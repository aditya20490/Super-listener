package com.musicplus.audioedit;

/**
 * Basic editing operations on 16-bit interleaved audio. Every method returns a NEW array and never changes its input,
 * so the original is always safe and an edit can be undone by simply replaying the list of edits.
 * Positions are in frames (one frame = one sample for every channel).
 */
public final class AudioOps {
    private AudioOps() {}

    public static int frames(short[] d, int ch) {
        return d.length / ch;
    }

    private static int clampF(long v, int lo, int hi) {
        return (int) Math.max(lo, Math.min(hi, v));
    }

    private static short clip(float v) {
        if (v > 32767f) return 32767;
        if (v < -32768f) return -32768;
        return (short) Math.round(v);
    }

    /** Keep only [from, to). */
    public static short[] trim(short[] d, int ch, long from, long to) {
        int n = frames(d, ch);
        int f = clampF(from, 0, n);
        int t = clampF(to, f, n);
        short[] out = new short[(t - f) * ch];
        System.arraycopy(d, f * ch, out, 0, out.length);
        return out;
    }

    /** Remove [from, to) and join the two sides with a very short crossfade so there is no click. */
    public static short[] cut(short[] d, int ch, long from, long to, int sr) {
        int n = frames(d, ch);
        int f = clampF(from, 0, n);
        int t = clampF(to, f, n);
        if (t == f) return d.clone();
        int outFrames = n - (t - f);
        short[] out = new short[outFrames * ch];
        System.arraycopy(d, 0, out, 0, f * ch);
        System.arraycopy(d, t * ch, out, f * ch, (n - t) * ch);
        // blend over a few milliseconds: the material before the cut fades out into the material after it
        int xf = Math.min(Math.min(f, n - t), Math.max(16, sr / 200)); // about 5 ms
        // Keep the sound after the cut untouched; fade out a copy of the sound that would have continued before the cut.
        for (int k = 0; k < xf; k++) {
            float tt = (k + 0.5f) / xf;
            float gOut = 1f - tt;
            float gIn = tt;
            for (int c = 0; c < ch; c++) {
                int pos = (f - xf + k) * ch + c;
                // what was playing just before the cut continues into the cut part, fading out
                float a = d[(f - xf + k) * ch + c];
                float b = d[(t - xf + k) * ch + c];
                out[pos] = clip(a * gOut + b * gIn);
            }
        }
        return out;
    }

    /** Fade in (0 to full) or fade out (full to 0) across [from, to). */
    public static short[] fade(short[] d, int ch, long from, long to, boolean in) {
        int n = frames(d, ch);
        int f = clampF(from, 0, n);
        int t = clampF(to, f, n);
        short[] out = d.clone();
        int len = t - f;
        if (len <= 0) return out;
        for (int k = 0; k < len; k++) {
            float p = (k + 0.5f) / len;
            float g = in ? p : 1f - p;
            g = g * g * (3f - 2f * g); // smooth S-curve
            for (int c = 0; c < ch; c++) {
                int pos = (f + k) * ch + c;
                out[pos] = clip(out[pos] * g);
            }
        }
        return out;
    }

    /** Volume change in decibels over [from, to). */
    public static short[] gain(short[] d, int ch, long from, long to, double db) {
        int n = frames(d, ch);
        int f = clampF(from, 0, n);
        int t = clampF(to, f, n);
        short[] out = d.clone();
        float g = (float) Math.pow(10.0, db / 20.0);
        for (int i = f * ch; i < t * ch; i++) out[i] = clip(out[i] * g);
        return out;
    }

    /** Peak of [from, to) as a number between 0 and 1. */
    public static double peak(short[] d, int ch, long from, long to) {
        int n = frames(d, ch);
        int f = clampF(from, 0, n);
        int t = clampF(to, f, n);
        int p = 0;
        for (int i = f * ch; i < t * ch; i++) {
            int v = Math.abs((int) d[i]);
            if (v > p) p = v;
        }
        return p / 32768.0;
    }

    /** Make the loudest point of [from, to) reach peakDb (for example -1 dB). */
    public static short[] normalize(short[] d, int ch, long from, long to, double peakDb) {
        double p = peak(d, ch, from, to);
        if (p < 1e-6) return d.clone();
        double target = Math.pow(10.0, peakDb / 20.0);
        return gain(d, ch, from, to, 20.0 * Math.log10(target / p));
    }

    /** Silence [from, to), with tiny ramps at the edges so it does not click. */
    public static short[] silence(short[] d, int ch, long from, long to, int sr) {
        int n = frames(d, ch);
        int f = clampF(from, 0, n);
        int t = clampF(to, f, n);
        short[] out = d.clone();
        int ramp = Math.min((t - f) / 2, Math.max(8, sr / 300)); // about 3 ms
        for (int k = f; k < t; k++) {
            float g = 0f;
            if (k - f < ramp) g = 1f - (k - f + 0.5f) / ramp;
            else if (t - 1 - k < ramp) g = 1f - (t - 1 - k + 0.5f) / ramp;
            for (int c = 0; c < ch; c++) {
                int pos = k * ch + c;
                out[pos] = clip(out[pos] * g);
            }
        }
        return out;
    }

    /** Play [from, to) backwards. */
    public static short[] reverse(short[] d, int ch, long from, long to) {
        int n = frames(d, ch);
        int f = clampF(from, 0, n);
        int t = clampF(to, f, n);
        short[] out = d.clone();
        for (int k = 0; k < t - f; k++) {
            for (int c = 0; c < ch; c++) out[(f + k) * ch + c] = d[(t - 1 - k) * ch + c];
        }
        return out;
    }

    /** Faster or slower playback (pitch changes with it, like a tape). factor 2 = twice as fast. */
    public static short[] speed(short[] d, int ch, double factor) {
        factor = Math.max(0.25, Math.min(4.0, factor));
        int n = frames(d, ch);
        int m = (int) Math.max(1, Math.floor(n / factor));
        short[] out = new short[m * ch];
        for (int k = 0; k < m; k++) {
            double p = k * factor;
            int i0 = (int) p;
            double fr = p - i0;
            int i1 = Math.min(n - 1, i0 + 1);
            int im = Math.max(0, i0 - 1);
            int i2 = Math.min(n - 1, i0 + 2);
            for (int c = 0; c < ch; c++) {
                // cubic (Catmull-Rom) interpolation
                double y0 = d[im * ch + c], y1 = d[i0 * ch + c], y2 = d[i1 * ch + c], y3 = d[i2 * ch + c];
                double v = y1 + 0.5 * fr * (y2 - y0 + fr * (2.0 * y0 - 5.0 * y1 + 4.0 * y2 - y3 + fr * (3.0 * (y1 - y2) + y3 - y0)));
                out[k * ch + c] = clip((float) v);
            }
        }
        return out;
    }
}
