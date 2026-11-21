// Runs during the build (called from the workflow's add_native step, inside musicapp/, after "expo prebuild").
// Puts your two finished apps INSIDE Music Plus:
//   - Vocal Splitter  (repo VocalSplitter, package com.vocalsplitter.app)
//   - Voice Cloner    (repo voice-studio,  package com.voicestudio.app)
// Their engine files are copied over exactly as they are in your own repos (nothing is edited).
// The ONLY files that are replaced are the screens (the outer look): native-studio/splitter/MainActivity.kt,
// native-studio/voice/MainActivity.kt and native-studio/voice/SpeakTab.kt, so they use the Music Plus theme.
// If anything here fails, it stops with an error and the workflow builds Music Plus without these two apps.
// Set SKIP_STUDIO=1 to skip it on purpose.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (process.env.SKIP_STUDIO) {
  console.log('Studio apps: skipped on purpose (SKIP_STUDIO is set)');
  process.exit(0);
}

const SPLITTER_SRC = '../old-splitter/app/src/main/java/com/vocalsplitter/app';
const VOICE_SRC = '../old-voice/app/src/main/java/com/voicestudio/app';
const NATIVE = '../native-studio';
const CACHE = path.resolve('../studio-cache');
const MODEL_FILE = 'UVR-MDX-NET-Voc_FT.onnx';
const MODEL_URL = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/' + MODEL_FILE;
const dst = 'android/app/src/main';

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}
function die(msg) {
  console.error('Studio apps ERROR: ' + msg);
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
function cmp(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

try {
  for (const d of [SPLITTER_SRC, VOICE_SRC, NATIVE, NATIVE + '/splitter', NATIVE + '/voice']) {
    if (!fs.existsSync(d)) die('missing folder ' + d);
  }

  // 1) the two apps' code: engines exactly as they are, only the screens come from native-studio
  function copyApp(srcDir, outDir, replaceDir, replaced) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith('.kt') || replaced.indexOf(f) >= 0) continue;
      fs.copyFileSync(srcDir + '/' + f, outDir + '/' + f);
    }
    for (const f of replaced) {
      if (!fs.existsSync(srcDir + '/' + f)) die(f + ' is not in ' + srcDir + ' (the original app changed?)');
      if (!fs.existsSync(replaceDir + '/' + f)) die('missing ' + replaceDir + '/' + f);
      fs.copyFileSync(replaceDir + '/' + f, outDir + '/' + f);
    }
  }
  copyApp(SPLITTER_SRC, dst + '/java/com/vocalsplitter/app', NATIVE + '/splitter', ['MainActivity.kt']);
  copyApp(VOICE_SRC, dst + '/java/com/voicestudio/app', NATIVE + '/voice', ['MainActivity.kt', 'SpeakTab.kt']);

  // 2) the Music Plus side: theme helper + the small launcher used by the hamburger menu
  const K = dst + '/java/com/mymusic/player';
  fs.mkdirSync(K, { recursive: true });
  for (const f of ['StudioTheme.kt', 'StudioAppsModule.kt']) fs.copyFileSync(NATIVE + '/' + f, K + '/' + f);

  // 3) Vocal Splitter's separation model (packed inside the app, as in the original app)
  fs.mkdirSync(CACHE, { recursive: true });
  const model = CACHE + '/' + MODEL_FILE;
  if (!fs.existsSync(model) || fs.statSync(model).size < 50000000) {
    console.log('Studio apps: getting the vocal separation model');
    sh('curl -L --fail --retry 5 --retry-delay 5 -o "' + model + '.part" "' + MODEL_URL + '"');
    fs.renameSync(model + '.part', model);
  }
  if (fs.statSync(model).size < 50000000) die('the separation model looks too small, the download is broken');
  fs.mkdirSync(dst + '/assets/models', { recursive: true });
  fs.copyFileSync(model, dst + '/assets/models/' + MODEL_FILE);

  // 4) manifest: permissions, the three entries (two screens + the separation service)
  const mfPath = dst + '/AndroidManifest.xml';
  let mf = fs.readFileSync(mfPath, 'utf8');
  if (mf.indexOf('com.vocalsplitter.app.MainActivity') < 0) {
    const perms = [
      'android.permission.RECORD_AUDIO',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.WAKE_LOCK',
      'android.permission.INTERNET',
    ];
    let add = '';
    for (const p of perms) {
      if (mf.indexOf('"' + p + '"') < 0) add += '  <uses-permission android:name="' + p + '"/>\n';
    }
    if (mf.indexOf('<application') < 0) die('no <application> tag in the manifest');
    mf = mf.replace('<application', () => add + '  <application');
    if (mf.indexOf('android:largeHeap') < 0) mf = mf.replace('<application', () => '<application android:largeHeap="true"');
    const comps =
      '    <activity android:name="com.vocalsplitter.app.MainActivity" android:label="Vocal Splitter" android:exported="false"\n' +
      '        android:theme="@android:style/Theme.DeviceDefault.NoActionBar"\n' +
      '        android:configChanges="orientation|screenSize|keyboardHidden|uiMode" />\n' +
      '    <service android:name="com.vocalsplitter.app.SeparationService" android:exported="false" android:foregroundServiceType="dataSync" />\n' +
      '    <activity android:name="com.voicestudio.app.MainActivity" android:label="Voice Cloner" android:exported="false"\n' +
      '        android:theme="@android:style/Theme.DeviceDefault.NoActionBar"\n' +
      '        android:windowSoftInputMode="adjustResize"\n' +
      '        android:configChanges="orientation|screenSize|keyboardHidden|uiMode" />\n';
    if (mf.indexOf('</application>') < 0) die('no </application> tag in the manifest');
    mf = mf.replace('</application>', () => comps + '  </application>');
    fs.writeFileSync(mfPath, mf);
  }

  // 5) Gradle. The two apps are Jetpack Compose apps, so Music Plus needs the Compose compiler plugin.
  // It must be the same version as the Kotlin that React Native uses.
  let kotlin = null;
  const toml = 'node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml';
  if (fs.existsSync(toml)) {
    const m = fs.readFileSync(toml, 'utf8').match(/^kotlin\s*=\s*"([^"]+)"/m);
    if (m) kotlin = m[1];
  }
  if (!kotlin && fs.existsSync('android/gradle.properties')) {
    const m = fs.readFileSync('android/gradle.properties', 'utf8').match(/kotlinVersion\s*=\s*([0-9][^\s]*)/);
    if (m) kotlin = m[1];
  }
  if (!kotlin) kotlin = '2.1.20';
  console.log('Studio apps: Kotlin version ' + kotlin);

  // ONNX Runtime: both apps use it (Java side). The Text to Speech voices (sherpa-onnx) bring their own copy of the
  // same native library. The two copies can NOT be merged: the voices ask for the exact version stamp (for example
  // "VERS_1.27.1") of the file they were built with. So both copies stay, and the voices' copy is renamed so the
  // two files do not clash.
  const sherpa = 'android/app/libs/sherpa-onnx.aar';
  let sherpaV = null;
  if (fs.existsSync(sherpa)) {
    try {
      const buf = execSync('unzip -p "' + sherpa + '" jni/arm64-v8a/libonnxruntime.so', { maxBuffer: 512 * 1024 * 1024 });
      const text = buf.toString('latin1');
      const re = /\x00(1\.(?:1[5-9]|2\d)\.\d{1,2})\x00/g;
      let m;
      while ((m = re.exec(text))) if (!sherpaV || cmp(m[1], sherpaV) > 0) sherpaV = m[1];
    } catch (e) {
      console.log('Studio apps: could not read the voice library version (' + (e && e.message ? e.message : e) + ')');
    }
    console.log('Studio apps: the voice library carries ONNX Runtime ' + (sherpaV || 'unknown version'));
  }
  function mavenHas(v) {
    try {
      const url = 'https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/' + v + '/onnxruntime-android-' + v + '.aar';
      return execSync('curl -s -o /dev/null -w "%{http_code}" -I -L "' + url + '"').toString().trim() === '200';
    } catch (e) {
      return false;
    }
  }
  // If the exact version the voices carry is not published (for example a patch release), use the closest published
  // one with the same interface: the same minor version first, otherwise the closest one above it.
  function mavenPick(wanted) {
    try {
      const xml = execSync('curl -s -L --max-time 60 https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/maven-metadata.xml', { maxBuffer: 16 * 1024 * 1024 }).toString();
      const list = [];
      const re = /<version>(\d+\.\d+\.\d+)<\/version>/g;
      let m;
      while ((m = re.exec(xml))) list.push(m[1]);
      list.sort(cmp);
      const minor = wanted.split('.').slice(0, 2).join('.');
      const sameMinor = list.filter((v) => v.split('.').slice(0, 2).join('.') === minor);
      if (sameMinor.length) return sameMinor[sameMinor.length - 1];
      const above = list.filter((v) => cmp(v, minor + '.0') >= 0);
      return above.length ? above[0] : null;
    } catch (e) {
      return null;
    }
  }
  // Renames the voices' own ONNX Runtime file to libortsherpa12.so, everywhere it is named inside the voice library's
  // own files (same length on purpose, so nothing else in those files moves).
  function renameVoiceRuntime() {
    const tmp = path.resolve('../studio-sherpa-patch');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const aarAbs = path.resolve(sherpa);
    sh('unzip -q -o "' + aarAbs + '" "jni/arm64-v8a/*" -d "' + tmp + '"');
    const dir = tmp + '/jni/arm64-v8a';
    const OLD = Buffer.from('libonnxruntime.so\0');
    const NEW = Buffer.from('libortsherpa12.so\0');
    if (OLD.length !== NEW.length) throw new Error('internal: the two names must have the same length');
    if (!fs.existsSync(dir + '/libonnxruntime.so')) throw new Error('libonnxruntime.so is not inside the voice library');
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.so')) continue;
      const p = dir + '/' + f;
      const b = fs.readFileSync(p);
      let i = 0;
      while ((i = b.indexOf(OLD, i)) >= 0) {
        NEW.copy(b, i);
        i += OLD.length;
        total++;
      }
      fs.writeFileSync(p, b);
    }
    if (total < 2) throw new Error('could not find the library name inside the voice library files');
    fs.renameSync(dir + '/libonnxruntime.so', dir + '/libortsherpa12.so');
    sh('zip -q -d "' + aarAbs + '" "jni/arm64-v8a/*"');
    sh('cd "' + tmp + '" && zip -q -r -X "' + aarAbs + '" jni');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  let ort = '1.22.0'; // the newest of the two apps' own versions (Voice Cloner uses 1.22.0, Vocal Splitter 1.19.2)
  if (fs.existsSync(sherpa)) {
    if (sherpaV && cmp(sherpaV, ort) > 0) {
      if (mavenHas(sherpaV)) {
        ort = sherpaV;
      } else {
        const alt = mavenPick(sherpaV);
        if (!alt) die('ONNX Runtime ' + sherpaV + ' (needed by the voices) was not found, and no close version could be found either');
        console.log('Studio apps: ONNX Runtime ' + sherpaV + ' is not published, using the closest one: ' + alt);
        ort = alt;
      }
    } else if (!sherpaV && mavenHas('1.23.2')) {
      ort = '1.23.2';
    }
    if (sherpaV && cmp(ort, sherpaV.split('.').slice(0, 2).join('.') + '.0') < 0) die('the app ONNX Runtime is older than the voice library one');
    try {
      renameVoiceRuntime();
      console.log('Studio apps: the voice library keeps its own ONNX Runtime (renamed to libortsherpa12.so), the two apps use ONNX Runtime ' + ort);
    } catch (e) {
      die('could not prepare the voice library: ' + (e && e.message ? e.message : e));
    }
  }
  console.log('Studio apps: ONNX Runtime ' + ort);

  // root build.gradle: the Compose compiler plugin
  const rootPath = 'android/build.gradle';
  let root = fs.readFileSync(rootPath, 'utf8');
  if (root.indexOf('compose-compiler-gradle-plugin') < 0) {
    const re = /^([ \t]*)classpath\(['"]org\.jetbrains\.kotlin:kotlin-gradle-plugin[^\n]*\n/m;
    if (!re.test(root)) die('could not find the Kotlin plugin line in android/build.gradle');
    root = root.replace(re, (line, ind) => line + ind + "classpath('org.jetbrains.kotlin:compose-compiler-gradle-plugin:" + kotlin + "')\n");
    fs.writeFileSync(rootPath, root);
  }

  // app/build.gradle: plugin, libraries, and the extra settings
  const gradlePath = 'android/app/build.gradle';
  let g = fs.readFileSync(gradlePath, 'utf8');
  if (g.indexOf('studio-apps') < 0) {
    const pluginRe = /^apply plugin:\s*["']org\.jetbrains\.kotlin\.android["'][^\n]*$/m;
    if (pluginRe.test(g)) {
      g = g.replace(pluginRe, (m) => m + '\napply plugin: "org.jetbrains.kotlin.plugin.compose" // studio-apps');
    } else {
      g += '\napply plugin: "org.jetbrains.kotlin.plugin.compose" // studio-apps\n';
    }
    const depRe = /^dependencies\s*\{/m;
    if (!depRe.test(g)) die('could not find the dependencies block in app/build.gradle');
    g = g.replace(
      depRe,
      (m) =>
        m +
        '\n    // studio-apps: Jetpack Compose + ONNX Runtime for Vocal Splitter and Voice Cloner' +
        "\n    implementation(platform('androidx.compose:compose-bom:2024.09.03'))" +
        "\n    implementation('androidx.compose.ui:ui')" +
        "\n    implementation('androidx.compose.foundation:foundation')" +
        "\n    implementation('androidx.compose.material3:material3')" +
        "\n    implementation('androidx.compose.material:material-icons-core')" +
        "\n    implementation('androidx.activity:activity-compose:1.9.2')" +
        "\n    implementation('org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1')" +
        "\n    implementation('com.microsoft.onnxruntime:onnxruntime-android:" + ort + "')"
    );
    g +=
      '\n// studio-apps: Compose on, the separation model must stay uncompressed (the app reads it straight from the APK)\n' +
      'android {\n' +
      '    buildFeatures {\n' +
      '        compose true\n' +
      '    }\n' +
      '    androidResources {\n' +
      "        noCompress 'onnx'\n" +
      '    }\n' +
      '    packaging {\n' +
      '        jniLibs {\n' +
      "            pickFirsts.add('**/libonnxruntime.so')\n" +
      "            pickFirsts.add('**/libonnxruntime4j_jni.so')\n" +
      '        }\n' +
      '    }\n' +
      '}\n';
    fs.writeFileSync(gradlePath, g);
  }

  // 6) register the launcher in the app (same way the other native pieces are registered)
  const mainApp = walk(dst + '/java', []).find((p) => /MainApplication\.(kt|java)$/.test(p));
  if (!mainApp) die('MainApplication not found');
  let ma = fs.readFileSync(mainApp, 'utf8');
  if (ma.indexOf('StudioAppsPackage') < 0) {
    const anchor = 'PackageList(this).packages.apply {';
    if (ma.indexOf(anchor) < 0) die('Could not find the package list in MainApplication');
    ma = ma.replace(anchor, () => anchor + '\n              add(com.mymusic.player.StudioAppsPackage())');
    fs.writeFileSync(mainApp, ma);
  }
  console.log('Studio apps: Vocal Splitter and Voice Cloner linked into the app');
} catch (e) {
  die(e && e.message ? e.message : String(e));
}
