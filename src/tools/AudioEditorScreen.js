/*
 * NOTICE TO ANY AI ASSISTANT OR DEVELOPER: this is the in-app Audio Editor (opened from the hamburger menu).
 * Do not rewrite, refactor, rename or "improve" it unless the OWNER of the app asks you to change this exact feature.
 * Ask first if you think something is wrong.
 *
 * How it works: the screen only holds a LIST OF EDITS (trim, cut, fade, volume, loop...). The real audio lives in the
 * native module "AudioEditor" (native-audioedit/*.java). Every change re-applies the whole list to the untouched
 * original, so Undo is just removing the last edit. The song file on the phone is never changed; the result is
 * saved as a new WAV file (Music / Edited songs).
 * Seamless loop: you select a part of the song (finger on the waveform, or the start / end boxes in milliseconds),
 * choose how long the result should be (30 seconds ... 3 hours) and a blend length. The loop is always the LAST edit.
 * Its audio is built on the fly by native-audioedit/LoopSpan.java, so even a one hour loop uses almost no memory.
 * The screen is a plain full-screen layer (not a Modal), so it always sits inside the safe area above the phone's
 * navigation buttons. The native files, link-audioedit.js and patch-finder.js belong together.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  FlatList,
  PanResponder,
  NativeModules,
  DeviceEventEmitter,
  Alert,
  ActivityIndicator,
  BackHandler,
  Keyboard,
  useWindowDimensions,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Engine from '../audioEngine';
import { useAppTheme } from './Tools';
import { cleanTitle } from '../utils';
import { saveFile, FileSystem } from './saver';

const AE = NativeModules ? NativeModules.AudioEditor : null;

const WAVE_H = 190;
const MAX_LOOP_SEC = 3 * 3600;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 1:05.3  (or 1:02:03 for long audio)
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec - h * 3600) / 60);
    const s = Math.floor(sec - h * 3600 - m * 60);
    return h + ':' + pad2(m) + ':' + pad2(s);
  }
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

// 1:05.300 (minutes, seconds and milliseconds) for the start / end boxes
function fmtMs(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const total = Math.round(sec * 1000);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  const msText = ms < 10 ? '00' + ms : ms < 100 ? '0' + ms : String(ms);
  return (h > 0 ? h + ':' + pad2(m) : String(m)) + ':' + pad2(s) + '.' + msText;
}

// "1:05.300", "65.3" or "1:02:03.5" -> seconds (null if it makes no sense)
function parseTime(text) {
  const x = String(text || '')
    .trim()
    .replace(',', '.');
  if (!x) return null;
  const parts = x.split(':');
  if (parts.length > 3) return null;
  let sec = 0;
  for (let i = 0; i < parts.length; i++) {
    const n = parseFloat(parts[i]);
    if (!isFinite(n) || n < 0) return null;
    sec = sec * 60 + n;
  }
  return sec;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  return Math.max(1, Math.round(bytes / (1024 * 1024))) + ' MB';
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export default function AudioEditorScreen() {
  const [open, setOpen] = useState(false);
  const t = useAppTheme(open);
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();

  // song picker (a card inside the editor)
  const [pickOpen, setPickOpen] = useState(false);
  const [lib, setLib] = useState([]);
  const [libLoading, setLibLoading] = useState(false);
  const [q, setQ] = useState('');
  const pickedAt = useRef(0);

  const [song, setSong] = useState(null);
  const [info, setInfo] = useState(null); // { duration, sampleRate, channels, frames, peaks, isLoop }
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

  const [panel, setPanel] = useState(null); // 'loop' | 'volume' | 'speed' | 'export'
  const [exportName, setExportName] = useState('');

  // seamless loop settings
  const [startTxt, setStartTxt] = useState('');
  const [endTxt, setEndTxt] = useState('');
  const [lh, setLh] = useState('0');
  const [lm, setLm] = useState('5');
  const [ls, setLs] = useState('0');
  const [xfSec, setXfSec] = useState(0); // 0 = automatic
  const [prevLoop, setPrevLoop] = useState(false);

  const [kbPad, setKbPad] = useState(0);
  const [colH, setColH] = useState(0); // height of the editor column (shrinks when the keyboard is up)
  const [upH, setUpH] = useState(0);
  const [upContentH, setUpContentH] = useState(0);

  const rootRef = useRef(null);
  const geo = useRef({});
  const drag = useRef({ x0: 0, mode: 'new', moved: false });
  const prevRef = useRef(false);
  const editing = useRef({ s: false, e: false });

  const dur = info ? info.duration : 0;
  const selValid = !!sel && sel.end - sel.start > 0.02;
  const hasLoop = ops.some((o) => o.t === 'loop');

  // ---------- opening ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openAudioEditor', () => setOpen(true));
    return () => sub.remove();
  }, []);

  // keep the bottom panel above the keyboard, whether or not Android already resized the screen
  useEffect(() => {
    if (!open) return undefined;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const top = e && e.endCoordinates ? e.endCoordinates.screenY : 0;
      if (!top || !rootRef.current || !rootRef.current.measureInWindow) return;
      rootRef.current.measureInWindow((x, y, w, h) => {
        const over = y + h - top;
        setKbPad(over > 1 ? over : 0);
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbPad(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [open]);

  const stopPlay = async () => {
    try {
      if (AE) await AE.stop();
    } catch (e) {}
    setPlaying(false);
  };

  // leaves the loop preview and puts the editor's audio back to the real edit list
  const endPreview = async () => {
    if (!prevRef.current) return;
    prevRef.current = false;
    setPrevLoop(false);
    await stopPlay();
    try {
      await AE.render(JSON.stringify(ops));
    } catch (e) {}
  };

  const close = async () => {
    prevRef.current = false;
    await stopPlay();
    try {
      if (AE) await AE.release();
    } catch (e) {}
    setOpen(false);
    setPickOpen(false);
    setSong(null);
    setInfo(null);
    setOps([]);
    setRedo([]);
    setSel(null);
    setPanel(null);
    setPrevLoop(false);
    setPos(0);
    Keyboard.dismiss();
  };

  const closePanel = async () => {
    Keyboard.dismiss();
    await endPreview();
    setPanel(null);
  };

  useEffect(() => {
    if (!open) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pickOpen) {
        setPickOpen(false);
        return true;
      }
      if (panel) {
        closePanel();
        return true;
      }
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, pickOpen, panel, ops]);

  // ---------- choosing a song ----------
  const openPicker = () => {
    pickedAt.current = Date.now();
    setQ('');
    setPickOpen(true);
  };

  useEffect(() => {
    if (!pickOpen) return undefined;
    let alive = true;
    (async () => {
      setLibLoading(true);
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
          .map((a) => ({ id: String(a.id), uri: a.uri, filename: a.filename || '', title: cleanTitle(a.filename || '') }))
          .sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
        if (alive) setLib(list);
      } catch (e) {}
      if (alive) setLibLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [pickOpen]);

  const shown = useMemo(() => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    return lib.filter((it) => tokens.every((k) => (it.title + ' ' + it.filename).toLowerCase().indexOf(k) >= 0)).slice(0, 300);
  }, [lib, q]);

  const loadSong = async (item) => {
    setPickOpen(false);
    Keyboard.dismiss();
    prevRef.current = false;
    setPrevLoop(false);
    await stopPlay();
    setSong(item);
    setInfo(null);
    setOps([]);
    setRedo([]);
    setSel(null);
    setPanel(null);
    setPos(0);
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

  const pickSong = (item) => {
    // ignore a touch that is still left over from opening the card
    if (Date.now() - pickedAt.current < 450) return;
    loadSong(item);
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
    await endPreview();
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
    await endPreview();
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
    await endPreview();
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
      Alert.alert('Select a part first', 'Drag across the waveform to choose the part.');
      return false;
    }
    return true;
  };

  // the loop is the last edit, so nothing else can be added after it
  const guard = (fn) => () => {
    if (!info) return;
    if (hasLoop) {
      Alert.alert('The loop is the last step', 'Undo the loop if you want to edit more.');
      return;
    }
    fn();
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
      if (loopOn && selValid && !hasLoop) {
        const s = Math.max(sel.start, Math.min(from, sel.end - 0.05));
        await AE.play(s, sel.end, sel.start, true, o);
      } else if (loopOn && !hasLoop) {
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
    if (prevRef.current) {
      await endPreview();
      return;
    }
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
        if (p.position >= 0 && !prevRef.current) setPos(p.position);
        if (p.ended || !p.playing) setPlaying(false);
      } catch (e) {}
    }, 100);
    return () => clearInterval(id);
  }, [playing]);

  // a loop preview that played to its end
  useEffect(() => {
    if (!playing && prevRef.current) endPreview();
  }, [playing]);

  const seekTo = async (tm) => {
    if (prevRef.current) {
      await endPreview();
      return;
    }
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
  geo.current = {
    w: width,
    dur: dur,
    sel: selValid ? sel : null,
    setSel: setSel,
    seek: seekTo,
    locked: hasLoop || !info,
    endPrev: endPreview,
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const g = geo.current;
        const x = e.nativeEvent.locationX;
        drag.current = { x0: x, mode: 'new', moved: false };
        if (g.sel && g.dur > 0) {
          const sx = (g.sel.start / g.dur) * g.w;
          const ex = (g.sel.end / g.dur) * g.w;
          const ds = Math.abs(x - sx);
          const de = Math.abs(x - ex);
          if (Math.min(ds, de) < 30) drag.current.mode = ds <= de ? 'start' : 'end';
        }
      },
      onPanResponderMove: (e, gs) => {
        const g = geo.current;
        const d = drag.current;
        if (g.locked) return;
        if (Math.abs(gs.dx) > 4 && !d.moved) {
          d.moved = true;
          if (prevRef.current) g.endPrev();
        }
        if (!d.moved || g.dur <= 0) return;
        const x = Math.max(0, Math.min(g.w, d.x0 + gs.dx));
        const tm = (x / g.w) * g.dur;
        if (d.mode === 'new') {
          const a = (d.x0 / g.w) * g.dur;
          g.setSel({ start: Math.min(a, tm), end: Math.max(a, tm) });
        } else if (d.mode === 'start' && g.sel) {
          g.setSel({ start: Math.max(0, Math.min(tm, g.sel.end - 0.05)), end: g.sel.end });
        } else if (d.mode === 'end' && g.sel) {
          g.setSel({ start: g.sel.start, end: Math.min(g.dur, Math.max(tm, g.sel.start + 0.05)) });
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

  // ---------- seamless loop ----------
  const loopSeconds = Math.min(MAX_LOOP_SEC, (parseInt(lh, 10) || 0) * 3600 + (parseInt(lm, 10) || 0) * 60 + (parseFloat(String(ls).replace(',', '.')) || 0));
  const sectionLen = selValid ? sel.end - sel.start : 0;
  // blend length in seconds for a part of this length (never more than a third of the part)
  const xfFor = (len) => Math.min(xfSec > 0 ? xfSec : Math.min(0.25, Math.max(0.03, len * 0.1)), len / 3);

  const setLength = (sec) => {
    setLh(String(Math.floor(sec / 3600)));
    setLm(String(Math.floor((sec % 3600) / 60)));
    setLs(String(sec % 60));
  };

  const openLoop = async () => {
    await stopPlay();
    if (!selValid) setSel({ start: 0, end: dur });
    setPanel('loop');
  };

  // Takes over a start / end that was typed but not confirmed yet, and returns the part to loop
  const flushRange = () => {
    let s = sel.start;
    let e = sel.end;
    if (editing.current.s) {
      const v = parseTime(startTxt);
      if (v !== null) s = clamp(v, 0, e - 0.05);
      editing.current.s = false;
    }
    if (editing.current.e) {
      const v = parseTime(endTxt);
      if (v !== null) e = clamp(v, s + 0.05, dur);
      editing.current.e = false;
    }
    if (s !== sel.start || e !== sel.end) setSel({ start: s, end: e });
    return { s: s, e: e };
  };

  // the part [a, b), the blend and the total length, all in exact frames
  const loopOp = (r) => {
    const sr = info.sampleRate;
    const total = info.frames || Math.round(dur * sr);
    const a = clamp(Math.round(r.s * sr), 0, total - 2);
    const b = clamp(Math.round(r.e * sr), a + 2, total);
    return { t: 'loop', a: a, b: b, xf: Math.round(xfFor((b - a) / sr) * sr), target: Math.round(loopSeconds * sr) };
  };

  const loopReady = (r) => {
    if (!sel || r.e - r.s < 0.05) {
      Alert.alert('Choose a part', 'Select the part you want to loop on the waveform, or type its start and end.');
      return false;
    }
    if (loopSeconds < 1) {
      Alert.alert('How long?', 'Choose how long the loop should last.');
      return false;
    }
    return true;
  };

  const previewLoop = async () => {
    if (prevRef.current) {
      await endPreview();
      return;
    }
    Keyboard.dismiss();
    const r = flushRange();
    if (!loopReady(r)) return;
    await stopPlay();
    try {
      if (Engine.player && Engine.player.pause) Engine.player.pause();
    } catch (e) {}
    setBusy('Building the preview…');
    try {
      const op = loopOp(r);
      await AE.render(JSON.stringify(ops.concat([op])));
      prevRef.current = true;
      setPrevLoop(true);
      // start a few seconds before the first join, so you hear it
      const sr = info.sampleRate;
      const from = clamp((op.b - op.a - op.xf) / sr - 3, 0, Math.max(0, loopSeconds - 1));
      await AE.play(from, -1, 0, false, false);
      setPlaying(true);
    } catch (e) {
      prevRef.current = false;
      setPrevLoop(false);
      try {
        await AE.render(JSON.stringify(ops));
      } catch (e2) {}
      Alert.alert('Could not preview', e && e.message ? e.message : '');
    }
    setBusy('');
  };

  const applyLoop = async () => {
    Keyboard.dismiss();
    const r = flushRange();
    if (!loopReady(r)) return;
    prevRef.current = false;
    setPrevLoop(false);
    await stopPlay();
    const ok = await pushOp(loopOp(r));
    if (ok) setPanel(null);
  };

  // the start / end boxes
  useEffect(() => {
    if (panel !== 'loop' || !sel) return;
    if (!editing.current.s) setStartTxt(fmtMs(sel.start));
    if (!editing.current.e) setEndTxt(fmtMs(sel.end));
  }, [sel, panel]);

  const commitStart = () => {
    editing.current.s = false;
    if (!sel) return;
    const v = parseTime(startTxt);
    if (v === null) {
      setStartTxt(fmtMs(sel.start));
      return;
    }
    const s = clamp(v, 0, sel.end - 0.05);
    endPreview();
    setSel({ start: s, end: sel.end });
    setStartTxt(fmtMs(s));
  };

  const commitEnd = () => {
    editing.current.e = false;
    if (!sel) return;
    const v = parseTime(endTxt);
    if (v === null) {
      setEndTxt(fmtMs(sel.end));
      return;
    }
    const e2 = clamp(v, sel.start + 0.05, dur);
    endPreview();
    setSel({ start: sel.start, end: e2 });
    setEndTxt(fmtMs(e2));
  };

  const nudge = (which, delta) => {
    if (!sel) return;
    endPreview();
    if (which === 's') setSel({ start: clamp(sel.start + delta, 0, sel.end - 0.05), end: sel.end });
    else setSel({ start: sel.start, end: clamp(sel.end + delta, sel.start + 0.05, dur) });
  };

  // ---------- saving ----------
  const openExport = async () => {
    await endPreview();
    await stopPlay();
    setPanel('export');
  };

  const doExport = async () => {
    Keyboard.dismiss();
    setPanel(null);
    await stopPlay();
    setBusy('Saving…');
    try {
      const name = String(exportName || 'edited').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      const path = await AE.exportWav(name);
      await saveFile(path, name + '.wav', 'audio/wav', true);
      try {
        if (FileSystem && path) await FileSystem.deleteAsync(path.indexOf('file://') === 0 ? path : 'file://' + path, { idempotent: true });
      } catch (e) {}
      Alert.alert('Saved', 'Saved as "' + name + '.wav" in Music / Edited songs. Pull down on your song list to refresh it.');
    } catch (e) {
      Alert.alert('Could not save', e && e.message ? e.message : 'Something went wrong.');
    }
    setBusy('');
  };

  // ---------- look ----------
  const pill = (label, on, onPress) => (
    <TouchableOpacity
      key={label}
      onPress={onPress}
      activeOpacity={0.8}
      style={{ paddingHorizontal: 13, paddingVertical: 8, borderRadius: 16, marginRight: 8, marginBottom: 8, backgroundColor: on ? t.accent : t.track }}
    >
      <Text style={{ fontWeight: '700', fontSize: 13, color: on ? t.onAccent : t.text }}>{label}</Text>
    </TouchableOpacity>
  );

  const label = (text, style) => (
    <Text style={[{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 6 }, style]}>{text}</Text>
  );

  const roundBtn = (icon, onPress) => (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={{ width: 34, height: 40, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={icon} size={18} color={t.text} />
    </TouchableOpacity>
  );

  // one tool in the bottom bar: a small icon with its name under it
  const tool = (icon, name, onPress, active) => (
    <TouchableOpacity key={name} onPress={onPress} activeOpacity={0.7} style={{ width: 64, alignItems: 'center', paddingVertical: 9 }}>
      <Ionicons name={icon} size={22} color={active ? t.accent : t.text} />
      <Text numberOfLines={1} style={{ marginTop: 3, fontSize: 10, fontWeight: '600', color: active ? t.accent : t.muted }}>
        {name}
      </Text>
    </TouchableOpacity>
  );

  const iconBtn = (icon, onPress, disabled) => (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={{ width: 40, height: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.35 : 1 }}>
      <Ionicons name={icon} size={22} color={t.text} />
    </TouchableOpacity>
  );

  const selStartX = selValid ? (sel.start / Math.max(0.001, dur)) * width : 0;
  const selEndX = selValid ? (sel.end / Math.max(0.001, dur)) * width : 0;
  const headX = (pos / Math.max(0.001, dur)) * width;

  let waveInner;
  if (!song) {
    waveInner = (
      <TouchableOpacity onPress={openPicker} activeOpacity={0.8} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 68, height: 68, borderRadius: 34, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="add" size={42} color={t.onAccent} />
        </View>
        <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600', marginTop: 10 }}>Add audio</Text>
      </TouchableOpacity>
    );
  } else if (!info) {
    waveInner = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={t.accent} size="large" />
        <Text style={{ color: t.muted, marginTop: 12 }}>{loading || 'Loading…'}</Text>
      </View>
    );
  } else {
    waveInner = (
      <View style={{ flex: 1 }} {...pan.panHandlers}>
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' }}>
          {bars.map((b, i) => (
            <View
              key={i}
              style={{ width: Math.max(1, width / bars.length - 1), marginRight: 1, height: Math.max(2, b * (WAVE_H - 30)), borderRadius: 1.5, backgroundColor: t.accent, opacity: 0.85 }}
            />
          ))}
        </View>
        {selValid ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: selStartX, width: Math.max(2, selEndX - selStartX), backgroundColor: t.accent, opacity: 0.22 }} />
        ) : null}
        {selValid ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: selStartX - 1.5, width: 3, backgroundColor: t.text }}>
            <View style={{ position: 'absolute', top: 0, left: -5, width: 13, height: 13, borderRadius: 7, backgroundColor: t.text }} />
          </View>
        ) : null}
        {selValid ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: selEndX - 1.5, width: 3, backgroundColor: t.text }}>
            <View style={{ position: 'absolute', bottom: 0, left: -5, width: 13, height: 13, borderRadius: 7, backgroundColor: t.text }} />
          </View>
        ) : null}
        {!prevLoop ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: headX - 1, width: 2, backgroundColor: '#ff453a' }} /> : null}
      </View>
    );
  }

  const waveform = (
    <View
      onLayout={(e) => setWidth(Math.max(100, e.nativeEvent.layout.width))}
      style={{ height: WAVE_H, borderRadius: 16, backgroundColor: t.card, overflow: 'hidden', marginHorizontal: 16 }}
    >
      {waveInner}
    </View>
  );

  // ---------- the panels at the bottom ----------
  const loopPanel = (
    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
      <View style={{ flexDirection: 'row' }}>
        <View style={{ flex: 1, marginRight: 8 }}>
          {label('START')}
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.track, borderRadius: 12 }}>
            {roundBtn('remove', () => nudge('s', -0.01))}
            <TextInput
              value={startTxt}
              onChangeText={setStartTxt}
              onFocus={() => {
                editing.current.s = true;
              }}
              onEndEditing={commitStart}
              onSubmitEditing={commitStart}
              selectTextOnFocus
              keyboardType="numbers-and-punctuation"
              placeholder="0:00.000"
              placeholderTextColor={t.muted}
              style={{ flex: 1, height: 40, textAlign: 'center', color: t.text, fontSize: 14, fontWeight: '700', padding: 0 }}
            />
            {roundBtn('add', () => nudge('s', 0.01))}
          </View>
        </View>
        <View style={{ flex: 1, marginLeft: 8 }}>
          {label('END')}
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.track, borderRadius: 12 }}>
            {roundBtn('remove', () => nudge('e', -0.01))}
            <TextInput
              value={endTxt}
              onChangeText={setEndTxt}
              onFocus={() => {
                editing.current.e = true;
              }}
              onEndEditing={commitEnd}
              onSubmitEditing={commitEnd}
              selectTextOnFocus
              keyboardType="numbers-and-punctuation"
              placeholder="0:00.000"
              placeholderTextColor={t.muted}
              style={{ flex: 1, height: 40, textAlign: 'center', color: t.text, fontSize: 14, fontWeight: '700', padding: 0 }}
            />
            {roundBtn('add', () => nudge('e', 0.01))}
          </View>
        </View>
      </View>
      <Text style={{ color: t.muted, fontSize: 12, marginTop: 6, marginBottom: 12 }}>
        Part to loop: {sectionLen.toFixed(3)} s (m:ss.mmm)
      </Text>

      {label('LOOP FOR')}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[[30, '30 s'], [60, '1 min'], [300, '5 min'], [600, '10 min'], [1800, '30 min'], [3600, '1 hour']].map((x) =>
          pill(x[1], Math.round(loopSeconds) === x[0], () => setLength(x[0]))
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
        {[[lh, setLh, 'h'], [lm, setLm, 'min'], [ls, setLs, 's']].map((x) => (
          <View key={x[2]} style={{ flexDirection: 'row', alignItems: 'center', marginRight: 12 }}>
            <TextInput
              value={x[0]}
              onChangeText={(v) => x[1](v.replace(/[^0-9.]/g, ''))}
              keyboardType="numeric"
              selectTextOnFocus
              maxLength={5}
              style={{ width: 54, height: 40, borderRadius: 12, textAlign: 'center', backgroundColor: t.track, color: t.text, fontSize: 15, fontWeight: '700', padding: 0 }}
            />
            <Text style={{ color: t.muted, marginLeft: 6, fontWeight: '600' }}>{x[2]}</Text>
          </View>
        ))}
        <Text style={{ flex: 1, color: t.muted, fontSize: 12, textAlign: 'right' }}>
          {fmt(loopSeconds)} · about {fmtSize(loopSeconds * (info ? info.sampleRate * info.channels * 2 : 176400))}
        </Text>
      </View>

      {label('BLEND LENGTH')}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[[0, 'Auto'], [0.01, '10 ms'], [0.05, '50 ms'], [0.1, '100 ms'], [0.25, '250 ms'], [0.5, '500 ms'], [1, '1 s']].map((x) =>
          pill(x[1], xfSec === x[0], () => {
            endPreview();
            setXfSec(x[0]);
          })
        )}
      </View>

      <TouchableOpacity
        onPress={previewLoop}
        activeOpacity={0.8}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44, borderRadius: 12, backgroundColor: t.card, marginTop: 4, marginBottom: 14 }}
      >
        <Ionicons name={prevLoop ? 'stop' : 'play'} size={18} color={t.text} />
        <Text style={{ marginLeft: 8, color: t.text, fontWeight: '800', fontSize: 14 }}>{prevLoop ? 'Stop preview' : 'Preview loop'}</Text>
      </TouchableOpacity>
    </View>
  );

  const volumePanel = (
    <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
      {label(selValid ? 'SELECTED PART' : 'WHOLE SONG')}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[-12, -6, -3, 3, 6, 9].map((db) => pill((db > 0 ? '+' : '') + db + ' dB', false, () => doGain(db)))}
      </View>
      {pill('Normalize', false, doNormalize)}
    </View>
  );

  const speedPanel = (
    <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{[0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2].map((f) => pill(f + 'x', false, () => doSpeed(f)))}</View>
    </View>
  );

  const exportPanel = (
    <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
      {label('FILE NAME')}
      <TextInput
        value={exportName}
        onChangeText={setExportName}
        placeholder="File name"
        placeholderTextColor={t.muted}
        style={{ backgroundColor: t.track, color: t.text, borderRadius: 12, paddingHorizontal: 14, height: 46, fontSize: 15, marginBottom: 8 }}
      />
      <Text style={{ color: t.muted, fontSize: 12, marginBottom: 14 }}>
        WAV · about {fmtSize((info ? info.duration * info.sampleRate * info.channels * 2 : 0) || 0)} · Music / Edited songs
      </Text>
    </View>
  );

  const panelTitle = panel === 'loop' ? 'Seamless loop' : panel === 'volume' ? 'Volume' : panel === 'speed' ? 'Speed' : 'Save';
  const panelBody = panel === 'loop' ? loopPanel : panel === 'volume' ? volumePanel : panel === 'speed' ? speedPanel : panel === 'export' ? exportPanel : null;
  const panelApply = panel === 'loop' ? applyLoop : panel === 'export' ? doExport : null;

  const bottomPadNow = kbPad > 0 ? kbPad : insets.bottom;
  const panelMax = colH > 0 ? Math.max(150, Math.round((colH - insets.top - bottomPadNow - 52 - 48) * 0.6)) : Math.round(win.height * 0.5);

  const bottom = panel ? (
    <View style={{ backgroundColor: t.bg, borderTopWidth: 1, borderTopColor: t.track }}>
      <ScrollView style={{ maxHeight: panelMax }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {panelBody}
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 48, paddingHorizontal: 6, borderTopWidth: 1, borderTopColor: t.track }}>
        <TouchableOpacity onPress={closePanel} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="close" size={24} color={t.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontWeight: '800', fontSize: 15 }}>{panelTitle}</Text>
        {panelApply ? (
          <TouchableOpacity onPress={panelApply} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="checkmark" size={26} color={t.accent} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 44 }} />
        )}
      </View>
    </View>
  ) : (
    <View style={{ backgroundColor: t.bg, borderTopWidth: 1, borderTopColor: t.track, opacity: info ? 1 : 0.4 }} pointerEvents={info ? 'auto' : 'none'}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 6 }}>
        {tool('contract', 'Trim', guard(doTrim))}
        {tool('cut', 'Cut', guard(doCut))}
        {tool('trending-up', 'Fade in', guard(doFadeIn))}
        {tool('trending-down', 'Fade out', guard(doFadeOut))}
        {tool('volume-high', 'Volume', guard(() => setPanel('volume')))}
        {tool('volume-mute', 'Silence', guard(doSilence))}
        {tool('swap-horizontal', 'Reverse', guard(doReverse))}
        {tool('speedometer', 'Speed', guard(() => setPanel('speed')))}
        {tool('infinite', 'Loop', guard(openLoop), hasLoop)}
      </ScrollView>
    </View>
  );

  // ---------- the song card ----------
  const pickerCard = pickOpen ? (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
      <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setPickOpen(false)} />
      <View
        style={{
          height: Math.round(win.height * 0.72),
          backgroundColor: t.bg,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          paddingTop: 8,
          paddingBottom: kbPad > 0 ? kbPad : insets.bottom,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 6, height: 46 }}>
          <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: '800' }}>Choose audio</Text>
          <TouchableOpacity onPress={() => setPickOpen(false)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="close" size={24} color={t.text} />
          </TouchableOpacity>
        </View>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search songs…"
          placeholderTextColor={t.muted}
          style={{ marginHorizontal: 16, marginBottom: 8, height: 44, borderRadius: 12, paddingHorizontal: 14, backgroundColor: t.card, color: t.text }}
        />
        {libLoading && lib.length === 0 ? <ActivityIndicator color={t.accent} style={{ marginTop: 20 }} /> : null}
        <FlatList
          data={shown}
          keyExtractor={(it) => it.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => pickSong(item)} style={{ paddingVertical: 12, paddingHorizontal: 18 }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                {item.filename}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>
    </View>
  ) : null;

  if (!open) return null;

  const bottomPad = kbPad > 0 ? kbPad : insets.bottom;

  return (
    <View
      ref={rootRef}
      collapsable={false}
      style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: t.bg, zIndex: 999, elevation: 999 }}
    >
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: bottomPad }} onLayout={(e) => setColH(e.nativeEvent.layout.height)}>
        {/* top bar */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 52 }}>
          <TouchableOpacity onPress={close} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-down" size={28} color={t.text} />
          </TouchableOpacity>
          <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: '800' }}>Audio Editor</Text>
          {song && info ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {iconBtn('arrow-undo', undo, ops.length === 0)}
              {iconBtn('arrow-redo', redoOp, redo.length === 0)}
              {iconBtn('musical-notes', openPicker, false)}
              <TouchableOpacity
                onPress={openExport}
                style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: t.accent, marginLeft: 2, marginRight: 4 }}
              >
                <Text style={{ color: t.onAccent, fontWeight: '800' }}>Save</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        {!AE ? (
          <Text style={{ color: t.muted, padding: 24, textAlign: 'center' }}>The audio editor is not part of this build of the app.</Text>
        ) : (
          <>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 12 }}
              keyboardShouldPersistTaps="handled"
              scrollEnabled={upContentH > upH + 1}
              onLayout={(e) => setUpH(e.nativeEvent.layout.height)}
              onContentSizeChange={(w, h) => setUpContentH(h)}
            >
              {song && info ? (
                <View style={{ paddingHorizontal: 16, marginBottom: 10 }}>
                  <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }} numberOfLines={1}>
                    {song.title}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
                    {fmt(dur)} · {info.sampleRate} Hz · {info.channels === 1 ? 'mono' : 'stereo'}
                    {ops.length > 0 ? ' · ' + ops.length + (ops.length === 1 ? ' edit' : ' edits') : ''}
                  </Text>
                </View>
              ) : (
                <View style={{ height: 8 }} />
              )}

              {waveform}

              {song && info ? (
                <View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 8 }}>
                    <Text style={{ color: t.muted, fontSize: 12 }}>{fmt(pos)}</Text>
                    <Text style={{ color: t.muted, fontSize: 12 }}>
                      {selValid ? fmt(sel.start) + ' – ' + fmt(sel.end) + '  (' + (sel.end - sel.start).toFixed(1) + ' s)' : ''}
                    </Text>
                    <Text style={{ color: t.muted, fontSize: 12 }}>{fmt(dur)}</Text>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, marginTop: 6 }}>
                    <TouchableOpacity onPress={() => seekTo(0)} style={{ padding: 10 }}>
                      <Ionicons name="play-skip-back" size={22} color={t.text} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={togglePlay}
                      style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', marginHorizontal: 6 }}
                    >
                      <Ionicons name={playing ? 'pause' : 'play'} size={26} color={t.onAccent} />
                    </TouchableOpacity>
                    {!hasLoop ? (
                      <TouchableOpacity onPress={() => setLoopOn(!loopOn)} style={{ padding: 10 }}>
                        <Ionicons name="repeat" size={22} color={loopOn ? t.accent : t.muted} />
                      </TouchableOpacity>
                    ) : null}
                    <View style={{ flex: 1 }} />
                    {selValid && !hasLoop ? (
                      <TouchableOpacity onPress={() => setSel(null)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: t.card, marginRight: 8 }}>
                        <Text style={{ color: t.text, fontWeight: '700', fontSize: 12 }}>Clear</Text>
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
                </View>
              ) : null}
            </ScrollView>

            {bottom}
          </>
        )}
      </View>

      {pickerCard}

      {busy ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 22, alignItems: 'center' }}>
            <ActivityIndicator color={t.accent} size="large" />
            <Text style={{ color: t.text, marginTop: 12, fontWeight: '700' }}>{busy}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
