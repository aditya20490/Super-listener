// Music Finder, built into the player. Songs (with previews and the Apple Music downloader), Covers, Lyrics and Task Automator.
// It opens from the "Find it online" card in your song list, or by itself when you copy an Apple Music song link.
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Engine from '../audioEngine';
import { Screen, Btn, useAppTheme } from './Tools';
import { downloadToCache, saveFile } from './saver';
import { TASK, COUNTRY_LIST } from './finderData';

const TA = NativeModules ? NativeModules.TaskAutomator : null;
const LAST_CLIP_KEY = 'mm_finder_lastclip';

const TABS = [
  { key: 'songs', label: 'Songs', icon: 'musical-notes' },
  { key: 'covers', label: 'Covers', icon: 'image' },
  { key: 'lyrics', label: 'Lyrics', icon: 'document-text' },
  { key: 'automate', label: 'Automate', icon: 'flash' },
];

const ENTITIES = [
  ['album', 'Album'],
  ['idAlbum', 'Apple ID (Album)'],
  ['tvSeason', 'TV Show'],
  ['movie', 'Movie'],
  ['ebook', 'iBook'],
  ['software', 'App (iPhone)'],
  ['iPadSoftware', 'App (iPad)'],
  ['macSoftware', 'App (macOS)'],
  ['audiobook', 'Audiobook'],
  ['podcast', 'Podcast'],
  ['musicVideo', 'Music Video'],
  ['id', 'Apple ID (Movie)'],
  ['shortFilm', 'Short Film'],
];

const COUNTRIES = COUNTRY_LIST.split('|')
  .map((x) => {
    const i = x.indexOf(':');
    return { code: x.slice(0, i), name: x.slice(i + 1) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

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

const safeName = (n) => String(n).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

export default function FinderScreen() {
  const [open, setOpen] = useState(false);
  const t = useAppTheme(open);
  const [tab, setTab] = useState('songs');

  // songs
  const [link, setLink] = useState('');
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [songQ, setSongQ] = useState('');
  const [songs, setSongs] = useState(null); // null = not searched, [] = nothing found
  const [songMsg, setSongMsg] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const previewRef = useRef(null);

  // covers
  const [coverQ, setCoverQ] = useState('');
  const [entity, setEntity] = useState('album');
  const [region, setRegion] = useState('us');
  const [regionOpen, setRegionOpen] = useState(false);
  const [regionQ, setRegionQ] = useState('');
  const [covers, setCovers] = useState(null);
  const [coverMsg, setCoverMsg] = useState('');
  const [saving, setSaving] = useState('');

  // lyrics
  const [lyricQ, setLyricQ] = useState('');
  const [lyricUrl, setLyricUrl] = useState('');

  const lastClip = useRef('');

  // ---------- previews (a hidden page plays the 30 second clip, so your music player is not touched) ----------
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
    const url = JSON.stringify(s.preview);
    if (previewRef.current) {
      previewRef.current.injectJavaScript(
        "var a=document.getElementById('a');a.src=" +
          url +
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
      setSongMsg('Something went wrong, check your internet and try again');
    }
  };

  const startDownload = async (raw) => {
    const l = normaliseLink(raw);
    if (!l) {
      setLog([{ k: 'bad', m: 'That is not an Apple Music song link.' }]);
      return;
    }
    if (!TA || !TA.run) {
      setLog([{ k: 'bad', m: 'Downloading needs the newest build of the app.' }]);
      return;
    }
    stopPreview();
    setBusy(true);
    setLog([{ k: '', m: 'Starting. A browser screen opens and does the steps for you.' }]);
    try {
      const out = await TA.run(TASK, l, '#id_url');
      setLog([{ k: 'good', m: 'Running ' + out.steps + ' steps. The file lands in your Downloads folder.' }]);
    } catch (e) {
      setLog([{ k: 'bad', m: 'Could not start: ' + (e && e.message ? e.message : e) }]);
    }
    setTimeout(() => setBusy(false), 1500);
  };

  const getSong = (s) => {
    setLink(s.apple);
    startDownload(s.apple);
  };

  // ---------- covers ----------
  const searchCovers = async (qIn) => {
    const q = String(qIn === undefined ? coverQ : qIn).trim();
    if (!q) return;
    setCovers(null);
    setCoverMsg('Searching...');
    try {
      const json = await getJson(buildSearchUrl(q, entity, region));
      const list = processResults(json, entity);
      setCovers(list);
      setCoverMsg(list.length === 0 ? 'Nothing found. Try another search or region.' : '');
    } catch (e) {
      setCovers([]);
      setCoverMsg('Something went wrong, try again');
    }
  };

  const saveCover = async (url, title, label) => {
    setSaving(url);
    try {
      const name = safeName(title) + ' ' + label + '.jpg';
      const p = await downloadToCache(url, name);
      await saveFile(p, name, 'image/jpeg', false);
      Alert.alert('Saved', 'The picture is in Downloads / Music Plus.');
    } catch (e) {
      Alert.alert('Could not save', String(e && e.message ? e.message : e));
    }
    setSaving('');
  };

  const copy = async (text) => {
    try {
      await Clipboard.setStringAsync(text);
      Alert.alert('Copied', 'The link is copied.');
    } catch (e) {}
  };

  // ---------- lyrics ----------
  const searchLyrics = (qIn) => {
    const q = String(qIn === undefined ? lyricQ : qIn).trim();
    if (!q) return;
    setLyricUrl('https://www.lyricsify.com/search?q=' + encodeURIComponent(q).replace(/%20/g, '+'));
  };

  // ---------- opening ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openFinder', (p) => {
      const info = p || {};
      const q = String(info.query || '').trim();
      const wanted = info.tab || 'songs';
      setOpen(true);
      setTab(wanted);
      setLyricUrl('');
      if (info.link) {
        setLink(info.link);
        setLog([]);
      }
      if (q) {
        if (wanted === 'songs') {
          setSongQ(q);
          searchSongs(q);
        } else if (wanted === 'covers') {
          setCoverQ(q);
          searchCovers(q);
        } else if (wanted === 'lyrics') {
          setLyricQ(q);
          searchLyrics(q);
        }
      }
    });
    return () => sub.remove();
  }, [entity, region]);

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

  const filteredCountries = useMemo(() => {
    const q = regionQ.trim().toLowerCase();
    return q ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.code === q) : COUNTRIES;
  }, [regionQ]);

  const input = {
    backgroundColor: t.card,
    color: t.text,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 46,
    fontSize: 15,
  };
  const card = { backgroundColor: t.card, borderRadius: 16, padding: 14, marginBottom: 12 };
  const label = { color: t.muted, fontSize: 12, fontWeight: '700', marginBottom: 6, marginTop: 4 };

  const regionName = (COUNTRIES.find((c) => c.code === region) || {}).name || region.toUpperCase();

  // ---------- the tabs ----------
  const songsView = (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }}>Download from Apple Music</Text>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 3, marginBottom: 10 }}>
          Paste a song link. A browser screen opens, does the steps for you, and the file lands in Downloads.
        </Text>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="https://music.apple.com/us/song/..."
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={input}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <Btn
            t={t}
            icon="clipboard-outline"
            label="Paste"
            alt
            style={{ flex: 1 }}
            onPress={async () => {
              try {
                setLink(await Clipboard.getStringAsync());
              } catch (e) {
                setLog([{ k: 'bad', m: 'Clipboard blocked. Paste it by hand.' }]);
              }
            }}
          />
          <Btn
            t={t}
            icon="close"
            label="Clear"
            alt
            style={{ flex: 1 }}
            onPress={() => {
              setLink('');
              setLog([]);
            }}
          />
        </View>
        <Btn t={t} icon="download" label={busy ? 'Starting...' : 'Download'} disabled={busy} style={{ marginTop: 8 }} onPress={() => startDownload(link)} />
        {log.map((x, i) => (
          <Text key={i} style={{ marginTop: 8, fontSize: 13, color: x.k === 'bad' ? '#F2625A' : x.k === 'good' ? '#34D67A' : t.muted }}>
            {x.m}
          </Text>
        ))}
      </View>

      <View style={card}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '800', marginBottom: 10 }}>Find a song</Text>
        <TextInput
          value={songQ}
          onChangeText={setSongQ}
          placeholder="Song or artist"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          onSubmitEditing={() => searchSongs()}
          style={input}
        />
        <Btn t={t} icon="search" label="Search" style={{ marginTop: 10 }} onPress={() => searchSongs()} />
      </View>

      {songs === null && songMsg ? (
        <View style={{ alignItems: 'center', padding: 20 }}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : null}
      {songs && songs.length === 0 && songMsg ? <Text style={{ color: t.muted, textAlign: 'center', padding: 16 }}>{songMsg}</Text> : null}
      {songs
        ? songs.map((s) => (
            <TouchableOpacity
              key={s.id}
              activeOpacity={0.8}
              onPress={() => Linking.openURL(s.apple).catch(() => {})}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}
            >
              <Image source={{ uri: s.art }} style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: t.card }} />
              <View style={{ flex: 1, marginHorizontal: 12 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>
                  {s.title}
                </Text>
                <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                  {s.artist}
                  {s.album ? ' · ' + s.album : ''}
                </Text>
              </View>
              {s.preview ? (
                <TouchableOpacity onPress={() => togglePreview(s)} style={{ padding: 8 }}>
                  <Ionicons name={playingId === s.id ? 'pause-circle' : 'play-circle'} size={32} color={t.accent} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={() => getSong(s)} style={{ padding: 8 }}>
                <Ionicons name="download" size={26} color={t.text} />
              </TouchableOpacity>
            </TouchableOpacity>
          ))
        : null}
    </ScrollView>
  );

  const coversView = (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <View style={card}>
        <Text style={label}>Media</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          {ENTITIES.map((e) => (
            <TouchableOpacity
              key={e[0]}
              onPress={() => setEntity(e[0])}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 18,
                marginRight: 8,
                backgroundColor: entity === e[0] ? t.accent : t.track,
              }}
            >
              <Text style={{ fontWeight: '700', fontSize: 13, color: entity === e[0] ? t.onAccent : t.text }}>{e[1]}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <Text style={label}>Region</Text>
        <TouchableOpacity onPress={() => setRegionOpen(true)} style={[input, { flexDirection: 'row', alignItems: 'center' }]}>
          <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>{regionName}</Text>
          <Ionicons name="chevron-down" size={18} color={t.muted} />
        </TouchableOpacity>
        <Text style={label}>{entity === 'id' || entity === 'idAlbum' ? 'Apple ID' : 'Search'}</Text>
        <TextInput
          value={coverQ}
          onChangeText={setCoverQ}
          placeholder="e.g. Montero"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          onSubmitEditing={() => searchCovers()}
          style={input}
        />
        <Btn t={t} icon="image" label="Get the artwork" style={{ marginTop: 10 }} onPress={() => searchCovers()} />
      </View>

      {covers === null && coverMsg ? (
        <View style={{ alignItems: 'center', padding: 20 }}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : null}
      {covers && covers.length === 0 && coverMsg ? <Text style={{ color: t.muted, textAlign: 'center', padding: 16 }}>{coverMsg}</Text> : null}
      {covers
        ? covers.map((d, i) => (
            <View key={i} style={card}>
              <View style={{ flexDirection: 'row' }}>
                <Image source={{ uri: d.url }} style={{ width: 110, height: 110, borderRadius: 12, backgroundColor: t.track }} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: t.text, fontSize: 15, fontWeight: '800' }} numberOfLines={4}>
                    {d.title}
                  </Text>
                  {d.uncompressed ? <Text style={{ color: t.muted, fontSize: 12, marginTop: 4 }}>Uncompressed 3000 x 3000 available</Text> : null}
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                {d.appstore ? (
                  <Btn t={t} icon="logo-apple-appstore" label="App Store page" alt onPress={() => Linking.openURL(d.appstore).catch(() => {})} />
                ) : null}
                <Btn
                  t={t}
                  icon="download"
                  label="Standard 600x600"
                  alt
                  disabled={saving === d.url}
                  onPress={() => saveCover(d.url, d.title, 'standard')}
                />
                <Btn
                  t={t}
                  icon="download"
                  label={d.uncompressed ? 'Uncompressed' : 'High resolution'}
                  disabled={saving === (d.uncompressed || d.hires)}
                  onPress={() => saveCover(d.uncompressed || d.hires, d.title, d.uncompressed ? 'uncompressed' : 'high')}
                />
                <Btn t={t} icon="copy-outline" label="Copy link" alt onPress={() => copy(d.uncompressed || d.hires)} />
              </View>
            </View>
          ))
        : null}
    </ScrollView>
  );

  const lyricsView = (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }}>Search lyrics</Text>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 3, marginBottom: 10 }}>
          Type a song or artist. The Lyricsify page opens right here.
        </Text>
        <TextInput
          value={lyricQ}
          onChangeText={setLyricQ}
          placeholder="Song or artist"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          onSubmitEditing={() => searchLyrics()}
          style={input}
        />
        <Btn t={t} icon="search" label="Search" style={{ marginTop: 10 }} onPress={() => searchLyrics()} />
      </View>
    </ScrollView>
  );

  const automateView = (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <View style={card}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }}>Task Automator</Text>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 3, marginBottom: 12 }}>
          The engine behind the downloader. Open it to record your own steps, run them, or see everything it downloaded.
        </Text>
        <Btn
          t={t}
          icon="flash"
          label="Open Task Automator"
          onPress={() => (TA && TA.openHome ? TA.openHome() : Alert.alert('Not available', 'This needs the newest build of the app.'))}
        />
        <Btn
          t={t}
          icon="download"
          label="Its downloads"
          alt
          style={{ marginTop: 8 }}
          onPress={() => (TA && TA.openDownloads ? TA.openDownloads() : Alert.alert('Not available', 'This needs the newest build of the app.'))}
        />
      </View>
    </ScrollView>
  );

  let content = songsView;
  if (tab === 'covers') content = coversView;
  else if (tab === 'lyrics') content = lyricsView;
  else if (tab === 'automate') content = automateView;

  return (
    <Modal visible={open} animationType="slide" onRequestClose={lyricUrl ? () => setLyricUrl('') : close}>
      {lyricUrl ? (
        <Screen t={t} title="Lyricsify" onClose={() => setLyricUrl('')}>
          <WebView source={{ uri: lyricUrl }} style={{ flex: 1, backgroundColor: t.bg }} startInLoadingState />
        </Screen>
      ) : (
        <Screen t={t} title="Music Finder" onClose={close}>
          <View style={{ flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 4 }}>
            {TABS.map((x) => {
              const on = tab === x.key;
              return (
                <TouchableOpacity
                  key={x.key}
                  onPress={() => {
                    if (x.key !== 'songs') stopPreview();
                    setTab(x.key);
                  }}
                  activeOpacity={0.8}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    paddingVertical: 9,
                    borderRadius: 12,
                    backgroundColor: on ? t.accent : t.card,
                  }}
                >
                  <Ionicons name={x.icon} size={17} color={on ? t.onAccent : t.text} />
                  <Text style={{ marginTop: 2, fontSize: 11, fontWeight: '800', color: on ? t.onAccent : t.text }}>{x.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {content}
        </Screen>
      )}

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

      <Modal visible={regionOpen} animationType="fade" transparent onRequestClose={() => setRegionOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: t.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', padding: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: '800' }}>Region</Text>
              <TouchableOpacity onPress={() => setRegionOpen(false)}>
                <Ionicons name="close" size={26} color={t.text} />
              </TouchableOpacity>
            </View>
            <TextInput
              value={regionQ}
              onChangeText={setRegionQ}
              placeholder="Search a country"
              placeholderTextColor={t.muted}
              style={input}
            />
            <FlatList
              data={filteredCountries}
              keyExtractor={(c) => c.code}
              keyboardShouldPersistTaps="handled"
              style={{ marginTop: 8 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => {
                    setRegion(item.code);
                    setRegionOpen(false);
                    setRegionQ('');
                  }}
                  style={{ paddingVertical: 13, flexDirection: 'row', alignItems: 'center' }}
                >
                  <Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: item.code === region ? '800' : '500' }}>{item.name}</Text>
                  {item.code === region ? <Ionicons name="checkmark" size={20} color={t.accent} /> : null}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </Modal>
  );
}
