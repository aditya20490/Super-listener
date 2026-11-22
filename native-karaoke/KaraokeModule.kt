package com.mymusic.player

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.ViewManager
import java.io.File

/**
 * Bridge to JS for the Karaoke feature: starting / watching / cancelling the background job, listing and removing the
 * generated files (they live in the app's private no-backup folder), and the silent shadow player.
 */
class KaraokeModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), LifecycleEventListener {
  private var engine: KaraokeEngine? = null
  private val main = Handler(Looper.getMainLooper())

  // same safety as the 8D engine: if the app is swiped away and no screen comes back, stop the sound
  private val stopIfGone = Runnable {
    engine?.release()
    engine = null
  }

  init {
    ctx.addLifecycleEventListener(this)
  }

  override fun onHostResume() {
    main.removeCallbacks(stopIfGone)
  }

  override fun onHostPause() {}

  override fun onHostDestroy() {
    main.removeCallbacks(stopIfGone)
    main.postDelayed(stopIfGone, 1500)
  }

  override fun getName(): String = "Karaoke"

  private fun appCtx(): Context = reactApplicationContext.applicationContext

  private fun okName(n: String?): Boolean = n != null && n.matches(Regex("[A-Za-z0-9._-]{1,80}"))

  // ---------- the background job ----------

  /** "started", "busy" (another karaoke or the Vocal Splitter is working) */
  @ReactMethod
  fun generate(uri: String, key: String, title: String, promise: Promise) {
    try {
      if (KaraokeState.phase == "working") {
        promise.resolve("busy")
        return
      }
      if (com.vocalsplitter.app.SeparationState.ui.value.phase == com.vocalsplitter.app.Phase.Working) {
        promise.resolve("busy")
        return
      }
      KaraokeState.begin(key, title)
      KaraokeService.start(appCtx(), Uri.parse(uri), key, title)
      promise.resolve("started")
    } catch (t: Throwable) {
      KaraokeState.fail(t.message ?: "Could not start")
      promise.reject("KARAOKE", t.message ?: "Could not start karaoke")
    }
  }

  @ReactMethod
  fun status(promise: Promise) {
    val m = Arguments.createMap()
    m.putString("phase", KaraokeState.phase)
    m.putDouble("progress", KaraokeState.progress.toDouble())
    m.putDouble("etaSec", KaraokeState.etaSec.toDouble())
    m.putString("message", KaraokeState.message)
    m.putString("error", KaraokeState.error)
    m.putString("key", KaraokeState.key)
    m.putString("title", KaraokeState.title)
    m.putString("file", KaraokeState.file)
    m.putDouble("lagFrames", KaraokeState.lagFrames.toDouble())
    m.putDouble("frames", KaraokeState.frames.toDouble())
    promise.resolve(m)
  }

  /** JS has read a finished / failed result: go back to idle */
  @ReactMethod
  fun ack() {
    if (KaraokeState.phase == "done" || KaraokeState.phase == "error") KaraokeState.reset()
  }

  @ReactMethod
  fun cancel() {
    try {
      if (KaraokeState.phase == "working") {
        KaraokeState.cancelRequested = true
        KaraokeService.cancel(appCtx())
      }
    } catch (t: Throwable) {}
  }

  // ---------- the files ----------

  @ReactMethod
  fun dir(promise: Promise) {
    promise.resolve(KaraokeService.dir(appCtx()).absolutePath)
  }

  /** The small description files of all finished karaoke files (JSON text each) */
  @ReactMethod
  fun list(promise: Promise) {
    val out = Arguments.createArray()
    try {
      val d = KaraokeService.dir(appCtx())
      val files = d.listFiles()
      if (files != null) {
        for (f in files) {
          if (!f.name.endsWith(".json")) continue
          val audio = File(d, f.name.removeSuffix(".json") + ".m4a")
          if (!audio.exists() || audio.length() == 0L) continue
          try {
            out.pushString(f.readText())
          } catch (e: Exception) {}
        }
      }
    } catch (t: Throwable) {}
    promise.resolve(out)
  }

  /** Deletes the files of one karaoke (base name like k0123abcd) */
  @ReactMethod
  fun remove(base: String, promise: Promise) {
    try {
      if (!okName(base)) {
        promise.resolve(false)
        return
      }
      val d = KaraokeService.dir(appCtx())
      File(d, "$base.m4a").delete()
      File(d, "$base.json").delete()
      File(d, "$base.m4a.part").delete()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  /** Deletes every file that is not in the keep list (left-overs of a crash). Never touches a running job. */
  @ReactMethod
  fun cleanup(keep: ReadableArray, promise: Promise) {
    try {
      if (KaraokeState.phase == "working") {
        promise.resolve(0)
        return
      }
      val keepSet = HashSet<String>()
      for (i in 0 until keep.size()) keep.getString(i)?.let { keepSet.add(it) }
      val d = KaraokeService.dir(appCtx())
      var removed = 0
      val files = d.listFiles()
      if (files != null) {
        for (f in files) {
          val base = f.name.substringBefore('.')
          if (!keepSet.contains(base)) {
            if (f.delete()) removed++
          }
        }
      }
      promise.resolve(removed)
    } catch (t: Throwable) {
      promise.resolve(0)
    }
  }

  // ---------- the silent shadow player ----------

  /** Starts playing the karaoke file silently (or at the given volume) from the original song's position */
  @ReactMethod
  fun playerStart(file: String, posMs: Double, volume: Double, playing: Boolean, lagMs: Double, promise: Promise) {
    try {
      if (!okName(file)) {
        promise.resolve(false)
        return
      }
      val f = File(KaraokeService.dir(appCtx()), file)
      if (!f.exists()) {
        promise.resolve(false)
        return
      }
      engine?.release()
      val e = KaraokeEngine(appCtx(), f, posMs.toLong(), volume.toFloat(), playing, lagMs.toLong())
      engine = e
      e.begin()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("KARAOKE", t.message ?: "Could not play karaoke")
    }
  }

  @ReactMethod
  fun playerStop() {
    engine?.release()
    engine = null
  }

  @ReactMethod
  fun playerSetPlaying(p: Boolean) {
    engine?.playing = p
  }

  @ReactMethod
  fun playerSeek(ms: Double) {
    engine?.seekOriginalMs(ms.toLong())
  }

  @ReactMethod
  fun playerSetVolume(v: Double) {
    engine?.targetVol = v.toFloat().coerceIn(0f, 1f)
  }

  @ReactMethod
  fun playerPosition(promise: Promise) {
    promise.resolve((engine?.positionMs() ?: -1L).toDouble())
  }
}

class KaraokePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(KaraokeModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
