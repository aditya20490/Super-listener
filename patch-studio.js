// Runs during the build, AFTER patch-finder.js. It only edits the build's own copy of src/tools/FinderScreen.js:
//  - adds a "Studio" section to the hamburger menu with "Vocal Splitter" and "Voice Cloner"
//  - makes the menu scrollable, so the longer list always fits on small phones
// Your repos are not changed.
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

patch('src/tools/FinderScreen.js', [
  // 1) the opener
  [
    "from './studioApps'",
    "import { Screen, useAppTheme } from './Tools';",
    "\nimport { openStudioApp } from './studioApps';",
    'after',
  ],
  // 2) tapping the two rows
  [
    'openStudioApp(wanted)',
    "const wanted = info.tab || 'songs';",
    "\n      if (wanted === 'splitter' || wanted === 'voice') {\n        setMenu(false);\n        openStudioApp(wanted);\n        return;\n      }",
    'after',
  ],
  // 3) the two rows themselves
  [
    "menuItem('splitter'",
    "{menuItem('tts', 'volume-high', 'Text to Speech', 'Offline voices, on your phone')}",
    "\n            <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginHorizontal: 12, marginTop: 22, marginBottom: 6 }}>\n              Studio\n            </Text>\n            {menuItem('splitter', 'layers', 'Vocal Splitter', 'Separate vocals and instruments, offline')}\n            {menuItem('voice', 'mic', 'Voice Cloner', 'Clone your voice, speak any text')}",
    'after',
  ],
  // 4) scrollable menu (opening tag, then closing tag)
  [
    "contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 12",
    "<View style={{ width: '80%', maxWidth: 340, backgroundColor: t.bg, paddingTop: insets.top + 16, paddingHorizontal: 12, paddingBottom: insets.bottom + 16 }}>",
    "<ScrollView style={{ width: '80%', maxWidth: 340, backgroundColor: t.bg }} contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 12, paddingBottom: insets.bottom + 16 }}>",
    'replace',
  ],
  [
    "</ScrollView>\n          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }}",
    "</View>\n          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }}",
    "</ScrollView>\n          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }}",
    'replace',
  ],
]);

console.log('Hamburger menu: Vocal Splitter and Voice Cloner added');
