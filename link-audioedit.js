// Runs during the build (called from link-persist.js, inside musicapp/): adds the audio editor's native engine
// (decoding, loop finder, edits, playback, WAV saving) to the Android project and registers it in the app.
const fs = require('fs');
const path = require('path');

const dst = 'android/app/src/main';
const javaDst = dst + '/java/com/musicplus/audioedit';
fs.mkdirSync(javaDst, { recursive: true });
const srcDir = '../native-audioedit';
let count = 0;
for (const f of fs.readdirSync(srcDir)) {
  if (!f.endsWith('.java')) continue;
  fs.copyFileSync(srcDir + '/' + f, javaDst + '/' + f);
  count++;
}
if (count < 5) {
  console.error('ERROR: the audio editor files are missing in ' + srcDir);
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

// register the package
const mainApp = walk(dst + '/java', []).find((p) => /MainApplication\.(kt|java)$/.test(p));
if (!mainApp) {
  console.error('ERROR: MainApplication not found');
  process.exit(1);
}
let ma = fs.readFileSync(mainApp, 'utf8');
if (ma.indexOf('AudioEditorPackage') < 0) {
  const anchor = 'PackageList(this).packages.apply {';
  if (ma.indexOf(anchor) < 0) {
    console.error('ERROR: Could not find the package list in MainApplication');
    process.exit(1);
  }
  ma = ma.replace(anchor, () => anchor + '\n              add(com.musicplus.audioedit.AudioEditorPackage())');
  fs.writeFileSync(mainApp, ma);
}

// a song held in memory as raw audio can be big, so the app asks Android for the larger memory limit
const mfPath = dst + '/AndroidManifest.xml';
let mf = fs.readFileSync(mfPath, 'utf8');
if (mf.indexOf('android:largeHeap') < 0) {
  mf = mf.replace('<application', () => '<application android:largeHeap="true"');
  fs.writeFileSync(mfPath, mf);
}
console.log('Audio editor engine linked into the app');

// the app icon: your own picture app-icon.jpg in the main folder of the repo, if there is one
require('./link-icon.js');
