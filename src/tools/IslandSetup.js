// The Island setup screen: the three permissions Android needs, plus position and size.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, AppState, NativeModules, DeviceEventEmitter, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadSettings } from '../library';
import { getTheme } from '../theme';

const Island = NativeModules ? NativeModules.Island : null;

function useAppTheme(refresh) {
  const [t, setT] = useState(getTheme('dark'));
  useEffect(() => {
    loadSettings()
      .then((s) => setT(getTheme(s.theme)))
      .catch(() => {});
  }, [refresh]);
  return t;
}

function Step({ t, n, title, desc, ok, button, onPress }) {
  return (
    <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 14, marginTop: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: ok ? '#22C55E' : t.track,
          }}
        >
          {ok ? <Ionicons name="checkmark" size={18} color="#fff" /> : <Text style={{ color: t.text, fontWeight: '800' }}>{n}</Text>}
        </View>
        <Text style={{ flex: 1, marginLeft: 12, color: t.text, fontSize: 16, fontWeight: '800' }}>{title}</Text>
      </View>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 8 }}>{desc}</Text>
      {ok ? null : (
        <TouchableOpacity
          onPress={onPress}
          style={{ marginTop: 10, paddingVertical: 11, borderRadius: 12, alignItems: 'center', backgroundColor: t.accent }}
        >
          <Text style={{ color: t.onAccent, fontWeight: '800' }}>{button}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function Stepper({ t, label, value, unit, onChange, min, max, step }) {
  const b = (txt, d) => (
    <TouchableOpacity
      onPress={() => onChange(Math.max(min, Math.min(max, value + d)))}
      style={{ width: 40, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: t.track }}
    >
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>{txt}</Text>
    </TouchableOpacity>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
      <Text style={{ flex: 1, color: t.text, fontSize: 14 }}>{label}</Text>
      {b('−', -step)}
      <Text style={{ width: 64, textAlign: 'center', color: t.text, fontWeight: '700' }}>{value + ' ' + unit}</Text>
      {b('+', step)}
    </View>
  );
}

export default function IslandSetup() {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState({ accessibility: false, notification: false, battery: false });
  const [pf, setPf] = useState({ enabled: true, offset: 6, width: 120 });
  const t = useAppTheme(open);

  const refresh = useCallback(async () => {
    if (!Island) return null;
    try {
      const s = await Island.status();
      setSt(s);
      setPf(await Island.getPrefs());
      return s;
    } catch (e) {
      return null;
    }
  }, []);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('openIslandSetup', () => {
      refresh();
      setOpen(true);
    });
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    // the first time, open the setup by itself
    (async () => {
      try {
        if (!Island) return;
        const s = await refresh();
        const asked = await AsyncStorage.getItem('island.asked');
        if (!asked && s && !(s.accessibility && s.notification)) {
          await AsyncStorage.setItem('island.asked', '1');
          setTimeout(() => setOpen(true), 2500);
        }
      } catch (e) {}
    })();
    return () => {
      sub.remove();
      app.remove();
    };
  }, [refresh]);

  const setPref = (patch) => {
    const n = { ...pf, ...patch };
    setPf(n);
    if (Island) Island.setPrefs(!!n.enabled, n.offset, n.width);
  };

  const test = async () => {
    try {
      const ok = await Island.demo();
      if (!ok) Alert.alert('Nothing to show yet', 'Turn on the permissions above, play a song, then press the home button and tap Test again.');
    } catch (e) {}
  };

  const all = st.accessibility && st.notification;

  return (
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 52 }}>
          <TouchableOpacity onPress={() => setOpen(false)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-down" size={28} color={t.text} />
          </TouchableOpacity>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '800' }}>Dynamic Island</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {!Island ? (
            <Text style={{ color: t.muted }}>This build does not include the Island. Install the newest build.</Text>
          ) : (
            <>
              <Text style={{ color: t.muted, fontSize: 14 }}>
                The island shows what is playing on top of every app. Android needs these permissions for that.
              </Text>
              {all ? (
                <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: '#14532D' }}>
                  <Text style={{ color: '#fff', fontWeight: '800' }}>All set ✓ Play a song and leave the app.</Text>
                </View>
              ) : null}

              <Step
                t={t}
                n={1}
                ok={st.accessibility}
                title="Accessibility service"
                desc={'Opens Accessibility settings. Find "Music Plus Island" (under Installed / Downloaded apps), turn it on and confirm.'}
                button="Open Accessibility settings"
                onPress={() => Island.openAccessibility()}
              />
              <Step
                t={t}
                n={2}
                ok={st.notification}
                title="Notification access"
                desc={'Lets the island see which song is playing. Turn on "Music Plus Island" in the list.'}
                button="Open Notification access"
                onPress={() => Island.openNotificationAccess()}
              />
              <Step
                t={t}
                n={3}
                ok={st.battery}
                title="Battery"
                desc="Stops Android from closing the island in the background. Choose Allow."
                button="Allow in the background"
                onPress={() => Island.requestBattery()}
              />

              {!st.accessibility || !st.notification ? (
                <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 14, marginTop: 12 }}>
                  <Text style={{ color: t.text, fontWeight: '800' }}>Switch is greyed out?</Text>
                  <Text style={{ color: t.muted, fontSize: 13, marginTop: 6 }}>
                    Android blocks this for apps installed from outside the Play Store. Open App info, tap the three dots at the top right,
                    choose "Allow restricted settings", then try step 1 and 2 again.
                  </Text>
                  <TouchableOpacity
                    onPress={() => Island.openAppInfo()}
                    style={{ marginTop: 10, paddingVertical: 11, borderRadius: 12, alignItems: 'center', backgroundColor: t.track }}
                  >
                    <Text style={{ color: t.text, fontWeight: '800' }}>Open App info</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 14, marginTop: 12 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }}>Look</Text>
                <TouchableOpacity onPress={() => setPref({ enabled: !pf.enabled })} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
                  <Ionicons name={pf.enabled ? 'toggle' : 'toggle-outline'} size={34} color={t.accent} />
                  <Text style={{ marginLeft: 10, color: t.text, fontSize: 14 }}>Show the island</Text>
                </TouchableOpacity>
                <Stepper t={t} label="Distance from the top" value={pf.offset} unit="dp" min={0} max={60} step={2} onChange={(v) => setPref({ offset: v })} />
                <Stepper t={t} label="Pill width" value={pf.width} unit="dp" min={70} max={220} step={10} onChange={(v) => setPref({ width: v })} />
                <TouchableOpacity
                  onPress={test}
                  style={{ marginTop: 14, paddingVertical: 11, borderRadius: 12, alignItems: 'center', backgroundColor: t.accent }}
                >
                  <Text style={{ color: t.onAccent, fontWeight: '800' }}>Test</Text>
                </TouchableOpacity>
                <Text style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>
                  Tap the small pill to open it. It hides while Music Plus is open, because the app has its own island.
                </Text>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
