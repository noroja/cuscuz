import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDriveChangeToken } from './extra-drive.js';
import { authHeaders, driveFetch } from './drive-auth.js';
import { IS_SERVERLESS, TMP_DIR, writableDir } from './fs-safe.js';

const API = 'https://www.googleapis.com/drive/v3';
const STATE_FILE = path.join(writableDir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')) || TMP_DIR, 'drive-push-channels.json');
const CHANNEL_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;
const channels = new Map(readChannels().map(item => Array.isArray(item) ? item : [item.id, Number(item.expiration || 0)]));
let onChange = null;
let changeTimer = null;
let busy = false;
let rerunRequested = false;

function readChannels() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).channels || []; }
  catch (_) { return []; }
}

function saveChannels() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ channels: [...channels].map(([id, expiration]) => ({ id, expiration })) }));
  } catch (error) { console.warn('[Drive Push] Não foi possível persistir canais:', error.message); }
}

export function drivePushConfigured() {
  return /^https:\/\//i.test(process.env.DRIVE_PUSH_WEBHOOK_URL || '') && !!process.env.DRIVE_PUSH_WEBHOOK_TOKEN;
}

export async function renewDrivePushChannel() {
  if (!drivePushConfigured()) return { configured: false, active: false };
  const pageToken = getDriveChangeToken();
  if (!pageToken) return { configured: true, active: false, error: 'O catálogo ainda não possui um token de mudanças do Drive.' };
  const id = crypto.randomUUID();
  const expiration = Date.now() + CHANNEL_LIFETIME_MS;
  const response = await driveFetch(`${API}/changes/watch?pageToken=${encodeURIComponent(pageToken)}&includeRemoved=true&restrictToMyDrive=false&spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, type: 'web_hook', address: process.env.DRIVE_PUSH_WEBHOOK_URL, token: process.env.DRIVE_PUSH_WEBHOOK_TOKEN, expiration: String(expiration) }),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`changes.watch respondeu ${response.status}: ${result.error?.message || 'erro desconhecido'}`);
  for (const [oldId, expiry] of channels) if (expiry <= Date.now()) channels.delete(oldId);
  channels.set(id, Number(result.expiration || expiration));
  saveChannels();
  return { configured: true, active: true, channelId: id, expiration: Number(result.expiration || expiration) };
}

export function acceptDriveNotification(headers) {
  const id = headers['x-goog-channel-id'];
  const token = headers['x-goog-channel-token'];
  const expected = String(process.env.DRIVE_PUSH_WEBHOOK_TOKEN || '');
  const actualBytes = Buffer.from(String(token || ''));
  const expectedBytes = Buffer.from(expected);
  if (!id || (!IS_SERVERLESS && !(channels.get(id) > Date.now())) || !expected || !token || actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return false;
  return true;
}

export function queueDriveChange(onChanges) {
  onChange = onChanges;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    if (!onChange) return;
    if (busy) { rerunRequested = true; return; }
    busy = true;
    try { await onChange(); }
    catch (error) { console.error('[Drive Push] Falha processando mudanças:', error.message); }
    finally {
      busy = false;
      if (rerunRequested) { rerunRequested = false; queueDriveChange(onChange); }
    }
  }, 350);
}

export function startDrivePushRenewal(onChanges) {
  onChange = onChanges;
  if (!drivePushConfigured()) return false;
  const renew = () => renewDrivePushChannel().then(result => {
    if (result.error) console.warn('[Drive Push]', result.error);
    else console.log('[Drive Push] Canal ativo até', new Date(result.expiration).toISOString());
  }).catch(error => console.error('[Drive Push] Não foi possível (re)criar canal:', error.message));
  setTimeout(renew, 15000).unref?.();
  const timer = setInterval(renew, 24 * 60 * 60 * 1000);
  timer.unref?.();
  return true;
}
