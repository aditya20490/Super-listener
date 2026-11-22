package com.mymusic.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.vocalsplitter.app.AudioDecoder
import com.vocalsplitter.app.MdxSeparator
import com.vocalsplitter.app.Resampler
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * Makes the karaoke (instrumental) version of one song in the background, using the Vocal Splitter's own engine
 * with the "Super fast" setting (one pass, all CPU cores, no denoise pass). The result is compressed to AAC and saved in
 * the app's private no-backup folder, never in the music folders, so no other app and no scanner can see it.
 * The original song file is only read, never changed.
 */
class KaraokeService : Service() {

  companion object {
    const val ACTION_START = "com.mymusic.player.KARAOKE_START"
    const val ACTION_CANCEL = "com.mymusic.player.KARAOKE_CANCEL"
    private const val EXTRA_URI = "uri"
    private const val EXTRA_KEY = "key"
    private const val EXTRA_TITLE = "title"
    private const val CHANNEL_ID = "karaoke"
    private const val NOTIF_ID = 7301
    private const val MODEL_ASSET = "models/UVR-MDX-NET-Voc_FT.onnx"
    private const val SR = 44100
    private const val BITRATE = 160_000

    fun dir(ctx: Context): File {
      val d = File(ctx.noBackupFilesDir, "karaoke")
      if (!d.exists()) d.mkdirs()
      return d
    }

    fun baseName(key: String): String {
      val d = MessageDigest.getInstance("SHA-1").digest(key.toByteArray(Charsets.UTF_8))
      val sb = StringBuilder("k")
      for (i in 0 until 8) sb.append(String.format("%02x", d[i]))
      return sb.toString()
    }

    fun start(ctx: Context, uri: Uri, key: String, title: String) {
      val i = Intent(ctx, KaraokeService::class.java)
        .setAction(ACTION_START)
        .putExtra(EXTRA_URI, uri.toString())
        .putExtra(EXTRA_KEY, key)
        .putExtra(EXTRA_TITLE, title)
      ContextCompat.startForegroundService(ctx, i)
    }

    fun cancel(ctx: Context) {
      ctx.startService(Intent(ctx, KaraokeService::class.java).setAction(ACTION_CANCEL))
    }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private var job: Job? = null
  private var wake: PowerManager.WakeLock? = null
  private var lastNotif = 0L
  private lateinit var nm: NotificationManager

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Karaoke", NotificationManager.IMPORTANCE_LOW))
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_CANCEL -> {
        KaraokeState.cancelRequested = true
        val j = job
        if (j != null && j.isActive) j.cancel() else stopSelf()
      }
      ACTION_START -> {
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "song"
        ServiceCompat.startForeground(
          this, NOTIF_ID, buildNotification(title, "Preparing…", 0),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
        if (job?.isActive == true) return START_NOT_STICKY
        val uri = Uri.parse(intent.getStringExtra(EXTRA_URI) ?: "")
        val key = intent.getStringExtra(EXTRA_KEY) ?: ""
        launchJob(uri, key, title)
      }
    }
    return START_NOT_STICKY
  }

  private fun launchJob(uri: Uri, key: String, title: String) {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MusicPlus::karaoke").apply {
      setReferenceCounted(false)
      acquire(2L * 60 * 60 * 1000)
    }
    job = scope.launch {
      val active = { isActive && !KaraokeState.cancelRequested }
      val base = baseName(key)
      try {
        process(uri, key, title, base, active)
      } catch (e: CancellationException) {
        cleanPart(base)
        KaraokeState.reset()
      } catch (t: Throwable) {
        cleanPart(base)
        val msg = if (t is OutOfMemoryError) "Out of memory. Close other apps and try again." else (t.message ?: t.javaClass.simpleName)
        KaraokeState.fail(msg)
      } finally {
        wake?.let { if (it.isHeld) it.release() }
        ServiceCompat.stopForeground(this@KaraokeService, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
  }

  private fun cleanPart(base: String) {
    try { File(dir(applicationContext), "$base.m4a.part").delete() } catch (_: Exception) {}
  }

  private fun process(uri: Uri, key: String, title: String, base: String, active: () -> Boolean) {
    val ctx = applicationContext
    publish(title, 0f, "Reading the song…")

    val audio = AudioDecoder.decode(ctx, uri, { publish(title, it * 0.04f, "Reading the song…") }, active)
    var left = audio.left
    var right = audio.right
    if (left.isEmpty()) throw IllegalStateException("The audio file is empty or not supported.")
    if (audio.sampleRate != SR) {
      publish(title, 0.04f, "Preparing…")
      left = Resampler.resample(left, audio.sampleRate, SR)
      right = Resampler.resample(right, audio.sampleRate, SR)
    }

    publish(title, 0.05f, "Loading the AI model…")
    val modelPath = prepareModel(ctx)

    // "Super fast": one pass, every CPU core (2 to 8 threads), no denoise pass. This is always the setting for karaoke.
    val cores = Runtime.getRuntime().availableProcessors()
    val threads = cores.coerceIn(2, 8)

    MdxSeparator(modelPath, threads).use { sep ->
      val t0 = SystemClock.elapsedRealtime()
      val stems = sep.separate(left, right, false, { done, total ->
        val elapsed = (SystemClock.elapsedRealtime() - t0) / 1000.0
        val eta = if (done > 0) (elapsed / done * (total - done)).toLong() else -1L
        publish(title, 0.06f + 0.80f * (done / total.toFloat()), "Separating…", eta + 10L)
      }, active)

      // the instrumental is the original minus the vocals (same as the Vocal Splitter does)
      val n = left.size
      val vl = stems[0]
      val vr = stems[1]
      for (i in 0 until n) {
        left[i] = left[i] - vl[i]
        right[i] = right[i] - vr[i]
      }

      publish(title, 0.87f, "Compressing…", 8L)
      val outDir = dir(ctx)
      val part = File(outDir, "$base.m4a.part")
      if (part.exists()) part.delete()
      KaraokeEncoder.encode(part, left, right, SR, BITRATE, active) { p -> publish(title, 0.87f + 0.08f * p, "Compressing…", 6L) }

      publish(title, 0.96f, "Checking…", 3L)
      var lag = 0
      try {
        val dec = AudioDecoder.decode(ctx, Uri.fromFile(part), { }, active)
        if (dec.sampleRate == SR && dec.left.isNotEmpty()) {
          // the file must hold about the same amount of audio as the song
          val diff = Math.abs(dec.left.size - n)
          if (diff > SR * 2) throw IllegalStateException("The karaoke file has the wrong length.")
          lag = KaraokeLag.find(left, dec.left)
        } else {
          throw IllegalStateException("The karaoke file could not be read back.")
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: IllegalStateException) {
        throw e
      } catch (t: Throwable) {
        lag = 0
      }

      val finalFile = File(outDir, "$base.m4a")
      if (finalFile.exists()) finalFile.delete()
      if (!part.renameTo(finalFile)) throw IllegalStateException("Could not save the karaoke file.")

      val meta = JSONObject()
      meta.put("v", 1)
      meta.put("key", key)
      meta.put("title", title)
      meta.put("file", "$base.m4a")
      meta.put("createdAt", System.currentTimeMillis())
      meta.put("lagFrames", lag)
      meta.put("frames", n.toLong())
      meta.put("bytes", finalFile.length())
      File(outDir, "$base.json").writeText(meta.toString())

      KaraokeState.file = "$base.m4a"
      KaraokeState.lagFrames = lag
      KaraokeState.frames = n.toLong()
      KaraokeState.progress = 1f
      KaraokeState.etaSec = 0L
      KaraokeState.message = "Ready"
      KaraokeState.phase = "done"
    }
  }

  private fun prepareModel(ctx: Context): String {
    val target = File(ctx.filesDir, "model.onnx")
    val expected = try {
      ctx.assets.openFd(MODEL_ASSET).use { it.length }
    } catch (e: Exception) {
      -1L
    }
    if (!target.exists() || (expected > 0 && target.length() != expected)) {
      val tmp = File(ctx.filesDir, "model.onnx.karaoke.tmp")
      ctx.assets.open(MODEL_ASSET).use { input ->
        FileOutputStream(tmp).use { output -> input.copyTo(output, 1 shl 20) }
      }
      if (target.exists()) target.delete()
      if (!tmp.renameTo(target)) throw IllegalStateException("Could not prepare the AI model.")
    }
    return target.absolutePath
  }

  private fun publish(title: String, progress: Float, msg: String, eta: Long = -1L) {
    val p = progress.coerceIn(0f, 1f)
    KaraokeState.progress = p
    KaraokeState.message = msg
    KaraokeState.etaSec = eta
    val now = SystemClock.elapsedRealtime()
    if (now - lastNotif > 2000) {
      lastNotif = now
      nm.notify(NOTIF_ID, buildNotification(title, msg, (p * 100).toInt()))
    }
  }

  private fun openAppIntent(): PendingIntent {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
    return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun buildNotification(title: String, text: String, pct: Int): Notification {
    val cancel = PendingIntent.getService(
      this, 1,
      Intent(this, KaraokeService::class.java).setAction(ACTION_CANCEL),
      PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("Making karaoke")
      .setContentText(if (title.isEmpty()) text else "$title · $text")
      .setProgress(100, pct, pct == 0)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(openAppIntent())
      .addAction(0, "Cancel", cancel)
      .build()
  }

  override fun onDestroy() {
    wake?.let { if (it.isHeld) it.release() }
    scope.cancel()
    super.onDestroy()
  }
}
