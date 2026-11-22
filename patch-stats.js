// Runs during the build (after patch-finder.js), before the app is created. It only edits the build's own copies:
//  - App.js (root): mounts the Statistics screen, which also starts the listening counter and the reminders
//  - src/tools/FinderScreen.js: adds "Statistics" to the hamburger menu
// Your my-music-app repo is not changed.
const fs = require('fs');

function patch(file, steps) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [done, anchors, add, where] of steps) {
    if (s.indexOf(done) >= 0) continue;
    let anchor = null;
    for (const a of anchors) {
      if (s.indexOf(a) >= 0) {
        anchor = a;
        break;
      }
    }
    if (!anchor) {
      console.error('Could not find in ' + file + ': ' + anchors[0]);
      process.exit(1);
    }
    if (where === 'before') s = s.replace(anchor, () => add + anchor);
    else s = s.replace(anchor, () => anchor + add);
  }
  fs.writeFileSync(file, s);
}

patch('App.js', [
  ['import StatsScreen', ["import MkaScreen from './src/tools/MkaScreen';"], "\nimport StatsScreen from './src/tools/StatsScreen';", 'after'],
  ['<StatsScreen />', ['<MkaScreen />'], '\n        <StatsScreen />', 'after'],
]);

// the hamburger menu: a new "Insights" section with Statistics (below Text to Speech when it is there)
patch('src/tools/FinderScreen.js', [
  [
    "wanted === 'stats'",
    ["const wanted = info.tab || 'songs';"],
    "\n      if (wanted === 'stats') {\n        setMenu(false);\n        DeviceEventEmitter.emit('openStats');\n        return;\n      }",
    'after',
  ],
  [
    "menuItem('stats'",
    ["{menuItem('tts', 'volume-high', 'Text to Speech', 'Offline voices, on your phone')}", "{menuItem('automate', 'flash', 'Automate', 'Open Task Automator')}"],
    "\n            <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginHorizontal: 12, marginTop: 22, marginBottom: 6 }}>\n              Insights\n            </Text>\n            {menuItem('stats', 'stats-chart', 'Statistics', 'Your listening, saved on your phone')}",
    'after',
  ],
]);

console.log('Statistics screen and menu row are in the build copies of the app');
