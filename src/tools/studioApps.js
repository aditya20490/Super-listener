// Opens Vocal Splitter or Voice Cloner from the hamburger menu.
// Both are your original apps (their engines are not touched). This file only hands them the Music Plus
// theme you picked in settings, so they open in the same colors. If the build was made without them,
// it says so instead of crashing.
import { NativeModules, Alert } from 'react-native';
import { loadSettings } from '../library';
import { getTheme } from '../theme';

export async function openStudioApp(which) {
  const M = NativeModules ? NativeModules.StudioApps : null;
  if (!M || !M.open) {
    Alert.alert('Not in this build', 'This version of Music Plus was built without Vocal Splitter and Voice Cloner.');
    return;
  }
  let t = getTheme('dark');
  try {
    const s = await loadSettings();
    t = getTheme(s.theme);
  } catch (e) {}
  const look = {
    id: t.id,
    isDark: !!t.isDark,
    bg: t.bg,
    bgTop: t.bgTop,
    card: t.card,
    text: t.text,
    muted: t.muted,
    accent: t.accent,
    accent2: t.accent2,
    track: t.track,
    onAccent: t.onAccent,
  };
  try {
    await M.open(which, JSON.stringify(look));
  } catch (e) {
    Alert.alert('Could not open', String(e && e.message ? e.message : e));
  }
}
