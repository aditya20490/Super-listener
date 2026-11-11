// The splash video. It covers the whole screen on top of the app, plays the first moment of your video,
// then fades away and shows the app that was loading underneath.
// The video comes from splashSource.js, which the build creates by itself (it is empty when there is no video in the repo).
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import source from './splashSource';

// how long the splash stays on screen, in milliseconds (1500 = 1.5 seconds)
const SHOW_MS = 1500;
// how long the fade-out takes, in milliseconds
const FADE_MS = 300;

function Player({ onDone }) {
  const fade = useRef(new Animated.Value(1)).current;
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.muted = true;
    p.play();
  });

  useEffect(() => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      Animated.timing(fade, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start(() => onDone());
    };
    const timer = setTimeout(finish, SHOW_MS);
    const subs = [];
    try {
      subs.push(player.addListener('playToEnd', finish));
      // if the video can't be loaded for some reason, don't hold the app back
      subs.push(player.addListener('statusChange', (e) => {
        if (e && e.status === 'error') finish();
      }));
    } catch (e) {}
    return () => {
      clearTimeout(timer);
      subs.forEach((s) => s && s.remove && s.remove());
    };
  }, []);

  return (
    <Animated.View style={[styles.cover, { opacity: fade }]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        surfaceType="textureView"
      />
    </Animated.View>
  );
}

export default function SplashVideo() {
  const [gone, setGone] = useState(!source);
  if (gone) return null;
  return <Player onDone={() => setGone(true)} />;
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    zIndex: 9999,
    elevation: 9999,
  },
});
