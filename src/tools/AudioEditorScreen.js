/*
 * NOTICE TO ANY AI ASSISTANT OR DEVELOPER: this is the in-app Audio Editor (opened from the hamburger menu).
 * It is finished and tested. Do not rewrite, refactor, rename or "improve" it unless the OWNER of the app asks you
 * to change this exact feature. Ask first if you think something is wrong.
 *
 * How it works: the screen only holds a LIST OF EDITS (trim, cut, fade, volume, loop...). The real audio lives in the
 * native module "AudioEditor" (native-audioedit/*.java). Every change re-applies the whole list to the untouched
 * original, so Undo is just removing the last edit. The song file on the phone is never changed; the result is
 * saved as a NEW file (Music / Edited songs).
 * Loop: the user picks a part (finger or start/end in milliseconds). native LoopMaker checks the jump, lines the
 * waveforms up and blends the seam. The loop edit makes ONE seamless cycle; how many times it repeats is applied
 * when the result is saved (LoopStream), so even a one hour result does not need memory.
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
  FlatList,
  PanResponder,
  NativeModules,
  DeviceEventEmitter,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import * as Engine from '../audioEngine';
import { Screen, Btn, useAppTheme } from './Tools';
import { saveFile } from './saver';

const AE = NativeModules ? NativeModules.AudioEditor : null;

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

function fmtLong(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h > 0 ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function mbText(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : Math.max(1, Math.round(mb)) + ' MB';
}

function cleanTitle(name) {
  return String(name || '')
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/_/g, ' ')
    .trim();
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
    loop: 'Loop x' + (o.loops || 1),
  };
  return names[o.t] || o.t;
}

const LOOP_LENGTHS = [
  [30, '30 s'],
  [60, '1 min'],
  [300, '5 min'],
  [600, '10 min'],
  [1800, '30 min'],
  [3600, '1 hour'],
  [7200, '2 hours'],
];

export default function AudioEditorScreen() {
  const [open, setOpen] = useState(false);
  const t = useAppTheme(open);
  const { height: winH } = useWindowDimensions();

  const [song, setSong] = useState(null);
  const [info, setInfo] = useState(null); // { duration, sampleRate, channels }
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
  const [overW, setOverW] = useState(200);
  const [view, setView] = useState({ start: 0, end: 1 });
  const [peaks, setPeaks] = useState([]);
  const [editing, setEditing] = useState(null); // 'start' | 'end' while typing
  const [typed, setTyped] = useState('');

  const [panel, setPanel] = useState(null); // 'choose' | 'loop' | 'volume' | 'speed' | 'export'
  const [songs, setSongs] = useState(null);
  const [query, setQuery] = useState('');

  // loop settings
  const [loopAlign, setLoopAlign] = useState(true);
  const [loopXf, setLoopXf] = useState(0);
  const [loopFor, setLoopFor] = useState(60);
  const [loopCustom, setLoopCustom] = useState('');
  const [loopFade, setLoopFade] = useState(false);
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState('');
  const [loopPlaying, setLoopPlaying] = useState(false);

  // saving
  const [exportName, setExportName] = useState('');
  const [format, setFormat] = useState('m4a');
  const [saving, setSaving] = useState(false);
  const [prog, setProg] = useState({ f: 0, stage: '' });

  const geo = useRef({});
  const drag = useRef({ x0: 0, mode: 'new', moved: false });
  const ovDrag = useRef({ x0: 0, vs: 0 });
  const openedAt = useRef(0);

  const dur = info ? info.duration : 0;
  const selValid = !!(sel && sel.end - sel.start > 0.02);
  const span = Math.max(0.05, view.end - view.start);
  const lastLoop = ops.slice().reverse().find((o) => o.t === 'loop') || null;
  const repeat = lastLoop ? { loops: lastLoop.loops || 1, fade: lastLoop.fadeOut || 0 } : { loops: 1, fade: 0 };

  // ---------- opening and closing ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openAudioEditor', () => setOpen(true));
    return () => sub.remove();
  }, []);

  const stopPlay = async () => {
    try {
      if (AE) await AE.stop();
    } catch (e) {}
    setPlaying(false);
    setLoopPlaying(false);
  };

  const close = async () => {
    await stopPlay();
    try {
      if (AE) {
        await AE.release();
        await AE.clearExports();
      }
    } catch (e) {}
    setOpen(false);
    setSong(null);
    setInfo(null);
    setOps([]);
    setRedo([]);
    setSel(null);
    setPanel(null);
    setCheck(null);
  };

  const openPanel = async (name) => {
    if (name !== 'choose' && !info) return;
    await stopPlay();
    openedAt.current = Date.now();
    setPanel(name);
  };

  const closePanel = async () => {
    if (saving) return;
    await stopPlay();
    setPanel(null);
  };

  // ---------- choosing a song ----------
  useEffect(() => {
    if (panel !== 'choose' || songs) return undefined;
    let alive = true;
    (async () => {
      try {
        const perm = await MediaLibrary.getPermissionsAsync();
        if (!perm.granted) await MediaLibrary.requestPermissionsAsync();
        let after;
        let more = true;
        const all = [];
        while (more) {
          const p = await MediaLibrary.getAssetsAsync({ mediaType: MediaLibrary.MediaType.audio, first: 1000, after });
          all.push(...p.assets);
          after = p.endCursor;
          more = p.hasNextPage;
        }
        const list = all
          .map((a) => ({ id: String(a.id), uri: a.uri, filename: a.filename || '', title: cleanTitle(a.filename || ''), duration: a.duration || 0 }))
          .sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
        if (alive) setSongs(list);
      } catch (e) {
        if (alive) setSongs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [panel]);

  const loadSong = async (item) => {
    if (Date.now() - openedAt.current < 450) return; // ignore the tap that opened this list
    setPanel(null);
    await stopPlay();
    setSong(item);
    setInfo(null);
    setOps([]);
    setRedo([]);
    setSel(null);
    setPos(0);
    setCheck(null);
    setExportName(String(item.title || 'song') + ' (edited)');
    setLoading('Opening the song…');
    try {
      const r = await AE.open(item.uri);
      setInfo(r);
      setView({ start: 0, end: r.duration });
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
      setView({ start: 0, end: r.duration });
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
      Alert.alert('Select a part first', 'Drag across the waveform, or type a start and end below it.');
      return false;
    }
    return true;
  };

  const range = () => (selValid ? { from: sel.start, to: sel.end } : {});

  // ---------- the waveform ----------
  useEffect(() => {
    if (!AE || !info) return undefined;
    let alive = true;
    const n = Math.max(30, Math.floor(width / 3));
    AE.getPeaks(view.start, view.end, n, false)
      .then((p) => {
        if (alive) setPeaks(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [info, view.start, view.end, width]);

  const clampView = (s, e) => {
    const d = Math.max(0.05, dur);
    let sp = Math.min(d, Math.max(0.5, e - s));
    if (d < 0.5) sp = d;
    let st = Math.max(0, Math.min(d - sp, s));
    return { start: st, end: st + sp };
  };

  const zoomIn = () => {
    const c = selValid ? (sel.start + sel.end) / 2 : pos;
    setView(clampView(c - span / 4, c + span / 4));
  };
  const zoomOut = () => {
    const c = (view.start + view.end) / 2;
    setView(clampView(c - span, c + span));
  };
  const zoomFit = () => setView({ start: 0, end: dur });

  // keep the playhead in sight while playing
  useEffect(() => {
    if (!playing || !info) return;
    if (pos > view.end || pos < view.start) setView(clampView(pos - span * 0.1, pos + span * 0.9));
  }, [pos, playing]);

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

  // ---------- touch on the waveform ----------
  geo.current = { w: width, view: view, span: span, dur: dur, sel: selValid ? sel : null, setSel: setSel, seek: seekTo };
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
          const sx = ((g.sel.start - g.view.start) / g.span) * g.w;
          const ex = ((g.sel.end - g.view.start) / g.span) * g.w;
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
        const tm = Math.max(0, Math.min(g.dur, g.view.start + (x / g.w) * g.span));
        if (d.mode === 'new') {
          const a = Math.max(0, Math.min(g.dur, g.view.start + (d.x0 / g.w) * g.span));
          g.setSel({ start: Math.min(a, tm), end: Math.max(a, tm) });
        } else if (d.mode === 'start' && g.sel) {
          g.setSel({ start: Math.min(tm, g.sel.end - 0.01), end: g.sel.end });
        } else if (d.mode === 'end' && g.sel) {
          g.setSel({ start: g.sel.start, end: Math.max(tm, g.sel.start + 0.01) });
        }
      },
      onPanResponderRelease: () => {
        const g = geo.current;
        const d = drag.current;
        if (!d.moved && g.dur > 0) g.seek(g.view.start + (d.x0 / g.w) * g.span);
      },
    })
  ).current;

  // the thin overview bar under the waveform: drag to move the zoomed window
  const overPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const g = geo.current;
        const x = e.nativeEvent.locationX;
        const tm = (x / g.ow) * g.dur;
        const mid = (g.view.start + g.view.end) / 2;
        // a touch outside the window jumps the window there
        if (tm < g.view.start || tm > g.view.end) g.setView(g.clamp(tm - g.span / 2, tm + g.span / 2));
        ovDrag.current = { x0: x, vs: tm < g.view.start || tm > g.view.end ? tm - g.span / 2 : g.view.start, mid: mid };
      },
      onPanResponderMove: (e, gs) => {
        const g = geo.current;
        const o = ovDrag.current;
        const delta = (gs.dx / g.ow) * g.dur;
        g.setView(g.clamp(o.vs + delta, o.vs + delta + g.span));
      },
    })
  ).current;
  geo.current.ow = overW;
  geo.current.setView = setView;
  geo.current.clamp = clampView;

  // ---------- start and end typed in milliseconds ----------
  const startMs = selValid ? Math.round(sel.start * 1000) : 0;
  const endMs = selValid ? Math.round(sel.end * 1000) : 0;

  const applyTyped = (which, text) => {
    setTyped(text);
    const v = parseInt(text, 10);
    if (!isFinite(v) || v < 0) return;
    const sec = Math.min(dur, v / 1000);
    if (which === 'start') {
      const end = selValid ? sel.end : dur;
      if (sec < end - 0.005) setSel({ start: sec, end: end });
    } else {
      const start = selValid ? sel.start : 0;
      if (sec > start + 0.005) setSel({ start: start, end: sec });
    }
  };

  const nudge = (which, ms) => {
    if (!selValid) return;
    if (which === 'start') {
      const v = Math.max(0, Math.min(sel.end - 0.005, sel.start + ms / 1000));
      setSel({ start: v, end: sel.end });
    } else {
      const v = Math.min(dur, Math.max(sel.start + 0.005, sel.end + ms / 1000));
      setSel({ start: sel.start, end: v });
    }
  };

  // ---------- tools ----------
  const doTrim = () => needSel() && pushOp({ t: 'trim', from: sel.start, to: sel.end });
  const doCut = () => needSel() && pushOp({ t: 'cut', from: sel.start, to: sel.end });
  const doFadeIn = () => pushOp(selValid ? { t: 'fadeIn', from: sel.start, to: sel.end } : { t: 'fadeIn', from: 0, to: Math.min(3, dur) });
  const doFadeOut = () => pushOp(selValid ? { t: 'fadeOut', from: sel.start, to: sel.end } : { t: 'fadeOut', from: Math.max(0, dur - 3), to: dur });
  const doSilence = () => needSel() && pushOp({ t: 'silence', from: sel.start, to: sel.end });
  const doReverse = () => pushOp(Object.assign({ t: 'reverse' }, range()));
  const doGain = (db) => {
    setPanel(null);
    pushOp(Object.assign({ t: 'gain', db: db }, range()));
  };
  const doNormalize = () => {
    setPanel(null);
    pushOp(Object.assign({ t: 'normalize', db: -1 }, range()));
  };
  const doSpeed = (f) => {
    setPanel(null);
    pushOp({ t: 'speed', factor: f });
  };

  // ---------- loop ----------
  const loopSeconds = () => {
    const c = parseFloat(String(loopCustom).replace(',', '.'));
    if (isFinite(c) && c > 0) return Math.min(7200, c * 60);
    return loopFor;
  };

  // body length of one loop (the loop is a little shorter when the picked part starts at the very beginning)
  const bodySeconds = () => {
    if (!check || !info) return 0;
    const len = (check.b - check.a) / info.sampleRate;
    const xfs = check.xf / info.sampleRate;
    return check.a >= check.xf ? len : len - xfs;
  };

  const openLoop = async () => {
    if (!info) return;
    await openPanel('loop');
  };

  // check the picked part whenever it or the settings change
  useEffect(() => {
    if (panel !== 'loop' || !selValid || !AE) return undefined;
    let alive = true;
    setChecking(true);
    setCheckErr('');
    const id = setTimeout(async () => {
      try {
        const r = await AE.analyzeSelection(sel.start, sel.end, loopXf, loopAlign);
        if (alive) setCheck(r);
      } catch (e) {
        if (alive) {
          setCheck(null);
          setCheckErr(e && e.message ? e.message : 'Could not check this part.');
        }
      }
      if (alive) setChecking(false);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [panel, sel ? sel.start : -1, sel ? sel.end : -1, loopXf, loopAlign]);

  const previewLoop = async () => {
    if (!check) return;
    try {
      if (Engine.player && Engine.player.pause) Engine.player.pause();
    } catch (e) {}
    try {
      await AE.previewLoop(check.a, check.b, check.xf);
      setLoopPlaying(true);
    } catch (e) {
      Alert.alert('Could not preview', e && e.message ? e.message : '');
    }
  };

  const stopLoopPreview = async () => {
    await stopPlay();
  };

  const applyLoop = async () => {
    if (!check || !info) return;
    const body = bodySeconds();
    const loops = Math.max(1, Math.round(loopSeconds() / Math.max(0.05, body)));
    await stopPlay();
    const ok = await pushOp({ t: 'loop', a: check.a, b: check.b, xf: check.xf, loops: loops, fadeOut: loopFade ? 3 : 0 });
    if (ok) {
      setPanel(null);
      setCheck(null);
    }
  };

  // ---------- saving ----------
  const totalSec = dur * repeat.loops;
  const wavBytes = totalSec * (info ? info.sampleRate * info.channels * 2 : 0);
  const m4aBytes = totalSec * 24000;

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('AudioEditorProgress', (m) => setProg({ f: m.fraction, stage: m.stage }));
    return () => sub.remove();
  }, []);

  const doExport = async () => {
    await stopPlay();
    setSaving(true);
    setProg({ f: 0, stage: 'Starting' });
    try {
      const name = String(exportName || 'edited').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      const path = format === 'wav' ? await AE.exportWav(name, repeat.loops, repeat.fade) : await AE.exportM4a(name, repeat.loops, repeat.fade);
      setProg({ f: 1, stage: 'Putting it in your Music folder' });
      await saveFile(path, name + (format === 'wav' ? '.wav' : '.m4a'), format === 'wav' ? 'audio/wav' : 'audio/mp4', true);
      try {
        await AE.clearExports();
      } catch (e) {}
      setSaving(false);
      setPanel(null);
      Alert.alert('Saved', 'Saved as "' + name + (format === 'wav' ? '.wav' : '.m4a') + '" in Music / Edited songs. Pull down on your song list to refresh it.');
    } catch (e) {
      setSaving(false);
      Alert.alert('Could not save', e && e.message ? e.message : 'Something went wrong.');
    }
  };

  // ---------- look ----------
  const line = t.track;
  const pill = (label, on, onPress) => (
    <TouchableOpacity
      key={label}
      onPress={onPress}
      activeOpacity={0.8}
      style={{ paddingHorizontal: 13, paddingVertical: 8, borderRadius: 16, marginRight: 8, marginBottom: 8, backgroundColor: on ? t.accent : line }}
    >
      <Text style={{ fontWeight: '700', fontSize: 13, color: on ? t.onAccent : t.text }}>{label}</Text>
    </TouchableOpacity>
  );
  const toggleRow = (label, sub, on, onPress) => (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontWeight: '700', fontSize: 14 }}>{label}</Text>
        {sub ? <Text style={{ color: t.muted, fontSize: 12, marginTop: 1 }}>{sub}</Text> : null}
      </View>
      <View style={{ width: 44, height: 26, borderRadius: 13, backgroundColor: on ? t.accent : line, justifyContent: 'center', padding: 3 }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: on ? t.onAccent : t.muted, alignSelf: on ? 'flex-end' : 'flex-start' }} />
      </View>
    </TouchableOpacity>
  );

  const toX = (sec) => ((sec - view.start) / span) * width;
  const selL = selValid ? Math.max(0, toX(sel.start)) : 0;
  const selR = selValid ? Math.min(width, toX(sel.end)) : 0;
  const headX = toX(pos);
  const barCount = peaks.length || 1;

  const barsView = useMemo(
    () =>
      peaks.map((b, i) => (
        <View
          key={i}
          style={{ width: Math.max(1, width / barCount - 1), marginRight: 1, height: Math.max(2, b * 170), borderRadius: 1.5, backgroundColor: t.accent, opacity: 0.85 }}
        />
      )),
    [peaks, width, t.accent]
  );

  const waveform = !song ? (
    <TouchableOpacity
      onPress={() => openPanel('choose')}
      activeOpacity={0.85}
      style={{ height: 190, borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', borderColor: t.muted, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}
    >
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="add" size={38} color={t.onAccent} />
      </View>
      <Text style={{ color: t.muted, marginTop: 10, fontWeight: '600' }}>Tap to add audio</Text>
    </TouchableOpacity>
  ) : !info ? (
    <View style={{ height: 190, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
      <ActivityIndicator color={t.accent} size="large" />
      <Text style={{ color: t.muted, marginTop: 10 }}>{loading || 'Loading…'}</Text>
    </View>
  ) : (
    <View
      onLayout={(e) => setWidth(Math.max(100, e.nativeEvent.layout.width))}
      style={{ height: 190, borderRadius: 16, backgroundColor: t.card, overflow: 'hidden', marginBottom: 8 }}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' }}>
        {barsView}
      </View>
      {selValid && selR > selL ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: selL, width: Math.max(2, selR - selL), backgroundColor: t.accent, opacity: 0.25 }} />
      ) : null}
      {selValid && toX(sel.start) >= 0 && toX(sel.start) <= width ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: toX(sel.start) - 2, width: 4, backgroundColor: t.text }} />
      ) : null}
      {selValid && toX(sel.end) >= 0 && toX(sel.end) <= width ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: toX(sel.end) - 2, width: 4, backgroundColor: t.text }} />
      ) : null}
      {headX >= 0 && headX <= width ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: headX - 1, width: 2, backgroundColor: '#ff453a' }} />
      ) : null}
    </View>
  );

  const overview = info ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
      <TouchableOpacity onPress={zoomOut} style={{ padding: 6 }}>
        <Ionicons name="remove-circle-outline" size={24} color={t.text} />
      </TouchableOpacity>
      <TouchableOpacity onPress={zoomFit} style={{ padding: 6 }}>
        <Ionicons name="scan-outline" size={22} color={t.text} />
      </TouchableOpacity>
      <TouchableOpacity onPress={zoomIn} style={{ padding: 6 }}>
        <Ionicons name="add-circle-outline" size={24} color={t.text} />
      </TouchableOpacity>
      <View
        onLayout={(e) => setOverW(Math.max(50, e.nativeEvent.layout.width))}
        style={{ flex: 1, height: 22, borderRadius: 11, backgroundColor: line, marginLeft: 8, overflow: 'hidden' }}
        {...overPan.panHandlers}
      >
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 2, bottom: 2, left: (view.start / Math.max(0.001, dur)) * overW, width: Math.max(10, (span / Math.max(0.001, dur)) * overW), borderRadius: 9, backgroundColor: t.accent, opacity: 0.8 }}
        />
      </View>
    </View>
  ) : null;

  const field = (which, label, value) => (
    <View style={{ flex: 1, marginRight: which === 'start' ? 10 : 0 }}>
      <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TouchableOpacity onPress={() => nudge(which, -10)} style={{ width: 30, height: 40, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="remove" size={18} color={t.text} />
        </TouchableOpacity>
        <TextInput
          value={editing === which ? typed : selValid ? String(value) : ''}
          onFocus={() => {
            setEditing(which);
            setTyped(selValid ? String(value) : '');
          }}
          onBlur={() => setEditing(null)}
          onChangeText={(x) => applyTyped(which, x.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          placeholder="ms"
          placeholderTextColor={t.muted}
          style={{ flex: 1, height: 40, borderRadius: 10, backgroundColor: line, color: t.text, textAlign: 'center', fontSize: 14, fontWeight: '700', paddingVertical: 0 }}
        />
        <TouchableOpacity onPress={() => nudge(which, 10)} style={{ width: 30, height: 40, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="add" size={18} color={t.text} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const toolDefs = [
    ['add', 'add-circle-outline', 'Audio', () => openPanel('choose'), true],
    ['trim', 'contract-outline', 'Trim', doTrim, false],
    ['cut', 'cut-outline', 'Cut', doCut, false],
    ['fadein', 'trending-up', 'Fade in', doFadeIn, false],
    ['fadeout', 'trending-down', 'Fade out', doFadeOut, false],
    ['volume', 'volume-high-outline', 'Volume', () => openPanel('volume'), false],
    ['speed', 'speedometer-outline', 'Speed', () => openPanel('speed'), false],
    ['reverse', 'swap-horizontal', 'Reverse', doReverse, false],
    ['silence', 'volume-mute-outline', 'Silence', doSilence, false],
    ['loop', 'infinite-outline', 'Loop', openLoop, false],
  ];

  const toolbar = (
    <View style={{ backgroundColor: t.card, borderTopWidth: 1, borderTopColor: line }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 6 }}>
        {toolDefs.map((x) => {
          const off = !x[4] && !info;
          const on = panel === x[0] || (x[0] === 'add' && panel === 'choose');
          return (
            <TouchableOpacity
              key={x[0]}
              onPress={x[3]}
              disabled={off}
              activeOpacity={0.7}
              style={{ width: 66, alignItems: 'center', paddingVertical: 10, opacity: off ? 0.35 : 1 }}
            >
              <Ionicons name={x[1]} size={23} color={on ? t.accent : t.text} />
              <Text style={{ marginTop: 3, fontSize: 10, fontWeight: '700', color: on ? t.accent : t.muted }} numberOfLines={1}>
                {x[2]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  const editor = (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 10 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 8 }}>
          <Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: '800' }} numberOfLines={1}>
            {song ? song.title : 'No audio yet'}
          </Text>
          {info ? (
            <Text style={{ color: t.muted, fontSize: 12, marginLeft: 8 }}>
              {fmt(pos)} / {fmt(dur)}
            </Text>
          ) : null}
        </View>
        {lastLoop ? (
          <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>
            Loop x{repeat.loops}: saves as {fmtLong(totalSec)} long
          </Text>
        ) : ops.length > 0 ? (
          <Text style={{ color: t.muted, fontSize: 11, marginBottom: 8 }} numberOfLines={2}>
            {ops.map(opLabel).join(' > ')}
          </Text>
        ) : null}

        {waveform}
        {overview}

        {info ? (
          <View style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
              {field('start', 'START (ms)', startMs)}
              {field('end', 'END (ms)', endMs)}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
              <Text style={{ flex: 1, color: t.muted, fontSize: 12 }}>
                {selValid ? 'Selected ' + (sel.end - sel.start).toFixed(3) + ' s' : 'Drag on the waveform, or type start and end'}
              </Text>
              <TouchableOpacity onPress={() => setSel({ start: 0, end: dur })} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: line, marginRight: 8 }}>
                <Text style={{ color: t.text, fontSize: 12, fontWeight: '700' }}>Select all</Text>
              </TouchableOpacity>
              {selValid ? (
                <TouchableOpacity onPress={() => setSel(null)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: line }}>
                  <Text style={{ color: t.text, fontSize: 12, fontWeight: '700' }}>Clear</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        ) : null}

        {info ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
            <TouchableOpacity onPress={() => seekTo(selValid ? sel.start : 0)} style={{ padding: 10 }}>
              <Ionicons name="play-skip-back" size={24} color={t.text} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={togglePlay}
              style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', marginHorizontal: 12 }}
            >
              <Ionicons name={playing ? 'pause' : 'play'} size={27} color={t.onAccent} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setLoopOn(!loopOn)} style={{ padding: 10 }}>
              <Ionicons name="repeat" size={24} color={loopOn ? t.accent : t.muted} />
            </TouchableOpacity>
            {ops.length > 0 ? (
              <TouchableOpacity
                onPress={toggleAB}
                style={{ position: 'absolute', right: 0, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, backgroundColor: useOriginal ? t.accent : line }}
              >
                <Text style={{ color: useOriginal ? t.onAccent : t.text, fontWeight: '700', fontSize: 12 }}>{useOriginal ? 'Original' : 'Edited'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      {toolbar}
    </View>
  );

  // ---------- the panels (they sit inside this screen, above the phone's own buttons) ----------
  const q = query.trim().toLowerCase();
  const shown = songs ? songs.filter((s) => !q || (s.title + ' ' + s.filename).toLowerCase().indexOf(q) >= 0).slice(0, 300) : [];

  const choosePanel = (
    <View style={{ height: winH * 0.66 }}>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: '800', marginBottom: 10 }}>Choose audio</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search songs…"
        placeholderTextColor={t.muted}
        style={{ height: 42, borderRadius: 12, paddingHorizontal: 14, backgroundColor: line, color: t.text, marginBottom: 6 }}
      />
      {!songs ? <ActivityIndicator color={t.accent} style={{ marginTop: 24 }} /> : null}
      {songs && songs.length === 0 ? <Text style={{ color: t.muted, textAlign: 'center', marginTop: 24 }}>No songs found.</Text> : null}
      <FlatList
        data={shown}
        keyExtractor={(it) => it.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <TouchableOpacity onPress={() => loadSong(item)} style={{ paddingVertical: 11 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
              {item.duration ? fmt(item.duration) + '  ' : ''}
              {item.filename}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );

  const body0 = bodySeconds();
  const wantSec = loopSeconds();
  const loops = Math.max(1, Math.round(wantSec / Math.max(0.05, body0)));

  const loopPanel = (
    <View>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: '800' }}>Loop</Text>
      {!selValid ? (
        <View>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 6, marginBottom: 12 }}>
            Pick the part to repeat first. Drag on the waveform, or type a start and end in milliseconds. To loop the whole song, tap Select all.
          </Text>
          <Btn
            t={t}
            label="Select all"
            onPress={() => setSel({ start: 0, end: dur })}
          />
        </View>
      ) : (
        <View>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 4, marginBottom: 10 }}>
            Repeats {fmt(sel.start)} to {fmt(sel.end)} ({(sel.end - sel.start).toFixed(2)} s) with no gap.
          </Text>

          {checking ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <ActivityIndicator color={t.accent} size="small" />
              <Text style={{ color: t.muted, marginLeft: 8, fontSize: 13 }}>Checking the seam…</Text>
            </View>
          ) : check ? (
            <View style={{ backgroundColor: t.card, borderRadius: 14, padding: 12, marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ flex: 1, color: t.text, fontWeight: '800' }}>Seam quality</Text>
                <Text style={{ color: qualityColor(check.quality), fontWeight: '800' }}>
                  {qualityLabel(check.quality)} ({Math.round(check.quality)})
                </Text>
              </View>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: line, marginTop: 8, overflow: 'hidden' }}>
                <View style={{ height: 6, width: Math.round(check.quality) + '%', backgroundColor: qualityColor(check.quality) }} />
              </View>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>
                {loopAlign
                  ? check.shiftMs !== 0
                    ? 'End moved by ' + (check.shiftMs > 0 ? '+' : '') + check.shiftMs + ' ms to line the waveforms up. '
                    : 'The range already lines up. '
                  : 'Your exact range is kept. '}
                Blend {Math.round((check.xf / info.sampleRate) * 1000)} ms.
              </Text>
              {check.quality < 35 ? (
                <Text style={{ color: '#ffb020', fontSize: 12, marginTop: 6 }}>
                  The start and end of this part do not sound alike, so the seam may be noticeable. Try another range, or a longer blend.
                </Text>
              ) : null}
            </View>
          ) : checkErr ? (
            <Text style={{ color: '#ff6b5e', fontSize: 13, marginBottom: 10 }}>{checkErr}</Text>
          ) : null}

          <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', marginBottom: 6 }}>LOOP IT FOR</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {LOOP_LENGTHS.map((x) =>
              pill(x[1], !loopCustom && loopFor === x[0], () => {
                setLoopCustom('');
                setLoopFor(x[0]);
              })
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ color: t.muted, fontSize: 13 }}>or type minutes</Text>
            <TextInput
              value={loopCustom}
              onChangeText={(x) => setLoopCustom(x.replace(/[^0-9.,]/g, ''))}
              keyboardType="decimal-pad"
              placeholder="e.g. 45"
              placeholderTextColor={t.muted}
              style={{ width: 90, height: 36, borderRadius: 10, backgroundColor: line, color: t.text, textAlign: 'center', marginLeft: 10, paddingVertical: 0 }}
            />
          </View>
          {check ? (
            <Text style={{ color: t.text, fontSize: 13, fontWeight: '700', marginBottom: 8 }}>
              {loops} loops, about {fmtLong(loops * body0)} in total
            </Text>
          ) : null}

          <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', marginBottom: 6 }}>BLEND</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {[[0, 'Auto'], [0.02, '20 ms'], [0.1, '100 ms'], [0.5, '0.5 s'], [1, '1 s'], [2, '2 s']].map((x) => pill(x[1], loopXf === x[0], () => setLoopXf(x[0])))}
          </View>

          {toggleRow('Line the end up automatically', 'Moves the end by a few milliseconds for the smoothest seam', loopAlign, () => setLoopAlign(!loopAlign))}
          {toggleRow('Fade out at the end', 'Fades the last 3 seconds', loopFade, () => setLoopFade(!loopFade))}

          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            {loopPlaying ? (
              <Btn t={t} icon="stop" label="Stop preview" alt style={{ flex: 1, marginRight: 8 }} onPress={stopLoopPreview} />
            ) : (
              <Btn t={t} icon="play" label="Preview" alt style={{ flex: 1, marginRight: 8 }} disabled={!check || checking} onPress={previewLoop} />
            )}
            <Btn t={t} icon="checkmark" label="Apply loop" style={{ flex: 1 }} disabled={!check || checking} onPress={applyLoop} />
          </View>
        </View>
      )}
    </View>
  );

  const volumePanel = (
    <View>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: '800' }}>Volume</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 4, marginBottom: 12 }}>
        {selValid ? 'Applies to the selected part.' : 'Applies to the whole audio.'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[-12, -6, -3, 3, 6, 9].map((db) => pill((db > 0 ? '+' : '') + db + ' dB', false, () => doGain(db)))}
      </View>
      <Btn t={t} icon="stats-chart" label="Normalize" style={{ marginTop: 6 }} onPress={doNormalize} />
    </View>
  );

  const speedPanel = (
    <View>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: '800' }}>Speed</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 4, marginBottom: 12 }}>The pitch changes with the speed, like a tape.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{[0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2].map((f) => pill(f + 'x', false, () => doSpeed(f)))}</View>
    </View>
  );

  const exportPanel = (
    <View>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: '800' }}>Save</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 4, marginBottom: 12 }}>
        Saves a new file in Music / Edited songs. Your original song is not changed.
      </Text>
      <TextInput
        value={exportName}
        onChangeText={setExportName}
        editable={!saving}
        placeholder="File name"
        placeholderTextColor={t.muted}
        style={{ backgroundColor: line, color: t.text, borderRadius: 12, paddingHorizontal: 14, height: 44, fontSize: 15, marginBottom: 12 }}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {pill('M4A  (small, about ' + mbText(m4aBytes) + ')', format === 'm4a', () => !saving && setFormat('m4a'))}
        {pill('WAV  (full quality, about ' + mbText(wavBytes) + ')', format === 'wav', () => !saving && setFormat('wav'))}
      </View>
      <Text style={{ color: t.muted, fontSize: 12, marginBottom: 12 }}>Length: {fmtLong(totalSec)}</Text>
      {saving ? (
        <View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: line, overflow: 'hidden' }}>
            <View style={{ height: 8, width: Math.round(prog.f * 100) + '%', backgroundColor: t.accent }} />
          </View>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 8 }}>{prog.stage}</Text>
        </View>
      ) : (
        <Btn t={t} icon="download" label="Save" onPress={doExport} />
      )}
    </View>
  );

  const panelContent = panel === 'choose' ? choosePanel : panel === 'loop' ? loopPanel : panel === 'volume' ? volumePanel : panel === 'speed' ? speedPanel : panel === 'export' ? exportPanel : null;

  const panelView = panel ? (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' }}>
      <TouchableOpacity activeOpacity={1} onPress={closePanel} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} />
      <View style={{ backgroundColor: t.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: winH * 0.78, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10 }}>
        {panel === 'choose' ? (
          panelContent
        ) : (
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {panelContent}
            <View style={{ height: 6 }} />
          </ScrollView>
        )}
      </View>
    </View>
  ) : null;

  const header = info ? (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <TouchableOpacity onPress={undo} disabled={ops.length === 0} style={{ padding: 8, opacity: ops.length === 0 ? 0.35 : 1 }}>
        <Ionicons name="arrow-undo" size={22} color={t.text} />
      </TouchableOpacity>
      <TouchableOpacity onPress={redoOp} disabled={redo.length === 0} style={{ padding: 8, opacity: redo.length === 0 ? 0.35 : 1 }}>
        <Ionicons name="arrow-redo" size={22} color={t.text} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => openPanel('export')}
        style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: t.accent, marginLeft: 4, marginRight: 6 }}
      >
        <Text style={{ color: t.onAccent, fontWeight: '800' }}>Save</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <View pointerEvents="box-none">
      <Modal visible={open} animationType="slide" onRequestClose={panel ? closePanel : close}>
        <Screen t={t} title="Audio Editor" onClose={close} right={header}>
          {AE ? (
            <View style={{ flex: 1 }}>
              {editor}
              {panelView}
              {busy ? (
                <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
                  <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 22, alignItems: 'center' }}>
                    <ActivityIndicator color={t.accent} size="large" />
                    <Text style={{ color: t.text, marginTop: 12, fontWeight: '700' }}>{busy}</Text>
                  </View>
                </View>
              ) : null}
            </View>
          ) : (
            <Text style={{ color: t.muted, padding: 24, textAlign: 'center' }}>The audio editor is not part of this build of the app.</Text>
          )}
        </Screen>
      </Modal>
    </View>
  );
}
