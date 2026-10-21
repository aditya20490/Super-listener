// Saving files: into Downloads (pictures, lyrics) or into Music (edited songs). Needs the FileSaver native module.
import { NativeModules } from 'react-native';

let FS = null;
try {
  FS = require('expo-file-system/legacy');
} catch (e) {
  try {
    FS = require('expo-file-system');
  } catch (e2) {
    FS = null;
  }
}
if (FS && typeof FS.copyAsync !== 'function') FS = null;
export const FileSystem = FS;

const Native = NativeModules ? NativeModules.FileSaver : null;
const clean = (n) => String(n).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
const b64 = () => (FS.EncodingType && FS.EncodingType.Base64) || 'base64';

function need() {
  if (!FS) throw new Error('File access is not part of this build.');
}

export async function writeCacheBase64(name, data) {
  need();
  const p = FS.cacheDirectory + clean(name);
  await FS.writeAsStringAsync(p, data, { encoding: b64() });
  return p;
}

export async function writeCacheText(name, text) {
  need();
  const p = FS.cacheDirectory + clean(name);
  await FS.writeAsStringAsync(p, text);
  return p;
}

export async function downloadToCache(url, name) {
  need();
  const p = FS.cacheDirectory + clean(name);
  const r = await FS.downloadAsync(url, p);
  if (r && r.status && r.status >= 400) throw new Error('The download failed (' + r.status + ')');
  return p;
}

// A picture saved inside the app, named like the app's own custom covers
export async function downloadCover(url, songId) {
  need();
  const dir = (FS.documentDirectory || FS.cacheDirectory) + 'covers/';
  try {
    await FS.makeDirectoryAsync(dir, { intermediates: true });
  } catch (e) {}
  const safe = String(songId).replace(/[^A-Za-z0-9_-]/g, '_');
  const dest = dir + 'custom_' + safe + '_' + Date.now() + '.jpg';
  const r = await FS.downloadAsync(url, dest);
  if (r && r.status && r.status >= 400) throw new Error('The picture download failed (' + r.status + ')');
  return dest;
}

// toMusic = true: into Music/Edited songs (your library picks it up). false: Downloads/Music Plus.
export async function saveFile(path, name, mime, toMusic) {
  if (!Native || !Native.save) throw new Error('Saving needs the newest build of the app.');
  return Native.save(path, clean(name), mime || 'application/octet-stream', !!toMusic);
}
