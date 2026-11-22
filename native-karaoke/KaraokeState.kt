package com.mymusic.player

/**
 * What the karaoke job is doing right now. One job at a time in the whole app: KaraokeModule refuses to start a second
 * one (and also refuses while the Vocal Splitter screen is separating a song).
 */
object KaraokeState {
  @Volatile var phase: String = "idle" // idle | working | done | error
  @Volatile var progress: Float = 0f
  @Volatile var etaSec: Long = -1L
  @Volatile var message: String = ""
  @Volatile var error: String = ""
  @Volatile var key: String = ""
  @Volatile var title: String = ""
  @Volatile var file: String = ""
  @Volatile var lagFrames: Int = 0
  @Volatile var frames: Long = 0L
  @Volatile var cancelRequested: Boolean = false

  fun begin(k: String, t: String) {
    key = k
    title = t
    phase = "working"
    progress = 0f
    etaSec = -1L
    message = "Starting…"
    error = ""
    file = ""
    lagFrames = 0
    frames = 0L
    cancelRequested = false
  }

  fun reset() {
    phase = "idle"
    progress = 0f
    etaSec = -1L
    message = ""
    error = ""
    key = ""
    title = ""
    file = ""
    lagFrames = 0
    frames = 0L
    cancelRequested = false
  }

  fun fail(msg: String) {
    phase = "error"
    error = msg
    message = "Failed"
  }
}
