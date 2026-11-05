// Runs during the build: packs the two things the player needs from your Music Finder repo
// (the recorded download steps and the country list) into one JS file. Music Finder itself is not changed.
const fs = require('fs');
const dir = 'old-finder/www/';
const task = fs.readFileSync(dir + 'task/apple-music.task.json', 'utf8');
const html = fs.readFileSync(dir + 'index.html', 'utf8');
const m = html.match(/const COUNTRY_LIST = "([^"]+)"/);
if (!m) {
  console.error('Could not find COUNTRY_LIST in the Music Finder index.html');
  process.exit(1);
}
fs.mkdirSync('src/tools', { recursive: true });
fs.writeFileSync(
  'src/tools/finderData.js',
  'export const TASK = ' + JSON.stringify(task) + ';\nexport const COUNTRY_LIST = ' + JSON.stringify(m[1]) + ';\n'
);
console.log('Music Finder data packed: task', task.length, 'chars, countries', m[1].split('|').length);
