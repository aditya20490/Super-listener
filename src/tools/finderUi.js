// Look and feel for the Music Finder screen: pure black OLED style, grouped cards, squircle icons, spring presses,
// bottom sheets and the little "live activity" pill. This file only draws things. All the real work (searching,
// downloading, previews, clipboard) stays in FinderScreen.js, exactly as before.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Modal, TextInput, Animated, Easing, PanResponder, Pressable, Dimensions, Vibration, PermissionsAndroid, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// ---------- haptics (short, soft pulses; quietly does nothing if the phone does not allow vibration) ----------
let vibOk = null;
function canVibrate() {
  if (vibOk === null) {
    vibOk = false;
    try {
      if (Platform.OS === 'android' && PermissionsAndroid && PermissionsAndroid.check) {
        PermissionsAndroid.check('android.permission.VIBRATE')
          .then((r) => {
            vibOk = !!r;
          })
          .catch(() => {});
      } else {
        vibOk = true;
      }
    } catch (e) {}
  }
  return vibOk === true;
}
canVibrate();
const buzz = (p) => {
  try {
    if (canVibrate()) Vibration.vibrate(p);
  } catch (e) {}
};
export const haptic = {
  tick: () => buzz(10),
  tap: () => buzz(14),
  success: () => buzz([0, 12, 60, 22]),
  warn: () => buzz(26),
};

// ---------- the colours from the mockup ----------
export const C = {
  bg: '#000000',
  card: '#1C1C1E',
  input: '#0D0D0F',
  pill: '#2C2C2E',
  list: '#121214',
  muted: '#8E8E93',
  ph: '#636366',
  text: '#FFFFFF',
  hair: 'rgba(255,255,255,0.08)',
  hair2: 'rgba(255,255,255,0.07)',
  inBorder: 'rgba(255,255,255,0.09)',
  green: '#30D158',
  red: '#FF453A',
  blue: '#0A84FF',
};

export const ACC = {
  songs: { c: '#FA2D48', glow: 'rgba(250,45,72,0.22)', shadow: '#FA2D48', icon: 'musical-notes', ink: '#FFFFFF' },
  covers: { c: '#0A84FF', glow: 'rgba(10,132,255,0.22)', shadow: '#0A84FF', icon: 'image', ink: '#FFFFFF' },
  lyrics: { c: '#BF5AF2', glow: 'rgba(191,90,242,0.22)', shadow: '#BF5AF2', icon: 'document-text', ink: '#FFFFFF' },
  automate: { c: '#FF9F0A', glow: 'rgba(255,159,10,0.22)', shadow: '#FF9F0A', icon: 'flash', ink: '#000000' },
};

export const TAB_META = {
  songs: {
    kicker: 'Songs',
    title: 'About Songs',
    text: 'Paste an Apple Music song link and tap Download. Tracks are grabbed in the background and saved straight to your Music folder, or search by song/artist below.',
  },
  covers: {
    kicker: 'Covers',
    title: 'About Covers',
    text: 'Uses the iTunes Artwork Finder method to fetch both standard and uncompressed 3000×3000 album covers.',
  },
  lyrics: {
    kicker: 'Lyrics',
    title: 'About Lyrics',
    text: 'Type a song or artist to open the real Lyricsify page right inside the app. Use the close button on the top left of the opened page to return here.',
  },
  automate: {
    kicker: 'Automate',
    title: 'About Automate',
    text: 'Run automated batch jobs (lyrics, uncompressed covers, metadata cleanup) across your library via Task Automator.',
  },
};

const EASE = Easing.bezier(0.22, 1, 0.36, 1);

// ---------- a button or row that sinks in with a little spring when you press it ----------
const AP = Animated.createAnimatedComponent(Pressable);
export function Press({ onPress, style, children, scale = 0.97, disabled, haptics = true, tint, hitSlop, onLongPress }) {
  const s = useRef(new Animated.Value(1)).current;
  const [down, setDown] = useState(false);
  const to = (v) => Animated.spring(s, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 9 }).start();
  return (
    <AP
      disabled={disabled}
      hitSlop={hitSlop}
      onLongPress={onLongPress}
      onPressIn={() => {
        to(scale);
        if (tint) setDown(true);
      }}
      onPressOut={() => {
        to(1);
        if (tint) setDown(false);
      }}
      onPress={() => {
        if (haptics) haptic.tick();
        if (onPress) onPress();
      }}
      style={[style, { transform: [{ scale: s }] }, down && tint ? { backgroundColor: tint } : null]}
    >
      {children}
    </AP>
  );
}

// ---------- a spinning ring (the progress ring) ----------
export function Ring({ size = 18, color = '#fff', width = 2.4, track = 'rgba(255,255,255,0.18)' }) {
  const r = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(r, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, []);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: width,
        borderColor: track,
        borderTopColor: color,
        transform: [{ rotate: r.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
      }}
    />
  );
}

// ---------- the squircle icon with a soft top shine ----------
export function Squircle({ size = 24, radius = 7, color, icon, ink = '#fff', iconSize }) {
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: color, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: size / 2, backgroundColor: 'rgba(255,255,255,0.14)' }} />
      <Ionicons name={icon} size={iconSize || Math.round(size * 0.58)} color={ink} />
    </View>
  );
}

// ---------- big page heading: small gradient-style icon + eyebrow, then the 32px title ----------
export function Header({ acc, eyebrow, title }) {
  return (
    <View style={{ marginTop: 6, marginBottom: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <Squircle size={24} radius={7} color={acc.c} icon={acc.icon} ink={acc.ink} />
        <Text style={{ color: acc.c, fontSize: 11, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase', marginLeft: 8 }}>{eyebrow}</Text>
      </View>
      <Text style={{ color: C.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.8 }}>{title}</Text>
    </View>
  );
}

export function Eyebrow({ left, right, color }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 10, marginHorizontal: 4 }}>
      <Text style={{ color: color || C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase' }}>{left}</Text>
      {right ? <Text style={{ color: C.muted, fontSize: 12, fontWeight: '600' }}>{right}</Text> : null}
    </View>
  );
}

export function Card({ children, style }) {
  return (
    <View style={[{ backgroundColor: C.card, borderWidth: 1, borderColor: C.hair, borderRadius: 18, padding: 14, marginBottom: 16 }, style]}>{children}</View>
  );
}

export function Label({ children }) {
  return <Text style={{ color: C.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8, marginLeft: 2 }}>{children}</Text>;
}

// ---------- text box: dark, round, and it glows in the page colour when you tap into it ----------
export function Field({ acc, icon, onClear, style, ...rest }) {
  const [focus, setFocus] = useState(false);
  const has = rest.value && String(rest.value).length > 0;
  return (
    <View style={[{ padding: 3, borderRadius: 16, backgroundColor: focus ? acc.glow : 'transparent', marginHorizontal: -3, marginBottom: 9 }, style]}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          height: 48,
          borderRadius: 13,
          backgroundColor: C.input,
          borderWidth: 1,
          borderColor: focus ? acc.c : C.inBorder,
          paddingHorizontal: 14,
        }}
      >
        {icon ? <Ionicons name={icon} size={18} color={C.muted} style={{ marginRight: 9 }} /> : null}
        <TextInput
          {...rest}
          placeholderTextColor={C.ph}
          selectionColor={acc.c}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{ flex: 1, color: C.text, fontSize: 16, paddingVertical: 0, height: 46 }}
        />
        {onClear && has ? (
          <Press onPress={onClear} scale={0.88} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: C.pill, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="close" size={14} color={C.muted} />
          </Press>
        ) : null}
      </View>
    </View>
  );
}

// ---------- the big colour / white action button ----------
export function Action({ label, icon, color, ink = '#fff', onPress, disabled, working, style, height = 48, glow = true }) {
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      style={[
        {
          height,
          borderRadius: 14,
          backgroundColor: color,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.6 : 1,
        },
        glow
          ? { shadowColor: color, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: color === '#FFFFFF' ? 0 : 6 }
          : null,
        style,
      ]}
    >
      {working ? <Ring size={17} color={ink} track="rgba(255,255,255,0.25)" /> : icon ? <Ionicons name={icon} size={19} color={ink} /> : null}
      <Text style={{ color: ink, fontSize: 16, fontWeight: '700', marginLeft: working || icon ? 8 : 0 }}>{label}</Text>
    </Press>
  );
}

// ---------- pages slide and fade in ----------
export function TabEnter({ children }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 280, easing: EASE, useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View
      style={{
        opacity: a,
        transform: [
          { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          { scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.99, 1] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

// ---------- results pop in one after another ----------
export function Pop({ index = 0, children, style }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 340, delay: Math.min(index, 8) * 45, easing: EASE, useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: a,
          transform: [
            { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
            { scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

// ---------- bottom sheet: springs up, swipe the handle down to close ----------
export function Sheet({ visible, onClose, children, bottom = 16, maxHeight = '82%' }) {
  const H = Dimensions.get('window').height;
  const p = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(!!visible);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (visible) {
      drag.setValue(0);
      setMounted(true);
      Animated.timing(p, { toValue: 1, duration: 380, easing: EASE, useNativeDriver: true }).start();
    } else {
      Animated.timing(p, { toValue: 0, duration: 260, easing: EASE, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 90 || g.vy > 0.9) {
          haptic.tick();
          if (closeRef.current) closeRef.current();
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
        }
      },
      onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
    })
  ).current;

  const translateY = Animated.add(p.interpolate({ inputRange: [0, 1], outputRange: [H, 0] }), drag);

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', opacity: p }}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <Animated.View
          style={{
            backgroundColor: C.card,
            borderTopLeftRadius: 26,
            borderTopRightRadius: 26,
            borderTopWidth: 1,
            borderColor: C.hair,
            maxHeight,
            paddingBottom: bottom,
            transform: [{ translateY }],
          }}
        >
          <View {...pan.panHandlers} style={{ alignItems: 'center', paddingTop: 9, paddingBottom: 8 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)' }} />
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

// ---------- the live activity pill that drops in from the top ----------
export function LivePill({ pill, top }) {
  const p = useRef(new Animated.Value(0)).current;
  const bar = useRef(new Animated.Value(0)).current;
  const keep = useRef(pill);
  if (pill) keep.current = pill;
  const shown = !!pill;
  useEffect(() => {
    Animated.spring(p, { toValue: shown ? 1 : 0, useNativeDriver: true, friction: 8, tension: 70 }).start();
  }, [shown]);
  const working = !!(pill && pill.working);
  useEffect(() => {
    if (!working) return undefined;
    bar.setValue(0);
    const a = Animated.loop(Animated.timing(bar, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [working]);
  const d = keep.current;
  if (!d) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top, left: 0, right: 0, alignItems: 'center', zIndex: 50 }}>
      <Animated.View
        style={{
          width: 264,
          borderRadius: 24,
          backgroundColor: '#000',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.14)',
          paddingHorizontal: 12,
          paddingTop: 9,
          paddingBottom: 9,
          opacity: p.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }),
          transform: [
            { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [-70, 0] }) },
            { scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
          ],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {d.working ? (
            <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
              <Ring size={22} color={d.color} width={2.6} />
            </View>
          ) : (
            <Squircle size={30} radius={9} color={d.color} icon={d.icon} ink={d.ink || '#fff'} />
          )}
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: '700' }} numberOfLines={1}>
              {d.title}
            </Text>
            {d.sub ? (
              <Text style={{ color: C.muted, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                {d.sub}
              </Text>
            ) : null}
          </View>
        </View>
        {d.working ? (
          <View style={{ height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', marginTop: 8 }}>
            <Animated.View
              style={{
                width: 90,
                height: 3,
                borderRadius: 2,
                backgroundColor: d.color,
                transform: [{ translateX: bar.interpolate({ inputRange: [0, 1], outputRange: [-90, 240] }) }],
              }}
            />
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}
