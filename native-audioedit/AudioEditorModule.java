package com.musicplus.audioedit;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.ShortBuffer;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The audio editor's engine. It decodes a song to raw audio in memory, applies the list of edits the screen sends
 * (always starting again from the untouched original, so any edit can be undone), finds seamless loops, plays the
 * result and writes it out as a WAV file. The song file itself is never changed.
 */
public class AudioEditorModule extends ReactContextBaseJavaModule {

    private static final int PEAKS = 900;

    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final Object lock = new Object();

    private short[] orig;
    private short[] cur;
    private int ch = 2;
    private int sr = 44100;
    private volatile boolean cancel = false;

    // playback
    private AudioTrack track;
    private Thread writer;
    private volatile boolean playing = false;
    private volatile boolean ended = false;
    private int pbStart, pbRegionStart, pbRegionEnd;
    private boolean pbLoop;
    private long pbWritten;
    private short[] pbData;

    public AudioEditorModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "AudioEditor";
    }

    private void emit(String name, WritableMap m) {
        try {
            getReactApplicationContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(name, m);
        } catch (Exception ignored) {
        }
    }

    // ---------------------------------------------------------------- decoding

    private static final class Shorts {
        short[] a = new short[1 << 20];
        int n = 0;

        void ensure(int more) {
            if (n + more > a.length) {
                long want = Math.max((long) a.length * 2, (long) n + more);
                if (want > Integer.MAX_VALUE - 8) throw new OutOfMemoryError("too long");
                a = java.util.Arrays.copyOf(a, (int) want);
            }
        }
    }

    private void decode(String uriText) throws Exception {
        Context ctx = getReactApplicationContext();
        Uri uri = uriText.indexOf("://") > 0 ? Uri.parse(uriText) : Uri.fromFile(new File(uriText));
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        try {
            ex.setDataSource(ctx, uri, null);
            int ti = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    ti = i;
                    fmt = f;
                    break;
                }
            }
            if (ti < 0) throw new Exception("This file has no audio.");
            ex.selectTrack(ti);
            int rate = fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
            int chans = fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 2;
            long durUs = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) : 0;
            if (durUs > 20L * 60 * 1000000L) throw new Exception("This song is longer than 20 minutes. The editor handles up to 20 minutes.");
            codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
            codec.configure(fmt, null, null, 0);
            codec.start();

            Shorts out = new Shorts();
            if (durUs > 0) {
                long est = durUs * rate / 1000000L * Math.min(2, chans) + 4096;
                if (est < Integer.MAX_VALUE / 2) out.a = new short[(int) est];
            }
            int outCh = Math.min(2, chans);
            int srcCh = chans;
            int encoding = AudioFormat.ENCODING_PCM_16BIT;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false, outDone = false;
            while (!outDone) {
                if (!inDone) {
                    int ii = codec.dequeueInputBuffer(10000);
                    if (ii >= 0) {
                        ByteBuffer ib = codec.getInputBuffer(ii);
                        int sz = ex.readSampleData(ib, 0);
                        if (sz < 0) {
                            codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(ii, 0, sz, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int oi = codec.dequeueOutputBuffer(info, 10000);
                if (oi >= 0) {
                    if (info.size > 0) {
                        ByteBuffer ob = codec.getOutputBuffer(oi);
                        ob.order(ByteOrder.nativeOrder());
                        ob.position(info.offset);
                        ob.limit(info.offset + info.size);
                        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
                            FloatBuffer fb = ob.asFloatBuffer();
                            int frames = fb.remaining() / srcCh;
                            out.ensure(frames * outCh);
                            for (int i = 0; i < frames; i++) {
                                for (int c = 0; c < srcCh; c++) {
                                    float v = fb.get();
                                    if (c < outCh) {
                                        int s = Math.round(v * 32767f);
                                        out.a[out.n++] = (short) Math.max(-32768, Math.min(32767, s));
                                    }
                                }
                            }
                        } else {
                            ShortBuffer sb = ob.asShortBuffer();
                            int frames = sb.remaining() / srcCh;
                            out.ensure(frames * outCh);
                            if (srcCh == outCh) {
                                sb.get(out.a, out.n, frames * outCh);
                                out.n += frames * outCh;
                            } else {
                                for (int i = 0; i < frames; i++) {
                                    for (int c = 0; c < srcCh; c++) {
                                        short v = sb.get();
                                        if (c < outCh) out.a[out.n++] = v;
                                    }
                                }
                            }
                        }
                    }
                    codec.releaseOutputBuffer(oi, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                } else if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat nf = codec.getOutputFormat();
                    if (nf.containsKey(MediaFormat.KEY_SAMPLE_RATE)) rate = nf.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    if (nf.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                        srcCh = nf.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                        outCh = Math.min(2, srcCh);
                    }
                    encoding = nf.containsKey(MediaFormat.KEY_PCM_ENCODING) ? nf.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
                }
            }
            int frames = out.n / outCh;
            short[] pcm = java.util.Arrays.copyOf(out.a, frames * outCh);
            out = null;
            synchronized (lock) {
                orig = pcm;
                cur = pcm;
                ch = outCh;
                sr = rate;
            }
        } finally {
            try {
                if (codec != null) {
                    codec.stop();
                    codec.release();
                }
            } catch (Exception ignored) {
            }
            ex.release();
        }
    }

    private WritableArray peaksOf(short[] d, int n) {
        WritableArray arr = Arguments.createArray();
        int frames = d.length / ch;
        if (frames == 0) return arr;
        for (int i = 0; i < n; i++) {
            int a = (int) ((long) frames * i / n);
            int b = (int) ((long) frames * (i + 1) / n);
            if (b <= a) b = Math.min(frames, a + 1);
            int p = 0;
            int step = Math.max(1, (b - a) / 64);
            for (int f = a; f < b; f += step) {
                for (int c = 0; c < ch; c++) {
                    int v = Math.abs((int) d[f * ch + c]);
                    if (v > p) p = v;
                }
            }
            arr.pushDouble(p / 32768.0);
        }
        return arr;
    }

    private WritableMap describe(short[] d) {
        WritableMap m = Arguments.createMap();
        int frames = d.length / ch;
        m.putInt("sampleRate", sr);
        m.putInt("channels", ch);
        m.putDouble("frames", frames);
        m.putDouble("duration", frames / (double) sr);
        m.putArray("peaks", peaksOf(d, PEAKS));
        return m;
    }

    /** Loads a song. Resolves with its length and waveform. */
    @ReactMethod
    public void open(final String uri, final Promise promise) {
        stopPlayback();
        pool.execute(new Runnable() {
            public void run() {
                try {
                    synchronized (lock) {
                        orig = null;
                        cur = null;
                    }
                    decode(uri);
                    WritableMap m;
                    synchronized (lock) {
                        m = describe(cur);
                    }
                    promise.resolve(m);
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "This song is too big for the editor on this phone.");
                } catch (Exception e) {
                    promise.reject("E_DECODE", e.getMessage() == null ? "Could not read this song." : e.getMessage());
                } catch (Throwable e) {
                    promise.reject("E_DECODE", "Could not read this song.");
                }
            }
        });
    }

    // ---------------------------------------------------------------- edits

    private static List<OpsRunner.Op> parse(String json) throws Exception {
        JSONArray arr = new JSONArray(json);
        java.util.ArrayList<OpsRunner.Op> ops = new java.util.ArrayList<OpsRunner.Op>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            OpsRunner.Op p = new OpsRunner.Op();
            p.t = o.optString("t", "");
            p.from = o.optDouble("from", -1);
            p.to = o.optDouble("to", -1);
            p.db = o.optDouble("db", 0);
            p.factor = o.optDouble("factor", 1);
            p.a = (long) o.optDouble("a", 0);
            p.b = (long) o.optDouble("b", 0);
            p.xf = (long) o.optDouble("xf", 0);
            p.target = (long) o.optDouble("target", 0);
            ops.add(p);
        }
        return ops;
    }

    /** Applies the whole edit list to the original and makes the result the current audio. */
    @ReactMethod
    public void render(final String opsJson, final Promise promise) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    short[] src;
                    int c, r;
                    synchronized (lock) {
                        src = orig;
                        c = ch;
                        r = sr;
                    }
                    if (src == null) {
                        promise.reject("E_NONE", "Open a song first.");
                        return;
                    }
                    short[] d = src;
                    for (OpsRunner.Op op : parse(opsJson)) d = OpsRunner.apply(d, c, r, op);
                    WritableMap m;
                    synchronized (lock) {
                        cur = d;
                        m = describe(d);
                    }
                    promise.resolve(m);
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "That result is too big for this phone. Try a shorter length.");
                } catch (Exception e) {
                    promise.reject("E_RENDER", e.getMessage() == null ? "Could not apply that edit." : e.getMessage());
                } catch (Throwable e) {
                    promise.reject("E_RENDER", "Could not apply that edit.");
                }
            }
        });
    }

    // ---------------------------------------------------------------- loop finder

    @ReactMethod
    public void cancelAnalysis() {
        cancel = true;
    }

    /** Searches the current audio for the best seamless loops. */
    @ReactMethod
    public void findLoops(final String optionsJson, final Promise promise) {
        cancel = false;
        pool.execute(new Runnable() {
            public void run() {
                try {
                    short[] d;
                    int c, r;
                    synchronized (lock) {
                        d = cur;
                        c = ch;
                        r = sr;
                    }
                    if (d == null) {
                        promise.reject("E_NONE", "Open a song first.");
                        return;
                    }
                    JSONObject o = new JSONObject(optionsJson == null ? "{}" : optionsJson);
                    LoopEngine.Options opt = new LoopEngine.Options();
                    opt.wholeSong = o.optBoolean("wholeSong", false);
                    opt.minLenSec = o.optDouble("minLenSec", 0);
                    opt.xfSec = o.optDouble("xfSec", 0);
                    long t0 = System.currentTimeMillis();
                    List<LoopEngine.Candidate> res = LoopEngine.find(d, c, r, opt, new LoopEngine.Progress() {
                        public void on(float f, String s) {
                            WritableMap m = Arguments.createMap();
                            m.putDouble("fraction", f);
                            m.putString("stage", s);
                            emit("AudioEditorProgress", m);
                        }

                        public boolean cancelled() {
                            return cancel;
                        }
                    });
                    if (res == null) {
                        promise.reject("E_CANCEL", "Cancelled.");
                        return;
                    }
                    WritableArray arr = Arguments.createArray();
                    for (LoopEngine.Candidate k : res) {
                        WritableMap m = Arguments.createMap();
                        m.putDouble("a", k.a);
                        m.putDouble("b", k.b);
                        m.putDouble("xf", k.xf);
                        m.putDouble("startSec", k.a / (double) r);
                        m.putDouble("endSec", k.b / (double) r);
                        m.putDouble("lenSec", k.lenSec);
                        m.putDouble("quality", k.quality);
                        m.putDouble("pre", k.pre);
                        m.putDouble("ncc", k.ncc);
                        arr.pushMap(m);
                    }
                    WritableMap out = Arguments.createMap();
                    out.putArray("loops", arr);
                    out.putDouble("ms", System.currentTimeMillis() - t0);
                    promise.resolve(out);
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "Not enough memory to analyze this song.");
                } catch (Exception e) {
                    promise.reject("E_LOOP", e.getMessage() == null ? "The loop search failed." : e.getMessage());
                } catch (Throwable e) {
                    promise.reject("E_LOOP", "The loop search failed.");
                }
            }
        });
    }

    // ---------------------------------------------------------------- playback

    private void stopPlayback() {
        AudioTrack t;
        Thread w;
        synchronized (lock) {
            playing = false;
            t = track;
            w = writer;
            track = null;
            writer = null;
        }
        if (t != null) {
            try {
                t.pause();
                t.flush();
            } catch (Exception ignored) {
            }
        }
        if (w != null) {
            try {
                w.join(400);
            } catch (Exception ignored) {
            }
        }
        if (t != null) {
            try {
                t.release();
            } catch (Exception ignored) {
            }
        }
    }

    private double positionSeconds() {
        AudioTrack t = track;
        if (t == null) return -1;
        long head = t.getPlaybackHeadPosition() & 0xFFFFFFFFL;
        long p;
        long firstPass = pbRegionEnd - pbStart;
        if (!pbLoop) {
            p = Math.min(pbRegionEnd, pbStart + head);
        } else if (head < firstPass) {
            p = pbStart + head;
        } else {
            long len = Math.max(1, pbRegionEnd - pbRegionStart);
            p = pbRegionStart + ((head - firstPass) % len);
        }
        return p / (double) sr;
    }

    /**
     * Plays the current audio (or the untouched original) from startSec. With loop = true it plays endSec back into
     * loopStartSec again and again with no gap.
     */
    @ReactMethod
    public void play(double startSec, double endSec, double loopStartSec, boolean loop, boolean original, Promise promise) {
        try {
            stopPlayback();
            short[] d;
            int c, r;
            synchronized (lock) {
                d = original ? orig : cur;
                c = ch;
                r = sr;
            }
            if (d == null) {
                promise.resolve(false);
                return;
            }
            int frames = d.length / c;
            int s0 = (int) Math.max(0, Math.min(frames - 1, Math.round(startSec * r)));
            int re = endSec < 0 ? frames : (int) Math.max(s0 + 1, Math.min(frames, Math.round(endSec * r)));
            int rs = loop ? (int) Math.max(0, Math.min(re - 1, Math.round(loopStartSec * r))) : s0;
            if (loop && s0 < rs) s0 = rs;
            startTrack(d, c, r, s0, rs, re, loop);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("E_PLAY", e.getMessage() == null ? "Could not play." : e.getMessage());
        }
    }

    /** Starts playing d (frames s0 .. re; with loop = true it jumps from re back to rs again and again). */
    private void startTrack(short[] d, int c, int r, int s0, int rs, int re, boolean loop) throws Exception {
        {
            stopPlayback();
            int mask = c == 1 ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO;
            int minBuf = AudioTrack.getMinBufferSize(r, mask, AudioFormat.ENCODING_PCM_16BIT);
            int bufSize = Math.max(minBuf, r * c * 2 / 4);
            final AudioTrack t = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(r)
                            .setChannelMask(mask)
                            .build())
                    .setBufferSizeInBytes(bufSize)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            final short[] data = d;
            final int cc = c;
            final int start = s0, regionStart = rs, regionEnd = re;
            final boolean lp = loop;
            synchronized (lock) {
                pbData = data;
                pbStart = start;
                pbRegionStart = regionStart;
                pbRegionEnd = regionEnd;
                pbLoop = lp;
                pbWritten = 0;
                ended = false;
                playing = true;
                track = t;
            }
            t.play();
            Thread w = new Thread(new Runnable() {
                public void run() {
                    int pos = start;
                    long written = 0;
                    try {
                        while (playing && track == t) {
                            if (pos >= regionEnd) {
                                if (lp) pos = regionStart;
                                else break;
                            }
                            int n = Math.min(4096, regionEnd - pos);
                            int wr = t.write(data, pos * cc, n * cc);
                            if (wr < 0) break;
                            pos += wr / cc;
                            written += wr / cc;
                        }
                        if (playing && track == t && !lp) {
                            long until = System.currentTimeMillis() + 3000;
                            while (playing && track == t && System.currentTimeMillis() < until) {
                                long head = t.getPlaybackHeadPosition() & 0xFFFFFFFFL;
                                if (head >= written) break;
                                Thread.sleep(20);
                            }
                            if (playing && track == t) ended = true;
                        }
                    } catch (Exception ignored) {
                    }
                }
            }, "AudioEditorPlay");
            synchronized (lock) {
                writer = w;
            }
            w.start();
        }
    }

    /** Where playback is now, in seconds of the audio being played. */
    @ReactMethod
    public void getPosition(Promise promise) {
        WritableMap m = Arguments.createMap();
        double p = positionSeconds();
        m.putDouble("position", p);
        m.putBoolean("playing", track != null && playing && !ended);
        m.putBoolean("ended", ended);
        promise.resolve(m);
    }

    /** Stops playback and tells where it stopped. */
    @ReactMethod
    public void stop(Promise promise) {
        double p = positionSeconds();
        stopPlayback();
        WritableMap m = Arguments.createMap();
        m.putDouble("position", p);
        promise.resolve(m);
    }

    // ---------------------------------------------------------------- saving

    private static void le(ByteBuffer b, int v) {
        b.putInt(v);
    }

    private File exportDir() {
        File dir = new File(getReactApplicationContext().getCacheDir(), "audioedit");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private static String safeName(String name) {
        String safe = name == null ? "" : name.replaceAll("[^A-Za-z0-9._ -]", "_");
        if (safe.trim().length() == 0) safe = "edited";
        return safe;
    }

    private void progress(double fraction, String stage) {
        WritableMap m = Arguments.createMap();
        m.putDouble("fraction", fraction);
        m.putString("stage", stage);
        emit("AudioEditorProgress", m);
    }

    /**
     * Writes the current audio as a WAV file in the app's cache and resolves with its path. The loop edit makes one
     * cycle; it is repeated here (loops times, with an optional fade out) a piece at a time, so it needs no memory.
     */
    @ReactMethod
    public void exportWav(final String name, final double loops, final double fadeSec, final Promise promise) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    short[] d;
                    int c, r;
                    synchronized (lock) {
                        d = cur;
                        c = ch;
                        r = sr;
                    }
                    if (d == null || d.length < c) {
                        promise.reject("E_NONE", "Open a song first.");
                        return;
                    }
                    LoopStream ls = new LoopStream(d, c, r, Math.max(1L, Math.round(loops)), fadeSec);
                    long total = ls.totalFrames();
                    long dataBytes = total * c * 2L;
                    if (dataBytes > 4000000000L) {
                        promise.reject("E_EXPORT", "This is too long for a WAV file. Choose M4A instead.");
                        return;
                    }
                    File f = new File(exportDir(), safeName(name) + ".wav");
                    BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(f), 1 << 16);
                    try {
                        ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
                        h.put(new byte[]{'R', 'I', 'F', 'F'});
                        le(h, (int) (36 + dataBytes));
                        h.put(new byte[]{'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
                        le(h, 16);
                        h.putShort((short) 1);
                        h.putShort((short) c);
                        le(h, r);
                        le(h, r * c * 2);
                        h.putShort((short) (c * 2));
                        h.putShort((short) 16);
                        h.put(new byte[]{'d', 'a', 't', 'a'});
                        le(h, (int) dataBytes);
                        out.write(h.array());
                        final int piece = 16384;
                        short[] buf = new short[piece * c];
                        ByteBuffer chunk = ByteBuffer.allocate(piece * c * 2).order(ByteOrder.LITTLE_ENDIAN);
                        long pos = 0;
                        int lastPct = -1;
                        while (pos < total) {
                            int n = (int) Math.min((long) piece, total - pos);
                            ls.fill(pos, n, buf);
                            chunk.clear();
                            chunk.asShortBuffer().put(buf, 0, n * c);
                            out.write(chunk.array(), 0, n * c * 2);
                            pos += n;
                            int pct = (int) (pos * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                progress(pos / (double) total, "Writing the WAV file");
                            }
                        }
                        out.flush();
                    } finally {
                        out.close();
                    }
                    promise.resolve(f.getAbsolutePath());
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "Not enough memory to save this.");
                } catch (Exception e) {
                    promise.reject("E_EXPORT", e.getMessage() == null ? "Could not save the file." : e.getMessage());
                } catch (Throwable e) {
                    promise.reject("E_EXPORT", "Could not save the file.");
                }
            }
        });
    }

    /** Same as exportWav, but compressed to AAC inside an .m4a file (small). */
    @ReactMethod
    public void exportM4a(final String name, final double loops, final double fadeSec, final Promise promise) {
        pool.execute(new Runnable() {
            public void run() {
                MediaCodec enc = null;
                MediaMuxer mux = null;
                boolean muxStarted = false;
                File f = null;
                boolean ok = false;
                try {
                    short[] d;
                    int c, r;
                    synchronized (lock) {
                        d = cur;
                        c = ch;
                        r = sr;
                    }
                    if (d == null || d.length < c) {
                        promise.reject("E_NONE", "Open a song first.");
                        return;
                    }
                    LoopStream ls = new LoopStream(d, c, r, Math.max(1L, Math.round(loops)), fadeSec);
                    long total = ls.totalFrames();
                    f = new File(exportDir(), safeName(name) + ".m4a");
                    if (f.exists()) f.delete();

                    MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, r, c);
                    fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
                    fmt.setInteger(MediaFormat.KEY_BIT_RATE, c == 1 ? 128000 : 192000);
                    fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536);
                    enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
                    enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                    enc.start();
                    mux = new MediaMuxer(f.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);

                    MediaCodec.BufferInfo bi = new MediaCodec.BufferInfo();
                    short[] buf = new short[4096 * c];
                    long pos = 0;
                    int track = -1;
                    int lastPct = -1;
                    boolean inDone = false, outDone = false;
                    while (!outDone) {
                        if (!inDone) {
                            int ii = enc.dequeueInputBuffer(10000);
                            if (ii >= 0) {
                                ByteBuffer ib = enc.getInputBuffer(ii);
                                ib.clear();
                                long pts = pos * 1000000L / r;
                                if (pos >= total) {
                                    enc.queueInputBuffer(ii, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                    inDone = true;
                                } else {
                                    int n = (int) Math.min(4096L, Math.min(total - pos, (long) (ib.capacity() / (2 * c))));
                                    ls.fill(pos, n, buf);
                                    ib.order(ByteOrder.nativeOrder());
                                    ib.asShortBuffer().put(buf, 0, n * c);
                                    enc.queueInputBuffer(ii, 0, n * c * 2, pts, 0);
                                    pos += n;
                                    int pct = (int) (pos * 100 / total);
                                    if (pct != lastPct) {
                                        lastPct = pct;
                                        progress(pos / (double) total, "Making the M4A file");
                                    }
                                }
                            }
                        }
                        int oi = enc.dequeueOutputBuffer(bi, 10000);
                        if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            track = mux.addTrack(enc.getOutputFormat());
                            mux.start();
                            muxStarted = true;
                        } else if (oi >= 0) {
                            ByteBuffer ob = enc.getOutputBuffer(oi);
                            if ((bi.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) bi.size = 0;
                            if (bi.size > 0 && muxStarted && ob != null) {
                                ob.position(bi.offset);
                                ob.limit(bi.offset + bi.size);
                                mux.writeSampleData(track, ob, bi);
                            }
                            enc.releaseOutputBuffer(oi, false);
                            if ((bi.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                        }
                    }
                    if (muxStarted) {
                        mux.stop();
                        muxStarted = false;
                    }
                    ok = true;
                    promise.resolve(f.getAbsolutePath());
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "Not enough memory to save this.");
                } catch (Exception e) {
                    promise.reject("E_EXPORT", "Could not make the M4A file (" + (e.getMessage() == null ? "unknown problem" : e.getMessage()) + "). Try WAV instead.");
                } catch (Throwable e) {
                    promise.reject("E_EXPORT", "Could not make the M4A file. Try WAV instead.");
                } finally {
                    try {
                        if (enc != null) {
                            enc.stop();
                            enc.release();
                        }
                    } catch (Exception ignored) {
                    }
                    try {
                        if (mux != null) {
                            if (muxStarted) mux.stop();
                            mux.release();
                        }
                    } catch (Exception ignored) {
                    }
                    if (!ok && f != null) f.delete();
                }
            }
        });
    }

    /** Deletes the files made for saving (they have been copied into the Music folder by then). */
    @ReactMethod
    public void clearExports(Promise promise) {
        try {
            File[] list = exportDir().listFiles();
            if (list != null) {
                for (File x : list) x.delete();
            }
        } catch (Exception ignored) {
        }
        promise.resolve(true);
    }

    // ---------------------------------------------------------------- waveform and loop check

    /** The waveform: n bars (0..1) for the part from startSec to endSec of the current audio (or the original). */
    @ReactMethod
    public void getPeaks(double startSec, double endSec, int n, boolean original, Promise promise) {
        try {
            short[] d;
            int c, r;
            synchronized (lock) {
                d = original ? orig : cur;
                c = ch;
                r = sr;
            }
            WritableArray arr = Arguments.createArray();
            if (d == null || n <= 0 || c <= 0) {
                promise.resolve(arr);
                return;
            }
            int frames = d.length / c;
            long s0 = Math.max(0, Math.min(frames, Math.round(startSec * r)));
            long e0 = Math.max(s0, Math.min(frames, Math.round(endSec * r)));
            for (int i = 0; i < n; i++) {
                long a = s0 + (e0 - s0) * i / n;
                long b = s0 + (e0 - s0) * (i + 1) / n;
                if (b <= a) b = Math.min(frames, a + 1);
                int p = 0;
                long step = Math.max(1L, (b - a) / 64);
                for (long f = a; f < b && f < frames; f += step) {
                    for (int k = 0; k < c; k++) {
                        int v = Math.abs((int) d[(int) (f * c + k)]);
                        if (v > p) p = v;
                    }
                }
                arr.pushDouble(p / 32768.0);
            }
            promise.resolve(arr);
        } catch (Exception e) {
            promise.reject("E_PEAKS", e.getMessage() == null ? "Could not draw the waveform." : e.getMessage());
        }
    }

    /** Checks the picked part for looping: exact points, blend length and quality (see LoopMaker). */
    @ReactMethod
    public void analyzeSelection(final double startSec, final double endSec, final double xfSec, final boolean align, final Promise promise) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    short[] d;
                    int c, r;
                    synchronized (lock) {
                        d = cur;
                        c = ch;
                        r = sr;
                    }
                    if (d == null) {
                        promise.reject("E_NONE", "Open a song first.");
                        return;
                    }
                    LoopMaker.Seam sm = LoopMaker.analyze(d, c, r, Math.round(startSec * r), Math.round(endSec * r), xfSec, align);
                    WritableMap m = Arguments.createMap();
                    m.putDouble("a", sm.a);
                    m.putDouble("b", sm.b);
                    m.putDouble("xf", sm.xf);
                    m.putDouble("shiftMs", sm.shiftMs);
                    m.putDouble("ncc", sm.ncc);
                    m.putDouble("pre", sm.pre);
                    m.putDouble("quality", sm.quality);
                    promise.resolve(m);
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "Not enough memory to check this part.");
                } catch (Exception e) {
                    promise.reject("E_CHECK", e.getMessage() == null ? "Could not check this part." : e.getMessage());
                } catch (Throwable e) {
                    promise.reject("E_CHECK", "Could not check this part.");
                }
            }
        });
    }

    /** Plays the loop (as it will sound when saved) again and again, so the seam can be heard. */
    @ReactMethod
    public void previewLoop(final double a, final double b, final double xf, final Promise promise) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    short[] d;
                    int c, r;
                    synchronized (lock) {
                        d = cur;
                        c = ch;
                        r = sr;
                    }
                    if (d == null) {
                        promise.resolve(false);
                        return;
                    }
                    short[] body = LoopMaker.build(d, c, (int) Math.round(a), (int) Math.round(b), (int) Math.round(xf));
                    int frames = body.length / c;
                    if (frames < 1) {
                        promise.resolve(false);
                        return;
                    }
                    startTrack(body, c, r, 0, 0, frames, true);
                    promise.resolve(true);
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "Not enough memory to play this.");
                } catch (Exception e) {
                    promise.reject("E_PLAY", e.getMessage() == null ? "Could not play the loop." : e.getMessage());
                } catch (Throwable e) {
                    promise.reject("E_PLAY", "Could not play the loop.");
                }
            }
        });
    }

    /** Frees the audio held in memory. */
    @ReactMethod
    public void release(Promise promise) {
        stopPlayback();
        synchronized (lock) {
            orig = null;
            cur = null;
        }
        promise.resolve(true);
    }
}
