// Keeps a small copy of your listening history (play counts, skips, time of day, favorites, artist tags) in a file
// that Android does not delete when the app is uninstalled: Android/media/<package>/MusicPlus/. This is the same
// place big apps use for backups. After a reinstall, the history is matched back to your songs and restored,
// without any account, internet or permission screen. It is only text, usually well under 1 MB.
//
// How songs are matched: not by the phone's song id (that can change), but by a fingerprint made from the song's
// title, artist and length. So the history still finds the song after a reinstall, a rescan, or a move to another folder.
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Store from '../foryou/store';

const Native = NativeModules ? NativeModules.PersistentStore : null;
const FILE = 'listening-history.json';
const DONE_KEY = 'mm_persist_restored_v1';
const KEEP_MS = 365 * 86400000; // history of songs that are no longer on the phone is kept for a year, in case they come back
const CHECK_MS = 30000;

let lib = { keyOf: new Map(), idByKey: new Map(), title: new Map(), ready: false };
let favIds = new Set();
let synced = false;
let cache = null; // the backup as it is on disk
let writing = false;
let again = false;
let lastSig = '';
let favsDirty = false;
let watcher = null;
let favTimer = null;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/, ' ')
    .replace(/[^a-z0-9\u00C0-\uFFFF]+/g, ' ')
    .trim();
}

export function songKey(s) {
  let title = norm(s.title);
  if (!title) title = norm(String(s.filename || '').replace(/\.[A-Za-z0-9]{2,5}$/, ''));
  if (!title) return '';
  return title + '|' + norm(s.artist) + '|' + Math.round(s.duration || 0);
}

function buildLib(songs) {
  const keyOf = new Map();
  const idByKey = new Map();
  const title = new Map();
  for (const s of songs) {
    if (!s || !s.id) continue;
    const k = songKey(s);
    if (!k) continue;
    keyOf.set(s.id, k);
    title.set(k, [s.title || '', s.artist || '']);
    if (!idByKey.has(k)) idByKey.set(k, s.id);
  }
  lib = { keyOf: keyOf, idByKey: idByKey, title: title, ready: keyOf.size > 0 };
}

function mergeEntry(a, b, add) {
  // a: the entry already here (or nothing), b: the entry coming in. add = true: add the counts together (first restore after a reinstall).
  const x = a || { n: 0, sk: 0, last: 0, first: 0, sl: [0, 0, 0, 0] };
  const y = b || { n: 0, sk: 0, last: 0, first: 0, sl: [0, 0, 0, 0] };
  const pick = add ? (p, q) => (p || 0) + (q || 0) : (p, q) => Math.max(p || 0, q || 0);
  const sl = [];
  for (let i = 0; i < 4; i++) sl.push(pick(x.sl && x.sl[i], y.sl && y.sl[i]));
  const fa = x.first || 0;
  const fb = y.first || 0;
  return {
    n: pick(x.n, y.n),
    sk: pick(x.sk, y.sk),
    last: Math.max(x.last || 0, y.last || 0),
    first: fa && fb ? Math.min(fa, fb) : fa || fb,
    sl: sl,
  };
}

function valid(j) {
  return j && typeof j === 'object' && j.v === 1 && j.plays && typeof j.plays === 'object';
}

async function readBackup() {
  if (!Native || !Native.read) return null;
  try {
    const raw = await Native.read(FILE);
    if (raw) {
      const j = JSON.parse(raw);
      if (valid(j)) return j;
    }
  } catch (e) {}
  try {
    const raw = await Native.readOld(FILE); // the newest file was damaged, use the one before it
    if (raw) {
      const j = JSON.parse(raw);
      if (valid(j)) return j;
    }
  } catch (e) {}
  return null;
}

function signature() {
  const plays = Store.getTaste().plays;
  let c = 0;
  let sum = 0;
  for (const id in plays) {
    c++;
    sum += (plays[id].n || 0) + (plays[id].sk || 0);
  }
  return c + ':' + sum;
}

async function writeBackup() {
  if (!Native || !Native.write || !lib.ready || !synced) return;
  if (writing) {
    again = true;
    return;
  }
  writing = true;
  try {
    if (!cache) cache = (await readBackup()) || { v: 1, plays: {}, favs: {}, tags: {} };
    const now = Date.now();
    const plays = Store.getTaste().plays;

    // your history now, joined with what the backup already had. It can only grow, so an empty or fresh
    // database can never wipe a good backup.
    for (const id in plays) {
      const fk = lib.keyOf.get(id);
      if (!fk) continue;
      const m = mergeEntry(cache.plays[fk], plays[id], false);
      const t = lib.title.get(fk) || ['', ''];
      m.ls = now;
      m.t = t[0];
      m.a = t[1];
      cache.plays[fk] = m;
    }
    // songs that are on the phone right now are marked as seen
    lib.idByKey.forEach((id, fk) => {
      if (cache.plays[fk]) cache.plays[fk].ls = now;
    });

    // favorites: what is favorite now, plus favorites of songs that are not on the phone at the moment
    const favs = {};
    const oldFavs = cache.favs || {};
    for (const fk in oldFavs) {
      if (!lib.idByKey.has(fk) && now - (oldFavs[fk] || 0) < KEEP_MS) favs[fk] = oldFavs[fk];
    }
    favIds.forEach((id) => {
      const fk = lib.keyOf.get(id);
      if (fk) favs[fk] = now;
    });
    cache.favs = favs;

    // what the internet told us about your artists (so it does not need to ask again)
    const tags = cache.tags || {};
    const local = Store.getArtistTags();
    for (const k in local) if (Array.isArray(local[k])) tags[k] = local[k];
    cache.tags = tags;

    // forget songs that have been gone for over a year
    for (const fk in cache.plays) {
      if (now - (cache.plays[fk].ls || 0) > KEEP_MS) delete cache.plays[fk];
    }

    cache.v = 1;
    cache.app = 'Music Plus';
    cache.saved = now;
    const ok = await Native.write(FILE, JSON.stringify(cache));
    if (ok) lastSig = signature();
  } catch (e) {}
  writing = false;
  favsDirty = false;
  if (again) {
    again = false;
    setTimeout(writeBackup, 2000);
  }
}

// Called once the song list is ready: brings the history back after a reinstall, then starts keeping the copy up to date.
export async function sync(songs, favs, applyFavs) {
  if (!Native || !Native.read) return;
  await Store.loadForYouData();
  buildLib(songs);
  if (!lib.ready) return;

  const bk = await readBackup();
  const first = (await AsyncStorage.getItem(DONE_KEY)) !== '1';
  const plays = Store.getTaste().plays;
  let changed = false;

  if (bk) {
    // play history: first time after a reinstall the old counts are added to anything already counted;
    // after that it is a plain "keep the bigger number", which never double counts.
    for (const fk in bk.plays) {
      const id = lib.idByKey.get(fk);
      if (!id) continue;
      plays[id] = mergeEntry(plays[id], bk.plays[fk], first);
      changed = true;
    }
    // favorites come back after a reinstall (or when this phone has none)
    if (applyFavs && bk.favs && (first || !favs || favs.size === 0)) {
      const add = [];
      for (const fk in bk.favs) {
        const id = lib.idByKey.get(fk);
        if (id && !(favs && favs.has(id))) add.push(id);
      }
      if (add.length > 0) {
        const next = new Set(favs || []);
        add.forEach((i) => next.add(i));
        favs = next;
        applyFavs(next);
      }
    }
    // artist tags we already learned
    if (bk.tags) {
      for (const k in bk.tags) {
        if (Array.isArray(bk.tags[k]) && !Store.hasArtistTags(k)) {
          Store.setArtistTags(k, bk.tags[k]);
          changed = true;
        }
      }
    }
  }

  await AsyncStorage.setItem(DONE_KEY, '1');
  if (changed) Store.flushNow();
  cache = bk;
  favIds = new Set(favs || []);
  synced = true;
  await writeBackup();

  if (!watcher) {
    // every half minute: if your history changed, update the backup
    watcher = setInterval(() => {
      if (signature() !== lastSig || favsDirty) writeBackup();
    }, CHECK_MS);
  }
}

// Called when the favorites change
export function noteFavs(favs) {
  if (!synced) return;
  favIds = new Set(favs || []);
  favsDirty = true;
  if (favTimer) clearTimeout(favTimer);
  favTimer = setTimeout(writeBackup, 4000);
}

// Called when the app goes to the background, so nothing is left unsaved
export function flush() {
  if (!synced) return;
  if (signature() !== lastSig || favsDirty) writeBackup();
}
