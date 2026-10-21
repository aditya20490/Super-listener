// MKA bundles: put an original song and its remixes/edits into ONE .mka file, and play the versions.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, TextInput, ScrollView, NativeModules, DeviceEventEmitter, Alert, ActivityIndicator } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import * as Engine from '../audioEngine';
import { cleanTitle, formatTime } from '../utils';
import { Screen, Btn, SongPicker, useAppTheme } from './Tools';
import { FileSystem as FS, saveFile } from './saver';

const Mka = NativeModules ? NativeModules.Mka : null;

const toPath = (uri) => {
  const p = String(uri).replace(/^file:\/\//, '');
  try {
    return decodeURI(p);
  } catch (e) {
    return p;
  }
};
const safe = (s) => String(s || 'bundle').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'bundle';

// shows what is playing from a bundle (only mounted while the screen is open)
function NowBar({ t, now }) {
  const st = Engine.usePlayerStatus();
  const frac = st.duration > 0 ? Math.min(1, st.currentTime / st.duration) : 0;
  return (
    <View style={{ backgroundColor: t.card, padding: 12, borderTopWidth: 1, borderTopColor: t.track }}>
      <Text style={{ color: t.text, fontWeight: '800' }} numberOfLines={1}>
        {now.name}
      </Text>
      <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={1}>
        {now.title}
      </Text>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: t.track, marginTop: 8 }}>
        <View style={{ height: 4, borderRadius: 2, width: frac * 100 + '%', backgroundColor: t.accent }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
        <Text style={{ color: t.muted, fontSize: 12, width: 44 }}>{formatTime(st.currentTime)}</Text>
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
          <TouchableOpacity onPress={() => Engine.player.seekTo(Math.max(0, st.currentTime - 10))} style={{ padding: 8 }}>
            <Ionicons name="play-back" size={24} color={t.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => (st.playing ? Engine.player.pause() : Engine.player.play())}
            style={{ marginHorizontal: 14, width: 46, height: 46, borderRadius: 23, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}
          >
            <Ionicons name={st.playing ? 'pause' : 'play'} size={24} color={t.onAccent} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Engine.player.seekTo(st.currentTime + 10)} style={{ padding: 8 }}>
            <Ionicons name="play-forward" size={24} color={t.text} />
          </TouchableOpacity>
        </View>
        <Text style={{ color: t.muted, fontSize: 12, width: 44, textAlign: 'right' }}>{formatTime(st.duration)}</Text>
      </View>
    </View>
  );
}

export default function MkaScreen() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('create');
  const [title, setTitle] = useState('');
  const [items, setItems] = useState([]); // { key, uri, name }
  const [pickOpen, setPickOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [bundles, setBundles] = useState([]);
  const [detail, setDetail] = useState(null); // { b, info }
  const [now, setNow] = useState(null);
  const t = useAppTheme(open);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openMka', () => setOpen(true));
    return () => sub.remove();
  }, []);

  const loadBundles = useCallback(async () => {
    setBusy('Looking for bundles…');
    try {
      const perm = await MediaLibrary.getPermissionsAsync();
      if (!perm.granted) await MediaLibrary.requestPermissionsAsync();
      let after;
      let more = true;
      const found = [];
      while (more) {
        const p = await MediaLibrary.getAssetsAsync({ mediaType: MediaLibrary.MediaType.audio, first: 1000, after });
        for (const a of p.assets) {
          if (/\.mka$/i.test(a.filename || '')) found.push({ id: String(a.id), uri: a.uri, filename: a.filename, title: cleanTitle(a.filename || '') });
        }
        after = p.endCursor;
        more = p.hasNextPage;
      }
      setBundles(found);
    } catch (e) {}
    setBusy('');
  }, []);

  useEffect(() => {
    if (open && tab === 'bundles') loadBundles();
  }, [open, tab, loadBundles]);

  const addSong = (song) => {
    setPickOpen(false);
    setItems((l) => [...l, { key: song.id + '_' + Date.now(), uri: song.uri, name: song.title }]);
    if (!title) setTitle(song.title);
  };

  const rename = (key, name) => setItems((l) => l.map((x) => (x.key === key ? { ...x, name } : x)));
  const remove = (key) => setItems((l) => l.filter((x) => x.key !== key));
  const up = (key) =>
    setItems((l) => {
      const i = l.findIndex((x) => x.key === key);
      if (i <= 0) return l;
      const c = l.slice();
      const tmp = c[i - 1];
      c[i - 1] = c[i];
      c[i] = tmp;
      return c;
    });

  const create = async () => {
    if (!Mka || !FS) {
      Alert.alert('Not available', 'This build does not include the bundle maker. Install the newest build.');
      return;
    }
    if (items.length < 2) {
      Alert.alert('Add more versions', 'A bundle needs at least two songs (for example the original and a remix).');
      return;
    }
    const name = safe(title);
    setBusy('Creating the bundle…');
    try {
      const out = FS.cacheDirectory + name + '.mka';
      await Mka.create(JSON.stringify(items.map((i) => ({ uri: i.uri, name: i.name || 'Version' }))), title || name, toPath(out));
      const where = await saveFile(out, name + '.mka', 'audio/x-matroska', true);
      setBusy('');
      Alert.alert('Bundle created', 'Saved in ' + where + '\nOpen "My bundles" to play the versions.');
      setItems([]);
      setTitle('');
      setTab('bundles');
    } catch (e) {
      setBusy('');
      Alert.alert('Could not create the bundle', String(e && e.message ? e.message : e));
    }
  };

  const openBundle = async (b) => {
    setBusy('Opening…');
    try {
      const info = JSON.parse(await Mka.list(toPath(b.uri)));
      setDetail({ b, info });
    } catch (e) {
      Alert.alert('Could not open it', String(e && e.message ? e.message : e));
    }
    setBusy('');
  };

  const playVersion = async (tr) => {
    const { b, info } = detail;
    setBusy('Opening ' + tr.name + '…');
    try {
      const out = toPath(FS.cacheDirectory) + 'bundle_' + b.id + '_' + tr.number + '.mka';
      const p = await Mka.extract(toPath(b.uri), tr.number, out);
      await Engine.player.load(
        { id: 'mka_' + b.id + '_' + tr.number, uri: 'file://' + p, duration: (info.durationMs || 0) / 1000 },
        { title: tr.name, artist: info.title || b.title, album: info.title || b.title },
        1
      );
      setNow({ name: tr.name, title: info.title || b.title });
    } catch (e) {
      Alert.alert('Could not play it', String(e && e.message ? e.message : e));
    }
    setBusy('');
  };

  const tabBtn = (k, label) => (
    <TouchableOpacity
      onPress={() => {
        setTab(k);
        setDetail(null);
      }}
      style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 12, backgroundColor: tab === k ? t.accent : 'transparent' }}
    >
      <Text style={{ fontWeight: '800', color: tab === k ? t.onAccent : t.muted }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <Modal visible={open} animationType="slide" onRequestClose={() => (detail ? setDetail(null) : setOpen(false))} statusBarTranslucent>
      <Screen t={t} title="MKA bundles" onClose={() => setOpen(false)}>
        <View style={{ flexDirection: 'row', marginHorizontal: 16, padding: 3, borderRadius: 14, backgroundColor: t.track }}>
          {tabBtn('create', 'Create')}
          {tabBtn('bundles', 'My bundles')}
        </View>
        {busy ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10 }}>
            <ActivityIndicator color={t.accent} />
            <Text style={{ color: t.muted, marginLeft: 10 }}>{busy}</Text>
          </View>
        ) : null}

        {tab === 'create' ? (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            <Text style={{ color: t.muted, fontSize: 13 }}>
              Put the original song and its remixes or edits into one file. The audio is copied as it is, so the quality stays exactly the same.
            </Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Bundle name (the song name)"
              placeholderTextColor={t.muted}
              style={{ marginTop: 12, height: 46, borderRadius: 12, paddingHorizontal: 14, backgroundColor: t.card, color: t.text }}
            />
            {items.map((it, i) => (
              <View key={it.key} style={{ marginTop: 10, padding: 10, borderRadius: 14, backgroundColor: t.card }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ color: t.accent, fontWeight: '800', width: 22 }}>{i + 1}</Text>
                  <TextInput
                    value={it.name}
                    onChangeText={(v) => rename(it.key, v)}
                    placeholder="Version name (Original, Remix, TikTok edit…)"
                    placeholderTextColor={t.muted}
                    style={{ flex: 1, color: t.text, fontSize: 15, paddingVertical: 4 }}
                  />
                  {i > 0 ? (
                    <TouchableOpacity onPress={() => up(it.key)} style={{ padding: 6 }}>
                      <Ionicons name="arrow-up" size={20} color={t.text} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity onPress={() => remove(it.key)} style={{ padding: 6 }}>
                    <Ionicons name="trash-outline" size={20} color={t.muted} />
                  </TouchableOpacity>
                </View>
                {i === 0 ? <Text style={{ color: t.muted, fontSize: 11, marginLeft: 22 }}>Plays first by default</Text> : null}
              </View>
            ))}
            <Btn t={t} icon="add" label="Add a song from my library" alt onPress={() => setPickOpen(true)} style={{ marginTop: 12 }} />
            <Btn t={t} icon="albums" label="Create bundle" onPress={create} disabled={!!busy || items.length < 2} style={{ marginTop: 10 }} />
            <Text style={{ color: t.muted, fontSize: 12, marginTop: 10 }}>Works with MP3, M4A/AAC, FLAC and Opus songs.</Text>
          </ScrollView>
        ) : detail ? (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <TouchableOpacity onPress={() => setDetail(null)} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <Ionicons name="chevron-back" size={20} color={t.accent} />
              <Text style={{ color: t.accent, fontWeight: '700' }}>All bundles</Text>
            </TouchableOpacity>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>{detail.info.title || detail.b.title}</Text>
            <Text style={{ color: t.muted, marginTop: 2 }}>
              {detail.info.tracks.length} versions{detail.info.durationMs ? ' · ' + formatTime(detail.info.durationMs / 1000) : ''}
            </Text>
            {detail.info.tracks.map((tr) => (
              <TouchableOpacity
                key={tr.number}
                onPress={() => playVersion(tr)}
                style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, padding: 12, borderRadius: 14, backgroundColor: t.card }}
              >
                <Ionicons name="play-circle" size={30} color={t.accent} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>
                    {tr.name}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>
                    {tr.codec} · {tr.channels === 1 ? 'Mono' : tr.channels === 2 ? 'Stereo' : tr.channels + ' ch'} · {Math.round(tr.rate / 100) / 10} kHz
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            {bundles.length === 0 && !busy ? (
              <Text style={{ color: t.muted }}>
                No bundles found yet. Create one in the other tab. A .mka file from somewhere else shows up here once it is in your Music folder.
              </Text>
            ) : null}
            {bundles.map((b) => (
              <TouchableOpacity
                key={b.id}
                onPress={() => openBundle(b)}
                style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, padding: 12, borderRadius: 14, backgroundColor: t.card }}
              >
                <Ionicons name="albums" size={26} color={t.accent} />
                <Text style={{ flex: 1, marginLeft: 12, color: t.text, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>
                  {b.title}
                </Text>
                <Ionicons name="chevron-forward" size={20} color={t.muted} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {now && open ? <NowBar t={t} now={now} /> : null}
        <SongPicker t={t} visible={pickOpen} onClose={() => setPickOpen(false)} onPick={addSong} title="Add which song?" />
      </Screen>
    </Modal>
  );
}
