// The Music Finder "Songs" rules, in one place, for the Home Screen search (see HomeFinder.js).
// Everything here is the same as the Songs page in FinderScreen.js: the same online search (iTunes, 25 results),
// the same Apple Music link rules and the same recorded download task. FinderScreen.js itself is not changed.
import { NativeModules, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TASK } from './finderData';

let WebBrowser = null;
try {
  WebBrowser = require('expo-web-browser');
} catch (e) {
  WebBrowser = null;
}

export const TA = NativeModules ? NativeModules.TaskAutomator : null;

// The clipboard watcher in FinderScreen opens Music Finder when you copy an Apple Music link.
// Links copied from here are marked as already seen, so it does not pop open for them.
export const LAST_CLIP_KEY = 'mm_finder_lastclip';

export function appleUrl(u) {
  try {
    const x = new URL(u);
    x.hostname = 'music.apple.com';
    x.searchParams.delete('uo');
    return x.toString();
  } catch (e) {
    return u;
  }
}

export function normaliseLink(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  if (!/music\.apple\.com\//i.test(v)) return null;
  if (!/\/song\//i.test(v) && !/[?&]i=\d+/.test(v)) return null; // a song link, or an album link with ?i=
  return v;
}

async function getJson(url) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
  try {
    const res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) throw new Error('Server said ' + res.status);
    return await res.json();
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw e;
  }
}

// The Songs search of Music Finder: [{ id, title, artist, album, art, preview, apple }]
export async function searchSongsOnline(qIn) {
  const q = String(qIn || '').trim();
  if (!q) return [];
  const data = await getJson('https://itunes.apple.com/search?media=music&entity=song&limit=25&term=' + encodeURIComponent(q));
  return (data.results || []).map((r, i) => ({
    id: String(r.trackId || i),
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName,
    art: r.artworkUrl100,
    preview: r.previewUrl,
    apple: appleUrl(r.trackViewUrl || r.collectionViewUrl),
  }));
}

// The download: the recorded steps, only the song link changes. Same call the Download button in Music Finder makes.
export function runDownload(link) {
  if (!TA || !TA.run) return Promise.reject(new Error('Task Automator is not available in this build.'));
  return TA.run(TASK, link, '#id_url');
}

export async function markLinkSeen(link) {
  const l = normaliseLink(link);
  if (!l) return;
  try {
    await AsyncStorage.setItem(LAST_CLIP_KEY, l);
  } catch (e) {}
}

// Opens a web page inside the app (an in-app browser)
export function openInApp(url) {
  if (!url) return;
  try {
    if (WebBrowser && WebBrowser.openBrowserAsync) {
      WebBrowser.openBrowserAsync(url, { showTitle: true });
      return;
    }
  } catch (e) {}
  Linking.openURL(url).catch(() => {});
}
