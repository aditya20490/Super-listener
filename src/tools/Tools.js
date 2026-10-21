// Two tools inside the player:
//  1. YouTube link reader (thumbnail, title, lyrics) - opens by itself when you copy a YouTube link
//  2. Tag editor (the same editor page as your tag editor app) - writes tags into a copy of the song
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Image,
  FlatList,
  Alert,
  AppState,
  ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadSettings } from '../library';
import { getTheme } from '../theme';
import { cleanTitle } from '../utils';
import { saveEdit } from '../edits';
import { findVideoId, getThumbnail, getTracks, getCaptionText, toLrc, toSrt, safeName } from './youtube';
import { FileSystem as FS, saveFile, writeCacheBase64, writeCacheText, downloadToCache, downloadCover } from './saver';
import TAG_HTML from './tagEditorHtml';

// ---------- small pieces ----------
function useAppTheme(refresh) {
  const [t, setT] = useState(getTheme('dark'));
  useEffect(() => {
    loadSettings()
      .then((s) => setT(getTheme(s.theme)))
      .catch(() => {});
  }, [refresh]);
  return t;
}

function Btn({ t, icon, label, onPress, alt, disabled, style }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: 12,
          paddingHorizontal: 14,
          borderRadius: 12,
          backgroundColor: alt ? t.card : t.accent,
          opacity: disabled ? 0.45 : 1,
        },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={18} color={alt ? t.text : t.onAccent} /> : null}
      <Text style={{ marginLeft: icon ? 8 : 0, fontWeight: '800', fontSize: 14, color: alt ? t.text : t.onAccent }}>{label}</Text>
    </TouchableOpacity>
  );
}

function Screen({ t, title, onClose, right, children }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 52 }}>
        <TouchableOpacity onPress={onClose} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="chevron-down" size={28} color={t.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: '800' }}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function Card({ t, children, style }) {
  return <View style={[{ backgroundColor: t.card, borderRadius: 16, padding: 14, marginTop: 14 }, style]}>{children}</View>;
}

// ---------- pick a song from the library ----------
function SongPicker({ t, visible, onClose, onPick, title }) {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    (async () => {
      setLoading(true);
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
        if (alive) setItems(list);
      } catch (e) {}
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [visible]);

  const shown = useMemo(() => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => tokens.every((k) => (it.title + ' ' + it.filename).toLowerCase().indexOf(k) >= 0)).slice(0, 300);
  }, [items, q]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Screen t={t} title={title || 'Choose a song'} onClose={onClose}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search songs…"
          placeholderTextColor={t.muted}
          style={{ marginHorizontal: 16, marginBottom: 8, height: 44, borderRadius: 12, paddingHorizontal: 14, backgroundColor: t.card, color: t.text }}
        />
        {loading ? <ActivityIndicator color={t.accent} style={{ marginTop: 20 }} /> : null}
        <FlatList
          data={shown}
          keyExtractor={(it) => it.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => onPick(item)} style={{ paddingVertical: 12, paddingHorizontal: 16 }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                {item.filename}
              </Text>
            </TouchableOpacity>
          )}
        />
      </Screen>
    </Modal>
  );
}

// ---------- 1. YouTube link ----------
function YouTubeSheet({ t, visible, onClose, initialLink, onApplied }) {
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const [vid, setVid] = useState('');
  const [thumb, setThumb] = useState(null);
  const [info, setInfo] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [sel, setSel] = useState(0);
  const [lines, setLines] = useState([]);
  const [lyMsg, setLyMsg] = useState('');
  const [opts, setOpts] = useState({ title: true, cover: true, lyrics: true });
  const [pickOpen, setPickOpen] = useState(false);
  const runId = useRef(0);
  const lastRun = useRef('');

  const pickTrack = async (i, list, my) => {
    setSel(i);
    setLines([]);
    setLyMsg('Getting the lyrics…');
    const r = await getCaptionText(list[i].url);
    if (my !== runId.current) return;
    if (!r.ok) {
      setLyMsg(r.error);
      return;
    }
    setLines(r.lines);
    setLyMsg(r.lines.length + ' lines' + (list[i].auto ? ' · auto-generated, so it can have mistakes' : ''));
  };

  const run = async (text) => {
    const my = ++runId.current;
    lastRun.current = text;
    setThumb(null);
    setInfo(null);
    setTracks([]);
    setLines([]);
    setLyMsg('');
    const id = findVideoId(text, true);
    if (!id) {
      setMsg("Couldn't find a YouTube link there.");
      return;
    }
    setVid(id);
    setMsg('Loading…');
    const th = await getThumbnail(id);
    if (my !== runId.current) return;
    setThumb(th);
    setMsg(th ? '' : 'No thumbnail found. Is the video public?');
    setLyMsg('Looking for captions…');
    const inf = await getTracks(id);
    if (my !== runId.current) return;
    setInfo(inf);
    if (!inf.ok) {
      setLyMsg(inf.error);
      return;
    }
    setTracks(inf.tracks);
    let first = inf.tracks.findIndex((x) => !x.auto);
    if (first < 0) first = 0;
    pickTrack(first, inf.tracks, my);
  };

  useEffect(() => {
    if (visible && initialLink && initialLink !== lastRun.current) {
      setUrl(initialLink);
      run(initialLink);
    }
  }, [visible, initialLink]);

  const lrc = lines.length ? toLrc(lines, info && info.title) : '';
  const name = safeName(info && info.title, vid);

  const attempt = async (fn, okTitle) => {
    try {
      const m = await fn();
      Alert.alert(okTitle || 'Saved', m || '');
    } catch (e) {
      Alert.alert('Could not save', String(e && e.message ? e.message : e));
    }
  };

  const saveThumb = () =>
    attempt(async () => {
      const p = await downloadToCache(thumb.url, vid + '_thumbnail.jpg');
      const out = await saveFile(p, vid + '_thumbnail.jpg', 'image/jpeg', false);
      return 'Saved in ' + out;
    });
  const saveLrc = () =>
    attempt(async () => {
      const p = await writeCacheText(name + '.lrc', lrc);
      return 'Saved in ' + (await saveFile(p, name + '.lrc', 'application/octet-stream', false));
    });
  const saveSrt = () =>
    attempt(async () => {
      const p = await writeCacheText(name + '.srt', toSrt(lines));
      return 'Saved in ' + (await saveFile(p, name + '.srt', 'application/octet-stream', false));
    });
  const copyText = async () => {
    await Clipboard.setStringAsync(lines.map((l) => l.t).join('\n'));
    Alert.alert('Copied', 'The lyrics text is in your clipboard.');
  };

  const apply = async (song) => {
    setPickOpen(false);
    try {
      const patch = {};
      if (opts.title && info && info.title) patch.title = info.title;
      if (opts.lyrics && lrc) patch.lyrics = lrc;
      if (opts.cover && thumb) patch.cover = await downloadCover(thumb.url, song.id);
      if (Object.keys(patch).length === 0) {
        Alert.alert('Nothing to apply', 'Pick at least one thing that is available.');
        return;
      }
      await saveEdit(song.id, patch);
      Alert.alert('Done', 'Updated "' + song.title + '". The song list will reload now.');
      onApplied();
    } catch (e) {
      Alert.alert('Could not apply', String(e && e.message ? e.message : e));
    }
  };

  const Check = ({ k, label, ok }) => (
    <TouchableOpacity
      onPress={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}
      disabled={!ok}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, opacity: ok ? 1 : 0.4 }}
    >
      <Ionicons name={opts[k] && ok ? 'checkbox' : 'square-outline'} size={22} color={t.accent} />
      <Text style={{ marginLeft: 10, color: t.text, fontSize: 14 }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Screen t={t} title="YouTube link" onClose={onClose}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row' }}>
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder="Paste YouTube link…"
              placeholderTextColor={t.muted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => run(url)}
              style={{ flex: 1, height: 46, borderRadius: 12, paddingHorizontal: 14, backgroundColor: t.card, color: t.text }}
            />
            <Btn t={t} label="Get" onPress={() => run(url)} style={{ marginLeft: 8 }} />
          </View>
          {msg ? <Text style={{ color: t.muted, marginTop: 10 }}>{msg}</Text> : null}

          {thumb ? (
            <Card t={t}>
              <Image source={{ uri: thumb.url }} style={{ width: '100%', aspectRatio: thumb.w / thumb.h, borderRadius: 10, backgroundColor: t.track }} />
              {info && info.title ? (
                <Text selectable style={{ color: t.text, fontSize: 16, fontWeight: '800', marginTop: 10 }}>
                  {info.title}
                </Text>
              ) : null}
              {info && info.author ? <Text style={{ color: t.muted, marginTop: 2 }}>{info.author}</Text> : null}
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
                {thumb.w}×{thumb.h}
              </Text>
              <Btn t={t} icon="download" label="Save thumbnail" onPress={saveThumb} style={{ marginTop: 10 }} />
            </Card>
          ) : null}

          {lyMsg || tracks.length ? (
            <Card t={t}>
              <Text style={{ color: t.text, fontWeight: '800', fontSize: 15 }}>Lyrics / subtitles</Text>
              {tracks.length > 1 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
                  {tracks.map((tr, i) => (
                    <TouchableOpacity
                      key={i}
                      onPress={() => pickTrack(i, tracks, runId.current)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                        borderRadius: 16,
                        marginRight: 8,
                        backgroundColor: sel === i ? t.accent : t.track,
                      }}
                    >
                      <Text style={{ color: sel === i ? t.onAccent : t.text, fontSize: 12, fontWeight: '700' }}>
                        {(tr.name || tr.lang) + (tr.auto ? ' (auto)' : '')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              ) : null}
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>{lyMsg}</Text>
              {lrc ? (
                <ScrollView nestedScrollEnabled style={{ maxHeight: 220, marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: t.bg }}>
                  <Text selectable style={{ color: t.text, fontSize: 13, lineHeight: 19 }}>
                    {lrc}
                  </Text>
                </ScrollView>
              ) : null}
              {lrc ? (
                <View style={{ flexDirection: 'row', marginTop: 10 }}>
                  <Btn t={t} label=".lrc" icon="download" onPress={saveLrc} style={{ flex: 1 }} />
                  <Btn t={t} label=".srt" icon="download" alt onPress={saveSrt} style={{ flex: 1, marginLeft: 8 }} />
                  <Btn t={t} label="Copy" icon="copy" alt onPress={copyText} style={{ flex: 1, marginLeft: 8 }} />
                </View>
              ) : null}
            </Card>
          ) : null}

          {thumb || lrc ? (
            <Card t={t}>
              <Text style={{ color: t.text, fontWeight: '800', fontSize: 15 }}>Use it for a song in my library</Text>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 4, marginBottom: 6 }}>
                Changes how the song looks inside the app. The audio file is never touched.
              </Text>
              <Check k="title" label="Title" ok={!!(info && info.title)} />
              <Check k="cover" label="Cover (the thumbnail)" ok={!!thumb} />
              <Check k="lyrics" label="Lyrics" ok={!!lrc} />
              <Btn t={t} icon="musical-notes" label="Choose the song…" onPress={() => setPickOpen(true)} style={{ marginTop: 8 }} />
            </Card>
          ) : null}
        </ScrollView>
        <SongPicker t={t} visible={pickOpen} onClose={() => setPickOpen(false)} onPick={apply} title="Apply to which song?" />
      </Screen>
    </Modal>
  );
}

// ---------- 2. Tag editor ----------
// Replaces the Capacitor save helper of the tag editor app: blob downloads are sent to the app instead.
const BRIDGE =
  '(function(){if(window.__bridge)return;window.__bridge=true;' +
  'var orig=HTMLAnchorElement.prototype.click;' +
  'HTMLAnchorElement.prototype.click=function(){var a=this;' +
  'if(a.download&&a.href&&a.href.indexOf("blob:")===0){' +
  'fetch(a.href).then(function(r){return r.blob();}).then(function(b){var f=new FileReader();' +
  'f.onload=function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:"save",name:a.download,mime:b.type||"",data:String(f.result).split(",")[1]}));};' +
  'f.readAsDataURL(b);});return;}' +
  'return orig.apply(this,arguments);};' +
  'window.__say=function(text,bad){var m=document.getElementById("msg");if(!m)return;m.textContent=text;m.className=bad?"err":"";};' +
  '})();true;';

const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4', m4b: 'audio/mp4' };

function TagEditor({ t, visible, onClose }) {
  const web = useRef(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [busy, setBusy] = useState('');

  const say = (text, bad) => {
    if (web.current) web.current.injectJavaScript('window.__say(' + JSON.stringify(text) + ',' + (bad ? 'true' : 'false') + ');true;');
  };

  const onMessage = async (e) => {
    let m;
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch (x) {
      return;
    }
    if (m.type === 'save') {
      try {
        const p = await writeCacheBase64(m.name, m.data);
        const isAudio = String(m.mime || '').indexOf('audio/') === 0;
        const out = await saveFile(p, m.name, m.mime || 'application/octet-stream', isAudio);
        say('Saved ✓ ' + out + (isAudio ? '\nPull to refresh your library to see it.' : ''));
      } catch (err) {
        say('Could not save: ' + (err && err.message ? err.message : err), true);
      }
    } else if (m.type === 'err') {
      say(m.text, true);
    }
  };

  const openSong = async (song) => {
    setPickOpen(false);
    if (!FS) {
      Alert.alert('Not available', 'File access is not part of this build.');
      return;
    }
    setBusy('Opening ' + song.title + '…');
    try {
      const data = await FS.readAsStringAsync(song.uri, { encoding: (FS.EncodingType && FS.EncodingType.Base64) || 'base64' });
      const ext = ((song.filename.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
      const js =
        '(function(){try{var b=atob(' + JSON.stringify(data) + ');var u=new Uint8Array(b.length);' +
        'for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);' +
        'load(new File([u],' + JSON.stringify(song.filename || 'song.mp3') + ',{type:' + JSON.stringify(MIME[ext] || '') + '}));' +
        '}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({type:"err",text:String(e)}));}})();true;';
      if (web.current) web.current.injectJavaScript(js);
    } catch (e) {
      Alert.alert('Could not open that song', String(e && e.message ? e.message : e));
    }
    setBusy('');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Screen
        t={t}
        title="Tag editor"
        onClose={onClose}
        right={
          <TouchableOpacity
            onPress={() => setPickOpen(true)}
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 36, borderRadius: 18, backgroundColor: t.accent, marginRight: 8 }}
          >
            <Ionicons name="musical-notes" size={16} color={t.onAccent} />
            <Text style={{ marginLeft: 6, fontWeight: '800', color: t.onAccent }}>My songs</Text>
          </TouchableOpacity>
        }
      >
        {busy ? <Text style={{ color: t.muted, paddingHorizontal: 16, paddingBottom: 6 }}>{busy}</Text> : null}
        {visible ? (
          <WebView
            ref={web}
            source={{ html: TAG_HTML, baseUrl: 'https://localhost/' }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            allowFileAccess
            injectedJavaScriptBeforeContentLoaded={BRIDGE}
            onMessage={onMessage}
            style={{ flex: 1, backgroundColor: '#000' }}
          />
        ) : null}
        <SongPicker t={t} visible={pickOpen} onClose={() => setPickOpen(false)} onPick={openSong} title="Edit which song?" />
      </Screen>
    </Modal>
  );
}

// ---------- the button + clipboard watcher ----------
export default function Tools({ onChanged }) {
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState(false);
  const [yt, setYt] = useState(false);
  const [editor, setEditor] = useState(false);
  const [link, setLink] = useState('');
  const t = useAppTheme(menu || yt || editor);
  const lastSeen = useRef('');

  // When you copy a YouTube link and open the app, the link screen opens by itself
  useEffect(() => {
    const check = async () => {
      try {
        const text = ((await Clipboard.getStringAsync()) || '').trim();
        if (findVideoId(text, false) && text !== lastSeen.current) {
          lastSeen.current = text;
          setLink(text);
          setYt(true);
        }
      } catch (e) {}
    };
    const first = setTimeout(check, 1500);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        setTimeout(check, 500);
        setTimeout(check, 1500);
      }
    });
    return () => {
      clearTimeout(first);
      sub.remove();
    };
  }, []);

  const row = (icon, label, onPress) => (
    <TouchableOpacity onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', padding: 12 }}>
      <Ionicons name={icon} size={20} color={t.accent} />
      <Text style={{ marginLeft: 12, color: t.text, fontSize: 15, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <>
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
        {menu ? (
          <TouchableOpacity activeOpacity={1} onPress={() => setMenu(false)} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
        ) : null}
        {menu ? (
          <View
            style={{
              position: 'absolute',
              right: 14,
              bottom: insets.bottom + 146,
              backgroundColor: t.card,
              borderRadius: 16,
              padding: 4,
              minWidth: 210,
              elevation: 8,
            }}
          >
            {row('logo-youtube', 'YouTube link', () => {
              setMenu(false);
              setYt(true);
            })}
            {row('pricetags', 'Tag editor', () => {
              setMenu(false);
              setEditor(true);
            })}
          </View>
        ) : null}
        <TouchableOpacity
          onPress={() => setMenu((m) => !m)}
          activeOpacity={0.85}
          style={{
            position: 'absolute',
            right: 14,
            bottom: insets.bottom + 92,
            width: 46,
            height: 46,
            borderRadius: 23,
            backgroundColor: t.accent,
            alignItems: 'center',
            justifyContent: 'center',
            elevation: 6,
          }}
        >
          <Ionicons name={menu ? 'close' : 'add'} size={26} color={t.onAccent} />
        </TouchableOpacity>
      </View>

      <YouTubeSheet
        t={t}
        visible={yt}
        initialLink={link}
        onClose={() => setYt(false)}
        onApplied={() => {
          setYt(false);
          if (onChanged) onChanged();
        }}
      />
      <TagEditor t={t} visible={editor} onClose={() => setEditor(false)} />
    </>
  );
}
