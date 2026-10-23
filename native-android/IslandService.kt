package com.mymusic.player

import android.accessibilityservice.AccessibilityService
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Outline
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min

// The Dynamic Island: a black pill drawn on top of every app, right over the camera hole.
// Needs the Accessibility permission (to draw) and Notification access (to read what is playing).
// It also runs the always-on cover (AodController): the cover on a dim black screen while the screen is off.
class IslandService : AccessibilityService() {
  companion object {
    @Volatile var instance: IslandService? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private var wm: WindowManager? = null
  private var msm: MediaSessionManager? = null
  private var comp: ComponentName? = null
  private var registered = false
  private val controllers = ArrayList<MediaController>()
  private val callbacks = HashMap<MediaController, MediaController.Callback>()
  private var cur: MediaController? = null
  private var aod: AodController? = null
  private val kg by lazy { getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager }
  private val ease = PathInterpolator(0.2f, 0f, 0f, 1f)

  private lateinit var root: FrameLayout
  private lateinit var card: FrameLayout
  private lateinit var small: FrameLayout
  private lateinit var big: LinearLayout
  private lateinit var smallArt: ImageView
  private lateinit var eq: EqView
  private lateinit var bigArt: ImageView
  private lateinit var titleV: TextView
  private lateinit var artistV: TextView
  private lateinit var bar: BarView
  private lateinit var timeL: TextView
  private lateinit var timeR: TextView
  private lateinit var btnPrev: IconView
  private lateinit var btnPlay: IconView
  private lateinit var btnNext: IconView
  private lateinit var lp: WindowManager.LayoutParams
  private val bg = GradientDrawable()

  private var built = false
  private var attached = false
  private var expanded = false
  private var anim: ValueAnimator? = null
  private var lastTrack = ""
  private var artBitmap: Bitmap? = null
  private var lastArtTry = 0L
  private var lastPlayingAt = 0L
  private var collapseAt = 0L
  private var unwantedSince = 0L

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()
  private fun smallW(): Int = dp(IslandPrefs.width(this))
  private fun smallH(): Int = dp(IslandPrefs.height(this))
  private fun bigW(): Int = min(resources.displayMetrics.widthPixels - dp(24), dp(360))
  private fun bigH(): Int = dp(146)

  private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { l -> onSessions(l) }

  private val tick = object : Runnable {
    override fun run() {
      try {
        if (!registered) tryRegister()
        updateProgress()
        if (expanded && SystemClock.elapsedRealtime() > collapseAt) morph(false)
        evaluate()
        aod?.tick()
      } catch (t: Throwable) {
      }
      main.postDelayed(this, 500)
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    msm = getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
    comp = ComponentName(this, IslandListener::class.java)
    buildViews()
    if (aod == null) aod = AodController(this)
    aod?.start()
    tryRegister()
    main.removeCallbacks(tick)
    main.post(tick)
  }

  // We do not use window events any more: the app tells us when it is open.
  override fun onAccessibilityEvent(e: AccessibilityEvent?) {}

  override fun onInterrupt() {}

  override fun onDestroy() {
    main.removeCallbacks(tick)
    try { msm?.removeOnActiveSessionsChangedListener(sessionsListener) } catch (t: Throwable) {}
    for ((c, cb) in callbacks) {
      try { c.unregisterCallback(cb) } catch (t: Throwable) {}
    }
    callbacks.clear()
    aod?.stop()
    aod = null
    detach()
    instance = null
    super.onDestroy()
  }

  // ---------- the views ----------
  private fun round(v: View, r: Float) {
    v.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, o: Outline) {
        o.setRoundRect(0, 0, view.width, view.height, r)
      }
    }
    v.clipToOutline = true
  }

  private fun label(size: Float, color: Int, bold: Boolean): TextView {
    val t = TextView(this)
    t.setTextColor(color)
    t.textSize = size
    if (bold) t.setTypeface(null, Typeface.BOLD)
    t.isSingleLine = true
    t.ellipsize = TextUtils.TruncateAt.END
    return t
  }

  private fun buildViews() {
    if (built) return
    built = true
    bg.setColor(Color.BLACK)
    bg.cornerRadius = smallH() / 2f

    root = FrameLayout(this)
    card = FrameLayout(this)
    card.background = bg
    card.setOnClickListener {
      if (!expanded) {
        morph(true)
        touch()
      }
    }
    root.addView(card, FrameLayout.LayoutParams(smallW(), smallH(), Gravity.TOP or Gravity.CENTER_HORIZONTAL))

    // small pill: cover on the left, bars on the right, the camera sits in the middle
    small = FrameLayout(this)
    smallArt = ImageView(this)
    smallArt.scaleType = ImageView.ScaleType.CENTER_CROP
    round(smallArt, dp(11).toFloat())
    smallArt.setImageDrawable(ColorDrawable(0xFF333333.toInt()))
    val al = FrameLayout.LayoutParams(dp(22), dp(22), Gravity.START or Gravity.CENTER_VERTICAL)
    al.leftMargin = dp(9)
    small.addView(smallArt, al)
    eq = EqView(this)
    val el = FrameLayout.LayoutParams(dp(16), dp(14), Gravity.END or Gravity.CENTER_VERTICAL)
    el.rightMargin = dp(13)
    small.addView(eq, el)
    card.addView(small, FrameLayout.LayoutParams(-1, -1))

    // big card
    big = LinearLayout(this)
    big.orientation = LinearLayout.VERTICAL
    big.setPadding(dp(16), dp(14), dp(16), dp(8))
    val top = LinearLayout(this)
    top.orientation = LinearLayout.HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    top.setOnClickListener {
      openOwner()
      morph(false)
    }
    bigArt = ImageView(this)
    bigArt.scaleType = ImageView.ScaleType.CENTER_CROP
    round(bigArt, dp(12).toFloat())
    bigArt.setImageDrawable(ColorDrawable(0xFF333333.toInt()))
    top.addView(bigArt, LinearLayout.LayoutParams(dp(52), dp(52)))
    val col = LinearLayout(this)
    col.orientation = LinearLayout.VERTICAL
    titleV = label(15f, Color.WHITE, true)
    artistV = label(12f, 0xFFAAAAAA.toInt(), false)
    col.addView(titleV)
    col.addView(artistV)
    val cl = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
    cl.leftMargin = dp(12)
    top.addView(col, cl)
    big.addView(top, LinearLayout.LayoutParams(-1, dp(52)))

    val pr = LinearLayout(this)
    pr.orientation = LinearLayout.HORIZONTAL
    pr.gravity = Gravity.CENTER_VERTICAL
    timeL = label(10f, 0xFFAAAAAA.toInt(), false)
    timeL.text = "0:00"
    timeR = label(10f, 0xFFAAAAAA.toInt(), false)
    timeR.text = "0:00"
    timeR.gravity = Gravity.END
    bar = BarView(this)
    bar.onSeek = { f ->
      val d = cur?.metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L
      if (d > 0) cur?.transportControls?.seekTo((f * d).toLong())
      touch()
    }
    pr.addView(timeL, LinearLayout.LayoutParams(dp(36), -2))
    pr.addView(bar, LinearLayout.LayoutParams(0, dp(20), 1f))
    pr.addView(timeR, LinearLayout.LayoutParams(dp(36), -2))
    val prl = LinearLayout.LayoutParams(-1, dp(24))
    prl.topMargin = dp(8)
    big.addView(pr, prl)

    val ctl = LinearLayout(this)
    ctl.orientation = LinearLayout.HORIZONTAL
    ctl.gravity = Gravity.CENTER
    btnPrev = IconView(this, 0)
    btnPlay = IconView(this, 1)
    btnNext = IconView(this, 3)
    btnPrev.setOnClickListener {
      cur?.transportControls?.skipToPrevious()
      touch()
    }
    btnNext.setOnClickListener {
      cur?.transportControls?.skipToNext()
      touch()
    }
    btnPlay.setOnClickListener {
      val c = cur
      if (c != null) {
        val st = c.playbackState?.state
        if (st == PlaybackState.STATE_PLAYING || st == PlaybackState.STATE_BUFFERING) c.transportControls.pause()
        else c.transportControls.play()
      }
      touch()
    }
    ctl.addView(btnPrev, LinearLayout.LayoutParams(dp(56), dp(40)))
    ctl.addView(btnPlay, LinearLayout.LayoutParams(dp(64), dp(40)))
    ctl.addView(btnNext, LinearLayout.LayoutParams(dp(56), dp(40)))
    big.addView(ctl, LinearLayout.LayoutParams(-1, dp(40)))
    card.addView(big, FrameLayout.LayoutParams(bigW(), bigH(), Gravity.TOP or Gravity.CENTER_HORIZONTAL))
    big.visibility = View.GONE

    lp = WindowManager.LayoutParams(
      smallW(),
      smallH(),
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
        WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
      PixelFormat.TRANSLUCENT
    )
    lp.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
    lp.title = "MusicPlusIsland"
    if (Build.VERSION.SDK_INT >= 30) {
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    } else if (Build.VERSION.SDK_INT >= 28) {
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    lp.y = topPx(smallH())
  }

  // Top edge of the pill so that it sits centered on the camera hole
  private fun topPx(h: Int): Int {
    var cy = -1
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        val cut = wm?.currentWindowMetrics?.windowInsets?.displayCutout
        if (cut != null) {
          for (r in cut.boundingRects) {
            if (r.top <= dp(6) && r.height() > 0 && r.height() <= dp(60)) cy = (r.top + r.bottom) / 2
          }
        }
      }
    } catch (t: Throwable) {
    }
    if (cy < 0) {
      val id = resources.getIdentifier("status_bar_height", "dimen", "android")
      val sb = if (id > 0) resources.getDimensionPixelSize(id) else dp(28)
      cy = sb / 2
    }
    return max(0, cy - h / 2 + dp(IslandPrefs.yoff(this)))
  }

  private fun updateLayout() {
    if (attached) {
      try { wm?.updateViewLayout(root, lp) } catch (t: Throwable) {}
    }
  }

  private fun setCard(w: Int, h: Int) {
    val cl = card.layoutParams as FrameLayout.LayoutParams
    cl.width = w
    cl.height = h
    card.layoutParams = cl
  }

  private fun resetToSmall() {
    expanded = false
    anim?.cancel()
    setCard(smallW(), smallH())
    lp.width = smallW()
    lp.height = smallH()
    lp.y = topPx(smallH())
    bg.cornerRadius = smallH() / 2f
    small.visibility = View.VISIBLE
    small.alpha = 1f
    big.visibility = View.GONE
    big.alpha = 0f
    card.alpha = 1f
    card.scaleX = 1f
  }

  private fun attach() {
    if (attached || !built) return
    resetToSmall()
    try {
      wm?.addView(root, lp)
      attached = true
      // grows out of the camera hole
      card.alpha = 0f
      card.scaleX = 0.6f
      card.pivotX = smallW() / 2f
      card.pivotY = 0f
      card.animate().alpha(1f).scaleX(1f).setDuration(220).setInterpolator(ease).start()
    } catch (t: Throwable) {
    }
  }

  private fun detach() {
    if (!attached) return
    anim?.cancel()
    card.animate().cancel()
    try { wm?.removeView(root) } catch (t: Throwable) {}
    attached = false
    expanded = false
  }

  private fun morph(toExpanded: Boolean) {
    if (!attached || expanded == toExpanded) return
    expanded = toExpanded
    anim?.cancel()
    val cl = card.layoutParams as FrameLayout.LayoutParams
    val fromW = cl.width
    val fromH = cl.height
    val toW = if (toExpanded) bigW() else smallW()
    val toH = if (toExpanded) bigH() else smallH()
    val fromR = bg.cornerRadius
    val toR = if (toExpanded) dp(30).toFloat() else smallH() / 2f
    if (toExpanded) {
      // the window becomes big first, then the black shape grows inside it (smooth)
      lp.width = bigW()
      lp.height = bigH()
      updateLayout()
    }
    big.visibility = View.VISIBLE
    small.visibility = View.VISIBLE
    var cancelled = false
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 320
    a.interpolator = ease
    a.addUpdateListener { v ->
      val f = v.animatedValue as Float
      setCard((fromW + (toW - fromW) * f).toInt(), (fromH + (toH - fromH) * f).toInt())
      bg.cornerRadius = fromR + (toR - fromR) * f
      if (toExpanded) {
        big.alpha = ((f - 0.35f) / 0.65f).coerceIn(0f, 1f)
        small.alpha = (1f - f * 3f).coerceIn(0f, 1f)
      } else {
        big.alpha = (1f - f * 2.5f).coerceIn(0f, 1f)
        small.alpha = ((f - 0.5f) / 0.5f).coerceIn(0f, 1f)
      }
    }
    a.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationCancel(animation: Animator) {
        cancelled = true
      }

      override fun onAnimationEnd(animation: Animator) {
        if (cancelled) return
        if (expanded) {
          small.visibility = View.GONE
        } else {
          big.visibility = View.GONE
          lp.width = smallW()
          lp.height = smallH()
          updateLayout()
        }
      }
    })
    anim = a
    a.start()
  }

  private fun touch() {
    collapseAt = SystemClock.elapsedRealtime() + 5000
  }

  private fun openOwner() {
    try { cur?.sessionActivity?.send() } catch (t: Throwable) {}
  }

  // ---------- reading what is playing ----------
  private fun tryRegister() {
    try {
      val m = msm ?: return
      val c = comp ?: return
      m.addOnActiveSessionsChangedListener(sessionsListener, c, main)
      registered = true
      onSessions(m.getActiveSessions(c))
    } catch (e: SecurityException) {
      registered = false // no notification access yet
    } catch (t: Throwable) {
    }
  }

  private fun onSessions(list: List<MediaController>?) {
    val l = list ?: emptyList()
    for ((c, cb) in callbacks) {
      try { c.unregisterCallback(cb) } catch (t: Throwable) {}
    }
    callbacks.clear()
    controllers.clear()
    controllers.addAll(l)
    for (c in l) {
      val cb = object : MediaController.Callback() {
        override fun onPlaybackStateChanged(state: PlaybackState?) {
          evaluate()
        }

        override fun onMetadataChanged(metadata: MediaMetadata?) {
          evaluate()
        }

        override fun onSessionDestroyed() {
          main.post { evaluate() }
        }
      }
      try {
        c.registerCallback(cb, main)
        callbacks[c] = cb
      } catch (t: Throwable) {
      }
    }
    evaluate()
  }

  private fun pick(): MediaController? {
    var first: MediaController? = null
    for (c in controllers) {
      val s = c.playbackState?.state
      if (s == PlaybackState.STATE_PLAYING || s == PlaybackState.STATE_BUFFERING) return c
      if (first == null && s != null && s != PlaybackState.STATE_NONE && s != PlaybackState.STATE_STOPPED) first = c
    }
    return first
  }

  private fun artOf(md: MediaMetadata): Bitmap? {
    for (k in arrayOf(MediaMetadata.METADATA_KEY_ART, MediaMetadata.METADATA_KEY_ALBUM_ART, MediaMetadata.METADATA_KEY_DISPLAY_ICON)) {
      val b = md.getBitmap(k)
      if (b != null) return b
    }
    for (k in arrayOf(MediaMetadata.METADATA_KEY_ART_URI, MediaMetadata.METADATA_KEY_ALBUM_ART_URI, MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI)) {
      val s = md.getString(k)
      if (!s.isNullOrEmpty()) {
        try {
          contentResolver.openInputStream(Uri.parse(s))?.use { return BitmapFactory.decodeStream(it) }
        } catch (t: Throwable) {
        }
      }
    }
    return null
  }

  private fun setArt(b: Bitmap?) {
    if (b != null) {
      smallArt.setImageBitmap(b)
      bigArt.setImageBitmap(b)
    } else {
      smallArt.setImageDrawable(ColorDrawable(0xFF333333.toInt()))
      bigArt.setImageDrawable(ColorDrawable(0xFF333333.toInt()))
    }
  }

  private fun fmt(ms: Long): String {
    val s = (if (ms < 0) 0 else ms) / 1000
    return (s / 60).toString() + ":" + (s % 60).toString().padStart(2, '0')
  }

  private fun updateProgress() {
    if (!attached || !expanded) return
    val c = cur ?: return
    val st = c.playbackState ?: return
    val dur = c.metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L
    var pos = st.position
    if (st.state == PlaybackState.STATE_PLAYING) {
      pos += ((SystemClock.elapsedRealtime() - st.lastPositionUpdateTime) * st.playbackSpeed).toLong()
    }
    if (dur > 0) pos = pos.coerceIn(0L, dur)
    if (!bar.dragging) {
      bar.frac = if (dur > 0) pos.toFloat() / dur else 0f
      bar.invalidate()
    }
    timeL.text = fmt(pos)
    timeR.text = if (dur > 0) fmt(dur) else "--:--"
  }

  // Decides: show or hide, and what to show
  private fun evaluate() {
    if (!built) return
    val c = pick()
    cur = c
    val now = SystemClock.elapsedRealtime()
    val st = c?.playbackState
    val playing = st != null && (st.state == PlaybackState.STATE_PLAYING || st.state == PlaybackState.STATE_BUFFERING)
    if (playing) lastPlayingAt = now
    val md = c?.metadata
    aod?.onMedia(c, playing)
    val preview = IslandState.preview
    val hardHide = !IslandPrefs.enabled(this) || kg.isKeyguardLocked || (IslandState.appForeground && !preview) || aod?.showing() == true
    val hasMedia = c != null && md != null && (playing || now - lastPlayingAt < 5000)

    if (hardHide) {
      unwantedSince = 0L
      if (attached) detach()
      return
    }
    if (!hasMedia && !preview) {
      // wait a moment before hiding, so short hiccups do not make it blink
      if (attached) {
        if (unwantedSince == 0L) unwantedSince = now
        if (now - unwantedSince > 1500) {
          unwantedSince = 0L
          detach()
        }
      }
      return
    }
    unwantedSince = 0L
    if (!attached) attach()

    if (hasMedia && md != null && c != null) {
      val title = md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE) ?: ""
      val artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST)
        ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
        ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE) ?: ""
      val key = title + "|" + artist + "|" + c.packageName
      val changed = key != lastTrack
      if (changed) {
        lastTrack = key
        artBitmap = null
        lastArtTry = 0L
        titleV.text = title
        artistV.text = artist
        setArt(null)
      }
      if (artBitmap == null && now - lastArtTry > 2000) {
        lastArtTry = now
        val b = artOf(md)
        if (b != null) {
          artBitmap = b
          setArt(b)
        }
      }
      btnPlay.set(if (playing) 2 else 1)
      eq.active = playing
      if (changed && playing && attached) {
        morph(true)
        collapseAt = now + 3500
      }
    } else if (lastTrack != "preview") {
      // nothing is playing: show a sample while you adjust the island
      lastTrack = "preview"
      artBitmap = null
      titleV.text = "Preview"
      artistV.text = "This is how the island looks"
      setArt(null)
      btnPlay.set(2)
      eq.active = false
    }
  }

  // ---------- called from the app ----------
  fun refresh() {
    evaluate()
  }

  fun applyPrefs() {
    aod?.applyPrefs()
    if (!built) return
    lp.y = topPx(smallH())
    if (!expanded) {
      setCard(smallW(), smallH())
      lp.width = smallW()
      lp.height = smallH()
      bg.cornerRadius = smallH() / 2f
    }
    updateLayout()
    evaluate()
  }

  // Shows the always-on cover for a few seconds (from the setup screen)
  fun aodPreview(): Boolean {
    val a = aod ?: return false
    return a.runPreview()
  }

  fun demo(): Boolean {
    if (!built) return false
    lastPlayingAt = SystemClock.elapsedRealtime()
    evaluate()
    if (!attached) return false
    morph(true)
    collapseAt = SystemClock.elapsedRealtime() + 4000
    return true
  }
}
