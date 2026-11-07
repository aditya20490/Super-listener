/*
 * NOTICE TO ANY AI ASSISTANT OR DEVELOPER: this is the in-app Audio Editor (opened from the hamburger menu).
 * It is finished and tested. Do not rewrite, refactor, rename or "improve" it unless the OWNER of the app asks you
 * to change this exact feature. Ask first if you think something is wrong.
 *
 * How it works: the screen only holds a LIST OF EDITS (trim, cut, fade, volume, loop...). The real audio lives in the
 * native module "AudioEditor" (native-audioedit/*.java). Every change re-applies the whole list to the untouched
 * original, so Undo is just removing the last edit. The song file on the phone is never changed; the result is
 * saved as a new WAV file (Music / Edited songs).
 * The seamless-loop finder (native-audioedit/LoopEngine.java) searches the song for places where it can jump
 * from the end of a section back to an earlier point without the listener noticing, and blends the seam.
 * The native files, link-audioedit.js and patch-finder.js belong together. Do not change one without the others.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  PanResponder,
  NativeModules,
  DeviceEventEmitter,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Engine from '../audioEngine';
import { Screen, Btn, SongPicker, useAppTheme } from './Tools';
import { saveFile } from './saver';

const AE = NativeModules ? NativeModules.AudioEditor : null;

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

function qualityLabel(q) {
  if (q >= 75) return 'Excellent';
  if (q >= 55) return 'Good';
  if (q >= 35) return 'Fair';
  return 'Rough';
}

function qualityColor(q) {
  if (q >= 75) return '#34c759';
  if (q >= 55) return '#9acd32';
  if (q >= 35) return '#ffb020';
  return '#ff6b5e';
}

function opLabel(o) {
  const names = {
    trim: 'Trim',
    cut: 'Cut',
    fadeIn: 'Fade in',
    fadeOut: 'Fade out',
    gain: 'Volume ' + (o.db > 0 ? '+' : '') + o.db + ' dB',
    normalize: 'Normalize',
    silence: 'Silence',
    reverse: 'Reverse',
    speed: 'Speed ' + o.factor + 'x',
    loop: 'Seamless loop',
  };
  return names[o.t] || o.t;
}

export default function AudioEditorScreen() {
  const [open, setOpen] = useState(false);
  const t = useAppTheme(open);

  const [pickOpen, setPickOpen] = useState(false);
  const [song, setSong] = useState(null);
  const [info, setInfo] = useState(null); // { duration, sampleRate, channels, peaks }
  const [loading, setLoading] = useState('');
  const [busy, setBusy] = useState('');
  const [ops, setOps] = useState([]);
  const [redo, setRedo] = useState([]);
  const [sel, setSel] = useState(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loopOn, setLoopOn] = useState(false);
  const [useOriginal, setUseOriginal] = useState(false);
  const [width, setWidth] = useState(300);

  const [sheet, setSheet] = useState(null); // 'loop' | 'volume' | 'speed' | 'export'
  const [style, setStyle] = useState('best');
  const [xf, setXf] = useState(0);
  const [extend, setExtend] = useState(0); // minutes, 0 = only the loop
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState({ f: 0, stage: '' });
  const [results, setResults] = useState(null);
  const [chosen, setChosen] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [exportName, setExportName] = useState('');

  const geo = useRef({});
  const drag = useRef({ x0: 0, mode: 'new', moved: false });

  const dur = info ? info.duration : 0;
  const selValid = sel && sel.end - sel.start > 0.02;

  // ---------- opening ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openAudioEditor', () => {
      setOpen(true);
      if (!song) setPickOpen(true);
    });
    return () => sub.remove();
  }, [song]);

  const stopPlay = async () => {
    try {
      if (AE) await AE.stop();
    } catch (e) {}
    setPlaying(false);
  };

  const close = async () => {
    await stopPlay();
    try {
      if (AE) await AE.release();
    } catch (e) {}
    setOpen(false);
    setSong(null);
    setInfo(null);
    setOps([]);
    setRedo([]);
    setSel(null);
    setSheet(null);
    setResults(null);
  };

  const loadSong = async (item) => {
    setPickOpen(false);
    await stopPlay();
    setSong(item);
    setInfo(null);
    setOps([]);
    setRedo([]);
    setSel(null);
    setPos(0);
    setResults(null);
    setExportName(String(item.title || 'song') + ' (edited)');
    setLoading('Opening the song…');
    try {
      const r = await AE.open(item.uri);
      setInfo(r);
    } catch (e) {
      Alert.alert('Could not open this song', e && e.message ? e.message : 'Try another song.');
      setSong(null);
    }
    setLoading('');
  };

  // ---------- the edit list ----------
  const applyList = async (list) => {
    setBusy('Applying…');
    try {
      const r = await AE.render(JSON.stringify(list));
      setInfo(r);
      setSel(null);
      return true;
    } catch (e) {
      Alert.alert('Could not apply that', e && e.message ? e.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy('');
    }
  };

  const pushOp = async (op) => {
    await stopPlay();
    const next = ops.concat([op]);
    if (await applyList(next)) {
      setOps(next);
      setRedo([]);
      setPos(0);
      return true;
    }
    return false;
  };

  const undo = async () => {
    if (ops.length === 0) return;
    await stopPlay();
    const next = ops.slice(0, -1);
    if (await applyList(next)) {
      setRedo(redo.concat([ops[ops.length - 1]]));
      setOps(next);
      setPos(0);
    }
  };

  const redoOp = async () => {
    if (redo.length === 0) return;
    await stopPlay();
    const op = redo[redo.length - 1];
    const next = ops.concat([op]);
    if (await applyList(next)) {
      setRedo(redo.slice(0, -1));
      setOps(next);
      setPos(0);
    }
  };

  const needSel = () => {
    if (!selValid) {
      Alert.alert('Select a part first', 'Drag across the waveform to choose the part you want to change.');
      return false;
    }
    return true;
  };

  const range = () => (selValid ? { from: sel.start, to: sel.end } : {});

  // ---------- playback ----------
  const startPlay = async (from, orig) => {
    if (!AE || !info) return;
    try {
      if (Engine.player && Engine.player.pause) Engine.player.pause(); // your music pauses while you edit
    } catch (e) {}
    const o = orig === undefined ? useOriginal : orig;
    try {
      if (loopOn && selValid) {
        const s = Math.max(sel.start, Math.min(from, sel.end - 0.05));
        await AE.play(s, sel.end, sel.start, true, o);
      } else if (loopOn) {
        await AE.play(from, -1, 0, true, o);
      } else {
        await AE.play(from, -1, 0, false, o);
      }
      setPlaying(true);
    } catch (e) {
      Alert.alert('Could not play', e && e.message ? e.message : '');
    }
  };

  const togglePlay = async () => {
    if (playing) {
      try {
        const p = await AE.stop();
        if (p && p.position >= 0) setPos(p.position);
      } catch (e) {}
      setPlaying(false);
    } else {
      await startPlay(pos >= dur - 0.05 ? 0 : pos);
    }
  };

  useEffect(() => {
    if (!playing || !AE) return undefined;
    const id = setInterval(async () => {
      try {
        const p = await AE.getPosition();
        if (p.position >= 0) setPos(p.position);
        if (p.ended || !p.playing) setPlaying(false);
      } catch (e) {}
    }, 100);
    return () => clearInterval(id);
  }, [playing]);

  const seekTo = async (tm) => {
    const tt = Math.max(0, Math.min(dur, tm));
    setPos(tt);
    if (playing) await startPlay(tt);
  };

  const toggleAB = async () => {
    const next = !useOriginal;
    setUseOriginal(next);
    if (playing) {
      await stopPlay();
      await startPlay(pos, next);
    }
  };

  // ---------- waveform touch ----------
  geo.current = { w: width, dur: dur, sel: selValid ? sel : null, setSel: setSel, seek: seekTo };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const g = geo.current;
        const x = e.nativeEvent.locationX;
        drag.current = { x0: x, mode: 'new', moved: false };
        if (g.sel) {
          const sx = (g.sel.start / g.dur) * g.w;
          const ex = (g.sel.end / g.dur) * g.w;
          if (Math.abs(x - sx) < 26) drag.current.mode = 'start';
          else if (Math.abs(x - ex) < 26) drag.current.mode = 'end';
        }
      },
      onPanResponderMove: (e, gs) => {
        const g = geo.current;
        const d = drag.current;
        if (Math.abs(gs.dx) > 4) d.moved = true;
        if (!d.moved || g.dur <= 0) return;
        const x = Math.max(0, Math.min(g.w, d.x0 + gs.dx));
        const tm = (x / g.w) * g.dur;
        if (d.mode === 'new') {
          const a = (d.x0 / g.w) * g.dur;
          g.setSel({ start: Math.min(a, tm), end: Math.max(a, tm) });
        } else if (d.mode === 'start' && g.sel) {
          g.setSel({ start: Math.min(tm, g.sel.end - 0.05), end: g.sel.end });
        } else if (d.mode === 'end' && g.sel) {
          g.setSel({ start: g.sel.start, end: Math.max(tm, g.sel.start + 0.05) });
        }
      },
      onPanResponderRelease: () => {
        const g = geo.current;
        const d = drag.current;
        if (!d.moved && g.dur > 0) g.seek((d.x0 / g.w) * g.dur);
      },
    })
  ).current;

  const bars = useMemo(() => {
    if (!info || !info.peaks) return [];
    const n = Math.max(24, Math.floor(width / 3));
    const p = info.peaks;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i * p.length) / n);
      const b = Math.max(a + 1, Math.floor(((i + 1) * p.length) / n));
      let m = 0;
      for (let k = a; k < b && k < p.length; k++) if (p[k] > m) m = p[k];
      out.push(m);
    }
    return out;
  }, [info, width]);

  // ---------- tools ----------
  const doTrim = () => needSel() && pushOp({ t: 'trim', from: sel.start, to: sel.end });
  const doCut = () => needSel() && pushOp({ t: 'cut', from: sel.start, to: sel.end });
  const doFadeIn = () => pushOp(selValid ? { t: 'fadeIn', from: sel.start, to: sel.end } : { t: 'fadeIn', from: 0, to: Math.min(3, dur) });
  const doFadeOut = () => pushOp(selValid ? { t: 'fadeOut', from: sel.start, to: sel.end } : { t: 'fadeOut', from: Math.max(0, dur - 3), to: dur });
  const doSilence = () => needSel() && pushOp({ t: 'silence', from: sel.start, to: sel.end });
  const doReverse = () => pushOp(Object.assign({ t: 'reverse' }, range()));
  const doGain = (db) => {
    setSheet(null);
    pushOp(Object.assign({ t: 'gain', db: db }, range()));
  };
  const doNormalize = () => {
    setSheet(null);
    pushOp(Object.assign({ t: 'normalize', db: -1 }, range()));
  };
  const doSpeed = (f) => {
    setSheet(null);
    pushOp({ t: 'speed', factor: f });
  };

  // ---------- seamless loop ----------
  const loopOp = (c, targetSec) => ({ t: 'loop', a: c.a, b: c.b, xf: c.xf, target: Math.round(targetSec * (info ? info.sampleRate : 44100)) });

  const restoreView = async () => {
    if (!previewing) return;
    setPreviewing(false);
    await stopPlay();
    try {
      const r = await AE.render(JSON.stringify(ops));
      setInfo(r);
    } catch (e) {}
  };

  const openLoop = async () => {
    await stopPlay();
    setSheet('loop');
  };

  const closeSheet = async () => {
    if (sheet === 'loop') {
      if (running) {
        try {
          AE.cancelAnalysis();
        } catch (e) {}
      }
      await restoreView();
    }
    setSheet(null);
  };

  const runSearch = async () => {
    await restoreView();
    await stopPlay();
    setRunning(true);
    setResults(null);
    setProg({ f: 0, stage: 'Starting' });
    const sub = DeviceEventEmitter.addListener('AudioEditorProgress', (m) => setProg({ f: m.fraction, stage: m.stage }));
    try {
      const r = await AE.findLoops(JSON.stringify({ wholeSong: style === 'whole', xfSec: xf }));
      setResults(r);
      setChosen(0);
    } catch (e) {
      if (!e || e.code !== 'E_CANCEL') Alert.alert('The loop search failed', e && e.message ? e.message : 'Try again.');
    }
    sub.remove();
    setRunning(false);
  };

  const previewLoop = async (idx) => {
    if (!results) return;
    setChosen(idx);
    await stopPlay();
    try {
      if (Engine.player && Engine.player.pause) Engine.player.pause();
    } catch (e) {}
    setBusy('Building the preview…');
    try {
      const c = results.loops[idx];
      const r = await AE.render(JSON.stringify(ops.concat([loopOp(c, 0)])));
      setInfo(r);
      setPreviewing(true);
      // start a few seconds before the end, so you hear the seam again and again
      await AE.play(Math.max(0, r.duration - 4), -1, 0, true, false);
      setPlaying(true);
    } catch (e) {
      Alert.alert('Could not preview', e && e.message ? e.message : '');
    }
    setBusy('');
  };

  const applyLoop = async () => {
    if (!results || !results.loops[chosen]) return;
    const c = results.loops[chosen];
    await stopPlay();
    setPreviewing(false);
    const ok = await pushOp(loopOp(c, extend * 60));
    if (ok) {
      setSheet(null);
      setResults(null);
    } else {
      await restoreView();
    }
  };

  // ---------- saving ----------
  const doExport = async () => {
    setSheet(null);
    await stopPlay();
    setBusy('Saving…');
    try {
      const name = String(exportName || 'edited').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      const path = await AE.exportWav(name);
      await saveFile(path, name + '.wav', 'audio/wav', true);
      Alert.alert('Saved', 'Saved as "' + name + '.wav" in Music / Edited songs. Pull down on your song list to refresh it.');
    } catch (e) {
      Alert.alert('Could not save', e && e.message ? e.message : 'Something went wrong.');
    }
    setBusy('');
  };

  // ---------- look ----------
  const card = { backgroundColor: t.card, borderRadius: 16, padding: 14, marginBottom: 12 };
  const chip = (icon, label, onPress, hi, disabled) => (
    <TouchableOpacity
      key={label}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        width: '23%',
        paddingVertical: 12,
        borderRadius: 14,
        marginBottom: 8,
        backgroundColor: hi ? t.accent : t.card,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Ionicons name={icon} size={21} color={hi ? t.onAccent : t.text} />
      <Text style={{ marginTop: 4, fontSize: 11, fontWeight: '700', color: hi ? t.onAccent : t.text }} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
  const pill = (label, on, onPress) => (
    <TouchableOpacity
      key={label}
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 18,
        marginRight: 8,
        marginBottom: 8,
        backgroundColor: on ? t.accent : t.track,
      }}
    >
      <Text style={{ fontWeight: '700', fontSize: 13, color: on ? t.onAccent : t.text }}>{label}</Text>
    </TouchableOpacity>
  );

  const selStartX = selValid ? (sel.start / Math.max(0.001, dur)) * width : 0;
  const selEndX = selValid ? (sel.end / Math.max(0.001, dur)) * width : 0;
  const headX = (pos / Math.max(0.001, dur)) * width;

  const waveform = (
    <View
      onLayout={(e) => setWidth(Math.max(100, e.nativeEvent.layout.width))}
      style={{ height: 150, borderRadius: 16, backgroundColor: t.card, overflow: 'hidden', marginBottom: 10 }}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' }}>
        {bars.map((b, i) => (
          <View
            key={i}
            style={{ width: Math.max(1, width / bars.length - 1), marginRight: 1, height: Math.max(2, b * 130), borderRadius: 1.5, backgroundColor: t.accent, opacity: 0.85 }}
          />
        ))}
      </View>
      {selValid ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: selStartX, width: Math.max(2, selEndX - selStartX), backgroundColor: t.accent, opacity: 0.22 }} />
      ) : null}
      {selValid ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: selStartX - 2, width: 4, backgroundColor: t.text }} />
      ) : null}
      {selValid ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: selEndX - 2, width: 4, backgroundColor: t.text }} />
      ) : null}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: headX - 1, width: 2, backgroundColor: '#ff453a' }} />
    </View>
  );

  const loopSheet = (
    <View>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>Seamless loop</Text>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginTop: 4, marginBottom: 14 }}>
        Searches your song for places where it can jump from the end of a section back to an earlier point without anyone noticing,
        then blends the seam. It will not always find a perfect spot, and it tells you how good each loop is.
      </Text>

      <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>WHAT TO LOOP</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {pill('Best match anywhere', style === 'best', () => setStyle('best'))}
        {pill('Keep the whole song', style === 'whole', () => setStyle('whole'))}
      </View>

      <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700', marginTop: 6, marginBottom: 6 }}>BLEND LENGTH</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[[0, 'Auto'], [0.1, '0.1 s'], [0.5, '0.5 s'], [1, '1 s'], [2, '2 s']].map((x) => pill(x[1], xf === x[0], () => setXf(x[0])))}
      </View>

      {running ? (
        <View style={{ marginTop: 10 }}>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.track, overflow: 'hidden' }}>
            <View style={{ height: 8, width: Math.round(prog.f * 100) + '%', backgroundColor: t.accent }} />
          </View>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 8 }}>{prog.stage}</Text>
          <Btn t={t} label="Cancel" alt style={{ marginTop: 10 }} onPress={() => AE.cancelAnalysis()} />
        </View>
      ) : (
        <Btn t={t} icon="search" label={results ? 'Search again' : 'Find loops'} style={{ marginTop: 10 }} onPress={runSearch} />
      )}

      {results ? (
        <View style={{ marginTop: 16 }}>
          <Text style={{ color: t.muted, fontSize: 12, marginBottom: 8 }}>
            Found {results.loops.length} loop{results.loops.length === 1 ? '' : 's'} in {(results.ms / 1000).toFixed(1)} s. Tap Preview to hear how the end flows into the start.
          </Text>
          {results.loops.map((c, i) => {
            const on = chosen === i;
            return (
              <TouchableOpacity
                key={i}
                activeOpacity={0.85}
                onPress={() => setChosen(i)}
                style={{ borderRadius: 14, padding: 12, marginBottom: 10, backgroundColor: t.card, borderWidth: 2, borderColor: on ? t.accent : 'transparent' }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ flex: 1, color: t.text, fontWeight: '800', fontSize: 15 }}>
                    Loop {i + 1}: {fmt(c.startSec)} to {fmt(c.endSec)}
                  </Text>
                  <Text style={{ color: qualityColor(c.quality), fontWeight: '800' }}>{qualityLabel(c.quality)}</Text>
                </View>
                <Text style={{ color: t.muted, fontSize: 12, marginTop: 3 }}>
                  {c.lenSec.toFixed(1)} s long, quality {Math.round(c.quality)} of 100, blend {Math.round((c.xf / info.sampleRate) * 1000)} ms
                </Text>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: t.track, marginTop: 8, overflow: 'hidden' }}>
                  <View style={{ height: 6, width: Math.round(c.quality) + '%', backgroundColor: qualityColor(c.quality) }} />
                </View>
                <View style={{ flexDirection: 'row', marginTop: 10 }}>
                  <Btn t={t} icon="play" label="Preview" alt style={{ flex: 1 }} onPress={() => previewLoop(i)} />
                </View>
              </TouchableOpacity>
            );
          })}
          {results.loops.length > 0 && results.loops[0].quality < 35 ? (
            <Text style={{ color: '#ffb020', fontSize: 12, marginBottom: 10 }}>
              Nothing in this song fits well, so these loops use a longer blend. They may be noticeable.
            </Text>
          ) : null}

          <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>RESULT</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {[[0, 'Only the loop'], [3, 'Song to 3 min'], [5, 'Song to 5 min'], [10, 'Song to 10 min']].map((x) => pill(x[1], extend === x[0], () => setExtend(x[0])))}
          </View>
          <Text style={{ color: t.muted, fontSize: 12, marginBottom: 10 }}>
            {extend === 0
              ? 'The result is the loop itself. When it ends it flows straight back into its start.'
              : 'The whole song, with the loop repeated until it is that long, then the natural ending.'}
          </Text>
          <Btn t={t} icon="checkmark" label="Use this loop" onPress={applyLoop} />
        </View>
      ) : null}
    </View>
  );

  const volumeSheet = (
    <View>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>Volume</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 4, marginBottom: 14 }}>
        {selValid ? 'Applies to the part you selected.' : 'Applies to the whole song. Select a part on the waveform to change only that part.'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[-12, -6, -3, 3, 6, 9].map((db) => pill((db > 0 ? '+' : '') + db + ' dB', false, () => doGain(db)))}
      </View>
      <Btn t={t} icon="stats-chart" label="Normalize (loudest point to -1 dB)" style={{ marginTop: 6 }} onPress={doNormalize} />
    </View>
  );

  const speedSheet = (
    <View>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>Speed</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 4, marginBottom: 14 }}>
        Plays the whole song faster or slower. Like a tape, the pitch changes with the speed.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2].map((f) => pill(f + 'x', false, () => doSpeed(f)))}
      </View>
    </View>
  );

  const exportSheet = (
    <View>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>Save</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 4, marginBottom: 12 }}>
        Saves a new WAV file in Music / Edited songs. Your original song is not touched. WAV is full quality, so the file is large (about 10 MB per minute).
      </Text>
      <TextInput
        value={exportName}
        onChangeText={setExportName}
        placeholder="File name"
        placeholderTextColor={t.muted}
        style={{ backgroundColor: t.track, color: t.text, borderRadius: 12, paddingHorizontal: 14, height: 46, fontSize: 15, marginBottom: 12 }}
      />
      <Btn t={t} icon="download" label="Save" onPress={doExport} />
    </View>
  );

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <TouchableOpacity onPress={undo} disabled={ops.length === 0} style={{ padding: 8, opacity: ops.length === 0 ? 0.35 : 1 }}>
        <Ionicons name="arrow-undo" size={22} color={t.text} />
      </TouchableOpacity>
      <TouchableOpacity onPress={redoOp} disabled={redo.length === 0} style={{ padding: 8, opacity: redo.length === 0 ? 0.35 : 1 }}>
        <Ionicons name="arrow-redo" size={22} color={t.text} />
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setPickOpen(true)} style={{ padding: 8 }}>
        <Ionicons name="musical-notes" size={22} color={t.text} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={async () => {
          await stopPlay();
          setSheet('export');
        }}
        disabled={!info}
        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: t.accent, marginLeft: 4, marginRight: 6, opacity: info ? 1 : 0.4 }}
      >
        <Text style={{ color: t.onAccent, fontWeight: '800' }}>Save</Text>
      </TouchableOpacity>
    </View>
  );

  let body;
  if (!AE) {
    body = (
      <Text style={{ color: t.muted, padding: 24, textAlign: 'center' }}>The audio editor is not part of this build of the app.</Text>
    );
  } else if (!song) {
    body = (
      <View style={{ padding: 24, alignItems: 'center' }}>
        <Ionicons name="cut" size={46} color={t.accent} />
        <Text style={{ color: t.text, fontSize: 20, fontWeight: '800', marginTop: 12 }}>Audio Editor</Text>
        <Text style={{ color: t.muted, textAlign: 'center', marginTop: 6, marginBottom: 18 }}>
          Trim, cut, fade, change volume or speed, and turn any song into a seamless loop. Your original file is never changed.
        </Text>
        <Btn t={t} icon="musical-notes" label="Choose a song" onPress={() => setPickOpen(true)} />
      </View>
    );
  } else if (!info) {
    body = (
      <View style={{ padding: 40, alignItems: 'center' }}>
        <ActivityIndicator color={t.accent} size="large" />
        <Text style={{ color: t.muted, marginTop: 14 }}>{loading || 'Loading…'}</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: t.text, fontSize: 17, fontWeight: '800' }} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 2, marginBottom: 10 }}>
          {previewing ? 'Previewing a loop. ' : ''}
          {fmt(dur)} long, {info.sampleRate} Hz, {info.channels === 1 ? 'mono' : 'stereo'}
          {ops.length > 0 ? '. Edits: ' + ops.map(opLabel).join(', ') : ''}
        </Text>

        {waveform}

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ color: t.muted, fontSize: 12 }}>{fmt(pos)}</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            {selValid ? 'Selected ' + fmt(sel.start) + ' to ' + fmt(sel.end) + ' (' + (sel.end - sel.start).toFixed(1) + ' s)' : 'Drag on the waveform to select a part'}
          </Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>{fmt(dur)}</Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <TouchableOpacity onPress={() => seekTo(0)} style={{ padding: 10 }}>
            <Ionicons name="play-skip-back" size={24} color={t.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={togglePlay}
            style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', marginHorizontal: 8 }}
          >
            <Ionicons name={playing ? 'pause' : 'play'} size={28} color={t.onAccent} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setLoopOn(!loopOn)} style={{ padding: 10 }}>
            <Ionicons name="repeat" size={24} color={loopOn ? t.accent : t.muted} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          {selValid ? (
            <TouchableOpacity onPress={() => setSel(null)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: t.card, marginRight: 8 }}>
              <Text style={{ color: t.text, fontWeight: '700', fontSize: 12 }}>Clear selection</Text>
            </TouchableOpacity>
          ) : null}
          {ops.length > 0 ? (
            <TouchableOpacity
              onPress={toggleAB}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: useOriginal ? t.accent : t.card }}
            >
              <Text style={{ color: useOriginal ? t.onAccent : t.text, fontWeight: '700', fontSize: 12 }}>{useOriginal ? 'Original' : 'Edited'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <TouchableOpacity
          onPress={openLoop}
          activeOpacity={0.85}
          style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.accent, borderRadius: 16, padding: 14, marginBottom: 14 }}
        >
          <Ionicons name="infinite" size={30} color={t.onAccent} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: t.onAccent, fontWeight: '800', fontSize: 16 }}>Seamless loop</Text>
            <Text style={{ color: t.onAccent, opacity: 0.85, fontSize: 12, marginTop: 2 }}>
              Find where the song can repeat without a break
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color={t.onAccent} />
        </TouchableOpacity>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          {chip('contract', 'Trim', doTrim)}
          {chip('cut', 'Cut', doCut)}
          {chip('trending-up', 'Fade in', doFadeIn)}
          {chip('trending-down', 'Fade out', doFadeOut)}
          {chip('volume-high', 'Volume', () => setSheet('volume'))}
          {chip('volume-mute', 'Silence', doSilence)}
          {chip('swap-horizontal', 'Reverse', doReverse)}
          {chip('speedometer', 'Speed', () => setSheet('speed'))}
        </View>
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>
          Trim keeps the selected part. Cut removes it. Without a selection, fades work on the first or last 3 seconds and volume works on the whole song.
        </Text>
      </ScrollView>
    );
  }

  const sheetContent = sheet === 'loop' ? loopSheet : sheet === 'volume' ? volumeSheet : sheet === 'speed' ? speedSheet : sheet === 'export' ? exportSheet : null;

  return (
    <View pointerEvents="box-none">
      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <Screen t={t} title="Audio Editor" onClose={close} right={song && info ? header : null}>
          {body}
        </Screen>

        <SongPicker t={t} visible={pickOpen} onClose={() => setPickOpen(false)} onPick={loadSong} title="Edit which song?" />

        <Modal visible={!!sheet} transparent animationType="slide" onRequestClose={closeSheet}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={closeSheet} />
            <View style={{ backgroundColor: t.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '86%', padding: 18 }}>
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {busy ? <Text style={{ color: t.accent, fontWeight: '700', marginBottom: 8 }}>{busy}</Text> : null}
                {sheetContent}
                <Btn t={t} label="Close" alt style={{ marginTop: 14 }} onPress={closeSheet} />
                <View style={{ height: 10 }} />
              </ScrollView>
            </View>
          </View>
        </Modal>

        {busy ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 22, alignItems: 'center' }}>
              <ActivityIndicator color={t.accent} size="large" />
              <Text style={{ color: t.text, marginTop: 12, fontWeight: '700' }}>{busy}</Text>
            </View>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}
