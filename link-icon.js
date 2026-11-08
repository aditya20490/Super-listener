// Runs during the build (called from link-audioedit.js, inside musicapp/, after "expo prebuild").
// If you put your own picture in the main folder of the Super-listener repo as app-icon.jpg (or .jpeg / .png),
// it becomes the app icon: the normal icon, the round icon and the adaptive icon of newer phones.
// With no picture there, the default icon stays.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const rootDir = path.resolve('..');
const names = ['app-icon.jpg', 'app-icon.jpeg', 'app-icon.png', 'icon.jpg', 'icon.jpeg', 'icon.png'];
let file = null;
const have = fs.readdirSync(rootDir);
for (const n of names) {
  const hit = have.find((x) => x.toLowerCase() === n);
  if (hit) {
    file = path.join(rootDir, hit);
    break;
  }
}
if (!file) {
  console.log('No app-icon.jpg in the repo, keeping the default app icon.');
  return;
}

function loadSharp() {
  try {
    return require('sharp');
  } catch (e) {}
  const dir = '/tmp/icon-tools';
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir + '/package.json')) fs.writeFileSync(dir + '/package.json', '{"name":"icon-tools","version":"1.0.0"}');
  cp.execSync('npm install --no-audit --no-fund sharp', { cwd: dir, stdio: 'inherit' });
  return require(dir + '/node_modules/sharp');
}

(async () => {
  try {
    const sharp = loadSharp();
    const res = 'android/app/src/main/res';
    if (!fs.existsSync(res)) throw new Error('res folder not found');

    // the picture as a square (cropped from the middle)
    const base = await sharp(file).rotate().resize(1024, 1024, { fit: 'cover' }).png().toBuffer();

    // the colour around the edge of the picture, used behind it on newer phones
    const small = await sharp(base).resize(16, 16).raw().toBuffer({ resolveWithObject: true });
    const ch = small.info.channels;
    let r = 0, g = 0, b = 0, cnt = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (x !== 0 && y !== 0 && x !== 15 && y !== 15) continue;
        const i = (y * 16 + x) * ch;
        r += small.data[i];
        g += small.data[i + 1];
        b += small.data[i + 2];
        cnt++;
      }
    }
    const hex = '#' + [r, g, b].map((v) => Math.round(v / cnt).toString(16).padStart(2, '0')).join('');

    const scale = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    let written = 0;
    for (const dir of fs.readdirSync(res)) {
      const m = dir.match(/^mipmap-(ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)$/);
      if (!m) continue;
      const sc = scale[m[1]];
      for (const f of fs.readdirSync(res + '/' + dir)) {
        const mm = f.match(/^(ic_launcher|ic_launcher_round|ic_launcher_foreground)\.(webp|png)$/);
        if (!mm) continue;
        const kind = mm[1];
        const ext = mm[2];
        let img;
        if (kind === 'ic_launcher_foreground') {
          const size = Math.round(108 * sc);
          const inner = Math.round(size * 0.66);
          const pic = await sharp(base).resize(inner, inner).png().toBuffer();
          img = sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([
            { input: pic, left: Math.round((size - inner) / 2), top: Math.round((size - inner) / 2) },
          ]);
        } else {
          const size = Math.round(48 * sc);
          img = sharp(base).resize(size, size);
          if (kind === 'ic_launcher_round') {
            const mask = Buffer.from('<svg width="' + size + '" height="' + size + '"><circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + size / 2 + '"/></svg>');
            img = sharp(await img.png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]);
          }
        }
        const out = ext === 'webp' ? await img.webp({ quality: 95 }).toBuffer() : await img.png().toBuffer();
        fs.writeFileSync(res + '/' + dir + '/' + f, out);
        written++;
      }
    }
    const colors = res + '/values/colors.xml';
    if (fs.existsSync(colors)) {
      let x = fs.readFileSync(colors, 'utf8');
      if (/name="iconBackground"/.test(x)) x = x.replace(/(<color name="iconBackground">)[^<]*(<\/color>)/, '$1' + hex + '$2');
      else x = x.replace('</resources>', '    <color name="iconBackground">' + hex + '</color>\n</resources>');
      fs.writeFileSync(colors, x);
    }
    console.log('App icon replaced with ' + path.basename(file) + ' (' + written + ' files, background ' + hex + ')');
  } catch (e) {
    // a problem with the picture must never stop the app from building
    console.log('Could not use the app icon picture (' + (e && e.message ? e.message : e) + '). Keeping the default icon.');
  }
})();
