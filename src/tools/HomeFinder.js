// Home screen search -> Music Finder results.
// When nothing on the phone matches what you typed, this takes the place of "Nothing matches your search.":
// it looks the song up online (the same search as Music Finder > Songs), shows the same result rows
// (cover, title, artist - album, Preview, Copy link), and adds a Download button on each row that runs the same
// download as Music Finder. Nothing on your phone is searched or changed here; this only shows when there is no local match.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Image, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import * as Engine from '../audioEngine';
import { useTheme } from '../theme';
import { TA, normaliseLink, openInApp, searchSongsOnline, runDownload, markLinkSeen } from './finderCore';

const WAIT_MS = 600; // waits for you to stop typing before asking the internet
const KEEP_MS = 10 * 60 * 1000; // the same search shown again within 10 minutes does not ask again
const PAUSE_JS = "var a=document.getElementById('a');if(a){a.pause();}true;";

const cache = new Map(); // search text -> { at, list }
function fromCache(q) {
  const hit = cache.get(q.toLowerCase());
  return hit && Date.now() - hit.at < KEEP_MS ? hit.list : null;
}
function remember(q, list) {
  cache.set(q.toLowerCase(), { at: Date.now(), list: list });
  if (cache.size > 12) cache.delete(cache.keys().next().value);
}

export default function HomeFinder({ query }) {
  const { t } = useTheme();
  const q = String(query || '').trim();

  // res = the answer for one search text. It is only used while it belongs to the text in the box.
  const [res, setRes] = useState(() => {
    const c = q ? fromCache(q) : null;
    return c ? { q: q, list: c, fail: false } : { q: null, list: null, fail: false };
  });
  const [tryNo, setTryNo] = useState(0);
  const [playingId, setPlayingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [log, setLog] = useState(null);
  const [copied, setCopied] = useState('');
  const previewRef = useRef(null);
  const alive = useRef(true);
  const timers = useRef([]);
  const skipWait = useRef(false);

  const later = (fn, ms) => {
    timers.current.push(
      setTimeout(() => {
        if (alive.current) fn();
      }, ms)
    );
  };

  // ---------- previews: a hidden page plays the 30 second clip, so your music player is not touched ----------
  const stopPreview = () => {
    try {
      if (previewRef.current) previewRef.current.injectJavaScript(PAUSE_JS);
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

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      timers.current.forEach(clearTimeout);
      try {
        if (previewRef.current) previewRef.current.injectJavaScript(PAUSE_JS);
      } catch (e) {}
    };
  }, []);

  // ---------- the online search ----------
  useEffect(() => {
    if (!q) return undefined;
    stopPreview();
    setLog(null);
    const cached = fromCache(q);
    if (cached) {
      setRes({ q: q, list: cached, fail: false });
      return undefined;
    }
    let live = true;
    const wait = skipWait.current ? 0 : WAIT_MS;
    skipWait.current = false;
    const timer = setTimeout(async () => {
      try {
        const list = await searchSongsOnline(q);
        if (!live) return;
        remember(q, list);
        setRes({ q: q, list: list, fail: false });
      } catch (e) {
        if (!live) return;
        setRes({ q: q, list: [], fail: true });
      }
    }, wait);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, tryNo]);

  const retry = () => {
    skipWait.current = true;
    setRes({ q: null, list: null, fail: false });
    setTryNo((n) => n + 1);
  };

  // ---------- download ----------
  const startDownload = async (s) => {
    const l = normaliseLink(s.apple);
    if (!l) {
      setLog({ k: 'bad', m: 'This result has no Apple Music song link, so it can not be downloaded.' });
      return;
    }
    if (!TA || !TA.run) {
      setLog({ k: 'bad', m: 'Task Automator is not available in this build.' });
      return;
    }
    stopPreview();
    setBusyId(s.id);
    setLog({ k: '', m: 'Starting "' + s.title + '". A browser screen opens and does the steps for you.' });
    try {
      const out = await runDownload(l);
      if (alive.current) setLog({ k: 'good', m: 'Running ' + out.steps + ' steps. The file lands in your Downloads folder.' });
    } catch (e) {
      if (alive.current) setLog({ k: 'bad', m: 'Could not start: ' + (e && e.message ? e.message : e) });
    }
    later(() => setBusyId(null), 1500);
  };

  // One tap puts the song's Apple Music link on the clipboard (marked as seen, so Music Finder does not pop open for it)
  const copyLink = async (s) => {
    if (!s.apple) return;
    await markLinkSeen(s.apple);
    try {
      await Clipboard.setStringAsync(s.apple);
      setCopied(s.apple);
    } catch (e) {
      setCopied('');
      setLog({ k: 'bad', m: 'Could not copy the link.' });
      return;
    }
    later(() => setCopied(''), 1800);
  };

  // ---------- look: the Music Finder rows in the home screen's colours ----------
  const line = t.track;
  const cur = res.q === q ? res : null;
  const list = cur ? cur.list : null;

  const iconBtn = (key, icon, color, bg, onPress, label, disabled, busy) => (
    <TouchableOpacity
      key={key}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityLabel={label}
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
      style={{ width: 38, height: 38, borderRadius: 10, marginLeft: 6, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : <Ionicons name={icon} size={19} color={color} />}
    </TouchableOpacity>
  );

  return (
    <View style={{ marginHorizontal: 16, marginTop: 14, paddingBottom: 8 }}>
      {/* what this is: the song is not on the phone, these come from the internet */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
        <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="globe-outline" size={21} color={t.onAccent} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '800' }} numberOfLines={2}>
            {'Not on your phone: "' + q + '"'}
          </Text>
          <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>Online results from Apple Music. Tap the download button on a song to get it.</Text>
        </View>
      </View>

      {!cur ? (
        <View style={{ alignItems: 'center', padding: 24 }}>
          <ActivityIndicator color={t.accent} />
          <Text style={{ color: t.muted, marginTop: 10 }}>Searching online...</Text>
        </View>
      ) : null}

      {cur && cur.fail ? (
        <View style={{ alignItems: 'center', padding: 24 }}>
          <Text style={{ color: t.muted, textAlign: 'center' }}>Could not reach the online search. Check your internet and try again.</Text>
          <TouchableOpacity onPress={retry} activeOpacity={0.8} style={{ marginTop: 14, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12, backgroundColor: t.accent }}>
            <Text style={{ color: t.onAccent, fontWeight: '700', fontSize: 15 }}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {cur && !cur.fail && list.length === 0 ? <Text style={{ color: t.muted, textAlign: 'center', padding: 28 }}>Nothing found online either. Try other words.</Text> : null}

      {log ? (
        <Text style={{ fontSize: 13, lineHeight: 21, marginBottom: 10, marginHorizontal: 2, color: log.k === 'bad' ? '#ff453a' : log.k === 'good' ? '#34c759' : t.muted }}>{log.m}</Text>
      ) : null}

      {list
        ? list.map((s) => (
            <TouchableOpacity
              key={s.id}
              activeOpacity={0.85}
              onPress={() => openInApp(s.apple)}
              style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.card, borderWidth: 1, borderColor: line, borderRadius: 14, padding: 10, marginBottom: 10 }}
            >
              <Image source={{ uri: s.art }} style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: line }} />
              <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                <Text style={{ color: t.text, fontWeight: '700' }} numberOfLines={1}>
                  {s.title}
                </Text>
                <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }} numberOfLines={1}>
                  {s.artist + ' \u2022 ' + s.album}
                </Text>
              </View>
              {s.preview ? iconBtn('pv', playingId === s.id ? 'stop' : 'play', t.text, line, () => togglePreview(s), playingId === s.id ? 'Stop preview' : 'Preview') : null}
              {s.apple ? iconBtn('cp', copied === s.apple ? 'checkmark' : 'copy-outline', copied === s.apple ? t.accent : t.text, line, () => copyLink(s), 'Copy link') : null}
              {s.apple ? iconBtn('dl', 'download-outline', t.onAccent, t.accent, () => startDownload(s), 'Download', busyId !== null, busyId === s.id) : null}
            </TouchableOpacity>
          ))
        : null}

      {/* hidden: plays the preview clips */}
      {list && list.length > 0 ? (
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
      ) : null}
    </View>
  );
}
