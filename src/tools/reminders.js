/*
 * Reminders: friendly notifications from the lines in messages.js. Everything happens on the phone, no internet.
 *
 * How it works: Android cannot run the app in the background just to send a message, so the app plans the next
 * two weeks ahead and hands the plan to the phone's own alarm system (expo-notifications). Every time you close or
 * leave the app, the plan is made again, starting at least 3 hours later, so a reminder never arrives right after
 * you used the app. If you do not open the app for two weeks, the reminders stop by themselves.
 *
 * Rules the planner follows:
 *   - 1, 2 or 3 reminders a day (your choice in the Statistics screen), only between about 09:00 and 21:30
 *   - a line is not shown again until every other line has been shown (about 1,600 lines), tracked by line id
 *   - lines about "being away" are used for days further ahead, weekend lines for Saturday and Sunday
 *   - some lines are personal ("time to listen to {your top song}"), filled in from your statistics
 *   - while the app is open, reminders stay silent
 */
import { AppState, Platform, Linking } from 'react-native';
import * as Stats from './stats';
import { allMessages, personalMessages, fill, TITLES } from './messages';

let AS = null;
try {
  const mod = require('@react-native-async-storage/async-storage');
  AS = mod.default || mod;
} catch (e) {
  AS = null;
}
let N = null;
try {
  N = require('expo-notifications');
} catch (e) {
  N = null;
}

const SET_KEY = 'mm_reminders_v1';
const STATE_KEY = 'mm_reminders_state_v1';
const CHANNEL = 'reminders';
const DAYS_AHEAD = 14;
const MIN_GAP = 3 * 3600000;
const SLOTS = {
  1: [[19, 0]],
  2: [[12, 30], [19, 30]],
  3: [[9, 15], [14, 30], [20, 15]],
};

let settings = { on: true, perDay: 2 };
let state = { used: [], sched: [], asked: false };
let started = false;
let ready = false;
let planning = false;
let again = false;
let planTimer = null;
const subs = new Set();

async function readJson(key, fallback) {
  try {
    const raw = AS ? await AS.getItem(key) : null;
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return fallback;
}

async function writeJson(key, value) {
  try {
    if (AS) await AS.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

function emit() {
  subs.forEach((f) => {
    try {
      f();
    } catch (e) {}
  });
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function available() {
  return !!N;
}

export function getSettings() {
  return { on: settings.on, perDay: settings.perDay };
}

export function nextReminder() {
  const now = Date.now();
  for (const s of state.sched) if (s.t > now) return s.t;
  return 0;
}

export async function permission() {
  if (!N) return 'missing';
  try {
    const p = await N.getPermissionsAsync();
    if (p.granted) return 'granted';
    return p.canAskAgain === false ? 'blocked' : 'ask';
  } catch (e) {
    return 'ask';
  }
}

export async function ensurePermission(ask) {
  if (!N) return false;
  try {
    let p = await N.getPermissionsAsync();
    if (p.granted) return true;
    if (ask && p.canAskAgain !== false) {
      p = await N.requestPermissionsAsync();
      return !!p.granted;
    }
  } catch (e) {}
  return false;
}

export function openPhoneSettings() {
  try {
    Linking.openSettings();
  } catch (e) {}
}

export async function setSettings(patch) {
  if (patch && typeof patch.on === 'boolean') settings.on = patch.on;
  if (patch && (patch.perDay === 1 || patch.perDay === 2 || patch.perDay === 3)) settings.perDay = patch.perDay;
  await writeJson(SET_KEY, settings);
  if (settings.on) await ensurePermission(true);
  await plan();
  emit();
}

function rnd(n) {
  return Math.floor(Math.random() * n);
}

function timeCat(h) {
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

// the planned times for the next days
function makeSlots(now) {
  const out = [];
  const list = SLOTS[settings.perDay] || SLOTS[2];
  for (let d = 0; d < DAYS_AHEAD; d++) {
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + d);
    const weekend = base.getDay() === 0 || base.getDay() === 6;
    for (const slot of list) {
      let minutes = slot[0] * 60 + slot[1] + (rnd(81) - 40) + (weekend ? 45 : 0);
      minutes = Math.max(9 * 60, Math.min(21 * 60 + 30, minutes));
      const t = new Date(base);
      t.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      if (t.getTime() < now + MIN_GAP) continue;
      out.push({ t: t.getTime(), d: d, weekend: weekend, hour: Math.floor(minutes / 60) });
    }
  }
  return out;
}

function pickGeneral(pool, used, picked, slot) {
  const tc = timeCat(slot.hour);
  let primary = tc;
  if (slot.d >= 2 && Math.random() < 0.5) primary = 'away';
  else if (slot.weekend && Math.random() < 0.4) primary = 'weekend';
  const r = Math.random();
  const first = r < 0.3 ? 'mix' : r < 0.65 ? primary : 'any';
  const order = [first, primary, 'any', tc, 'mix'];
  for (const cat of order) {
    const c = pool.filter((m) => m.cat === cat && !used.has(m.id) && !picked.has(m.id));
    if (c.length > 0) return c[rnd(c.length)];
  }
  return null;
}

function pickPersonal(pers, facts, used, picked) {
  const c = [];
  for (const m of pers) {
    if (used.has(m.id) || picked.has(m.id)) continue;
    const text = fill(m.text, facts);
    if (text) c.push({ id: m.id, text: text });
  }
  return c.length > 0 ? c[rnd(c.length)] : null;
}

async function scheduleOne(title, body, whenMs, data) {
  const content = { title: title, body: body, data: data || { kind: 'reminder' } };
  const type = N.SchedulableTriggerInputTypes ? N.SchedulableTriggerInputTypes.DATE : 'date';
  try {
    return await N.scheduleNotificationAsync({ content: content, trigger: { type: type, date: new Date(whenMs), channelId: CHANNEL } });
  } catch (e) {
    return await N.scheduleNotificationAsync({ content: content, trigger: new Date(whenMs) });
  }
}

// Makes the plan for the next two weeks and gives it to the phone. Safe to call often.
export async function plan() {
  if (!N || !ready) return 0;
  if (planning) {
    again = true;
    return 0;
  }
  planning = true;
  let count = 0;
  try {
    const now = Date.now();
    const used = new Set(state.used || []);
    // reminders whose time has passed were shown: remember them, so they are not used again soon
    for (const s of state.sched || []) if (s.t <= now && s.h) used.add(s.h);
    state.sched = [];
    try {
      await N.cancelAllScheduledNotificationsAsync();
    } catch (e) {}
    if (settings.on && (await ensurePermission(false))) {
      const pool = allMessages();
      const pers = personalMessages();
      const facts = Stats.isReady() && Stats.hasData() ? Stats.personalFacts() : {};
      const picked = new Set();
      let slots = makeSlots(now);
      // when every general line was shown, start the round again
      const unusedGeneral = pool.filter((m) => !used.has(m.id)).length;
      if (unusedGeneral < slots.length) {
        for (const m of pool) used.delete(m.id);
      }
      if (pers.filter((m) => !used.has(m.id)).length < 3) {
        for (const m of pers) used.delete(m.id);
      }
      for (const slot of slots) {
        let msg = null;
        if (Math.random() < 0.28) msg = pickPersonal(pers, facts, used, picked);
        if (!msg) msg = pickGeneral(pool, used, picked, slot);
        if (!msg) continue;
        picked.add(msg.id);
        try {
          await scheduleOne(TITLES[rnd(TITLES.length)], msg.text, slot.t);
          state.sched.push({ t: slot.t, h: msg.id });
          count += 1;
        } catch (e) {}
      }
    }
    state.used = Array.from(used);
    await writeJson(STATE_KEY, state);
  } catch (e) {}
  planning = false;
  emit();
  if (again) {
    again = false;
    setTimeout(plan, 1500);
  }
  return count;
}

// A reminder in a few seconds, shown even while the app is open (to try it out)
export async function sendTest() {
  if (!N) return 'missing';
  if (!(await ensurePermission(true))) return 'blocked';
  try {
    const pool = allMessages();
    const m = pool[rnd(pool.length)];
    await scheduleOne(TITLES[rnd(TITLES.length)], m.text, Date.now() + 4000, { kind: 'test', test: true });
    return 'ok';
  } catch (e) {
    return 'error';
  }
}

function planSoon() {
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    plan();
  }, 1200);
}

export async function start() {
  if (started) return;
  started = true;
  if (!N) return;
  settings = Object.assign(settings, await readJson(SET_KEY, {}));
  const st = await readJson(STATE_KEY, null);
  if (st && typeof st === 'object') state = Object.assign(state, st);
  try {
    N.setNotificationHandler({
      handleNotification: async (n) => {
        const test = !!(n && n.request && n.request.content && n.request.content.data && n.request.content.data.test);
        return { shouldShowAlert: test, shouldShowBanner: test, shouldShowList: test, shouldPlaySound: false, shouldSetBadge: false };
      },
    });
    if (Platform.OS === 'android' && N.setNotificationChannelAsync) {
      await N.setNotificationChannelAsync(CHANNEL, {
        name: 'Music Plus reminders',
        importance: N.AndroidImportance ? N.AndroidImportance.DEFAULT : 3,
        enableVibrate: false,
        showBadge: false,
      });
    }
  } catch (e) {}
  ready = true;
  // first time: ask for permission once, a little while after the app opened (after the music permission)
  setTimeout(async () => {
    if (settings.on && !state.asked) {
      state.asked = true;
      await writeJson(STATE_KEY, state);
      await ensurePermission(true);
    }
    await plan();
  }, 20000);
  try {
    AppState.addEventListener('change', (s) => {
      if (s !== 'active') planSoon();
    });
  } catch (e) {}
}

export const __test = {
  setReady(v) {
    ready = v;
  },
  makeSlots: makeSlots,
  state: () => state,
};
