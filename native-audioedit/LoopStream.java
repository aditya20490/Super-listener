package com.musicplus.audioedit;

/**
 * The loop repeated as many times as wanted, produced a piece at a time, so a one hour result never has to sit in
 * memory. Optionally fades out over the last seconds.
 */
public final class LoopStream {
    private final short[] body;
    private final int ch;
    private final long bodyFrames;
    private final long total;
    private final long fadeFrames;

    public LoopStream(short[] body, int ch, int sr, long loops, double fadeOutSec) {
        this.body = body;
        this.ch = ch;
        this.bodyFrames = body.length / ch;
        this.total = bodyFrames * Math.max(1, loops);
        long ff = Math.round(Math.max(0, fadeOutSec) * sr);
        this.fadeFrames = Math.min(ff, total);
    }

    public long totalFrames() {
        return total;
    }

    /** Fills out with frames [start, start + frames). */
    public void fill(long start, int frames, short[] out) {
        int bi = (int) (start % bodyFrames);
        long fadeFrom = total - fadeFrames;
        for (int i = 0; i < frames; i++) {
            long pos = start + i;
            float g = 1f;
            if (fadeFrames > 0 && pos >= fadeFrom) {
                float p = (float) (total - pos) / fadeFrames; // 1 -> 0
                g = p * p * (3f - 2f * p);
            }
            int src = bi * ch;
            for (int c = 0; c < ch; c++) {
                float v = body[src + c] * g;
                out[i * ch + c] = (short) Math.round(Math.max(-32768f, Math.min(32767f, v)));
            }
            bi++;
            if (bi >= bodyFrames) bi = 0;
        }
    }
}
