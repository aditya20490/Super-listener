package com.musicplus.audioedit;

/**
 * A seamless loop that is never built in memory as one long array.
 *
 * You choose a section [a, b) of the audio and a total length (for example 10 seconds looped for one hour).
 * The result is described by three small pieces:
 *   head: the first xf frames of the section, played once
 *   unit: the part that repeats. It is the middle of the section followed by a crossfade of the section's end
 *         into the section's start, so when it wraps around it is one continuous stream
 *   total: how many frames the finished audio has
 * Any frame of the result can be produced on the fly (read), so a one hour loop needs only a few MB of memory,
 * can be played straight away and can be written to a file in small chunks.
 */
public final class LoopSpan {
    public final int ch;
    public final int sr;
    public final short[] head; // headFrames * ch
    public final short[] unit; // unitFrames * ch
    public final int headFrames;
    public final int unitFrames;
    public final long total; // frames of the finished audio
    public final int fadeFrames; // short fade at the very end so the file does not end with a click
    public final int xfFrames; // blend length actually used
    private final int peakHead, peakUnit;

    public LoopSpan(short[] d, int ch, int sr, long aIn, long bIn, long xfIn, long totalFrames) {
        this.ch = ch;
        this.sr = sr;
        int n = d.length / ch;
        int a = (int) Math.max(0, Math.min(n - 2, aIn));
        int b = (int) Math.max(a + 2, Math.min(n, bIn));
        int len = b - a;
        int xf = (int) Math.max(0, Math.min(xfIn, (len - 1) / 3));
        this.xfFrames = xf;
        this.headFrames = xf;
        this.unitFrames = len - xf;

        // blend: alike material blends with equal gain (no loudness bump), unlike material with equal power
        double sab = 0, saa = 0, sbb = 0;
        for (int k = 0; k < xf; k++) {
            float pa = mono(d, ch, b - xf + k);
            float pb = mono(d, ch, a + k);
            sab += pa * pb;
            saa += pa * pa;
            sbb += pb * pb;
        }
        double rho = xf > 0 ? Math.max(0, sab / Math.sqrt(saa * sbb + 1e-9)) : 0;

        head = new short[headFrames * ch];
        System.arraycopy(d, a * ch, head, 0, headFrames * ch);

        unit = new short[unitFrames * ch];
        int mid = len - 2 * xf; // frames of the untouched middle
        System.arraycopy(d, (a + xf) * ch, unit, 0, mid * ch);
        for (int k = 0; k < xf; k++) {
            double t = (k + 0.5) / xf;
            double gOut = rho * (1 - t) + (1 - rho) * Math.cos(t * Math.PI / 2);
            double gIn = rho * t + (1 - rho) * Math.sin(t * Math.PI / 2);
            for (int c = 0; c < ch; c++) {
                float v = (float) (d[(b - xf + k) * ch + c] * gOut + d[(a + k) * ch + c] * gIn);
                unit[(mid + k) * ch + c] = clip16(v);
            }
        }

        long t = Math.max(1, totalFrames);
        if (t > Integer.MAX_VALUE - 8) t = Integer.MAX_VALUE - 8;
        this.total = t;
        this.fadeFrames = (int) Math.max(0, Math.min(sr / 50, t / 4)); // about 20 ms

        int ph = 0, pu = 0;
        for (int i = 0; i < head.length; i++) ph = Math.max(ph, Math.abs((int) head[i]));
        for (int i = 0; i < unit.length; i++) pu = Math.max(pu, Math.abs((int) unit[i]));
        peakHead = ph;
        peakUnit = pu;
    }

    /** Fills dst (from dstOff, in shorts) with n frames of the finished audio, starting at frame pos. */
    public void read(long pos, short[] dst, int dstOff, int n) {
        long p = pos;
        int w = 0;
        while (w < n) {
            if (p >= total || p < 0) {
                java.util.Arrays.fill(dst, dstOff + w * ch, dstOff + n * ch, (short) 0);
                break;
            }
            int can = (int) Math.min(n - w, total - p);
            int c;
            if (p < headFrames) {
                c = (int) Math.min(can, headFrames - p);
                System.arraycopy(head, (int) p * ch, dst, dstOff + w * ch, c * ch);
            } else {
                int q = (int) ((p - headFrames) % unitFrames);
                c = Math.min(can, unitFrames - q);
                System.arraycopy(unit, q * ch, dst, dstOff + w * ch, c * ch);
            }
            p += c;
            w += c;
        }
        // the short fade at the very end
        if (fadeFrames > 0) {
            long fadeStart = total - fadeFrames;
            if (pos + n > fadeStart) {
                for (int i = 0; i < n; i++) {
                    long fp = pos + i;
                    if (fp < fadeStart) continue;
                    if (fp >= total) break;
                    float g = (total - fp) / (float) fadeFrames;
                    for (int c2 = 0; c2 < ch; c2++) {
                        int idx = dstOff + i * ch + c2;
                        dst[idx] = (short) Math.round(dst[idx] * g);
                    }
                }
            }
        }
    }

    /** Loudest sample (0..32768) of one frame of the finished audio. */
    private int peakAtFrame(long f) {
        short[] src;
        int idx;
        if (f < headFrames) {
            src = head;
            idx = (int) f * ch;
        } else {
            src = unit;
            idx = (int) ((f - headFrames) % unitFrames) * ch;
        }
        int m = 0;
        for (int c = 0; c < ch; c++) m = Math.max(m, Math.abs((int) src[idx + c]));
        return m;
    }

    /** Waveform for the screen: bins values between 0 and 1. */
    public double[] peaks(int bins) {
        double[] out = new double[bins];
        for (int i = 0; i < bins; i++) {
            long s = total * i / bins;
            long e = total * (i + 1) / bins;
            if (e <= s) e = Math.min(total, s + 1);
            int p;
            if (e - s >= unitFrames) {
                p = Math.max(peakUnit, s < headFrames ? peakHead : 0);
            } else {
                p = 0;
                long step = Math.max(1, (e - s) / 64);
                for (long f = s; f < e; f += step) p = Math.max(p, peakAtFrame(f));
            }
            out[i] = p / 32768.0;
        }
        return out;
    }

    private static float mono(short[] d, int ch, int i) {
        int base = i * ch;
        float s = 0;
        for (int c = 0; c < ch; c++) s += d[base + c];
        return s / ch;
    }

    private static short clip16(float v) {
        if (v > 32767f) return 32767;
        if (v < -32768f) return -32768;
        return (short) Math.round(v);
    }
}
