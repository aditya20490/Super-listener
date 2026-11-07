package com.musicplus.audioedit;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;

/**
 * Finds places in a song where it can jump from the end of a section back to an earlier point without the listener
 * noticing, and builds the seamless loop.
 *
 * How it works:
 *  1. Listening: the song is turned into a short-time spectrum. For every moment we keep a small "fingerprint":
 *     which notes are sounding (chroma), the tone colour (band shape) and how strongly something just started (onset).
 *  2. Candidates: moments where a new sound starts (beats, notes) are possible places to jump from and to.
 *  3. Search: for every pair (start A, end B) we measure how alike the music BEFORE B is to the music BEFORE A
 *     (that is what the listener hears just before the jump and just after it), plus how alike the music after
 *     them is, how similar the loudness is, and how much of the song is kept. That is a weighted cost; the lowest
 *     cost pairs win. The search is a two-stage local search: a cheap pass over all pairs, then the full cost on
 *     the best few hundred.
 *  4. Fine alignment: at full sample rate B is shifted by up to about 20 ms so the waveforms line up (maximum
 *     normalized cross-correlation), so there is no click and the beat does not stumble.
 *  5. Splice: the last part of the loop is blended into the sound that comes BEFORE A, so playback that wraps
 *     from B to A is one continuous stream. The blend length depends on how alike the two places are: alike places
 *     get a very short blend (the original music is untouched), unlike places get a longer one.
 *
 * It does not claim every song can be looped perfectly: the result carries a quality score and, when nothing in the
 * song fits well, it says so.
 */
public final class LoopEngine {
    private LoopEngine() {}

    public interface Progress {
        void on(float fraction, String stage);

        boolean cancelled();
    }

    public static class Options {
        public double minLenSec = 0; // 0 = automatic
        public boolean wholeSong = false; // true: start near the beginning and end near the end
        public double xfSec = 0; // 0 = automatic blend length
        public double wPre = 1.0, wPost = 0.8, wLoud = 0.35, wContent = 0.35;
        public int maxResults = 6;
    }

    public static class Candidate {
        public int a; // loop start (frame)
        public int b; // loop end (frame)
        public int xf; // blend length (frames)
        public double lenSec;
        public double cost;
        public double pre; // how alike the music before the two points is (0 = identical)
        public double ncc; // waveform match at the splice (1 = identical)
        public double quality; // 0..100
    }

    // ---- analysis settings ----
    private static final int N = 2048; // analysis window
    private static final int H = 512; // analysis hop
    private static final int NB = 12; // band count
    private static final int D = 12 + NB + 1; // fingerprint size
    private static final int W1 = 12; // cheap pass window (frames)
    private static final int W2 = 64; // full pass window (frames, about 3 seconds)

    private static void fft(float[] re, float[] im, int[] rev, float[] cs, float[] sn) {
        int n = re.length;
        for (int i = 0; i < n; i++) {
            int j = rev[i];
            if (j > i) {
                float t = re[i];
                re[i] = re[j];
                re[j] = t;
                t = im[i];
                im[i] = im[j];
                im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            int half = len >> 1;
            int step = n / len;
            for (int i = 0; i < n; i += len) {
                for (int k = 0; k < half; k++) {
                    float wr = cs[k * step], wi = -sn[k * step];
                    int p = i + k, q = p + half;
                    float xr = re[q] * wr - im[q] * wi;
                    float xi = re[q] * wi + im[q] * wr;
                    re[q] = re[p] - xr;
                    im[q] = im[p] - xi;
                    re[p] += xr;
                    im[p] += xi;
                }
            }
        }
    }

    private static final class Feat {
        int T;
        int dec;
        double asr;
        float[] f; // T * D
        float[] flux; // T
        float[] db; // T (loudness)
    }

    private static Feat features(short[] d, int ch, int sr, Progress pg) {
        int frames = d.length / ch;
        int dec = Math.max(1, (int) Math.round(sr / 11025.0));
        double asr = sr / (double) dec;
        int m = frames / dec;
        float[] x = new float[m];
        for (int i = 0; i < m; i++) {
            float s = 0;
            int base = i * dec * ch;
            for (int k = 0; k < dec * ch; k++) s += d[base + k];
            x[i] = s / (dec * ch * 32768f);
        }
        Feat F = new Feat();
        F.dec = dec;
        F.asr = asr;
        int T = (m - N) / H + 1;
        if (T < 4) {
            F.T = 0;
            return F;
        }
        F.T = T;
        F.f = new float[T * D];
        F.flux = new float[T];
        F.db = new float[T];

        // tables
        int[] rev = new int[N];
        int bits = Integer.numberOfTrailingZeros(N);
        for (int i = 0; i < N; i++) rev[i] = Integer.reverse(i) >>> (32 - bits);
        float[] cs = new float[N / 2], sn = new float[N / 2];
        for (int i = 0; i < N / 2; i++) {
            cs[i] = (float) Math.cos(2 * Math.PI * i / N);
            sn[i] = (float) Math.sin(2 * Math.PI * i / N);
        }
        float[] win = new float[N];
        for (int i = 0; i < N; i++) win[i] = (float) (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
        int[] pc = new int[N / 2 + 1];
        for (int k = 0; k <= N / 2; k++) {
            double fr = k * asr / N;
            pc[k] = (fr < 65 || fr > 2100) ? -1 : (((int) Math.round(12 * Math.log(fr / 440.0) / Math.log(2) + 69)) % 12 + 12) % 12;
        }
        double top = Math.min(5500, 0.45 * asr);
        int[] edge = new int[NB + 1];
        for (int b = 0; b <= NB; b++) {
            double fr = 90 * Math.pow(top / 90.0, b / (double) NB);
            edge[b] = Math.max(1, Math.min(N / 2, (int) Math.round(fr * N / asr)));
            if (b > 0 && edge[b] <= edge[b - 1]) edge[b] = Math.min(N / 2, edge[b - 1] + 1);
        }

        float[] re = new float[N], im = new float[N];
        float[] prevLog = new float[NB];
        float[] lg = new float[NB];
        float[] chroma = new float[12];
        for (int t = 0; t < T; t++) {
            if ((t & 63) == 0 && pg != null) {
                if (pg.cancelled()) return null;
                pg.on(0.02f + 0.38f * t / T, "Listening to the song");
            }
            int s0 = t * H;
            for (int i = 0; i < N; i++) {
                re[i] = x[s0 + i] * win[i];
                im[i] = 0;
            }
            fft(re, im, rev, cs, sn);
            java.util.Arrays.fill(chroma, 0f);
            double tot = 0;
            for (int k = 1; k <= N / 2; k++) {
                float p = re[k] * re[k] + im[k] * im[k];
                tot += p;
                if (pc[k] >= 0) chroma[pc[k]] += (float) Math.sqrt(p);
            }
            // chroma: compress and normalize
            double cn = 0;
            for (int c = 0; c < 12; c++) {
                chroma[c] = (float) Math.sqrt(chroma[c]);
                cn += chroma[c] * chroma[c];
            }
            cn = Math.sqrt(cn) + 1e-9;
            // bands
            double mean = 0;
            for (int b = 0; b < NB; b++) {
                double e = 0;
                for (int k = edge[b]; k < edge[b + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
                lg[b] = (float) Math.log10(1e-7 + e / Math.max(1, edge[b + 1] - edge[b]));
                mean += lg[b];
            }
            mean /= NB;
            float fl = 0;
            int o = t * D;
            for (int c = 0; c < 12; c++) F.f[o + c] = (float) (chroma[c] / cn);
            for (int b = 0; b < NB; b++) {
                F.f[o + 12 + b] = (float) ((lg[b] - mean) / 2.0 * 0.5);
                if (t > 0) fl += Math.max(0f, lg[b] - prevLog[b]);
                prevLog[b] = lg[b];
            }
            F.flux[t] = fl;
            F.db[t] = (float) (10 * Math.log10(1e-9 + tot / N));
        }
        double mf = 0;
        for (int t = 0; t < T; t++) mf += F.flux[t];
        mf = mf / T + 1e-6;
        for (int t = 0; t < T; t++) F.f[t * D + D - 1] = (float) (Math.min(3.0, F.flux[t] / mf) * 0.25);
        return F;
    }

    private static float dist(float[] f, int i, int j) {
        float s = 0;
        int a = i * D, b = j * D;
        for (int k = 0; k < D; k++) {
            float v = f[a + k] - f[b + k];
            s += v * v;
        }
        return (float) Math.sqrt(s);
    }

    private static final class Pair {
        int ti, tj;
        double c;
    }

    // ---- the search ----
    /** Returns the best loops found, best first. Returns null if cancelled. */
    public static List<Candidate> find(short[] d, int ch, int sr, Options o, Progress pg) {
        long t0 = System.currentTimeMillis();
        int frames = d.length / ch;
        double dur = frames / (double) sr;
        List<Candidate> out = new ArrayList<Candidate>();
        if (o == null) o = new Options();
        if (pg != null) pg.on(0.01f, "Listening to the song");
        Feat F = features(d, ch, sr, pg);
        if (F == null) return null;
        double hop = H * F.dec / (double) sr; // seconds per frame
        double minLen = o.minLenSec > 0 ? o.minLenSec : Math.max(6.0, 0.3 * dur);
        if (dur < 14) minLen = Math.max(1.0, 0.5 * dur);

        List<Pair> pairs = new ArrayList<Pair>();
        if (F.T >= 40) {
            // candidate moments: where something starts
            int T = F.T;
            double mean = 0, var = 0;
            for (int t = 0; t < T; t++) mean += F.flux[t];
            mean /= T;
            for (int t = 0; t < T; t++) var += (F.flux[t] - mean) * (F.flux[t] - mean);
            double thr = mean + 0.35 * Math.sqrt(var / T);
            List<Integer> cand = new ArrayList<Integer>();
            for (int t = 3; t < T - 3; t++) {
                float v = F.flux[t];
                if (v > thr && v >= F.flux[t - 1] && v >= F.flux[t - 2] && v > F.flux[t + 1] && v > F.flux[t + 2]) cand.add(t);
            }
            if (cand.size() > 1200) {
                final float[] fx = F.flux;
                Collections.sort(cand, new Comparator<Integer>() {
                    public int compare(Integer p, Integer q) {
                        return Float.compare(fx[q], fx[p]);
                    }
                });
                cand = new ArrayList<Integer>(cand.subList(0, 1200));
            }
            if (cand.size() < 150) { // quiet or smooth music: add an even grid
                java.util.HashSet<Integer> have = new java.util.HashSet<Integer>(cand);
                for (int t = 6; t < T - 6; t += 6) {
                    boolean near = false;
                    for (int k = -2; k <= 2; k++) if (have.contains(t + k)) near = true;
                    if (!near) cand.add(t);
                }
            }
            Collections.sort(cand);
            int n = cand.size();
            int[] cf = new int[n];
            for (int i = 0; i < n; i++) cf[i] = cand.get(i);

            // stage 1: cheap pass
            final int M = 1500;
            PriorityQueue<Pair> heap = new PriorityQueue<Pair>(M + 1, new Comparator<Pair>() {
                public int compare(Pair p, Pair q) {
                    return Double.compare(q.c, p.c); // largest cost first (so it can be dropped)
                }
            });
            double worst = Double.MAX_VALUE;
            for (int ci = 0; ci < n; ci++) {
                if ((ci & 31) == 0 && pg != null) {
                    if (pg.cancelled()) return null;
                    pg.on(0.40f + 0.35f * ci / n, "Searching for places that fit");
                }
                int ti = cf[ci];
                if (ti < 3) continue;
                if (o.wholeSong && ti > 0.12 * T) continue;
                for (int cj = ci + 1; cj < n; cj++) {
                    int tj = cf[cj];
                    if ((tj - ti) * hop < minLen) continue;
                    if (o.wholeSong && tj < 0.88 * T) continue;
                    int w = Math.min(W1, ti);
                    float s = 0;
                    for (int k = 1; k <= w; k++) s += dist(F.f, ti - k, tj - k);
                    int wq = Math.min(W1, T - tj);
                    float s2 = 0;
                    for (int k = 0; k < wq; k++) s2 += dist(F.f, ti + k, tj + k);
                    double c = s / w + 0.6 * (wq > 0 ? s2 / wq : 1.0);
                    if (heap.size() < M || c < worst) {
                        Pair p = new Pair();
                        p.ti = ti;
                        p.tj = tj;
                        p.c = c;
                        heap.add(p);
                        if (heap.size() > M) heap.poll();
                        worst = heap.peek().c;
                    }
                }
            }
            // stage 2: the full cost on the best ones
            int cnt = 0, total = heap.size();
            for (Pair p : heap) {
                if ((cnt++ & 31) == 0 && pg != null) {
                    if (pg.cancelled()) return null;
                    pg.on(0.75f + 0.12f * cnt / Math.max(1, total), "Comparing the best matches");
                }
                int ti = p.ti, tj = p.tj;
                int w = Math.min(W2, ti);
                double pre = 0, loud = 0;
                for (int k = 1; k <= w; k++) {
                    pre += dist(F.f, ti - k, tj - k);
                    loud += Math.abs(F.db[ti - k] - F.db[tj - k]);
                }
                pre /= w;
                loud = Math.min(1.0, loud / w / 8.0);
                int wp = Math.min(W2, F.T - tj);
                double post = 0;
                for (int k = 0; k < wp; k++) post += dist(F.f, ti + k, tj + k);
                post = wp > 0 ? post / wp : 1.0;
                double content = (ti * hop) / dur + (dur - tj * hop) / dur;
                double len = (tj - ti) * hop;
                p.c = o.wPre * pre + o.wPost * post + o.wLoud * loud + o.wContent * content;
                pairs.add(p);
                // remember the pre distance for the report (stored in the next step again)
            }
            Collections.sort(pairs, new Comparator<Pair>() {
                public int compare(Pair p, Pair q) {
                    return Double.compare(p.c, q.c);
                }
            });
        }

        // pick distinct winners
        List<Pair> win = new ArrayList<Pair>();
        for (Pair p : pairs) {
            boolean same = false;
            for (Pair q : win) {
                if (Math.abs(p.ti - q.ti) * hop < 1.0 && Math.abs(p.tj - q.tj) * hop < 1.0) {
                    same = true;
                    break;
                }
            }
            if (!same) win.add(p);
            if (win.size() >= Math.max(1, o.maxResults) * 2) break;
        }

        // fine alignment at full sample rate
        int idx = 0;
        for (Pair p : win) {
            if (pg != null) {
                if (pg.cancelled()) return null;
                pg.on(0.88f + 0.10f * (idx++) / Math.max(1, win.size()), "Lining up the waveforms");
            }
            Candidate c = refine(d, ch, sr, F, p.ti, p.tj, o);
            if (c != null) {
                c.cost = p.c;
                out.add(c);
            }
        }
        // a last resort: the plain end-to-start blend, so there is always something
        if (out.isEmpty()) {
            Candidate c = fallback(d, ch, sr, o);
            if (c != null) out.add(c);
        }
        for (Candidate c : out) {
            double pre = c.pre;
            c.quality = Math.max(0, Math.min(100, 100.0 * Math.exp(-2.5 * Math.max(0, pre - 0.04)) * (0.8 + 0.2 * Math.max(0, c.ncc))));
        }
        Collections.sort(out, new Comparator<Candidate>() {
            public int compare(Candidate p, Candidate q) {
                return Double.compare(q.quality - q.cost * 5, p.quality - p.cost * 5);
            }
        });
        // keep distinct ones
        List<Candidate> res = new ArrayList<Candidate>();
        for (Candidate c : out) {
            boolean same = false;
            for (Candidate q : res) {
                if (Math.abs(c.a - q.a) < sr && Math.abs(c.b - q.b) < sr) same = true;
            }
            if (!same) res.add(c);
            if (res.size() >= Math.max(1, o.maxResults)) break;
        }
        if (pg != null) pg.on(1f, "Done in " + (System.currentTimeMillis() - t0) + " ms");
        return res;
    }

    private static float mono(short[] d, int ch, int i) {
        int base = i * ch;
        float s = 0;
        for (int c = 0; c < ch; c++) s += d[base + c];
        return s / ch;
    }

    private static double meanDistBefore(Feat F, int fa, int fb) {
        if (F.T == 0) return 1.0;
        fa = Math.max(1, Math.min(F.T - 1, fa));
        fb = Math.max(1, Math.min(F.T - 1, fb));
        int w = Math.min(W2, Math.min(fa, fb));
        if (w <= 0) return 1.0;
        double s = 0;
        for (int k = 1; k <= w; k++) s += dist(F.f, fa - k, fb - k);
        return s / w;
    }

    /** Move the guessed start and end to the exact sample, line the waveforms up, and choose the blend length. */
    private static Candidate refine(short[] d, int ch, int sr, Feat F, int ti, int tj, Options o) {
        int n = d.length / ch;
        double perFrame = H * F.dec;
        int a0 = (int) Math.round(ti * perFrame + 0.3 * N * F.dec);
        int b0 = (int) Math.round(tj * perFrame + 0.3 * N * F.dec);
        int a = onset(d, ch, a0, (int) (0.045 * sr));
        int b = onset(d, ch, b0, (int) (0.045 * sr));
        // line B up with A: compare the sound before them (and after them) at the sample level
        int L = Math.min(Math.min(a, 1536), 4096);
        if (L < 128) L = 128;
        int S = (int) (0.02 * sr);
        double best = -2, bestPre = 0;
        int bestS = 0;
        for (int s = -S; s <= S; s++) {
            int bb = b + s;
            if (bb - L < 0 || bb + 1 > n || bb <= a + sr / 4) continue;
            if (a - L < 0) continue;
            double sab = 0, saa = 0, sbb = 0;
            for (int i = 0; i < L; i++) {
                float pa = mono(d, ch, a - L + i);
                float pb = mono(d, ch, bb - L + i);
                sab += pa * pb;
                saa += pa * pa;
                sbb += pb * pb;
            }
            double pre = sab / Math.sqrt(saa * sbb + 1e-9);
            double post = 0;
            if (a + L <= n && bb + L <= n) {
                double qab = 0, qaa = 0, qbb = 0;
                for (int i = 0; i < L; i += 2) {
                    float pa = mono(d, ch, a + i);
                    float pb = mono(d, ch, bb + i);
                    qab += pa * pb;
                    qaa += pa * pa;
                    qbb += pb * pb;
                }
                post = qab / Math.sqrt(qaa * qbb + 1e-9);
            }
            double sc = pre + 0.5 * post;
            if (sc > best) {
                best = sc;
                bestPre = pre;
                bestS = s;
            }
        }
        b += bestS;
        if (b <= a + sr / 4 || b > n) return null;
        Candidate c = new Candidate();
        c.a = a;
        c.b = b;
        c.ncc = bestPre;
        c.pre = meanDistBefore(F, (int) Math.round((a - 0.3 * N * F.dec) / perFrame), (int) Math.round((b - 0.3 * N * F.dec) / perFrame));
        c.lenSec = (b - a) / (double) sr;
        double xfs = o.xfSec > 0 ? o.xfSec : 0.03 + 1.17 * Math.max(0, Math.min(1, (c.pre - 0.12) / 0.7));
        int xf = (int) Math.round(xfs * sr);
        xf = Math.min(xf, Math.min(a, (b - a) / 3));
        xf = Math.min(xf, 3 * sr);
        c.xf = Math.max(0, xf);
        return c;
    }

    /** Where, close to the guess, does the sound really start? (the biggest jump in loudness) */
    private static int onset(short[] d, int ch, int center, int radius) {
        int n = d.length / ch;
        int blk = 32;
        int from = Math.max(blk * 4, center - radius);
        int to = Math.min(n - blk * 2, center + radius);
        if (to <= from) return Math.max(0, Math.min(n - 1, center));
        double bestV = -1;
        int best = center;
        for (int p = from; p < to; p += blk) {
            double after = 0, before = 0;
            for (int i = 0; i < blk * 2; i++) {
                float v = mono(d, ch, p + i);
                after += v * v;
            }
            for (int i = 1; i <= blk * 4; i++) {
                float v = mono(d, ch, p - i);
                before += v * v;
            }
            double v = after / (blk * 2) - before / (blk * 4);
            if (v > bestV) {
                bestV = v;
                best = p;
            }
        }
        return Math.max(0, Math.min(n - 1, best - 16));
    }

    private static Candidate fallback(short[] d, int ch, int sr, Options o) {
        int n = d.length / ch;
        if (n < sr) return null;
        Candidate c = new Candidate();
        int xf = (int) Math.min(2.0 * sr, n / 4.0);
        if (o != null && o.xfSec > 0) xf = (int) Math.min(o.xfSec * sr, n / 4.0);
        c.a = xf;
        c.b = n;
        c.xf = xf;
        c.lenSec = (c.b - c.a) / (double) sr;
        c.pre = 0.8;
        c.ncc = 0;
        c.cost = 9;
        return c;
    }

    // ---- building the loop ----
    /**
     * Builds the loop from [a, b). The last xf frames are blended into the sound that comes before a, so when
     * playback wraps from b back to a it is one unbroken stream.
     * target = 0: only the loop (its end flows into its start).
     * target > 0: the whole song, with the loop part repeated until the song is at least target frames long, then the
     * natural ending.
     */
    public static short[] build(short[] d, int ch, int a, int b, int xf, long target) {
        int n = d.length / ch;
        a = Math.max(0, Math.min(n - 1, a));
        b = Math.max(a + 1, Math.min(n, b));
        int len = b - a;
        xf = Math.max(0, Math.min(xf, Math.min(a, len / 2)));
        float[] gOut = new float[xf], gIn = new float[xf];
        // alike material blends with equal gain (no loudness bump), unlike material with equal power
        double sab = 0, saa = 0, sbb = 0;
        for (int k = 0; k < xf; k++) {
            float pa = mono(d, ch, b - xf + k);
            float pb = mono(d, ch, a - xf + k);
            sab += pa * pb;
            saa += pa * pa;
            sbb += pb * pb;
        }
        double rho = xf > 0 ? Math.max(0, sab / Math.sqrt(saa * sbb + 1e-9)) : 0;
        for (int k = 0; k < xf; k++) {
            double t = (k + 0.5) / xf;
            double eqPowOut = Math.cos(t * Math.PI / 2), eqPowIn = Math.sin(t * Math.PI / 2);
            double linOut = 1 - t, linIn = t;
            gOut[k] = (float) (rho * linOut + (1 - rho) * eqPowOut);
            gIn[k] = (float) (rho * linIn + (1 - rho) * eqPowIn);
        }
        // the tail: [b-xf, b) blended with [a-xf, a)
        short[] tail = new short[xf * ch];
        for (int k = 0; k < xf; k++) {
            for (int c = 0; c < ch; c++) {
                float v = d[(b - xf + k) * ch + c] * gOut[k] + d[(a - xf + k) * ch + c] * gIn[k];
                tail[k * ch + c] = clip16(v);
            }
        }
        if (target <= 0) {
            short[] out = new short[len * ch];
            System.arraycopy(d, a * ch, out, 0, (len - xf) * ch);
            System.arraycopy(tail, 0, out, (len - xf) * ch, xf * ch);
            return out;
        }
        // song: [0, b-xf) + tail, then r more loops, then [a, n)
        long base = (long) b + (n - a); // with no extra loops
        long r = 0;
        if (target > base) r = (target - base + len - 1) / len;
        long total = base + r * len;
        if (total > Integer.MAX_VALUE / ch) throw new IllegalArgumentException("too long");
        short[] out = new short[(int) total * ch];
        int pos = 0;
        System.arraycopy(d, 0, out, 0, (b - xf) * ch);
        pos += (b - xf) * ch;
        System.arraycopy(tail, 0, out, pos, xf * ch);
        pos += xf * ch;
        for (long i = 0; i < r; i++) {
            System.arraycopy(d, a * ch, out, pos, (len - xf) * ch);
            pos += (len - xf) * ch;
            System.arraycopy(tail, 0, out, pos, xf * ch);
            pos += xf * ch;
        }
        System.arraycopy(d, a * ch, out, pos, (n - a) * ch);
        return out;
    }

    private static short clip16(float v) {
        if (v > 32767f) return 32767;
        if (v < -32768f) return -32768;
        return (short) Math.round(v);
    }
}
