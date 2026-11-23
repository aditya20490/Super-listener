/*
 * ==========================================================================================================
 *  KARAOKE (the small K button next to 8D in the player)
 * ==========================================================================================================
 *  What it does: makes an instrumental version of a song with the Vocal Splitter's engine ("Super fast" setting, always),
 *  in the background, one song at a time. The instrumental is NOT a song in your library: it lives in the app's private
 *  folder (no-backup files, so it is deleted when the app is uninstalled), is never indexed, never shown, never shared.
 *  The original file is only read, never changed.
 *
 *  How the switch is seamless (same idea as 8D): when a song that has karaoke starts, the karaoke file is played
 *  SILENTLY next to the normal player (the "shadow", native KaraokeEngine) and kept on the same position. Tapping K only
 *  swaps the volumes over ~40 ms. The normal player keeps running muted as the clock, so the progress bar, the
 *  notification and the lock screen keep working. Tapping K again swaps back.
 *
 *  Rules:
 *    - one karaoke job in the whole app (also refused while the Vocal Splitter screen is working)
 *    - karaoke is deleted 30 days after it was made (silently; no countdown anywhere). Set COUNT_FROM_LAST_USE to true
 *      to count 30 days from the last time K was used instead.
 *    - it works together with 8D: 8D then plays the karaoke file
 *    - records live in AsyncStorage (mm_karaoke_v1), and every finished file also has a small .json next to it, so a
 *      karaoke that finished while the app was closed is picked up on the next start
 *  Connected files: KaraokeButton.js (the button), patch-karaoke.js (adds the button and the hooks into audioEngine.js
 *  at build time), native-karaoke/*.kt (job, encoder, shadow player, bridge), link-karaoke.js (adds them to the build).
 * ==========================================================================================================
 */
import { NativeModules, AppState, ToastAndroid, Platform } from 'react-native';
import { songKey } from './stats';

let AS = null;
try {
  const mod = require('@react-native-async-storage/async-storage');
  AS = mod.default || mod;
} catch (e) {
  AS = null;
}
let TP = null;
let TPEvent = null;
let TPState = null;
try {
  const mod = require('react-native-track-player');
  TP = mod.default || mod;
  TPEvent = mod.Event || null;
  TPState = mod.State || null;
} catch (e) {
  TP = null;
}

const Native = NativeModules ? NativeModules.Karaoke : null;
export const supported = !!Native;

const KEY = 'mm_karaoke_v1';
const SPEED_KEY = 'mm_karaoke_speed_v1';
const EXPIRE_MS = 30 * 86400000;
const COUNT_FROM_LAST_USE = false;

let recs = {}; // song key -> { file, createdAt, usedAt, lagFrames, frames, title }
let started = false;
let loaded = false;
let job = null; // { key, title, duration, t0, progress, etaSec, est }
let pollTimer = null;
let cur = null; // { key, song }  the song loaded in the player
let active = false; // karaoke is what you hear
let shadow = null; // { key }  the silent karaoke player runs for the current song
let dirPath = '';
let speed = 2; // seconds of work per second of song (learned from earlier jobs; this is only the first guess)
let lastFix = 0;
let deadChecks = 0;
let hooks = { isEight: () => false, getVolume: () => 1, refreshEight: async () => {} };
const subs = new Set();
let version = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg) {
  try {
    if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.LONG);
  } catch (e) {}
}

function notify() {
  version += 1;
  subs.forEach((f) => {
    try {
      f();
    } catch (e) {}
  });
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getVersion() {
  return version;
}

export function keyOf(song) {
  if (!song) return '';
  return songKey(song.title, song.artist, song.duration);
}

function baseOf(file) {
  return String(file || '').replace(/\.m4a$/, '');
}

function lagMs(rec) {
  return rec && rec.lagFrames ? Math.round((rec.lagFrames * 1000) / 44100) : 0;
}

export function isExpired(rec, now) {
  const from = COUNT_FROM_LAST_USE ? Math.max(rec.createdAt || 0, rec.usedAt || 0) : rec.createdAt || 0;
  return now - from > EXPIRE_MS;
}

async function saveRecs() {
  try {
    if (AS) await AS.setItem(KEY, JSON.stringify({ v: 1, recs: recs }));
  } catch (e) {}
}

// ---------- looking after the files: pick up finished files, delete old ones ----------
async function maintain() {
  if (!supported) return;
  try {
    const texts = await Native.list();
    const metas = {};
    for (const t of texts || []) {
      try {
        const m = JSON.parse(t);
        if (m && m.key && m.file) metas[m.key] = m;
      } catch (e) {}
    }
    // files that finished while the app was closed
    for (const k in metas) {
      if (!recs[k]) {
        recs[k] = { file: metas[k].file, createdAt: metas[k].createdAt || Date.now(), usedAt: 0, lagFrames: metas[k].lagFrames || 0, frames: metas[k].frames || 0, title: metas[k].title || '' };
      }
    }
    // records whose file is gone
    for (const k in recs) if (!metas[k]) delete recs[k];
    // 30 days passed: delete silently (never the one that is playing right now)
    const now = Date.now();
    for (const k in recs) {
      if (isExpired(recs[k], now) && !(active && cur && cur.key === k)) {
        if (shadow && shadow.key === k) stopShadow();
        try {
          await Native.remove(baseOf(recs[k].file));
        } catch (e) {}
        delete recs[k];
      }
    }
    // left-overs of a crash
    const keep = Object.keys(recs).map((k) => baseOf(recs[k].file));
    try {
      await Native.cleanup(keep);
    } catch (e) {}
    await saveRecs();
    notify();
  } catch (e) {}
}

// ---------- the background job ----------
function fmtEta(sec) {
  const s = Math.max(1, Math.round(sec));
  if (s >= 90) return Math.ceil(s / 60) + ' min';
  if (s >= 60) return '1 min';
  return Math.max(5, Math.ceil(s / 5) * 5) + ' s';
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, 1000);
  poll();
}

async function finishJob(s) {
  const j = job;
  recs[s.key] = { file: s.file, createdAt: Date.now(), usedAt: 0, lagFrames: s.lagFrames || 0, frames: s.frames || 0, title: s.title || '' };
  try {
    Native.ack();
  } catch (e) {}
  if (j && j.duration > 0) {
    const took = (Date.now() - j.t0) / 1000;
    speed = Math.max(0.05, Math.min(5, took / j.duration));
    try {
      if (AS) await AS.setItem(SPEED_KEY, String(speed));
    } catch (e) {}
  }
  job = null;
  stopPoll();
  await saveRecs();
  notify();
  toast('Karaoke is ready: ' + (s.title || 'song'));
  if (cur && cur.key === s.key && !shadow) startShadow();
}

async function poll() {
  if (!supported) return;
  try {
    const s = await Native.status();
    if (s.phase === 'working') {
      if (!job) job = { key: s.key, title: s.title, duration: 0, t0: Date.now(), progress: 0, etaSec: -1, est: 0 };
      job.progress = s.progress || 0;
      job.etaSec = s.etaSec;
      notify();
      return;
    }
    if (s.phase === 'done') {
      await finishJob(s);
      return;
    }
    if (s.phase === 'error') {
      try {
        Native.ack();
      } catch (e) {}
      toast('Could not make karaoke' + (s.error ? ': ' + s.error : ''));
    }
    // idle (finished, failed or cancelled)
    if (job) {
      job = null;
      notify();
    }
    stopPoll();
  } catch (e) {}
}

// 'started' | 'working' | 'busy' | 'error' | 'unsupported'
export async function generate(song) {
  if (!supported) return 'unsupported';
  const key = keyOf(song);
  if (!key || !song || !song.uri) return 'error';
  if (job) return job.key === key ? 'working' : 'busy';
  let r = 'error';
  try {
    r = await Native.generate(String(song.uri), key, song.title || '');
  } catch (e) {
    return 'error';
  }
  if (r === 'busy') return 'busy';
  const dur = song.duration > 0 ? song.duration : 0;
  job = { key: key, title: song.title || '', duration: dur, t0: Date.now(), progress: 0, etaSec: -1, est: (dur || 180) * speed };
  notify();
  startPoll();
  return 'started';
}

export function cancel() {
  if (!supported || !job) return;
  try {
    Native.cancel();
  } catch (e) {}
}

export function busyTitle() {
  return job ? job.title : '';
}

// What the K button should show for this song
export function stateFor(song) {
  if (!supported || !song || song.mka) return { phase: 'hidden' };
  const key = keyOf(song);
  if (!key) return { phase: 'hidden' };
  // a song whose karaoke is already made can always be used, even while another karaoke is being made
  if (recs[key]) return { phase: active && cur && cur.key === key ? 'active' : 'ready' };
  if (job) {
    if (job.key === key) {
      let remain;
      if (job.etaSec >= 0) remain = job.etaSec;
      else remain = Math.max(5, job.est - (Date.now() - job.t0) / 1000);
      return { phase: 'working', progress: job.progress || 0, etaText: fmtEta(remain) };
    }
    return { phase: 'idle', busy: true, busyTitle: job.title };
  }
  return { phase: 'idle' };
}

// ---------- the silent shadow player ----------
async function mainPos() {
  try {
    const p = await TP.getProgress();
    return p && p.position ? p.position : 0;
  } catch (e) {
    return 0;
  }
}

function isPlayingState(s) {
  if (!TPState) return true;
  return s === TPState.Playing || s === TPState.Buffering || s === TPState.Loading;
}

async function mainPlaying() {
  try {
    const st = await TP.getPlaybackState();
    const s = st && st.state !== undefined ? st.state : st;
    return isPlayingState(s);
  } catch (e) {
    return true;
  }
}

function stopShadow() {
  shadow = null;
  deadChecks = 0;
  try {
    if (supported) Native.playerStop();
  } catch (e) {}
}

async function startShadow() {
  if (!supported || !cur || !TP) return false;
  const key = cur.key;
  const rec = recs[key];
  if (!rec) return false;
  const pos = await mainPos();
  const pl = await mainPlaying();
  const vol = active && !hooks.isEight() ? hooks.getVolume() : 0;
  let ok = false;
  try {
    ok = await Native.playerStart(rec.file, pos * 1000, vol, pl, lagMs(rec));
  } catch (e) {
    ok = false;
  }
  if (!cur || cur.key !== key) {
    // the song changed while this was starting
    stopShadow();
    return false;
  }
  shadow = ok ? { key: key } : null;
  lastFix = Date.now();
  return !!ok;
}

async function driftCheck(posSec) {
  if (!shadow) return;
  const now = Date.now();
  let sp = -1;
  try {
    sp = await Native.playerPosition();
  } catch (e) {}
  if (sp < 0) {
    // the shadow player is not running: if you were listening to karaoke, go back to the original sound
    deadChecks += 1;
    if (deadChecks >= 3 && active && !hooks.isEight()) {
      deadChecks = 0;
      let why = '';
      try {
        const st = await Native.playerStatus();
        why = st && st.error ? ' (' + st.error + ')' : '';
      } catch (e) {}
      toast('Karaoke stopped' + why + '. Playing the original again.');
      deactivate();
    }
    return;
  }
  deadChecks = 0;
  if (now - lastFix > 2500 && Math.abs(sp - posSec * 1000) > 150) {
    lastFix = now;
    try {
      Native.playerSeek(posSec * 1000 + 120);
    } catch (e) {}
  }
}

// waits until the silent player really runs; returns '' when it does, or the reason when it does not
async function waitShadowAlive(ms) {
  const t0 = Date.now();
  let err = '';
  while (Date.now() - t0 < ms) {
    try {
      const st = await Native.playerStatus();
      if (st && st.alive) return '';
      if (st && st.error) {
        err = st.error;
        break;
      }
    } catch (e) {
      err = 'no answer';
      break;
    }
    await sleep(100);
  }
  return err || 'it did not start in time';
}

// true when the silent player's position is really moving (so it is making sound)
async function waitShadowMoving(ms) {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < ms) {
    let p = -1;
    try {
      p = await Native.playerPosition();
    } catch (e) {}
    if (last >= 0 && p > last) return true;
    if (p >= 0) last = p;
    await sleep(80);
  }
  return false;
}

async function rampMain(from, to) {
  if (!TP) return;
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    try {
      await TP.setVolume(from + ((to - from) * i) / steps);
    } catch (e) {}
    await sleep(10);
  }
}

// ---------- turning karaoke on and off ----------
export async function activate() {
  if (!supported || !cur || active) return false;
  const rec = recs[cur.key];
  if (!rec) return false;
  const key = cur.key;
  if (!shadow) {
    if (!(await startShadow())) {
      toast('Could not start karaoke for this song.');
      return false;
    }
  }
  // never mute the original unless the karaoke player is really running
  const why = await waitShadowAlive(1500);
  if (why) {
    toast('Karaoke could not start (' + why + '). Playing the original.');
    stopShadow();
    return false;
  }
  const playingNow = await mainPlaying();
  if (playingNow && !(await waitShadowMoving(1500))) {
    toast('Karaoke is not making sound yet. Playing the original.');
    stopShadow();
    return false;
  }
  // make sure both are on the same position before swapping (the original keeps playing while this happens)
  const mp = await mainPos();
  let sp = -1;
  try {
    sp = await Native.playerPosition();
  } catch (e) {}
  if (sp >= 0 && Math.abs(sp - mp * 1000) > 60) {
    try {
      Native.playerSeek(mp * 1000 + 250);
    } catch (e) {}
    lastFix = Date.now();
    if (playingNow && !(await waitShadowMoving(1000))) {
      toast('Karaoke is not making sound yet. Playing the original.');
      stopShadow();
      return false;
    }
  }
  if (!cur || cur.key !== key) return false;
  rec.usedAt = Date.now();
  saveRecs();
  active = true;
  notify();
  if (hooks.isEight()) {
    // 8D is on: the 8D engine plays the karaoke file from now on
    try {
      Native.playerSetVolume(0);
    } catch (e) {}
    await hooks.refreshEight();
    return true;
  }
  const v = hooks.getVolume();
  try {
    Native.playerSetVolume(v);
  } catch (e) {}
  await rampMain(v, 0);
  return true;
}

export async function deactivate() {
  if (!active) return false;
  active = false;
  notify();
  if (hooks.isEight()) {
    await hooks.refreshEight(); // 8D goes back to the original sound
    return true;
  }
  const v = hooks.getVolume();
  try {
    Native.playerSetVolume(0);
  } catch (e) {}
  await rampMain(0, v);
  return true;
}

// ---------- called from audioEngine.js (see patch-karaoke.js) ----------
export function attach(h) {
  hooks = Object.assign(hooks, h || {});
}

export function isActive() {
  return active;
}

// a new song was loaded into the player
export function onLoad(song) {
  try {
    active = false; // the player unmutes itself for a new song
    cur = song && song.uri ? { key: keyOf(song), song: song } : null;
    stopShadow();
    notify();
    if (supported && loaded && cur && recs[cur.key]) startShadow();
  } catch (e) {}
}

export function onSeek(sec) {
  try {
    if (shadow) {
      lastFix = Date.now();
      Native.playerSeek(sec * 1000);
    }
  } catch (e) {}
}

export function setVolume(v) {
  try {
    if (active && !hooks.isEight()) Native.playerSetVolume(v);
  } catch (e) {}
}

// 8D was switched on / off while a karaoke song plays
export function onEightChanged(on) {
  try {
    if (!supported) return;
    if (on) Native.playerSetVolume(0);
    else if (active) Native.playerSetVolume(hooks.getVolume());
  } catch (e) {}
}

// the file the 8D engine should play while karaoke is on (or null: play the original)
export function eightSource(song) {
  if (!active || !cur || !dirPath) return null;
  const rec = recs[cur.key];
  if (!rec) return null;
  return { uri: 'file://' + dirPath + '/' + rec.file, offsetMs: lagMs(rec) };
}

// ---------- start ----------
export async function start() {
  if (started) return;
  started = true;
  if (!supported) return;
  try {
    if (AS) {
      const raw = await AS.getItem(KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (j && j.recs && typeof j.recs === 'object') recs = j.recs;
      }
      const sp = await AS.getItem(SPEED_KEY);
      if (sp && isFinite(parseFloat(sp))) speed = parseFloat(sp);
    }
  } catch (e) {}
  try {
    dirPath = await Native.dir();
  } catch (e) {}
  loaded = true;
  await maintain();
  // a job from before (the app was closed while it worked)?
  try {
    const s = await Native.status();
    if (s && s.phase === 'working') startPoll();
  } catch (e) {}
  if (cur && recs[cur.key] && !shadow) startShadow();
  if (TP && TPEvent) {
    try {
      TP.addEventListener(TPEvent.PlaybackState, (e) => {
        if (!shadow) return;
        const s = e && e.state !== undefined ? e.state : e;
        try {
          Native.playerSetPlaying(isPlayingState(s));
        } catch (err) {}
      });
      TP.addEventListener(TPEvent.PlaybackProgressUpdated, (e) => {
        if (shadow && e) driftCheck(e.position || 0);
      });
    } catch (e) {}
  }
  try {
    AppState.addEventListener('change', (st) => {
      if (st === 'active') maintain();
    });
  } catch (e) {}
}

start();

export const __test = {
  recs: () => recs,
  setCur(c) {
    cur = c;
  },
  setActive(a) {
    active = a;
  },
  job: () => job,
  fmtEta: fmtEta,
};
