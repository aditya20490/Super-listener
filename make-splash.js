// Runs during the build, inside the app project (musicapp/), before the app is built.
// It makes two small picture files in musicapp/assets:
//  - splash-blank.png : a completely see-through picture. The phone's own splash screen uses it, so that screen is just plain black.
//  - splash-logo.png  : a copy of your app-icon picture (the white symbol on black). The app fades it in itself right after.
// If there is no app-icon picture in the repo, the logo is see-through too, so the splash is simply plain black.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function blankPng(size) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // 8 bits per colour
  head[9] = 6; // colour + see-through
  const raw = Buffer.alloc(size * (size * 4 + 1)); // all zeros = every pixel see-through
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/splash-blank.png', blankPng(1024));

const rootDir = path.resolve('..');
const names = ['app-icon.png', 'app-icon.jpg', 'app-icon.jpeg', 'icon.png', 'icon.jpg', 'icon.jpeg'];
const have = fs.readdirSync(rootDir);
let file = null;
for (const n of names) {
  const hit = have.find((x) => x.toLowerCase() === n);
  if (hit) {
    file = path.join(rootDir, hit);
    break;
  }
}
if (file) {
  fs.copyFileSync(file, 'assets/splash-logo.png');
  console.log('Splash: logo = ' + path.basename(file));
} else {
  fs.writeFileSync('assets/splash-logo.png', blankPng(16));
  console.log('Splash: no app-icon picture found, so the splash is plain black.');
}
