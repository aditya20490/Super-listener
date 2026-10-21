// Runs during the build on src/tools/Tools.js:
//  - shares a few of its pieces with the other screens
//  - adds the "Island setup" and "MKA bundles" rows to the + menu
const fs = require('fs');
const p = 'src/tools/Tools.js';
let s = fs.readFileSync(p, 'utf8');

for (const name of ['useAppTheme', 'Btn', 'Screen', 'SongPicker']) {
  const a = '\nfunction ' + name + '(';
  if (s.indexOf(a) >= 0) s = s.replace(a, '\nexport function ' + name + '(');
}

const key = "{row('pricetags', 'Tag editor'";
if (s.indexOf(key) < 0) {
  console.error('Could not find the Tag editor row in src/tools/Tools.js');
  process.exit(1);
}

if (s.indexOf('Island setup') < 0) {
  const add =
    "{row('sparkles', 'Island setup', () => {\n" +
    '              setMenu(false);\n' +
    "              require('react-native').DeviceEventEmitter.emit('openIslandSetup');\n" +
    '            })}\n            ';
  s = s.replace(key, () => add + key);
}

if (s.indexOf('MKA bundles') < 0) {
  const add =
    "{row('albums', 'MKA bundles', () => {\n" +
    '              setMenu(false);\n' +
    "              require('react-native').DeviceEventEmitter.emit('openMka');\n" +
    '            })}\n            ';
  s = s.replace(key, () => add + key);
}

fs.writeFileSync(p, s);
console.log('Tools menu patched');
