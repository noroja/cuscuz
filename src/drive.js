/* ==========================================================================
   DRIVE.JS — Módulo centralizado de acesso ao Google Drive
   Todas as credenciais vêm de variáveis de ambiente (Railway).
   Nunca expõe chaves ao front-end.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { driveFetchWithRetry } from './drive-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Variáveis de ambiente (obrigatórias ou opcionais) ──────────────────────
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
const GOOGLE_DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY || '';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

// ── Validação na inicialização ─────────────────────────────────────────────
const missing = [];
if (!GOOGLE_DRIVE_FOLDER_ID) missing.push('GOOGLE_DRIVE_FOLDER_ID');
if (!GOOGLE_DRIVE_API_KEY && !GOOGLE_SERVICE_ACCOUNT_JSON) missing.push('GOOGLE_DRIVE_API_KEY ou GOOGLE_SERVICE_ACCOUNT_JSON');

const driveReady = missing.length === 0;

if (!driveReady) {
  console.error(`❌ Drive não configurado. Variáveis faltando: ${missing.join(', ')}`);
} else {
  console.log(`✅ Drive configurado. Pasta principal: ${GOOGLE_DRIVE_FOLDER_ID}`);
}

// ── Conta de serviço ───────────────────────────────────────────────────────
let SA = null;
try {
  const raw = String(GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    const txt = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(txt);
    if (j.client_email && j.private_key) {
      SA = { email: j.client_email, key: String(j.private_key).replace(/\\n/g, '\n') };
    }
  }
} catch (e) {
  console.warn('⚠️ GOOGLE_SERVICE_ACCOUNT_JSON inválido:', e.message);
}

export const temConta = () => !!SA;
export const emailConta = () => SA ? SA.email : '';

let tok = '', exp = 0, pend = null, erro = '';
export const erroConta = () => erro;

const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

export async function driveToken() {
  if (!SA) return '';
  if (tok && Date.now() < exp - 60000) return tok;
  if (pend) return pend;
  pend = (async () => {
    try {
      const agora = Math.floor(Date.now() / 1000);
      const corpo = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: SA.email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 });
      const sig = crypto.createSign('RSA-SHA256').update(corpo).sign(SA.key).toString('base64url');
      const r = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + corpo + '.' + sig,
        signal: AbortSignal.timeout(15000)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error('login da conta de serviço recusado: ' + (j.error_description || j.error || r.status));
      tok = j.access_token; exp = Date.now() + (j.expires_in || 3600) * 1000; erro = '';
      return tok;
    } catch (e) { erro = String(e.message || e); throw e; }
    finally { pend = null; }
  })();
  return pend;
}

export async function authHeaders() { return SA ? { Authorization: 'Bearer ' + await driveToken() } : {}; }

/* fetch para a API do Drive: conta de serviço (Bearer) ou, sem ela, chave de API */
export async function driveFetch(url, opts = {}) {
  if (SA) return fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(await authHeaders()) } });
  const k = GOOGLE_DRIVE_API_KEY.trim();
  return fetch(k && !/[?&]key=/.test(url) ? url + (url.includes('?') ? '&' : '?') + 'key=' + k : url, opts);
}

/* Helper para sanitizar IDs do Google Drive */
export function cleanDriveId(raw) {
  if (!raw) return '';
  let id = String(raw).trim();
  if (id.includes('folders/')) id = id.split('folders/')[1];
  if (id.includes('file/d/')) id = id.split('file/d/')[1];
  if (id.includes('/')) id = id.split('/')[0];
  if (id.includes('?')) id = id.split('?')[0];
  return id.trim();
}

/* ── Listagem de pastas/arquivos ── */
export async function listFolder(folderId) {
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,shortcutDetails,webViewLink,parents,size,modifiedTime)');
    const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=folder,name_natural&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pageParam}`;
    const r = await driveFetchWithRetry(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) break;
    const data = await r.json();
    if (data.files) files.push(...data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

/* ── Metadata de arquivo/pasta ── */
export async function getFileMeta(fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,shortcutDetails,webViewLink,parents,size,modifiedTime&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const r = await driveFetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  return r.json();
}

/* ── Verifica se nome é pasta "Apostila" ── */
export function isApostilaFolder(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('apostila') || n === 'apostilas';
}

/* ── Status do Drive ── */
export async function getDriveStatus() {
  if (!driveReady) {
    return {
      connected: false,
      folder: null,
      itemCount: 0,
      missing: missing,
      message: 'Drive não configurado. Variáveis faltando: ' + missing.join(', ')
    };
  }
  try {
    const cleanRoot = cleanDriveId(GOOGLE_DRIVE_FOLDER_ID);
    if (!cleanRoot) {
      return { connected: false, folder: null, itemCount: 0, missing: [], message: 'GOOGLE_DRIVE_FOLDER_ID inválido' };
    }
    const files = await listFolder(cleanRoot);
    return {
      connected: true,
      folder: GOOGLE_DRIVE_FOLDER_ID,
      itemCount: files.length,
      missing: [],
      message: 'Conectado à pasta principal do Drive'
    };
  } catch (e) {
    return {
      connected: false,
      folder: GOOGLE_DRIVE_FOLDER_ID,
      itemCount: 0,
      missing: [],
      message: 'Erro ao conectar ao Drive: ' + e.message
    };
  }
}
