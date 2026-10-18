// Multi-user Authentication System with Supabase & Local fallback
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Supabase Client Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
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

// Cache em memória para performance
let usersDb = new Map();
let sessionsDb = new Map();

export async function loadUsersDb() {
  try {
    if (supabase) {
      // Carrega do Supabase
      const { data: users, error: uErr } = await supabase.from('users').select('*');
      if (!uErr && users) {
        usersDb = new Map(users.map(u => [u.username, {
          username: u.username,
          displayName: u.name || u.username,
          passwordHash: u.password_hash,
          salt: u.salt,
          role: u.role || 'user',
          settings: u.settings || {}
        }]));
        console.log(`👥 [Supabase] ${usersDb.size} usuários carregados.`);
      }

      const { data: sessions, error: sErr } = await supabase.from('sessions').select('*');
      if (!sErr && sessions) {
        const now = Date.now();
        sessionsDb = new Map(sessions
          .filter(s => Number(s.expires_at) > now)
          .map(s => [s.token, {
            token: s.token,
            username: s.username,
            createdAt: Number(s.created_at),
            expiresAt: Number(s.expires_at)
          }]));
        console.log(`🔑 [Supabase] ${sessionsDb.size} sessões válidas carregadas.`);
      }
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
    await supabase.from('users').upsert({
      username: user.username,
      name: user.displayName,
      password_hash: user.passwordHash,
      salt: user.salt,
      role: user.role || 'user',
      settings: user.settings || {}
    }, { onConflict: 'username' });
    return;
  }
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify([...usersDb.values()], null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Falha ao salvar user local:', e.message);
  }
}

async function saveSession(session) {
  sessionsDb.set(session.token, session);
  if (supabase) {
    await supabase.from('sessions').upsert({
      token: session.token,
      username: session.username,
      created_at: session.createdAt,
      expires_at: session.expiresAt
    }, { onConflict: 'token' });
    return;
  }
  try {
    const now = Date.now();
    const valid = [...sessionsDb.entries()].filter(([, s]) => s.expiresAt > now);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(valid.map(([, s]) => s), null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Falha ao salvar session local:', e.message);
  }
}

async function removeSession(token) {
  sessionsDb.delete(token);
  if (supabase) {
    await supabase.from('sessions').delete().eq('token', token);
    return;
  }
  try {
    const now = Date.now();
    const valid = [...sessionsDb.entries()].filter(([, s]) => s.expiresAt > now);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(valid.map(([, s]) => s), null, 2), 'utf8');
  } catch (e) {}
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
  const session = sessionsDb.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await removeSession(token);
    return null;
  }
  session.expiresAt = Date.now() + TOKEN_TTL_MS;
  await saveSession(session);
  return session.username;
}

// Rotas de Autenticação Express
export function setupAuthRoutes(app) {
  loadUsersDb();

  app.get('/api/auth/check-username', (req, res) => {
    const username = String(req.query.username || '').trim().toLowerCase();
    if (!username || username.length < 3) return res.json({ available: false, error: 'Mínimo de 3 caracteres' });
    if (!/^[a-z0-9_-]+$/.test(username)) return res.json({ available: false, error: 'Apenas letras, números, _ e -' });
    const exists = usersDb.has(username);
    res.json({ available: !exists });
  });

  app.post('/api/auth/signup', async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const displayName = String(req.body?.displayName || '').trim();

      if (!username || username.length < 3) return res.status(400).json({ success: false, error: 'Usuário inválido (mín. 3 caracteres)' });
      if (!password || password.length < 4) return res.status(400).json({ success: false, error: 'Senha muito curta (mín. 4 caracteres)' });
      if (!/^[a-z0-9_-]+$/.test(username)) return res.status(400).json({ success: false, error: 'Caracteres inválidos no usuário' });

      if (usersDb.has(username)) {
        return res.status(400).json({ success: false, error: 'Este nome de usuário já está em uso' });
      }

      const { hash, salt } = await hashPassword(password);
      const user = {
        username,
        displayName: displayName || username,
        passwordHash: hash,
        salt,
        role: 'user',
        settings: {}
      };

      await saveUser(user);
      const token = await createSession(username);
      res.json({ success: true, token, user: { username, displayName: user.displayName } });
    } catch (e) {
      console.error('Erro no signup:', e);
      res.status(500).json({ success: false, error: 'Erro interno ao criar conta' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (!username || !password) return res.status(400).json({ success: false, error: 'Informe usuário e senha' });

      const user = usersDb.get(username);
      if (!user) return res.status(400).json({ success: false, error: 'Usuário ou senha incorretos' });

      const match = await verifyPassword(password, user.passwordHash, user.salt);
      if (!match) return res.status(400).json({ success: false, error: 'Usuário ou senha incorretos' });

      const token = await createSession(username);
      res.json({ success: true, token, user: { username, displayName: user.displayName } });
    } catch (e) {
      console.error('Erro no login:', e);
      res.status(500).json({ success: false, error: 'Erro interno no login' });
    }
  });

  app.post('/api/auth/google', async (req, res) => {
    try {
      const { email, name, providerId } = req.body;
      if (!email) return res.status(400).json({ success: false, error: 'E-mail do Google não fornecido' });

      const baseName = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '');
      let username = baseName + '_g';
      let user = usersDb.get(username);

      if (!user) {
        user = {
          username,
          displayName: name || baseName,
          passwordHash: 'GOOGLE_AUTH',
          salt: 'GOOGLE_AUTH',
          role: 'user',
          settings: { email, providerId }
        };
        await saveUser(user);
      }

      const token = await createSession(username);
      res.json({ success: true, token, user: { username, displayName: user.displayName } });
    } catch (e) {
      console.error('Erro no login com Google:', e);
      res.status(500).json({ success: false, error: 'Erro interno ao autenticar com Google' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.token || req.query?.token);
    if (token) await removeSession(token);
    res.json({ success: true });
  });

  app.get('/api/auth/me', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query?.token;
    const username = await validateSession(token);
    if (!username) return res.status(401).json({ success: false, error: 'Não autenticado' });

    const user = usersDb.get(username);
    if (!user) return res.status(401).json({ success: false, error: 'Usuário não encontrado' });

    res.json({
      success: true,
      user: {
        username: user.username,
        displayName: user.displayName,
        role: user.role
      }
    });
  });
}

// Alias para compatibilidade com server.js (que importa registerAuthRoutes)
export const registerAuthRoutes = setupAuthRoutes;

// Middleware de autenticação para rotas /api (exceto /api/auth/*, /api/health, /api/config e /api/drive/*)
export function authMiddleware(req, res, next) {
  // Dentro de app.use('/api', ...), req.path NÃO contém o prefixo /api.
  // Usar req.originalUrl (caminho completo) para comparar corretamente.
  const full = String(req.originalUrl || req.url || '').split('?')[0];
  if (full.startsWith('/api/auth/')) return next();
  if (full === '/api/health') return next();
  if (full === '/api/config') return next();
  if (full.startsWith('/api/drive/')) return next();
  const authHeader = req.headers.authorization || '';
  const token =
    authHeader.startsWith('Bearer ') ? authHeader.slice(7) :
    req.query?.token || req.body?.token;
  validateSession(token)
    .then(username => {
      if (!username) return res.status(401).json({ success: false, error: 'Não autenticado' });
      const user = usersDb.get(username);
      if (!user) return res.status(401).json({ success: false, error: 'Usuário não encontrado' });
      req.user = { username: user.username, displayName: user.displayName, role: user.role };
      next();
    })
    .catch(() => res.status(401).json({ success: false, error: 'Erro de autenticação' }));
}

// Atualiza nome de exibição do usuário
export async function updateUserProfile(username, displayName) {
  const user = usersDb.get(username);
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
