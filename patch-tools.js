// Adds the "Island setup" row to the + menu during the build.
const fs = require('fs');
const p = 'src/tools/Tools.js';
let s = fs.readFileSync(p, 'utf8');
if (s.indexOf('Island setup') >= 0) {
  console.log('Tools menu already has the Island row');
  process.exit(0);
}
const key = "{row('pricetags', 'Tag editor'";
if (s.indexOf(key) < 0) {
  console.error('Could not find the Tag editor row in src/tools/Tools.js');
  process.exit(1);
}
const add =
  "{row('sparkles', 'Island setup', () => {\n" +
  '              setMenu(false);\n' +
  "              require('react-native').DeviceEventEmitter.emit('openIslandSetup');\n" +
  '            })}\n            ';
s = s.replace(key, () => add + key);
fs.writeFileSync(p, s);
console.log('Added the Island row to the Tools menu');
