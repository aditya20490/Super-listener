package com.mymusic.player

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

// Saves a file from the app's cache into Downloads/Music Plus, or into Music/Edited songs (so the library finds it).
class FileSaverModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "FileSaver"

  @ReactMethod
  fun save(srcPath: String, name: String, mime: String, toMusic: Boolean, promise: Promise) {
    Thread {
      try {
        if (Build.VERSION.SDK_INT < 29) {
          promise.reject("SAVE", "Saving needs Android 10 or newer.")
        } else {
          val resolver = reactApplicationContext.contentResolver
          val src = File(srcPath.removePrefix("file://"))
          val values = ContentValues()
          values.put(MediaStore.MediaColumns.DISPLAY_NAME, name)
          values.put(MediaStore.MediaColumns.MIME_TYPE, mime)
          val folder: String
          val collection = if (toMusic) {
            folder = Environment.DIRECTORY_MUSIC + "/Edited songs"
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
          } else {
            folder = Environment.DIRECTORY_DOWNLOADS + "/Music Plus"
            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
          }
          values.put(MediaStore.MediaColumns.RELATIVE_PATH, folder)
          values.put(MediaStore.MediaColumns.IS_PENDING, 1)
          val uri = resolver.insert(collection, values) ?: throw Exception("could not create the file")
          val out = resolver.openOutputStream(uri) ?: throw Exception("could not open the file")
          out.use { o -> src.inputStream().use { i -> i.copyTo(o) } }
          val done = ContentValues()
          done.put(MediaStore.MediaColumns.IS_PENDING, 0)
          resolver.update(uri, done, null, null)
          promise.resolve(folder + "/" + name)
        }
      } catch (t: Throwable) {
        promise.reject("SAVE", t.message ?: "could not save")
      }
    }.start()
  }
}
