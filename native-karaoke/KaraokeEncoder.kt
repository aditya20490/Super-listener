package com.mymusic.player

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import kotlinx.coroutines.CancellationException
import java.io.File
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.min

/** Float stereo audio -> AAC-LC in an M4A file (about 1.2 MB per minute at 160 kbps, instead of 10 MB per minute as WAV). */
object KaraokeEncoder {
  private fun s16(v: Float): Short {
    val c = max(-1f, min(1f, v))
    return (c * 32767f).toInt().toShort()
  }

  fun encode(
    out: File,
    left: FloatArray,
    right: FloatArray,
    sampleRate: Int,
    bitrate: Int,
    isActive: () -> Boolean,
    onProgress: (Float) -> Unit,
  ) {
    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 2)
    format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
    format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
    format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024)

    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    var muxer: MediaMuxer? = null
    var muxStarted = false
    try {
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start()
      muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      var track = -1
      val info = MediaCodec.BufferInfo()
      val n = left.size
      var pos = 0
      var inputDone = false
      var outputDone = false
      var lastReport = 0

      while (!outputDone) {
        if (!isActive()) throw CancellationException("cancelled")

        if (!inputDone) {
          val ib = codec.dequeueInputBuffer(10_000)
          if (ib >= 0) {
            val buf = codec.getInputBuffer(ib)!!
            buf.clear()
            buf.order(ByteOrder.LITTLE_ENDIAN)
            val maxFrames = buf.capacity() / 4
            val cnt = min(maxFrames, n - pos)
            val ptsUs = pos.toLong() * 1_000_000L / sampleRate
            if (cnt <= 0) {
              codec.queueInputBuffer(ib, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              for (j in 0 until cnt) {
                buf.putShort(s16(left[pos + j]))
                buf.putShort(s16(right[pos + j]))
              }
              codec.queueInputBuffer(ib, 0, cnt * 4, ptsUs, 0)
              pos += cnt
              if (pos - lastReport > sampleRate * 5) {
                lastReport = pos
                onProgress(pos.toFloat() / n.toFloat())
              }
            }
          }
        }

        val ob = codec.dequeueOutputBuffer(info, 10_000)
        if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          track = muxer.addTrack(codec.outputFormat)
          muxer.start()
          muxStarted = true
        } else if (ob >= 0) {
          if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
          if (info.size > 0 && muxStarted) {
            val data = codec.getOutputBuffer(ob)!!
            data.position(info.offset)
            data.limit(info.offset + info.size)
            muxer.writeSampleData(track, data, info)
          }
          codec.releaseOutputBuffer(ob, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
        }
      }
      if (!muxStarted) throw IllegalStateException("The encoder produced no audio.")
    } finally {
      try { codec.stop() } catch (_: Exception) {}
      try { codec.release() } catch (_: Exception) {}
      try { if (muxStarted) muxer?.stop() } catch (_: Exception) {}
      try { muxer?.release() } catch (_: Exception) {}
    }
  }
}

/**
 * The compressed file can start a few milliseconds late (the AAC encoder adds a little silence at the start).
 * This compares the decoded file with the audio we meant to store and returns how many frames it is shifted.
 * It is used to correct the position when the karaoke audio is played, so both versions stay on the same timeline.
 */
object KaraokeLag {
  private const val SR = 44100

  fun find(ref: FloatArray, dec: FloatArray): Int {
    if (ref.size < SR * 2 || dec.size < SR * 2) return 0
    val len = min(6 * SR, ref.size - 16384)
    if (len < SR) return 0
    var start = ref.size / 2 - len / 2
    if (start < 8192) start = 8192
    if (start + len + 16384 > ref.size) start = max(8192, ref.size - len - 16384)
    if (start + len + 8192 > dec.size) return 0

    // coarse: compare averages of 8 samples
    val step = 8
    val m = len / step
    val a = FloatArray(m)
    for (i in 0 until m) {
      var s = 0f
      for (k in 0 until step) s += ref[start + i * step + k]
      a[i] = s
    }
    val maxLag = 6144
    val minLag = -2048
    var bestD = 0
    var bestScore = -Float.MAX_VALUE
    var lagD = minLag / step
    while (lagD <= maxLag / step) {
      var dot = 0f
      var ok = true
      for (i in 0 until m) {
        val idx = start + i * step + lagD * step
        if (idx < 0 || idx + step > dec.size) { ok = false; break }
        var s = 0f
        for (k in 0 until step) s += dec[idx + k]
        dot += a[i] * s
      }
      if (ok && dot > bestScore) {
        bestScore = dot
        bestD = lagD
      }
      lagD++
    }

    // fine: full resolution around the coarse result
    var best = bestD * step
    var bestFine = -Float.MAX_VALUE
    for (lag in (bestD * step - step)..(bestD * step + step)) {
      var dot = 0f
      var ok = true
      var i = 0
      while (i < len) {
        val idx = start + i + lag
        if (idx < 0 || idx >= dec.size) { ok = false; break }
        dot += ref[start + i] * dec[idx]
        i++
      }
      if (ok && dot > bestFine) {
        bestFine = dot
        best = lag
      }
    }

    // is the match real? (normalised correlation at the best lag)
    var er = 0.0
    var ed = 0.0
    var dp = 0.0
    for (i in 0 until len) {
      val idx = start + i + best
      if (idx < 0 || idx >= dec.size) return 0
      val x = ref[start + i].toDouble()
      val y = dec[idx].toDouble()
      er += x * x
      ed += y * y
      dp += x * y
    }
    if (er <= 1e-9 || ed <= 1e-9) return 0
    val corr = dp / Math.sqrt(er * ed)
    return if (corr > 0.6) best else 0
  }
}
