package com.taskautomator;

import android.content.Intent;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.Arguments;

import org.json.JSONObject;

/**
 * Bridge between the player's Music Finder screen and the Task Automator engine.
 * Lives in the com.taskautomator package so it can use the engine's package-private classes.
 */
public class TaskAutomatorModule extends ReactContextBaseJavaModule {

    // One fixed id, so every run overwrites the same saved project instead of piling up new ones.
    private static final String RUN_ID = "music-finder-run";

    public TaskAutomatorModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "TaskAutomator";
    }

    /** run(template, link, selector): replaces the typed link in the recorded steps, then opens the runner screen. */
    @ReactMethod
    public void run(String template, String link, String selector, Promise promise) {
        if (template == null || template.isEmpty()) { promise.reject("E_TASK", "No task template given"); return; }
        if (link == null || link.isEmpty()) { promise.reject("E_LINK", "No link given"); return; }
        if (selector == null || selector.isEmpty()) selector = "#id_url";
        try {
            Project p = ProjectFile.parse(template);

            JSONObject target = null;
            JSONObject firstType = null;
            for (int i = 0; i < p.steps.length(); i++) {
                JSONObject s = p.steps.optJSONObject(i);
                if (s == null || !"type".equals(s.optString("type")) || s.optBoolean("secret")) continue;
                if (firstType == null) firstType = s;
                if (selector.equals(s.optString("selector"))) { target = s; break; }
            }
            if (target == null) target = firstType;
            if (target == null) { promise.reject("E_TASK", "The task has no typing step to put the link into"); return; }
            target.put("value", link);

            p.id = RUN_ID;
            new ProjectStore(getReactApplicationContext()).save(p);

            Intent i = new Intent(getReactApplicationContext(), BrowserActivity.class);
            i.putExtra("mode", "run");
            i.putExtra("projectId", RUN_ID);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(i);

            WritableMap ret = Arguments.createMap();
            ret.putInt("steps", p.steps.length());
            promise.resolve(ret);
        } catch (Exception e) {
            promise.reject("E_RUN", "Could not start the task: " + e.getMessage());
        }
    }

    /** Opens the full Task Automator screen (projects, recorder, downloads). */
    @ReactMethod
    public void openHome(Promise promise) {
        Intent i = new Intent(getReactApplicationContext(), MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getReactApplicationContext().startActivity(i);
        promise.resolve(true);
    }

    /** Opens the automator's own Downloads list. */
    @ReactMethod
    public void openDownloads(Promise promise) {
        Intent i = new Intent(getReactApplicationContext(), DownloadsActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getReactApplicationContext().startActivity(i);
        promise.resolve(true);
    }
}
