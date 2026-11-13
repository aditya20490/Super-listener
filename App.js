// New root: your music player, unchanged, plus the Tools button, the Island setup and the MKA bundles on top of it.
// Plus the start screen: plain black, your symbol fades in, then the whole thing fades away into the app.
import React, { useEffect, useRef, useState } from 'react';
import { View, Image, Animated, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import MusicApp from './MusicApp';
import Tools from './src/tools/Tools';
import IslandSetup from './src/tools/IslandSetup';
import MkaScreen from './src/tools/MkaScreen';

// keeps the phone's own (plain black) start screen until our black screen below is ready, so nothing flashes
try {
  SplashScreen.preventAutoHideAsync().catch(() => {});
} catch (e) {}

function hideNativeSplash() {
  try {
    if (SplashScreen.hideAsync) SplashScreen.hideAsync().catch(() => {});
    else if (SplashScreen.hide) SplashScreen.hide();
  } catch (e) {}
}

function StartScreen({ onDone }) {
  const logo = useRef(new Animated.Value(0)).current;
  const cover = useRef(new Animated.Value(1)).current;
  const started = useRef(false);

  const begin = () => {
    if (started.current) return;
    started.current = true;
    hideNativeSplash();
    Animated.sequence([
      Animated.timing(logo, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.delay(250),
      Animated.timing(cover, { toValue: 0, duration: 350, useNativeDriver: true }),
    ]).start(() => onDone());
  };

  // safety: if the screen never reports ready, still go on after a moment
  useEffect(() => {
    const t = setTimeout(begin, 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <Animated.View
      pointerEvents="auto"
      onLayout={begin}
      style={[st.cover, { opacity: cover }]}
    >
      <Animated.Image
        source={require('./assets/splash-logo.png')}
        resizeMode="contain"
        style={[
          st.logo,
          {
            opacity: logo,
            transform: [{ scale: logo.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
          },
        ]}
      />
    </Animated.View>
  );
}

export default function App() {
  const [k, setK] = useState(0);
  const [intro, setIntro] = useState(true);
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: '#000000' }}>
        {/* changing the key reloads the song list, so your edits show up straight away */}
        <MusicApp key={k} />
        <Tools onChanged={() => setK((n) => n + 1)} />
        <IslandSetup />
        <MkaScreen />
        {intro ? <StartScreen onDone={() => setIntro(false)} /> : null}
      </View>
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    elevation: 9999,
  },
  logo: { width: 190, height: 190 },
});
