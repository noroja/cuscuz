// Multi-user Authentication System with Supabase & Local fallback
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { writableDir, TMP_DIR } from './fs-safe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/* Em serverless o projeto é somente leitura: usuários/sessões locais vão para /tmp.
   O estado durável é o Supabase (quando configurado). */
const DATA_DIR = writableDir(process.env.APP_DATA_DIR || path.join(__dirname, '..', 'data')) || TMP_DIR;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Supabase Client Setup
const supabaseUrl = process.env.SUPABASE_URL;
// Auth tables contain password hashes and session tokens. They are server-only:
// never use the public anon key as a fallback for this client.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const serviceRoleConfigured = !!(supabaseUrl && supabaseKey);
let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
    console.log('✅ [Auth] Conectado ao Supabase com sucesso.');
  } catch (e) {
    console.warn('⚠️ [Auth] Falha ao inicializar Supabase, usando arquivos locais:', e.message);
  }
}

// Configurações de segurança
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 dias
const INVITATION_TTL_MS = 60 * 60 * 1000; // acompanha o padrão de 1 h do Supabase Auth
const SESSION_COOKIE = 'cuscuz_session';
const COOKIE_AUTH_MARKER = 'cookie-session';
const AUTH_PUBLIC_PATHS = new Set([
  '/api/auth/signup', '/api/auth/login', '/api/auth/google',
  '/api/auth/logout', '/api/auth/me', '/api/auth/invitations/accept',
  '/api/auth/password-reset/request', '/api/auth/password-reset/complete'
]);

// Cache em memória para performance
let usersDb = new Map();
let sessionsDb = new Map();
const rateBuckets = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) {}
  }
  return out;
}

function requestToken(req) {
  const cookieToken = parseCookies(req)[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const auth = String(req.headers.authorization || '');
  const fullPath = String(req.originalUrl || req.url || '').split('?')[0];
  if (auth.startsWith('Bearer ') && auth.slice(7) !== COOKIE_AUTH_MARKER &&
      (fullPath === '/api/auth/me' || fullPath === '/api/auth/logout')) return auth.slice(7);
  return null;
}

export function getRequestSessionToken(req) {
  return requestToken(req);
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
  res.set('Cache-Control', 'no-store');
}

function clearSessionCookie(res, req) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (req.secure || process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
  res.set('Cache-Control', 'no-store');
}

function requireSameOrigin(req, res) {
  const origin = req.get('origin');
  if (!origin) return true;
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.secure ? 'https' : 'http');
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || req.get('host');
  try {
    if (new URL(origin).origin === `${protocol}://${host}`) return true;
  } catch (_) {}
  res.status(403).json({ success: false, error: 'Origem da requisição inválida' });
  return false;
}

function getApplicationBaseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim();
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('APP_URL precisa estar configurada em produção.');
  }
  const url = new URL(configured || `${req.protocol}://${req.get('host')}`);
  if (url.username || url.password || url.search || url.hash) throw new Error('APP_URL inválida.');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('APP_URL deve usar HTTPS em produção.');
  }
  return url.origin;
}

function rateLimit(key, limit, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${key}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    let bucket = rateBuckets.get(bucketKey);
    if (!bucket || bucket.until <= now) bucket = { count: 0, until: now + windowMs };
    if (!rateBuckets.has(bucketKey) && rateBuckets.size >= 5000) {
      for (const [k, v] of rateBuckets) if (v.until <= now) rateBuckets.delete(k);
      if (rateBuckets.size >= 5000) rateBuckets.delete(rateBuckets.keys().next().value);
    }
    rateBuckets.delete(bucketKey);
    bucket.count += 1;
    rateBuckets.set(bucketKey, bucket);
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.until - now) / 1000)));
      return res.status(429).json({ success: false, error: 'Muitas tentativas. Aguarde alguns minutos.' });
    }
    next();
  };
}

// Em serverless (Vercel) cada instância nasce com os mapas vazios; sem o await,
// login/signup rodavam antes do carregamento e falhavam com "Usuário ou senha incorretos".
let _loadPromise = null;
function ensureAuthLoaded() {
  if (!_loadPromise) _loadPromise = loadUsersDb().catch(e => { _loadPromise = null; throw e; });
  return _loadPromise;
}

// Busca pontual no Supabase (fallback p/ instância que subiu antes do dado existir)
function mapSupabaseUser(data) {
  return {
    username: data.username,
    displayName: data.name || data.username,
    passwordHash: data.password_hash,
    salt: data.salt,
    role: data.role || 'user',
    settings: data.settings || {},
    email: data.email || (data.settings && data.settings.email) || null,
    isActive: data.is_active !== false,
    isPrimaryAdmin: data.is_primary_admin === true,
    createdAt: data.created_at || null,
    lastLoginAt: data.last_login_at || null
  };
}

async function buscarUsuarioSupabase(username) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const user = mapSupabaseUser(data);
  usersDb.set(user.username, user);
  return user;
}

async function buscarUsuarioPorEmailSupabase(email) {
  if (!supabase) return null;
  const normalized = String(email || '').trim().toLowerCase();
  const { data, error } = await supabase.from('users').select('*').eq('email', normalized).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const user = mapSupabaseUser(data);
  usersDb.set(user.username, user);
  return user;
}

async function buscarSessaoSupabase(token) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('sessions').select('*').eq('token', token).maybeSingle();
  if (error) throw error;
  if (!data || Number(data.expires_at) < Date.now()) return null;
  return {
    token,
    username: data.username,
    createdAt: Number(data.created_at),
    expiresAt: Number(data.expires_at)
  };
}

export async function loadUsersDb() {
  try {
    if (supabase) {
      // Supabase records are fetched by username/email as needed. Loading every
      // account (including password hashes) on each cold serverless start is
      // unnecessary and scales with the whole user table.
      usersDb = new Map();
      sessionsDb = new Map();
      // Sessions are checked directly in Supabase on each request so revocation
      // is immediate. Do not preload every bearer token into serverless memory.
      return;
    }

    // Fallback para arquivos locais
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const arr = JSON.parse(raw);
      usersDb = new Map(arr.map(u => [u.username, u]));
      console.log(`👥 ${usersDb.size} usuários carregados (local).`);
    }
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const arr = JSON.parse(raw);
      const now = Date.now();
      sessionsDb = new Map(arr
        .filter(s => s.expiresAt > now)
        .map(s => [s.token, s]));
      console.log(`🔑 ${sessionsDb.size} sessões válidas carregadas (local).`);
    }
  } catch (e) {
    console.warn('⚠️ Falha ao carregar users/sessions:', e.message);
  }
}

async function saveUser(user) {
  usersDb.set(user.username, user);
  if (supabase) {
    const { error } = await supabase.from('users').upsert({
      username: user.username,
      name: user.displayName,
      password_hash: user.passwordHash,
      salt: user.salt,
      role: user.role || 'user',
      settings: user.settings || {}
    }, { onConflict: 'username' });
    if (error) throw new Error('Falha ao salvar usuário no Supabase: ' + error.message);
    return;
  }
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify([...usersDb.values()], null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Falha ao salvar user local:', e.message);
  }
}

async function saveSession(session) {
  if (supabase) {
    const { error } = await supabase.from('sessions').upsert({
      token: session.token,
      username: session.username,
      created_at: session.createdAt,
      expires_at: session.expiresAt
    }, { onConflict: 'token' });
    if (error) throw new Error('Falha ao salvar sessão no Supabase: ' + error.message);
    return;
  }
  sessionsDb.set(session.token, session);
  try {
    const now = Date.now();
    const valid = [...sessionsDb.entries()].filter(([, s]) => s.expiresAt > now);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(valid.map(([, s]) => s), null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Falha ao salvar session local:', e.message);
  }
}

async function removeSession(token) {
  if (supabase) {
    const { error } = await supabase.from('sessions').delete().eq('token', token);
    if (error) throw new Error('Falha ao revogar sessão no Supabase: ' + error.message);
    sessionsDb.delete(token);
  } else {
    sessionsDb.delete(token);
    try {
      const now = Date.now();
      const valid = [...sessionsDb.entries()].filter(([, s]) => s.expiresAt > now);
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(valid.map(([, s]) => s), null, 2), 'utf8');
    } catch (e) {
      console.warn('⚠️ Falha ao persistir revogação da sessão local:', e.message);
      throw e;
    }
  }
}

async function extendSessionForMigration(token) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  if (supabase) {
    const { error } = await supabase.from('sessions').update({ expires_at: expiresAt }).eq('token', token);
    if (error) throw new Error('Falha ao migrar sessão legada: ' + error.message);
    return;
  }
  const session = sessionsDb.get(token);
  if (!session) throw new Error('Sessão legada não encontrada durante a migração.');
  session.expiresAt = expiresAt;
  await saveSession(session);
}

// Hash de senha com scrypt
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve({
        hash: derivedKey.toString('hex'),
        salt: salt.toString('hex')
      });
    });
  });
}

function verifyPassword(password, hash, salt) {
  return new Promise((resolve, reject) => {
    const saltBuf = Buffer.from(salt, 'hex');
    crypto.scrypt(password, saltBuf, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derivedKey));
    });
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(username) {
  const token = generateToken();
  const now = Date.now();
  const session = {
    token,
    username,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS
  };
  await saveSession(session);
  return token;
}

export async function validateSession(token) {
  if (!token) return null;
  await ensureAuthLoaded();
  let session;
  // In a serverless deployment the in-memory cache cannot prove a session is
  // still valid: another instance may have revoked it. Read through every time.
  if (supabase) {
    session = await buscarSessaoSupabase(token);
    if (!session) return null;
  } else {
    session = sessionsDb.get(token);
    if (!session) return null;
  }
  if (session.expiresAt < Date.now()) {
    await removeSession(token);
    return null;
  }
  // Sessions have a fixed 30-day lifetime. Avoid a database write on reads.
  return session.username;
}

// Rotas de Autenticação Express
export function setupAuthRoutes(app) {
  ensureAuthLoaded().catch(e => console.warn('⚠️ [Auth] Carga inicial de usuários falhou (vai tentar sob demanda):', e.message));

  // Kept as a hard denial so old clients and direct requests cannot create users.
  app.post('/api/auth/signup', (_req, res) => res.status(403).json({
    success: false,
    error: 'Cadastro público desativado. Solicite um convite a um administrador.'
  }));

  app.get('/api/auth/check-username', (_req, res) => res.status(404).json({ success: false }));

  app.post('/api/auth/login', rateLimit('login', 10, 15 * 60 * 1000), async (req, res) => {
    try {
      await ensureAuthLoaded();
      const username = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (!username || !password) return res.status(400).json({ success: false, error: 'Informe usuário e senha' });

      // Fresh status and password are required so suspension and password changes
      // take effect across Vercel instances immediately.
      if (!requireSameOrigin(req, res)) return;
      let user = supabase ? await buscarUsuarioSupabase(username) : usersDb.get(username);
      if (!user || user.isActive === false) return res.status(400).json({ success: false, error: 'Usuário ou senha incorretos' });

      if (!user.passwordHash || user.passwordHash === 'GOOGLE_AUTH' || user.passwordHash === 'INVITED') {
        return res.status(400).json({ success: false, error: 'Usuário ou senha incorretos' });
      }
      const match = await verifyPassword(password, user.passwordHash, user.salt);
      if (!match) return res.status(400).json({ success: false, error: 'Usuário ou senha incorretos' });

      const token = await createSession(username);
      if (supabase) {
        user.lastLoginAt = new Date().toISOString();
        try {
          const { error } = await supabase.from('users').update({ last_login_at: user.lastLoginAt }).eq('username', username);
          if (error) console.warn('[Auth] Não foi possível atualizar last_login_at:', error.message);
        } catch (error) { console.warn('[Auth] Não foi possível atualizar last_login_at:', error.message); }
      }
      setSessionCookie(req, res, token);
      res.json({ success: true, user: { username, displayName: user.displayName, role: user.role } });
    } catch (e) {
      console.error('Erro no login:', e);
      res.status(500).json({ success: false, error: 'Erro interno no login' });
    }
  });

  // Login com Google (via Supabase Auth). O servidor NÃO confia em e-mail/nome vindos do navegador: valida o access_token da
  // sessão do Supabase consultando /auth/v1/user e só então usa o e-mail verificado devolvido pelo próprio Supabase.
  app.post('/api/auth/google', rateLimit('google', 20, 15 * 60 * 1000), async (req, res) => {
    try {
      const accessToken = String(req.body?.accessToken || '');
      if (!requireSameOrigin(req, res)) return;
      if (!supabaseUrl || !supabaseKey || !supabase) return res.status(503).json({ success: false, error: 'Login com Google indisponível: Supabase não configurado no servidor.' });
      if (!accessToken) return res.status(400).json({ success: false, error: 'Token do Google não fornecido' });
      let gu = null;
      try {
        const r = await fetch(supabaseUrl.replace(/\/+$/, '') + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + accessToken, apikey: supabaseKey } });
        if (r.ok) gu = await r.json();
      } catch (_) { /* cai na recusa abaixo */ }
      const ident = gu && Array.isArray(gu.identities) ? gu.identities.find(i => i.provider === 'google') : null;
      const provider = gu && gu.app_metadata && gu.app_metadata.provider;
      const verificado = gu && (gu.email_confirmed_at || (ident && ident.identity_data && ident.identity_data.email_verified));
      if (!gu || !gu.email || !(ident || provider === 'google') || !verificado) return res.status(401).json({ success: false, error: 'Login com Google inválido ou não verificado' });
      const email = String(gu.email).toLowerCase();
      const user = supabase
        ? await buscarUsuarioPorEmailSupabase(email)
        : (await ensureAuthLoaded(), [...usersDb.values()].find(candidate =>
            String(candidate.email || candidate.settings?.email || '').trim().toLowerCase() === email
          ) || null);
      if (!user || user.isActive === false) {
        return res.status(403).json({ success: false, error: 'Esta conta não foi autorizada. Solicite um convite ao administrador.' });
      }

      const token = await createSession(user.username);
      if (supabase) {
        user.lastLoginAt = new Date().toISOString();
        try {
          const { error } = await supabase.from('users').update({ last_login_at: user.lastLoginAt }).eq('username', user.username);
          if (error) console.warn('[Auth] Não foi possível atualizar last_login_at:', error.message);
        } catch (error) { console.warn('[Auth] Não foi possível atualizar last_login_at:', error.message); }
      }
      setSessionCookie(req, res, token);
      res.json({ success: true, user: { username: user.username, displayName: user.displayName, role: user.role } });
    } catch (e) {
      console.error('Erro no login com Google:', e);
      res.status(500).json({ success: false, error: 'Erro interno ao autenticar com Google' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    const token = requestToken(req);
    clearSessionCookie(res, req);
    if (token) {
      try { await removeSession(token); }
      catch (error) {
        console.error('[Auth] Falha ao encerrar a sessão:', error.message);
        return res.status(503).json({ success: false, error: 'Não foi possível confirmar o encerramento da sessão. Tente novamente.' });
      }
    }
    res.json({ success: true });
  });

  app.get('/api/auth/me', async (req, res) => {
    try {
      const token = requestToken(req);
      const auth = String(req.headers.authorization || '');
      const legacyBearer = !parseCookies(req)[SESSION_COOKIE] && auth.startsWith('Bearer ') && auth.slice(7) !== COOKIE_AUTH_MARKER;
      const username = await validateSession(token);
      if (!username) {
        clearSessionCookie(res, req);
        return res.status(401).json({ success: false, error: 'Não autenticado' });
      }

      const user = supabase ? await buscarUsuarioSupabase(username) : usersDb.get(username);
      if (!user || user.isActive === false) {
        if (token) {
          try { await removeSession(token); }
          catch (error) { console.error('[Auth] Falha ao revogar sessão não autorizada:', error.message); }
        }
        clearSessionCookie(res, req);
        return res.status(401).json({ success: false, error: 'Usuário não autorizado' });
      }

      if (legacyBearer) await extendSessionForMigration(token);

      // Upgrade old localStorage bearer sessions to the HttpOnly cookie without
      // extending the caller-visible lifetime or returning the token again.
      if (token) setSessionCookie(req, res, token);

      res.json({
        success: true,
        user: {
          username: user.username,
          displayName: user.displayName,
          role: user.role
        }
      });
    } catch (error) {
      console.error('[Auth] Falha ao verificar a sessão:', error.message);
      clearSessionCookie(res, req);
      res.status(503).json({ success: false, error: 'Não foi possível validar a sessão no momento.' });
    }
  });

  app.post('/api/auth/invitations/accept', rateLimit('invite-accept', 8, 15 * 60 * 1000), async (req, res) => {
    try {
      if (!requireSameOrigin(req, res)) return;
      if (!serviceRoleConfigured || !supabase) return res.status(503).json({ success: false, error: 'Ativação indisponível no momento.' });
      const inviteToken = String(req.body?.inviteToken || '');
      const accessToken = String(req.body?.accessToken || '');
      const password = String(req.body?.password || '');
      if (inviteToken.length < 32 || inviteToken.length > 256 || !accessToken) {
        return res.status(400).json({ success: false, error: 'Convite inválido ou expirado.' });
      }
      if (password.length < 12 || password.length > 256) {
        return res.status(400).json({ success: false, error: 'Use uma senha com pelo menos 12 caracteres.' });
      }
      const inviteHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      const { data: invite, error: inviteError } = await supabase.from('user_invitations')
        .select('token_hash,email,username,role,display_name,expires_at,accepted_at')
        .eq('token_hash', inviteHash).maybeSingle();
      if (inviteError || !invite || invite.accepted_at || new Date(invite.expires_at).getTime() <= Date.now()) {
        return res.status(400).json({ success: false, error: 'Convite inválido ou expirado.' });
      }
      let authUser = null;
      try {
        const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
          headers: { Authorization: `Bearer ${accessToken}`, apikey: supabaseKey }
        });
        if (response.ok) authUser = await response.json();
      } catch (_) {}
      const verified = authUser && (authUser.email_confirmed_at || authUser.confirmed_at);
      if (!authUser || !verified || String(authUser.email || '').trim().toLowerCase() !== String(invite.email).trim().toLowerCase()) {
        return res.status(401).json({ success: false, error: 'A sessão de convite não corresponde ao e-mail autorizado.' });
      }
      const { hash, salt } = await hashPassword(password);
      const { data: accepted, error: acceptError } = await supabase.rpc('accept_user_invitation', {
        p_token_hash: inviteHash,
        p_email: String(authUser.email).trim().toLowerCase(),
        p_password_hash: hash,
        p_salt: salt
      });
      if (acceptError || !Array.isArray(accepted) || !accepted[0]) {
        return res.status(400).json({ success: false, error: 'Convite inválido, expirado ou já utilizado.' });
      }
      const row = accepted[0];
      const user = {
        username: row.username,
        displayName: row.display_name || row.username,
        passwordHash: hash,
        salt,
        role: row.role || invite.role || 'user',
        email: invite.email,
        isActive: true,
        settings: { email: invite.email }
      };
      usersDb.set(user.username, user);
      const session = await createSession(user.username);
      setSessionCookie(req, res, session);
      res.json({ success: true, user: { username: user.username, displayName: user.displayName, role: user.role } });
    } catch (e) {
      console.error('Erro ao aceitar convite:', e);
      res.status(500).json({ success: false, error: 'Não foi possível ativar a conta.' });
    }
  });

  app.post('/api/auth/password-reset/request', rateLimit('password-reset', 5, 15 * 60 * 1000), async (req, res) => {
    const generic = { success: true, message: 'Se o e-mail estiver vinculado a uma conta, enviaremos as instruções de recuperação.' };
    try {
      if (!requireSameOrigin(req, res)) return;
      if (!supabase || !serviceRoleConfigured) return res.status(503).json({ success: false, error: 'Recuperação indisponível no momento.' });
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.json(generic);
      const base = getApplicationBaseUrl(req);
      // The response is intentionally identical whether or not an account exists.
      const { data: matches, error: lookupError } = await supabase.from('users')
        .select('username,email,is_active').eq('email', email).eq('is_active', true);
      if (lookupError) throw lookupError;
      if (matches?.length === 1) {
        const recoveryToken = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(recoveryToken).digest('hex');
        const { error: revokeError } = await supabase.from('user_password_recoveries')
          .update({ consumed_at: new Date().toISOString() }).eq('email', email).is('consumed_at', null);
        if (revokeError) throw revokeError;
        const { error: insertError } = await supabase.from('user_password_recoveries').insert({
          token_hash: tokenHash,
          email,
          expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString()
        });
        if (insertError) throw insertError;
        const { error: mailError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${base}/?recover=${encodeURIComponent(recoveryToken)}`
        });
        if (mailError) {
          await supabase.from('user_password_recoveries').update({ consumed_at: new Date().toISOString() }).eq('token_hash', tokenHash);
          console.warn('[Auth] Provedor não enviou o e-mail de recuperação:', mailError.message);
        }
      }
      res.set('Cache-Control', 'no-store').json(generic);
    } catch (e) {
      console.error('[Auth] Falha ao solicitar recuperação de senha:', e.message);
      res.set('Cache-Control', 'no-store').json(generic);
    }
  });

  app.post('/api/auth/password-reset/complete', rateLimit('password-reset-complete', 8, 15 * 60 * 1000), async (req, res) => {
    try {
      if (!requireSameOrigin(req, res)) return;
      if (!supabase || !serviceRoleConfigured) return res.status(503).json({ success: false, error: 'Recuperação indisponível no momento.' });
      const accessToken = String(req.body?.accessToken || '');
      const recoveryToken = String(req.body?.recoveryToken || '');
      const password = String(req.body?.password || '');
      if (!accessToken || recoveryToken.length < 32 || recoveryToken.length > 256 || password.length < 12 || password.length > 256) {
        return res.status(400).json({ success: false, error: 'Sessão de recuperação inválida ou senha fraca.' });
      }
      let authUser = null;
      try {
        const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
          headers: { Authorization: `Bearer ${accessToken}`, apikey: supabaseKey }
        });
        if (response.ok) authUser = await response.json();
      } catch (_) {}
      const email = String(authUser?.email || '').trim().toLowerCase();
      if (!authUser || !(authUser.email_confirmed_at || authUser.confirmed_at) || !email) {
        return res.status(401).json({ success: false, error: 'Sessão de recuperação inválida ou expirada.' });
      }
      const { hash, salt } = await hashPassword(password);
      const tokenHash = crypto.createHash('sha256').update(recoveryToken).digest('hex');
      const { data: recovered, error: recoveryError } = await supabase.rpc('complete_user_password_recovery', {
        p_token_hash: tokenHash,
        p_email: email,
        p_password_hash: hash,
        p_salt: salt
      });
      if (recoveryError) throw recoveryError;
      const user = Array.isArray(recovered) ? recovered[0] : recovered;
      if (!user?.username) return res.status(400).json({ success: false, error: 'Link de recuperação inválido ou expirado.' });
      const cached = usersDb.get(user.username);
      if (cached) { cached.passwordHash = hash; cached.salt = salt; }
      for (const [token, session] of sessionsDb) if (session.username === user.username) sessionsDb.delete(token);
      clearSessionCookie(res, req);
      res.set('Cache-Control', 'no-store').json({ success: true, message: 'Senha redefinida. Entre com sua nova senha.' });
    } catch (e) {
      console.error('[Auth] Falha ao concluir recuperação:', e.message);
      res.status(500).json({ success: false, error: 'Não foi possível redefinir a senha.' });
    }
  });
}

// Alias para compatibilidade com server.js (que importa registerAuthRoutes)
export const registerAuthRoutes = setupAuthRoutes;

// Middleware de autenticação de API.
export function authMiddleware(req, res, next) {
  // Dentro de app.use('/api', ...), req.path NÃO contém o prefixo /api.
  // Usar req.originalUrl (caminho completo) para comparar corretamente.
  const full = String(req.originalUrl || req.url || '').split('?')[0];
  if (AUTH_PUBLIC_PATHS.has(full)) return next();
  if (full === '/api/health' && req.query?.deep !== '1') return next();
  if (full === '/api/config') return next();
  if (full === '/api/radar-medico/refresh') return next(); // cron: valida CRON_SECRET na própria rota
  const token = requestToken(req);
  validateSession(token)
    .then(async username => {
      if (!username) return res.status(401).json({ success: false, error: 'Não autenticado' });
      const user = supabase ? await buscarUsuarioSupabase(username) : usersDb.get(username);
      if (!user || user.isActive === false) {
        if (token) await removeSession(token);
        return res.status(401).json({ success: false, error: 'Usuário não autorizado' });
      }
      const authorization = String(req.headers.authorization || '');
      const usingCookie = !authorization.startsWith('Bearer ') || authorization === `Bearer ${COOKIE_AUTH_MARKER}`;
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && usingCookie && !requireSameOrigin(req, res)) return;
      req.user = { username: user.username, displayName: user.displayName, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin === true };
      next();
    })
    .catch(() => res.status(401).json({ success: false, error: 'Erro de autenticação' }));
}

function respondAdminOnly(req, res) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    res.status(403).json({ success: false, error: 'Acesso restrito à administração.' });
    return false;
  }
  if (!serviceRoleConfigured || !supabase) {
    res.status(503).json({ success: false, error: 'Administração indisponível: configure SUPABASE_SERVICE_ROLE_KEY no servidor.' });
    return false;
  }
  return true;
}

function adminCanManage(req, target, roleChange = false) {
  if (req.user.username === target.username || target.is_primary_admin || target.isPrimaryAdmin) return false;
  if (req.user.role === 'super_admin') return true;
  return req.user.role === 'admin' && target.role === 'user' && !roleChange;
}

function inviteUsername(email, used) {
  const base = String(email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'aluno';
  let candidate = base.length >= 3 ? base : `aluno_${base}`;
  if (!used.has(candidate)) return candidate;
  const suffix = crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 7);
  candidate = `${base.slice(0, 22)}_${suffix}`;
  if (used.has(candidate)) candidate = `${base.slice(0, 18)}_${crypto.randomBytes(4).toString('hex')}`;
  return candidate;
}

async function getUnusedInviteUsername(email) {
  const used = new Set();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const username = inviteUsername(email, used);
    const { data, error } = await supabase.from('users').select('username').eq('username', username).maybeSingle();
    if (error) throw error;
    if (!data) return username;
    used.add(username);
  }
  throw new Error('Não foi possível gerar um identificador de usuário disponível.');
}

async function writeAdminAudit(actor, action, targetUsername, metadata = {}) {
  if (!supabase) return;
  const { error } = await supabase.from('auth_admin_audit').insert({
    actor_username: actor,
    action,
    target_username: targetUsername || null,
    metadata,
    created_at: new Date().toISOString()
  });
  if (error) throw new Error('Falha ao persistir auditoria administrativa: ' + error.message);
}

async function sendInviteEmail(req, email, rawToken, displayName) {
  try {
    const base = getApplicationBaseUrl(req);
    const redirectTo = `${base}/?invite=${encodeURIComponent(rawToken)}`;
    const invitation = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { display_name: displayName }
    });
    const inviteError = invitation?.error;
    if (!inviteError) return invitation;
    const detail = `${inviteError.code || ''} ${inviteError.message || ''}`;
    if (!/user[_ ]already[_ ](?:exists|registered)|already (?:exists|registered)/i.test(detail)) return invitation;

    // An approved email may already have a confirmed Supabase identity from an
    // older Google login. In that case, send a sign-in link without creating
    // another Auth user; the app invitation token still gates activation.
    return await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo, data: { display_name: displayName } }
    });
  } catch (error) {
    return { error };
  }
}

async function revokeUserSessions(username) {
  if (supabase) {
    const { error } = await supabase.from('sessions').delete().eq('username', username);
    if (error) throw new Error(error.message);
  }
  for (const [token, session] of sessionsDb) if (session.username === username) sessionsDb.delete(token);
}

export function registerAdminRoutes(app) {
  app.get('/api/admin/users', async (req, res) => {
    if (!respondAdminOnly(req, res)) return;
    try {
      const term = String(req.query.q || '').trim().slice(0, 100).toLowerCase();
      const { data, error } = await supabase.from('users')
        .select('username,name,role,email,is_active,is_primary_admin,created_at,last_login_at')
        .order('created_at', { ascending: true }).limit(500);
      if (error) throw error;
      const { data: pendingInvites, error: inviteError } = await supabase.from('user_invitations')
        .select('username').is('accepted_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString());
      if (inviteError) throw inviteError;
      const pendingUsernames = new Set((pendingInvites || []).map(invite => invite.username));
      let users = (data || []).map(user => ({
        username: user.username,
        displayName: user.name || user.username,
        email: user.email || '',
        role: user.role || 'user',
        active: user.is_active !== false,
        invitationPending: user.is_active === false && pendingUsernames.has(user.username),
        primaryAdmin: user.is_primary_admin === true,
        createdAt: user.created_at || null,
        lastLoginAt: user.last_login_at || null
      }));
      if (term) users = users.filter(user => `${user.username} ${user.displayName} ${user.email} ${user.role}`.toLowerCase().includes(term));
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, users });
    } catch (e) {
      console.error('[Admin] Falha ao listar usuários:', e.message);
      res.status(500).json({ success: false, error: 'Não foi possível carregar as contas.' });
    }
  });

  app.post('/api/admin/invitations', rateLimit('admin-invite', 10, 60 * 60 * 1000), async (req, res) => {
    if (!respondAdminOnly(req, res)) return;
    if (!requireSameOrigin(req, res)) return;
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const displayName = String(req.body?.displayName || '').trim().slice(0, 100);
      const role = String(req.body?.role || 'user');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !displayName) {
        return res.status(400).json({ success: false, error: 'Informe um e-mail válido e o nome do usuário.' });
      }
      if (!['user', 'admin', 'super_admin'].includes(role)) return res.status(400).json({ success: false, error: 'Papel inválido.' });
      if (role !== 'user' && req.user.role !== 'super_admin') return res.status(403).json({ success: false, error: 'Somente super_admin pode convidar administradores.' });
      const { data: emailMatches, error: lookupError } = await supabase.from('users').select('username').eq('email', email).limit(1);
      if (lookupError) throw lookupError;
      if (emailMatches?.length) return res.status(409).json({ success: false, error: 'Já existe uma conta ou convite para este e-mail.' });

      const username = await getUnusedInviteUsername(email);
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
      const { error: userError } = await supabase.from('users').insert({
        username,
        name: displayName,
        password_hash: 'INVITED',
        salt: 'INVITED',
        role,
        settings: { email },
        email,
        is_active: false,
        is_primary_admin: false
      });
      if (userError) throw userError;
      const { error: inviteError } = await supabase.from('user_invitations').insert({
        token_hash: tokenHash,
        email,
        username,
        role,
        display_name: displayName,
        invited_by: req.user.username,
        expires_at: expiresAt
      });
      if (inviteError) {
        await supabase.from('users').delete().eq('username', username);
        throw inviteError;
      }
      usersDb.set(username, { username, displayName, email, passwordHash: 'INVITED', salt: 'INVITED', role, isActive: false, settings: { email } });
      const { error: mailError } = await sendInviteEmail(req, email, rawToken, displayName);
      await writeAdminAudit(req.user.username, 'user.invited', username, { role, email });
      if (mailError) {
        return res.status(502).json({ success: false, pending: true, username, error: 'A conta foi preparada, mas o e-mail não foi enviado. Verifique o SMTP/URL permitida do Supabase e tente reenviar.' });
      }
      res.status(201).json({ success: true, username, message: 'Convite enviado. Ele expira em 1 hora.' });
    } catch (e) {
      console.error('[Admin] Falha ao convidar usuário:', e.message);
      res.status(500).json({ success: false, error: 'Não foi possível criar o convite.' });
    }
  });

  app.post('/api/admin/users/:username/resend-invite', rateLimit('admin-resend-invite', 10, 60 * 60 * 1000), async (req, res) => {
    if (!respondAdminOnly(req, res)) return;
    if (!requireSameOrigin(req, res)) return;
    try {
      const username = String(req.params.username || '').toLowerCase();
      const { data: target, error } = await supabase.from('users')
        .select('username,name,role,email,is_active,is_primary_admin').eq('username', username).maybeSingle();
      if (error || !target) return res.status(404).json({ success: false, error: 'Conta não encontrada.' });
      if (!adminCanManage(req, target) || target.is_active !== false || !target.email) return res.status(403).json({ success: false, error: 'Este convite não pode ser reenviado por sua conta.' });
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const { error: revokeError } = await supabase.from('user_invitations').update({ revoked_at: new Date().toISOString() })
        .eq('username', username).is('accepted_at', null).is('revoked_at', null);
      if (revokeError) throw revokeError;
      const { error: inviteError } = await supabase.from('user_invitations').insert({
        token_hash: tokenHash,
        email: target.email,
        username,
        role: target.role || 'user',
        display_name: target.name || username,
        invited_by: req.user.username,
        expires_at: new Date(Date.now() + INVITATION_TTL_MS).toISOString()
      });
      if (inviteError) throw inviteError;
      const { error: mailError } = await sendInviteEmail(req, target.email, rawToken, target.name || username);
      await writeAdminAudit(req.user.username, 'user.invite_resent', username, { role: target.role });
      if (mailError) return res.status(502).json({ success: false, error: 'Não foi possível reenviar. Verifique o provedor de e-mail do Supabase.' });
      res.json({ success: true, message: 'Novo convite enviado; o anterior foi invalidado.' });
    } catch (e) {
      console.error('[Admin] Falha ao reenviar convite:', e.message);
      res.status(500).json({ success: false, error: 'Não foi possível reenviar o convite.' });
    }
  });

  app.patch('/api/admin/users/:username/status', async (req, res) => {
    if (!respondAdminOnly(req, res)) return;
    if (!requireSameOrigin(req, res)) return;
    try {
      const username = String(req.params.username || '').toLowerCase();
      const active = req.body?.active;
      if (typeof active !== 'boolean') return res.status(400).json({ success: false, error: 'Estado inválido.' });
      const { data: target, error } = await supabase.from('users')
        .select('username,role,is_active,is_primary_admin,password_hash').eq('username', username).maybeSingle();
      if (error || !target) return res.status(404).json({ success: false, error: 'Conta não encontrada.' });
      if (!adminCanManage(req, target)) return res.status(403).json({ success: false, error: 'Você não pode alterar esta conta.' });
      if (active && target.password_hash === 'INVITED') return res.status(409).json({ success: false, error: 'Conta pendente deve ser ativada pelo convite.' });
      if (active) {
        // Clear any stale sessions before reactivating an account.
        await revokeUserSessions(username);
      }
      const { error: updateError } = await supabase.from('users').update({ is_active: active }).eq('username', username);
      if (updateError) throw updateError;
      const cached = usersDb.get(username);
      if (cached) cached.isActive = active;
      if (!active) {
        await revokeUserSessions(username);
        const { error: inviteError } = await supabase.from('user_invitations').update({ revoked_at: new Date().toISOString() })
          .eq('username', username).is('accepted_at', null).is('revoked_at', null);
        if (inviteError) throw inviteError;
      }
      await writeAdminAudit(req.user.username, active ? 'user.activated' : 'user.suspended', username);
      res.json({ success: true, active });
    } catch (e) {
      console.error('[Admin] Falha ao alterar estado:', e.message);
      res.status(500).json({ success: false, error: 'Não foi possível alterar o acesso.' });
    }
  });

  app.patch('/api/admin/users/:username/role', async (req, res) => {
    if (!respondAdminOnly(req, res)) return;
    if (!requireSameOrigin(req, res)) return;
    try {
      if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, error: 'Somente super_admin pode alterar papéis.' });
      const username = String(req.params.username || '').toLowerCase();
      const role = String(req.body?.role || '');
      if (!['user', 'admin', 'super_admin'].includes(role)) return res.status(400).json({ success: false, error: 'Papel inválido.' });
      const { data: target, error } = await supabase.from('users')
        .select('username,role,is_primary_admin').eq('username', username).maybeSingle();
      if (error || !target) return res.status(404).json({ success: false, error: 'Conta não encontrada.' });
      if (!adminCanManage(req, target, true)) return res.status(403).json({ success: false, error: 'Esta conta não pode ser alterada.' });
      const { error: updateError } = await supabase.from('users').update({ role }).eq('username', username);
      if (updateError) throw updateError;
      const cached = usersDb.get(username);
      if (cached) cached.role = role;
      await writeAdminAudit(req.user.username, 'user.role_changed', username, { from: target.role, to: role });
      res.json({ success: true, role });
    } catch (e) {
      console.error('[Admin] Falha ao alterar papel:', e.message);
      res.status(500).json({ success: false, error: 'Não foi possível alterar o papel.' });
    }
  });
}

// Atualiza nome de exibição do usuário
export async function updateUserProfile(username, displayName) {
  const user = usersDb.get(username) || await buscarUsuarioSupabase(username);
  if (!user) return null;
  user.displayName = displayName.trim();
  await saveUser(user);
  return user;
}

// Retorna o diretório de dados de um usuário específico
export function getUserDataDir(username) {
  const safe = String(username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'user';
  return path.join(DATA_DIR, 'users', safe);
}

// Retorna o caminho completo para um arquivo dentro do diretório do usuário
export function getUserFilePath(username, filename) {
  return path.join(getUserDataDir(username), filename);
}
