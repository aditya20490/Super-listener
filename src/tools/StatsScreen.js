// The Statistics screen (menu > Statistics): how much you listen, your top songs and artists, when you listen,
// plus the reminder settings. It also starts the counting (stats.js) and the reminders (reminders.js) when the app opens.
// The numbers are saved outside the app too, so they come back after an uninstall and reinstall (see stats.js).
import React, { useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, Switch, DeviceEventEmitter, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen, useAppTheme } from './Tools';
import * as Stats from './stats';
import * as Reminders from './reminders';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: 'all', label: 'All time' },
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmt(sec) {
  const s = Math.round(sec || 0);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + ' h ' + (mm < 10 ? '0' : '') + mm + ' min';
}

function dateText(ms) {
  if (!ms) return 'never';
  const d = new Date(ms);
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

function timeText(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
}

function dayLabel(ms) {
  const now = new Date();
  const d = new Date(ms);
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((a - b) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
}

function Card({ t, children, style }) {
  return <View style={[{ backgroundColor: t.card, borderRadius: 16, padding: 14, marginTop: 14 }, style]}>{children}</View>;
}

function Head({ t, title, sub }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }}>{title}</Text>
      {sub ? <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  );
}

function Big({ t, icon, value, label }) {
  return (
    <View style={{ width: '48.5%', backgroundColor: t.card, borderRadius: 16, padding: 14, marginBottom: 10 }}>
      <Ionicons name={icon} size={18} color={t.accent} />
      <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', marginTop: 8 }}>{value}</Text>
      <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

function Bars({ t, values, labels, height, highlightLast }) {
  const max = Math.max(1, ...values);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: height }}>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(3, Math.round((v / max) * (height - 16))) : 2;
        const last = highlightLast && i === values.length - 1;
        return (
          <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: height }}>
            <View style={{ width: '62%', height: h, borderRadius: 4, backgroundColor: v > 0 ? t.accent : t.track, opacity: v > 0 ? (last ? 1 : 0.75) : 0.6 }} />
          </View>
        );
      })}
    </View>
  );
}

function Pill({ t, label, on, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 18, marginRight: 8, backgroundColor: on ? t.accent : t.track }}
    >
      <Text style={{ color: on ? t.onAccent : t.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function StatsScreen() {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState('7');
  const [, setTick] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [perm, setPerm] = useState('ask');
  const [rset, setRset] = useState(Reminders.getSettings());
  const [bk, setBk] = useState({ available: true, path: '' });
  const t = useAppTheme(open);

  // counting and reminders start with the app
  useEffect(() => {
    Stats.start().catch(() => {});
    Reminders.start().catch(() => {});
    const sub = DeviceEventEmitter.addListener('openStats', () => setOpen(true));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const refresh = () => {
      if (!alive) return;
      setTick((n) => n + 1);
      setRset(Reminders.getSettings());
    };
    refresh();
    Reminders.permission().then((p) => alive && setPerm(p));
    Stats.backupInfo().then((i) => alive && setBk(i || { available: false, path: '' }));
    const id = setInterval(refresh, 3000);
    const un = Reminders.subscribe(refresh);
    return () => {
      alive = false;
      clearInterval(id);
      un();
    };
  }, [open]);

  const close = () => setOpen(false);

  const changeReminders = async (patch) => {
    await Reminders.setSettings(patch);
    setRset(Reminders.getSettings());
    setPerm(await Reminders.permission());
  };

  const test = async () => {
    const r = await Reminders.sendTest();
    setPerm(await Reminders.permission());
    if (r === 'ok') Alert.alert('Sent', 'A test reminder arrives in a few seconds. Leave the app to see it as a normal notification.');
    else if (r === 'blocked') Alert.alert('Notifications are off', 'Allow notifications for Music Plus in your phone settings to get reminders.');
    else if (r === 'missing') Alert.alert('Not in this build', 'This build of the app does not include reminders yet.');
    else Alert.alert('Could not send it', 'Please try again in a moment.');
  };

  const sum = Stats.summary(range);
  const daily = Stats.dailySeconds(14);
  const hours = Stats.hourSeconds();
  const streak = Stats.streak();
  const best = Stats.bestDay();
  const since = Stats.firstDay();
  const hasData = Stats.hasData();
  const next = Reminders.nextReminder();
  const songs = sum.songs.slice(0, showAll ? 25 : 8);
  const artists = sum.artists.slice(0, 5);
  const maxArtist = Math.max(1, ...artists.map((a) => a.plays));
  const today = daily.length > 0 ? daily[daily.length - 1] : { sec: 0, plays: 0 };

  let bestHour = -1;
  let bestVal = 0;
  hours.forEach((v, i) => {
    if (v > bestVal) {
      bestVal = v;
      bestHour = i;
    }
  });
  const hourName = (h) => (h === 0 ? '12 am' : h < 12 ? h + ' am' : h === 12 ? '12 pm' : h - 12 + ' pm');

  return (
    <Modal visible={open} animationType="slide" onRequestClose={close} statusBarTranslucent>
      <Screen t={t} title="Statistics" onClose={close}>
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 48 }}>
          {/* period */}
          <View style={{ flexDirection: 'row', backgroundColor: t.card, borderRadius: 14, padding: 4 }}>
            {RANGES.map((r) => (
              <TouchableOpacity
                key={r.key}
                onPress={() => {
                  setRange(r.key);
                  setExpanded(null);
                }}
                activeOpacity={0.8}
                style={{ flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 11, backgroundColor: range === r.key ? t.accent : 'transparent' }}
              >
                <Text style={{ color: range === r.key ? t.onAccent : t.muted, fontWeight: '700', fontSize: 13 }}>{r.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {!hasData ? (
            <Card t={t}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }}>Nothing here yet</Text>
              <Text style={{ color: t.muted, fontSize: 13, marginTop: 6, lineHeight: 19 }}>
                Play some songs and your numbers appear here: time listened, plays per song, your top artists and when you listen. They are kept on your phone, so they stay even if you uninstall and install the app again.
              </Text>
            </Card>
          ) : null}

          {/* numbers */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 14 }}>
            <Big t={t} icon="time" value={fmt(sum.sec)} label="Listening time" />
            <Big t={t} icon="play-circle" value={String(sum.plays)} label="Plays" />
            <Big t={t} icon="musical-notes" value={String(sum.songsHeard)} label="Different songs" />
            <Big t={t} icon="flame" value={streak + (streak === 1 ? ' day' : ' days')} label="Listening streak" />
          </View>

          {/* last 14 days */}
          <Card t={t} style={{ marginTop: 4 }}>
            <Head t={t} title="Last 14 days" sub={'Today: ' + fmt(today.sec) + ', ' + today.plays + (today.plays === 1 ? ' play' : ' plays')} />
            <Bars t={t} values={daily.map((d) => d.sec)} height={96} highlightLast />
            <View style={{ flexDirection: 'row', marginTop: 6 }}>
              {daily.map((d, i) => (
                <Text key={i} style={{ flex: 1, textAlign: 'center', color: t.muted, fontSize: 9 }}>
                  {i % 2 === (daily.length - 1) % 2 ? WEEKDAYS[new Date(d.ms).getDay()].slice(0, 1) : ''}
                </Text>
              ))}
            </View>
          </Card>

          {/* top songs */}
          <Card t={t}>
            <Head t={t} title="Top songs" sub="Tap a song to see how many times you played it each day" />
            {songs.length === 0 ? <Text style={{ color: t.muted, fontSize: 13 }}>No songs in this period yet.</Text> : null}
            {songs.map((s, i) => {
              const isOpen = expanded === s.key;
              const days = isOpen ? Stats.songDays(s.key, 14) : [];
              return (
                <View key={s.key} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: t.track }}>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => setExpanded(isOpen ? null : s.key)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11 }}>
                    <Text style={{ width: 26, color: t.muted, fontSize: 14, fontWeight: '800' }}>{i + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{s.title}</Text>
                      <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12, marginTop: 1 }}>
                        {(s.artist ? s.artist + ' · ' : '') + fmt(s.sec)}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', marginLeft: 10 }}>
                      <Text style={{ color: t.text, fontSize: 15, fontWeight: '800' }}>{s.plays}</Text>
                      <Text style={{ color: t.muted, fontSize: 11 }}>{s.plays === 1 ? 'play' : 'plays'}</Text>
                    </View>
                  </TouchableOpacity>
                  {isOpen ? (
                    <View style={{ paddingBottom: 12, paddingLeft: 26 }}>
                      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>
                        {'First played ' + dateText(s.first) + '. Last played ' + dateText(s.last) + '.' + (s.skips ? ' Skipped ' + s.skips + (s.skips === 1 ? ' time.' : ' times.') : '')}
                      </Text>
                      {days.length === 0 ? (
                        <Text style={{ color: t.muted, fontSize: 12, marginTop: 6 }}>No plays in the last 14 days.</Text>
                      ) : (
                        days.map((d) => (
                          <View key={d.key} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                            <Text style={{ color: t.text, fontSize: 13 }}>{dayLabel(d.ms)}</Text>
                            <Text style={{ color: t.muted, fontSize: 13 }}>{d.plays + (d.plays === 1 ? ' play' : ' plays') + ' · ' + fmt(d.sec)}</Text>
                          </View>
                        ))
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })}
            {sum.songs.length > 8 ? (
              <TouchableOpacity onPress={() => setShowAll(!showAll)} style={{ paddingTop: 10, alignItems: 'center' }}>
                <Text style={{ color: t.accent, fontWeight: '700', fontSize: 13 }}>{showAll ? 'Show less' : 'Show more'}</Text>
              </TouchableOpacity>
            ) : null}
          </Card>

          {/* top artists */}
          <Card t={t}>
            <Head t={t} title="Top artists" />
            {artists.length === 0 ? <Text style={{ color: t.muted, fontSize: 13 }}>No artists in this period yet.</Text> : null}
            {artists.map((a, i) => (
              <View key={a.name} style={{ marginTop: i === 0 ? 0 : 12 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 14, fontWeight: '700' }}>{a.name}</Text>
                  <Text style={{ color: t.muted, fontSize: 12, marginLeft: 8 }}>{a.plays + (a.plays === 1 ? ' play' : ' plays') + ' · ' + fmt(a.sec)}</Text>
                </View>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: t.track, marginTop: 6 }}>
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: t.accent, width: Math.max(4, Math.round((a.plays / maxArtist) * 100)) + '%' }} />
                </View>
              </View>
            ))}
          </Card>

          {/* when you listen */}
          <Card t={t}>
            <Head t={t} title="When you listen" sub={bestHour >= 0 ? 'Your favourite hour: ' + hourName(bestHour) + ' (all time)' : 'All time, hour by hour'} />
            <Bars t={t} values={hours} height={80} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
              <Text style={{ color: t.muted, fontSize: 10 }}>12 am</Text>
              <Text style={{ color: t.muted, fontSize: 10 }}>6 am</Text>
              <Text style={{ color: t.muted, fontSize: 10 }}>12 pm</Text>
              <Text style={{ color: t.muted, fontSize: 10 }}>6 pm</Text>
              <Text style={{ color: t.muted, fontSize: 10 }}>11 pm</Text>
            </View>
          </Card>

          {/* records */}
          {best || since ? (
            <Card t={t}>
              <Head t={t} title="Records" />
              {best ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: t.muted, fontSize: 13 }}>Best day</Text>
                  <Text style={{ color: t.text, fontSize: 13, fontWeight: '700' }}>{dateText(new Date(best.key + 'T12:00:00').getTime()) + ' · ' + fmt(best.sec)}</Text>
                </View>
              ) : null}
              {since ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                  <Text style={{ color: t.muted, fontSize: 13 }}>Counting since</Text>
                  <Text style={{ color: t.text, fontSize: 13, fontWeight: '700' }}>{dateText(new Date(since + 'T12:00:00').getTime())}</Text>
                </View>
              ) : null}
            </Card>
          ) : null}

          {/* reminders */}
          <Card t={t}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '800' }}>Reminders</Text>
                <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>Friendly notifications to bring you back to your music</Text>
              </View>
              <Switch
                value={rset.on}
                onValueChange={(v) => changeReminders({ on: v })}
                trackColor={{ false: t.track, true: t.accent }}
                thumbColor={rset.on ? t.onAccent : '#CCCCCC'}
              />
            </View>
            {rset.on ? (
              <View style={{ marginTop: 12 }}>
                <Text style={{ color: t.muted, fontSize: 12, marginBottom: 8 }}>How many a day</Text>
                <View style={{ flexDirection: 'row' }}>
                  <Pill t={t} label="1" on={rset.perDay === 1} onPress={() => changeReminders({ perDay: 1 })} />
                  <Pill t={t} label="2" on={rset.perDay === 2} onPress={() => changeReminders({ perDay: 2 })} />
                  <Pill t={t} label="3" on={rset.perDay === 3} onPress={() => changeReminders({ perDay: 3 })} />
                </View>
                {perm === 'blocked' ? (
                  <TouchableOpacity onPress={() => Reminders.openPhoneSettings()} style={{ marginTop: 12 }}>
                    <Text style={{ color: t.accent, fontSize: 13, fontWeight: '700' }}>Notifications are blocked for Music Plus. Tap to open phone settings.</Text>
                  </TouchableOpacity>
                ) : null}
                {perm === 'missing' ? <Text style={{ color: t.muted, fontSize: 12, marginTop: 12 }}>This build of the app does not include reminders yet.</Text> : null}
                {perm === 'granted' && next ? (
                  <Text style={{ color: t.muted, fontSize: 12, marginTop: 12 }}>{'Next reminder: ' + dayLabel(next) + ' at ' + timeText(next)}</Text>
                ) : null}
                <TouchableOpacity onPress={test} activeOpacity={0.8} style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="notifications" size={16} color={t.accent} />
                  <Text style={{ color: t.accent, fontSize: 13, fontWeight: '700', marginLeft: 6 }}>Send me one now</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </Card>

          <Text style={{ color: t.muted, fontSize: 11, textAlign: 'center', marginTop: 18, lineHeight: 16 }}>
            {bk && bk.available
              ? 'Saved on your phone in Android/media/com.mymusic.plus/MusicPlus. It stays when you uninstall the app and comes back after you install it again.'
              : 'The backup folder is not available on this phone, so these numbers are only kept inside the app.'}
          </Text>
        </ScrollView>
      </Screen>
    </Modal>
  );
}
