// Runs during the build (after patch-karaoke.js), before the app is created. It edits only the build's own copy of the
// music app (old-music/App.js), for the Home Screen search:
//  - Nothing on the phone matches: the lists show the online Music Finder songs (src/tools/HomeFinder.js) instead of
//    "Nothing matches your search." They appear by themselves, with Preview, Copy link and Download on each song.
//  - Songs on the phone DO match: the normal local results show, and a small "Search online" button sits at the very
//    bottom of the list. Tap it and the online results are added below.
//  - The clear (x) button in the search boxes gets a bigger invisible tap area (the button itself keeps its size).
// ALL-OR-NOTHING: if any spot cannot be found (the music app changed), nothing is edited and the build goes on without this
// feature. It never stops the build. Your my-music-app repo is not changed.
const fs = require('fs');

const FILE = 'old-music/App.js';

// step: [marker (already done if present), anchor, text, mode, count]  mode: after | before | replace | all
// "all" replaces every copy of the anchor and needs exactly `count` copies.
function run(text, file, steps) {
  let s = text;
  for (const [done, anchor, add, mode, count] of steps) {
    if (s.indexOf(done) >= 0) continue;
    const i = s.indexOf(anchor);
    if (i < 0) throw new Error('cannot find in ' + file + ': ' + anchor.split('\n')[0].trim());
    if (mode === 'all') {
      const parts = s.split(anchor);
      if (parts.length - 1 !== count) throw new Error('expected ' + count + ' but found ' + (parts.length - 1) + ' in ' + file + ': ' + anchor.split('\n')[0].trim());
      s = parts.join(add);
      continue;
    }
    if (s.indexOf(anchor, i + 1) >= 0) throw new Error('found twice in ' + file + ': ' + anchor.split('\n')[0].trim());
    if (mode === 'before') s = s.replace(anchor, () => add + anchor);
    else if (mode === 'replace') s = s.replace(anchor, () => add);
    else s = s.replace(anchor, () => anchor + add);
  }
  return s;
}

const STEPS = [
  // the online results component
  ['import HomeFinder', "import { MixTile, ForYouHeader } from './src/foryou/ForYouUI';", "\nimport HomeFinder, { HomeFinderMore } from './src/tools/HomeFinder';", 'after'],

  // Songs, Favorites, Albums and Artists tabs: the "nothing found" block becomes the online results when no song on the phone matches.
  // "No song matches" is worked out on ALL your songs (not only the tab you are on), so a favourites tab that is empty
  // because the song just is not a favourite still says "Nothing matches your search."
  [
    'const onlineSearch =',
    '  const emptyBlock = (\n',
    '  // Something is typed and not one song on the phone matches it: show the online Music Finder songs\n' +
      "  const onlineSearch = query.trim() !== '' && songs.length > 0 && filtered.length === 0;\n\n" +
      '  // Something is typed and songs on the phone DO match: a small "Search online" button goes at the very bottom of the list\n' +
      "  const onlineMore = query.trim() !== '' && !onlineSearch ? <HomeFinderMore query={query} /> : null;\n\n" +
      '  const emptyBlock = onlineSearch ? (\n' +
      '    <HomeFinder query={query} />\n' +
      '  ) : (\n',
    'replace',
  ],

  // For You tab: same thing
  ['const forYouEmpty = onlineSearch ?', '  const forYouEmpty = (\n', '  const forYouEmpty = onlineSearch ? (\n    <HomeFinder query={query} />\n  ) : (\n', 'replace'],

  // the little "Search online" button at the bottom of the five lists
  ['ListEmptyComponent={emptyBlock}\n        ListFooterComponent', 'ListEmptyComponent={emptyBlock}\n', 'ListEmptyComponent={emptyBlock}\n        ListFooterComponent={onlineMore}\n', 'all', 3],
  ['ListEmptyComponent={forYouEmpty}\n        ListFooterComponent', 'ListEmptyComponent={forYouEmpty}\n', 'ListEmptyComponent={forYouEmpty}\n        ListFooterComponent={onlineMore}\n', 'all', 1],

  // the clear (x) button of the two search boxes: the picture stays the same size, only the invisible tap area grows
  // (it can only grow as far as the search box itself, which is what the phone allows)
  [
    'hitSlop={{ top: 11, bottom: 11, left: 24, right: 14 }}',
    "<TouchableOpacity onPress={() => setQuery('')}>",
    "<TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 11, bottom: 11, left: 24, right: 14 }}>",
    'all',
    2,
  ],
];

try {
  if (!fs.existsSync(FILE)) throw new Error('the music app file is not there');
  if (!fs.existsSync('src/tools/HomeFinder.js') || !fs.existsSync('src/tools/finderCore.js')) throw new Error('HomeFinder.js / finderCore.js are missing');
  const out = run(fs.readFileSync(FILE, 'utf8'), FILE, STEPS);
  fs.writeFileSync(FILE, out);
  console.log('Home Screen: online results for songs not on the phone, Search online button, bigger clear-button tap area');
} catch (e) {
  console.log('WARNING: Home Screen online search changes not added, building without them (' + (e && e.message ? e.message : e) + ')');
}
process.exit(0);
