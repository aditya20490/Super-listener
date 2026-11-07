// Runs during the build, before the app is created. It only edits the build's own copies:
//  - App.js (root): mounts the Music Finder screen and the Audio Editor next to the other tools
//  - old-music/App.js: adds a hamburger menu button at the top left of the header, and keeps your listening
//    history backed up outside the app (src/tools/persist.js)
//  - old-music/src/EditSong.js: adds an info button explaining that the edits are inside the app only
//  - src/tools/FinderScreen.js: adds "Audio Editor" to the hamburger menu
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
    if (where === 'before') s = s.replace(anchor, () => add + anchor);
    else if (where === 'replace') s = s.replace(anchor, () => add);
    else s = s.replace(anchor, () => anchor + add);
  }
  fs.writeFileSync(file, s);
}

patch('App.js', [
  ["import FinderScreen", "import MkaScreen from './src/tools/MkaScreen';", "\nimport FinderScreen from './src/tools/FinderScreen';", 'after'],
  ['<FinderScreen />', '<MkaScreen />', '\n        <FinderScreen />', 'after'],
  ["import AudioEditorScreen", "import FinderScreen from './src/tools/FinderScreen';", "\nimport AudioEditorScreen from './src/tools/AudioEditorScreen';", 'after'],
  ['<AudioEditorScreen />', '<FinderScreen />', '\n        <AudioEditorScreen />', 'after'],
]);

// the hamburger menu: a new "Audio" section with the Audio Editor
patch('src/tools/FinderScreen.js', [
  [
    "DeviceEventEmitter.emit('openAudioEditor')",
    "const wanted = info.tab || 'songs';",
    "\n      if (wanted === 'editor') {\n        setMenu(false);\n        DeviceEventEmitter.emit('openAudioEditor');\n        return;\n      }",
    'after',
  ],
  [
    "menuItem('editor'",
    "{menuItem('automate', 'flash', 'Automate', 'Open Task Automator')}",
    "\n            <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginHorizontal: 12, marginTop: 22, marginBottom: 6 }}>\n              Audio\n            </Text>\n            {menuItem('editor', 'cut', 'Audio Editor', 'Trim, fade, loop and more')}",
    'after',
  ],
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

// the "Edit song" screen: an info button next to the title
const editInfo =
  "<View style={{ flexDirection: 'row', alignItems: 'center' }}>\n" +
  '            <Text style={st.topTitle}>Edit song</Text>\n' +
  '            <TouchableOpacity\n' +
  '              onPress={() =>\n' +
  '                Alert.alert(\n' +
  "                  'In-app changes only',\n" +
  "                  'Everything you change here (title, artist, album, cover, lyrics and so on) is saved inside Music Plus only. It does not change the real audio file on your phone, and other apps will keep showing the original details. If you uninstall the app or clear its data, these edits can be lost.'\n" +
  '                )\n' +
  '              }\n' +
  '              style={{ marginLeft: 6, padding: 6 }}\n' +
  '              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}\n' +
  '            >\n' +
  '              <Ionicons name="information-circle-outline" size={22} color={t.muted} />\n' +
  '            </TouchableOpacity>\n' +
  '          </View>';

patch('old-music/src/EditSong.js', [
  ['In-app changes only', '<Text style={st.topTitle}>Edit song</Text>', editInfo, 'replace'],
]);
console.log('Music Finder, Audio Editor and the other links are in the build copies of the app');
