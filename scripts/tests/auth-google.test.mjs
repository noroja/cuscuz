// Login com Google: o servidor valida o access_token no Supabase (simulado) e ignora e-mail/nome vindos do navegador.
import http from 'node:http';
import express from 'express';
import assert from 'node:assert/strict';
const usuarios = {
  'tok-alex': { id: 'u1', email: 'Alex@gmail.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: true } }], user_metadata: { full_name: 'Alex' } },
  'tok-outro': { id: 'u2', email: 'alex@outlook.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: true } }], user_metadata: { name: 'Outro Alex' } },
  'tok-senha': { id: 'u3', email: 'x@y.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'email' }, identities: [{ provider: 'email' }] },
  'tok-naoverif': { id: 'u4', email: 'z@y.com', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: false } }] }
};
const sb = http.createServer((req, res) => {
  if (req.url === '/auth/v1/user') { const t = (req.headers.authorization || '').replace('Bearer ', ''); const u = usuarios[t]; res.writeHead(u ? 200 : 401, { 'content-type': 'application/json' }); return res.end(JSON.stringify(u || { msg: 'invalid' })); }
  if (req.url.startsWith('/rest/v1/')) { const gravou = req.method !== 'GET'; res.writeHead(gravou ? 201 : 200, { 'content-type': 'application/json' }); return res.end(gravou ? '' : '[]'); }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise(r => sb.listen(0, r));
process.env.SUPABASE_URL = `http://127.0.0.1:${sb.address().port}`; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
const { setupAuthRoutes } = await import('../../src/auth-multiuser.js');
const app = express(); app.use(express.json()); setupAuthRoutes(app);
const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
const B = `http://127.0.0.1:${srv.address().port}`;
const post = async (u, c) => { const r = await fetch(B + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const t = []; const teste = async (n, fn) => { try { await fn(); t.push(['OK ', n]); } catch (e) { t.push(['FALHOU', n, e.message]); } };

await teste('antigo formato (e-mail no corpo, sem token) é recusado', async () => { const r = await post('/api/auth/google', { email: 'qualquer@x.com', name: 'x' }); assert.equal(r.status, 400); assert.ok(!r.j.token); });
await teste('token inválido é recusado', async () => { const r = await post('/api/auth/google', { accessToken: 'falso', email: 'alex@gmail.com' }); assert.equal(r.status, 401); assert.ok(!r.j.token); });
await teste('conta de e-mail/senha do Supabase (não Google) é recusada', async () => { assert.equal((await post('/api/auth/google', { accessToken: 'tok-senha' })).status, 401); });
await teste('e-mail do Google não verificado é recusado', async () => { assert.equal((await post('/api/auth/google', { accessToken: 'tok-naoverif' })).status, 401); });
let u1;
await teste('token válido cria a sessão com o e-mail VERIFICADO (ignora o que o navegador diz)', async () => {
  const r = await post('/api/auth/google', { accessToken: 'tok-alex', email: 'admin@falso.com', name: 'Falso' });
  assert.equal(r.status, 200); assert.ok(r.j.token); u1 = r.j.user.username; assert.equal(u1, 'alex_g');
  const me = await (await fetch(B + '/api/auth/me', { headers: { authorization: 'Bearer ' + r.j.token } })).json(); assert.ok(JSON.stringify(me).includes('alex_g'));
});
await teste('mesmo começo de e-mail em outro e-mail NÃO entra na mesma conta', async () => {
  const r = await post('/api/auth/google', { accessToken: 'tok-outro' }); assert.equal(r.status, 200); assert.notEqual(r.j.user.username, u1); assert.ok(r.j.user.username.startsWith('alex_g'));
});
await teste('mesmo e-mail volta à mesma conta', async () => { assert.equal((await post('/api/auth/google', { accessToken: 'tok-alex' })).j.user.username, u1); });
await teste('usuário cadastrado antes com senha como "alex_g" não é reaproveitado', async () => {
  const sg = await post('/api/auth/signup', { username: 'x_g', password: 'senha-teste-123' }); assert.equal(sg.status, 200);
  usuarios['tok-x'] = { id: 'u9', email: 'x@gmail.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: true } }] };
  const r = await post('/api/auth/google', { accessToken: 'tok-x' }); assert.equal(r.status, 200); assert.notEqual(r.j.user.username, 'x_g');
});
srv.close(); sb.close();
for (const l of t) console.log(l.join(' — '));
process.exit(t.every(l => l[0] === 'OK ') ? 0 : 1);
