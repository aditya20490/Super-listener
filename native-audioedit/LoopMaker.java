package com.musicplus.audioedit;

/**
 * Makes a seamless loop out of a part of a song that the user picked (start and end).
 *
 * analyze(): nudges the end by up to about 25 ms so the waveforms line up at the jump, checks how alike the music
 * just before the start and just before the end is, and picks a blend length (alike places need a very short blend).
 * build(): cuts the picked part out and blends its end into the sound that comes just before its start, so when it
 * wraps from the end back to the start it is one unbroken stream. If there is no sound before the start (the part
 * begins at the very start of the song) the end is blended into the beginning instead.
 */
public final class LoopMaker {
    private LoopMaker() {}

    public static class Seam {
        public int a; // start (frame)
        public int b; // end (frame), after the small nudge
        public int xf; // blend length (frames)
        public int shiftMs; // how far the end was moved
        public double ncc; // waveform match at the jump (1 = identical)
        public double pre; // how alike the music before the two points is (0 = identical)
        public double quality; // 0..100
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

    private static double corr(short[] d, int ch, int p, int q, int len, int step) {
        double sab = 0, saa = 0, sbb = 0;
        for (int i = 0; i < len; i += step) {
            float x = mono(d, ch, p + i);
            float y = mono(d, ch, q + i);
            sab += x * y;
            saa += x * x;
            sbb += y * y;
        }
        return sab / Math.sqrt(saa * sbb + 1e-9);
    }

    // ---- a small fingerprint to compare the sound before two places ----
    private static final int FN = 1024;

    private static void fft(float[] re, float[] im) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                float t = re[i];
                re[i] = re[j];
                re[j] = t;
                t = im[i];
                im[i] = im[j];
                im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2 * Math.PI / len;
            float wlr = (float) Math.cos(ang), wli = (float) Math.sin(ang);
            for (int i = 0; i < n; i += len) {
                float wr = 1, wi = 0;
                for (int k = 0; k < len / 2; k++) {
                    int p = i + k, q = p + len / 2;
                    float xr = re[q] * wr - im[q] * wi;
                    float xi = re[q] * wi + im[q] * wr;
                    re[q] = re[p] - xr;
                    im[q] = im[p] - xi;
                    re[p] += xr;
                    im[p] += xi;
                    float nwr = wr * wlr - wi * wli;
                    wi = wr * wli + wi * wlr;
                    wr = nwr;
                }
            }
        }
    }

    /** 12 note strengths and 12 tone-colour bands of one short stretch of sound ending at position end (frames). */
    private static float[] fingerprint(short[] d, int ch, int sr, int dec, int endFrame) {
        int need = FN * dec;
        float[] re = new float[FN], im = new float[FN];
        int start = endFrame - need;
        for (int i = 0; i < FN; i++) {
            float s = 0;
            for (int k = 0; k < dec; k++) s += mono(d, ch, start + i * dec + k);
            float w = (float) (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FN - 1)));
            re[i] = s / dec / 32768f * w;
        }
        fft(re, im);
        double asr = sr / (double) dec;
        float[] chroma = new float[12];
        for (int k = 1; k <= FN / 2; k++) {
            double fr = k * asr / FN;
            if (fr < 65 || fr > 2100) continue;
            int pc = (((int) Math.round(12 * Math.log(fr / 440.0) / Math.log(2) + 69)) % 12 + 12) % 12;
            chroma[pc] += (float) Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        }
        double cn = 0;
        for (int c = 0; c < 12; c++) {
            chroma[c] = (float) Math.sqrt(chroma[c]);
            cn += chroma[c] * chroma[c];
        }
        cn = Math.sqrt(cn) + 1e-9;
        float[] f = new float[24];
        for (int c = 0; c < 12; c++) f[c] = (float) (chroma[c] / cn);
        double top = Math.min(5500, 0.45 * asr);
        double mean = 0;
        double[] lg = new double[12];
        for (int b = 0; b < 12; b++) {
            int lo = Math.max(1, (int) Math.round(90 * Math.pow(top / 90.0, b / 12.0) * FN / asr));
            int hi = Math.max(lo + 1, Math.min(FN / 2, (int) Math.round(90 * Math.pow(top / 90.0, (b + 1) / 12.0) * FN / asr)));
            double e = 0;
            for (int k = lo; k < hi; k++) e += re[k] * re[k] + im[k] * im[k];
            lg[b] = Math.log10(1e-7 + e / (hi - lo));
            mean += lg[b];
        }
        mean /= 12;
        for (int b = 0; b < 12; b++) f[12 + b] = (float) ((lg[b] - mean) / 2.0 * 0.5);
        return f;
    }

    private static double fpDist(float[] x, float[] y) {
        double s = 0;
        for (int i = 0; i < 24; i++) {
            double v = x[i] - y[i];
            s += v * v;
        }
        return Math.sqrt(s);
    }

    /** How alike is the sound just before frame a to the sound just before frame b? 0 = identical, about 1 = unrelated. */
    private static double contextDistance(short[] d, int ch, int sr, int a, int b) {
        int dec = Math.max(1, (int) Math.round(sr / 11025.0));
        int need = FN * dec;
        int hop = need / 2;
        int frames = 0;
        double sum = 0;
        for (int k = 0; k < 12; k++) { // about half a second: only the sound right before the jump matters
            int ea = a - k * hop;
            int eb = b - k * hop;
            if (ea - need < 0 || eb - need < 0) break;
            sum += fpDist(fingerprint(d, ch, sr, dec, ea), fingerprint(d, ch, sr, dec, eb));
            frames++;
        }
        return frames == 0 ? 0.5 : sum / frames; // nothing before the start to compare: call it middling
    }

    /** Checks the picked part and returns the exact loop points, the blend length and a quality score. */
    public static Seam analyze(short[] d, int ch, int sr, long aIn, long bIn, double xfSec, boolean align) {
        int n = d.length / ch;
        int a = (int) Math.max(0, Math.min(n - 2, aIn));
        int b = (int) Math.max(a + 1, Math.min(n, bIn));
        if (b - a < sr / 10) throw new IllegalArgumentException("Pick at least 0.1 seconds to loop.");

        int L = Math.min(2048, (b - a) / 2);
        int shift = 0;
        double ncc = 0;
        if (align) {
            int S = Math.min(sr / 40, (b - a) / 4); // about 25 ms
            double best = -9;
            for (int s = -S; s <= S; s++) {
                int bb = b + s;
                if (bb > n || bb - a < L * 2) continue;
                double score = 0, pre = 0;
                boolean hasPre = a >= L && bb - L >= 0;
                if (hasPre) {
                    pre = corr(d, ch, a - L, bb - L, L, 1);
                    score += pre;
                }
                if (bb + L <= n) score += 0.5 * corr(d, ch, a, bb, L, 2);
                else if (!hasPre) continue;
                if (!hasPre) {
                    // no sound before the start: compare the end of the part with the start of the part (circular)
                    score += corr(d, ch, a, bb - L, L, 1);
                    pre = score;
                }
                if (score > best) {
                    best = score;
                    shift = s;
                    ncc = pre;
                }
            }
            b += shift;
        } else if (a >= L) {
            ncc = corr(d, ch, a - L, b - L, L, 1);
        }

        Seam s = new Seam();
        s.a = a;
        s.b = b;
        s.shiftMs = (int) Math.round(shift * 1000.0 / sr);
        s.ncc = ncc;
        double pre = contextDistance(d, ch, sr, a > 0 ? a : 0, b);
        s.pre = pre;
        s.quality = Math.max(0, Math.min(100, 100.0 * Math.exp(-2.5 * Math.max(0, pre - 0.04)) * (0.8 + 0.2 * Math.max(0, ncc))));
        double xfs = xfSec > 0 ? xfSec : 0.03 + 1.17 * Math.max(0, Math.min(1, (pre - 0.12) / 0.7));
        int xf = (int) Math.round(xfs * sr);
        xf = Math.min(xf, (b - a) / 3);
        s.xf = Math.max(0, xf);
        return s;
    }

    /** The loop: [a, b) with its end blended into the start. Playing it again and again has no seam. */
    public static short[] build(short[] d, int ch, int a, int b, int xf) {
        int n = d.length / ch;
        a = Math.max(0, Math.min(n - 1, a));
        b = Math.max(a + 1, Math.min(n, b));
        int len = b - a;
        xf = Math.max(0, Math.min(xf, len / 3));
        boolean before = a >= xf; // is there sound before the start to blend into?
        float[] gOut = new float[xf], gIn = new float[xf];
        double sab = 0, saa = 0, sbb = 0;
        for (int k = 0; k < xf; k++) {
            float pa = mono(d, ch, b - xf + k);
            float pb = before ? mono(d, ch, a - xf + k) : mono(d, ch, a + k);
            sab += pa * pb;
            saa += pa * pa;
            sbb += pb * pb;
        }
        double rho = xf > 0 ? Math.max(0, sab / Math.sqrt(saa * sbb + 1e-9)) : 0;
        for (int k = 0; k < xf; k++) {
            double t = (k + 0.5) / xf;
            gOut[k] = (float) (rho * (1 - t) + (1 - rho) * Math.cos(t * Math.PI / 2));
            gIn[k] = (float) (rho * t + (1 - rho) * Math.sin(t * Math.PI / 2));
        }
        if (before) {
            // [a, b-xf) untouched, then the end blended with the sound that comes just before a
            short[] out = new short[len * ch];
            System.arraycopy(d, a * ch, out, 0, (len - xf) * ch);
            for (int k = 0; k < xf; k++) {
                for (int c = 0; c < ch; c++) {
                    float v = d[(b - xf + k) * ch + c] * gOut[k] + d[(a - xf + k) * ch + c] * gIn[k];
                    out[(len - xf + k) * ch + c] = clip16(v);
                }
            }
            return out;
        }
        // nothing before the start: the beginning fades in out of the end instead (the loop gets xf shorter)
        int outLen = len - xf;
        short[] out = new short[outLen * ch];
        for (int k = 0; k < xf; k++) {
            for (int c = 0; c < ch; c++) {
                float v = d[(a + k) * ch + c] * gIn[k] + d[(b - xf + k) * ch + c] * gOut[k];
                out[k * ch + c] = clip16(v);
            }
        }
        System.arraycopy(d, (a + xf) * ch, out, xf * ch, (outLen - xf) * ch);
        return out;
    }
}
