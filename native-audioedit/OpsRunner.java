package com.musicplus.audioedit;

/** Applies one edit from the edit list to the audio. Pure code (no Android), so it can be tested on its own. */
public final class OpsRunner {
    private OpsRunner() {}

    /** One edit. Times are in seconds, except the loop edit which uses exact frames. */
    public static class Op {
        public String t = "";
        public double from = -1; // -1 = from the start
        public double to = -1; // -1 = to the end
        public double db = 0;
        public double factor = 1;
        public long a, b, xf, target;
    }

    public static short[] apply(short[] d, int ch, int sr, Op op) {
        int n = d.length / ch;
        long f = op.from < 0 ? 0 : Math.round(op.from * sr);
        long t = op.to < 0 ? n : Math.round(op.to * sr);
        f = Math.max(0, Math.min(n, f));
        t = Math.max(f, Math.min(n, t));
        String k = op.t;
        if (k.equals("trim")) return AudioOps.trim(d, ch, f, t);
        if (k.equals("cut")) return AudioOps.cut(d, ch, f, t, sr);
        if (k.equals("fadeIn")) return AudioOps.fade(d, ch, f, t, true);
        if (k.equals("fadeOut")) return AudioOps.fade(d, ch, f, t, false);
        if (k.equals("gain")) return AudioOps.gain(d, ch, f, t, op.db);
        if (k.equals("normalize")) return AudioOps.normalize(d, ch, f, t, op.db == 0 ? -1.0 : op.db);
        if (k.equals("silence")) return AudioOps.silence(d, ch, f, t, sr);
        if (k.equals("reverse")) return AudioOps.reverse(d, ch, f, t);
        if (k.equals("speed")) return AudioOps.speed(d, ch, op.factor);
        if (k.equals("loop")) {
            // the loop itself (one seamless cycle). How many times it repeats is applied when the result is played or saved.
            return LoopMaker.build(d, ch, (int) op.a, (int) op.b, (int) op.xf);
        }
        return d; // unknown edit: leave the audio as it is
    }
}
