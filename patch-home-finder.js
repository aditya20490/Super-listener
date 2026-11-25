// Runs during the build (after patch-karaoke.js), before the app is created. It edits only the build's own copy of the
// music app (old-music/App.js): when you search on the Home Screen and NOTHING on the phone matches, the lists show the
// online Music Finder songs (src/tools/HomeFinder.js) instead of "Nothing matches your search."
//  - Found on the phone: nothing changes, the normal local results show.
//  - Not found on the phone: the online results appear by themselves, with Preview, Copy link and Download on each song.
// ALL-OR-NOTHING: if any spot cannot be found (the music app changed), nothing is edited and the build goes on without this
// feature. It never stops the build. Your my-music-app repo is not changed.
const fs = require('fs');

const FILE = 'old-music/App.js';

// step: [marker (already done if present), anchor, text, mode]  mode: after | before | replace
function run(text, file, steps) {
  let s = text;
  for (const [done, anchor, add, mode] of steps) {
    if (s.indexOf(done) >= 0) continue;
    const i = s.indexOf(anchor);
    if (i < 0) throw new Error('cannot find in ' + file + ': ' + anchor.split('\n')[0].trim());
    if (s.indexOf(anchor, i + 1) >= 0) throw new Error('found twice in ' + file + ': ' + anchor.split('\n')[0].trim());
    if (mode === 'before') s = s.replace(anchor, () => add + anchor);
    else if (mode === 'replace') s = s.replace(anchor, () => add);
    else s = s.replace(anchor, () => anchor + add);
  }
  return s;
}

const STEPS = [
  // the online results component
  ['import HomeFinder', "import { MixTile, ForYouHeader } from './src/foryou/ForYouUI';", "\nimport HomeFinder from './src/tools/HomeFinder';", 'after'],

  // Songs, Favorites, Albums and Artists tabs: the "nothing found" block becomes the online results when no song on the phone matches.
  // "No song matches" is worked out on ALL your songs (not only the tab you are on), so a favourites tab that is empty
  // because the song just is not a favourite still says "Nothing matches your search."
  [
    'const onlineSearch =',
    '  const emptyBlock = (\n',
    '  // Something is typed and not one song on the phone matches it: show the online Music Finder songs\n' +
      '  const onlineSearch = query.trim() !== \'\' && songs.length > 0 && filtered.length === 0;\n\n' +
      '  const emptyBlock = onlineSearch ? (\n' +
      '    <HomeFinder query={query} />\n' +
      '  ) : (\n',
    'replace',
  ],

  // For You tab: same thing
  ['const forYouEmpty = onlineSearch ?', '  const forYouEmpty = (\n', '  const forYouEmpty = onlineSearch ? (\n    <HomeFinder query={query} />\n  ) : (\n', 'replace'],
];

try {
  if (!fs.existsSync(FILE)) throw new Error('the music app file is not there');
  if (!fs.existsSync('src/tools/HomeFinder.js') || !fs.existsSync('src/tools/finderCore.js')) throw new Error('HomeFinder.js / finderCore.js are missing');
  const out = run(fs.readFileSync(FILE, 'utf8'), FILE, STEPS);
  fs.writeFileSync(FILE, out);
  console.log('Home Screen: songs that are not on the phone now show the online Music Finder results');
} catch (e) {
  console.log('WARNING: Home Screen online results not added, building without them (' + (e && e.message ? e.message : e) + ')');
}
process.exit(0);
