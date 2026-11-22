/*
 * ==========================================================================================================
 *  PERMANENT STATISTICS - READ BEFORE CHANGING ANYTHING IN THIS FILE
 * ==========================================================================================================
 *  What it does: counts what you listen to (plays, skips, seconds listened, per day, per hour) and shows it on
 *  the Statistics screen (StatsScreen.js). The numbers are kept in two places:
 *    1. inside the app (AsyncStorage, key mm_stats_v1), for speed
 *    2. in  /storage/emulated/0/Android/media/com.mymusic.plus/MusicPlus/listening-stats.json
 *       Android does NOT delete Android/media/<package>/ when the app is uninstalled. After a reinstall the file
 *       is read again and the statistics come back, with no login, internet or permission screen.
 *       (listening-history.json, written by persist.js, lives in the same folder and is a separate file.)
 *
 *  Rules for every future update:
 *    - The file name, the folder (MusicPlus), the package name com.mymusic.plus and the JSON format (v: 1) never
 *      change. If a new format is needed, add v: 2 and keep reading v: 1.
 *    - The backup can only GROW: every write is "merge with what is already in the file, keep the bigger number".
 *      Never change it to "overwrite", so an empty or fresh database can never wipe a good backup.
 *    - Songs are matched by a fingerprint (songKey: normalised title + artist + length in seconds), never by the
 *      phone's song id, because ids change after a reinstall or rescan.
 *    - The first restore after a reinstall ADDS the old numbers to the new (empty) ones, later restores keep the
 *      bigger number. This is controlled by the flag mm_stats_restored_v1. Do not rename or remove that flag.
 *    - The first run also imports the play counts that already exist in listening-history.json (the older
 *      history), so nothing counted before this feature is lost. It uses "keep the bigger number".
 *    - Do not move the file to cache or app-private folders. Do not add accounts, servers or permission prompts.
 *
 *  Connected files: stats.js (this file), StatsScreen.js (the screen), reminders.js (uses the numbers for
 *  personal reminders), native-persist/PersistentStoreModule.java (reads and writes the file),
 *  patch-stats.js (adds the screen to the menu at build time).
 * ==========================================================================================================
 */
import { NativeModules, AppState } from 'react-native';

let AS = null;
try {
  const mod = require('@react-native-async-storage/async-storage');
  AS = mod.default || mod;
} catch (e) {
  AS = null;
}
let TP = null;
let TPEvent = null;
try {
  const mod = require('react-native-track-player');
  TP = mod.default || mod;
  TPEvent = mod.Event || (mod.default && mod.default.Event) || null;
} catch (e) {
  TP = null;
}

const Native = NativeModules ? NativeModules.PersistentStore : null;
const KEY = 'mm_stats_v1';
const DONE_KEY = 'mm_stats_restored_v1';
const FILE = 'listening-stats.json';
const OLD_FILE = 'listening-history.json'; // written by persist.js: play counts from before this feature
const KEEP_DAYS = 90; // per-song daily detail is kept for this many days (totals are kept forever)
const SAVE_MS = 30000;

// data.songs[key] = { t: title, a: artist, n: plays, sk: skips, sec: seconds listened, first: ms, last: ms,
//                     d: { 'YYYY-MM-DD': [plays, seconds] } }
// data.days['YYYY-MM-DD'] = [seconds, plays]       data.hours = 24 numbers (seconds listened in each hour)
let data = blank();
let loaded = false;
let started = false;
let dirty = false;
let saveTimer = null;
let saving = false;
let cache = null; // the backup as it is on disk
let lastSaved = 0;
let cur = null; // the song playing right now
let tick = 0;
const subs = new Set();

function blank() {
  const hours = [];
  for (let i = 0; i < 24; i++) hours.push(0);
  return { v: 1, app: 'Music Plus', saved: 0, songs: {}, days: {}, hours: hours };
}

function valid(j) {
  return j && typeof j === 'object' && j.v === 1 && j.songs && typeof j.songs === 'object' && j.days && typeof j.days === 'object';
}

// ---------- song fingerprint (same recipe as persist.js, so the same song gets the same key) ----------
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/, ' ')
    .replace(/[^a-z0-9\u00C0-\uFFFF]+/g, ' ')
    .trim();
}

export function songKey(title, artist, duration) {
  const t = norm(title);
  if (!t) return '';
  return t + '|' + norm(artist) + '|' + Math.round(duration || 0);
}

export function dayKey(ms) {
  const d = new Date(ms);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// ---------- merging (used for the backup and for restoring) ----------
function mergeStats(a, b, add) {
  // a: what is here, b: what comes in. add = true: add the numbers (first restore after a reinstall); false: keep the bigger one.
  const pick = add ? (x, y) => (x || 0) + (y || 0) : (x, y) => Math.max(x || 0, y || 0);
  const out = blank();
  out.saved = Math.max(a.saved || 0, b.saved || 0);
  const copySong = (s) => ({ t: s.t || '', a: s.a || '', n: s.n || 0, sk: s.sk || 0, sec: s.sec || 0, first: s.first || 0, last: s.last || 0, d: Object.assign({}, s.d || {}) });
  for (const k in a.songs) out.songs[k] = copySong(a.songs[k]);
  for (const k in b.songs) {
    const y = b.songs[k];
    const x = out.songs[k];
    if (!x) {
      out.songs[k] = copySong(y);
      continue;
    }
    x.n = pick(x.n, y.n);
    x.sk = pick(x.sk, y.sk);
    x.sec = pick(x.sec, y.sec);
    x.last = Math.max(x.last, y.last || 0);
    x.first = x.first && y.first ? Math.min(x.first, y.first) : x.first || y.first || 0;
    if (!x.t && y.t) x.t = y.t;
    if (!x.a && y.a) x.a = y.a;
    const yd = y.d || {};
    for (const dk in yd) {
      const p = x.d[dk] || [0, 0];
      x.d[dk] = [pick(p[0], yd[dk][0]), pick(p[1], yd[dk][1])];
    }
  }
  const dayList = {};
  for (const dk in a.days) dayList[dk] = a.days[dk];
  for (const dk in b.days) {
    const p = dayList[dk] || [0, 0];
    dayList[dk] = [pick(p[0], b.days[dk][0]), pick(p[1], b.days[dk][1])];
  }
  out.days = dayList;
  for (let i = 0; i < 24; i++) out.hours[i] = pick(a.hours && a.hours[i], b.hours && b.hours[i]);
  prune(out);
  return out;
}

function prune(o) {
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 86400000);
  for (const k in o.songs) {
    const d = o.songs[k].d;
    if (!d) continue;
    for (const dk in d) if (dk < cutoff) delete d[dk];
  }
}

// ---------- reading and writing ----------
async function readFile(name) {
  if (!Native || !Native.read) return null;
  try {
    const raw = await Native.read(name);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  try {
    const raw = await Native.readOld(name); // the newest file was damaged, use the one before it
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

async function readBackup() {
  const j = await readFile(FILE);
  return valid(j) ? j : null;
}

// the older play history (persist.js): counts only, no listening time
async function importOld() {
  const j = await readFile(OLD_FILE);
  if (!j || !j.plays || typeof j.plays !== 'object') return;
  const inc = blank();
  for (const fk in j.plays) {
    const p = j.plays[fk];
    if (!p || typeof p !== 'object') continue;
    if (!(p.n > 0) && !(p.sk > 0)) continue;
    inc.songs[fk] = { t: p.t || '', a: p.a || '', n: p.n || 0, sk: p.sk || 0, sec: 0, first: p.first || 0, last: p.last || 0, d: {} };
  }
  data = mergeStats(data, inc, false);
}

async function persist(final) {
  if (!loaded) return;
  if (saving) {
    dirty = true;
    return;
  }
  saving = true;
  try {
    data.saved = Date.now();
    prune(data);
    if (AS) await AS.setItem(KEY, JSON.stringify(data));
    // the copy outside the app: joined with what the file already has, so it can only grow
    if (Native && Native.write && Object.keys(data.songs).length > 0) {
      if (!cache) cache = (await readBackup()) || blank();
      cache = mergeStats(cache, data, false);
      cache.app = 'Music Plus';
      const ok = await Native.write(FILE, JSON.stringify(cache));
      if (ok) lastSaved = Date.now();
    }
  } catch (e) {}
  saving = false;
  if (dirty && !final) scheduleSave();
}

function scheduleSave() {
  dirty = false;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist(false);
  }, SAVE_MS);
}

function changed() {
  dirty = true;
  scheduleSave();
  subs.forEach((f) => {
    try {
      f();
    } catch (e) {}
  });
}

// ---------- counting ----------
function songEntry(c) {
  let s = data.songs[c.key];
  if (!s) {
    s = { t: c.title, a: c.artist, n: 0, sk: 0, sec: 0, first: 0, last: 0, d: {} };
    data.songs[c.key] = s;
  }
  if (!s.t && c.title) s.t = c.title;
  if (!s.a && c.artist) s.a = c.artist;
  return s;
}

function finishCur() {
  // leaving a song very early counts as a skip
  const c = cur;
  cur = null;
  if (!c || !loaded) return;
  const early = Math.min(20, c.dur > 0 ? c.dur * 0.3 : 20);
  if (!c.counted && c.passSec < early && c.everTicked) {
    songEntry(c).sk += 1;
    changed();
  }
}

// A new track became the active one (track = { id, title, artist, duration })
export function setTrack(track) {
  if (cur && track && cur.id === String(track.id)) return;
  finishCur();
  if (!track || !track.id) return;
  const key = songKey(track.title, track.artist, track.duration);
  if (!key) return;
  cur = {
    id: String(track.id),
    key: key,
    title: track.title || '',
    artist: track.artist || '',
    dur: track.duration > 0 ? track.duration : 0,
    passSec: 0,
    counted: false,
    lastPos: 0,
    lastTick: 0,
    everTicked: false,
  };
}

// The player reports its position once a second while a song is really playing
export function onProgress(position, duration, now) {
  if (!loaded || !cur) return;
  const at = now || Date.now();
  const pos = typeof position === 'number' && isFinite(position) ? position : 0;
  if (duration > 0 && !cur.dur) cur.dur = duration;
  // the song started again from the beginning (repeat): a new round
  if (cur.lastPos > 5 && pos < 3 && cur.lastPos - pos > 5) {
    cur.passSec = 0;
    cur.counted = false;
  }
  cur.lastPos = pos;
  let dt = cur.lastTick ? (at - cur.lastTick) / 1000 : 1;
  cur.lastTick = at;
  // after a pause or a long gap, count one second, not the whole gap
  if (!(dt > 0) || dt > 3) dt = 1;
  cur.everTicked = true;
  cur.passSec += dt;

  const s = songEntry(cur);
  const dk = dayKey(at);
  s.sec += dt;
  if (!s.d[dk]) s.d[dk] = [0, 0];
  s.d[dk][1] += dt;
  if (!data.days[dk]) data.days[dk] = [0, 0];
  data.days[dk][0] += dt;
  const hr = new Date(at).getHours();
  data.hours[hr] = (data.hours[hr] || 0) + dt;

  // half of the song (or a minute) counts as a play
  const need = cur.dur > 0 ? Math.min(cur.dur * 0.5, 60) : 40;
  if (!cur.counted && cur.passSec >= need) {
    cur.counted = true;
    s.n += 1;
    s.last = at;
    if (!s.first) s.first = at;
    s.d[dk][0] += 1;
    data.days[dk][1] += 1;
  }
  changed();
}

async function syncActive() {
  // asks the player which song is active (a safety check, in case a track change was missed)
  if (!TP) return;
  try {
    const tr = await TP.getActiveTrack();
    if (!tr) {
      if (cur) finishCur();
      return;
    }
    setTrack({ id: tr.id, title: tr.title, artist: tr.artist, duration: tr.duration });
  } catch (e) {}
}

// ---------- loading ----------
async function load() {
  let first = false;
  try {
    if (AS) {
      const raw = await AS.getItem(KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (valid(j)) data = j;
      }
      first = (await AS.getItem(DONE_KEY)) !== '1';
    }
  } catch (e) {}
  if (!data.hours || data.hours.length !== 24) data.hours = blank().hours;
  const bk = await readBackup();
  if (bk) {
    cache = bk;
    // first run after a reinstall: add the old numbers to the new (empty) ones. After that: keep the bigger number.
    data = mergeStats(data, bk, first);
  }
  await importOld();
  try {
    if (AS) await AS.setItem(DONE_KEY, '1');
  } catch (e) {}
  loaded = true;
  await persist(true);
  changed();
}

// Starts counting. Safe to call more than once.
export async function start() {
  if (started) return;
  started = true;
  await load();
  if (TP && TPEvent) {
    try {
      TP.addEventListener(TPEvent.PlaybackActiveTrackChanged, (e) => {
        if (e && e.track) setTrack({ id: e.track.id, title: e.track.title, artist: e.track.artist, duration: e.track.duration });
        else syncActive();
      });
      TP.addEventListener(TPEvent.PlaybackProgressUpdated, (e) => {
        tick += 1;
        if (!cur || tick % 6 === 0) syncActive();
        if (e) onProgress(e.position, e.duration, Date.now());
      });
      TP.addEventListener(TPEvent.PlaybackQueueEnded, () => finishCur());
    } catch (e) {}
  }
  syncActive();
  try {
    AppState.addEventListener('change', (st) => {
      if (st !== 'active') persist(true);
    });
  } catch (e) {}
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function isReady() {
  return loaded;
}

export function lastBackup() {
  return lastSaved;
}

export function saveNow() {
  return persist(true);
}

export async function backupInfo() {
  try {
    if (Native && Native.info) return await Native.info();
  } catch (e) {}
  return { available: false, path: '' };
}

// ---------- numbers for the screen and for reminders ----------
const DAY = 86400000;

export function windowKeys(range) {
  const now = Date.now();
  const days = range === 'today' ? 1 : range === '7' ? 7 : range === '30' ? 30 : 0;
  if (!days) return null;
  const out = {};
  for (let i = 0; i < days; i++) out[dayKey(now - i * DAY)] = true;
  return out;
}

export function summary(range) {
  const keys = windowKeys(range); // null = all time
  const songs = [];
  const artists = {};
  let sec = 0;
  let plays = 0;
  for (const k in data.songs) {
    const s = data.songs[k];
    let n = 0;
    let t = 0;
    if (keys) {
      for (const dk in s.d) {
        if (keys[dk]) {
          n += s.d[dk][0];
          t += s.d[dk][1];
        }
      }
    } else {
      n = s.n;
      t = s.sec;
    }
    if (n <= 0 && t < 10) continue;
    sec += t;
    plays += n;
    const an = (s.a || '').trim() || 'Unknown artist';
    if (!artists[an]) artists[an] = { name: an, sec: 0, plays: 0, songs: 0 };
    artists[an].sec += t;
    artists[an].plays += n;
    artists[an].songs += 1;
    songs.push({ key: k, title: s.t || 'Unknown song', artist: s.a || '', plays: n, sec: t, last: s.last || 0, first: s.first || 0, skips: s.sk || 0, d: s.d });
  }
  songs.sort((x, y) => y.plays - x.plays || y.sec - x.sec);
  const topArtists = Object.keys(artists)
    .map((k) => artists[k])
    .sort((x, y) => y.plays - x.plays || y.sec - x.sec);
  return { sec: sec, plays: plays, songsHeard: songs.length, songs: songs, artists: topArtists };
}

// seconds listened on each of the last n days (oldest first)
export function dailySeconds(n) {
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    const ms = now - i * DAY;
    const dk = dayKey(ms);
    const v = data.days[dk];
    out.push({ key: dk, ms: ms, sec: v ? v[0] : 0, plays: v ? v[1] : 0 });
  }
  return out;
}

export function hourSeconds() {
  return data.hours.slice();
}

// number of days in a row (up to today, or up to yesterday if today has no listening yet) with at least a minute of music
export function streak() {
  let n = 0;
  const now = Date.now();
  let i = 0;
  const today = data.days[dayKey(now)];
  if (!today || today[0] < 60) i = 1;
  for (; i < 4000; i++) {
    const v = data.days[dayKey(now - i * DAY)];
    if (v && v[0] >= 60) n += 1;
    else break;
  }
  return n;
}

export function bestDay() {
  let best = null;
  for (const dk in data.days) {
    if (!best || data.days[dk][0] > best.sec) best = { key: dk, sec: data.days[dk][0] };
  }
  return best;
}

export function firstDay() {
  let first = '';
  for (const dk in data.days) if (!first || dk < first) first = dk;
  return first;
}

// last n days of one song: [{ key, plays, sec }] newest first, only days with listening
export function songDays(key, n) {
  const s = data.songs[key];
  const out = [];
  if (!s) return out;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const dk = dayKey(now - i * DAY);
    const v = s.d[dk];
    if (v && (v[0] > 0 || v[1] >= 5)) out.push({ key: dk, ms: now - i * DAY, plays: v[0], sec: v[1] });
  }
  return out;
}

// a few facts used by the personal reminders
export function personalFacts() {
  const all = summary('all');
  const facts = {};
  if (all.songs.length > 0 && all.songs[0].plays >= 2) {
    facts.top = all.songs[0].title;
    facts.topArtist = all.songs[0].artist;
    facts.topPlays = all.songs[0].plays;
  }
  if (all.artists.length > 0 && all.artists[0].name !== 'Unknown artist' && !facts.topArtist) facts.topArtist = all.artists[0].name;
  const now = Date.now();
  // a song you played a lot but not in the last three weeks
  let old = null;
  for (const s of all.songs) {
    if (s.plays >= 3 && s.last > 0 && now - s.last > 21 * DAY) {
      old = s;
      break;
    }
  }
  if (old) {
    facts.old = old.title;
    facts.oldArtist = old.artist;
  }
  // what you played most in the last week
  const week = summary('7');
  if (week.songs.length > 0 && week.songs[0].plays >= 2) {
    facts.recent = week.songs[0].title;
    facts.recentArtist = week.songs[0].artist;
  }
  if (all.sec >= 3600) facts.hours = Math.floor(all.sec / 3600);
  if (all.songsHeard >= 5) facts.songs = all.songsHeard;
  return facts;
}

export function totalSeconds() {
  let sec = 0;
  for (const k in data.songs) sec += data.songs[k].sec || 0;
  return sec;
}

export function hasData() {
  return Object.keys(data.songs).length > 0;
}

// ---- for tests only ----
export const __test = {
  reset() {
    data = blank();
    cur = null;
    loaded = true;
  },
  get: () => data,
  merge: mergeStats,
  blank: blank,
};
