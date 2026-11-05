// Runs during the build, inside the app project (musicapp/), after "expo prebuild".
// Pulls the Task Automator engine (checked out from its own repo) into the Android project and registers
// a bridge so the player's Music Finder screen can run the recorded download steps.
// Same idea as the Capacitor merge in your Music Finder repo, done for this app. Task Automator is not changed.
const fs = require('fs');
const path = require('path');

const TA = '../old-automator/app/src/main';
const ANDROID = 'android';
const NATIVE = '../native-finder';
const dst = ANDROID + '/app/src/main';

function die(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}
function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!fs.existsSync(TA + '/java/com/taskautomator')) die('Task Automator sources not found in ' + TA);

// the app's package (it owns R)
const gradlePath = ANDROID + '/app/build.gradle';
let gradle = fs.readFileSync(gradlePath, 'utf8');
const ns = (gradle.match(/namespace\s*=?\s*['"]([^'"]+)['"]/) || [])[1];
if (!ns) die('Could not find the app namespace in app/build.gradle');

// 1) Java: copy, point R at this app, prefix layout names
const javaDst = dst + '/java/com/taskautomator';
fs.mkdirSync(javaDst, { recursive: true });
for (const f of fs.readdirSync(TA + '/java/com/taskautomator')) {
  if (!f.endsWith('.java')) continue;
  let text = fs.readFileSync(TA + '/java/com/taskautomator/' + f, 'utf8');
  text = text.replace(/^(package com\.taskautomator;)/m, '$1\n\nimport ' + ns + '.R;');
  text = text.replace(/R\.layout\.(\w+)/g, 'R.layout.ta_$1');
  // keep the automator screens inside the status bar and above the keyboard, like they were in their own app
  text = text.replace(/(setContentView\(R\.layout\.ta_\w+\);)/g, '$1\n        TaInsets.apply(this);');
  fs.writeFileSync(javaDst + '/' + f, text);
}

// 1b) the small helper that does it
fs.writeFileSync(
  javaDst + '/TaInsets.java',
  [
    'package com.taskautomator;',
    '',
    'import android.app.Activity;',
    'import android.view.View;',
    'import androidx.core.graphics.Insets;',
    'import androidx.core.view.ViewCompat;',
    'import androidx.core.view.WindowInsetsCompat;',
    '',
    '/** Newer Android draws apps under the status bar and keyboard. This puts the automator screens back where they were. */',
    'public class TaInsets {',
    '    public static void apply(Activity a) {',
    '        final View root = a.findViewById(android.R.id.content);',
    '        if (root == null) return;',
    '        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {',
    '            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());',
    '            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);',
    '            return WindowInsetsCompat.CONSUMED;',
    '        });',
    '        ViewCompat.requestApplyInsets(root);',
    '    }',
    '}',
    '',
  ].join('\n')
);

// 2) our bridge
for (const f of ['TaskAutomatorModule.java', 'TaskAutomatorPackage.java']) {
  fs.copyFileSync(NATIVE + '/' + f, javaDst + '/' + f);
}

// 3) layouts, renamed with a ta_ prefix so nothing clashes
fs.mkdirSync(dst + '/res/layout', { recursive: true });
for (const f of fs.readdirSync(TA + '/res/layout')) {
  fs.copyFileSync(TA + '/res/layout/' + f, dst + '/res/layout/ta_' + f);
}

// 4) colors + theme, and the file paths used on old phones
fs.mkdirSync(dst + '/res/values', { recursive: true });
fs.copyFileSync(TA + '/res/values/themes.xml', dst + '/res/values/ta_themes.xml');
fs.mkdirSync(dst + '/res/xml', { recursive: true });
fs.writeFileSync(
  dst + '/res/xml/ta_file_paths.xml',
  '<?xml version="1.0" encoding="utf-8"?>\n<paths>\n    <external-path name="downloads" path="Download/"/>\n</paths>\n'
);

// 5) manifest: the four automator screens, the old-phone storage permission, the file provider
const mfPath = dst + '/AndroidManifest.xml';
let mf = fs.readFileSync(mfPath, 'utf8');
if (mf.indexOf('com.taskautomator.BrowserActivity') < 0) {
  if (mf.indexOf('</application>') < 0) die('AndroidManifest.xml has no </application>');
  let add =
    '\n        <activity android:name="com.taskautomator.MainActivity" android:theme="@style/Theme.TaskAutomator" android:exported="false"/>' +
    '\n        <activity android:name="com.taskautomator.ProjectActivity" android:theme="@style/Theme.TaskAutomator" android:exported="false"/>' +
    '\n        <activity android:name="com.taskautomator.DownloadsActivity" android:theme="@style/Theme.TaskAutomator" android:exported="false"/>' +
    '\n        <activity android:name="com.taskautomator.BrowserActivity" android:theme="@style/Theme.TaskAutomator" android:exported="false"' +
    ' android:windowSoftInputMode="adjustResize"' +
    ' android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize"/>';
  if (mf.indexOf('.fileprovider') < 0) {
    add +=
      '\n        <provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider"' +
      ' android:exported="false" android:grantUriPermissions="true">' +
      '\n            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/ta_file_paths"/>' +
      '\n        </provider>';
  }
  mf = mf.replace('</application>', () => add + '\n    </application>');
  const perms = [];
  if (mf.indexOf('android.permission.INTERNET') < 0) perms.push('<uses-permission android:name="android.permission.INTERNET"/>');
  if (mf.indexOf('android.permission.ACCESS_NETWORK_STATE') < 0) perms.push('<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>');
  if (mf.indexOf('WRITE_EXTERNAL_STORAGE') < 0) {
    perms.push('<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/>');
  }
  if (perms.length > 0) mf = mf.replace('<application', () => perms.join('\n    ') + '\n    <application');
  fs.writeFileSync(mfPath, mf);
}

// 6) Gradle: libraries the automator screens need
if (gradle.indexOf('androidx.recyclerview') < 0) {
  const re = /^dependencies\s*\{/m;
  if (!re.test(gradle)) die('could not find the dependencies block in app/build.gradle');
  gradle = gradle.replace(
    re,
    "dependencies {\n    implementation 'com.google.android.material:material:1.11.0'\n    implementation 'androidx.recyclerview:recyclerview:1.3.2'\n    implementation 'androidx.appcompat:appcompat:1.6.1'"
  );
  fs.writeFileSync(gradlePath, gradle);
}

// 7) register the bridge in the app
const mainApp = walk(dst + '/java', []).find((p) => /MainApplication\.(kt|java)$/.test(p));
if (!mainApp) die('MainApplication not found');
let ma = fs.readFileSync(mainApp, 'utf8');
if (ma.indexOf('TaskAutomatorPackage') < 0) {
  const anchor = 'PackageList(this).packages.apply {';
  if (ma.indexOf(anchor) < 0) die('Could not find the package list in MainApplication');
  ma = ma.replace(anchor, () => anchor + '\n              add(com.taskautomator.TaskAutomatorPackage())');
  fs.writeFileSync(mainApp, ma);
}
console.log('Task Automator linked into the app (package ' + ns + ')');
