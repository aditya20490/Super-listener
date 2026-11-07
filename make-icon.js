// Runs during the build: turns your picture (icon.jpg in this repo) into the app icon.
// Usage: node make-icon.js <your picture> <the app's assets folder>
// It makes three files:
//  - icon.png            the normal square icon
//  - adaptive-icon.png   your picture in the middle (so phones that crop icons into circles do not cut it off)
//  - adaptive-bg.png     a blurred copy of your picture behind it, so there is no empty frame
const fs = require('fs');
const sharp = require('sharp');

const input = process.argv[2];
const outDir = process.argv[3];
if (!input || !outDir || !fs.existsSync(input)) {
  console.error('Usage: node make-icon.js <picture> <assets folder> (picture not found)');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const SIZE = 1024;

(async () => {
  // .rotate() follows the photo's own orientation, so a phone photo is not turned sideways
  const base = await sharp(input).rotate().toBuffer();

  await sharp(base).resize(SIZE, SIZE, { fit: 'cover', position: 'centre' }).flatten({ background: '#000000' }).png().toFile(outDir + '/icon.png');

  const inner = Math.round(SIZE * 0.62);
  const fg = await sharp(base).resize(inner, inner, { fit: 'cover', position: 'centre' }).flatten({ background: '#000000' }).png().toBuffer();
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fg, gravity: 'centre' }])
    .png()
    .toFile(outDir + '/adaptive-icon.png');

  // written last: the build only uses the new icon when this file exists
  await sharp(base).resize(SIZE, SIZE, { fit: 'cover', position: 'centre' }).flatten({ background: '#000000' }).blur(30).png().toFile(outDir + '/adaptive-bg.png');

  console.log('App icon made from ' + input);
})().catch((e) => {
  console.error('Could not make the icon:', e && e.message ? e.message : e);
  process.exit(1);
});
