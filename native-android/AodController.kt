package com.mymusic.player

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Outline
import android.graphics.PixelFormat
import android.graphics.drawable.ColorDrawable
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView

// Settings of the always-on cover (saved in the same place as the island settings)
object AodPrefs {
  fun enabled(c: Context): Boolean = IslandPrefs.sp(c).getBoolean("aod_on", true)
  fun size(c: Context): Int = IslandPrefs.sp(c).getInt("aod_size", 70) // cover width, % of the screen width
  fun bright(c: Context): Int = IslandPrefs.sp(c).getInt("aod_bright", 6) // screen brightness while it shows, %
  fun others(c: Context): Boolean = IslandPrefs.sp(c).getBoolean("aod_any", false) // also for other music apps
}

// The always-on cover.
// When the screen goes off while music plays, the screen wakes up very dim, all black, and shows only the cover.
// Double tap the cover to get to the lock screen. Press the power button to switch the screen off for real.
// It lives inside the Island accessibility service, because that kind of window is allowed to draw over the lock screen.
class AodController(private val svc: AccessibilityService) {
  private val main = Handler(Looper.getMainLooper())
  private val wm = svc.getSystemService(Context.WINDOW_SERVICE) as WindowManager
  private val pm = svc.getSystemService(Context.POWER_SERVICE) as PowerManager
  private val am = svc.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private var root: FrameLayout? = null
  private var art: ImageView? = null
  private var lp: WindowManager.LayoutParams? = null
  private var lock: PowerManager.WakeLock? = null
  private var attached = false
  private var receiving = false

  private var playing = false // an allowed music app is playing right now
  private var lastPlayingAt = 0L
  private var lastMd: MediaMetadata? = null
  private var trackKey = ""
  private var haveArt = false
  private var triedAt = 0L
  private var gen = 0

  private var preview = false
  private var previewUntil = 0L
  private var suppressed = false // you pressed the power button while the cover showed: stay away until the screen is used again
  private var screenOffAt = 0L
  private var shownAt = 0L
  private var shiftStep = 0

  private fun dp(v: Int): Int = (v * svc.resources.displayMetrics.density + 0.5f).toInt()

  private val kick = Runnable { tick() }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(c: Context?, i: Intent?) {
      val a = i?.action ?: return
      val now = SystemClock.elapsedRealtime()
      if (a == Intent.ACTION_SCREEN_OFF) {
        if (attached) {
          // the screen went off while the cover showed = you pressed the power button
          if (!preview && now - shownAt > 1500) {
            suppressed = true
            hide()
          }
        } else {
          screenOffAt = now
          main.removeCallbacks(kick)
          main.postDelayed(kick, 800)
        }
      } else if (a == Intent.ACTION_SCREEN_ON) {
        if (!attached) {
          suppressed = false
          screenOffAt = 0L
        }
      }
    }
  }

  fun start() {
    if (receiving) return
    try {
      val f = IntentFilter()
      f.addAction(Intent.ACTION_SCREEN_OFF)
      f.addAction(Intent.ACTION_SCREEN_ON)
      svc.registerReceiver(receiver, f)
      receiving = true
    } catch (t: Throwable) {
    }
  }

  fun stop() {
    main.removeCallbacks(kick)
    hide()
    if (receiving) {
      try { svc.unregisterReceiver(receiver) } catch (t: Throwable) {}
      receiving = false
    }
  }

  fun showing(): Boolean = attached

  // The island service tells us what is playing (it knows the media sessions)
  fun onMedia(c: MediaController?, isPlaying: Boolean) {
    val ok = c != null && (AodPrefs.others(svc) || c.packageName == svc.packageName)
    playing = ok && isPlaying
    if (playing) lastPlayingAt = SystemClock.elapsedRealtime()
    val md: MediaMetadata? = if (c != null) c.metadata else null
    lastMd = md
    if (attached && md != null) checkTrack(md)
  }

  // Runs twice a second: decides to show or hide the cover
  fun tick() {
    val now = SystemClock.elapsedRealtime()
    val interactive = pm.isInteractive
    if (attached) {
      if (preview) {
        if (now > previewUntil) hide()
        return
      }
      if (!interactive && now - shownAt > 1500) {
        suppressed = true
        hide()
        return
      }
      val callOn = am.mode != AudioManager.MODE_NORMAL
      val stopped = !playing && now - lastPlayingAt > 2500
      if (!AodPrefs.enabled(svc) || callOn || stopped) {
        hide()
        return
      }
      val md = lastMd
      if (md != null) checkTrack(md)
      return
    }
    if (interactive) {
      suppressed = false
      screenOffAt = 0L
      return
    }
    if (screenOffAt == 0L) screenOffAt = now
    val callOn = am.mode != AudioManager.MODE_NORMAL
    if (!suppressed && AodPrefs.enabled(svc) && playing && !callOn && now - screenOffAt > 700) show(false)
  }

  // Used by the setup screen: shows the cover for 6 seconds without switching the screen off
  fun runPreview(): Boolean {
    if (attached) {
      hide()
      return true
    }
    show(true)
    return attached
  }

  fun applyPrefs() {
    applyLook()
    val r = root
    val l = lp
    if (attached && r != null && l != null) {
      try { wm.updateViewLayout(r, l) } catch (t: Throwable) {}
    }
  }

  // ---------- the window ----------
  private fun round(v: View, r: Float) {
    v.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, o: Outline) {
        o.setRoundRect(0, 0, view.width, view.height, r)
      }
    }
    v.clipToOutline = true
  }

  private fun build() {
    if (root != null) return
    val r = FrameLayout(svc)
    r.setBackgroundColor(Color.BLACK)
    val a = ImageView(svc)
    a.scaleType = ImageView.ScaleType.CENTER_CROP
    a.setImageDrawable(ColorDrawable(0xFF161616.toInt()))
    r.addView(a, FrameLayout.LayoutParams(dp(200), dp(200), Gravity.CENTER))
    val gd = GestureDetector(svc, object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(e: MotionEvent): Boolean = true

      override fun onDoubleTap(e: MotionEvent): Boolean {
        hide()
        return true
      }
    })
    r.setOnTouchListener { _, e ->
      gd.onTouchEvent(e)
      true
    }
    root = r
    art = a

    val l = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
        WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
      PixelFormat.TRANSLUCENT
    )
    l.gravity = Gravity.TOP or Gravity.START
    l.title = "MusicPlusCover"
    if (Build.VERSION.SDK_INT >= 30) {
      l.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    } else if (Build.VERSION.SDK_INT >= 28) {
      l.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    lp = l
  }

  // Cover size and screen brightness from the settings
  private fun applyLook() {
    val a = art ?: return
    val l = lp ?: return
    val w = svc.resources.displayMetrics.widthPixels
    val side = (w * AodPrefs.size(svc) / 100f).toInt().coerceAtLeast(dp(80))
    a.layoutParams = FrameLayout.LayoutParams(side, side, Gravity.CENTER)
    round(a, side * 0.07f)
    l.screenBrightness = AodPrefs.bright(svc).coerceIn(1, 100) / 100f
  }

  @Suppress("DEPRECATION")
  private fun show(asPreview: Boolean) {
    if (attached) return
    build()
    val r = root ?: return
    val l = lp ?: return
    preview = asPreview
    val now = SystemClock.elapsedRealtime()
    previewUntil = now + 6000
    shownAt = now
    applyLook()
    var flags = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
      WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
      WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
    if (!asPreview) flags = flags or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
    l.flags = flags
    try {
      wm.addView(r, l)
      attached = true
    } catch (t: Throwable) {
      attached = false
      preview = false
      return
    }
    if (!asPreview) wake()
    main.removeCallbacks(shift)
    main.postDelayed(shift, 60000)
    val md = lastMd
    if (md != null) checkTrack(md)
  }

  fun hide() {
    main.removeCallbacks(shift)
    val r = root
    if (attached && r != null) {
      try {
        art?.animate()?.cancel()
        wm.removeView(r)
      } catch (t: Throwable) {
      }
    }
    attached = false
    preview = false
    releaseLock()
  }

  // Wakes the screen up and keeps it on (very dim, the window asks for a low brightness)
  @Suppress("DEPRECATION")
  private fun wake() {
    try {
      val l = lock ?: pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "MusicPlus:cover")
      l.setReferenceCounted(false)
      lock = l
      if (!l.isHeld) l.acquire(4 * 60 * 60 * 1000L)
    } catch (t: Throwable) {
    }
  }

  private fun releaseLock() {
    try {
      val l = lock
      if (l != null && l.isHeld) l.release()
    } catch (t: Throwable) {
    }
  }

  // Every minute the cover moves a tiny bit, so the screen is never burnt in
  private val shift = object : Runnable {
    override fun run() {
      val a = art
      if (attached && a != null) {
        val dx = intArrayOf(0, 8, 8, 0, -8, -8, -8, 0, 8)
        val dy = intArrayOf(0, 0, 8, 8, 8, 0, -8, -8, -8)
        shiftStep = (shiftStep + 1) % dx.size
        a.animate().translationX(dp(dx[shiftStep]).toFloat()).translationY(dp(dy[shiftStep]).toFloat()).setDuration(3000).start()
        main.postDelayed(this, 60000)
      }
    }
  }

  // ---------- the cover picture ----------
  private fun checkTrack(md: MediaMetadata) {
    val key = (md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: "") + "|" +
      (md.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: "") + "|" +
      (md.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: "")
    val now = SystemClock.elapsedRealtime()
    if (key != trackKey) {
      trackKey = key
      haveArt = false
      triedAt = 0L
    }
    if (!haveArt && now - triedAt > 2000) {
      triedAt = now
      fetch(md)
    }
  }

  private fun fetch(md: MediaMetadata) {
    gen += 1
    val g = gen
    Thread {
      val b = readArt(md)
      if (b != null) {
        main.post {
          if (g == gen) {
            haveArt = true
            showBitmap(b)
          }
        }
      }
    }.start()
  }

  private fun showBitmap(b: Bitmap) {
    val a = art ?: return
    a.setImageBitmap(b)
    a.alpha = 0f
    a.animate().alpha(1f).setDuration(600).start()
  }

  private fun readArt(md: MediaMetadata): Bitmap? {
    for (k in arrayOf(MediaMetadata.METADATA_KEY_ART, MediaMetadata.METADATA_KEY_ALBUM_ART, MediaMetadata.METADATA_KEY_DISPLAY_ICON)) {
      val b = md.getBitmap(k)
      if (b != null) return b
    }
    for (k in arrayOf(MediaMetadata.METADATA_KEY_ART_URI, MediaMetadata.METADATA_KEY_ALBUM_ART_URI, MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI)) {
      val s = md.getString(k)
      if (!s.isNullOrEmpty()) {
        val b = decode(Uri.parse(s))
        if (b != null) return b
      }
    }
    return null
  }

  // Reads the picture, but not bigger than the screen needs (big covers would waste memory)
  private fun decode(u: Uri): Bitmap? {
    try {
      val o = BitmapFactory.Options()
      o.inJustDecodeBounds = true
      svc.contentResolver.openInputStream(u)?.use { BitmapFactory.decodeStream(it, null, o) }
      val target = svc.resources.displayMetrics.widthPixels
      var s = 1
      while (o.outWidth / (s * 2) >= target && o.outHeight / (s * 2) >= target) s *= 2
      val o2 = BitmapFactory.Options()
      o2.inSampleSize = s
      return svc.contentResolver.openInputStream(u)?.use { BitmapFactory.decodeStream(it, null, o2) }
    } catch (t: Throwable) {
      return null
    }
  }
}
