package com.mymusic.player

import android.content.Intent
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/** Opens Vocal Splitter or Voice Cloner from the hamburger menu, and hands over the Music Plus theme. */
class StudioAppsModule(private val rc: ReactApplicationContext) : ReactContextBaseJavaModule(rc) {
  override fun getName(): String = "StudioApps"

  @ReactMethod
  fun open(which: String, themeJson: String, promise: Promise) {
    try {
      val cls = when (which) {
        "splitter" -> "com.vocalsplitter.app.MainActivity"
        "voice" -> "com.voicestudio.app.MainActivity"
        else -> {
          promise.reject("E_UNKNOWN", "Unknown app: $which")
          return
        }
      }
      StudioTheme.save(rc.applicationContext, themeJson)
      val i = Intent()
      i.setClassName(rc.applicationContext.packageName, cls)
      i.putExtra("theme", themeJson)
      val act = rc.currentActivity
      if (act != null) {
        act.startActivity(i)
      } else {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        rc.applicationContext.startActivity(i)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_OPEN", e.message ?: "Could not open", e)
    }
  }
}

class StudioAppsPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(StudioAppsModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
