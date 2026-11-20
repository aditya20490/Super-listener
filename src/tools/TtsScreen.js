// Text to Speech: type something, pick a voice, and the phone reads it out loud. 100% offline.
// The voices are Kokoro, an AI voice model packed inside the app and run on the phone by the native module
// "KokoroTts" (native-tts/TtsModule.kt). Opens from the hamburger menu (patch-finder.js adds the menu row).
// If the build could not include the voice engine, this screen says so instead of crashing.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, TextInput, ScrollView, NativeModules, DeviceEventEmitter, Alert, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Engine from '../audioEngine';
import { Screen, Btn, useAppTheme } from './Tools';
import { saveFile } from './saver';

const K = NativeModules ? NativeModules.KokoroTts : null;
const PREFS_KEY = 'tts_prefs_v1';

// "sid" is the voice's number inside the Kokoro model. Rename the labels any time, only the number matters.
const GROUPS = [
  {
    title: 'US female',
    voices: [
      { sid: 3, name: 'Heart' },
      { sid: 2, name: 'Bella' },
      { sid: 6, name: 'Nicole' },
      { sid: 10, name: 'Sky' },
      { sid: 7, name: 'Nova' },
      { sid: 9, name: 'Sarah' },
    ],
  },
  {
    title: 'US male',
    voices: [
      { sid: 11, name: 'Adam' },
      { sid: 16, name: 'Michael' },
      { sid: 14, name: 'Fenrir' },
      { sid: 18, name: 'Puck' },
      { sid: 17, name: 'Onyx' },
    ],
  },
  {
    title: 'British female',
    voices: [
      { sid: 21, name: 'Emma' },
      { sid: 22, name: 'Isabella' },
      { sid: 23, name: 'Lily' },
    ],
  },
  {
    title: 'British male',
    voices: [
      { sid: 26, name: 'George' },
      { sid: 25, name: 'Fable' },
      { sid: 27, name: 'Lewis' },
    ],
  },
];
const ALL = GROUPS.reduce((a, g) => a.concat(g.voices), []);
const SPEEDS = [0.8, 1, 1.2, 1.4];

const errText = (e) => String((e && e.message) || e || 'Something went wrong');

export default function TtsScreen() {
  const [open, setOpen] = useState(false);
  const t = useAppTheme(open);
  const [text, setText] = useState('');
  const [sid, setSid] = useState(3);
  const [speed, setSpeed] = useState(1);
  const [phase, setPhase] = useState('idle'); // loading | idle | speaking | saving
  const [err, setErr] = useState('');
  const ready = useRef(false);
  const runId = useRef(0);

  const voice = ALL.find((v) => v.sid === sid) || ALL[0];

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openTts', () => setOpen(true));
    return () => sub.remove();
  }, []);

  // remembered text, voice and speed
  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY)
      .then((raw) => {
        if (!raw) return;
        const p = JSON.parse(raw);
        if (typeof p.text === 'string') setText(p.text);
        if (ALL.some((v) => v.sid === p.sid)) setSid(p.sid);
        if (SPEEDS.indexOf(p.speed) >= 0) setSpeed(p.speed);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const id = setTimeout(() => {
      AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ text: text, sid: sid, speed: speed })).catch(() => {});
    }, 600);
    return () => clearTimeout(id);
  }, [text, sid, speed]);

  // the first time, the voice model is loaded into memory (a few seconds)
  useEffect(() => {
    if (!open || !K || ready.current) return undefined;
    let alive = true;
    setPhase('loading');
    K.prepare()
      .then(() => {
        ready.current = true;
        if (alive) setPhase('idle');
      })
      .catch((e) => {
        if (alive) {
          setErr(errText(e));
          setPhase('idle');
        }
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const stop = () => {
    runId.current++;
    setPhase('idle');
    try {
      if (K) K.stop();
    } catch (e) {}
  };

  const close = () => {
    stop();
    setOpen(false);
  };

  const say = async (what) => {
    const s = String(what || '').trim();
    if (!K) return;
    if (!s) {
      Alert.alert('Nothing to read', 'Type or paste some text first.');
      return;
    }
    setErr('');
    try {
      if (Engine.player && Engine.player.pause) Engine.player.pause(); // your music pauses while the voice talks
    } catch (e) {}
    const my = ++runId.current;
    setPhase('speaking');
    try {
      await K.speak(s, sid, speed);
    } catch (e) {
      if (runId.current === my) setErr(errText(e));
    }
    if (runId.current === my) setPhase('idle');
  };

  const sample = () => say('Hi, I am ' + voice.name + '. This is how I sound, running fully on your phone.');

  const save = async () => {
    const s = text.trim();
    if (!K) return;
    if (!s) {
      Alert.alert('Nothing to save', 'Type or paste some text first.');
      return;
    }
    setErr('');
    setPhase('saving');
    try {
      const p = await K.saveWav(s, sid, speed);
      const where = await saveFile(p, 'Voice_' + voice.name + '_' + Date.now() + '.wav', 'audio/wav', false);
      Alert.alert('Saved', 'Saved in ' + where);
    } catch (e) {
      setErr(errText(e));
    }
    setPhase('idle');
  };

  const busy = phase === 'loading' || phase === 'saving';
  const speaking = phase === 'speaking';

  const chip = (label, on, onPress, key) => (
    <TouchableOpacity
      key={key}
      activeOpacity={0.8}
      onPress={onPress}
      style={{
        paddingVertical: 9,
        paddingHorizontal: 14,
        borderRadius: 20,
        marginRight: 8,
        marginBottom: 8,
        backgroundColor: on ? t.accent : t.track,
      }}
    >
      <Text style={{ fontWeight: '800', fontSize: 13, color: on ? t.onAccent : t.text }}>{label}</Text>
    </TouchableOpacity>
  );

  const body = K ? (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder="Type or paste what you want it to say"
        placeholderTextColor={t.muted}
        style={{
          minHeight: 150,
          maxHeight: 300,
          textAlignVertical: 'top',
          backgroundColor: t.card,
          color: t.text,
          borderRadius: 16,
          padding: 14,
          fontSize: 16,
        }}
      />

      <View style={{ flexDirection: 'row', marginTop: 14 }}>
        {speaking ? (
          <Btn t={t} icon="stop" label="Stop" onPress={stop} style={{ flex: 1 }} />
        ) : (
          <Btn t={t} icon="play" label="Speak" onPress={() => say(text)} disabled={busy} style={{ flex: 1 }} />
        )}
        <Btn t={t} icon="volume-medium" label="Sample" alt onPress={sample} disabled={busy || speaking} style={{ marginLeft: 8 }} />
        <Btn t={t} icon="download" label="Save" alt onPress={save} disabled={busy || speaking} style={{ marginLeft: 8 }} />
      </View>

      {phase === 'loading' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
          <ActivityIndicator color={t.accent} />
          <Text style={{ color: t.muted, marginLeft: 10, flex: 1 }}>Getting the voice engine ready. The first time takes a few seconds.</Text>
        </View>
      ) : null}
      {phase === 'saving' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
          <ActivityIndicator color={t.accent} />
          <Text style={{ color: t.muted, marginLeft: 10, flex: 1 }}>Making the audio file...</Text>
        </View>
      ) : null}
      {err ? <Text style={{ color: '#ff6b6b', marginTop: 14 }}>{err}</Text> : null}

      <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 24, marginBottom: 10 }}>Speed</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{SPEEDS.map((x) => chip(x + 'x', speed === x, () => setSpeed(x), 'sp' + x))}</View>

      {GROUPS.map((g) => (
        <View key={g.title}>
          <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 10 }}>{g.title}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{g.voices.map((v) => chip(v.name, sid === v.sid, () => setSid(v.sid), 'v' + v.sid))}</View>
        </View>
      ))}
    </ScrollView>
  ) : (
    <View style={{ padding: 24 }}>
      <Ionicons name="alert-circle-outline" size={36} color={t.muted} style={{ alignSelf: 'center' }} />
      <Text style={{ color: t.muted, textAlign: 'center', marginTop: 12 }}>
        The voice engine is not part of this build of the app. Open the release notes of this build on GitHub, they say why.
      </Text>
    </View>
  );

  return (
    <View pointerEvents="box-none">
      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <Screen t={t} title="Text to Speech" onClose={close}>
          {body}
        </Screen>
      </Modal>
    </View>
  );
}
