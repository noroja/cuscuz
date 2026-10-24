// DRIVE_DIRECT: /m/:ticket (vídeo) redireciona 307 ao Drive com access_token; ?via=app e PDF continuam no proxy.
// Servidor de token falso (GOOGLE_TOKEN_URL) + chave RSA gerada na hora. Nada do Google real é chamado.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const mockFetch = fileURLToPath(new URL('./mock-drive-fetch.mjs', import.meta.url));
const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir, { recursive: true });
const files = ['users.json', 'sessions.json'].map(n => path.join(dataDir, n));
const originals = new Map(files.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
const users = originals.get(files[0]) ? JSON.parse(originals.get(files[0]).toString('utf8')) : [];
const nome = 'direct_' + Date.now().toString(36), pass = 'direct-test-password', salt = crypto.randomBytes(16);
users.push({ username: nome, displayName: 'Direct', passwordHash: crypto.scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'), salt: salt.toString('hex'), role: 'user', settings: {} });
fs.writeFileSync(files[0], JSON.stringify(users));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'teste@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const tokenSrv = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ access_token: 'tok-falso-123', expires_in: 3600 })); });
await new Promise(r => tokenSrv.listen(3974, '127.0.0.1', r));
const P = 3973, base = `http://127.0.0.1:${P}`;
const env = { ...process.env, APP_PASSWORD: 'segredo-de-teste', AI_LOG: '0', PORT: String(P), DRIVE_DIRECT: '1', GOOGLE_TOKEN_URL: 'http://127.0.0.1:3974/token', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_DRIVE_API_KEY', 'GOOGLE_DRIVE_FOLDER_ID', 'MEDIA_ORIGIN']) delete env[k];
const S = spawn(process.execPath, ['--import', pathToFileURL(mockFetch).href, 'server.js'], { cwd: root, env, stdio: 'ignore' });
const t = [];
const teste = async (n, fn) => { try { await fn(); t.push(['OK ', n]); } catch (e) { t.push(['FALHOU', n, e.message]); } };
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: nome, password: pass }) });
  assert.equal(login.status, 200);
  const auth = { cookie: (login.headers.get('set-cookie') || '').split(';')[0], 'content-type': 'application/json' };
  const ID = 'AbCdEfGhIjKlMnOp12345';
  const tk = async (kind) => (await (await fetch(base + '/api/media/ticket', { method: 'POST', headers: auth, body: JSON.stringify({ id: ID, kind }) })).json()).url;
  const g = (u, init) => fetch(base + u, { redirect: 'manual', ...init });
  await teste('vídeo: 307 para o Drive com access_token (sem proxiar bytes)', async () => {
    const r = await g(await tk('v'), { headers: { Range: 'bytes=0-' } });
    assert.equal(r.status, 307); const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, `https://www.googleapis.com/drive/v3/files/${ID}`);
    assert.equal(loc.searchParams.get('alt'), 'media'); assert.equal(loc.searchParams.get('access_token'), 'tok-falso-123');
  });
  await teste('?via=app força o proxy (206, 8 MiB)', async () => {
    const r = await g((await tk('v')) + '?via=app', { headers: { Range: 'bytes=0-' } });
    assert.equal(r.status, 206); assert.equal(Number(r.headers.get('content-length')), 8 * 1024 * 1024); await r.arrayBuffer();
  });
  await teste('PDF continua pelo proxy (nunca redireciona ao Google)', async () => {
    const r = await g(await tk('p'));
    assert.ok(!(r.headers.get('location') || '').includes('googleapis.com'), String(r.headers.get('location')));
  });
  await teste('ticket inválido → 404', async () => { assert.equal((await g('/m/invalido')).status, 404); });
} finally {
  S.kill(); tokenSrv.close();
  for (const [f, c] of originals) { if (c) fs.writeFileSync(f, c); else fs.rmSync(f, { force: true }); }
}
for (const l of t) console.log(l.join(' — '));
if (t.some(x => x[0] === 'FALHOU')) process.exit(1);
