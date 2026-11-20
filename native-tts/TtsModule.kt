package com.mymusic.player

import android.content.res.AssetManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

// Offline voices for the Text to Speech screen. Kokoro (an AI voice model) runs on the phone through sherpa-onnx.
// The model files are packed inside the app (assets/kokoro-multi-lang-v1_0), so nothing is downloaded and no internet is used.
// The JS side calls: prepare(), speak(text, voiceNumber, speed), stop(), saveWav(text, voiceNumber, speed).
class TtsModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "KokoroTts"

  private val modelDir = "kokoro-multi-lang-v1_0"
  private val lock = Any()
  private val genLock = Any()

  @Volatile private var engine: OfflineTts? = null
  @Volatile private var current: Run? = null
  @Volatile private var worker: Thread? = null
  @Volatile private var track: AudioTrack? = null

  private class Run {
    @Volatile var stop = false
  }

  private class Chunk(val samples: FloatArray, val rate: Int)

  // the phonemizer (espeak-ng) needs real files, so its data is copied out of the app once
  private fun copyAssets(am: AssetManager, path: String, out: File) {
    val names = am.list(path) ?: emptyArray()
    if (names.isEmpty()) {
      try {
        out.parentFile?.mkdirs()
        am.open(path).use { i -> out.outputStream().use { o -> i.copyTo(o) } }
      } catch (e: java.io.IOException) {
        out.mkdirs()
      }
    } else {
      out.mkdirs()
      for (n in names) copyAssets(am, path + "/" + n, File(out, n))
    }
  }

  private fun ensureEngine(): OfflineTts {
    return synchronized(lock) {
      val have = engine
      if (have != null) have else buildEngine()
    }
  }

  private fun buildEngine(): OfflineTts {
    val am = ctx.assets
    val base = File(ctx.filesDir, "kokoro")
    val marker = File(base, ".copied_v1")
    val hasDict = (am.list(modelDir) ?: emptyArray()).contains("dict")
    if (!marker.exists()) {
      base.deleteRecursively()
      base.mkdirs()
      copyAssets(am, modelDir + "/espeak-ng-data", File(base, "espeak-ng-data"))
      if (hasDict) copyAssets(am, modelDir + "/dict", File(base, "dict"))
      marker.writeText("ok")
    }
    val kokoro = OfflineTtsKokoroModelConfig(
      model = modelDir + "/model.onnx",
      voices = modelDir + "/voices.bin",
      tokens = modelDir + "/tokens.txt",
      dataDir = File(base, "espeak-ng-data").absolutePath,
      lexicon = modelDir + "/lexicon-us-en.txt," + modelDir + "/lexicon-zh.txt",
      dictDir = if (hasDict) File(base, "dict").absolutePath else ""
    )
    val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)
    val cfg = OfflineTtsConfig(
      model = OfflineTtsModelConfig(kokoro = kokoro, numThreads = threads, debug = false, provider = "cpu")
    )
    val made = OfflineTts(am, cfg)
    engine = made
    return made
  }

  // Long text is read sentence by sentence, so the first words start quickly
  private fun splitText(raw: String): List<String> {
    val out = ArrayList<String>()
    for (para in raw.split(Regex("\\n+"))) {
      val p = para.trim()
      if (p.isEmpty()) continue
      for (piece in p.split(Regex("(?<=[.!?。！？])\\s+"))) {
        var x = piece.trim()
        while (x.length > 280) {
          var cut = x.lastIndexOf(", ", 280)
          if (cut < 40) cut = x.lastIndexOf(' ', 280)
          if (cut < 40) cut = 280
          out.add(x.substring(0, cut + 1).trim())
          x = x.substring(cut + 1).trim()
        }
        if (x.isNotEmpty()) out.add(x)
      }
    }
    return out
  }

  private fun makeTrack(rate: Int): AudioTrack {
    val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
    val size = maxOf(min * 2, rate * 4)
    return AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
          .setSampleRate(rate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build()
      )
      .setBufferSizeInBytes(size)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
  }

  private fun stopInternal() {
    current?.stop = true
    try {
      track?.pause()
      track?.flush()
    } catch (e: Throwable) {
    }
    val w = worker
    if (w != null && w !== Thread.currentThread()) {
      try {
        w.join(8000)
      } catch (e: InterruptedException) {
      }
    }
  }

  @ReactMethod
  fun prepare(promise: Promise) {
    Thread {
      try {
        ensureEngine()
        promise.resolve(true)
      } catch (t: Throwable) {
        promise.reject("TTS", t.message ?: "could not start the voice engine")
      }
    }.start()
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopInternal()
    promise.resolve(true)
  }

  // Resolves true when the text was read to the end, false when it was stopped
  @ReactMethod
  fun speak(text: String, sid: Int, speed: Double, promise: Promise) {
    stopInternal()
    val run = Run()
    current = run
    val t = Thread {
      var at: AudioTrack? = null
      var failure: Throwable? = null
      var gen: Thread? = null
      try {
        val eng = ensureEngine()
        val parts = splitText(text)
        val queue = LinkedBlockingQueue<Chunk>(3)
        val end = Chunk(FloatArray(0), 0)
        val g = Thread {
          try {
            for (p in parts) {
              if (run.stop) break
              val a = synchronized(genLock) { eng.generate(p, sid, speed.toFloat()) }
              val c = Chunk(a.samples, a.sampleRate)
              while (!run.stop && !queue.offer(c, 200, TimeUnit.MILLISECONDS)) {
              }
            }
          } catch (e: Throwable) {
            failure = e
          }
          while (!run.stop && !queue.offer(end, 200, TimeUnit.MILLISECONDS)) {
          }
        }
        gen = g
        g.start()
        var total = 0L
        while (!run.stop) {
          val c = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
          if (c.rate == 0) break
          val tr = at ?: makeTrack(c.rate).also {
            at = it
            track = it
            it.play()
          }
          var off = 0
          while (off < c.samples.size && !run.stop) {
            val n = tr.write(c.samples, off, c.samples.size - off, AudioTrack.WRITE_BLOCKING)
            if (n <= 0) break
            off += n
          }
          total += c.samples.size
        }
        val tr2 = at
        if (!run.stop && tr2 != null) {
          tr2.stop()
          var waited = 0
          while (!run.stop && tr2.playbackHeadPosition < total && waited < 100) {
            Thread.sleep(50)
            waited++
          }
        }
      } catch (e: Throwable) {
        failure = e
      } finally {
        try {
          gen?.join(10000)
        } catch (e: InterruptedException) {
        }
        try {
          at?.pause()
          at?.flush()
          at?.release()
        } catch (e: Throwable) {
        }
        if (track === at) track = null
      }
      val f = failure
      if (f != null) promise.reject("TTS", f.message ?: "the voice engine failed")
      else promise.resolve(!run.stop)
    }
    worker = t
    t.start()
  }

  // Makes the whole text into a WAV file in the app's cache and returns its path (the JS side saves it to Downloads)
  @ReactMethod
  fun saveWav(text: String, sid: Int, speed: Double, promise: Promise) {
    stopInternal()
    Thread {
      try {
        val eng = ensureEngine()
        val parts = splitText(text)
        if (parts.isEmpty()) {
          promise.reject("TTS", "There is nothing to read.")
          return@Thread
        }
        val pcm = ByteArrayOutputStream()
        var rate = 24000
        for (p in parts) {
          val a = synchronized(genLock) { eng.generate(p, sid, speed.toFloat()) }
          rate = a.sampleRate
          val bb = ByteBuffer.allocate(a.samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
          for (f in a.samples) bb.putShort((f.coerceIn(-1f, 1f) * 32767f).toInt().toShort())
          pcm.write(bb.array())
        }
        val data = pcm.toByteArray()
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + data.size).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(data.size)
        val f = File(ctx.cacheDir, "tts_" + System.currentTimeMillis() + ".wav")
        f.outputStream().use { o ->
          o.write(h.array())
          o.write(data)
        }
        promise.resolve(f.absolutePath)
      } catch (t: Throwable) {
        promise.reject("TTS", t.message ?: "could not make the audio file")
      }
    }.start()
  }
}

class TtsPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(TtsModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
