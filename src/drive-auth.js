/* Acesso ao Google Drive com CONTA DE SERVIÇO (pasta continua privada; só a conta de serviço tem permissão).
   Configure GOOGLE_SERVICE_ACCOUNT_JSON no Render (o JSON da chave, puro ou em base64). Sem isso, usa a chave de API (pasta pública). */
import crypto from 'crypto';

let SA = null;
try {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    const txt = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(txt);
    if (j.client_email && j.private_key) SA = { email: j.client_email, key: String(j.private_key).replace(/\\n/g, '\n') };
  }
} catch (e) { console.warn('⚠️ GOOGLE_SERVICE_ACCOUNT_JSON inválido:', e.message); }

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
      const corpo = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: SA.email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 });
      const sig = crypto.createSign('RSA-SHA256').update(corpo).sign(SA.key).toString('base64url');
      const r = await fetch((process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + corpo + '.' + sig, signal: AbortSignal.timeout(15000) });
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
  const k = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  return fetch(k && !/[?&]key=/.test(url) ? url + (url.includes('?') ? '&' : '?') + 'key=' + k : url, opts);
}

/* ── Exponential Backoff para chamadas da API do Drive ──
   Retenta em 2s, 4s, 8s (até 3 tentativas) quando houver 403 rateLimitExceeded / usageLimits ou 429.
   Outros erros 4xx (exceto 429) não são retry — falham rápido.                        */
const BACKOFF_MAX = 3;
const BACKOFF_BASE_MS = 2000;
function isRateLimitError(status, bodyText) {
  if (status === 429) return true;
  if (status !== 403) return false;
  const blob = String(bodyText || '').toLowerCase();
  return /ratelimit|usagelimits|quota|rate/i.test(blob);
}
export async function driveFetchWithRetry(url, opts = {}) {
  let lastErr = null;
  for (let i = 1; i <= BACKOFF_MAX; i++) {
    try {
      const r = await driveFetch(url, opts);
      if (r.ok) return r;
      const texto = await r.text().catch(() => '');
      if (!isRateLimitError(r.status, texto)) {
        const e = new Error(`Drive ${r.status}: ${texto.slice(0, 200)}`);
        e.status = r.status; e.fatal = true; throw e;
      }
      lastErr = new Error(`Drive 403 rateLimitExceeded (tentativa ${i}/${BACKOFF_MAX})`);
      lastErr.status = 403; lastErr.retryable = true;
      if (i < BACKOFF_MAX) await new Promise(s => setTimeout(s, BACKOFF_BASE_MS * i));
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      if (i < BACKOFF_MAX && e.retryable) await new Promise(s => setTimeout(s, BACKOFF_BASE_MS * i));
    }
  }
  throw lastErr || new Error('Drive request falhou após retry');
}

/* Helper para sanitizar IDs do Google Drive (remove parâmetros de URL como ?hl=pt-br, prefixos de path, etc.) */
export function cleanDriveId(raw) {
  if (!raw) return '';
  let id = String(raw).trim();
  if (id.includes('folders/')) id = id.split('folders/')[1];
  if (id.includes('file/d/')) id = id.split('file/d/')[1];
  if (id.includes('/')) id = id.split('/')[0];
  if (id.includes('?')) id = id.split('?')[0];
  return id.trim();
}
