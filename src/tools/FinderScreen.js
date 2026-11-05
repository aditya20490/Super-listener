// Music Finder, built into the player. Same pages as your Music Finder app: Songs (download + search + previews),
// Covers, Lyrics and Automate. It opens from the hamburger menu at the top left of the player, or by itself
// when you copy an Apple Music song link.
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  FlatList,
  Image,
  NativeModules,
  DeviceEventEmitter,
  Linking,
  Alert,
  AppState,
  ActivityIndicator,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Engine from '../audioEngine';
import { Screen, useAppTheme } from './Tools';
import { TASK, COUNTRY_LIST } from './finderData';

let WebBrowser = null;
try {
  WebBrowser = require('expo-web-browser');
} catch (e) {
  WebBrowser = null;
}

const TA = NativeModules ? NativeModules.TaskAutomator : null;
const LAST_CLIP_KEY = 'mm_finder_lastclip';

const NAV = [
  { key: 'songs', label: 'Songs' },
  { key: 'covers', label: 'Covers' },
  { key: 'lyrics', label: 'Lyrics' },
  { key: 'automate', label: 'Automate' },
];

const ENTITIES = [
  { code: 'album', name: 'Album' },
  { code: 'idAlbum', name: 'Apple ID (Album)' },
  { code: 'tvSeason', name: 'TV Show' },
  { code: 'movie', name: 'Movie' },
  { code: 'ebook', name: 'iBook' },
  { code: 'software', name: 'App (iPhone or Universal)' },
  { code: 'iPadSoftware', name: 'App (iPad)' },
  { code: 'macSoftware', name: 'App (macOS)' },
  { code: 'audiobook', name: 'Audiobook' },
  { code: 'podcast', name: 'Podcast' },
  { code: 'musicVideo', name: 'Music Video (may not work)' },
  { code: 'id', name: 'Apple ID (Movie)' },
  { code: 'shortFilm', name: 'Short Film' },
];

// United States and United Kingdom first, then the rest A to Z (the same order as Music Finder)
const ALL_COUNTRIES = COUNTRY_LIST.split('|').map((x) => {
  const i = x.indexOf(':');
  return { code: x.slice(0, i), name: x.slice(i + 1) };
});
const COUNTRIES = [
  { code: 'us', name: 'United States of America' },
  { code: 'gb', name: 'United Kingdom' },
].concat(ALL_COUNTRIES.filter((c) => c.code !== 'us' && c.code !== 'gb').sort((a, b) => a.name.localeCompare(b.name)));

// ---------- the same rules Music Finder uses ----------
function appleUrl(u) {
  try {
    const x = new URL(u);
    x.hostname = 'music.apple.com';
    x.searchParams.delete('uo');
    return x.toString();
  } catch (e) {
    return u;
  }
}

function normaliseLink(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  if (!/music\.apple\.com\//i.test(v)) return null;
  if (!/\/song\//i.test(v) && !/[?&]i=\d+/.test(v)) return null; // a song link, or an album link with ?i=
  return v;
}

function buildSearchUrl(query, entity, country) {
  let ent = entity;
  let shortFilm = false;
  if (ent === 'shortFilm') {
    shortFilm = true;
    ent = 'movie';
  }
  let url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(query) + '&country=' + country + '&entity=' + ent;
  if (shortFilm) url += '&attribute=shortFilmTerm';
  if (entity === 'id' || entity === 'idAlbum') {
    url = 'https://itunes.apple.com/lookup?id=' + encodeURIComponent(query) + '&country=' + country;
  }
  return url + '&limit=25';
}

function processResults(json, entity) {
  const out = [];
  (json.results || []).forEach((r) => {
    if (entity === 'id' && r.kind !== 'feature-movie' && r.wrapperType !== 'collection') return;
    if (entity === 'idAlbum' && r.collectionType !== 'Album') return;
    if (!r.artworkUrl100 && !r.artworkUrl512) return;
    const art = r.artworkUrl100 || r.artworkUrl512;
    const d = {};
    d.url = art.replace('100x100', '600x600');
    let hires = art.replace('100x100bb', '100000x100000-999');
    try {
      hires = 'https://is5-ssl.mzstatic.com' + new URL(hires).pathname;
    } catch (e) {}
    d.hires = hires;
    if (entity === 'album' || entity === 'idAlbum') {
      const parts = hires.split('/image/thumb/');
      if (parts.length === 2) {
        const segs = parts[1].split('/');
        segs.pop();
        d.uncompressed = 'https://is1-ssl.mzstatic.com/image/thumb/' + segs.join('/') + '/3000x3000bb-100.jpg';
      }
    }
    d.title = entity === 'movie' ? r.trackName : r.collectionName;
    switch (entity) {
      case 'musicVideo':
        d.title = r.trackName + ' (by ' + r.artistName + ')';
        d.url = hires;
        break;
      case 'movie':
      case 'id':
      case 'shortFilm':
        d.title = r.trackName || r.collectionName;
        break;
      case 'ebook':
        d.title = r.trackName + ' (by ' + r.artistName + ')';
        break;
      case 'album':
      case 'idAlbum':
      case 'audiobook':
      case 'podcast':
        d.title = r.collectionName + ' (by ' + r.artistName + ')';
        break;
      case 'software':
      case 'iPadSoftware':
      case 'macSoftware':
        d.url = (r.artworkUrl512 || art).replace('512x512bb', '1024x1024bb');
        d.appstore = r.trackViewUrl;
        d.title = r.trackName;
        break;
    }
    if (d.title) out.push(d);
  });
  return out;
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

// Opens a web page inside the app (an in-app browser, so you can press and hold a picture to download it)
function openInApp(url) {
  try {
    if (WebBrowser && WebBrowser.openBrowserAsync) {
      WebBrowser.openBrowserAsync(url, { showTitle: true });
      return;
    }
  } catch (e) {}
  Linking.openURL(url).catch(() => {});
}

// a cover picture at its own shape (albums are square, posters are not)
function CoverImage({ uri, t }) {
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    Image.getSize(
      uri,
      (w, h) => {
        if (w > 0 && h > 0) setRatio(w / h);
      },
      () => {}
    );
  }, [uri]);
  return <Image source={{ uri: uri }} style={{ width: '100%', aspectRatio: ratio, borderRadius: 12, backgroundColor: t.track }} resizeMode="cover" />;
}

export default function FinderScreen() {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const t = useAppTheme(open || menu);
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState('songs');

  // songs
  const [link, setLink] = useState('');
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [songQ, setSongQ] = useState('');
  const [songs, setSongs] = useState(null);
  const [songMsg, setSongMsg] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const previewRef = useRef(null);

  // covers
  const [coverQ, setCoverQ] = useState('');
  const [entity, setEntity] = useState('album');
  const [region, setRegion] = useState('us');
  const [covers, setCovers] = useState(null);
  const [coverMsg, setCoverMsg] = useState('');
  const [isAppEntity, setIsAppEntity] = useState(false);
  const [copied, setCopied] = useState('');
  const entityRef = useRef('album');
  const regionRef = useRef('us');
  entityRef.current = entity;
  regionRef.current = region;

  // lyrics
  const [lyricQ, setLyricQ] = useState('');

  // a pick-from-a-list window (Media, Region)
  const [picker, setPicker] = useState(null);
  const [pickerQ, setPickerQ] = useState('');

  const lastClip = useRef('');

  // ---------- previews: a hidden page plays the 30 second clip, so your music player is not touched ----------
  const stopPreview = () => {
    try {
      if (previewRef.current) previewRef.current.injectJavaScript("var a=document.getElementById('a');if(a){a.pause();}true;");
    } catch (e) {}
    setPlayingId(null);
  };

  const togglePreview = (s) => {
    if (playingId === s.id) {
      stopPreview();
      return;
    }
    try {
      if (Engine.player && Engine.player.pause) Engine.player.pause(); // your own music pauses while you listen to the clip
    } catch (e) {}
    setPlayingId(s.id);
    if (previewRef.current) {
      previewRef.current.injectJavaScript(
        "var a=document.getElementById('a');a.src=" +
          JSON.stringify(s.preview) +
          ";a.onended=function(){window.ReactNativeWebView.postMessage('end')};a.onerror=function(){window.ReactNativeWebView.postMessage('end')};a.play();true;"
      );
    }
  };

  // ---------- songs ----------
  const searchSongs = async (qIn) => {
    const q = String(qIn === undefined ? songQ : qIn).trim();
    if (!q) return;
    stopPreview();
    setSongs(null);
    setSongMsg('Searching...');
    try {
      const data = await getJson('https://itunes.apple.com/search?media=music&entity=song&limit=25&term=' + encodeURIComponent(q));
      const list = (data.results || []).map((r, i) => ({
        id: String(r.trackId || i),
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName,
        art: r.artworkUrl100,
        preview: r.previewUrl,
        apple: appleUrl(r.trackViewUrl || r.collectionViewUrl),
      }));
      setSongs(list);
      setSongMsg(list.length === 0 ? 'Nothing found' : '');
    } catch (e) {
      setSongs([]);
      setSongMsg('Something went wrong, try again');
    }
  };

  // The download. The steps are exactly the recorded ones; only the song link changes each time.
  const startDownload = async () => {
    setLog([]);
    const l = normaliseLink(link);
    if (!l) {
      setLog([{ k: 'bad', m: 'That is not an Apple Music song link.' }]);
      return;
    }
    if (!TA || !TA.run) {
      setLog([{ k: 'bad', m: 'Task Automator is not available in this build.' }]);
      return;
    }
    stopPreview();
    setBusy(true);
    try {
      setLog([{ k: '', m: 'Starting. A browser screen opens and does the steps for you.' }]);
      const out = await TA.run(TASK, l, '#id_url');
      setLog([{ k: 'good', m: 'Running ' + out.steps + ' steps. The file lands in your Downloads folder.' }]);
    } catch (e) {
      setLog([{ k: 'bad', m: 'Could not start: ' + (e && e.message ? e.message : e) }]);
    }
    setTimeout(() => setBusy(false), 1500);
  };

  // ---------- covers ----------
  const searchCovers = async (qIn) => {
    const q = String(qIn === undefined ? coverQ : qIn).trim();
    if (!q) return;
    const ent = entityRef.current;
    setCovers(null);
    setCoverMsg('Searching...');
    try {
      const json = await getJson(buildSearchUrl(q, ent, regionRef.current));
      const list = processResults(json, ent);
      setIsAppEntity(ent === 'software' || ent === 'iPadSoftware' || ent === 'macSoftware');
      setCovers(list);
      setCoverMsg(list.length === 0 ? 'No results found.' : '');
    } catch (e) {
      setCovers([]);
      setCoverMsg('Something went wrong, try again');
    }
  };

  const copyLink = async (url) => {
    try {
      await Clipboard.setStringAsync(url);
      setCopied(url);
    } catch (e) {
      setCopied('');
      Alert.alert('Could not copy');
      return;
    }
    setTimeout(() => setCopied(''), 1800);
  };

  // ---------- lyrics ----------
  const searchLyrics = (qIn) => {
    const q = String(qIn === undefined ? lyricQ : qIn).trim();
    if (!q) return;
    openInApp('https://www.lyricsify.com/search?q=' + encodeURIComponent(q).replace(/%20/g, '+'));
  };

  const openAutomator = () => {
    if (TA && TA.openHome) TA.openHome();
    else Alert.alert('Not available', 'Task Automator is not available in this build.');
  };

  const goTab = (key) => {
    if (key === 'automate') {
      openAutomator();
      return;
    }
    if (key !== 'songs') stopPreview();
    setTab(key);
  };

  // ---------- opening ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openFinder', (p) => {
      const info = p || {};
      const wanted = info.tab || 'songs';
      if (wanted === 'automate') {
        setMenu(false);
        openAutomator();
        return;
      }
      setMenu(false);
      setOpen(true);
      setTab(wanted);
      if (info.link) {
        setLink(info.link);
        setLog([]);
      }
    });
    const sub2 = DeviceEventEmitter.addListener('openFinderMenu', () => setMenu(true));
    return () => {
      sub.remove();
      sub2.remove();
    };
  }, []);

  // Copy an Apple Music song link, open the app, and Music Finder opens by itself with the link filled in
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const txt = await Clipboard.getStringAsync();
        const l = normaliseLink(txt);
        if (!alive || !l || l === lastClip.current) return;
        const saved = await AsyncStorage.getItem(LAST_CLIP_KEY);
        lastClip.current = l;
        if (saved === l) return;
        await AsyncStorage.setItem(LAST_CLIP_KEY, l);
        DeviceEventEmitter.emit('openFinder', { tab: 'songs', link: l });
      } catch (e) {}
    };
    const first = setTimeout(check, 2500);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') setTimeout(check, 600);
    });
    return () => {
      alive = false;
      clearTimeout(first);
      sub.remove();
    };
  }, []);

  const close = () => {
    stopPreview();
    setOpen(false);
  };

  // ---------- look: the Music Finder look in the player's colours ----------
  const line = t.track;
  const panel = { backgroundColor: t.card, borderWidth: 1, borderColor: line, borderRadius: 16, padding: 14, marginBottom: 18 };
  const labelStyle = { color: t.muted, fontSize: 13, fontWeight: '600', marginBottom: 6, marginLeft: 2 };
  const field = {
    backgroundColor: line,
    color: t.text,
    borderWidth: 1,
    borderColor: line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    marginBottom: 12,
  };
  const goBtn = (disabled) => ({
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: t.accent,
    opacity: disabled ? 0.55 : 1,
  });
  const goText = { color: t.onAccent, fontSize: 17, fontWeight: '700' };
  const ghostBtn = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: line,
    backgroundColor: line,
  };

  const Heading = ({ eyebrow, title, lead }) => (
    <View>
      <Text style={{ color: t.accent, fontWeight: '700', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>{eyebrow}</Text>
      <Text style={{ color: t.text, fontSize: 30, fontWeight: '800', marginBottom: 8 }}>{title}</Text>
      <Text style={{ color: t.muted, fontSize: 16, lineHeight: 24, marginBottom: 20 }}>{lead}</Text>
    </View>
  );

  const pickerBox = (labelText, valueText, onPress) => (
    <View>
      <Text style={labelStyle}>{labelText}</Text>
      <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={[field, { flexDirection: 'row', alignItems: 'center' }]}>
        <Text style={{ color: t.text, fontSize: 16, flex: 1 }} numberOfLines={1}>
          {valueText}
        </Text>
        <Ionicons name="chevron-down" size={18} color={t.muted} />
      </TouchableOpacity>
    </View>
  );

  const linkButton = (key, labelText, sub, url, hi) => (
    <TouchableOpacity
      key={key}
      activeOpacity={0.85}
      onPress={() => openInApp(url)}
      style={{
        padding: 13,
        borderRadius: 12,
        marginTop: 8,
        borderWidth: 1,
        borderColor: hi ? t.accent : line,
        backgroundColor: hi ? t.accent : line,
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: '600', color: hi ? t.onAccent : t.text }}>{labelText}</Text>
      <Text style={{ fontSize: 13, marginTop: 2, color: hi ? t.onAccent : t.muted, opacity: hi ? 0.85 : 1 }}>{sub}</Text>
    </TouchableOpacity>
  );

  // ---------- the pages ----------
  const songsPage = (
    <View>
      <Heading
        eyebrow="Apple Music"
        title="Download"
        lead="Paste a song link, tap Download. It is grabbed in the background and saved to your Music folder."
      />
      <View style={panel}>
        <Text style={labelStyle}>Apple Music song link</Text>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="https://music.apple.com/us/song/..."
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={field}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 2 }}>
          <TouchableOpacity
            style={ghostBtn}
            activeOpacity={0.8}
            onPress={async () => {
              try {
                setLink(await Clipboard.getStringAsync());
              } catch (e) {
                setLog([{ k: 'bad', m: 'Clipboard blocked, paste it by hand.' }]);
              }
            }}
          >
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Paste</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={ghostBtn}
            activeOpacity={0.8}
            onPress={() => {
              setLink('');
              setLog([]);
            }}
          >
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Clear</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[goBtn(busy), { flex: 2 }]} activeOpacity={0.85} disabled={busy} onPress={startDownload}>
            <Text style={goText}>Download</Text>
          </TouchableOpacity>
        </View>
        <View style={{ marginTop: 12 }}>
          {log.map((x, i) => (
            <Text key={i} style={{ fontSize: 13, lineHeight: 21, color: x.k === 'bad' ? '#ff453a' : x.k === 'good' ? '#34c759' : t.muted }}>
              {x.m}
            </Text>
          ))}
        </View>
      </View>

      <View style={panel}>
        <Text style={labelStyle}>Song or artist</Text>
        <TextInput
          value={songQ}
          onChangeText={setSongQ}
          placeholder="e.g. Tiffany"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          onSubmitEditing={() => searchSongs()}
          autoCorrect={false}
          style={field}
        />
        <TouchableOpacity style={goBtn(false)} activeOpacity={0.85} onPress={() => searchSongs()}>
          <Text style={goText}>Search</Text>
        </TouchableOpacity>
      </View>

      {songs === null && songMsg ? (
        <View style={{ alignItems: 'center', padding: 24 }}>
          <ActivityIndicator color={t.accent} />
          <Text style={{ color: t.muted, marginTop: 10 }}>{songMsg}</Text>
        </View>
      ) : null}
      {songs && songs.length === 0 && songMsg ? <Text style={{ color: t.muted, textAlign: 'center', padding: 28 }}>{songMsg}</Text> : null}
      {songs
        ? songs.map((s) => (
            <TouchableOpacity
              key={s.id}
              activeOpacity={0.85}
              onPress={() => openInApp(s.apple)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                backgroundColor: t.card,
                borderWidth: 1,
                borderColor: line,
                borderRadius: 14,
                padding: 10,
                marginBottom: 10,
              }}
            >
              <Image source={{ uri: s.art }} style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: line }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: t.text, fontWeight: '700' }} numberOfLines={1}>
                  {s.title}
                </Text>
                <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }} numberOfLines={1}>
                  {s.artist + ' • ' + s.album}
                </Text>
              </View>
              {s.preview ? (
                <TouchableOpacity
                  onPress={() => togglePreview(s)}
                  activeOpacity={0.8}
                  style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: line }}
                >
                  <Text style={{ color: t.text, fontWeight: '600', fontSize: 14 }}>{playingId === s.id ? 'Stop' : 'Preview'}</Text>
                </TouchableOpacity>
              ) : null}
            </TouchableOpacity>
          ))
        : null}
    </View>
  );

  const coversPage = (
    <View>
      <Heading
        eyebrow="iTunes Artwork Finder"
        title="Album Cover"
        lead="Same method as the real artwork finder: standard and uncompressed covers."
      />
      <View style={panel}>
        {pickerBox('Media', (ENTITIES.find((e) => e.code === entity) || {}).name || entity, () => {
          setPickerQ('');
          setPicker({ title: 'Media', items: ENTITIES, value: entity, onPick: setEntity, search: false });
        })}
        {pickerBox('Region', (COUNTRIES.find((c) => c.code === region) || {}).name || region.toUpperCase(), () => {
          setPickerQ('');
          setPicker({ title: 'Region', items: COUNTRIES, value: region, onPick: setRegion, search: true });
        })}
        <Text style={labelStyle}>Search</Text>
        <TextInput
          value={coverQ}
          onChangeText={setCoverQ}
          placeholder="e.g. Montero"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          onSubmitEditing={() => searchCovers()}
          autoCorrect={false}
          style={field}
        />
        <TouchableOpacity style={goBtn(false)} activeOpacity={0.85} onPress={() => searchCovers()}>
          <Text style={goText}>Get the artwork</Text>
        </TouchableOpacity>
      </View>

      {covers === null && coverMsg ? (
        <View style={{ alignItems: 'center', padding: 24 }}>
          <ActivityIndicator color={t.accent} />
          <Text style={{ color: t.muted, marginTop: 10 }}>{coverMsg}</Text>
        </View>
      ) : null}
      {covers && covers.length === 0 && coverMsg ? <Text style={{ color: t.muted, textAlign: 'center', padding: 28 }}>{coverMsg}</Text> : null}
      {covers && covers.length > 0 ? (
        <View>
          <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20, marginHorizontal: 2, marginTop: 4, marginBottom: 18 }}>
            Tap a button to open the image, then press and hold it to download. If the item is not on iTunes, this tool will not find it.
          </Text>
          {covers.map((d, i) => (
            <View key={i} style={{ backgroundColor: t.card, borderWidth: 1, borderColor: line, borderRadius: 18, padding: 12, marginBottom: 16 }}>
              <CoverImage uri={d.url} t={t} />
              <Text style={{ color: t.text, fontSize: 18, fontWeight: '700', marginTop: 12, marginHorizontal: 4, marginBottom: 10, lineHeight: 24 }}>
                {d.title}
              </Text>
              {isAppEntity ? (
                <View>
                  {linkButton('icon', 'App icon', '1024 × 1024', d.url, true)}
                  {d.appstore ? linkButton('store', 'View on the App Store', 'Opens the store page', d.appstore, false) : null}
                </View>
              ) : (
                <View>
                  {linkButton('std', 'Standard Resolution', '600 × 600', d.url, false)}
                  {d.uncompressed ? (
                    <View>
                      {linkButton('unc', 'Uncompressed High Resolution', 'Full quality, 3000 × 3000 (large file)', d.uncompressed, true)}
                      <TouchableOpacity onPress={() => copyLink(d.uncompressed)} activeOpacity={0.7} style={{ padding: 10, alignItems: 'center', marginTop: 4 }}>
                        <Text style={{ color: t.muted, fontSize: 14 }}>{copied === d.uncompressed ? 'Copied' : 'Copy uncompressed link'}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    linkButton('hi', 'High Resolution', 'Largest version available', d.hires, true)
                  )}
                </View>
              )}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );

  const lyricsPage = (
    <View>
      <Heading
        eyebrow="Lyricsify"
        title="Search Lyrics"
        lead="Type a song or artist. The real Lyricsify page opens right inside the app."
      />
      <View style={panel}>
        <Text style={labelStyle}>Song or artist</Text>
        <TextInput
          value={lyricQ}
          onChangeText={setLyricQ}
          placeholder="e.g. Lil Nas X"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          onSubmitEditing={() => searchLyrics()}
          autoCorrect={false}
          style={field}
        />
        <TouchableOpacity style={goBtn(false)} activeOpacity={0.85} onPress={() => searchLyrics()}>
          <Text style={goText}>Search</Text>
        </TouchableOpacity>
      </View>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20, marginHorizontal: 2 }}>
        Use the close button on the top left of the opened page to come back here.
      </Text>
    </View>
  );

  let page = songsPage;
  if (tab === 'covers') page = coversPage;
  else if (tab === 'lyrics') page = lyricsPage;

  const pickerItems = picker
    ? picker.search && pickerQ.trim()
      ? picker.items.filter((c) => c.name.toLowerCase().includes(pickerQ.trim().toLowerCase()) || c.code === pickerQ.trim().toLowerCase())
      : picker.items
    : [];

  const menuItem = (key, icon, title, sub) => (
    <TouchableOpacity
      key={key}
      activeOpacity={0.8}
      onPress={() => DeviceEventEmitter.emit('openFinder', { tab: key })}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 12, borderRadius: 14 }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: t.card, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={19} color={t.accent} />
      </View>
      <View style={{ marginLeft: 14, flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 1 }}>{sub}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View pointerEvents="box-none">
      {/* the hamburger menu */}
      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: '80%', maxWidth: 340, backgroundColor: t.bg, paddingTop: insets.top + 16, paddingHorizontal: 12, paddingBottom: insets.bottom + 16 }}>
            <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', marginHorizontal: 12 }}>Menu</Text>
            <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginHorizontal: 12, marginTop: 22, marginBottom: 6 }}>
              Music Finder
            </Text>
            {menuItem('songs', 'musical-notes', 'Songs', 'Download from Apple Music, find songs')}
            {menuItem('covers', 'image', 'Covers', 'Standard and uncompressed album art')}
            {menuItem('lyrics', 'document-text', 'Lyrics', 'Search Lyricsify')}
            {menuItem('automate', 'flash', 'Automate', 'Open Task Automator')}
          </View>
          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }} activeOpacity={1} onPress={() => setMenu(false)} />
        </View>
      </Modal>

      {/* Music Finder */}
      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <Screen t={t} title="Music Finder" onClose={close}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 30 }}>
            {page}
          </ScrollView>
          <View style={{ flexDirection: 'row', backgroundColor: t.card, borderTopWidth: 1, borderTopColor: line }}>
            {NAV.map((x) => (
              <TouchableOpacity key={x.key} activeOpacity={0.7} onPress={() => goTab(x.key)} style={{ flex: 1, paddingVertical: 16, alignItems: 'center' }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: tab === x.key && x.key !== 'automate' ? t.accent : t.muted }}>{x.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Screen>

        {/* hidden: plays the preview clips */}
        <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} pointerEvents="none">
          <WebView
            ref={previewRef}
            originWhitelist={['*']}
            source={{ html: '<html><body><audio id="a" preload="none"></audio></body></html>' }}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback
            onMessage={() => setPlayingId(null)}
          />
        </View>

        <Modal visible={!!picker} animationType="fade" transparent onRequestClose={() => setPicker(null)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
            <View style={{ backgroundColor: t.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: '800' }}>{picker ? picker.title : ''}</Text>
                <TouchableOpacity onPress={() => setPicker(null)}>
                  <Ionicons name="close" size={26} color={t.text} />
                </TouchableOpacity>
              </View>
              {picker && picker.search ? (
                <TextInput
                  value={pickerQ}
                  onChangeText={setPickerQ}
                  placeholder="Search a country"
                  placeholderTextColor={t.muted}
                  style={[field, { marginBottom: 6 }]}
                />
              ) : null}
              <FlatList
                data={pickerItems}
                keyExtractor={(c) => c.code}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <TouchableOpacity
                    onPress={() => {
                      picker.onPick(item.code);
                      setPicker(null);
                    }}
                    style={{ paddingVertical: 13, flexDirection: 'row', alignItems: 'center' }}
                  >
                    <Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: picker && item.code === picker.value ? '800' : '500' }}>{item.name}</Text>
                    {picker && item.code === picker.value ? <Ionicons name="checkmark" size={20} color={t.accent} /> : null}
                  </TouchableOpacity>
                )}
              />
            </View>
          </View>
        </Modal>
      </Modal>
    </View>
  );
}
