package com.mymusic.player

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max

// ---------- Matroska writing helpers ----------
object Ebml {
  fun idBytes(id: Int): ByteArray {
    var n = 1
    while (n < 4 && (id ushr (8 * n)) != 0) n++
    return ByteArray(n) { i -> ((id ushr (8 * (n - 1 - i))) and 0xFF).toByte() }
  }

  fun sizeBytes(size: Long): ByteArray {
    var len = 1
    while (len < 8 && size > (1L shl (7 * len)) - 2) len++
    val v = size or (1L shl (7 * len))
    return ByteArray(len) { i -> ((v ushr (8 * (len - 1 - i))) and 0xFF).toByte() }
  }

  fun size8(size: Long): ByteArray =
    ByteArray(8) { i -> if (i == 0) 0x01.toByte() else ((size ushr (8 * (7 - i))) and 0xFF).toByte() }

  fun be8(v: Long): ByteArray = ByteArray(8) { i -> ((v ushr (8 * (7 - i))) and 0xFF).toByte() }

  fun uintBytes(v: Long): ByteArray {
    var n = 1
    while (n < 8 && (v ushr (8 * n)) != 0L) n++
    return ByteArray(n) { i -> ((v ushr (8 * (n - 1 - i))) and 0xFF).toByte() }
  }

  fun cat(vararg parts: ByteArray): ByteArray {
    val o = ByteArrayOutputStream()
    for (p in parts) o.write(p, 0, p.size)
    return o.toByteArray()
  }

  fun el(id: Int, payload: ByteArray): ByteArray = cat(idBytes(id), sizeBytes(payload.size.toLong()), payload)
  fun uint(id: Int, v: Long): ByteArray = el(id, uintBytes(v))
  fun str(id: Int, s: String): ByteArray = el(id, s.toByteArray(Charsets.UTF_8))
  fun f64(id: Int, d: Double): ByteArray = el(id, be8(java.lang.Double.doubleToLongBits(d)))
  fun fixed8(id: Int, v: Long): ByteArray = cat(idBytes(id), byteArrayOf(0x88.toByte()), be8(v))
}

class TrackDesc(
  val codecId: String,
  val priv: ByteArray?,
  val channels: Int,
  val rate: Double,
  val name: String,
  val codecDelayNs: Long = 0L,
  val seekPreRollNs: Long = 0L
)

class MkaInfo(val title: String, val durationMs: Double, val tracks: List<TrackDesc>, val numbers: List<Int>)

// ---------- Matroska writer: header, tracks, interleaved clusters, cues (so seeking works) ----------
class MkaWriter(private val file: File, private val title: String, private val tracks: List<TrackDesc>) {
  private var raf: RandomAccessFile? = null
  private var segSizePos = 0L
  private var segDataStart = 0L
  private var cuesPatchPos = 0L
  private var durPatchPos = 0L
  private val cues = ArrayList<LongArray>()
  private val buf = ByteArrayOutputStream()
  private var clusterStart = -1L
  private var maxMs = 0L

  private fun seek(id: Int, pos: Long): ByteArray =
    Ebml.el(0x4DBB, Ebml.cat(Ebml.el(0x53AB, Ebml.idBytes(id)), Ebml.fixed8(0x53AC, pos)))

  private fun seekHead(infoPos: Long, tracksPos: Long, cuesPos: Long): ByteArray =
    Ebml.el(0x114D9B74, Ebml.cat(seek(0x1549A966, infoPos), seek(0x1654AE6B, tracksPos), seek(0x1C53BB6B, cuesPos)))

  private fun entry(i: Int, t: TrackDesc): ByteArray {
    val parts = ArrayList<ByteArray>()
    parts.add(Ebml.uint(0xD7, (i + 1).toLong()))
    parts.add(Ebml.uint(0x73C5, (i + 1).toLong() + 1000L))
    parts.add(Ebml.uint(0x83, 2L))
    parts.add(Ebml.uint(0x9C, 0L))
    parts.add(Ebml.uint(0x88, if (i == 0) 1L else 0L))
    parts.add(Ebml.str(0x86, t.codecId))
    val p = t.priv
    if (p != null && p.isNotEmpty()) parts.add(Ebml.el(0x63A2, p))
    if (t.codecDelayNs > 0) parts.add(Ebml.uint(0x56AA, t.codecDelayNs))
    if (t.seekPreRollNs > 0) parts.add(Ebml.uint(0x56BB, t.seekPreRollNs))
    parts.add(Ebml.str(0x536E, t.name))
    parts.add(Ebml.str(0x22B59C, "und"))
    parts.add(Ebml.el(0xE1, Ebml.cat(Ebml.f64(0xB5, t.rate), Ebml.uint(0x9F, t.channels.toLong()))))
    return Ebml.el(0xAE, Ebml.cat(*parts.toTypedArray()))
  }

  fun start() {
    file.delete()
    val r = RandomAccessFile(file, "rw")
    raf = r
    r.write(
      Ebml.el(
        0x1A45DFA3,
        Ebml.cat(
          Ebml.uint(0x4286, 1L), Ebml.uint(0x42F7, 1L), Ebml.uint(0x42F2, 4L), Ebml.uint(0x42F3, 8L),
          Ebml.str(0x4282, "matroska"), Ebml.uint(0x4287, 4L), Ebml.uint(0x4285, 2L)
        )
      )
    )
    r.write(Ebml.idBytes(0x18538067))
    segSizePos = r.filePointer
    r.write(Ebml.size8(0L))
    segDataStart = r.filePointer

    val info = Ebml.el(
      0x1549A966,
      Ebml.cat(
        Ebml.uint(0x2AD7B1, 1000000L), Ebml.str(0x4D80, "Music Plus"), Ebml.str(0x5741, "Music Plus"),
        Ebml.str(0x7BA9, title), Ebml.f64(0x4489, 0.0)
      )
    )
    val tr = Ebml.el(0x1654AE6B, Ebml.cat(*tracks.mapIndexed { i, t -> entry(i, t) }.toTypedArray()))
    val seekLen = seekHead(0L, 0L, 0L).size
    val sh = seekHead(seekLen.toLong(), (seekLen + info.size).toLong(), 0L)
    cuesPatchPos = r.filePointer + sh.size - 8
    r.write(sh)
    durPatchPos = r.filePointer + info.size - 8
    r.write(info)
    r.write(tr)
  }

  private fun flush() {
    val r = raf ?: return
    if (clusterStart < 0) return
    val body = Ebml.cat(Ebml.uint(0xE7, clusterStart), buf.toByteArray())
    val pos = r.filePointer - segDataStart
    r.write(Ebml.el(0x1F43B675, body))
    cues.add(longArrayOf(clusterStart, pos))
    buf.reset()
    clusterStart = -1L
  }

  fun write(trackIdx: Int, timeMs: Long, data: ByteArray, len: Int) {
    if (clusterStart >= 0 && (timeMs - clusterStart > 4000 || timeMs < clusterStart || buf.size() > 900000)) flush()
    if (clusterStart < 0) clusterStart = timeMs
    val rel = (timeMs - clusterStart).toInt()
    val hdr = byteArrayOf((0x80 or (trackIdx + 1)).toByte(), (rel shr 8).toByte(), rel.toByte(), 0x80.toByte())
    buf.write(Ebml.idBytes(0xA3))
    buf.write(Ebml.sizeBytes((4 + len).toLong()))
    buf.write(hdr, 0, 4)
    buf.write(data, 0, len)
    if (timeMs > maxMs) maxMs = timeMs
  }

  fun finish(durationMs: Long) {
    val r = raf ?: return
    flush()
    val cuesPos = r.filePointer - segDataStart
    val pts = ByteArrayOutputStream()
    for (c in cues) {
      val tp = tracks.indices.map { i -> Ebml.el(0xB7, Ebml.cat(Ebml.uint(0xF7, (i + 1).toLong()), Ebml.uint(0xF1, c[1]))) }
      val pt = Ebml.el(0xBB, Ebml.cat(Ebml.uint(0xB3, c[0]), *tp.toTypedArray()))
      pts.write(pt, 0, pt.size)
    }
    r.write(Ebml.el(0x1C53BB6B, pts.toByteArray()))
    val end = r.filePointer
    r.seek(segSizePos)
    r.write(Ebml.size8(end - segDataStart))
    r.seek(cuesPatchPos)
    r.write(Ebml.be8(cuesPos))
    r.seek(durPatchPos)
    r.write(Ebml.be8(java.lang.Double.doubleToLongBits(max(durationMs, maxMs).toDouble())))
    r.close()
    raf = null
  }

  fun abort() {
    try { raf?.close() } catch (t: Throwable) {}
    raf = null
  }
}

// ---------- Matroska reader ----------
class MkaReader(file: File) {
  private val raf = RandomAccessFile(file, "r")
  private var segEnd = 0L
  private var timeScale = 1000000L
  private val top = setOf(0x1F43B675L, 0x1C53BB6BL, 0x1254C367L, 0x114D9B74L, 0x1549A966L, 0x1654AE6BL, 0x1941A469L, 0x1043A770L)

  private class Hdr(val id: Long, val size: Long, val dataPos: Long)

  private fun readHdr(): Hdr? {
    val b0 = raf.read()
    if (b0 < 0) return null
    var len = 1
    var mask = 0x80
    while (len <= 4 && (b0 and mask) == 0) { len++; mask = mask shr 1 }
    if (len > 4) return null
    var id = b0.toLong()
    for (i in 1 until len) {
      val x = raf.read()
      if (x < 0) return null
      id = (id shl 8) or x.toLong()
    }
    val s0 = raf.read()
    if (s0 < 0) return null
    var sl = 1
    var sm = 0x80
    while (sl <= 8 && (s0 and sm) == 0) { sl++; sm = sm shr 1 }
    if (sl > 8) return null
    var size = (s0 and (sm - 1)).toLong()
    var ones = (s0 and (sm - 1)) == (sm - 1)
    for (i in 1 until sl) {
      val x = raf.read()
      if (x < 0) return null
      if (x != 0xFF) ones = false
      size = (size shl 8) or x.toLong()
    }
    return Hdr(id, if (ones) -1L else size, raf.filePointer)
  }

  private fun readUint(n: Int): Long {
    var v = 0L
    for (i in 0 until n) v = (v shl 8) or raf.read().toLong()
    return v
  }

  private fun readFloat(n: Int): Double =
    if (n == 4) java.lang.Float.intBitsToFloat(readUint(4).toInt()).toDouble()
    else java.lang.Double.longBitsToDouble(readUint(8))

  private fun readBytes(n: Int): ByteArray {
    val b = ByteArray(n)
    raf.readFully(b)
    return b
  }

  private fun readStr(n: Int): String = String(readBytes(n), Charsets.UTF_8).trimEnd('\u0000')

  private fun enterSegment(): Boolean {
    raf.seek(0)
    while (true) {
      val h = readHdr() ?: return false
      if (h.id == 0x18538067L) {
        segEnd = if (h.size < 0) raf.length() else Math.min(raf.length(), h.dataPos + h.size)
        return true
      }
      if (h.size < 0) return false
      raf.seek(h.dataPos + h.size)
    }
  }

  fun close() {
    try { raf.close() } catch (t: Throwable) {}
  }

  private fun readEntry(end: Long, tracks: ArrayList<TrackDesc>, nums: ArrayList<Int>) {
    var num = 0
    var type = 0
    var codec = ""
    var priv: ByteArray? = null
    var name = ""
    var ch = 2
    var rate = 44100.0
    var delay = 0L
    var pre = 0L
    while (raf.filePointer < end) {
      val c = readHdr() ?: break
      val ce = c.dataPos + c.size
      val n = c.size.toInt()
      when (c.id) {
        0xD7L -> num = readUint(n).toInt()
        0x83L -> type = readUint(n).toInt()
        0x86L -> codec = readStr(n)
        0x63A2L -> priv = readBytes(n)
        0x536EL -> name = readStr(n)
        0x56AAL -> delay = readUint(n)
        0x56BBL -> pre = readUint(n)
        0xE1L -> {
          while (raf.filePointer < ce) {
            val a = readHdr() ?: break
            val ae = a.dataPos + a.size
            if (a.id == 0xB5L) rate = readFloat(a.size.toInt())
            if (a.id == 0x9FL) ch = readUint(a.size.toInt()).toInt()
            raf.seek(ae)
          }
        }
        else -> {}
      }
      raf.seek(ce)
    }
    if (type == 2) {
      tracks.add(TrackDesc(codec, priv, ch, rate, if (name.isEmpty()) "Track $num" else name, delay, pre))
      nums.add(num)
    }
  }

  fun readInfo(): MkaInfo {
    if (!enterSegment()) throw Exception("This is not a Matroska (.mka) file")
    var title = ""
    var dur = 0.0
    val tracks = ArrayList<TrackDesc>()
    val nums = ArrayList<Int>()
    while (raf.filePointer < segEnd) {
      val h = readHdr() ?: break
      if (h.id == 0x1F43B675L || h.size < 0) break
      val end = h.dataPos + h.size
      if (h.id == 0x1549A966L) {
        while (raf.filePointer < end) {
          val c = readHdr() ?: break
          val ce = c.dataPos + c.size
          when (c.id) {
            0x2AD7B1L -> timeScale = readUint(c.size.toInt())
            0x4489L -> dur = readFloat(c.size.toInt())
            0x7BA9L -> title = readStr(c.size.toInt())
            else -> {}
          }
          raf.seek(ce)
        }
      } else if (h.id == 0x1654AE6BL) {
        while (raf.filePointer < end) {
          val c = readHdr() ?: break
          val ce = c.dataPos + c.size
          if (c.id == 0xAEL) readEntry(ce, tracks, nums)
          raf.seek(ce)
        }
      }
      raf.seek(end)
    }
    return MkaInfo(title, dur * timeScale / 1000000.0, tracks, nums)
  }

  private fun block(pos: Long, size: Int, ct: Long, want: Int, cb: (Long, ByteArray) -> Unit) {
    raf.seek(pos)
    val b0 = raf.read()
    var len = 1
    var mask = 0x80
    while (len <= 8 && (b0 and mask) == 0) { len++; mask = mask shr 1 }
    var tn = (b0 and (mask - 1)).toLong()
    for (i in 1 until len) tn = (tn shl 8) or raf.read().toLong()
    val hi = raf.read()
    val lo = raf.read()
    val rel = ((hi shl 8) or lo).toShort().toInt()
    val flags = raf.read()
    val hdr = len + 3
    if (tn.toInt() != want || (flags and 0x06) != 0 || size - hdr <= 0) return
    val data = ByteArray(size - hdr)
    raf.readFully(data)
    cb((ct + rel) * timeScale / 1000000L, data)
  }

  // Calls cb(timeMs, frame) for every frame of one track
  fun readFrames(trackNo: Int, cb: (Long, ByteArray) -> Unit) {
    if (!enterSegment()) return
    while (raf.filePointer < segEnd) {
      val h = readHdr() ?: break
      if (h.id != 0x1F43B675L) {
        if (h.size < 0) break
        raf.seek(h.dataPos + h.size)
        continue
      }
      val end = if (h.size < 0) segEnd else h.dataPos + h.size
      var ct = 0L
      while (raf.filePointer < end) {
        val cs = raf.filePointer
        val c = readHdr() ?: break
        if (h.size < 0 && top.contains(c.id)) { raf.seek(cs); break }
        if (c.size < 0) break
        val ce = c.dataPos + c.size
        when (c.id) {
          0xE7L -> ct = readUint(c.size.toInt())
          0xA3L -> block(c.dataPos, c.size.toInt(), ct, trackNo, cb)
          0xA0L -> {
            while (raf.filePointer < ce) {
              val b = readHdr() ?: break
              if (b.size < 0) break
              if (b.id == 0xA1L) block(b.dataPos, b.size.toInt(), ct, trackNo, cb)
              raf.seek(b.dataPos + b.size)
            }
          }
          else -> {}
        }
        raf.seek(ce)
      }
      if (h.size >= 0) raf.seek(end)
    }
  }
}

// ---------- the bridge ----------
class MkaModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "Mka"

  private fun pathOf(u: String): String? {
    val p = Uri.parse(u)
    return when (p.scheme) {
      null -> u
      "file" -> p.path
      else -> null
    }
  }

  private fun openStream(c: Context, u: String): InputStream {
    val path = pathOf(u)
    if (path != null && File(path).exists()) return FileInputStream(path)
    return c.contentResolver.openInputStream(Uri.parse(u)) ?: throw Exception("could not open the file")
  }

  private fun readN(s: InputStream, n: Int): ByteArray {
    val b = ByteArray(n)
    var got = 0
    while (got < n) {
      val r = s.read(b, got, n - got)
      if (r < 0) throw Exception("unexpected end of file")
      got += r
    }
    return b
  }

  // FLAC needs its STREAMINFO block as the codec data
  private fun flacPrivate(c: Context, u: String): ByteArray {
    val s = BufferedInputStream(openStream(c, u))
    try {
      var first = readN(s, 4)
      if (first[0] == 'I'.code.toByte() && first[1] == 'D'.code.toByte() && first[2] == '3'.code.toByte()) {
        val rest = readN(s, 6)
        val sz = ((rest[2].toInt() and 0x7F) shl 21) or ((rest[3].toInt() and 0x7F) shl 14) or
          ((rest[4].toInt() and 0x7F) shl 7) or (rest[5].toInt() and 0x7F)
        readN(s, sz)
        first = readN(s, 4)
      }
      if (String(first, Charsets.ISO_8859_1) != "fLaC") throw Exception("not a FLAC file")
      val bh = readN(s, 4)
      val len = ((bh[1].toInt() and 255) shl 16) or ((bh[2].toInt() and 255) shl 8) or (bh[3].toInt() and 255)
      val si = readN(s, len)
      return Ebml.cat("fLaC".toByteArray(Charsets.ISO_8859_1), byteArrayOf(0x80.toByte(), 0, 0, len.toByte()), si)
    } finally {
      try { s.close() } catch (t: Throwable) {}
    }
  }

  private fun csd(f: MediaFormat, key: String): ByteArray? {
    val b = f.getByteBuffer(key) ?: return null
    val d = b.duplicate()
    val a = ByteArray(d.remaining())
    d.get(a)
    return a
  }

  private fun longOf(a: ByteArray?): Long {
    if (a == null || a.size < 8) return 0L
    return ByteBuffer.wrap(a).order(ByteOrder.nativeOrder()).long
  }

  @ReactMethod
  fun create(inputsJson: String, title: String, outPath: String, promise: Promise) {
    Thread {
      val ctx = reactApplicationContext.applicationContext
      val exts = ArrayList<MediaExtractor>()
      var writer: MkaWriter? = null
      try {
        val arr = JSONArray(inputsJson)
        val descs = ArrayList<TrackDesc>()
        for (i in 0 until arr.length()) {
          val o = arr.getJSONObject(i)
          val u = o.getString("uri")
          val name = o.optString("name", "Version " + (i + 1))
          val ex = MediaExtractor()
          exts.add(ex)
          val path = pathOf(u)
          try {
            if (path != null) ex.setDataSource(path) else ex.setDataSource(ctx, Uri.parse(u), null)
          } catch (e: Exception) {
            ex.setDataSource(ctx, Uri.parse(u), null)
          }
          var ti = -1
          var fmt: MediaFormat? = null
          for (k in 0 until ex.trackCount) {
            val f = ex.getTrackFormat(k)
            if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) { ti = k; fmt = f; break }
          }
          if (ti < 0 || fmt == null) throw Exception("\"" + name + "\" has no audio")
          ex.selectTrack(ti)
          val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
          val rate = if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE).toDouble() else 44100.0
          val ch = if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 2
          when (mime) {
            "audio/mpeg" -> descs.add(TrackDesc("A_MPEG/L3", null, ch, rate, name))
            "audio/mp4a-latm" -> descs.add(TrackDesc("A_AAC", csd(fmt, "csd-0"), ch, rate, name))
            "audio/flac" -> descs.add(TrackDesc("A_FLAC", flacPrivate(ctx, u), ch, rate, name))
            "audio/opus" -> descs.add(
              TrackDesc("A_OPUS", csd(fmt, "csd-0"), ch, 48000.0, name, longOf(csd(fmt, "csd-1")), longOf(csd(fmt, "csd-2")))
            )
            else -> throw Exception("\"" + name + "\" is " + mime + ". Supported: MP3, AAC/M4A, FLAC and Opus.")
          }
        }
        val w = MkaWriter(File(outPath), title, descs)
        writer = w
        w.start()
        val bb = ByteBuffer.allocate(4 * 1024 * 1024)
        var maxMs = 0L
        while (true) {
          var best = -1
          var bestT = Long.MAX_VALUE
          for (i in exts.indices) {
            val t = exts[i].sampleTime
            if (t >= 0 && t < bestT) { best = i; bestT = t }
          }
          if (best < 0) break
          val ex = exts[best]
          bb.clear()
          val n = ex.readSampleData(bb, 0)
          if (n > 0) {
            bb.position(0)
            bb.limit(n)
            val arrB = ByteArray(n)
            bb.get(arrB)
            val ms = bestT / 1000L
            w.write(best, ms, arrB, n)
            if (ms > maxMs) maxMs = ms
          }
          ex.advance()
        }
        w.finish(maxMs + 30L)
        writer = null
        val res = JSONObject()
        res.put("tracks", descs.size)
        res.put("durationMs", maxMs)
        promise.resolve(res.toString())
      } catch (t: Throwable) {
        writer?.abort()
        promise.reject("MKA", t.message ?: "could not create the bundle")
      } finally {
        for (e in exts) {
          try { e.release() } catch (t: Throwable) {}
        }
      }
    }.start()
  }

  @ReactMethod
  fun list(path: String, promise: Promise) {
    Thread {
      var r: MkaReader? = null
      try {
        r = MkaReader(File(path))
        val info = r.readInfo()
        val o = JSONObject()
        o.put("title", info.title)
        o.put("durationMs", info.durationMs)
        val arr = JSONArray()
        for (i in info.tracks.indices) {
          val t = info.tracks[i]
          val j = JSONObject()
          j.put("number", info.numbers[i])
          j.put("name", t.name)
          j.put("codec", when (t.codecId) {
            "A_MPEG/L3" -> "MP3"
            "A_AAC" -> "AAC"
            "A_FLAC" -> "FLAC"
            "A_OPUS" -> "Opus"
            "A_VORBIS" -> "Vorbis"
            else -> t.codecId
          })
          j.put("channels", t.channels)
          j.put("rate", t.rate)
          arr.put(j)
        }
        o.put("tracks", arr)
        promise.resolve(o.toString())
      } catch (t: Throwable) {
        promise.reject("MKA", t.message ?: "could not read the bundle")
      } finally {
        r?.close()
      }
    }.start()
  }

  // Copies one version out into its own single-track .mka (no re-encoding), ready to play
  @ReactMethod
  fun extract(path: String, trackNo: Int, outPath: String, promise: Promise) {
    Thread {
      var r: MkaReader? = null
      var w: MkaWriter? = null
      try {
        r = MkaReader(File(path))
        val info = r.readInfo()
        val idx = info.numbers.indexOf(trackNo)
        if (idx < 0) throw Exception("version not found")
        val t = info.tracks[idx]
        val out = MkaWriter(File(outPath), info.title + " - " + t.name, listOf(t))
        w = out
        out.start()
        var maxMs = 0L
        r.readFrames(trackNo) { ms, data ->
          out.write(0, ms, data, data.size)
          if (ms > maxMs) maxMs = ms
        }
        out.finish(maxMs + 30L)
        w = null
        promise.resolve(outPath)
      } catch (t: Throwable) {
        w?.abort()
        promise.reject("MKA", t.message ?: "could not open that version")
      } finally {
        r?.close()
      }
    }.start()
  }
}
