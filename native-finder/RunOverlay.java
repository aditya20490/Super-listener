package com.taskautomator;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.SweepGradient;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;

import java.util.List;
import java.util.Random;

/**
 * The screen you see while Music Finder downloads a song. The real website keeps working underneath, out of sight;
 * this shows what is happening instead: a glowing ring that fills step by step, a list of the 7 steps that tick off
 * one by one, then the download itself, and a small celebration at the end.
 * "Show browser" lets you look at the real page (for example if the site asks for a captcha).
 */
final class RunOverlay extends FrameLayout {

    private static final int RUN = 0, DOWNLOADING = 1, SUCCESS = 2, FAILED = 3, STOPPED = 4;
    private static final String[] LABELS = {
            "Opening the downloader",
            "Pasting your song link",
            "Searching for the song",
            "Preparing the download link",
            "Choosing the quality",
            "Picking the original M4A",
            "Downloading your song",
    };

    private final Activity activity;
    private final Runnable onStop;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final int total;
    private final AnimView anim;
    private final PillView pill;
    private final ValueAnimator ticker;

    private int phase = RUN;
    private int completed = 0; // steps that are finished
    private int active = 0; // the step running now
    private long activeAt = 0;
    private final long[] doneAt;
    private long allStepsAt = 0;
    private long successAt = 0;
    private long startWall = 0;
    private float dlFraction = -1f;
    private String dlName = "";
    private String message = "";
    private boolean showBrowser = false;
    private boolean closed = false;

    private final Runnable poll = new Runnable() {
        public void run() {
            if (closed) return;
            pollDownload();
            handler.postDelayed(this, 400);
        }
    };

    static RunOverlay attach(Activity a, int totalSteps, Runnable onStop) {
        RunOverlay o = new RunOverlay(a, totalSteps, onStop);
        FrameLayout root = a.findViewById(android.R.id.content);
        root.addView(o, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // the keyboard would pop up over the animation when the page's text box is tapped, so keep it away
        a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
        return o;
    }

    private RunOverlay(Activity a, int totalSteps, Runnable stop) {
        super(a);
        this.activity = a;
        this.onStop = stop;
        this.total = Math.max(1, totalSteps);
        this.doneAt = new long[this.total];
        this.anim = new AnimView(a);
        this.pill = new PillView(a);
        addView(anim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        FrameLayout.LayoutParams pl = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        int m = (int) (16 * a.getResources().getDisplayMetrics().density);
        pl.setMargins(m, m, m, m * 4);
        addView(pill, pl);
        pill.setVisibility(View.GONE);
        ticker = ValueAnimator.ofFloat(0f, 1f);
        ticker.setDuration(1000);
        ticker.setRepeatCount(ValueAnimator.INFINITE);
        ticker.setInterpolator(new LinearInterpolator());
        ticker.addUpdateListener(v -> anim.invalidate());
        ticker.start();
    }

    // ---------------------------------------------------------------- called by the run screen

    void onStart() {
        startWall = System.currentTimeMillis();
        phase = RUN;
        completed = 0;
        active = 0;
        activeAt = SystemClock.uptimeMillis();
        handler.removeCallbacks(poll);
        handler.postDelayed(poll, 400);
    }

    void onStep(int shown, int totalSteps) {
        long now = SystemClock.uptimeMillis();
        int idx = Math.min(total, Math.max(0, shown - 1));
        for (int i = 0; i < idx && i < total; i++) if (doneAt[i] == 0) doneAt[i] = now;
        completed = idx;
        active = idx;
        activeAt = now;
    }

    void onAllSteps(int failed) {
        long now = SystemClock.uptimeMillis();
        for (int i = 0; i < total - 1; i++) if (doneAt[i] == 0) doneAt[i] = now;
        completed = total - 1; // the last step stays "running" until the song has arrived
        active = total - 1;
        if (phase == RUN) {
            phase = DOWNLOADING;
            allStepsAt = now;
        }
        if (failed > 0) message = failed + (failed == 1 ? " step" : " steps") + " could not find their button on the page.";
    }

    void onStopped(String msg) {
        if (phase == SUCCESS || phase == FAILED) return;
        phase = STOPPED;
        message = msg == null ? "Stopped." : msg;
        anim.invalidate();
    }

    void shutdown() {
        closed = true;
        handler.removeCallbacksAndMessages(null);
        try {
            ticker.cancel();
        } catch (Exception ignored) {
        }
    }

    // ---------------------------------------------------------------- the download itself

    private void pollDownload() {
        if (phase == SUCCESS || phase == FAILED || phase == STOPPED) return;
        try {
            List<DownloadItem> list = DownloadStore.all(activity);
            DownloadItem found = null;
            for (DownloadItem d : list) {
                if (d.time >= startWall - 3000) {
                    found = d;
                    break;
                }
            }
            if (found != null) {
                dlName = found.name == null ? "" : found.name;
                if ("done".equals(found.status)) {
                    succeed();
                } else if ("failed".equals(found.status)) {
                    fail("The download failed. Try again, or tap Show browser to see the page.");
                } else {
                    dlFraction = found.size > 0 ? Math.min(1f, (float) found.done / found.size) : -1f;
                    if (phase == RUN && active >= total - 1) phase = DOWNLOADING;
                }
            } else if (phase == DOWNLOADING && SystemClock.uptimeMillis() - allStepsAt > 60000) {
                fail("The download did not start. Tap Show browser to see the page.");
            }
        } catch (Exception ignored) {
        }
    }

    private void succeed() {
        long now = SystemClock.uptimeMillis();
        for (int i = 0; i < total; i++) if (doneAt[i] == 0) doneAt[i] = now;
        completed = total;
        successAt = now;
        phase = SUCCESS;
        anim.startBurst();
        if (showBrowser) toggleBrowser();
    }

    private void fail(String msg) {
        phase = FAILED;
        message = msg;
    }

    private void toggleBrowser() {
        showBrowser = !showBrowser;
        anim.setVisibility(showBrowser ? View.GONE : View.VISIBLE);
        pill.setVisibility(showBrowser ? View.VISIBLE : View.GONE);
        if (showBrowser) activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
        else activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
    }

    private boolean finished() {
        return phase == SUCCESS || phase == FAILED || phase == STOPPED;
    }

    // ---------------------------------------------------------------- the small "back to the animation" button

    private final class PillView extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();

        PillView(Context c) {
            super(c);
        }

        @Override
        protected void onMeasure(int w, int h) {
            float d = getResources().getDisplayMetrics().density;
            setMeasuredDimension((int) (150 * d), (int) (44 * d));
        }

        @Override
        protected void onDraw(Canvas c) {
            float d = getResources().getDisplayMetrics().density;
            r.set(0, 0, getWidth(), getHeight());
            p.setStyle(Paint.Style.FILL);
            p.setColor(0xF2241B3F);
            c.drawRoundRect(r, getHeight() / 2f, getHeight() / 2f, p);
            p.setColor(0xFFFFFFFF);
            p.setTextSize(14 * d);
            p.setTypeface(Typeface.DEFAULT_BOLD);
            p.setTextAlign(Paint.Align.CENTER);
            c.drawText("Show animation", getWidth() / 2f, getHeight() / 2f + 5 * d, p);
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            if (e.getAction() == MotionEvent.ACTION_UP) toggleBrowser();
            return true;
        }
    }

    // ---------------------------------------------------------------- the animation

    private final class AnimView extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();
        private final Random rnd = new Random(11);
        private final float d;

        private Shader bgShader, sweepShader, glowShader;
        private float cx, cy, R;
        private float[] px, py, pv, ps, pph;
        private float progShown = 0f;
        private long last = 0;

        // confetti
        private float[] fx, fy, fvx, fvy, fr, frv;
        private int[] fc;
        private long burstAt = 0;
        private final boolean[] hit = new boolean[2]; // 0 = stop/done button, 1 = browser button
        private final RectF btnMain = new RectF(), btnBrowser = new RectF();

        AnimView(Context c) {
            super(c);
            d = c.getResources().getDisplayMetrics().density;
        }

        void startBurst() {
            int n = 70;
            fx = new float[n];
            fy = new float[n];
            fvx = new float[n];
            fvy = new float[n];
            fr = new float[n];
            frv = new float[n];
            fc = new int[n];
            int[] pal = {0xFF8B5CF6, 0xFF22D3EE, 0xFF34D399, 0xFFFBBF24, 0xFFF472B6, 0xFFFFFFFF};
            for (int i = 0; i < n; i++) {
                fx[i] = cx;
                fy[i] = cy;
                double a = rnd.nextDouble() * Math.PI * 2;
                float sp = (180 + rnd.nextFloat() * 520) * d;
                fvx[i] = (float) Math.cos(a) * sp;
                fvy[i] = (float) Math.sin(a) * sp - 260 * d;
                fr[i] = rnd.nextFloat() * 360f;
                frv[i] = (rnd.nextFloat() - 0.5f) * 900f;
                fc[i] = pal[rnd.nextInt(pal.length)];
            }
            burstAt = SystemClock.uptimeMillis();
        }

        @Override
        protected void onSizeChanged(int w, int h, int ow, int oh) {
            cx = w / 2f;
            R = Math.min(w * 0.24f, h * 0.13f);
            cy = Math.min(h * 0.27f, 64 * d + R + 40 * d);
            bgShader = new LinearGradient(0, 0, 0, h, new int[]{0xFF0B0816, 0xFF1A1038, 0xFF0B0816}, null, Shader.TileMode.CLAMP);
            sweepShader = new SweepGradient(cx, cy, new int[]{0xFF8B5CF6, 0xFF22D3EE, 0xFF8B5CF6}, null);
            glowShader = new RadialGradient(0, 0, 1f, new int[]{0x668B5CF6, 0x00000000}, null, Shader.TileMode.CLAMP);
            int n = 42;
            px = new float[n];
            py = new float[n];
            pv = new float[n];
            ps = new float[n];
            pph = new float[n];
            for (int i = 0; i < n; i++) {
                px[i] = rnd.nextFloat() * w;
                py[i] = rnd.nextFloat() * h;
                pv[i] = (10 + rnd.nextFloat() * 34) * d;
                ps[i] = (1 + rnd.nextFloat() * 2.4f) * d;
                pph[i] = rnd.nextFloat() * 6.28f;
            }
        }

        private float ease(float x) {
            return x * x * (3f - 2f * x);
        }

        @Override
        protected void onDraw(Canvas c) {
            int W = getWidth(), H = getHeight();
            if (W == 0 || H == 0 || bgShader == null) return;
            long nowMs = SystemClock.uptimeMillis();
            float t = nowMs / 1000f;
            float dt = last == 0 ? 0.016f : Math.min(0.05f, (nowMs - last) / 1000f);
            last = nowMs;

            // background
            p.setStyle(Paint.Style.FILL);
            p.setShader(bgShader);
            c.drawRect(0, 0, W, H, p);
            p.setShader(null);

            // drifting lights
            for (int i = 0; i < px.length; i++) {
                py[i] -= pv[i] * dt;
                if (py[i] < -10 * d) {
                    py[i] = H + 10 * d;
                    px[i] = rnd.nextFloat() * W;
                }
                float tw = 0.5f + 0.5f * (float) Math.sin(t * 1.6f + pph[i]);
                p.setColor(((int) ((0.10f + 0.30f * tw) * 255) << 24) | 0xC8B8FF);
                c.drawCircle(px[i], py[i], ps[i], p);
            }

            boolean ok = phase == SUCCESS;
            boolean bad = phase == FAILED || phase == STOPPED;

            // glow behind the ring
            float pulse = 1f + 0.08f * (float) Math.sin(t * 2.4f);
            float gr = R * 2.0f * pulse;
            c.save();
            c.translate(cx, cy);
            c.scale(gr, gr);
            p.setShader(glowShader);
            c.drawRect(-1, -1, 1, 1, p);
            p.setShader(null);
            c.restore();
            if (ok) {
                // rings of light spreading out
                float age = (nowMs - successAt) / 1000f;
                for (int k = 0; k < 2; k++) {
                    float q = (age - k * 0.35f) / 1.4f;
                    if (q > 0 && q < 1) {
                        p.setStyle(Paint.Style.STROKE);
                        p.setStrokeWidth(3 * d);
                        p.setColor(((int) ((1f - q) * 140) << 24) | 0x34D399);
                        c.drawCircle(cx, cy, R + q * R * 1.6f, p);
                    }
                }
            }

            // progress
            float target;
            if (ok) target = 1f;
            else if (phase == DOWNLOADING && dlFraction >= 0) target = (total - 1 + 0.15f + 0.85f * dlFraction) / total;
            else target = (Math.min(completed, total - 1) + (finished() ? 0f : 0.45f)) / total;
            if (bad) target = Math.max(0.05f, progShown);
            progShown += (target - progShown) * Math.min(1f, dt * 4f);

            // the ring
            float sw = 9 * d;
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(sw);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setColor(0xFF2A2347);
            c.drawCircle(cx, cy, R, p);
            r.set(cx - R, cy - R, cx + R, cy + R);
            if (progShown > 0.004f) {
                c.save();
                c.rotate(-90, cx, cy);
                if (bad) p.setColor(0xFFFB7185);
                else p.setShader(sweepShader);
                c.drawArc(r, 0, Math.min(360f, progShown * 360f), false, p);
                p.setShader(null);
                c.restore();
            }
            if (!finished() && !ok) {
                // a bright spark running around the ring
                p.setColor(0xE6FFFFFF);
                c.drawArc(r, (t * 230f) % 360f - 90f, 26f, false, p);
                // orbiting dots
                p.setStyle(Paint.Style.FILL);
                for (int k = 0; k < 3; k++) {
                    float a = t * 1.5f + k * 2.094f;
                    float rr = R + 20 * d;
                    p.setColor(((int) ((0.9f - 0.25f * k) * 255) << 24) | (k == 1 ? 0x22D3EE : 0x8B5CF6));
                    c.drawCircle(cx + (float) Math.cos(a) * rr, cy + (float) Math.sin(a) * rr, (4.2f - k * 0.9f) * d, p);
                }
            }
            p.setStrokeCap(Paint.Cap.BUTT);

            // the middle of the ring
            drawCenter(c, t, nowMs, ok, bad);

            // title
            p.setStyle(Paint.Style.FILL);
            p.setTextAlign(Paint.Align.CENTER);
            p.setTypeface(Typeface.DEFAULT_BOLD);
            p.setColor(0xFFFFFFFF);
            p.setTextSize(22 * d);
            String title = ok ? "Song downloaded" : phase == FAILED ? "Could not finish" : phase == STOPPED ? "Stopped" : phase == DOWNLOADING ? "Downloading" : "Getting your song";
            c.drawText(title, cx, 40 * d, p);
            p.setTypeface(Typeface.DEFAULT);
            p.setTextSize(13 * d);
            p.setColor(0xFF9B93B8);
            String sub = ok ? (dlName.length() > 0 ? dlName : "Saved in your Downloads folder")
                    : bad ? message : "Working in the background";
            drawFit(c, sub, cx, 40 * d + 22 * d, W - 40 * d);

            drawSteps(c, W, H, t, nowMs, ok);
            drawButtons(c, W, H);

            // confetti
            if (fx != null && burstAt > 0) {
                float age = (nowMs - burstAt) / 1000f;
                if (age < 3.2f) {
                    p.setStyle(Paint.Style.FILL);
                    for (int i = 0; i < fx.length; i++) {
                        fvy[i] += 900 * d * dt;
                        fx[i] += fvx[i] * dt;
                        fy[i] += fvy[i] * dt;
                        fr[i] += frv[i] * dt;
                        float al = Math.max(0f, Math.min(1f, (3.2f - age) / 1.2f));
                        p.setColor(((int) (al * 255) << 24) | (fc[i] & 0xFFFFFF));
                        c.save();
                        c.rotate(fr[i], fx[i], fy[i]);
                        c.drawRect(fx[i] - 4 * d, fy[i] - 2 * d, fx[i] + 4 * d, fy[i] + 2 * d, p);
                        c.restore();
                    }
                }
            }
        }

        private void drawFit(Canvas c, String s, float x, float y, float maxW) {
            if (s == null) return;
            String out = s;
            while (out.length() > 4 && p.measureText(out) > maxW) out = out.substring(0, out.length() - 4) + "…";
            c.drawText(out, x, y, p);
        }

        private void drawCenter(Canvas c, float t, long nowMs, boolean ok, boolean bad) {
            p.setStyle(Paint.Style.FILL);
            p.setTextAlign(Paint.Align.CENTER);
            if (ok) {
                float q = Math.min(1f, (nowMs - successAt) / 650f);
                float ax = cx - R * 0.34f, ay = cy + R * 0.02f;
                float bx = cx - R * 0.10f, by = cy + R * 0.28f;
                float ex = cx + R * 0.38f, ey = cy - R * 0.26f;
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(R * 0.15f);
                p.setStrokeCap(Paint.Cap.ROUND);
                p.setColor(0xFFFFFFFF);
                if (q < 0.4f) {
                    float u = q / 0.4f;
                    c.drawLine(ax, ay, ax + (bx - ax) * u, ay + (by - ay) * u, p);
                } else {
                    float u = (q - 0.4f) / 0.6f;
                    c.drawLine(ax, ay, bx, by, p);
                    c.drawLine(bx, by, bx + (ex - bx) * u, by + (ey - by) * u, p);
                }
                p.setStrokeCap(Paint.Cap.BUTT);
                return;
            }
            if (bad) {
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(R * 0.14f);
                p.setStrokeCap(Paint.Cap.ROUND);
                p.setColor(0xFFFB7185);
                c.drawLine(cx - R * 0.28f, cy - R * 0.28f, cx + R * 0.28f, cy + R * 0.28f, p);
                c.drawLine(cx + R * 0.28f, cy - R * 0.28f, cx - R * 0.28f, cy + R * 0.28f, p);
                p.setStrokeCap(Paint.Cap.BUTT);
                return;
            }
            p.setColor(0xFFFFFFFF);
            p.setTypeface(Typeface.DEFAULT_BOLD);
            if (phase == DOWNLOADING && completed >= total - 1 && allStepsAt > 0) {
                if (dlFraction >= 0) {
                    p.setTextSize(R * 0.62f);
                    c.drawText(Math.round(dlFraction * 100) + "%", cx, cy + R * 0.2f, p);
                    p.setTypeface(Typeface.DEFAULT);
                    p.setTextSize(R * 0.2f);
                    p.setColor(0xFF9B93B8);
                    c.drawText("downloading", cx, cy + R * 0.52f, p);
                } else {
                    // bouncing dots while the size is not known yet
                    for (int k = 0; k < 3; k++) {
                        float b = (float) Math.abs(Math.sin(t * 4f - k * 0.55f));
                        p.setColor(0xFFFFFFFF);
                        c.drawCircle(cx + (k - 1) * R * 0.3f, cy - b * R * 0.2f, R * 0.09f, p);
                    }
                }
                return;
            }
            float age = (nowMs - activeAt) / 1000f;
            float pop = 1f + 0.35f * (float) Math.exp(-age * 7f) * (float) Math.cos(age * 14f);
            p.setTextSize(R * 0.78f * pop);
            c.drawText(String.valueOf(Math.min(total, active + 1)), cx, cy + R * 0.24f * pop, p);
            p.setTypeface(Typeface.DEFAULT);
            p.setTextSize(R * 0.22f);
            p.setColor(0xFF9B93B8);
            c.drawText("of " + total, cx, cy + R * 0.58f, p);
        }

        private void drawSteps(Canvas c, int W, int H, float t, long nowMs, boolean ok) {
            float top = cy + R + 58 * d;
            float avail = H - top - 110 * d;
            float rowH = Math.max(34 * d, Math.min(54 * d, avail / total));
            float x0 = W * 0.13f;
            float cr = 12 * d;
            for (int i = 0; i < total; i++) {
                float yc = top + rowH * i + rowH / 2f;
                boolean done = ok || i < completed;
                boolean act = !ok && !finished() && i == Math.min(active, total - 1) && !done;
                if (phase == DOWNLOADING && i == total - 1 && !ok) {
                    done = false;
                    act = true;
                }
                // the line down to the next step
                if (i < total - 1) {
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(3 * d);
                    p.setColor(0xFF2A2347);
                    c.drawLine(x0, yc + cr + 3 * d, x0, yc + rowH - cr - 3 * d, p);
                    if (done && doneAt[i] > 0) {
                        float q = ease(Math.min(1f, Math.max(0f, (nowMs - doneAt[i]) / 450f)));
                        p.setColor(0xFF8B5CF6);
                        float y1 = yc + cr + 3 * d, y2 = yc + rowH - cr - 3 * d;
                        c.drawLine(x0, y1, x0, y1 + (y2 - y1) * q, p);
                    }
                }
                // highlight behind the running step
                if (act) {
                    float a = 0.10f + 0.06f * (float) Math.sin(t * 3f);
                    p.setStyle(Paint.Style.FILL);
                    p.setColor(((int) (a * 255) << 24) | 0x8B5CF6);
                    r.set(x0 - cr - 10 * d, yc - rowH / 2f + 3 * d, W - 16 * d, yc + rowH / 2f - 3 * d);
                    c.drawRoundRect(r, 14 * d, 14 * d, p);
                }
                // the marker
                if (done) {
                    float age = doneAt[i] > 0 ? (nowMs - doneAt[i]) / 1000f : 1f;
                    float s = age < 0.4f ? 1f + 0.45f * (float) Math.sin(age / 0.4f * Math.PI) * (1f - age / 0.4f) : 1f;
                    p.setStyle(Paint.Style.FILL);
                    p.setColor(0xFF8B5CF6);
                    c.drawCircle(x0, yc, cr * s, p);
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(2.6f * d);
                    p.setStrokeCap(Paint.Cap.ROUND);
                    p.setColor(0xFFFFFFFF);
                    c.drawLine(x0 - 5 * d * s, yc + 0.5f * d, x0 - 1.5f * d * s, yc + 4 * d * s, p);
                    c.drawLine(x0 - 1.5f * d * s, yc + 4 * d * s, x0 + 5.5f * d * s, yc - 4 * d * s, p);
                    p.setStrokeCap(Paint.Cap.BUTT);
                } else if (act) {
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(3 * d);
                    p.setColor(0xFF4C3F86);
                    c.drawCircle(x0, yc, cr, p);
                    r.set(x0 - cr, yc - cr, x0 + cr, yc + cr);
                    p.setColor(0xFF22D3EE);
                    p.setStrokeCap(Paint.Cap.ROUND);
                    c.drawArc(r, (t * 360f) % 360f, 110f, false, p);
                    p.setStrokeCap(Paint.Cap.BUTT);
                    p.setStyle(Paint.Style.FILL);
                    p.setColor(0xFFFFFFFF);
                    c.drawCircle(x0, yc, (3.2f + 1.2f * (float) Math.sin(t * 5f)) * d, p);
                } else {
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(2 * d);
                    p.setColor(0xFF3A3358);
                    c.drawCircle(x0, yc, cr, p);
                }
                // the words
                p.setStyle(Paint.Style.FILL);
                p.setTextAlign(Paint.Align.LEFT);
                p.setTextSize(15 * d);
                String label = i < LABELS.length && total == LABELS.length ? LABELS[i] : "Step " + (i + 1);
                if (act) {
                    int dots = 1 + (int) ((t * 2.5f) % 3);
                    label = label + "...".substring(0, dots);
                    p.setTypeface(Typeface.DEFAULT_BOLD);
                    p.setColor(0xFFFFFFFF);
                } else if (done) {
                    p.setTypeface(Typeface.DEFAULT);
                    p.setColor(0xFFCFC8EE);
                } else {
                    p.setTypeface(Typeface.DEFAULT);
                    p.setColor(0xFF6F688F);
                }
                c.drawText(label, x0 + cr + 16 * d, yc + 5 * d, p);
            }
            p.setTextAlign(Paint.Align.CENTER);
        }

        private void drawButtons(Canvas c, int W, int H) {
            float bh = 48 * d;
            float by = H - bh - 20 * d;
            float gap = 12 * d;
            float side = 20 * d;
            float half = (W - side * 2 - gap) / 2f;
            btnBrowser.set(side, by, side + half, by + bh);
            btnMain.set(side + half + gap, by, W - side, by + bh);
            p.setStyle(Paint.Style.FILL);
            p.setColor(0xFF241B3F);
            c.drawRoundRect(btnBrowser, bh / 2f, bh / 2f, p);
            p.setColor(finished() ? (phase == SUCCESS ? 0xFF8B5CF6 : 0xFF3A2F63) : 0xFF3B1F3A);
            c.drawRoundRect(btnMain, bh / 2f, bh / 2f, p);
            p.setTextAlign(Paint.Align.CENTER);
            p.setTypeface(Typeface.DEFAULT_BOLD);
            p.setTextSize(15 * d);
            p.setColor(0xFFFFFFFF);
            c.drawText("Show browser", btnBrowser.centerX(), btnBrowser.centerY() + 5 * d, p);
            p.setColor(finished() ? 0xFFFFFFFF : 0xFFFF9FB0);
            c.drawText(finished() ? (phase == SUCCESS ? "Done" : "Close") : "Stop", btnMain.centerX(), btnMain.centerY() + 5 * d, p);
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            int a = e.getAction();
            if (a == MotionEvent.ACTION_DOWN) return true;
            if (a == MotionEvent.ACTION_UP) {
                float x = e.getX(), y = e.getY();
                if (btnBrowser.contains(x, y)) {
                    toggleBrowser();
                } else if (btnMain.contains(x, y)) {
                    if (finished()) activity.finish();
                    else if (onStop != null) onStop.run();
                }
                return true;
            }
            return true;
        }
    }
}
