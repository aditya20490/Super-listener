package com.mymusic.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sin

// Shared state between the app and the island (the app tells the island when it is open)
object IslandState {
  @Volatile var appForeground = false
  @Volatile var preview = false
}

object IslandPrefs {
  fun sp(c: Context) = c.getSharedPreferences("island", Context.MODE_PRIVATE)
  fun enabled(c: Context): Boolean = sp(c).getBoolean("enabled", true)
  fun yoff(c: Context): Int = sp(c).getInt("yoff", 0)
  fun width(c: Context): Int = sp(c).getInt("width", 120)
  fun height(c: Context): Int = sp(c).getInt("height", 34)
}

// Little drawn icons so we don't depend on any font: 0 previous, 1 play, 2 pause, 3 next
class IconView(ctx: Context, var kind: Int) : View(ctx) {
  private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

  fun set(k: Int) {
    if (k != kind) {
      kind = k
      invalidate()
    }
  }

  private fun tri(c: Canvas, x: Float, y: Float, s: Float, right: Boolean) {
    val path = Path()
    if (right) {
      path.moveTo(x - s / 2, y - s / 2)
      path.lineTo(x - s / 2, y + s / 2)
      path.lineTo(x + s / 2, y)
    } else {
      path.moveTo(x + s / 2, y - s / 2)
      path.lineTo(x + s / 2, y + s / 2)
      path.lineTo(x - s / 2, y)
    }
    path.close()
    c.drawPath(path, p)
  }

  override fun onDraw(c: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    val s = min(width, height) * 0.5f
    when (kind) {
      1 -> tri(c, cx + s * 0.06f, cy, s * 1.2f, true)
      2 -> {
        c.drawRoundRect(RectF(cx - s * 0.5f, cy - s * 0.55f, cx - s * 0.16f, cy + s * 0.55f), 4f, 4f, p)
        c.drawRoundRect(RectF(cx + s * 0.16f, cy - s * 0.55f, cx + s * 0.5f, cy + s * 0.55f), 4f, 4f, p)
      }
      3 -> {
        tri(c, cx - s * 0.12f, cy, s * 0.9f, true)
        c.drawRoundRect(RectF(cx + s * 0.38f, cy - s * 0.45f, cx + s * 0.58f, cy + s * 0.45f), 3f, 3f, p)
      }
      else -> {
        tri(c, cx + s * 0.12f, cy, s * 0.9f, false)
        c.drawRoundRect(RectF(cx - s * 0.58f, cy - s * 0.45f, cx - s * 0.38f, cy + s * 0.45f), 3f, 3f, p)
      }
    }
  }
}

// The three dancing bars in the small pill
class EqView(ctx: Context) : View(ctx) {
  var active: Boolean = false
    set(v) {
      field = v
      invalidate()
    }
  private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

  override fun onDraw(c: Canvas) {
    val t = SystemClock.uptimeMillis() / 1000.0
    val bw = width / 5f
    for (i in 0 until 3) {
      val f = if (active) 0.3f + 0.7f * abs(sin(t * (3.0 + i * 1.4) + i)).toFloat() else 0.25f
      val h = height * f
      val x = i * bw * 2f
      c.drawRoundRect(RectF(x, height - h, x + bw, height.toFloat()), bw / 2, bw / 2, p)
    }
    if (active) postInvalidateOnAnimation()
  }
}

// The progress line (you can drag it to seek)
class BarView(ctx: Context) : View(ctx) {
  var frac = 0f
  var dragging = false
  var onSeek: ((Float) -> Unit)? = null
  private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x40FFFFFF }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

  override fun onDraw(c: Canvas) {
    val h = 4f * resources.displayMetrics.density
    val top = (height - h) / 2f
    c.drawRoundRect(RectF(0f, top, width.toFloat(), top + h), h / 2, h / 2, track)
    c.drawRoundRect(RectF(0f, top, width * frac.coerceIn(0f, 1f), top + h), h / 2, h / 2, fill)
  }

  override fun onTouchEvent(e: MotionEvent): Boolean {
    when (e.action) {
      MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
        dragging = true
        frac = (e.x / width).coerceIn(0f, 1f)
        invalidate()
        return true
      }
      MotionEvent.ACTION_UP -> {
        dragging = false
        frac = (e.x / width).coerceIn(0f, 1f)
        invalidate()
        onSeek?.invoke(frac)
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        dragging = false
        return true
      }
    }
    return super.onTouchEvent(e)
  }
}
