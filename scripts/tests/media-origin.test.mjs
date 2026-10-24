// MEDIA_ORIGIN / MEDIA_ONLY: a mídia pesada é redirecionada (não proxiada) e o host de mídia só expõe /m/*.
// Sobe 2 processos reais do server.js (sem Google Drive: o que se verifica é roteamento, não o conteúdo).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const mockFetch = fileURLToPath(new URL('./mock-drive-fetch.mjs', import.meta.url));
const dataDir = path.join(root, 'data');
const files = ['users.json', 'sessions.json'].map(name => path.join(dataDir, name));
const originals = new Map(files.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
fs.mkdirSync(dataDir, { recursive: true });
const userFile = files[0];
const users = originals.get(userFile) ? JSON.parse(originals.get(userFile).toString('utf8')) : [];
const testUsername = 'media_test_' + Date.now().toString(36);
const pass = 'media-test-password';
const salt = crypto.randomBytes(16);
const passwordHash = crypto.scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
users.push({ username: testUsername, displayName: 'Media Test', passwordHash, salt: salt.toString('hex'), role: 'user', settings: {} });
fs.writeFileSync(userFile, JSON.stringify(users));
const PA = 3971, PB = 3972; const base = (p) => `http://127.0.0.1:${p}`;
const env = { ...process.env, APP_PASSWORD: 'segredo-de-teste', AI_LOG: '0' };
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_DRIVE_API_KEY', 'GOOGLE_DRIVE_FOLDER_ID']) delete env[k];
const sobe = (port, extra) => spawn(process.execPath, ['--import', pathToFileURL(mockFetch).href, 'server.js'], { cwd: root, env: { ...env, PORT: String(port), ...extra }, stdio: 'ignore' });
const A = sobe(PA, { MEDIA_ORIGIN: base(PB) }); const B = sobe(PB, { MEDIA_ONLY: '1' });
const espera = async (p) => { for (let i = 0; i < 60; i++) { try { if ((await fetch(base(p) + '/api/health')).ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 250)); } throw new Error('servidor não subiu: ' + p); };
const t = []; const teste = async (n, fn) => { try { await fn(); t.push(['OK ', n]); } catch (e) { t.push(['FALHOU', n, e.message]); } };
try {
  await Promise.all([espera(PA), espera(PB)]);
  const j = (url, init) => fetch(url, { redirect: 'manual', ...init });
  const u = 'm' + Date.now();
  const signup = await fetch(base(PA) + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'public-signup', password: 'some-password' }) });
  assert.equal(signup.status, 403);
  const login = await fetch(base(PA) + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: testUsername, password: pass }) });
  const loginData = await login.json();
  assert.equal(login.status, 200); assert.equal(loginData.token, undefined);
  const auth = { cookie: (login.headers.get('set-cookie') || '').split(';')[0] };
  const ID = 'AbCdEfGhIjKlMnOp12345';
  let ticketUrl = '';
  await teste('app principal: vídeo e PDF viram 307 para o host de mídia (sem proxiar bytes)', async () => {
    for (const [rota, kind] of [['stream', 'v'], ['pdf', 'p']]) {
      const r = await j(`${base(PA)}/api/drive/${rota}/${ID}`, { headers: auth });
      assert.equal(r.status, 307); const loc = r.headers.get('location');
      assert.ok(loc.startsWith(base(PB) + '/m/'), loc); assert.equal(r.headers.get('content-length') === null || Number(r.headers.get('content-length')) < 500, true);
      if (kind === 'v') ticketUrl = loc;
    }
  });
  await teste('o ticket emitido pelo app principal é aceito pelo host de mídia (mesmo APP_PASSWORD)', async () => {
    const r = await j(ticketUrl, { method: 'OPTIONS' }); assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const ruim = await j(base(PB) + '/m/ticket-invalido'); assert.equal(ruim.status, 404);
  });
  await teste('Range aberto é entregue em blocos de até 8 MiB', async () => {
    const ticket = ticketUrl.split('/m/')[1];
    const first = await j(`${base(PB)}/m/${ticket}`, { headers: { Range: 'bytes=0-' } });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get('content-range'), 'bytes 0-8388607/20971520');
    assert.equal(Number(first.headers.get('content-length')), 8 * 1024 * 1024);
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    assert.equal(firstBytes.byteLength, 8 * 1024 * 1024);
    assert.equal(firstBytes[0], 0);
    assert.equal(firstBytes[1024 * 1024], (1024 * 1024) % 251);
    assert.equal(firstBytes[4 * 1024 * 1024], (4 * 1024 * 1024) % 251);

    const next = await j(`${base(PB)}/m/${ticket}`, { headers: { Range: 'bytes=8388608-' } });
    assert.equal(next.status, 206);
    assert.equal(next.headers.get('content-range'), 'bytes 8388608-16777215/20971520');
    assert.equal((await next.arrayBuffer()).byteLength, 8 * 1024 * 1024);
  });
  await teste('HEAD também informa o tamanho do bloco limitado', async () => {
    const ticket = ticketUrl.split('/m/')[1];
    const head = await j(`${base(PB)}/m/${ticket}`, { method: 'HEAD', headers: { Range: 'bytes=0-' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), 'bytes 0-8388607/20971520');
    assert.equal(Number(head.headers.get('content-length')), 8 * 1024 * 1024);
  });
  await teste('host de mídia: só /m/* e /api/health; todo o resto 404', async () => {
    assert.equal((await j(base(PB) + '/api/health')).status, 200);
    for (const p of ['/', '/index.html', '/api/auth/login', '/api/questions/bank', '/acervo-manifest.json', '/data/users.json', '/server.js']) assert.equal((await j(base(PB) + p)).status, 404, p);
    assert.equal((await j(base(PB) + '/api/auth/signup', { method: 'POST' })).status, 404);
  });
  await teste('/m/<ticket> no app principal redireciona para o host de mídia', async () => {
    const tk = ticketUrl.split('/m/')[1]; const r = await j(`${base(PA)}/m/${tk}`);
    assert.equal(r.status, 307); assert.equal(r.headers.get('location'), `${base(PB)}/m/${tk}`);
  });
} finally {
  A.kill(); B.kill();
  await Promise.all([A, B].map(child => new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); })));
  for (const [file, content] of originals) {
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
  }
}
for (const l of t) console.log(l.join(' — '));
process.exit(t.length && t.every(l => l[0] === 'OK ') ? 0 : 1);
