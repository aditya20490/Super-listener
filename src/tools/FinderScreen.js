// Music Finder, built into the player. Same pages as your Music Finder app: Songs (download + search + previews),
// Covers, Lyrics and Automate. It opens from the hamburger menu at the top left of the player, or by itself
// when you copy an Apple Music song link.
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Animated,
  StatusBar,
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
import { useSafeAreaInsets, SafeAreaProvider } from 'react-native-safe-area-context';
import * as Engine from '../audioEngine';
import { Screen, useAppTheme } from './Tools';
import { TASK, COUNTRY_LIST } from './finderData';
import { C, ACC, TAB_META, haptic, Press, Field, Action, Sheet, Pop, TabEnter, Ring, LivePill, Header, Eyebrow, Card, Label, Squircle } from './finderUi';

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
  return <Image source={{ uri: uri }} style={{ width: '100%', aspectRatio: ratio, borderRadius: 12, backgroundColor: C.pill }} resizeMode="cover" />;
}

const NAV_ICON = { songs: 'musical-notes', covers: 'image', lyrics: 'document-text', automate: 'flash' };
const roundBtn = { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: C.hair, alignItems: 'center', justifyContent: 'center' };
const smallBtn = { flex: 1, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' };
const smallTxt = { color: C.text, fontSize: 11.5, fontWeight: '700' };

// gives the page below the safe area sizes of the phone (the window is its own screen, so it needs its own)
function Shell({ children }) {
  const ins = useSafeAreaInsets();
  return children(ins);
}

// one bottom tab: the icon springs up a little when its page is open
function TabItem({ item, active, onPress }) {
  const s = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(s, { toValue: active ? 1 : 0, useNativeDriver: true, friction: 6, tension: 120 }).start();
  }, [active]);
  const color = active ? ACC[item.key].c : C.muted;
  return (
    <Press onPress={onPress} scale={0.92} style={{ flex: 1, alignItems: 'center', paddingVertical: 3 }}>
      <Animated.View style={{ transform: [{ scale: s.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }] }}>
        <Ionicons name={NAV_ICON[item.key]} size={22} color={color} />
      </Animated.View>
      <Text style={{ fontSize: 10.5, fontWeight: '600', marginTop: 3, color }}>{item.label}</Text>
    </Press>
  );
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
  const pickerKeep = useRef(null);

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

  // One tap on a song's copy button puts its Apple Music link on the clipboard.
  // The link is marked as already seen, so the clipboard watcher does not pop Music Finder open for it later.
  const copySongLink = async (url) => {
    if (!url) return;
    const l = normaliseLink(url);
    if (l) {
      lastClip.current = l;
      try {
        await AsyncStorage.setItem(LAST_CLIP_KEY, l);
      } catch (e) {}
    }
    copyLink(url);
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

  // ---------- the little live-activity pill (it only watches what is already happening) ----------
  const [pill, setPill] = useState(null);
  const pillTimer = useRef(null);
  const wasBusy = useRef(false);
  const flashPill = (p, ms) => {
    if (pillTimer.current) clearTimeout(pillTimer.current);
    setPill(p);
    if (ms) pillTimer.current = setTimeout(() => setPill(null), ms);
  };
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      flashPill({ title: 'Downloading', sub: 'Task Automator is working', color: ACC.songs.c, working: true }, 0);
    } else if (wasBusy.current) {
      wasBusy.current = false;
      const bad = log.length > 0 && log[0].k === 'bad';
      if (bad) haptic.warn();
      else haptic.success();
      flashPill(
        bad
          ? { title: 'Could not start', sub: 'Check the link and try again', color: C.red, icon: 'alert' }
          : { title: 'Download started', sub: 'Saving to your Music folder', color: C.green, icon: 'checkmark' },
        2200
      );
    }
  }, [busy]);
  useEffect(() => {
    if (copied) flashPill({ title: 'Link copied', sub: 'Ready to paste', color: C.green, icon: 'copy' }, 1600);
  }, [copied]);
  useEffect(() => {
    if (playingId) flashPill({ title: 'Previewing', sub: '30 second clip', color: ACC.songs.c, icon: 'play' }, 1800);
  }, [playingId]);
  useEffect(
    () => () => {
      if (pillTimer.current) clearTimeout(pillTimer.current);
    },
    []
  );

  // ---------- look: the mockup (pure black, grouped cards) ----------
  const [info, setInfo] = useState(false);
  const scrollY = useRef(new Animated.Value(0)).current;
  const pulseA = useRef(new Animated.Value(0)).current;
  const pulseB = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!open) return undefined;
    pulseA.setValue(0);
    pulseB.setValue(0);
    const run = (v, delay) =>
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, { toValue: 1, duration: 1100, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 1100, useNativeDriver: true }),
      ]);
    const a = Animated.parallel([run(pulseA, 600), run(pulseB, 1300)]);
    a.start();
    return () => a.stop();
  }, [open]);

  const acc = ACC[tab] || ACC.songs;
  const meta = TAB_META[tab] || TAB_META.songs;
  const ring = (v) => ({
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: acc.c,
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }],
  });

  const rowStyle = { flexDirection: 'row', alignItems: 'center', minHeight: 54, paddingHorizontal: 16, paddingVertical: 10 };
  const group = { backgroundColor: C.card, borderWidth: 1, borderColor: C.hair, borderRadius: 18, overflow: 'hidden', marginBottom: 16 };
  const Sep = ({ left }) => <View style={{ height: 1, marginLeft: left, backgroundColor: C.hair2 }} />;

  const pickRow = (labelText, valueText, onPress) => (
    <Press onPress={onPress} scale={0.988} tint="rgba(255,255,255,0.06)" style={rowStyle}>
      <Text style={{ color: C.text, fontSize: 15, flex: 1 }}>{labelText}</Text>
      <Text style={{ color: C.muted, fontSize: 15, maxWidth: '62%' }} numberOfLines={1}>
        {valueText}
      </Text>
      <Ionicons name="chevron-forward" size={16} color={C.ph} style={{ marginLeft: 6 }} />
    </Press>
  );

  // ---------- the pages ----------
  const songsPage = (
    <View>
      <Header acc={ACC.songs} eyebrow="Apple Music" title="Download" />
      <Card>
        <Label>Apple Music song link</Label>
        <Field
          acc={ACC.songs}
          value={link}
          onChangeText={setLink}
          placeholder="https://music.apple.com/us/song/..."
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          onClear={() => {
            setLink('');
            setLog([]);
          }}
        />
        <View style={{ flexDirection: 'row', marginTop: 4 }}>
          <Press
            style={{ height: 44, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.pill, flexDirection: 'row', alignItems: 'center', marginRight: 8 }}
            onPress={async () => {
              try {
                setLink(await Clipboard.getStringAsync());
              } catch (e) {
                setLog([{ k: 'bad', m: 'Clipboard blocked, paste it by hand.' }]);
              }
            }}
          >
            <Ionicons name="clipboard-outline" size={16} color={C.text} />
            <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '600', marginLeft: 6 }}>Paste</Text>
          </Press>
          <Press
            style={{ height: 44, paddingHorizontal: 16, borderRadius: 14, backgroundColor: C.pill, alignItems: 'center', justifyContent: 'center', marginRight: 8 }}
            onPress={() => {
              setLink('');
              setLog([]);
            }}
          >
            <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '600' }}>Clear</Text>
          </Press>
          <Action label="Download" icon="arrow-down" color={ACC.songs.c} height={44} working={busy} disabled={busy} onPress={startDownload} style={{ flex: 1 }} />
        </View>
        {log.length > 0 ? (
          <View style={{ marginTop: 12 }}>
            {log.map((x, i) => (
              <Text key={i} style={{ fontSize: 13, lineHeight: 20, color: x.k === 'bad' ? C.red : x.k === 'good' ? C.green : C.muted }}>
                {x.m}
              </Text>
            ))}
          </View>
        ) : null}
      </Card>

      <Card>
        <Label>Song or artist</Label>
        <Field
          acc={ACC.songs}
          icon="search"
          value={songQ}
          onChangeText={setSongQ}
          placeholder="e.g. Tiffany"
          returnKeyType="search"
          onSubmitEditing={() => searchSongs()}
          autoCorrect={false}
        />
        <Action label="Search" color="#FFFFFF" ink="#000000" onPress={() => searchSongs()} glow={false} style={{ marginTop: 2 }} />
      </Card>

      {songs === null && songMsg ? (
        <View style={{ alignItems: 'center', padding: 24 }}>
          <ActivityIndicator color={ACC.songs.c} />
          <Text style={{ color: C.muted, marginTop: 10 }}>{songMsg}</Text>
        </View>
      ) : null}
      {songs && songs.length === 0 && songMsg ? <Text style={{ color: C.muted, textAlign: 'center', padding: 28 }}>{songMsg}</Text> : null}
      {songs && songs.length > 0 ? (
        <View>
          <Eyebrow left="Top Results" right={songs.length + (songs.length === 1 ? ' song' : ' songs')} />
          <View style={group}>
            {songs.map((s, i) => (
              <Pop key={s.id} index={i}>
                {i > 0 ? <Sep left={76} /> : null}
                <Press onPress={() => openInApp(s.apple)} scale={0.988} tint="rgba(255,255,255,0.06)" haptics={false} style={[rowStyle, { paddingHorizontal: 12 }]}>
                  <Image source={{ uri: s.art }} style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: C.pill }} />
                  <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                    <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '600' }} numberOfLines={1}>
                      {s.title}
                    </Text>
                    <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                      {s.artist + ' · ' + s.album}
                    </Text>
                  </View>
                  {s.preview ? (
                    <Press
                      onPress={() => togglePreview(s)}
                      scale={0.88}
                      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        marginLeft: 8,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: playingId === s.id ? 'rgba(250,45,72,0.18)' : C.pill,
                      }}
                    >
                      {playingId === s.id ? (
                        <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                          <View style={{ position: 'absolute' }}>
                            <Ring size={30} color={ACC.songs.c} width={2.6} />
                          </View>
                          <Ionicons name="stop" size={13} color={ACC.songs.c} />
                        </View>
                      ) : (
                        <Ionicons name="play" size={15} color={C.text} style={{ marginLeft: 2 }} />
                      )}
                    </Press>
                  ) : null}
                  {s.apple ? (
                    <Press
                      onPress={() => copySongLink(s.apple)}
                      scale={0.88}
                      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        marginLeft: 8,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: copied === s.apple ? 'rgba(48,209,88,0.16)' : C.pill,
                      }}
                    >
                      <Ionicons name={copied === s.apple ? 'checkmark' : 'copy-outline'} size={17} color={copied === s.apple ? C.green : C.text} />
                    </Press>
                  ) : null}
                </Press>
              </Pop>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );

  const coversPage = (
    <View>
      <Header acc={ACC.covers} eyebrow="iTunes Artwork Finder" title="Album Cover" />
      <View style={group}>
        {pickRow('Media', (ENTITIES.find((e) => e.code === entity) || {}).name || entity, () => {
          setPickerQ('');
          setPicker({ title: 'Media', items: ENTITIES, value: entity, onPick: setEntity, search: false });
        })}
        <Sep left={16} />
        {pickRow('Region', (COUNTRIES.find((c) => c.code === region) || {}).name || region.toUpperCase(), () => {
          setPickerQ('');
          setPicker({ title: 'Region', items: COUNTRIES, value: region, onPick: setRegion, search: true });
        })}
      </View>
      <Card>
        <Label>Search</Label>
        <Field
          acc={ACC.covers}
          icon="search"
          value={coverQ}
          onChangeText={setCoverQ}
          placeholder="e.g. Montero"
          returnKeyType="search"
          onSubmitEditing={() => searchCovers()}
          autoCorrect={false}
        />
        <Action label="Get the artwork" color={ACC.covers.c} onPress={() => searchCovers()} style={{ marginTop: 2 }} />
      </Card>

      {covers === null && coverMsg ? (
        <View style={{ alignItems: 'center', padding: 24 }}>
          <ActivityIndicator color={ACC.covers.c} />
          <Text style={{ color: C.muted, marginTop: 10 }}>{coverMsg}</Text>
        </View>
      ) : null}
      {covers && covers.length === 0 && coverMsg ? <Text style={{ color: C.muted, textAlign: 'center', padding: 28 }}>{coverMsg}</Text> : null}
      {covers && covers.length > 0 ? (
        <View>
          <Eyebrow left="Artwork Results" right={covers.length + (covers.length === 1 ? ' result' : ' results')} />
          <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18, marginHorizontal: 4, marginBottom: 12 }}>
            Tap a button to open the image, then press and hold it to download. If the item is not on iTunes, this tool will not find it.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {covers.map((d, i) => (
              <Pop key={i} index={i} style={{ width: '48.5%', marginBottom: 12 }}>
                <View style={{ backgroundColor: C.card, borderWidth: 1, borderColor: C.hair, borderRadius: 18, padding: 10 }}>
                  <View>
                    <CoverImage uri={d.url} t={t} />
                    <View style={{ position: 'absolute', left: 6, bottom: 6, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{isAppEntity ? '1024²' : d.uncompressed ? '3000²' : '600²'}</Text>
                    </View>
                  </View>
                  <Text style={{ color: C.text, fontSize: 13, fontWeight: '700', marginTop: 9, lineHeight: 17 }} numberOfLines={2}>
                    {d.title}
                  </Text>
                  <Text style={{ color: C.muted, fontSize: 11, marginTop: 2, marginBottom: 9 }}>{isAppEntity ? 'App icon' : d.uncompressed ? 'Standard + uncompressed' : 'Cover art'}</Text>
                  {isAppEntity ? (
                    <View style={{ flexDirection: 'row' }}>
                      <Press onPress={() => openInApp(d.url)} style={[smallBtn, { backgroundColor: C.pill, marginRight: 6 }]}>
                        <Text style={smallTxt}>Icon</Text>
                      </Press>
                      {d.appstore ? (
                        <Press onPress={() => openInApp(d.appstore)} style={[smallBtn, { backgroundColor: 'rgba(10,132,255,0.2)', borderWidth: 1, borderColor: 'rgba(10,132,255,0.55)' }]}>
                          <Text style={[smallTxt, { color: '#4DA3FF' }]}>Store</Text>
                        </Press>
                      ) : null}
                    </View>
                  ) : (
                    <View>
                      <View style={{ flexDirection: 'row' }}>
                        <Press onPress={() => openInApp(d.url)} style={[smallBtn, { backgroundColor: C.pill, marginRight: 6 }]}>
                          <Text style={smallTxt}>Standard</Text>
                        </Press>
                        <Press
                          onPress={() => openInApp(d.uncompressed ? d.uncompressed : d.hires)}
                          style={[smallBtn, { backgroundColor: 'rgba(10,132,255,0.2)', borderWidth: 1, borderColor: 'rgba(10,132,255,0.55)' }]}
                        >
                          <Text style={[smallTxt, { color: '#4DA3FF' }]}>{d.uncompressed ? 'Uncomp.' : 'High res'}</Text>
                        </Press>
                      </View>
                      {d.uncompressed ? (
                        <Press onPress={() => copyLink(d.uncompressed)} scale={0.95} style={{ paddingTop: 9, alignItems: 'center' }}>
                          <Text style={{ color: copied === d.uncompressed ? C.green : C.muted, fontSize: 11.5, fontWeight: '600' }}>
                            {copied === d.uncompressed ? 'Copied' : 'Copy uncompressed link'}
                          </Text>
                        </Press>
                      ) : null}
                    </View>
                  )}
                </View>
              </Pop>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );

  const lyricsPage = (
    <View>
      <Header acc={ACC.lyrics} eyebrow="Lyricsify" title="Search Lyrics" />
      <Card>
        <Label>Song or artist</Label>
        <Field
          acc={ACC.lyrics}
          icon="search"
          value={lyricQ}
          onChangeText={setLyricQ}
          placeholder="e.g. Lil Nas X"
          returnKeyType="search"
          onSubmitEditing={() => searchLyrics()}
          autoCorrect={false}
        />
        <Action label="Search" color={ACC.lyrics.c} onPress={() => searchLyrics()} style={{ marginTop: 2 }} />
      </Card>
      <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 18, marginHorizontal: 4 }}>
        Use the close button on the top left of the opened page to come back here.
      </Text>
    </View>
  );

  let page = songsPage;
  if (tab === 'covers') page = coversPage;
  else if (tab === 'lyrics') page = lyricsPage;

  if (picker) pickerKeep.current = picker;
  const pk = picker || pickerKeep.current;
  const pickerItems = pk
    ? pk.search && pickerQ.trim()
      ? pk.items.filter((c) => c.name.toLowerCase().includes(pickerQ.trim().toLowerCase()) || c.code === pickerQ.trim().toLowerCase())
      : pk.items
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
        <StatusBar barStyle="light-content" backgroundColor="#000000" />
        <SafeAreaProvider style={{ flex: 1 }}>
          <Shell>
            {(ins) => (
              <View style={{ flex: 1, backgroundColor: C.bg }}>
                {/* top bar */}
                <View style={{ paddingTop: ins.top + 6, paddingBottom: 8, paddingHorizontal: 14, backgroundColor: 'rgba(0,0,0,0.92)', zIndex: 5 }}>
                  <View style={{ height: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Press onPress={close} scale={0.9} style={roundBtn}>
                      <Ionicons name="chevron-down" size={20} color={C.text} />
                    </Press>
                    <Text style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', color: C.text, fontSize: 16, fontWeight: '700' }} pointerEvents="none">
                      Music Finder
                    </Text>
                    <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                      <Animated.View pointerEvents="none" style={ring(pulseA)} />
                      <Animated.View pointerEvents="none" style={ring(pulseB)} />
                      <Press onPress={() => setInfo(true)} scale={0.9} style={roundBtn}>
                        <Ionicons name="information" size={19} color={C.text} />
                      </Press>
                    </View>
                  </View>
                  <Animated.View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: 1,
                      backgroundColor: C.hair,
                      opacity: scrollY.interpolate({ inputRange: [0, 10], outputRange: [0, 1], extrapolate: 'clamp' }),
                    }}
                  />
                </View>

                <Animated.ScrollView
                  keyboardShouldPersistTaps="handled"
                  scrollEventThrottle={16}
                  onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
                  contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 36 }}
                >
                  <TabEnter key={tab}>{page}</TabEnter>
                </Animated.ScrollView>

                {/* bottom tabs */}
                <View style={{ flexDirection: 'row', backgroundColor: '#000', borderTopWidth: 1, borderTopColor: C.hair, paddingTop: 7, paddingBottom: ins.bottom + 6 }}>
                  {NAV.map((x) => (
                    <TabItem key={x.key} item={x} active={tab === x.key && x.key !== 'automate'} onPress={() => goTab(x.key)} />
                  ))}
                </View>

                <LivePill pill={pill} top={ins.top + 6} />
              </View>
            )}
          </Shell>
        </SafeAreaProvider>

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

        {/* what each page is about */}
        <Sheet visible={info} onClose={() => setInfo(false)} bottom={insets.bottom + 16}>
          <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
              <Squircle size={40} radius={12} color={acc.c} icon={acc.icon} ink={acc.ink} />
              <View style={{ marginLeft: 12 }}>
                <Text style={{ color: acc.c, fontSize: 11, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase' }}>{meta.kicker}</Text>
                <Text style={{ color: C.text, fontSize: 18, fontWeight: '800', marginTop: 1 }}>{meta.title}</Text>
              </View>
            </View>
            <Text style={{ color: '#C7C7CC', fontSize: 14.5, lineHeight: 21, marginBottom: 20 }}>{meta.text}</Text>
            <Action label="Done" color="#FFFFFF" ink="#000000" glow={false} onPress={() => setInfo(false)} />
          </View>
        </Sheet>

        {/* pick from a list (Media, Region) */}
        <Sheet visible={!!picker} onClose={() => setPicker(null)} bottom={insets.bottom + 12} maxHeight="78%">
          <View style={{ paddingHorizontal: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, marginTop: 2 }}>
              <Text style={{ flex: 1, color: C.text, fontSize: 17, fontWeight: '800' }}>{pk ? pk.title : ''}</Text>
              <Press onPress={() => setPicker(null)} scale={0.92} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ color: C.blue, fontSize: 17, fontWeight: '600' }}>Done</Text>
              </Press>
            </View>
            {pk && pk.search ? <Field acc={ACC.covers} icon="search" value={pickerQ} onChangeText={setPickerQ} placeholder="Search a country" autoCorrect={false} /> : null}
            <View style={{ backgroundColor: C.list, borderRadius: 16, overflow: 'hidden', maxHeight: 360 }}>
              <FlatList
                data={pickerItems}
                keyExtractor={(c) => c.code}
                keyboardShouldPersistTaps="handled"
                ItemSeparatorComponent={() => <View style={{ height: 1, marginLeft: 16, backgroundColor: C.hair2 }} />}
                renderItem={({ item }) => (
                  <Press
                    onPress={() => {
                      pk.onPick(item.code);
                      setPicker(null);
                    }}
                    scale={0.99}
                    tint="rgba(255,255,255,0.06)"
                    style={{ paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' }}
                  >
                    <Text style={{ flex: 1, color: C.text, fontSize: 15, fontWeight: pk && item.code === pk.value ? '700' : '500' }}>{item.name}</Text>
                    {pk && item.code === pk.value ? <Ionicons name="checkmark" size={20} color={C.blue} /> : null}
                  </Press>
                )}
              />
            </View>
          </View>
        </Sheet>
      </Modal>
    </View>
  );
}
