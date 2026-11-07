package com.musicplus.persist;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Keeps one small text file in the app's media folder: Android/media/<package>/MusicPlus/.
 * Android does not delete that folder when the app is uninstalled, and the same app can read it again after a
 * reinstall without asking for any permission. This is the standard place apps use for backups that must survive
 * an uninstall.
 */
public class PersistentStoreModule extends ReactContextBaseJavaModule {

    public PersistentStoreModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "PersistentStore";
    }

    private File dir() {
        try {
            File[] dirs = getReactApplicationContext().getExternalMediaDirs();
            if (dirs == null || dirs.length == 0 || dirs[0] == null) return null;
            File d = new File(dirs[0], "MusicPlus");
            if (!d.exists()) d.mkdirs();
            return d.exists() && d.isDirectory() ? d : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean okName(String n) {
        return n != null && n.matches("[A-Za-z0-9._-]{1,64}");
    }

    private static String readText(File f) throws Exception {
        if (f == null || !f.exists() || f.length() == 0) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void copy(File from, File to) throws Exception {
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    /** The saved text, or null when there is none. */
    @ReactMethod
    public void read(String name, Promise promise) {
        try {
            File d = dir();
            if (d == null || !okName(name)) { promise.resolve(null); return; }
            promise.resolve(readText(new File(d, name)));
        } catch (Exception e) {
            promise.resolve(null);
        }
    }

    /** The copy from before the last save (used if the newest file is damaged). */
    @ReactMethod
    public void readOld(String name, Promise promise) {
        try {
            File d = dir();
            if (d == null || !okName(name)) { promise.resolve(null); return; }
            promise.resolve(readText(new File(d, name + ".bak")));
        } catch (Exception e) {
            promise.resolve(null);
        }
    }

    /** Saves safely: write a temporary file first, keep the previous one as .bak, then swap. */
    @ReactMethod
    public void write(String name, String content, Promise promise) {
        try {
            File d = dir();
            if (d == null || !okName(name) || content == null) { promise.resolve(false); return; }
            File main = new File(d, name);
            File tmp = new File(d, name + ".tmp");
            File bak = new File(d, name + ".bak");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (main.exists() && main.length() > 0) {
                try { copy(main, bak); } catch (Exception ignored) {}
            }
            if (!tmp.renameTo(main)) {
                main.delete();
                if (!tmp.renameTo(main)) { promise.resolve(false); return; }
            }
            promise.resolve(true);
        } catch (Exception e) {
            promise.resolve(false);
        }
    }

    /** Where the file lives (handy to check). */
    @ReactMethod
    public void info(Promise promise) {
        File d = dir();
        WritableMap m = Arguments.createMap();
        m.putBoolean("available", d != null);
        m.putString("path", d == null ? "" : d.getAbsolutePath());
        promise.resolve(m);
    }
}
