// Security regression tests for private access, invitations, sessions and RBAC.
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import assert from 'node:assert/strict';

const now = Date.now();
const salt = crypto.randomBytes(16);
const password = 'password-test-1234';
const passwordHash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
const db = {
  users: [
    { username: 'alex_g', name: 'Alex', password_hash: 'GOOGLE_AUTH', salt: 'GOOGLE_AUTH', role: 'user', settings: { email: 'alex@gmail.com' }, email: 'alex@gmail.com', is_active: true, created_at: new Date(now - 50000).toISOString() },
    { username: 'blocked_g', name: 'Suspenso', password_hash: 'GOOGLE_AUTH', salt: 'GOOGLE_AUTH', role: 'user', settings: { email: 'blocked@gmail.com' }, email: 'blocked@gmail.com', is_active: false },
    { username: 'blocked_local', name: 'Suspenso local', password_hash: passwordHash, salt: salt.toString('hex'), role: 'user', settings: {}, email: null, is_active: false },
    { username: 'noro_test', name: 'Noro', password_hash: passwordHash, salt: salt.toString('hex'), role: 'user', settings: {}, email: null, is_active: true },
    { username: 'admin_test', name: 'Admin', password_hash: passwordHash, salt: salt.toString('hex'), role: 'admin', settings: {}, email: 'admin@test.local', is_active: true },
    { username: 'root_test', name: 'Root', password_hash: passwordHash, salt: salt.toString('hex'), role: 'super_admin', settings: {}, email: 'root@test.local', is_active: true, is_primary_admin: true }
  ],
  sessions: [
    { token: 'admin-token', username: 'admin_test', created_at: now, expires_at: now + 86400000 },
    { token: 'root-token', username: 'root_test', created_at: now, expires_at: now + 86400000 },
    { token: 'user-token', username: 'noro_test', created_at: now, expires_at: now + 86400000 },
    { token: 'renew-token', username: 'alex_g', created_at: now - 29 * 86400000, expires_at: now + 86400000 }
  ],
  invites: [],
  recoveries: [],
  audits: []
};
const authUsers = {
  'tok-alex': { id: 'u1', email: 'Alex@gmail.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: true } }], user_metadata: { full_name: 'Alex' } },
  'tok-other': { id: 'u2', email: 'alex@outlook.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: true } }], user_metadata: { name: 'Outro Alex' } },
  'tok-unverified': { id: 'u3', email: 'nobody@example.com', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: false } }] },
  'tok-invite': { id: 'u4', email: 'invite@example.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'email' }, identities: [{ provider: 'email' }] }
};
let lastRecoveryRedirect = '', lastInviteRedirect = '', lastOtpRedirect = '';

function filterRows(rows, url) {
  return rows.filter(row => {
    for (const [key, value] of url.searchParams) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(key)) continue;
      if (value.startsWith('eq.')) {
        if (String(row[key] ?? '') !== decodeURIComponent(value.slice(3))) return false;
      } else if (value === 'is.null') {
        if (row[key] != null) return false;
      } else if (value.startsWith('gt.')) {
        if (!(new Date(row[key]).getTime() > new Date(value.slice(3)).getTime())) return false;
      }
    }
    return true;
  });
}

const sb = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/auth/v1/user') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = authUsers[token];
    res.writeHead(user ? 200 : 401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(user || { msg: 'invalid' }));
  }
  if (url.pathname === '/auth/v1/recover') {
    const body = JSON.parse(await new Promise(resolve => { let raw=''; req.on('data', x => raw += x); req.on('end', () => resolve(raw || '{}')); }));
    lastRecoveryRedirect = url.searchParams.get('redirect_to') || body.redirect_to || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Recovery email sent' }));
  }
  if (url.pathname === '/auth/v1/invite') {
    const body = JSON.parse(await new Promise(resolve => { let raw=''; req.on('data', x => raw += x); req.on('end', () => resolve(raw || '{}')); }));
    lastInviteRedirect = url.searchParams.get('redirect_to') || '';
    if (body.email === 'existing-auth@example.com') {
      res.writeHead(422, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 'user_already_exists', message: 'User already registered' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'new-auth-user', email: body.email }));
  }
  if (url.pathname === '/auth/v1/otp') {
    lastOtpRedirect = url.searchParams.get('redirect_to') || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'OTP sent' }));
  }
  if (url.pathname.startsWith('/auth/v1/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'invited-auth-user', email: 'invite@example.com' }));
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const body = JSON.parse(await new Promise(resolve => { let raw=''; req.on('data', x => raw += x); req.on('end', () => resolve(raw || '{}')); }));
    if (url.pathname.endsWith('/complete_user_password_recovery')) {
      const challenge = db.recoveries.find(item => item.token_hash === body.p_token_hash && item.consumed_at == null && new Date(item.expires_at).getTime() > Date.now());
      const matches = db.users.filter(item => item.email?.toLowerCase() === body.p_email.toLowerCase() && item.is_active !== false);
      if (!challenge || challenge.email.toLowerCase() !== body.p_email.toLowerCase() || matches.length !== 1) {
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]');
      }
      const user = matches[0];
      user.password_hash = body.p_password_hash; user.salt = body.p_salt;
      db.sessions = db.sessions.filter(session => session.username !== user.username);
      challenge.consumed_at = new Date().toISOString();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ username: user.username }]));
    }
    const invite = db.invites.find(item => item.token_hash === body.p_token_hash && item.accepted_at == null && item.revoked_at == null && new Date(item.expires_at).getTime() > Date.now());
    if (!invite || invite.email.toLowerCase() !== body.p_email.toLowerCase()) {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]');
    }
    const user = db.users.find(item => item.username === invite.username && item.is_active === false);
    if (!user) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    user.password_hash = body.p_password_hash; user.salt = body.p_salt; user.is_active = true;
    user.email = invite.email.toLowerCase(); user.settings = { email: invite.email.toLowerCase() };
    invite.accepted_at = new Date().toISOString();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify([{ username: user.username, display_name: user.name, role: user.role }]));
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.split('/').at(-1);
    const rows = table === 'users' ? db.users : table === 'sessions' ? db.sessions : table === 'user_invitations' ? db.invites : table === 'user_password_recoveries' ? db.recoveries : db.audits;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(filterRows(rows, url)));
    }
    const raw = await new Promise(resolve => { let value=''; req.on('data', x => value += x); req.on('end', () => resolve(value)); });
    const body = raw ? JSON.parse(raw) : {};
    const incoming = Array.isArray(body) ? body : [body];
    if (req.method === 'POST') {
      for (const item of incoming) {
        const existing = table === 'sessions' ? rows.find(row => row.token === item.token)
          : table === 'user_invitations' ? rows.find(row => row.token_hash === item.token_hash)
            : table === 'users' ? rows.find(row => row.username === item.username) : null;
        if (existing) Object.assign(existing, item); else rows.push(item);
      }
      res.writeHead(201, { 'content-type': 'application/json' }); return res.end(JSON.stringify(incoming));
    }
    const matching = filterRows(rows, url);
    if (req.method === 'PATCH') for (const row of matching) Object.assign(row, body);
    if (req.method === 'DELETE') for (const row of matching) rows.splice(rows.indexOf(row), 1);
    res.writeHead(204); return res.end();
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise(resolve => sb.listen(0, resolve));
process.env.SUPABASE_URL = `http://127.0.0.1:${sb.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.NODE_ENV = 'test';
const { setupAuthRoutes, authMiddleware, registerAdminRoutes, getRequestSessionToken, validateSession } = await import('../../src/auth-multiuser.js');

const app = express(); app.set('trust proxy', true); app.use(express.json());
setupAuthRoutes(app); app.use('/api', authMiddleware); registerAdminRoutes(app);
app.get('/api/private-test', (req, res) => res.json({ user: req.user.username }));
app.get('/api/health', (req, res) => {
  const isAdmin = ['admin', 'super_admin'].includes(req.user?.role);
  if (req.query.deep === '1' && !isAdmin) return res.status(403).json({ status: 'forbidden' });
  return res.json({ status: 'ok', ...(isAdmin ? { providers: ['test-provider'] } : {}), ...(req.query.deep === '1' ? { diagnostic: true } : {}) });
});
app.get('/private-manifest-test', async (req, res) => res.send(await validateSession(getRequestSessionToken(req)) ? 'ok' : 'unauthorized'));
const server = await new Promise(resolve => { const instance = app.listen(0, () => resolve(instance)); });
const base = `http://127.0.0.1:${server.address().port}`;
const cookie = token => ({ cookie: `cuscuz_session=${token}` });
const post = async (route, body, opts = {}) => {
  const response = await fetch(base + route, { ...opts, method: 'POST', headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: JSON.stringify(body) });
  return { response, data: await response.json().catch(() => ({})) };
};
const tests = [];
const test = async (name, fn) => { try { await fn(); tests.push(['OK', name]); } catch (error) { tests.push(['FAIL', name, error.stack || error.message]); } };

await test('cadastro público e consulta de nomes permanecem bloqueados', async () => {
  assert.equal((await post('/api/auth/signup', { username: 'attacker', password })).response.status, 403);
  assert.equal((await fetch(base + '/api/auth/check-username?username=attacker')).status, 404);
});
await test('token Google verificado sem conta autorizada não cria usuário', async () => {
  const before = db.users.length;
  const { response, data } = await post('/api/auth/google', { accessToken: 'tok-other', email: 'alex@gmail.com' });
  assert.equal(response.status, 403); assert.equal(data.token, undefined); assert.equal(db.users.length, before);
});
await test('Google exige provedor e e-mail confirmado', async () => {
  assert.equal((await post('/api/auth/google', { accessToken: 'tok-unverified' })).response.status, 401);
  assert.equal((await post('/api/auth/google', { email: 'alex@gmail.com' })).response.status, 400);
});
await test('Google permite apenas conta previamente autorizada e emite cookie HttpOnly', async () => {
  const { response, data } = await post('/api/auth/google', { accessToken: 'tok-alex', email: 'attacker@example.com' });
  assert.equal(response.status, 200); assert.equal(data.user.username, 'alex_g'); assert.equal(data.token, undefined);
  assert.match(response.headers.get('set-cookie') || '', /HttpOnly/);
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  const me = await fetch(base + '/api/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200); assert.equal((await me.json()).user.role, 'user');
});
await test('conta Google suspensa não autentica', async () => {
  authUsers['tok-blocked'] = { email: 'blocked@gmail.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email_verified: true } }] };
  assert.equal((await post('/api/auth/google', { accessToken: 'tok-blocked' })).response.status, 403);
});
await test('login local cria sessão em cookie e não retorna token ao navegador', async () => {
  const { response, data } = await post('/api/auth/login', { username: 'noro_test', password });
  assert.equal(response.status, 200); assert.equal(data.token, undefined); assert.equal(data.user.username, 'noro_test');
  assert.match(response.headers.get('set-cookie') || '', /HttpOnly/);
  assert.match(response.headers.get('set-cookie') || '', /SameSite=Lax/);
});
await test('conta suspensa não pode entrar com senha local', async () => {
  const { response, data } = await post('/api/auth/login', { username: 'blocked_local', password });
  assert.equal(response.status, 400); assert.equal(data.success, false); assert.match(data.error, /usuário ou senha/i);
});
await test('usuário autenticado acessa API privada e usuário suspenso perde o acesso', async () => {
  const allowed = await fetch(base + '/api/private-test', { headers: cookie('user-token') });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const stopped = await fetch(base + '/api/admin/users', { headers: cookie('user-token') });
  assert.equal(stopped.status, 403);
  const suspended = await fetch(base + '/api/admin/users/noro_test/status', { method: 'PATCH', headers: { ...cookie('root-token'), origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) });
  assert.equal(suspended.status, 200);
  const denied = await fetch(base + '/api/private-test', { headers: cookie('user-token') });
  assert.equal(denied.status, 401);
});
await test('health público é mínimo e diagnóstico exige administrador', async () => {
  const publicHealth = await fetch(base + '/api/health');
  assert.equal(publicHealth.status, 200);
  assert.deepEqual(await publicHealth.json(), { status: 'ok' });
  assert.equal((await fetch(base + '/api/health?deep=1')).status, 401);
  assert.equal((await fetch(base + '/api/health?deep=1', { headers: cookie('renew-token') })).status, 403);
  const adminHealth = await fetch(base + '/api/health?deep=1', { headers: cookie('root-token') });
  assert.equal(adminHealth.status, 200);
  assert.deepEqual(await adminHealth.json(), { status: 'ok', providers: ['test-provider'], diagnostic: true });
});
await test('sessão validada permanece sem gravação em requisições de leitura', async () => {
  const before = db.sessions.find(session => session.token === 'renew-token').expires_at;
  assert.equal((await fetch(base + '/api/private-test', { headers: cookie('renew-token') })).status, 200);
  assert.equal(db.sessions.find(session => session.token === 'renew-token').expires_at, before);
  assert.equal((await fetch(base + '/api/private-test', { headers: cookie('renew-token') })).status, 200);
  assert.equal(db.sessions.find(session => session.token === 'renew-token').expires_at, before);
});
await test('somente super_admin convida administradores; promoção própria é bloqueada', async () => {
  const adminInvite = await post('/api/admin/invitations', { email: 'new-user@example.com', displayName: 'New User', role: 'user' }, { headers: { ...cookie('admin-token'), origin: base } });
  assert.equal(adminInvite.response.status, 201);
  const denied = await post('/api/admin/invitations', { email: 'new-admin@example.com', displayName: 'New Admin', role: 'admin' }, { headers: { ...cookie('admin-token'), origin: base } });
  assert.equal(denied.response.status, 403);
  const elevated = await fetch(base + '/api/admin/users/root_test/role', { method: 'PATCH', headers: { ...cookie('root-token'), origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user' }) });
  assert.equal(elevated.status, 403);
  assert.ok(db.audits.some(event => event.action === 'user.invited'));
});
await test('convite para identidade Supabase já existente usa link de acesso sem provisionar outra identidade', async () => {
  const invite = await post('/api/admin/invitations', { email: 'existing-auth@example.com', displayName: 'Existing Auth', role: 'user' }, { headers: { ...cookie('admin-token'), origin: base } });
  assert.equal(invite.response.status, 201);
  assert.match(lastInviteRedirect, /invite=/);
  assert.match(lastOtpRedirect, /invite=/);
  assert.ok(db.users.some(user => user.email === 'existing-auth@example.com' && user.is_active === false));
});
await test('convite é aceito uma vez com senha definida pelo usuário e senha/token não são devolvidos', async () => {
  const inviteToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
  db.users.push({ username: 'invite', name: 'Invite User', email: 'invite@example.com', password_hash: 'INVITED', salt: 'INVITED', role: 'user', settings: { email: 'invite@example.com' }, is_active: false });
  db.invites.push({ token_hash: tokenHash, email: 'invite@example.com', username: 'invite', role: 'user', display_name: 'Invite User', invited_by: 'root_test', expires_at: new Date(Date.now() + 3600000).toISOString(), accepted_at: null, revoked_at: null });
  const url = new URL(base + '/api/auth/invitations/accept');
  const { response, data } = await post('/api/auth/invitations/accept', { inviteToken, accessToken: 'tok-invite', password: 'new-secure-password-123' }, { headers: { origin: base } });
  assert.equal(response.status, 200); assert.equal(data.user.username, 'invite'); assert.equal(data.token, undefined);
  assert.match(response.headers.get('set-cookie') || '', /HttpOnly/);
  const again = await post('/api/auth/invitations/accept', { inviteToken, accessToken: 'tok-invite', password: 'new-secure-password-123' }, { headers: { origin: base } });
  assert.equal(again.response.status, 400);
  assert.notEqual(db.users.find(user => user.username === 'invite').password_hash, 'INVITED');
});
await test('convite expirado é recusado', async () => {
  const inviteToken = 'expired-invite-token-'.padEnd(40, 'x');
  db.invites.push({ token_hash: crypto.createHash('sha256').update(inviteToken).digest('hex'), email: 'invite@example.com', username: 'invite', role: 'user', display_name: 'Invite User', invited_by: 'root_test', expires_at: new Date(Date.now() - 1000).toISOString(), accepted_at: null, revoked_at: null });
  const { response } = await post('/api/auth/invitations/accept', { inviteToken, accessToken: 'tok-invite', password: 'new-secure-password-123' }, { headers: { origin: base } });
  assert.equal(response.status, 400);
});
await test('sessão Google sem token de recuperação não permite trocar a senha', async () => {
  const { response } = await post('/api/auth/password-reset/complete', { accessToken: 'tok-alex', password: 'new-secure-password-123' }, { headers: { origin: base } });
  assert.equal(response.status, 400);
});
await test('pedido de recuperação cria desafio de uso único e URL com origem canônica', async () => {
  const { response, data } = await post('/api/auth/password-reset/request', { email: 'alex@gmail.com' }, { headers: { origin: base } });
  assert.equal(response.status, 200); assert.equal(data.success, true);
  const recoveryUrl = new URL(lastRecoveryRedirect);
  assert.equal(recoveryUrl.origin, base);
  const recoveryToken = recoveryUrl.searchParams.get('recover');
  assert.ok(recoveryToken && recoveryToken.length >= 32);
  assert.ok(db.recoveries.some(item => item.token_hash === crypto.createHash('sha256').update(recoveryToken).digest('hex') && item.consumed_at == null));
});
await test('pedido para e-mail não cadastrado mantém a mesma resposta e não cria desafio', async () => {
  const before = db.recoveries.length;
  const { response, data } = await post('/api/auth/password-reset/request', { email: 'missing@example.com' }, { headers: { origin: base } });
  assert.equal(response.status, 200); assert.equal(data.success, true);
  assert.match(data.message, /Se o e-mail estiver vinculado/);
  assert.equal(db.recoveries.length, before);
});
await test('recuperação válida é de uso único e revoga sessões existentes', async () => {
  const recoveryToken = crypto.randomBytes(32).toString('base64url');
  db.recoveries.push({ token_hash: crypto.createHash('sha256').update(recoveryToken).digest('hex'), email: 'alex@gmail.com', expires_at: new Date(Date.now() + 600000).toISOString(), consumed_at: null });
  db.sessions.push({ token: 'alex-old-session', username: 'alex_g', created_at: now, expires_at: now + 86400000 });
  const { response, data } = await post('/api/auth/password-reset/complete', { accessToken: 'tok-alex', recoveryToken, password: 'new-secure-password-123' }, { headers: { origin: base } });
  assert.equal(response.status, 200); assert.equal(data.success, true);
  assert.equal(db.sessions.some(session => session.username === 'alex_g'), false);
  const recovery = db.recoveries.find(item => item.token_hash === crypto.createHash('sha256').update(recoveryToken).digest('hex'));
  assert.ok(recovery.consumed_at);
  const replay = await post('/api/auth/password-reset/complete', { accessToken: 'tok-alex', recoveryToken, password: 'another-secure-password-456' }, { headers: { origin: base } });
  assert.equal(replay.response.status, 400);
});
await test('token de recuperação expirado é recusado', async () => {
  const recoveryToken = crypto.randomBytes(32).toString('base64url');
  db.recoveries.push({ token_hash: crypto.createHash('sha256').update(recoveryToken).digest('hex'), email: 'alex@gmail.com', expires_at: new Date(Date.now() - 1000).toISOString(), consumed_at: null });
  const { response } = await post('/api/auth/password-reset/complete', { accessToken: 'tok-alex', recoveryToken, password: 'new-secure-password-123' }, { headers: { origin: base } });
  assert.equal(response.status, 400);
});
await test('login limita tentativas repetidas por origem', async () => {
  const ip = '198.51.100.123';
  let last;
  for (let i = 0; i < 11; i++) last = await post('/api/auth/login', { username: 'missing', password: 'nope' }, { headers: { 'x-forwarded-for': ip } });
  assert.equal(last.response.status, 429);
});
await test('rota parecida com endpoint de cron não contorna autenticação', async () => {
  assert.equal((await fetch(base + '/api/radar-medico/refresh-malicious')).status, 401);
  assert.equal((await fetch(base + '/api/private-test', { headers: { authorization: 'Bearer root-token' } })).status, 401);
  const migrated = await fetch(base + '/api/auth/me', { headers: { authorization: 'Bearer root-token' } });
  assert.equal(migrated.status, 200);
  assert.match(migrated.headers.get('set-cookie') || '', /HttpOnly/);
  assert.ok(db.sessions.find(session => session.token === 'root-token').expires_at > Date.now() + 29 * 86400000);
});
await test('catálogo protegido exige cookie e ignora tokens em query ou bearer genérico', async () => {
  assert.equal(await (await fetch(base + '/private-manifest-test?t=root-token')).text(), 'unauthorized');
  assert.equal(await (await fetch(base + '/private-manifest-test', { headers: { authorization: 'Bearer root-token' } })).text(), 'unauthorized');
  assert.equal(await (await fetch(base + '/private-manifest-test', { headers: cookie('root-token') })).text(), 'ok');
});

server.close(); sb.close();
for (const line of tests) console.log(`${line[0]} — ${line[1]}${line[2] ? `\n${line[2]}` : ''}`);
process.exit(tests.every(line => line[0] === 'OK') ? 0 : 1);
