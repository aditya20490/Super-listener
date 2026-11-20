// Runs during the build (called from the workflow's add_native step, inside musicapp/, after "expo prebuild").
// Adds the offline voice engine for the Text to Speech screen:
//  - sherpa-onnx (the library that runs AI voice models on the phone), as an .aar from its GitHub release
//  - the Kokoro voice model, packed inside the app (assets/kokoro-multi-lang-v1_0)
//  - native-tts/TtsModule.kt, registered in MainApplication
// If anything here fails, it stops BEFORE touching the app (or touches only harmless extras) and the workflow
// carries on and builds the app without voices. Set SKIP_TTS=1 to skip it on purpose.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (process.env.SKIP_TTS) {
  console.log('Text to Speech: skipped on purpose (SKIP_TTS is set)');
  process.exit(0);
}

const SHERPA = '1.13.7';
const AAR_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v' + SHERPA + '/sherpa-onnx-' + SHERPA + '.aar';
const MODEL_NAME = 'kokoro-multi-lang-v1_0';
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/' + MODEL_NAME + '.tar.bz2';

const CACHE = path.resolve('../tts-cache');
const dst = 'android/app/src/main';

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}
function die(msg) {
  console.error('Text to Speech ERROR: ' + msg);
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
function fetchTo(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000000) return;
  sh('curl -L --fail --retry 4 --retry-delay 5 -o "' + file + '.part" "' + url + '"');
  fs.renameSync(file + '.part', file);
}

try {
  fs.mkdirSync(CACHE, { recursive: true });

  // 1) downloads (kept in tts-cache, which the workflow caches between builds)
  const aar = CACHE + '/sherpa-onnx-' + SHERPA + '.aar';
  console.log('Text to Speech: getting the voice library');
  fetchTo(AAR_URL, aar);

  const modelFolder = CACHE + '/' + MODEL_NAME;
  if (!fs.existsSync(modelFolder + '/model.onnx')) {
    const tar = CACHE + '/' + MODEL_NAME + '.tar.bz2';
    console.log('Text to Speech: getting the Kokoro voice model (a big file, this can take a minute)');
    fetchTo(MODEL_URL, tar);
    sh('tar -xjf "' + tar + '" -C "' + CACHE + '"');
    fs.unlinkSync(tar);
  }
  for (const f of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt']) {
    if (!fs.existsSync(modelFolder + '/' + f)) die('the voice model is missing ' + f);
  }
  if (fs.statSync(modelFolder + '/model.onnx').size < 100000000) die('model.onnx looks too small, the download is broken');
  if (!fs.existsSync(modelFolder + '/espeak-ng-data')) die('the voice model is missing espeak-ng-data');

  // 2) the library, into the app (only the phone's own chip type, the others would just make the app bigger)
  fs.mkdirSync('android/app/libs', { recursive: true });
  fs.copyFileSync(aar, 'android/app/libs/sherpa-onnx.aar');
  try {
    sh('zip -q -d android/app/libs/sherpa-onnx.aar "jni/x86/*" "jni/x86_64/*" "jni/armeabi-v7a/*"');
  } catch (e) {
    console.log('Text to Speech: could not trim the library (fine, the app is just a bit bigger)');
  }

  // 3) the voice model, packed inside the app
  fs.mkdirSync(dst + '/assets', { recursive: true });
  fs.cpSync(modelFolder, dst + '/assets/' + MODEL_NAME, { recursive: true });

  // 4) Gradle: use the library
  const gradlePath = 'android/app/build.gradle';
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  if (gradle.indexOf('libs/sherpa-onnx.aar') < 0) {
    const re = /^dependencies\s*\{/m;
    if (!re.test(gradle)) die('could not find the dependencies block in app/build.gradle');
    gradle = gradle.replace(re, () => "dependencies {\n    implementation files('libs/sherpa-onnx.aar')");
    fs.writeFileSync(gradlePath, gradle);
  }

  // 5) our native piece (last, so a failure above never leaves code that needs the library without it)
  const K = dst + '/java/com/mymusic/player';
  fs.mkdirSync(K, { recursive: true });
  fs.copyFileSync('../native-tts/TtsModule.kt', K + '/TtsModule.kt');

  const mainApp = walk(dst + '/java', []).find((p) => /MainApplication\.(kt|java)$/.test(p));
  if (!mainApp) die('MainApplication not found');
  let ma = fs.readFileSync(mainApp, 'utf8');
  if (ma.indexOf('TtsPackage') < 0) {
    const anchor = 'PackageList(this).packages.apply {';
    if (ma.indexOf(anchor) < 0) die('Could not find the package list in MainApplication');
    ma = ma.replace(anchor, () => anchor + '\n              add(com.mymusic.player.TtsPackage())');
    fs.writeFileSync(mainApp, ma);
  }
  console.log('Text to Speech: Kokoro voices linked into the app');
} catch (e) {
  die(e && e.message ? e.message : String(e));
}
