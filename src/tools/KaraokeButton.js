// The small K circle in the player, on the left of the heart (same size as the 8D circle).
//   outline          no karaoke yet: tap to make it (in the background, you get a pop-up)
//   faint fill       being made: tap for a reminder, long press to stop
//   accent outline + dot   ready: tap to switch to karaoke (seamless)
//   solid fill       karaoke is on (like 8D when it is on): tap to go back to the original
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Alert, ToastAndroid, Platform } from 'react-native';
import * as Karaoke from './karaoke';

function say(msg) {
  try {
    if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.LONG);
  } catch (e) {}
}

export default function KaraokeButton({ song, t }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const un = Karaoke.subscribe(() => setTick((n) => n + 1));
    return () => un();
  }, []);

  const st = Karaoke.stateFor(song);
  if (st.phase === 'hidden') return null;
  const working = st.phase === 'working';
  const ready = st.phase === 'ready';
  const on = st.phase === 'active';
  const accent = working || ready || on;

  const onPress = async () => {
    if (working) {
      say('Your karaoke is being made. You can keep listening.');
    } else if (st.phase === 'idle') {
      const r = await Karaoke.generate(song);
      if (r === 'busy') say('Another karaoke is being made right now' + (Karaoke.busyTitle() ? ': ' + Karaoke.busyTitle() : '') + '. Please wait until it is done.');
      else if (r === 'error') say('Could not start karaoke for this song.');
      else if (r === 'unsupported') say('This build of the app does not include karaoke.');
      else say('Your karaoke is being made. You can keep listening.');
    } else if (ready) {
      await Karaoke.activate();
    } else if (on) {
      await Karaoke.deactivate();
    }
  };

  const onLong = () => {
    if (!working) return;
    Alert.alert('Stop making karaoke?', 'The song will stay as it is.', [
      { text: 'Keep going', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => Karaoke.cancel() },
    ]);
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLong}
      activeOpacity={0.8}
      style={{
        marginRight: -1, // sits exactly above the 8D options circle
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: accent ? t.accent : t.muted,
        backgroundColor: on ? t.accent : 'transparent',
      }}
    >
      {working ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 15, backgroundColor: t.accent, opacity: 0.2 }} /> : null}
      {ready ? <View pointerEvents="none" style={{ position: 'absolute', top: -1, right: -1, width: 9, height: 9, borderRadius: 5, backgroundColor: t.accent }} /> : null}
      <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '900', color: on ? t.onAccent : accent ? t.accent : t.muted }}>K</Text>
    </TouchableOpacity>
  );
}
