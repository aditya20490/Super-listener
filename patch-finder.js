// Runs during the build, before the app is created. It only edits the build's own copies:
//  - App.js (root): mounts the Music Finder screen next to the other tools
//  - old-music/App.js: adds the "Find it online" card at the end of the song list
// Your my-music-app repo is not changed.
const fs = require('fs');

function patch(file, steps) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [done, anchor, add, where] of steps) {
    if (s.indexOf(done) >= 0) continue;
    const at = s.indexOf(anchor);
    if (at < 0) {
      console.error('Could not find in ' + file + ': ' + anchor);
      process.exit(1);
    }
    s = where === 'before' ? s.replace(anchor, () => add + anchor) : s.replace(anchor, () => anchor + add);
  }
  fs.writeFileSync(file, s);
}

patch('App.js', [
  ["import FinderScreen", "import MkaScreen from './src/tools/MkaScreen';", "\nimport FinderScreen from './src/tools/FinderScreen';", 'after'],
  ['<FinderScreen />', '<MkaScreen />', '\n        <FinderScreen />', 'after'],
]);

patch('old-music/App.js', [
  ["import FinderCard", "import EditSong from './src/EditSong';", "\nimport FinderCard from './src/tools/FinderCard';", 'after'],
  [
    'ListFooterComponent={<FinderCard',
    "key={'songs-' + tab + '-' + columns}",
    '\n        ListFooterComponent={<FinderCard query={query} />}',
    'after',
  ],
]);
console.log('Music Finder linked into the build copies of App.js');
