// Runs during the build (called from link-finder.js, inside musicapp/): adds the small native piece that keeps
// the listening-history file in Android/media/<package>/MusicPlus/ and registers it in the app.
const fs = require('fs');
const path = require('path');

const dst = 'android/app/src/main';
const javaDst = dst + '/java/com/musicplus/persist';
fs.mkdirSync(javaDst, { recursive: true });
for (const f of ['PersistentStoreModule.java', 'PersistentStorePackage.java']) {
  fs.copyFileSync('../native-persist/' + f, javaDst + '/' + f);
}

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const mainApp = walk(dst + '/java', []).find((p) => /MainApplication\.(kt|java)$/.test(p));
if (!mainApp) {
  console.error('ERROR: MainApplication not found');
  process.exit(1);
}
let ma = fs.readFileSync(mainApp, 'utf8');
if (ma.indexOf('PersistentStorePackage') < 0) {
  const anchor = 'PackageList(this).packages.apply {';
  if (ma.indexOf(anchor) < 0) {
    console.error('ERROR: Could not find the package list in MainApplication');
    process.exit(1);
  }
  ma = ma.replace(anchor, () => anchor + '\n              add(com.musicplus.persist.PersistentStorePackage())');
  fs.writeFileSync(mainApp, ma);
}
console.log('History backup storage linked into the app');

// the audio editor's native engine is linked the same way
require('./link-audioedit.js');
