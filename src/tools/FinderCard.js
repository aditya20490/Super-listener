// The "Find it online" card at the end of your song list. With a search typed, it offers that search in Music Finder.
import React from 'react';
import { View, Text, TouchableOpacity, DeviceEventEmitter } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';

export default function FinderCard({ query }) {
  const { t } = useTheme();
  const q = String(query || '').trim();
  const go = (tab) => DeviceEventEmitter.emit('openFinder', { tab: tab, query: q });

  const chip = (tab, icon, label) => (
    <TouchableOpacity
      key={tab}
      onPress={() => go(tab)}
      activeOpacity={0.8}
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: tab === 'songs' ? t.accent : t.track,
      }}
    >
      <Ionicons name={icon} size={16} color={tab === 'songs' ? t.onAccent : t.text} />
      <Text style={{ marginLeft: 6, fontWeight: '800', fontSize: 13, color: tab === 'songs' ? t.onAccent : t.text }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={{ marginHorizontal: 16, marginTop: 18, marginBottom: 8, padding: 14, borderRadius: 18, backgroundColor: t.card }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: t.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="globe-outline" size={22} color={t.onAccent} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '800' }} numberOfLines={2}>
            {q ? 'Not on your phone? Find "' + q + '" online' : 'Music Finder'}
          </Text>
          <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
            {q ? 'Search Apple Music, covers and lyrics' : 'Search songs, covers and lyrics, or download from an Apple Music link'}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {q ? [chip('songs', 'musical-notes', 'Songs'), chip('covers', 'image', 'Covers'), chip('lyrics', 'document-text', 'Lyrics')] : chip('songs', 'search', 'Open Music Finder')}
      </View>
    </View>
  );
}
