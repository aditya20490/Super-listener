// The splash animation. It covers the whole screen on top of the app, plays your Lottie animation,
// then fades away and shows the app that was loading underneath.
// splashSource.js is created by the build from your splash.json (it is empty when there is no splash.json).
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';
import LottieView from 'lottie-react-native';
import animation from './splashSource';

// how fast the animation plays: 1 = normal speed (4.4 seconds), 2 = twice as fast (2.2 seconds)
const SPEED = 2;
// how long the fade-out takes, in milliseconds
const FADE_MS = 300;
// safety: the splash is removed after this many milliseconds, whatever happens
const MAX_MS = 6000;

export default function SplashVideo() {
  const [gone, setGone] = useState(!animation);
  const fade = useRef(new Animated.Value(1)).current;
  const closing = useRef(false);

  const finish = () => {
    if (closing.current) return;
    closing.current = true;
    Animated.timing(fade, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start(() => setGone(true));
  };

  useEffect(() => {
    if (!animation) return undefined;
    const timer = setTimeout(finish, MAX_MS);
    return () => clearTimeout(timer);
  }, []);

  if (gone) return null;

  return (
    <Animated.View style={[styles.cover, { opacity: fade }]}>
      <LottieView
        source={animation}
        autoPlay
        loop={false}
        speed={SPEED}
        resizeMode="cover"
        style={StyleSheet.absoluteFill}
        onAnimationFinish={finish}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    zIndex: 9999,
    elevation: 9999,
  },
});
