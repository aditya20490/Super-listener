package com.mymusic.player

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import kotlin.math.max
import kotlin.math.min

/**
 * Plays the karaoke file silently next to the normal player ("shadow"), always on the same position. When you tap K,
 * only the volumes change places (over about 40 ms), so there is no restart and no gap. Same idea as the 8D engine:
 * the normal player keeps running as the clock, the progress bar and the notification.
 *
 * lagMs: the karaoke file starts this many milliseconds late (encoder delay, measured when it was made).
 * Positions given to and returned from this class are always on the ORIGINAL song's timeline.
 */
class KaraokeEngine(
  private val ctx: Context,
  private val file: File,
  startMs: Long,
  startVolume: Float,
  startPlaying: Boolean,
  private val lagMs: Long,
) {
  @Volatile var targetVol: Float = startVolume
  @Volatile var playing: Boolean = startPlaying
  @Volatile var seekReq: Long = max(0L, startMs + lagMs)
  @Volatile private var stopped = false
  @Volatile private var baseMs = 0L
  @Volatile private var rate = 44100
  @Volatile private var track: AudioTrack? = null
  private var thread: Thread? = null
  private var curVol: Float = startVolume

  fun begin() {
    val t = Thread({ run() }, "karaoke-decoder")
    t.isDaemon = true
    thread = t
    t.start()
  }

  fun release() {
    stopped = true
  }

  /** Position on the original song's timeline, in ms (or -1 if not playing yet). */
  fun positionMs(): Long {
    val tr = track ?: return -1L
    return try {
      baseMs + (tr.playbackHeadPosition.toLong() and 0xFFFFFFFFL) * 1000L / rate - lagMs
    } catch (e: Throwable) {
      -1L
    }
  }

  fun seekOriginalMs(ms: Long) {
    seekReq = max(0L, ms + lagMs)
  }

  private fun makeTrack(sr: Int): AudioTrack {
    val minSize = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT)
    val size = max(minSize * 2, sr * 4 / 8)
    return AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(sr)
          .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
          .build()
      )
      .setBufferSizeInBytes(size)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
  }

  private fun run() {
    var extractor: MediaExtractor? = null
    var codec: MediaCodec? = null
    try {
      extractor = MediaExtractor()
      extractor.setDataSource(file.absolutePath)
      var idx = -1
      var fmt: MediaFormat? = null
      for (i in 0 until extractor.trackCount) {
        val f = extractor.getTrackFormat(i)
        if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) {
          idx = i
          fmt = f
          break
        }
      }
      if (idx < 0 || fmt == null) return
      extractor.selectTrack(idx)
      codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
      codec.configure(fmt, null, null, 0)
      codec.start()

      var sr = if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100
      var ch = if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 2
      rate = sr
      var tr = makeTrack(sr)
      track = tr
      var trackPlaying = false

      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var outputDone = false
      var skipUntilUs = 0L
      var pcm = ShortArray(4096 * 2)

      while (!stopped) {
        // seek request (also the first start)
        val sk = seekReq
        if (sk >= 0) {
          seekReq = -1
          val us = sk * 1000L
          extractor.seekTo(us, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
          codec.flush()
          inputDone = false
          outputDone = false
          skipUntilUs = us
          baseMs = sk
          try { tr.pause(); tr.flush(); trackPlaying = false } catch (e: Throwable) {}
        }

        // pause / resume
        if (!playing) {
          if (trackPlaying) {
            try { tr.pause() } catch (e: Throwable) {}
            trackPlaying = false
          }
          Thread.sleep(25)
          continue
        }

        if (outputDone) {
          Thread.sleep(50)
          continue
        }

        if (!inputDone) {
          val ib = codec.dequeueInputBuffer(0)
          if (ib >= 0) {
            val buf = codec.getInputBuffer(ib)!!
            val n = extractor.readSampleData(buf, 0)
            if (n < 0) {
              codec.queueInputBuffer(ib, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              codec.queueInputBuffer(ib, 0, n, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        val ob = codec.dequeueOutputBuffer(info, 5000)
        if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val nf = codec.outputFormat
          val nsr = if (nf.containsKey(MediaFormat.KEY_SAMPLE_RATE)) nf.getInteger(MediaFormat.KEY_SAMPLE_RATE) else sr
          ch = if (nf.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) nf.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else ch
          if (nsr != sr) {
            try { tr.release() } catch (e: Throwable) {}
            sr = nsr
            rate = sr
            tr = makeTrack(sr)
            track = tr
            trackPlaying = false
          }
        } else if (ob >= 0) {
          if (info.size > 0) {
            val bb = codec.getOutputBuffer(ob)!!
            bb.position(info.offset)
            bb.limit(info.offset + info.size)
            val sb = bb.order(java.nio.ByteOrder.nativeOrder()).asShortBuffer()
            val total = sb.remaining()
            val chn = max(1, ch)
            val frames = total / chn
            var startFrame = 0
            if (info.presentationTimeUs < skipUntilUs) {
              // drop the part of this buffer that is before the wanted position (sample exact)
              startFrame = ((skipUntilUs - info.presentationTimeUs) * sr / 1_000_000L).toInt()
              if (startFrame > frames) startFrame = frames
            }
            if (startFrame < frames) {
              val tmp = ShortArray(total)
              sb.get(tmp)
              val count = frames - startFrame
              if (pcm.size < count * 2) pcm = ShortArray(count * 2)
              val step = 1f / (sr * 0.04f) // a full volume change takes about 40 ms
              val tgt = targetVol
              for (f in 0 until count) {
                if (curVol < tgt) curVol = min(tgt, curVol + step)
                else if (curVol > tgt) curVol = max(tgt, curVol - step)
                val src = (startFrame + f) * chn
                val l = tmp[src] / 32768f
                val r = if (chn >= 2) tmp[src + 1] / 32768f else l
                pcm[f * 2] = (max(-1f, min(1f, l * curVol)) * 32767f).toInt().toShort()
                pcm[f * 2 + 1] = (max(-1f, min(1f, r * curVol)) * 32767f).toInt().toShort()
              }
              if (!trackPlaying) {
                try { tr.play() } catch (e: Throwable) {}
                trackPlaying = true
              }
              var off = 0
              val len = count * 2
              while (off < len && !stopped && seekReq < 0 && playing) {
                val w = tr.write(pcm, off, len - off, AudioTrack.WRITE_NON_BLOCKING)
                if (w < 0) break
                if (w == 0) Thread.sleep(5) else off += w
              }
            }
          }
          codec.releaseOutputBuffer(ob, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
        }
      }
    } catch (t: Throwable) {
      // the normal player is still playing, so a failure here just means no karaoke sound
    } finally {
      try { track?.stop() } catch (e: Throwable) {}
      try { track?.release() } catch (e: Throwable) {}
      track = null
      try { codec?.stop() } catch (e: Throwable) {}
      try { codec?.release() } catch (e: Throwable) {}
      try { extractor?.release() } catch (e: Throwable) {}
    }
  }
}
