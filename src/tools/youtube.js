// Reads a YouTube link: thumbnail, title and captions (lyrics). Ported from your thumbnail app.
import { Image } from 'react-native';

const API_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const CLIENTS = [
  {
    name: 'ANDROID',
    version: '20.10.38',
    id: '3',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    extra: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
  },
  {
    name: 'IOS',
    version: '20.10.4',
    id: '5',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extra: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
  },
];

// Finds the video id inside any text (a link, or text that contains a link)
export function findVideoId(text, allowBare) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (allowBare && /^[\w-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/i
  );
  return m ? m[1] : null;
}

const size = (url) =>
  new Promise((resolve) => {
    Image.getSize(
      url,
      (w, h) => resolve({ w, h }),
      () => resolve(null)
    );
  });

// Best thumbnail YouTube really has
export async function getThumbnail(id) {
  for (const key of ['maxresdefault', 'sddefault', 'hqdefault']) {
    const url = 'https://i.ytimg.com/vi/' + id + '/' + key + '.jpg';
    const sz = await size(url);
    if (sz && sz.w > 120) return { url, w: sz.w, h: sz.h };
  }
  return null;
}

async function http(url, opt) {
  const o = opt || {};
  const ua = o.client ? o.client.ua : CLIENTS[0].ua;
  const headers = { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' };
  const init = { headers };
  if (o.body) {
    init.method = 'POST';
    headers['Content-Type'] = 'application/json';
    headers['X-YouTube-Client-Name'] = o.client.id;
    headers['X-YouTube-Client-Version'] = o.client.version;
    headers.Origin = 'https://www.youtube.com';
    init.body = JSON.stringify(o.body);
  }
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('YouTube took too long to answer')), 25000));
  const r = await Promise.race([fetch(url, init), timeout]);
  if (!r.ok) throw new Error('YouTube answered with error ' + r.status);
  return r.text();
}

// Title, channel and the list of caption tracks
export async function getTracks(videoId) {
  let lastError = 'This video has no captions or lyrics (not even auto-generated).';
  let title = '';
  let author = '';
  for (const cl of CLIENTS) {
    try {
      const body = {
        context: { client: { clientName: cl.name, clientVersion: cl.version, hl: 'en', gl: 'US', ...cl.extra } },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      };
      const txt = await http('https://www.youtube.com/youtubei/v1/player?key=' + API_KEY + '&prettyPrint=false', {
        body,
        client: cl,
      });
      const pr = JSON.parse(txt);
      if (pr.videoDetails) {
        title = pr.videoDetails.title || title;
        author = pr.videoDetails.author || author;
      }
      const ps = pr.playabilityStatus;
      if (ps && ps.status && ps.status !== 'OK') {
        lastError = ps.reason || 'YouTube would not let the app see this video.';
        continue;
      }
      const arr =
        pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (!arr || !arr.length) {
        lastError = 'This video has no captions or lyrics (not even auto-generated).';
        continue;
      }
      const tracks = arr.map((t) => {
        let name = '';
        if (t.name) name = t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text) || '';
        return { url: t.baseUrl || '', lang: t.languageCode || '', auto: t.kind === 'asr', name };
      });
      return { ok: true, title, author, tracks };
    } catch (e) {
      lastError = 'Could not reach YouTube: ' + (e && e.message ? e.message : e);
    }
  }
  return { ok: false, title, author, error: lastError };
}

const decode = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const tidy = (s) => s.replace(/\s+/g, ' ').trim();

function parseJson3(txt) {
  const j = JSON.parse(txt);
  const out = [];
  for (const ev of j.events || []) {
    if (!ev.segs) continue;
    const t = tidy(ev.segs.map((s) => s.utf8 || '').join(''));
    if (!t) continue;
    out.push({ s: (ev.tStartMs || 0) / 1000, d: (ev.dDurationMs || 0) / 1000, t });
  }
  return out;
}

function parseXml(txt) {
  const out = [];
  let m;
  const re1 = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = re1.exec(txt))) {
    const t = tidy(decode(m[3].replace(/<[^>]*>/g, '')));
    if (t) out.push({ s: parseFloat(m[1]), d: parseFloat(m[2] || '0'), t });
  }
  if (out.length) return out;
  const re2 = /<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = re2.exec(txt))) {
    const t = tidy(decode(m[3].replace(/<[^>]*>/g, '')));
    if (t) out.push({ s: parseInt(m[1], 10) / 1000, d: parseInt(m[2] || '0', 10) / 1000, t });
  }
  return out;
}

// Downloads one caption track and turns it into lines { s, d, t }
export async function getCaptionText(url) {
  if (url.indexOf('https://www.youtube.com/api/timedtext') !== 0) {
    return { ok: false, error: 'unexpected caption address' };
  }
  const clean = url.replace(/&fmt=[^&]*/, '');
  let body = '';
  try {
    body = await http(clean + '&fmt=json3');
  } catch (e) {}
  if (!body || !body.trim()) {
    try {
      body = await http(clean);
    } catch (e) {
      return { ok: false, error: 'Could not get the caption file: ' + (e && e.message ? e.message : e) };
    }
  }
  let lines = [];
  try {
    lines = body.trim().charAt(0) === '{' ? parseJson3(body) : parseXml(body);
  } catch (e) {}
  if (!lines.length) return { ok: false, error: 'YouTube sent back an empty file for this one. Try another language.' };
  return { ok: true, lines };
}

const pad = (n, l) => String(n).padStart(l || 2, '0');
function lrcTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const m = Math.floor(cs / 6000);
  const r = cs % 6000;
  return '[' + pad(m) + ':' + pad(Math.floor(r / 100)) + '.' + pad(r % 100) + ']';
}
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(ms % 1000, 3);
}

export function toLrc(lines, title) {
  const head = title ? '[ti:' + title + ']\n' : '';
  return head + lines.map((l) => lrcTime(l.s) + ' ' + l.t).join('\n');
}

export function toSrt(lines) {
  return lines
    .map((l, i) => {
      const next = lines[i + 1];
      let end = l.d > 0 ? l.s + l.d : next ? next.s : l.s + 3;
      if (next && end > next.s) end = next.s;
      if (end <= l.s) end = l.s + 0.5;
      return i + 1 + '\n' + srtTime(l.s) + ' --> ' + srtTime(end) + '\n' + l.t + '\n';
    })
    .join('\n');
}

export function safeName(title, id) {
  const s = String(title || id).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || id;
}
