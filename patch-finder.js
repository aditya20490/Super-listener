// Runs during the build, before the app is created. It only edits the build's own copies:
//  - App.js (root): mounts the Music Finder screen next to the other tools
//  - old-music/App.js: adds a hamburger menu button at the top left of the header, and keeps your listening
//    history backed up outside the app (src/tools/persist.js)
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

const menuButton =
  "        <TouchableOpacity style={[s.headerBtn, { marginRight: 8 }]} onPress={() => require('react-native').DeviceEventEmitter.emit('openFinderMenu')}>\n" +
  '          <Ionicons name="menu" size={24} color={t.text} />\n' +
  '        </TouchableOpacity>\n';

const persistEffects =
  '\n  // Keeps a small copy of your listening history outside the app, so a reinstall does not start from zero\n' +
  '  useEffect(() => {\n' +
  '    if (songs.length === 0 || scan) return undefined;\n' +
  '    const timer = setTimeout(() => {\n' +
  '      Persist.sync(songs, favsRef.current, (merged) => {\n' +
  '        setFavs(merged);\n' +
  '        Collections.saveFavs(merged);\n' +
  '      }).catch(() => {});\n' +
  '    }, 5000);\n' +
  '    return () => clearTimeout(timer);\n' +
  '  }, [songs.length, scan === null]);\n' +
  '  useEffect(() => {\n' +
  '    Persist.noteFavs(favs);\n' +
  '  }, [favs]);\n' +
  '  useEffect(() => {\n' +
  "    const sub = AppState.addEventListener('change', (st) => {\n" +
  "      if (st !== 'active') Persist.flush();\n" +
  '    });\n' +
  '    return () => sub.remove();\n' +
  '  }, []);\n';

patch('old-music/App.js', [
  ["import * as Persist", "import * as ForYouStore from './src/foryou/store';", "\nimport * as Persist from './src/tools/persist';", 'after'],
  ['Persist.sync(', '  favsRef.current = favs;\n', persistEffects, 'after'],
  [
    "emit('openFinderMenu')",
    '        <View style={{ flex: 1 }}>\n          <Text style={s.bigTitle}>My Music</Text>',
    menuButton,
    'before',
  ],
]);
console.log('Music Finder linked into the build copies of App.js');
