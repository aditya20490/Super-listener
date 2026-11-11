// New root: your music player, unchanged, plus the Tools button, the Island setup and the MKA bundles on top of it.
import React, { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import MusicApp from './MusicApp';
import Tools from './src/tools/Tools';
import IslandSetup from './src/tools/IslandSetup';
import MkaScreen from './src/tools/MkaScreen';
import SplashVideo from './src/tools/SplashVideo';

export default function App() {
  const [k, setK] = useState(0);
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1 }}>
        {/* changing the key reloads the song list, so your edits show up straight away */}
        <MusicApp key={k} />
        <Tools onChanged={() => setK((n) => n + 1)} />
        <IslandSetup />
        <MkaScreen />
        {/* the splash video sits on top for a moment while the app loads underneath, then fades away */}
        <SplashVideo />
      </View>
    </SafeAreaProvider>
  );
}
