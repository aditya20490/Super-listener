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
    private int pbRate = 44100;
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
                }
            }
        });
    }

    // ---------------------------------------------------------------- waveform and loop check

    /** The waveform of [startSec, endSec] as n bars between 0 and 1. */
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
            if (d == null || n <= 0) {
                promise.resolve(arr);
                return;
            }
            int frames = d.length / c;
            int f0 = (int) Math.max(0, Math.min(frames - 1, Math.round(startSec * r)));
            int f1 = (int) Math.max(f0 + 1, Math.min(frames, Math.round(endSec * r)));
            for (int i = 0; i < n; i++) {
                int a = f0 + (int) ((long) (f1 - f0) * i / n);
                int b = f0 + (int) ((long) (f1 - f0) * (i + 1) / n);
                if (b <= a) b = Math.min(frames, a + 1);
                int p = 0;
                int step = Math.max(1, (b - a) / 48);
                for (int f = a; f < b; f += step) {
                    for (int k = 0; k < c; k++) {
                        int v = Math.abs((int) d[f * c + k]);
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

    /** Checks the picked part for looping: exact points, blend length and how smooth the seam will be. */
    @ReactMethod
    public void analyzeSelection(final double fromSec, final double toSec, final double xfSec, final boolean align, final Promise promise) {
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
                    LoopMaker.Seam k = LoopMaker.analyze(d, c, r, Math.round(fromSec * r), Math.round(toSec * r), xfSec, align);
                    WritableMap m = Arguments.createMap();
                    m.putDouble("a", k.a);
                    m.putDouble("b", k.b);
                    m.putDouble("xf", k.xf);
                    m.putInt("shiftMs", k.shiftMs);
                    m.putDouble("quality", k.quality);
                    m.putDouble("ncc", k.ncc);
                    m.putDouble("pre", k.pre);
                    m.putDouble("startSec", k.a / (double) r);
                    m.putDouble("endSec", k.b / (double) r);
                    m.putDouble("lenSec", (k.b - k.a) / (double) r);
                    promise.resolve(m);
                } catch (IllegalArgumentException e) {
                    promise.reject("E_SELECT", e.getMessage());
                } catch (OutOfMemoryError e) {
                    promise.reject("E_MEMORY", "Not enough memory to check this part.");
                } catch (Exception e) {
                    promise.reject("E_LOOP", e.getMessage() == null ? "Could not check the loop." : e.getMessage());
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
        return p / (double) pbRate;
    }

    /** Starts playing data[rs..re) from frame s0. With loop = true it wraps from re back to rs with no gap. */
    private void startPlayback(short[] d, int c, int r, int s0, int rs, int re, boolean loop) {
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
            pbRate = r;
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

    /**
     * Plays the current audio (or the untouched original) from startSec. With loop = true it plays endSec back into
     * loopStartSec again and again with no gap.
     */
    @ReactMethod
    public void play(double startSec, double endSec, double loopStartSec, boolean loop, boolean original, Promise promise) {
        try {
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
            startPlayback(d, c, r, s0, rs, re, loop);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("E_PLAY", e.getMessage() == null ? "Could not play." : e.getMessage());
        }
    }

    /** Plays the loop that would be made from [aFrame, bFrame) on repeat, starting a little before its end so the seam is heard. */
    @ReactMethod
    public void previewLoop(double aFrame, double bFrame, double xfFrames, Promise promise) {
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
            short[] body = LoopMaker.build(d, c, (int) aFrame, (int) bFrame, (int) xfFrames);
            int frames = body.length / c;
            int s0 = Math.max(0, frames - 3 * r);
            startPlayback(body, c, r, s0, 0, frames, true);
            promise.resolve(true);
        } catch (OutOfMemoryError e) {
            promise.reject("E_MEMORY", "Not enough memory for the preview.");
        } catch (Exception e) {
            promise.reject("E_PLAY", e.getMessage() == null ? "Could not preview." : e.getMessage());
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

    private void progress(double f, String stage) {
        WritableMap m = Arguments.createMap();
        m.putDouble("fraction", f);
        m.putString("stage", stage);
        emit("AudioEditorProgress", m);
    }

    private static String safeName(String name) {
        String safe = name == null ? "" : name.replaceAll("[^A-Za-z0-9._ -]", "_");
        return safe.length() == 0 ? "edited" : safe;
    }

    /**
     * Saves the current audio as a WAV file in the app's cache and resolves with its path. loops = how many times the
     * audio is repeated (1 = once). The repeats are produced a piece at a time, so a very long result does not need
     * memory. fadeOutSec fades the end out.
     */
    @ReactMethod
    public void exportWav(final String name, final double loops, final double fadeOutSec, final Promise promise) {
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
                    LoopStream st = new LoopStream(d, c, r, (long) loops, fadeOutSec);
                    long total = st.totalFrames();
                    long dataBytes = total * c * 2;
                    if (dataBytes > 4000000000L) {
                        promise.reject("E_EXPORT", "That is too long for a WAV file. Save it as M4A instead.");
                        return;
                    }
                    File f = new File(getReactApplicationContext().getCacheDir(), safeName(name) + ".wav");
                    BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(f), 1 << 16);
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
                    int chunkFrames = 16384;
                    short[] buf = new short[chunkFrames * c];
                    ByteBuffer bytes = ByteBuffer.allocate(chunkFrames * c * 2).order(ByteOrder.LITTLE_ENDIAN);
                    long pos = 0;
                    long lastEmit = 0;
                    while (pos < total) {
                        int n = (int) Math.min(chunkFrames, total - pos);
                        st.fill(pos, n, buf);
                        bytes.clear();
                        for (int k = 0; k < n * c; k++) bytes.putShort(buf[k]);
                        out.write(bytes.array(), 0, n * c * 2);
                        pos += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 400) {
                            lastEmit = now;
                            progress(pos / (double) total, "Writing the file");
                        }
                    }
                    out.flush();
                    out.close();
                    promise.resolve(f.getAbsolutePath());
                } catch (Exception e) {
                    promise.reject("E_EXPORT", e.getMessage() == null ? "Could not save the file." : e.getMessage());
                }
            }
        });
    }

    /** Same as exportWav but as a small M4A (AAC) file, which is much smaller for long results. */
    @ReactMethod
    public void exportM4a(final String name, final double loops, final double fadeOutSec, final Promise promise) {
        pool.execute(new Runnable() {
            public void run() {
                MediaCodec enc = null;
                MediaMuxer mux = null;
                boolean muxStarted = false;
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
                    LoopStream st = new LoopStream(d, c, r, (long) loops, fadeOutSec);
                    long total = st.totalFrames();
                    File f = new File(getReactApplicationContext().getCacheDir(), safeName(name) + ".m4a");
                    if (f.exists()) f.delete();
                    MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, r, c);
                    fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
                    fmt.setInteger(MediaFormat.KEY_BIT_RATE, 192000);
                    fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1 << 16);
                    enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
                    enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                    enc.start();
                    mux = new MediaMuxer(f.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                    int track = -1;
                    long pos = 0;
                    boolean inDone = false, outDone = false;
                    short[] chunk = new short[4096 * c];
                    MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                    long lastEmit = 0;
                    while (!outDone) {
                        if (!inDone) {
                            int ii = enc.dequeueInputBuffer(10000);
                            if (ii >= 0) {
                                ByteBuffer ib = enc.getInputBuffer(ii);
                                ib.clear();
                                int maxFrames = Math.min(ib.capacity() / (2 * c), chunk.length / c);
                                int n = (int) Math.min(maxFrames, total - pos);
                                long pts = pos * 1000000L / r;
                                if (n <= 0) {
                                    enc.queueInputBuffer(ii, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                    inDone = true;
                                } else {
                                    st.fill(pos, n, chunk);
                                    ShortBuffer sb = ib.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
                                    sb.put(chunk, 0, n * c);
                                    enc.queueInputBuffer(ii, 0, n * c * 2, pts, 0);
                                    pos += n;
                                }
                            }
                        }
                        int oi = enc.dequeueOutputBuffer(info, 10000);
                        if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            track = mux.addTrack(enc.getOutputFormat());
                            mux.start();
                            muxStarted = true;
                        } else if (oi >= 0) {
                            ByteBuffer ob = enc.getOutputBuffer(oi);
                            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                            if (info.size > 0 && muxStarted) {
                                ob.position(info.offset);
                                ob.limit(info.offset + info.size);
                                mux.writeSampleData(track, ob, info);
                            }
                            enc.releaseOutputBuffer(oi, false);
                            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 400) {
                            lastEmit = now;
                            progress(Math.min(1.0, pos / (double) total), "Compressing the file");
                        }
                    }
                    promise.resolve(f.getAbsolutePath());
                } catch (Exception e) {
                    promise.reject("E_EXPORT", e.getMessage() == null ? "Could not save the M4A file. Try WAV." : e.getMessage());
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
                }
            }
        });
    }

    /** Deletes the temporary files made by saving (they can be large). */
    @ReactMethod
    public void clearExports(Promise promise) {
        try {
            File[] files = getReactApplicationContext().getCacheDir().listFiles();
            if (files != null) {
                for (File f : files) {
                    String n = f.getName().toLowerCase();
                    if (n.endsWith(".wav") || n.endsWith(".m4a")) f.delete();
                }
            }
        } catch (Exception ignored) {
        }
        promise.resolve(true);
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
