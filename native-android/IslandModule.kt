package com.mymusic.player

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.service.notification.NotificationListenerService
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// Needed so Android lets us read what music is playing. It does nothing else.
class IslandListener : NotificationListenerService()

// The settings screen of the app talks to the island through this
class IslandModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "Island"

  private fun app(): Context = reactApplicationContext.applicationContext

  private fun go(i: Intent) {
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      app().startActivity(i)
    } catch (t: Throwable) {
    }
  }

  @ReactMethod
  fun status(p: Promise) {
    try {
      val c = app()
      val pkg = c.packageName
      val m = Arguments.createMap()
      val acc = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
      m.putBoolean("accessibility", acc.contains(pkg) && acc.contains("IslandService"))
      val nl = Settings.Secure.getString(c.contentResolver, "enabled_notification_listeners") ?: ""
      m.putBoolean("notification", nl.contains(pkg))
      val pm = c.getSystemService(Context.POWER_SERVICE) as PowerManager
      m.putBoolean("battery", pm.isIgnoringBatteryOptimizations(pkg))
      p.resolve(m)
    } catch (t: Throwable) {
      p.reject("ISLAND", t.message ?: "status failed")
    }
  }

  @ReactMethod
  fun openAccessibility() {
    go(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
  }

  @ReactMethod
  fun openNotificationAccess() {
    go(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
  }

  @ReactMethod
  fun openAppInfo() {
    go(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + app().packageName)))
  }

  @ReactMethod
  fun requestBattery() {
    try {
      go(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + app().packageName)))
    } catch (t: Throwable) {
      go(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
  }

  @ReactMethod
  fun getPrefs(p: Promise) {
    val m = Arguments.createMap()
    m.putBoolean("enabled", IslandPrefs.enabled(app()))
    m.putInt("offset", IslandPrefs.offset(app()))
    m.putInt("width", IslandPrefs.width(app()))
    p.resolve(m)
  }

  @ReactMethod
  fun setPrefs(enabled: Boolean, offset: Int, width: Int) {
    IslandPrefs.sp(app()).edit().putBoolean("enabled", enabled).putInt("offset", offset).putInt("width", width).apply()
    Handler(Looper.getMainLooper()).post { IslandService.instance?.applyPrefs() }
  }

  @ReactMethod
  fun demo(p: Promise) {
    Handler(Looper.getMainLooper()).post {
      val s = IslandService.instance
      p.resolve(s != null && s.demo())
    }
  }
}
