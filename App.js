// New root: your music player, unchanged, plus the Tools button on top of it.
import React, { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import MusicApp from './MusicApp';
import Tools from './src/tools/Tools';

export default function App() {
  const [k, setK] = useState(0);
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1 }}>
        {/* changing the key reloads the song list, so your edits show up straight away */}
        <MusicApp key={k} />
        <Tools onChanged={() => setK((n) => n + 1)} />
      </View>
    </SafeAreaProvider>
  );
}
