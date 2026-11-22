// Adds the Karaoke native code to the Android project. Runs inside the app project folder (musicapp/), after link-studio.js.
// It is skipped when the studio apps are skipped (karaoke uses the Vocal Splitter's engine) or when SKIP_KARAOKE=1.
// It never stops the build by itself: if something is not as expected it prints a warning and adds nothing.
const fs = require('fs');
const path = require('path');

if (process.env.SKIP_KARAOKE || process.env.SKIP_STUDIO) {
  console.log('Karaoke: skipped (SKIP_KARAOKE / SKIP_STUDIO)');
  process.exit(0);
}

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

try {
  const SRC = path.resolve('../native-karaoke');
  const main = 'android/app/src/main';
  const javaRoot = main + '/java';
  const K = javaRoot + '/com/mymusic/player';
  const need = [
    javaRoot + '/com/vocalsplitter/app/MdxSeparator.kt',
    javaRoot + '/com/vocalsplitter/app/AudioDecoder.kt',
    javaRoot + '/com/vocalsplitter/app/SeparationState.kt',
    main + '/AndroidManifest.xml',
  ];
  for (const f of need) if (!fs.existsSync(f)) throw new Error('missing ' + f + ' (the Vocal Splitter is not linked)');
  if (!fs.existsSync(SRC)) throw new Error('native-karaoke folder not found');

  const mainApp = walk(javaRoot, []).find((p) => /MainApplication\.(kt|java)$/.test(p));
  if (!mainApp) throw new Error('MainApplication not found');
  let ma = fs.readFileSync(mainApp, 'utf8');
  const anchor = 'PackageList(this).packages.apply {';
  if (ma.indexOf(anchor) < 0) throw new Error('could not find the package list in MainApplication');

  let mf = fs.readFileSync(main + '/AndroidManifest.xml', 'utf8');
  if (mf.indexOf('</application>') < 0) throw new Error('no </application> in the manifest');

  // everything checked: now write
  fs.mkdirSync(K, { recursive: true });
  for (const f of fs.readdirSync(SRC)) if (f.endsWith('.kt')) fs.copyFileSync(path.join(SRC, f), path.join(K, f));
  if (ma.indexOf('KaraokePackage') < 0) {
    ma = ma.replace(anchor, () => anchor + '\n              add(com.mymusic.player.KaraokePackage())');
    fs.writeFileSync(mainApp, ma);
  }
  if (mf.indexOf('com.mymusic.player.KaraokeService') < 0) {
    const svc = '    <service android:name="com.mymusic.player.KaraokeService" android:exported="false" android:foregroundServiceType="dataSync" />\n';
    mf = mf.replace('</application>', () => svc + '  </application>');
    for (const p of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.WAKE_LOCK']) {
      if (mf.indexOf('"' + p + '"') < 0) mf = mf.replace('<application', () => '<uses-permission android:name="' + p + '"/>\n  <application');
    }
    fs.writeFileSync(main + '/AndroidManifest.xml', mf);
  }
  console.log('Karaoke: native code linked');
} catch (e) {
  console.log('WARNING: Karaoke not linked (' + (e && e.message ? e.message : e) + ')');
}
process.exit(0);
