// Runs during the build (after patch-stats.js), before the app is created. It edits only the build's own copy of the music
// app (old-music/): the K button next to 8D, and a few small hooks in audioEngine.js so karaoke can follow the player.
// ALL-OR-NOTHING: if any spot cannot be found (the music app changed), nothing is edited and the build goes on without the
// K button. It never stops the build. Your my-music-app repo is not changed.
const fs = require('fs');

const NP = 'old-music/src/NowPlaying.js';
const AE = 'old-music/src/audioEngine.js';

// step: [marker (already done if present), anchor, text, mode]  mode: after | before | replace | append
function run(text, file, steps) {
  let s = text;
  for (const [done, anchor, add, mode] of steps) {
    if (s.indexOf(done) >= 0) continue;
    if (mode === 'append') {
      s = s + add;
      continue;
    }
    const i = s.indexOf(anchor);
    if (i < 0) throw new Error('cannot find in ' + file + ': ' + anchor.split('\n')[0].trim());
    if (s.indexOf(anchor, i + 1) >= 0) throw new Error('found twice in ' + file + ': ' + anchor.split('\n')[0].trim());
    if (mode === 'before') s = s.replace(anchor, () => add + anchor);
    else if (mode === 'replace') s = s.replace(anchor, () => add);
    else s = s.replace(anchor, () => anchor + add);
  }
  return s;
}

const NP_STEPS = [
  ['import KaraokeButton', "import * as Engine from './audioEngine';", "\nimport KaraokeButton from './tools/KaraokeButton';", 'after'],
  [
    '<KaraokeButton',
    "<View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>\n                  {eightD ? (",
    '<KaraokeButton song={song} t={t} />\n                ',
    'before',
  ],
  ['minWidth: 74,', 'borderColor: eightD ? t.accent : t.muted,', "\n                      minWidth: 74,\n                      justifyContent: 'center',", 'after'],
];

const AE_STEPS = [
  ['import * as Karaoke', "import { NativeModules } from 'react-native';", "\nimport * as Karaoke from './tools/karaoke';", 'after'],
  ['Karaoke.onLoad(song);', '    eight.song = song;\n', '    Karaoke.onLoad(song);\n', 'after'],
  ['Karaoke.onSeek(sec);', '  seekTo(sec) {\n    eight.touchedAt = Date.now();\n', '    Karaoke.onSeek(sec);\n', 'after'],
  [
    'Karaoke.setVolume(v);',
    '    TrackPlayer.setVolume(v).catch(() => {});\n',
    '    if (Karaoke.isActive()) {\n      Karaoke.setVolume(v);\n      return;\n    }\n',
    'before',
  ],
  ['Karaoke.onEightChanged(true);', '      eight.on = true;\n', '      Karaoke.onEightChanged(true);\n', 'after'],
  [
    'Karaoke.onEightChanged(false);',
    '    eight.on = false;\n    try {\n      Native.stop();\n    } catch (e) {}\n',
    '    if (Karaoke.isActive()) {\n      Karaoke.onEightChanged(false);\n      return false;\n    }\n',
    'after',
  ],
  [
    'Karaoke.eightSource(',
    '    await Native.start(eight.song.uri, Math.max(0, positionSec) * 1000, eight.volume, eight.playing);\n',
    '    const ks = Karaoke.eightSource(eight.song);\n    await Native.start(ks ? ks.uri : eight.song.uri, Math.max(0, positionSec) * 1000 + (ks ? ks.offsetMs : 0), eight.volume, eight.playing);\n',
    'replace',
  ],
  [
    'Karaoke.attach(',
    '',
    "\n// Karaoke (see tools/karaoke.js): lets it know about 8D and restart the 8D sound with the karaoke file\nKaraoke.attach({\n  isEight: () => eight.on,\n  getVolume: () => eight.volume,\n  refreshEight: async () => {\n    if (!eight.on || !Native) return;\n    let pos = 0;\n    try {\n      pos = (await TrackPlayer.getProgress()).position || 0;\n    } catch (e) {}\n    eight.touchedAt = Date.now();\n    await eightStart(pos);\n  },\n});\n",
    'append',
  ],
];

try {
  if (!fs.existsSync(NP) || !fs.existsSync(AE)) throw new Error('the music app files are not there');
  const np = run(fs.readFileSync(NP, 'utf8'), NP, NP_STEPS);
  const ae = run(fs.readFileSync(AE, 'utf8'), AE, AE_STEPS);
  fs.writeFileSync(NP, np);
  fs.writeFileSync(AE, ae);
  console.log('Karaoke: the K button and the player hooks are in the build copies of the app');
} catch (e) {
  console.log('WARNING: Karaoke button not added, building without it (' + (e && e.message ? e.message : e) + ')');
}
process.exit(0);
