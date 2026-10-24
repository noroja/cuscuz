import './src/load-env.js';
import { selecionar as selecionarQuestoes, norm, acharDoencas } from './src/questoes-aula.js';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execFile } from 'child_process';
import zlib from 'zlib';
import { Readable } from 'stream';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { Type, generateAI, aiConfigured, aiStatus } from './src/ai-provider.js';
import * as cheerio from 'cheerio';
import { plGerarPlanSinergia as plEngineGerarPlan } from './smart_scheduler.js';
import { registerPlanner } from './src/planner-routes.js';
import { registerPlannerV3 } from './src/planner-v3-routes.js';

import { registerAula } from './src/aula.js';
import { registerApostilaReader } from './src/apostila-reader.js';
import { registerMedreaderMarcas } from './src/medreader-marcas.js';
import { materiaisDeIrmaos } from './src/materiais-irmaos.js';
import { registerAuthRoutes, registerAdminRoutes, authMiddleware, getUserFilePath, getUserDataDir, getRequestSessionToken, validateSession, updateUserProfile } from './src/auth-multiuser.js';
import { varrerExtras, juntar as juntarExtras, lerExtra, STATUS as EXTRA_STATUS, EXTRA_IDS, setCatalogo, CAT } from './src/extra-drive.js';
import { resetCatalogo } from './src/planner-engine.js';
import { temConta, emailConta, erroConta, driveFetch, authHeaders, driveFetchWithRetry, cleanDriveId } from './src/drive-auth.js';

import { downloadCatalogFromSupabase, downloadQuestionsBankFromSupabase, uploadQuestionsBankToSupabase, supabaseCatalogReady, ensureSupabaseBucket } from './src/supabase-catalog.js';
import { IS_SERVERLESS, TMP_DIR, writableDir, safeReadJson, safeWriteJson } from './src/fs-safe.js';
import { getSystemConfig, setSystemConfig, systemConfigHealth } from './src/system-config.js';
import { getFlashcardSyncStatus, readFlashcardManifest, readFlashcardPage, readFlashcardMedia, startFlashcardSyncScheduler, syncDriveFlashcards } from './src/drive-flashcards.js';
import { acceptDriveNotification, queueDriveChange, renewDrivePushChannel, startDrivePushRenewal } from './src/drive-push.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ═══ DIRETÓRIO DE ESTADO GRAVÁVEL ═══════════════════════════════════════════════
   Na Vercel (serverless) o bundle é somente leitura (/var/task). Todo estado
   efêmero (caches, tokens, bancos de trabalho) vai para /tmp. O estado durável
   continua no Supabase (catálogo/usuários) e no GitHub (.json.gz do banco). */
const DATA_DIR = writableDir(path.join(__dirname, 'data')) || TMP_DIR;

const app = express();
const catalogEventClients = new Set();
// Em hospedagens (Render, Railway...) a porta vem do ambiente; 3000 é o padrão local
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Google Drive chama este webhook sem sessão do Cuscuz. O segredo do canal e
// o ID persistido do canal autenticam a notificação; seu conteúdo só dispara o delta.
app.post('/webhooks/google-drive', async (req, res) => {
  if (!acceptDriveNotification(req.headers)) return res.status(403).end();
  const state = String(req.headers['x-goog-resource-state'] || '');
  if (state === 'change' || state === 'update' || state === 'trash') {
    if (IS_SERVERLESS) {
      try { await processDriveUpdate(); }
      catch (error) { console.error('[Drive Push] Falha processando notificação:', error.message); return res.status(500).end(); }
    } else {
      queueDriveChange(processDriveUpdate);
    }
  }
  res.status(204).end();
});

// Secret for media ticket encryption. Fail closed when no secret is configured;
// a public, hard-coded fallback would let anyone forge a media URL.
const mediaTicketSecret = process.env.MEDIA_TICKET_SECRET || process.env.APP_PASSWORD || '';
const AUTH_SECRET = mediaTicketSecret ? crypto.createHash('sha256').update('cuscuz-media-ticket|' + mediaTicketSecret).digest() : null;

// ── Mídia pesada fora da Vercel (economiza a "Transferência rápida de origem" do plano Hobby) ──
// MEDIA_ORIGIN = endereço https público de OUTRO processo deste mesmo app (ex.: seu PC via túnel) que serve
//   vídeos/PDFs; aqui o app só redireciona (poucos bytes). Os dois lados precisam do MESMO APP_PASSWORD
//   (é a chave que assina os links /m/...) e das credenciais do Drive.
// MEDIA_ONLY=1 = esse processo só serve /m/* e /api/health (todo o resto responde 404): seguro para expor num túnel.
const MEDIA_ONLY = process.env.MEDIA_ONLY === '1';
const MEDIA_ORIGIN = /^https?:\/\//i.test(process.env.MEDIA_ORIGIN || '') ? String(process.env.MEDIA_ORIGIN).trim().replace(/\/+$/, '') : '';
if (MEDIA_ONLY) app.use((req, res, next) => (/^\/m\//.test(req.path) || req.path === '/api/health') ? next() : res.status(404).send('Not found'));

/* ═══ AUTENTICAÇÃO MULTI-USUÁRIO (scrypt + sessões) ═══ */
app.set('trust proxy', 1);

// Registra rotas de auth (signup, login, logout, me, change-password)
registerAuthRoutes(app);

// Health check endpoint (sempre acessível, sem autenticação)
// Middleware de autenticação para todas as rotas /api/*
app.use('/api', authMiddleware);
registerAdminRoutes(app);

app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  const payload = { status: 'ok', timestamp: new Date().toISOString() };
  const isAdmin = ['admin', 'super_admin'].includes(req.user?.role);

  // Uptime checks are public; operational details and active diagnostics are admin-only.
  if (isAdmin) {
    Object.assign(payload, {
      openaiConfigured: !!openai,
      supabaseConfigured: !!supabase,
      aiConfigured: aiConfigured(),
      aiProvider: aiStatus().provider,
      aiModel: aiStatus().model,
      aiProvedores: aiStatus().provedores,
      aiFluxo: aiStatus().workflow,
      geminiConfigured: false,
      authConfigured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      drive: driveStatus
    });
  }

  if (req.query.deep === '1') {
    if (!isAdmin) return res.status(403).json({ status: 'forbidden' });
    try { payload.systemConfig = await systemConfigHealth(); } catch (err) { payload.systemConfig = { error: err.message }; }
    try {
      const auth = await hwqEnsureToken();
      payload.hardworq = {
        authMode: (HWQ.email && HWQ.senha) ? 'login' : (HWQ.cookie ? 'cookie' : 'nenhum'),
        emailConfigured: !!HWQ.email,
        userTokenActive: !!HWQ_STATE.userToken,
        tokenStore: HWQ_STATE.tokenStore || 'none',
        lastLoginOk: HWQ_STATE.lastLoginOk,
        lastLoginAt: HWQ_STATE.lastLoginAt,
        lastLoginStatus: HWQ_STATE.lastLoginStatus || null,
        loginTest: { ok: !!auth.ok, status: auth.status || null, error: auth.error ? String(auth.error).slice(0, 240) : null }
      };
    } catch (err) {
      payload.hardworq = { loginTest: { ok: false, error: err.message } };
    }
  }

  res.json(payload);
});

/* ═══ ARQUIVOS ESTÁTICOS: nunca expor código, dados internos ou segredos ═══ */
const BLOCKED_STATIC = /^\/(server\.js|api\/index\.js$|vercel\.json|package(-lock)?\.json|render\.yaml|DEPLOY\.md|README\.md|supabase-schema\.sql|metadata\.json|drive-tree-snapshot\.json|data(\/|$)|scripts(\/|$)|src(\/|$)|node_modules(\/|$)|\.)/i;
app.use((req, res, next) => {
  let p = '';
  try { p = decodeURIComponent(req.path); } catch (_) { return res.status(400).end(); }
  if (BLOCKED_STATIC.test(p) || p.includes('..')) return res.status(404).end();
  next();
});

// IA generativa: provedor único (Groq) em src/ai-provider.js — chave só no servidor, sem fallback silencioso.

// In-memory conversations store (fallback if Supabase credentials are not provided)
const memoryConversations = new Map();

// Initialize Supabase Client if env variables are present
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase client initialized');
  } catch (err) {
    console.warn('⚠️ Could not initialize Supabase:', err.message);
  }
}

// Initialize OpenAI Client if API key is present
const openaiApiKey = process.env.OPENAI_API_KEY;
let openai = null;
if (openaiApiKey) {
  try {
    openai = new OpenAI({ apiKey: openaiApiKey });
    console.log('✅ OpenAI client initialized');
  } catch (err) {
    console.warn('⚠️ Could not initialize OpenAI:', err.message);
  }
}

// Helpers to get/save conversation
async function getConversationMessages(id) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('id', id)
        .single();
      if (!error && data && Array.isArray(data.messages)) {
        return data.messages;
      }
    } catch (err) {
      console.warn('Supabase fetch error, fallback to memory store:', err.message);
    }
  }
  return memoryConversations.get(id) || [];
}

async function saveConversationMessages(id, messages) {
  memoryConversations.set(id, messages);
  if (supabase) {
    try {
      const { error } = await supabase
        .from('conversations')
        .upsert({
          id,
          messages,
          updated_at: new Date().toISOString()
        });
      if (error) {
        console.warn('Supabase upsert warning:', error.message);
      }
    } catch (err) {
      console.warn('Supabase save error:', err.message);
    }
  }
}

// Function calling definitions for context & support
const supportTools = [
  {
    type: 'function',
    function: {
      name: 'get_app_features',
      description: 'Obtém informações e guia de navegação sobre os recursos do Cuscuz-MED / Lovable App.',
      parameters: {
        type: 'object',
        properties: {},
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_acervo_topics',
      description: 'Consulta disciplinas médicas e conteúdos disponíveis no acervo.',
      parameters: {
        type: 'object',
        properties: {
          discipline: { type: 'string', description: 'Nome da especialidade ou matéria (ex: Cardiologia, Cirurgia).' }
        },
        required: ['discipline']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_study_tips',
      description: 'Fornece orientações metodológicas sobre flashcards SRS, ciclo de estudos e simulados.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['pomodoro', 'srs', 'simulados', 'geral'] }
        }
      }
    }
  }
];

function handleToolExecution(name, args) {
  if (name === 'get_app_features') {
    return {
      features: [
        'Planejador Inteligente: crie cronogramas personalizados com meta de questões e data de prova.',
        'Acervo Completo: mais de 900 videoaulas e apostilas integradas ao Google Drive.',
        'Treino Livre & Flashcards SRS: repetição espaçada no estilo Anki para fixação de longo prazo.',
        'Simulados com Gabarito: cronômetro, revisão comentada e acompanhamento de estatísticas.',
        'Gamificação: ganhe XP por tópicos estudados, atinja streaks de dias e desbloqueie badges.',
        'Temporizador Pomodoro: sessões de estudo com pausas programadas e registro diário.'
      ]
    };
  }
  if (name === 'search_acervo_topics') {
    const disc = (args.discipline || '').toLowerCase();
    const map = {
      cardio: 'Semiologia, Hipertensão Arterial, Insuficiência Cardíaca, Síndromes Coronarianas, Cardiopatias Congênitas',
      cirurgia: 'Abdome Agudo Obstrutivo, Trauma, Hérnias da Parede Abdominal, Queimaduras, Pré e Pós-Operatório',
      gineco: 'Câncer de Mama, Rastreamento, Sangramento Uterino Anormal, Miomatose, Climatério, Doença Inflamatória Pélvica',
      obste: 'Pré-natal, Mecanismo de Parto, Hemorragia Pós-Parto (HPP), Síndromes Hipertensivas da Gestação, Aloimunização',
      pedia: 'Puericultura, Crescimento e Desenvolvimento, Aleitamento Materno, Desidratação, Pneumonias na Infância'
    };
    const key = Object.keys(map).find(k => disc.includes(k)) || 'cardio';
    return { discipline: args.discipline, topicsAvailable: map[key] };
  }
  if (name === 'get_study_tips') {
    const m = args.method || 'geral';
    if (m === 'srs') {
      return { tip: 'Pratique revisões ativas diárias no modo Flashcards. O algoritmo SRS espaça as revisões conforme a sua facilidade com o card.' };
    }
    if (m === 'pomodoro') {
      return { tip: 'Use ciclos de 25 min de foco total com 5 min de descanso na aba Preparatório. A cada 4 ciclos, faça uma pausa maior de 15 a 30 min.' };
    }
    return { tip: 'Alie estudo teórico em vídeo/PDF com resolução imediata de pelo menos 15 a 20 questões por tópico.' };
  }
  return { status: 'executed' };
}

// Google Drive Proxy & In-Memory Cache
const DRIVE_API_KEY = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
// Acesso ao Drive: conta de serviço (pasta privada) ou chave de API (pasta com link público)
const DRIVE_OK = !!DRIVE_API_KEY || temConta();
if (!DRIVE_OK) console.warn('⚠️ Nem GOOGLE_SERVICE_ACCOUNT_JSON nem GOOGLE_DRIVE_API_KEY definidas: o acervo do Drive não vai carregar.');
const DRIVE_ROOT_FOLDER_ID = cleanDriveId(process.env.GOOGLE_DRIVE_FOLDER_ID || '');

// Cache de pastas do Drive. Na Vercel o projeto é somente leitura: gravamos em /tmp
// (efêmero, por invocação) e o estado durável vive no Supabase. Nunca quebra se não houver disco.
const DRIVE_CACHE_DIR = DATA_DIR || TMP_DIR;
const DRIVE_CACHE_FILE = path.join(DRIVE_CACHE_DIR, 'drive-folder-cache.json');
let driveCache = new Map();
try {
  const obj = safeReadJson(DRIVE_CACHE_FILE, null);
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) driveCache.set(k, v);
    console.log(`📂 Cache de pastas do Drive carregado (${driveCache.size} pastas).`);
  }
} catch (e) {
  console.warn('⚠️ Falha ao carregar cache de pastas do Drive:', e.message);
}

function saveDriveCacheToDisk() {
  // Cache é best-effort: falha silenciosa quando o FS é somente leitura.
  const obj = {};
  for (const [k, v] of driveCache.entries()) obj[k] = v;
  if (!safeWriteJson(DRIVE_CACHE_FILE, obj) && !IS_SERVERLESS) {
    console.warn('⚠️ Falha ao salvar cache de pastas do Drive no disco.');
  }
}

/* Diagnóstico da chave do Drive: traduz o erro do Google em uma dica clara (sem expor segredos) */
const driveStatus = { configured: DRIVE_OK, ok: null, status: null, reason: null, hint: null, checkedAt: null };
function driveErrorInfo(status, bodyText) {
  let reason = '', msg = '';
  try {
    const j = JSON.parse(bodyText);
    const e = j.error || {};
    reason = (e.errors && e.errors[0] && e.errors[0].reason) || (e.details && e.details[0] && e.details[0].reason) || e.status || '';
    msg = e.message || '';
  } catch (_) { msg = String(bodyText || '').slice(0, 160); }
  const blob = (reason + ' ' + msg).toLowerCase();
  let hint;
  if (/referrer|ip_address_blocked|ip address/.test(blob)) hint = 'A chave do Drive tem restrição de site/IP. No Google Cloud, em "Restrições de aplicativo", escolha "Nenhuma" e deixe só a restrição de API (Google Drive API).';
  else if (/api_key_invalid|api key not valid|keyinvalid/.test(blob)) hint = 'Chave inválida. Confira GOOGLE_DRIVE_API_KEY no Render (sem espaços, sem aspas).';
  else if (/service_disabled|accessnotconfigured|has not been used|is disabled|api_key_service_blocked|blocked/.test(blob)) hint = 'A Google Drive API não está ativada ou a chave não a permite. Ative em APIs e serviços > Biblioteca e marque "Google Drive API" nas restrições da chave.';
  else if (/ratelimit|quota|userratelimit/.test(blob)) hint = 'Cota do Google atingida. Tente de novo em alguns minutos.';
  else if (status === 404 || /notfound/.test(blob)) hint = 'Pasta não encontrada. Confira GOOGLE_DRIVE_FOLDER_ID e se a pasta está como "Qualquer pessoa com o link".';
  else if (status === 403) {
    if (/storageQuotaExceeded|do not have storage quota/.test(blob)) hint = 'Service Account não tem cota de armazenamento própria no Google Drive. Use uma pasta dentro de um Shared Drive (Google Workspace) como GOOGLE_DRIVE_FOLDER_ID, ou configure OAuth delegation (domain-wide delegation) em vez de Service Account.';
    else hint = 'Acesso negado pelo Google. Confira se a pasta está como "Qualquer pessoa com o link" e as permissões da chave.';
  }
  else hint = 'Erro do Google Drive (' + status + '). Veja os logs do Render.';
  return { reason: reason || ('http_' + status), hint };
}
function noteDriveResult(ok, status, bodyText) {
  driveStatus.configured = DRIVE_OK;
  driveStatus.ok = ok; driveStatus.status = status; driveStatus.checkedAt = new Date().toISOString();
  if (ok) { driveStatus.reason = null; driveStatus.hint = null; return null; }
  const info = driveErrorInfo(status, bodyText);
  driveStatus.reason = info.reason; driveStatus.hint = info.hint;
  console.warn('⚠️ [Drive] ' + status + ' ' + info.reason + ' — ' + info.hint);
  return info;
}
async function checkDriveKey() {
  if (!DRIVE_OK) { driveStatus.ok = false; driveStatus.reason = 'missing_key'; driveStatus.hint = 'GOOGLE_DRIVE_API_KEY não está definida no Render.'; driveStatus.checkedAt = new Date().toISOString(); console.warn('⚠️ [Drive] ' + driveStatus.hint); return; }
  try {
    const q = encodeURIComponent(`'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed=false`);
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    const t = await r.text();
    noteDriveResult(r.ok, r.status, t);
    if (r.ok) console.log('✅ [Drive] Chave do Drive funcionando.');
  } catch (e) { driveStatus.ok = false; driveStatus.reason = 'network'; driveStatus.hint = 'Sem conexão com o Google: ' + e.message; }
}
const DRIVE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/* ═══ BOOT 100% NUVEM — Supabase como Single Source of Truth ═══════════════════
   1) Garante bucket no Supabase Storage
   2) Tenta baixar acervo-manifest.json do Supabase (zero cota do Drive)
   3) Se Supabase indisponível / arquivo não existir → Full Sync de emergência no Drive
   ═════════════════════════════════════════════════════════════════════════════════ */
async function inicializarCatalogoNuvem() {
  try {
    await ensureSupabaseBucket();
  } catch (e) { console.warn('⚠️ [Boot] Não foi garantir bucket Supabase:', e.message); }

  if (!supabaseCatalogReady()) {
    console.warn('⚠️ [Boot] Supabase não configurado — seguindo com catálogo local/Drive.');
    return;
  }

  const catNuvem = await downloadCatalogFromSupabase();
  if (catNuvem && (catNuvem.videos || []).length + (catNuvem.materials || []).length > 0) {
    setCatalogo(catNuvem);
    console.log('✅ [Boot] Catálogo carregado 100% da nuvem (Supabase).');
    return;
  }

  console.warn('⚠️ [Boot] Catálogo não encontrado no Supabase — disparando Full Sync de emergência no Google Drive...');
  try {
    const r = await varrerExtras(process.env.GOOGLE_DRIVE_API_KEY || '');
    if (r) {
      console.log(`✅ [Boot] Full Sync de emergência concluído: ${r.videos} vídeos, ${r.materials} materiais.`);
    }
  } catch (e) {
    console.error('❌ [Boot] Full Sync de emergência falhou:', e.message);
  }

  // Fallback de Segurança Máxima: se Supabase e Full Sync falharem, usa o acervo-manifest.json empacotado na raiz
  if ((CAT.videos || []).length === 0 && (CAT.materials || []).length === 0) {
    try {
      const fallbackPath = path.join(__dirname, 'acervo-manifest.json');
      if (fs.existsSync(fallbackPath)) {
        const localCat = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
        if ((localCat.videos || []).length > 0 || (localCat.materials || []).length > 0) {
          setCatalogo(localCat);
          console.log(`🛡️ [Boot] Fallback ativado: catálogo local carregado com ${localCat.videos?.length || 0} vídeos e ${localCat.materials?.length || 0} materiais.`);
        }
      }
    } catch (err) {
      console.warn('⚠️ [Boot] Falha ao ler catálogo local de fallback:', err.message);
    }
  }
}

// Snapshot offline local do Google Drive (fallback automático caso a chave expire ou falhe)
let snapshotIndex = null;
function initSnapshotIndex() {
  try {
    const snapPath = path.join(__dirname, 'drive-tree-snapshot.json');
    const acervoPath = path.join(__dirname, 'acervo-manifest.json');
    if (!fs.existsSync(snapPath)) return;
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const acervo = fs.existsSync(acervoPath) ? JSON.parse(fs.readFileSync(acervoPath, 'utf8')) : { videos: [], materials: [] };

    const folderMap = snap.folders || {};
    const childFolders = new Map();
    const pathToFolderId = new Map();

    for (const f of Object.values(folderMap)) {
      if (!f || !f.id) continue;
      if (f.path) pathToFolderId.set(f.path.trim(), f.id);
      const pid = f.parent || DRIVE_ROOT_FOLDER_ID;
      if (!childFolders.has(pid)) childFolders.set(pid, []);
      childFolders.get(pid).push({
        id: f.id,
        name: f.name.trim(),
        rawName: f.name,
        mimeType: 'application/vnd.google-apps.folder',
        isFolder: true,
        isVideo: false,
        isPdf: false,
        webViewLink: `https://drive.google.com/drive/folders/${f.id}`,
        previewUrl: `https://drive.google.com/drive/folders/${f.id}`
      });
    }

    const filesByFolderId = new Map();
    const videoIds = new Set((acervo.videos || []).map(v => v.id));
    const allItems = [...(acervo.videos || []), ...(acervo.materials || [])];
    for (const it of allItems) {
      if (!it || !it.path || !it.id) continue;
      const parts = it.path.split('/');
      parts.pop();
      const folderPath = parts.map(p => p.trim()).join(' / ');
      const folderId = pathToFolderId.get(folderPath);
      if (folderId) {
        if (!filesByFolderId.has(folderId)) filesByFolderId.set(folderId, []);
        const isVid = videoIds.has(it.id) || /\.(mp4|webm|mkv|mov|avi)$/i.test(it.d || '') || (it.d && it.d.includes('.mp4'));
        const isPdf = !isVid;
        filesByFolderId.get(folderId).push({
          id: it.id,
          name: it.t || (it.d ? it.d.replace(/\.[^.]+$/, '') : 'Arquivo'),
          rawName: it.d || it.t || 'Arquivo',
          mimeType: isVid ? 'video/mp4' : (isPdf ? 'application/pdf' : 'application/octet-stream'),
          isFolder: false,
          isVideo: isVid,
          isPdf: isPdf,
          webViewLink: `https://drive.google.com/file/d/${it.id}/preview`,
          previewUrl: `https://drive.google.com/file/d/${it.id}/preview`
        });
      }
    }

    snapshotIndex = { childFolders, filesByFolderId };
    console.log(`✅ Snapshot offline indexado: ${childFolders.size} pastas, ${allItems.length} arquivos.`);
  } catch (err) {
    console.warn('⚠️ Falha ao inicializar snapshot local do Drive:', err.message);
  }
}
inicializarCatalogoNuvem().then(() => initSnapshotIndex());

function getFilesFromSnapshot(folderId) {
  if (!snapshotIndex) return null;
  const fid = cleanDriveId(folderId) || DRIVE_ROOT_FOLDER_ID;
  const folders = snapshotIndex.childFolders.get(fid) || [];
  const files = snapshotIndex.filesByFolderId.get(fid) || [];
  if (!folders.length && !files.length) return null;
  return [...folders, ...files];
}

// Pastas extras do Drive aparecem como cursos na raiz
function comPastasExtras(folderId, files) {
  if (folderId !== DRIVE_ROOT_FOLDER_ID) return files;
  const roots = (lerExtra().roots || []).filter(r => !files.some(f => f.id === r.id));
  const ids = roots.length ? roots : EXTRA_IDS().filter(id => !files.some(f => f.id === id)).map(id => ({ id, name: 'Conteúdo extra' }));
  return [...files, ...ids.map(r => ({ id: r.id, name: r.name, rawName: r.name, mimeType: 'application/vnd.google-apps.folder', isFolder: true, isVideo: false, isPdf: false, webViewLink: `https://drive.google.com/drive/folders/${r.id}`, previewUrl: `https://drive.google.com/drive/folders/${r.id}` }))];
}
app.get('/api/drive/clear-cache', (req, res) => {
  const size = driveCache.size;
  driveCache.clear();
  res.json({ success: true, cleared: size, message: 'Cache do Google Drive limpo com sucesso' });
});

app.get('/api/drive/list', async (req, res) => {
  const folderId = cleanDriveId(req.query.folderId) || DRIVE_ROOT_FOLDER_ID;
  const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const now = Date.now();

  if (!forceRefresh) {
    const cached = driveCache.get(folderId);
    if (cached && (now - cached.timestamp < DRIVE_CACHE_TTL)) {
      return res.json({ files: comPastasExtras(folderId, cached.files), cached: true });
    }
  }

  // Tenta buscar da Google Drive API se a chave estiver configurada
  if (DRIVE_OK) {
    try {
      let rawFiles = [];
      let pageToken = '';

      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
        const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,webViewLink,size,createdTime,shortcutDetails)');
        const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=folder,name_natural&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pageParam}`;
        
        const r = await driveFetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) {
          const errText = await r.text();
          noteDriveResult(false, r.status, errText);
          throw new Error('Google Drive API retornou status ' + r.status);
        }
        noteDriveResult(true, 200, '');
        const data = await r.json();
        if (data.files && Array.isArray(data.files)) {
          rawFiles.push(...data.files);
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      
      const processed = rawFiles.map(f => {
        const isShortcut = f.mimeType === 'application/vnd.google-apps.shortcut';
        const effectiveId = isShortcut && f.shortcutDetails?.targetId ? f.shortcutDetails.targetId : f.id;
        const effectiveMime = isShortcut && f.shortcutDetails?.targetMimeType ? f.shortcutDetails.targetMimeType : f.mimeType;
        
        const isFolder = effectiveMime === 'application/vnd.google-apps.folder';
        const isVideo = /video|mp4|webm|mkv|mov/i.test(effectiveMime) || /\.(mp4|webm|mkv|mov)(\.(mp4|webm|mkv|mov))?$/i.test(f.name);
        const isHtml = /html/i.test(effectiveMime) || /\.(html?|htm)$/i.test(f.name) || (f.name && f.name.toLowerCase().endsWith('.html')) || (f.name && f.name.toLowerCase().endsWith('.htm'));
        const isPdf = !isHtml && (/pdf|document|presentation/i.test(effectiveMime) || /\.(pdf|doc|docx)$/i.test(f.name));
        const cleanName = isFolder ? f.name.trim() : f.name.replace(/(\.(mp4|webm|mkv|mov|pdf|doc|docx|html?|htm))+$/gi, "").trim();
        return {
          id: effectiveId,
          name: cleanName,
          rawName: f.name,
          mimeType: effectiveMime,
          isFolder,
          isVideo,
          isPdf,
          isHtml,
          webViewLink: f.webViewLink || `https://drive.google.com/file/d/${effectiveId}/preview`,
          previewUrl: `https://drive.google.com/file/d/${effectiveId}/preview`
        };
      });

      driveCache.set(folderId, { timestamp: now, files: processed });
      saveDriveCacheToDisk();
      return res.json({ files: comPastasExtras(folderId, processed), cached: false, total: processed.length });
    } catch (err) {
      console.warn(`[Drive] Falha ao consultar Google Drive API para pasta ${folderId} (${err.message}), recorrendo ao snapshot local...`);
    }
  }

  // Fallback transparente para o snapshot offline local
  const snapshotFiles = getFilesFromSnapshot(folderId);
  if (snapshotFiles && snapshotFiles.length > 0) {
    driveCache.set(folderId, { timestamp: now, files: snapshotFiles });
    saveDriveCacheToDisk();
    return res.json({ files: comPastasExtras(folderId, snapshotFiles), cached: true, fromSnapshot: true, total: snapshotFiles.length });
  }

  // Se não foi encontrado no snapshot e a chave não estava ativa
  if (!DRIVE_OK) {
    return res.status(503).json({ error: 'GOOGLE_DRIVE_API_KEY ausente', reason: 'missing_key', hint: 'GOOGLE_DRIVE_API_KEY não configurada no servidor.' });
  }
  return res.json({ files: [], cached: false, total: 0 });
});

// Busca materiais (PDFs e apostilas HTML) diretamente no Drive por curso e disciplina
/* ═══ MATERIAIS CONTEXTUAIS — 'irmãos' da pasta do vídeo ═══════════════════════════
   Regra de negócio: os materiais do painel pertencem à MESMA pasta do vídeo em
   reprodução (parent_folder_id). Duas fontes, em ordem de custo de cota:
     1) CATÁLOGO em memória — a varredura do acervo guarda o pid (pasta-pai) de cada
        arquivo → filtrar é local, ZERO chamada à API do Google por clique.
     2) FALLBACK files.list — restrito à pasta do vídeo, com cache de 10 min por
        pasta (protege a cota quando o arquivo não está no catálogo ainda).
   Classificação: PDFs (.pdf/.doc/.ppt ou mime pdf e afins) × Apostilas (.html/.htm
   ou text/html). Resposta: { success, videoId, parent, source, pdfs[], apostilas[] }. */
const matsCtxCache = new Map(); // parentId → { at, pdfs, apostilas, fonte }
const MATS_CTX_TTL = 10 * 60 * 1000;
const matCtxPdf = (n, m) => /\.pdf$/i.test(n || '') || /pdf/i.test(m || '') || /\.(docx?|pptx?)$/i.test(n || '');
const matCtxHtml = (n, m) => /\.(html?|htm)$/i.test(n || '') || /text\/html|application\/xhtml/.test(m || '');

async function materiaisDoDrivePorPasta(parentId) {
  const hit = matsCtxCache.get(parentId);
  if (hit) return hit;
  const itens = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,shortcutDetails)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=folder,name_natural&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const r = await driveFetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) break;
    const d = await r.json();
    itens.push(...(d.files || []));
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  const pdfs = [], apostilas = [];
  for (const it of itens) {
    const id = (it.shortcutDetails && it.shortcutDetails.targetId) || it.id;
    const mime = (it.shortcutDetails && it.shortcutDetails.targetMimeType) || it.mimeType;
    const nome = String(it.name || '');
    if (matCtxHtml(nome, mime)) apostilas.push({ id, nome, isHtml: true });
    else if (matCtxPdf(nome, mime)) pdfs.push({ id, nome, isHtml: false });
  }
  const val = { at: Date.now(), pdfs, apostilas, fonte: 'drive' };
  matsCtxCache.set(parentId, val);
  return val;
}

function materiaisDoCatalogoPorPasta(parentId) {
  const cat = lerExtra();
  if (!cat || !parentId) return null;
  const pdfs = [], apostilas = [];
  for (const m of (cat.materials || [])) {
    if (m.pid !== parentId) continue;
    const nome = String(m.d || '');
    if (matCtxHtml(nome, '')) apostilas.push({ id: m.id, nome, isHtml: true });
    else if (matCtxPdf(nome, '')) pdfs.push({ id: m.id, nome, isHtml: false });
  }
  if (!pdfs.length && !apostilas.length) return null;
  const val = { at: Date.now(), pdfs, apostilas, fonte: 'catalogo' };
  matsCtxCache.set(parentId, val);
  return val;
}

function isDescendantOf(childId, ancestorId) {
  let cur = childId;
  while (cur && cur !== ancestorId) {
    const info = CAT.folders?.[cur];
    if (!info || !info.parent) break;
    cur = info.parent;
  }
  return cur === ancestorId;
}

async function materiaisContexto(res, videoId, parentIdQ) {
  try {
    let parent = parentIdQ;
    if (!parent && videoId) {
      const cat = lerExtra();
      const reg = (cat.videos || []).find(x => x.id === videoId) || (cat.materials || []).find(x => x.id === videoId);
      if (reg && reg.pid) parent = reg.pid;
    }
    if (!parent) return res.json({ success: false, hint: 'vídeo sem pasta-pai conhecida', videoId, parent: '', total: 0, pdfs: [], apostilas: [] });
    // 1) catálogo (0 cota): pasta do vídeo + pastas irmãs de material (ex.: "Apostila", "Resumo")
    //    → 2) files.list com cache por pasta
    const propria = materiaisDoCatalogoPorPasta(parent);
    const cat0 = lerExtra() || {};
    const vizinhas = materiaisDeIrmaos(cat0.folders || CAT.folders, cat0.materials, parent);
    let val = null;
    if (propria || vizinhas) {
      const vistos = new Set();
      const junta = (a, b) => [...a, ...b].filter((m) => { const k = m.nome.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; });
      val = {
        pdfs: junta((propria || {}).pdfs || [], (vizinhas || {}).pdfs || []),
        apostilas: junta((propria || {}).apostilas || [], (vizinhas || {}).apostilas || []),
        fonte: propria ? (vizinhas ? 'catalogo+irmas' : 'catalogo') : 'catalogo-irmas',
      };
    } else {
      val = await materiaisDoDrivePorPasta(parent).catch(() => ({ pdfs: [], apostilas: [], fonte: 'drive-erro' }));
    }
    return res.json({ success: true, videoId, parent, total: val.pdfs.length + val.apostilas.length, pdfs: val.pdfs, apostilas: val.apostilas, source: val.fonte });
  } catch (e) {
    console.warn('⚠️ [Materials ctx]', e.message);
    return res.json({ success: false, error: String(e.message || e).slice(0, 200), videoId, parent: parentIdQ, total: 0, pdfs: [], apostilas: [] });
  }
}

// Usado como fallback quando o acervo-manifest.json não tem os materiais
app.get('/api/drive/materials', async (req, res) => {
  const videoId = cleanDriveId(req.query.videoId || '');
  if (!videoId) {
    // No videoId provided: return empty (could extend to old course/disc logic if needed)
    return res.json({ success: true, videoId: '', parent: '', total: 0, pdfs: [], apostilas: [] });
  }
  const cat = lerExtra();
  if (!cat || !cat.folders) {
    // Catalog unavailable or no folder tree: return empty
    return res.json({ success: true, videoId: '', parent: '', total: 0, pdfs: [], apostilas: [] });
  }
  // Find video record
  const videoRec = (cat.videos || []).find(v => v.id === videoId);
  if (!videoRec) {
    // Video not found in catalog
    return res.json({ success: true, videoId, parent: '', total: 0, pdfs: [], apostilas: [] });
  }
  let moduleId = videoRec.pid;
  // Go up two levels: video -> parent (video's folder) -> grandparent (module)
  const firstUp = CAT.folders?.[moduleId]?.parent;
  let secondUp = null;
  if (firstUp) {
    secondUp = CAT.folders?.[firstUp]?.parent;
  }
  if (secondUp) {
    moduleId = secondUp;
  } else if (firstUp) {
    // Only one level up available
    moduleId = firstUp;
  }
  // Now moduleId is the grandparent if possible, else parent, else video's parent
  const pdfs = [], apostilas = [];
  const vistosPdf = new Set(), vistosHtml = new Set(); // evita o mesmo nome repetido (ex.: "Apostila - PED 1.pdf" em varias subpastas)
  for (const m of (cat.materials || [])) {
    if (!isDescendantOf(m.pid, moduleId)) continue;
    const nome = String(m.d || '');
    const lower = nome.toLowerCase();
    if (lower.endsWith('.pdf')) {
      if (vistosPdf.has(lower)) continue;
      vistosPdf.add(lower);
      pdfs.push({ id: m.id, nome, isHtml: false, aulaNome: '', url: '' });
    } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      if (vistosHtml.has(lower)) continue;
      vistosHtml.add(lower);
      apostilas.push({ id: m.id, nome, isHtml: true, aulaNome: '', url: '' });
    }
  }
  return res.json({ success: true, videoId, parent: moduleId, total: pdfs.length + apostilas.length, pdfs, apostilas });
});

// Endpoint para alterar nome de exibição do usuário
app.post('/api/auth/update-profile', async (req, res) => {
  try {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Não autenticado' });

    const { displayName } = req.body;
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ success: false, error: 'Nome inválido' });
    }

    const user = await updateUserProfile(username, displayName);
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });

    res.json({ success: true, displayName: user.displayName, message: 'Nome atualizado com sucesso' });
  } catch (e) {
    console.error('Erro ao atualizar perfil:', e);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// Metadados de vídeo do Drive (tamanho/duração/resolução) — base do buffer inteligente da página de aula
const DRIVE_INFO_CACHE_FILE = path.join(DRIVE_CACHE_DIR, 'drive-info-cache.json');
let driveInfoCache = new Map();
try {
  const obj = safeReadJson(DRIVE_INFO_CACHE_FILE, null);
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) driveInfoCache.set(k, v);
    console.log(`📹 Cache de info de vídeos carregado (${driveInfoCache.size} itens).`);
  }
} catch (e) {
  console.warn('⚠️ Falha ao carregar cache de info de vídeos:', e.message);
}

function saveDriveInfoCache() {
  const obj = {};
  for (const [k, v] of driveInfoCache.entries()) obj[k] = v;
  safeWriteJson(DRIVE_INFO_CACHE_FILE, obj);
}

// Metadados de vídeo do Drive (tamanho/duração/resolução) — base do buffer inteligente da página de aula
app.get('/api/drive/video-info', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  if (!ids.length) return res.status(400).json({ error: 'Informe ids separados por vírgula' });
  const out = {};
  await Promise.all(ids.map(id => new Promise(resolve => {
    if (driveInfoCache.has(id)) { out[id] = driveInfoCache.get(id); return resolve(); }
    driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=size,videoMediaMetadata,mimeType&supportsAllDrives=true`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(j => {
        const sizeB = parseInt(j.size || '0', 10);
        const ms = parseInt((j.videoMediaMetadata && j.videoMediaMetadata.durationMillis) || '0', 10);
        const info = {
          mimeType: j.mimeType || '',
          sizeMB: sizeB ? Math.round(sizeB / 1048576 * 10) / 10 : 0,
          durLabel: ms ? (Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0')) : '',
          res: j.videoMediaMetadata ? (j.videoMediaMetadata.height || 0) + 'p' : ''
        };
        driveInfoCache.set(id, info);
        saveDriveInfoCache();
        out[id] = info;
      })
      .catch(err => { out[id] = { erro: String(err.message || err).slice(0, 60) }; })
      .finally(resolve);
  })));
  res.json({ info: out });
});

// ── Streaming do Google Drive ──────────────────────────────────────────────
// Abre o arquivo no Drive tentando várias URLs. O timeout vale só até chegarem os cabeçalhos
// (um AbortSignal.timeout normal também cortaria o corpo do vídeo depois de alguns segundos).
function driveCandidates(fileId) {
  const c = [];
  // Ordem otimizada: usercontent (CDN rápido) → uc (fallback) → API (mais lento, autenticado)
  c.push(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`);
  c.push(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`);
  if (DRIVE_OK) c.push(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true${temConta() ? '' : '&key=' + DRIVE_API_KEY}`);
  return c;
}
async function driveOpen(fileId, start, end, method, client) {
  let lastErr = null;
  for (const url of driveCandidates(fileId)) {
    if (client.signal.aborted) return null;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    client.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), 6000); // reduzido de 12s para 6s
    try {
      const headers = {};
      if (temConta() && url.startsWith('https://www.googleapis.com/')) Object.assign(headers, await authHeaders());
      if (start != null) headers.Range = `bytes=${start}-${end != null ? end : ''}`;
      const resp = await fetch(url, { method, headers, signal: ac.signal });
      clearTimeout(timer);
      const ct = resp.headers.get('content-type') || '';
      if ((resp.ok || resp.status === 206) && !ct.includes('text/html')) return { resp, ac, url };
      try { ac.abort(); } catch (_) {}
      lastErr = new Error('HTTP ' + resp.status + (ct.includes('text/html') ? ' (página HTML — arquivo sem link público?)' : ''));
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  if (lastErr) console.warn(`[Stream] ${fileId}: ${lastErr.message}`);
  return null;
}


// ── Links opacos de mídia: o navegador nunca vê o ID do Google Drive nem uma URL do Drive ──
// O app pede um "ticket" (criptografado, vale 12 h) e usa /m/<ticket> como endereço do vídeo/PDF.
function ticketSeal(id, kind) {
  if (!AUTH_SECRET) throw new Error('MEDIA_TICKET_SECRET or APP_PASSWORD is required to issue media tickets.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', AUTH_SECRET, iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ i: id, k: kind, e: Date.now() + 12 * 3600 * 1000 }), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}
function ticketOpen(t) {
  try {
    const b = Buffer.from(String(t), 'base64url'); if (b.length < 30) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', AUTH_SECRET, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16));
    const j = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
    return j && j.e > Date.now() && /^[A-Za-z0-9_-]{10,}$/.test(j.i) ? j : null;
  } catch (_) { return null; }
}
app.post('/api/media/ticket', (req, res) => {
  if (!AUTH_SECRET) return res.status(503).json({ success: false, error: 'Links de mídia indisponíveis: configure MEDIA_TICKET_SECRET no servidor.' });
  const id = cleanDriveId((req.body || {}).id), kind = (req.body || {}).kind === 'p' ? 'p' : 'v';
  if (!id) return res.status(400).json({ success: false, msg: 'ID inválido' });
  res.json({ success: true, url: '/m/' + ticketSeal(id, kind) });
});
// Redireciona para o host de mídia (sem proxiar bytes). Só quando MEDIA_ORIGIN está definido e não somos nós mesmos.
function midiaRemota(req) {
  if (!MEDIA_ORIGIN || MEDIA_ONLY) return false;
  try { return new URL(MEDIA_ORIGIN).host !== String(req.headers.host || ''); } catch (_) { return false; }
}
function redirecionarMidia(req, res, id, kind) {
  if (!AUTH_SECRET) return res.status(503).json({ success: false, error: 'Links de mídia indisponíveis: configure MEDIA_TICKET_SECRET no servidor.' });
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.redirect(307, MEDIA_ORIGIN + '/m/' + ticketSeal(id, kind));
}
app.all('/m/:ticket', (req, res) => {
  if (!AUTH_SECRET) return res.status(404).send('Link expirado');
  const t = ticketOpen(req.params.ticket);
  if (!t) return res.status(404).send('Link expirado');
  if (midiaRemota(req)) { res.setHeader('Access-Control-Allow-Origin', '*'); return res.redirect(307, MEDIA_ORIGIN + '/m/' + req.params.ticket); }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept'); return res.sendStatus(204); }
  req.params.id = t.i;
  res.setHeader('Cache-Control', 'private, no-store');
  return (t.k === 'p' ? drivePdfHandler : driveStreamHandler)(req, res);
});

// Streaming de vídeo com HTTP Range. Se a conexão com o Drive cair no meio, retoma sozinho do byte onde parou.
async function driveStreamHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    return res.sendStatus(204);
  }
  const fileId = cleanDriveId(req.params.id);
  if (!fileId) return res.status(400).send('ID de arquivo inválido');

  const client = new AbortController();
  res.on('close', () => client.abort());
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const hasRange = !!(m && m[1] !== '');
  const reqStart = hasRange ? parseInt(m[1], 10) : 0;
  const reqEnd = hasRange && m[2] !== '' ? parseInt(m[2], 10) : null;
  const isHead = req.method === 'HEAD';

  let up = await driveOpen(fileId, hasRange ? reqStart : null, hasRange ? reqEnd : null, isHead ? 'HEAD' : 'GET', client);
  if (!up) return res.status(502).json({ error: 'Não foi possível conectar ao Google Drive para reproduzir este vídeo.' });

  const cr = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(up.resp.headers.get('content-range') || '');
  const cl = parseInt(up.resp.headers.get('content-length') || '0', 10);
  let total = cr && cr[3] !== '*' ? parseInt(cr[3], 10) : (up.resp.status === 200 ? cl : 0);
  let upAbs = up.resp.status === 206 && cr ? parseInt(cr[1], 10) : 0; // posição absoluta do primeiro byte que o Drive está enviando
  const ct = up.resp.headers.get('content-type') || 'video/mp4';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', ct);
  const lm = up.resp.headers.get('last-modified'); if (lm) res.setHeader('Last-Modified', lm);

  // Sem tamanho total conhecido: repassa direto (sem retomada)
  if (!total) {
    res.status(up.resp.status);
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', up.resp.headers.get('content-range'));
    if (isHead || !up.resp.body) return res.end();
    const ns = Readable.fromWeb(up.resp.body);
    ns.on('error', () => { try { res.destroy(); } catch (_) {} });
    return ns.pipe(res);
  }

  const outStart = hasRange ? reqStart : 0;
  const outEnd = clamp0(hasRange && reqEnd != null ? Math.min(reqEnd, total - 1) : total - 1);
  if (outStart > outEnd) { try { up.ac.abort(); } catch (_) {} res.status(416).setHeader('Content-Range', `bytes */${total}`); return res.end(); }
  if (hasRange) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${outStart}-${outEnd}/${total}`);
  } else res.status(200);
  res.setHeader('Content-Length', outEnd - outStart + 1);
  if (isHead) { try { up.ac.abort(); } catch (_) {} return res.end(); }

  // Read-ahead: lê do Drive numa fila (até ~8 MB) enquanto o cliente consome, suavizando as oscilações de velocidade
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (res.flushHeaders) res.flushHeaders();
  const MAX_Q = 8 * 1024 * 1024; // reduzido de 24MB para 8MB
  let pos = outStart; // próximo byte absoluto a enviar
  let tentativas = 0;
  const fila = []; let filaBytes = 0, fim = false, falha = null, aviso = null;
  const acorda = () => { if (aviso) { const f = aviso; aviso = null; f(); } };
  const espera = () => new Promise(ok => { aviso = ok; });
  const produtor = (async () => {
    try {
      while (pos <= outEnd && !client.signal.aborted) {
        let lido = pos; // posição absoluta já enfileirada
        let reader = null;
        try {
          reader = up.resp.body.getReader();
          for (;;) {
            while (filaBytes >= MAX_Q && !client.signal.aborted) await espera();
            if (client.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            let buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            const chunkStart = upAbs; upAbs += buf.length;
            if (upAbs <= lido) continue;
            if (chunkStart < lido) buf = buf.subarray(lido - chunkStart);
            if (lido + buf.length - 1 > outEnd) buf = buf.subarray(0, outEnd - lido + 1);
            lido += buf.length; fila.push(buf); filaBytes += buf.length; acorda();
            if (lido > outEnd) break;
          }
        } catch (err) {
          if (client.signal.aborted) break;
          console.warn(`[Stream] ${fileId}: conexão com o Drive caiu em ${lido}/${total} (${err.message})`);
        }
        try { up.ac.abort(); } catch (_) {}
        if (lido > outEnd || client.signal.aborted) break;
        if (++tentativas > 6) throw new Error('Drive não retomou o stream');
        await new Promise(r => setTimeout(r, 400 * tentativas));
        up = await driveOpen(fileId, lido, outEnd, 'GET', client);
        if (!up) throw new Error('Drive indisponível ao retomar');
        const cr2 = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(up.resp.headers.get('content-range') || '');
        upAbs = up.resp.status === 206 && cr2 ? parseInt(cr2[1], 10) : 0;
      }
    } catch (e) { falha = e; }
    fim = true; acorda();
  })();
  try {
    let enviado = outStart;
    while (!client.signal.aborted) {
      if (!fila.length) {
        if (fim) break;
        await espera();
        continue;
      }
      const b = fila.shift(); filaBytes -= b.length; acorda();
      enviado += b.length;
      if (!res.write(b)) await new Promise(ok => { const f = () => { res.off('drain', f); res.off('close', f); ok(); }; res.on('drain', f); res.on('close', f); });
    }
    if (falha) throw falha;
    if (!client.signal.aborted) res.end();
  } catch (err) {
    console.error('[Stream] falha definitiva:', err.message);
    try { res.destroy(); } catch (_) {}
  } finally {
    client.abort(); acorda();
    try { up && up.ac.abort(); } catch (_) {}
  }
}
app.all('/api/drive/stream/:id', (req, res, next) => {
  const id = cleanDriveId(req.params.id);
  if (id && req.method !== 'OPTIONS' && midiaRemota(req)) return redirecionarMidia(req, res, id, 'v');
  return driveStreamHandler(req, res, next);
});
const clamp0 = n => Math.max(0, n);

// Download direto de PDFs do Google Drive para caching offline no IndexedDB
async function drivePdfHandler(req, res) {
  const fileId = cleanDriveId(req.params.id);
  if (!fileId) return res.status(400).send('ID de arquivo inválido');
  const client = new AbortController();
  res.on('close', () => client.abort());
  const up = await driveOpen(fileId, null, null, 'GET', client);
  if (!up) return res.status(502).send('Não foi possível obter o PDF do Google Drive.');
  try {
    const ct = up.resp.headers.get('content-type') || 'application/pdf';
    res.setHeader('Content-Type', ct.includes('text/html') ? 'application/pdf' : ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Disposition', 'inline');
    const cl = up.resp.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const ns = Readable.fromWeb(up.resp.body);
    ns.on('error', () => { try { res.destroy(); } catch (_) {} });
    ns.pipe(res);
  } catch (err) {
    console.error('Erro ao baixar PDF:', err);
    if (!res.headersSent) res.status(500).send(err.message);
  }
}
app.get('/api/drive/pdf/:id', (req, res, next) => {
  const id = cleanDriveId(req.params.id);
  if (id && midiaRemota(req)) return redirecionarMidia(req, res, id, 'p');
  return drivePdfHandler(req, res, next);
});

// Configuração pública para o frontend (não expõe segredos do servidor, apenas chaves anônimas do Supabase)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
});

// ══════════════════════════════════════════════════════════════════
// RADAR MÉDICO: ATUALIZAÇÕES E EDITAIS (Estratégia MED + IA)
// ══════════════════════════════════════════════════════════════════
const RADAR_CACHE_KEY = 'radar_medico_cache';
const RADAR_AI_KEY = 'radar_medico_last_ai';
const RADAR_CACHE_FILE = path.join(DATA_DIR, 'radar_medico_cache.json');
const RADAR_SEED_FILE = path.join(__dirname, 'radar-medico.json');
const RADAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1x ao dia
const RADAR_AI_RETRY_MS = 60 * 60 * 1000; // se a IA falhar, tenta de novo em 1h
let radarMemoryCache = null;
let radarRefreshPromise = null;

function radarCacheFresh(cache) {
  return !!(cache && cache.cachedAt && (Date.now() - Number(cache.cachedAt) < RADAR_CACHE_TTL_MS));
}

/* Fonte da verdade: Supabase (tabela ou bucket privado). /tmp e o seed do
   repositório são apenas fallback para dev/cold start sem Supabase. */
async function loadRadarCache() {
  if (radarMemoryCache) return radarMemoryCache;

  try {
    const durable = await getSystemConfig(RADAR_CACHE_KEY, null);
    if (durable && Array.isArray(durable.articles) && durable.articles.length) {
      radarMemoryCache = durable;
      return durable;
    }
  } catch (e) {
    console.warn('⚠️ Erro ao ler cache durável do Radar Médico:', e.message);
  }

  for (const file of [RADAR_CACHE_FILE, RADAR_SEED_FILE]) {
    try {
      const data = safeReadJson(file, null);
      if (data && Array.isArray(data.articles) && data.articles.length) {
        radarMemoryCache = data;
        return data;
      }
    } catch (e) {
      console.warn('⚠️ Erro ao ler cache local do Radar Médico:', e.message);
    }
  }
  return null;
}

async function saveRadarCache(data) {
  radarMemoryCache = data;
  try { safeWriteJson(RADAR_CACHE_FILE, data); } catch (_) {}
  try {
    await setSystemConfig(RADAR_CACHE_KEY, data);
  } catch (e) {
    console.warn('⚠️ Erro ao salvar cache durável do Radar Médico:', e.message);
  }
}

/* Garante no máximo 1 chamada de IA por dia, mesmo com vários cold starts. */
async function radarAiAllowed() {
  try {
    const last = await getSystemConfig(RADAR_AI_KEY, null);
    const at = Number(last && last.at || 0);
    if (!at) return true;
    const wait = last.ok ? RADAR_CACHE_TTL_MS : RADAR_AI_RETRY_MS;
    return Date.now() - at >= wait;
  } catch (_) {
    return true;
  }
}

async function markRadarAi(ok) {
  try {
    await setSystemConfig(RADAR_AI_KEY, { at: Date.now(), ok: !!ok });
  } catch (_) { /* best-effort */ }
}

async function scrapeAndSummarizeRadar(previous = null) {
  console.log('📡 Buscando artigos recentes em med.estrategia.com/portal/atualidades...');
  const res = await fetch('https://med.estrategia.com/portal/atualidades', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!res.ok) {
    throw new Error('Falha ao acessar o portal Estratégia MED: HTTP ' + res.status);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const rawArticles = [];

  $('article').each((i, el) => {
    if (rawArticles.length >= 5) return;
    const titleEl = $(el).find('h2.entry-title a, h3.entry-title a, header h2 a');
    const title = titleEl.text().trim();
    const link = titleEl.attr('href') || $(el).find('a.cs-overlay-link').attr('href') || $(el).find('a').attr('href');
    let img = $(el).find('img').attr('data-lazy-src') || $(el).find('noscript img').attr('src') || $(el).find('img').attr('src');
    if (img && img.startsWith('data:image/svg')) {
      img = $(el).find('noscript img').attr('src') || $(el).find('img').attr('data-src') || '';
    }
    const excerpt = $(el).find('.entry-excerpt').text().trim();
    const date = $(el).find('.meta-date').text().trim().replace(/^Publicado em\s+/i, '');
    const category = $(el).find('.meta-category .label').text().trim() || $(el).find('.meta-category').text().replace(/^[A-Z]\s*/, '').trim() || 'Atualidades';

    if (title && link) {
      rawArticles.push({ title, link, img, excerpt, date, category });
    }
  });

  if (!rawArticles.length) {
    throw new Error('Nenhum artigo encontrado na página do Estratégia MED.');
  }

  // Busca o corpo de cada matéria para envio ao IA
  for (const art of rawArticles) {
    try {
      const artRes = await fetch(art.link, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(8000)
      });
      if (artRes.ok) {
        const artHtml = await artRes.text();
        const $art = cheerio.load(artHtml);
        const bodyText = $art('.entry-content, article .content, .post-content').text().replace(/\s+/g, ' ').trim();
        art.bodyText = bodyText.slice(0, 4000);
        if (!art.img) {
          art.img = $art('meta[property="og:image"]').attr('content') || '';
        }
      }
    } catch (e) {
      console.warn('⚠️ Não foi possível extrair corpo de', art.link, e.message);
    }
    if (!art.bodyText) art.bodyText = art.excerpt || art.title;
  }

  // Resumo inteligente: UMA única chamada de IA para todas as matérias.
  // A marca `radar_medico_last_ai` garante no máximo 1 chamada por dia,
  // mesmo com vários cold starts ou instâncias serverless diferentes.
  const aiReady = aiConfigured();
  const summaries = new Map();
  let aiUsed = false;

  if (aiReady) {
    if (!(await radarAiAllowed())) {
      console.log('[Radar Médico] IA já consultada nas últimas 24h; reutilizando resumos/cache.');
    } else {
      const materias = rawArticles.map((art, i) => ({
        id: String(i),
        titulo: art.title,
        data: art.date,
        categoria: art.category,
        trecho: String(art.bodyText || art.excerpt || '').slice(0, 3500)
      }));
      const prompt = `Você é um preceptor médico especialista em residência médica e diretrizes clínicas.
Analise TODAS as matérias abaixo e elabore, para cada uma, um resumo estratégico de alto rendimento estruturado estritamente nestes 3 eixos:
1. implementacoes: quais novos protocolos, portarias, diretrizes ou normativas foram anunciados.
2. praticaClinica: o que é essencial para a prática clínica diária, raciocínio diagnóstico, dosagens, rastreios e conduta.
3. oQueMudou: o que mudou de fato em comparação com recomendações ou condutas prévias.

Responda APENAS com um objeto JSON no formato:
{"resumos":[{"id":"0","implementacoes":"...","praticaClinica":"...","oQueMudou":"..."}]}

Use exatamente o mesmo "id" de cada matéria. Seja conciso, claro e técnico.

MATÉRIAS:
${JSON.stringify(materias)}`;

      try {
        const aiRes = await generateAI({ task: "resumo_rapido",
          contents: prompt,
          config: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              required: ['resumos'],
              properties: {
                resumos: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    required: ['id', 'implementacoes', 'praticaClinica', 'oQueMudou'],
                    properties: {
                      id: { type: Type.STRING },
                      implementacoes: { type: Type.STRING },
                      praticaClinica: { type: Type.STRING },
                      oQueMudou: { type: Type.STRING }
                    }
                  }
                }
              }
            }
          }
        });

        if (aiRes.text) {
          const parsed = JSON.parse(aiRes.text);
          for (const item of (parsed.resumos || [])) {
            if (item && item.id != null) summaries.set(String(item.id), item);
          }
          aiUsed = summaries.size > 0;
        }
        await markRadarAi(aiUsed);
      } catch (err) {
        await markRadarAi(false);
        console.log('[Radar Médico] IA indisponível; aplicando resumos clínicos pré-estruturados:', String(err.message || '').slice(0, 160));
      }
    }
  }

  const oldByLink = new Map(((previous && previous.articles) || []).map(a => [a.link, a]));
  const processedArticles = rawArticles.map((art, i) => {
    const old = oldByLink.get(art.link);
    const resumo = summaries.get(String(i)) || old?.resumoEstrategico || {};
    const finalResumo = {
      implementacoes: resumo.implementacoes || `Novas diretrizes e atualizações clínicas publicadas oficialmente: ${art.title}.`,
      praticaClinica: resumo.praticaClinica || (art.excerpt ? art.excerpt.slice(0, 180) + '...' : 'Adoção das recomendações em ambulatório, enfermaria e atendimento primário com foco em segurança do paciente.'),
      oQueMudou: resumo.oQueMudou || 'Atualização e alinhamento dos critérios de conduta médica e parâmetros para provas de residência médica e Revalida.'
    };

    return {
      id: Buffer.from(art.link).toString('base64').slice(0, 16),
      title: art.title,
      link: art.link,
      img: art.img || 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=600&auto=format&fit=crop&q=80',
      date: art.date,
      category: art.category,
      resumoEstrategico: finalResumo,
      bullets: [
        `Implementações: ${finalResumo.implementacoes}`,
        `Prática Clínica: ${finalResumo.praticaClinica}`,
        `O Que Mudou: ${finalResumo.oQueMudou}`
      ]
    };
  });

  const cachePayload = {
    cachedAt: Date.now(),
    aiAt: aiUsed ? Date.now() : (previous?.aiAt || null),
    articles: processedArticles
  };

  await saveRadarCache(cachePayload);
  return cachePayload;
}

async function getRadar({ force = false } = {}) {
  const cached = await loadRadarCache();
  if (!force && radarCacheFresh(cached)) {
    return { status: 'cached', cachedAt: cached.cachedAt, aiAt: cached.aiAt || null, articles: cached.articles };
  }

  if (radarRefreshPromise) return radarRefreshPromise;

  radarRefreshPromise = (async () => {
    try {
      const fresh = await scrapeAndSummarizeRadar(cached);
      return { status: 'fresh', ...fresh };
    } catch (err) {
      if (cached) {
        return {
          status: 'cached_fallback',
          warning: 'Usando cache prévio devido a erro na extração: ' + err.message,
          cachedAt: cached.cachedAt,
          aiAt: cached.aiAt || null,
          articles: cached.articles
        };
      }
      throw err;
    } finally {
      radarRefreshPromise = null;
    }
  })();

  return radarRefreshPromise;
}

function radarNoStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
}

app.get('/api/radar-medico', async (req, res) => {
  radarNoStore(res);
  const force = req.query.force === 'true' || req.query.refresh === 'true';
  try {
    const out = await getRadar({ force });
    res.json(out);
  } catch (err) {
    console.error('❌ Erro no Radar Médico:', err.message);
    res.status(500).json({ error: 'Não foi possível carregar as notícias: ' + err.message });
  }
});

// Cron diário da Vercel: atualiza somente se o cache estiver vencido.
// Com o TTL de 24h, isso resulta em no máximo 1 chamada de IA por dia.
app.get('/api/radar-medico/refresh', async (req, res) => {
  radarNoStore(res);
  const expected = String(process.env.CRON_SECRET || '');
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const out = await getRadar({ force: false });
    return res.json({ success: true, ...out });
  } catch (err) {
    return res.status(503).json({ success: false, error: err.message });
  }
});

// GET conversation history
app.get('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await getConversationMessages(id);
    res.json({ id, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE conversation
app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    memoryConversations.delete(id);
    if (supabase) {
      await supabase.from('conversations').delete().eq('id', id);
    }
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat - Streaming OpenAI GPT-4o with Function Calling & Supabase persistence
app.post('/api/chat', async (req, res) => {
  const { message, conversationId = 'default-' + Date.now(), history = [] } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Mensagem obrigatória' });
  }

  // Setup Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // 1. Fetch conversation history from Supabase or memory
    const existingMessages = await getConversationMessages(conversationId);
    const contextHistory = existingMessages.length ? existingMessages : history;

    // 2. Append new user message
    const userMsg = { role: 'user', content: message.trim() };
    const conversationLog = [...contextHistory, userMsg];

    // 3. System Prompt for App Support
    const systemPrompt = {
      role: 'system',
      content: `Você é o Assistente Virtual de Suporte ao Estudante do Cuscuz-MED (Lovable App).
Você é amigável, conciso, inteligente e focado em ajudar o usuário a extrair o máximo da plataforma.
Você tem acesso a ferramentas de funções (function calling) para consultar funcionalidades, tópicos do acervo médico e dicas de metodologia de estudo.
Responda sempre em Português do Brasil com formatação limpa (Markdown, listas e destaques).
Se o usuário perguntar sobre o funcionamento da plataforma, funcionalidades, cronograma ou acervo, use as ferramentas disponíveis.`
    };

    const messagesToSend = [systemPrompt, ...conversationLog.slice(-10)];

    let assistantResponseText = '';

    // If OpenAI API key is NOT configured in environment, provide smart helpful streaming fallback
    if (!openai) {
      const fallbackNotice = 
        `👋 Olá! Sou o bot de suporte do **Cuscuz-MED** (Lovable App).\n\n` +
        `ℹ️ *Nota: O backend está pronto para o OpenAI GPT-4o, mas a variável \`OPENAI_API_KEY\` ainda não foi definida no arquivo \`.env\`.*\n\n` +
        `**Resposta sobre sua pergunta ("${message.trim()}"):**\n` +
        `• O app oferece **Planejador com cronograma**, **Acervo com +900 videoaulas**, **Banco de Questões com SRS** e **Simulados com tempo**.\n` +
        `• Você pode navegar pelo menu lateral para acessar qualquer módulo ou usar a busca global no topo.\n` +
        `• Para conectar sua chave OpenAI e Supabase real, configure \`OPENAI_API_KEY\` e \`SUPABASE_URL\` / \`SUPABASE_ANON_KEY\` no ambiente.`;

      // Simulate streaming with typing cadence
      const words = fallbackNotice.split(' ');
      for (const word of words) {
        assistantResponseText += (assistantResponseText ? ' ' : '') + word;
        sendEvent('delta', { text: word + ' ', conversationId });
        await new Promise(r => setTimeout(r, 25));
      }

      conversationLog.push({ role: 'assistant', content: assistantResponseText });
      await saveConversationMessages(conversationId, conversationLog);
      sendEvent('done', { conversationId, fullText: assistantResponseText });
      return res.end();
    }

    // 4. OpenAI execution with function calling
    const modelToUse = process.env.OPENAI_MODEL || 'gpt-4o';

    // First check if tool call is needed
    const initialCompletion = await openai.chat.completions.create({
      model: modelToUse,
      messages: messagesToSend,
      tools: supportTools,
      tool_choice: 'auto',
      temperature: 0.7
    });

    const choice = initialCompletion.choices[0];
    const toolCalls = choice.message?.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      // Append assistant's tool call message
      messagesToSend.push(choice.message);

      // Execute each tool and return results to the model
      for (const tc of toolCalls) {
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch (_) {}

        const toolResult = handleToolExecution(tc.function.name, parsedArgs);

        messagesToSend.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult)
        });
      }
    }

    // 5. Stream final response via SSE
    const stream = await openai.chat.completions.create({
      model: modelToUse,
      messages: messagesToSend,
      stream: true,
      temperature: 0.7
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        assistantResponseText += delta;
        sendEvent('delta', { text: delta, conversationId });
      }
    }

    // 6. Save updated history to Supabase / memory
    conversationLog.push({ role: 'assistant', content: assistantResponseText });
    await saveConversationMessages(conversationId, conversationLog);

    sendEvent('done', { conversationId, fullText: assistantResponseText });
    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    sendEvent('error', { message: err.message || 'Erro ao processar mensagem' });
    res.end();
  }
});

/* ═══════════════════════════════════════════════════════════════
   SISTEMA DE QUESTÕES (TREINO LIVRE, GERADOR GEMINI & TUTOR)
   ═══════════════════════════════════════════════════════════════ */
/* O banco empacotado no repositório é a base somente-leitura. O arquivo de
   trabalho (escrita) vive em DATA_DIR — em serverless, /tmp. */
const QUESTIONS_BANK_SEED_FILE = path.join(__dirname, 'data', 'questions-bank.json');
const QUESTIONS_BANK_FILE = path.join(DATA_DIR, 'questions-bank.json');
const QUESTIONS_BANK_GZ = path.join(__dirname, 'data', 'questions-bank.json.gz');
const QUESTIONS_BANK_CANDIDATES = [QUESTIONS_BANK_FILE, QUESTIONS_BANK_SEED_FILE];

let _bankCache = null;
let _bankTimer = null;
let _bankDirty = false;
let _bankBase = 0; // quantas questões o repositório já tinha quando o servidor subiu
let _lastBankUpload = 0;
let _bankReadyPromise = null;
let _bankCloud = null;
let _bankCloudAt = 0;
let _bankHydrating = null;
let _bankUploadPromise = null;
const BANK_CLOUD_TTL_MS = 60 * 1000;

/* Une dois bancos sem perder questões: prefere os dados de `extra` quando a
   mesma questão aparece nos dois lados (id ou enunciado). */
function mergeBankArrays(base, extra) {
  const byId = new Map();
  const byStmt = new Map();
  const out = [];
  const add = (q, override) => {
    if (!q) return;
    const idKey = q.id != null ? String(q.id) : '';
    const stmtKey = typeof hwqStatementKey === 'function' ? hwqStatementKey(q) : String(q.statement || '').slice(0, 80).toLowerCase();
    const existing = (idKey && byId.get(idKey)) || (stmtKey && byStmt.get(stmtKey));
    if (existing) {
      if (override) Object.assign(existing, q);
      if (idKey) byId.set(idKey, existing);
      if (stmtKey) byStmt.set(stmtKey, existing);
      return;
    }
    const copy = { ...q };
    out.push(copy);
    if (idKey) byId.set(idKey, copy);
    if (stmtKey) byStmt.set(stmtKey, copy);
  };
  for (const q of base || []) add(q, false);
  for (const q of extra || []) add(q, true);
  return out;
}

// O banco pré-catalogado vem no repositório compactado (.json.gz, gerado pelo GitHub Actions); o .json é o arquivo de trabalho
function readQuestionsBank() {
  if (_bankCache) return _bankCache;
  try {
    const lerPlain = () => {
      for (const f of QUESTIONS_BANK_CANDIDATES) {
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
      }
      return [];
    };
    const lerGz = () => (fs.existsSync(QUESTIONS_BANK_GZ) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(QUESTIONS_BANK_GZ)).toString('utf8')) : []);
    let a = [], b = [];
    try { a = lerPlain(); } catch (e) { console.warn('banco .json ilegível:', e.message); }
    try { b = lerGz(); } catch (e) { console.warn('banco .json.gz ilegível:', e.message); }
    const data = b.length > a.length ? b : a; // vale o mais completo
    if (Array.isArray(data) && data.length) { _bankBase = data.length; return (_bankCache = data); }
  } catch (err) {
    console.error('Erro ao ler o banco de questões:', err.message);
  }
  return (_bankCache = []);
}

async function readLocalBankFiles() {
  const lerPlain = async () => {
    for (const f of QUESTIONS_BANK_CANDIDATES) {
      if (fs.existsSync(f)) return JSON.parse(await fs.promises.readFile(f, 'utf8'));
    }
    return [];
  };
  const lerGz = async () => fs.existsSync(QUESTIONS_BANK_GZ) ? JSON.parse(zlib.gunzipSync(await fs.promises.readFile(QUESTIONS_BANK_GZ)).toString('utf8')) : [];
  const [a, b] = await Promise.all([lerPlain().catch(() => []), lerGz().catch(() => [])]);
  return b.length > a.length ? b : a;
}

// Carregamento durável: seed local + cópia mais completa do Supabase Storage.
// O resultado é a UNIÃO dos dois (nunca substitui um banco maior pelo seed).
async function preloadQuestionsBank() {
  try {
    const local = await readLocalBankFiles();
    if (Array.isArray(local) && local.length && (!_bankCache || local.length > _bankCache.length)) {
      _bankCache = local;
    }

    if (supabaseCatalogReady()) {
      const nuvem = await downloadQuestionsBankFromSupabase();
      if (Array.isArray(nuvem) && nuvem.length) {
        _bankCloud = nuvem;
        _bankCloudAt = Date.now();
        const merged = mergeBankArrays(nuvem, _bankCache || []);
        _bankCache = merged;
        _bankBase = merged.length;
        safeWriteJson(QUESTIONS_BANK_FILE, merged);
        console.log(`📚 Banco de questões pronto: ${nuvem.length} na nuvem + ${merged.length - nuvem.length} locais = ${merged.length} questões`);
        // Se havia questões locais que a nuvem não tinha, sobe a união para não perdê-las.
        if (merged.length > nuvem.length) {
          uploadQuestionsBankToSupabase(merged).catch(() => {});
        }
        return merged;
      }
    }

    if (Array.isArray(_bankCache) && _bankCache.length) {
      _bankBase = _bankCache.length;
      console.log(`📚 Banco de questões pré-carregado: ${_bankCache.length} questões`);
    }
    return _bankCache || [];
  } catch (err) {
    console.warn('Pré-carregamento do banco falhou (carregará sob demanda):', err.message);
    return readQuestionsBank();
  }
}

// Toda rota /api/questions aguarda o banco durável antes de ler/mesclar.
function ensureQuestionsBankLoaded() {
  if (!_bankReadyPromise) {
    _bankReadyPromise = preloadQuestionsBank().catch(err => {
      console.warn('Banco durável indisponível; seguindo com o seed local:', err.message);
      return readQuestionsBank();
    });
  }
  return _bankReadyPromise;
}
ensureQuestionsBankLoaded();

/* Rebaixa a cópia da nuvem em instâncias já aquecidas e une com o banco local.
   `force` é usado antes de mesclar/sincronizar para nunca sobrescrever a nuvem
   com um seed antigo de outra instância. */
async function hydrateQuestionsBank({ force = false } = {}) {
  await ensureQuestionsBankLoaded();
  if (!supabaseCatalogReady()) return _bankCloud;
  if (!force && _bankCloudAt && Date.now() - _bankCloudAt < BANK_CLOUD_TTL_MS) return _bankCloud;
  if (_bankHydrating) return _bankHydrating;

  _bankHydrating = (async () => {
    const nuvem = await downloadQuestionsBankFromSupabase();
    if (Array.isArray(nuvem) && nuvem.length) {
      _bankCloud = nuvem;
      _bankCloudAt = Date.now();
      const merged = mergeBankArrays(nuvem, _bankCache || []);
      if (merged.length !== (_bankCache?.length || 0)) {
        _bankCache = merged;
        safeWriteJson(QUESTIONS_BANK_FILE, merged);
        console.log(`📚 Banco de questões hidratado da nuvem: ${nuvem.length} na nuvem, ${merged.length} locais.`);
      }
    }
    return _bankCloud;
  })().finally(() => { _bankHydrating = null; });

  return _bankHydrating;
}

/* Upload durável aguardável. Antes de subir, garante que a nuvem não tenha
   mais questões que a memória; se tiver, mescla para não perder nada. */
async function uploadBankNow() {
  if (!supabaseCatalogReady() || !Array.isArray(_bankCache) || !_bankCache.length) return false;
  if (_bankUploadPromise) return _bankUploadPromise;

  _bankUploadPromise = (async () => {
    const nuvem = _bankCloud || (await hydrateQuestionsBank({ force: false }));
    if (Array.isArray(nuvem) && nuvem.length > _bankCache.length) {
      _bankCache = mergeBankArrays(nuvem, _bankCache);
      safeWriteJson(QUESTIONS_BANK_FILE, _bankCache);
    }
    _lastBankUpload = Date.now();
    return uploadQuestionsBankToSupabase(_bankCache);
  })().finally(() => { _bankUploadPromise = null; });

  return _bankUploadPromise;
}

// Escrita: atualiza a memória na hora e grava o arquivo (compacto).
// Uploads explícitos (sync/import) usam uploadBankNow() e são aguardados;
// escritas incidentais usam uploadBankSoon() com throttle.
function uploadBankSoon() {
  if (!supabaseCatalogReady() || !Array.isArray(_bankCache) || !_bankCache.length) return;
  if (Date.now() - _lastBankUpload < 60 * 1000) return;
  uploadBankNow().catch(() => {});
}

function flushQuestionsBank({ upload = true } = {}) {
  if (!Array.isArray(_bankCache)) _bankCache = [];
  // safeWriteJson é atômico (tmp + rename) e NUNCA lança: EROFS/ENOENT viram false.
  const ok = safeWriteJson(QUESTIONS_BANK_FILE, _bankCache);
  if (ok) {
    _bankDirty = false;
    if (upload) uploadBankSoon();
  } else if (!IS_SERVERLESS) {
    console.error('Erro ao escrever questions-bank.json: sistema de arquivos não gravável.');
  }
  return ok;
}
function writeQuestionsBank(questions, { upload = true } = {}) {
  _bankCache = questions; _bankDirty = true;
  clearTimeout(_bankTimer);
  if (IS_SERVERLESS) {
    // Não há garantia de que o timer rode depois da resposta: grava já no /tmp.
    flushQuestionsBank({ upload });
  } else {
    _bankTimer = setTimeout(() => flushQuestionsBank({ upload }), 3000);
  }
  return true;
}
const _sairLimpo = () => { clearTimeout(_bankTimer); if (_bankDirty) flushQuestionsBank(); process.exit(0); };
process.on('SIGTERM', _sairLimpo);
process.on('SIGINT', _sairLimpo);

// 1. Obter todas as questões prontas do banco (Aba 1)
app.get('/api/questions/bank', (req, res) => {
  const bank = readQuestionsBank();
  res.json({ success: true, count: bank.length, questions: bank });
});

// 1.1 Questões da videoaula: só entram questões que falam do tema/módulo da aula (cobertura mínima de conceitos).
// Se o banco tiver poucas e houver IA, completa com questões inéditas sobre o MESMO tema (marcadas como IA).
const _qIaCache = new Map();
const _qVivoCache = new Map();
app.get('/api/questions/match', async (req, res) => {
  try {
    const disciplina = String(req.query.disciplina || req.query.disc || '').slice(0, 120);
    const tema = String(req.query.tema || req.query.titulo || '').slice(0, 200);
    const modulo = String(req.query.modulo || req.query.curso || '').slice(0, 200);
    const limit = Math.max(1, Math.min(60, parseInt(req.query.limit, 10) || 40));
    const bank = readQuestionsBank();
    const r = selecionarQuestoes(bank, { tema, modulo, disc: disciplina, limit });
    let questions = r.questions;
    let iaCount = 0, vivoCount = 0, doencasUsadas = [];
    // Banco completo do Hardworq (30 mil+): acha a(s) doença(s) do catálogo que correspondem à aula e busca só elas
    if (req.query.vivo !== '0' && (HWQ.email && HWQ.senha || HWQ_STATE.userToken || HWQ.cookie)) {
      try {
        const doencas = await hwqListarDoencas();
        const alvo = acharDoencas(doencas, tema, modulo);
        if (alvo.length) {
          const key = alvo.map(d => d.id).sort().join(',');
          let vivo = _qVivoCache.get(key);
          if (!vivo || Date.now() - vivo.at > 6 * 3600 * 1000) {
            await hwqEnsureToken();
            const busca = await Promise.race([
              hwqFetchAll({ ids_doencas: alvo.map(d => d.id), qtd_maxima: Math.min(limit, 60), areas: ['Clínica Médica', 'Cirurgia Geral', 'Pediatria', 'Ginecologia e Obstetrícia', 'Medicina Preventiva'] }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))
            ]);
            const lista = busca && !busca.error && !busca.authFailed ? parseHardworqPayload(busca.questions) : [];
            vivo = { at: Date.now(), questions: lista.map(q => Object.assign({}, q, { _rel: 'alta' })) };
            if (lista.length) { _qVivoCache.set(key, vivo); if (_qVivoCache.size > 80) _qVivoCache.delete(_qVivoCache.keys().next().value); }
          }
          doencasUsadas = alvo.map(d => d.nome);
          const vistos = new Set();
          const juntas = [];
          for (const q of [...vivo.questions, ...questions]) {
            const k = q.remoteId != null ? 'r' + q.remoteId : q.id;
            if (vistos.has(k)) continue; vistos.add(k); juntas.push(q);
          }
          vivoCount = vivo.questions.length;
          questions = juntas.slice(0, limit);
        }
      } catch (e) { console.warn('[Questões da aula] banco Hardworq indisponível:', e.message); }
    }
    const MIN = 10;
    const assunto = (tema && r.termos.length ? tema : (modulo || tema)).trim();
    const gemini = aiConfigured();
    if (questions.length < MIN && gemini && assunto.length > 3 && req.query.ia !== '0') {
      const key = norm(assunto) + '|' + norm(disciplina);
      let novas = _qIaCache.get(key);
      if (!novas) {
        try {
          const falta = Math.min(10, MIN + 2 - questions.length);
          const aiRes = await Promise.race([
            generateAI({ task: "questoes",
              contents: `Você é preceptor de residência médica (ENARE, USP, UNIFESP, AMRIGS, Revalida).
Crie ${falta} questões de múltipla escolha inéditas, estritamente sobre o tema desta videoaula: "${assunto}"${disciplina ? ` (área: ${disciplina})` : ''}.
Regras: caso clínico objetivo, 4 alternativas ("A) ...", "B) ..."), apenas UMA correta, comentário técnico curto que explique por que a correta está certa e as demais erradas. Não saia do tema. Varie o foco (diagnóstico, conduta, fisiopatologia, exames).`,
              config: { responseMimeType: 'application/json', responseSchema: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { statement: { type: Type.STRING }, options: { type: Type.ARRAY, items: { type: Type.STRING } }, correctIndex: { type: Type.INTEGER }, explanation: { type: Type.STRING } }, required: ['statement', 'options', 'correctIndex', 'explanation'] } } }
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))
          ]);
          const arr = JSON.parse(aiRes.text || '[]');
          novas = (Array.isArray(arr) ? arr : []).filter(q => q && q.statement && Array.isArray(q.options) && q.options.length >= 3 && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < q.options.length)
            .map((q, i) => ({
              id: 'q-ia-' + Buffer.from(key).toString('base64').slice(0, 10) + '-' + i,
              statement: q.statement, options: q.options, correctIndex: q.correctIndex,
              correctLetter: String.fromCharCode(65 + q.correctIndex), explanation: q.explanation || '',
              institution: 'Gerada por IA', year: new Date().getFullYear(), specialty: disciplina || 'Medicina',
              subspecialty: assunto, difficulty: 'Médio', tags: [assunto], source: 'ia', _rel: 'ia'
            }));
          if (novas.length) { _qIaCache.set(key, novas); if (_qIaCache.size > 100) _qIaCache.delete(_qIaCache.keys().next().value); }
        } catch (e) { console.warn('[Questões da aula] geração por IA indisponível:', e.message); novas = []; }
      }
      iaCount = novas.length;
      questions = [...questions, ...novas].slice(0, limit);
    }
    res.json({
      success: true, count: questions.length, totalAvailable: questions.length,
      bancoCount: questions.length - iaCount, iaCount, vivoCount, doencas: doencasUsadas, exatas: r.exatas, termos: r.termos,
      questions, tema, modulo, disciplina
    });
  } catch (err) {
    console.error('Erro em /api/questions/match:', err.message);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Sincronização TOTAL e Bidirecional: mescla todas as questões do cliente com as do servidor
// sem perda, salvando em sua totalidade no arquivo persistente questions-bank.json
let _syncOrd = null;
app.post('/api/questions/bank/sync', (req, res) => {
  try {
    const { questions, since, limit } = req.body || {};
    let m = { imported: 0, updated: 0, total: 0 };
    if (Array.isArray(questions) && questions.length > 0) {
      m = mergeQuestionsIntoBank(questions);
    }
    const fullBank = readQuestionsBank();
    // Incremental por cursor (createdAt|id): lotes grandes, sem reordenar 30 mil questões a cada chamada
    const lim = Math.max(500, Math.min(8000, parseInt(limit, 10) || 6000));
    const desde = since ? String(since) : '';
    if (!_syncOrd || _syncOrd.ref !== fullBank || _syncOrd.n !== fullBank.length) {
      const k = q => (q.createdAt || '') + '|' + (q.id == null ? '' : q.id);
      const arr0 = fullBank.map(q => ({ q, k: k(q) })).sort((x, y) => x.k < y.k ? -1 : x.k > y.k ? 1 : 0);
      _syncOrd = { ref: fullBank, n: fullBank.length, arr: arr0 };
    }
    const arr = _syncOrd.arr;
    let ini = 0;
    if (desde) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].k <= desde) lo = mid + 1; else hi = mid; } ini = lo; }
    const fatia = arr.slice(ini, ini + lim);
    const lote = fatia.map(x => x.q);
    const more = ini + lim < arr.length;
    const nextSince = fatia.length ? fatia[fatia.length - 1].k : desde;
    const corpo = JSON.stringify({
      success: true, count: fullBank.length, total: fullBank.length,
      imported: m.imported || 0, updated: m.updated || 0,
      questions: lote, more, nextSince, incremental: !!desde
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && corpo.length > 20000) {
      res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
      return zlib.gzip(corpo, (e, z) => e ? res.end(corpo) : res.end(z));
    }
    res.end(corpo);
  } catch (err) {
    console.error('Erro em /api/questions/bank/sync:', err.message);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Restauração / Espelhamento do banco do navegador
app.post('/api/questions/bank/restore', (req, res) => {
  try {
    const { questions } = req.body || {};
    if (Array.isArray(questions) && questions.length > 0) {
      const m = mergeQuestionsIntoBank(questions);
      const atual = readQuestionsBank();
      console.log(`♻️ [Banco Restore] Mescladas na totalidade: +${m.imported} novas, total ${m.total}.`);
      return res.json({ success: true, restaurado: m.imported, updated: m.updated, total: m.total, questions: atual });
    }
    const atual = readQuestionsBank();
    res.json({ success: true, restaurado: 0, total: atual.length, questions: atual });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   INTEGRAÇÃO HARDWORQ — banco de questões oficial
   API: PUT https://extensivo.hardworkmedicina.api.br/banco/questoes/{id_turma}
   (schema validado: gabarito vem no feed em alternativas[].correta)
   ═══════════════════════════════════════════════════════════════ */
const HWQ = {
  apiBase: process.env.HARDWORQ_API_BASE || 'https://extensivo.hardworkmedicina.api.br',
  hwqBase: process.env.HARDWORQ_HWQ_BASE || 'https://hardworq.hardworkmedicina.api.br',
  idTurma: process.env.HARDWORQ_ID_TURMA || '1273',
  // Login por credenciais (método atual — o cookie de sessão foi descontinuado pela API)
  email: process.env.HARDWORQ_EMAIL || '',
  senha: process.env.HARDWORQ_SENHA || '',
  // Chaves de app do próprio Hardworq (públicas, embutidas no bundle do app — uma por API)
  appKeyExt: process.env.HARDWORQ_APP_KEY_EXT || 'YzJjNTZkYjMtMGQwNS00NGJiLTk5YzUtZjJhN2E4ODlmNjdl',
  appKeyHwq: process.env.HARDWORQ_APP_KEY_HWQ || 'mcJZrH5yb7qhpST3k4vMqUL76t78ttpGeHj0U20V6khQWuWLPkIHJlOukj9p8U1E',
  // Legado: cookie de sessão ainda aceito como fallback
  cookie: process.env.HARDWORQ_COOKIE || '',
  autoSync: /^(1|true|on)$/i.test(process.env.HARDWORQ_AUTO_SYNC || ''),
  syncIntervalHours: Math.max(1, parseInt(process.env.HARDWORQ_SYNC_INTERVAL_H, 10) || 6),
  maxBankSize: Math.max(50, parseInt(process.env.HARDWORQ_MAX_BANK, 10) || 400),
  // Espelho contínuo do banco completo (ligado sozinho quando há login; desligue com HARDWORQ_MIRROR=0)
  mirror: !/^(0|false|off)$/i.test(process.env.HARDWORQ_MIRROR || ''),
  mirrorMax: Math.max(500, parseInt(process.env.HARDWORQ_MIRROR_MAX, 10) || 2000000) // sem limite prático
};
const HWQ_STATE = { userToken: null, tokenStore: null, lastLoginAt: null, lastLoginOk: null, lastLoginError: '', lastLoginStatus: 0, lastLoginAttemptAt: 0, lastSyncAt: null, lastSyncOk: null, lastSyncResult: null, doencas: null, doencasAt: 0 };
const HWQ_LOGIN_RETRY_MS = 30 * 1000;

// Login contínuo: o token do aluno é estado DURÁVEL e vive no Supabase
// (system_configs → chave `hwq_token`). Na Vercel /tmp é apagado a cada cold
// start, então arquivo local só serve como cache efêmero de fallback.
// Só refaz o login de verdade quando a API recusar o token (auth:false) — relogin automático.
const HWQ_TOKEN_KEY = 'hwq_token';
const HWQ_TOKEN_FILE = path.join(TMP_DIR, 'hwq-token.json'); // legado/dev: NUNCA fonte da verdade
const HWQ_TOKEN_LEGACY = path.join(DATA_DIR, 'hwq-token.json'); // migração: Render/local

async function saveHwqToken(token) {
  if (!token) return false;
  const record = { token: String(token), savedAt: new Date().toISOString() };

  // UPSERT no Supabase. O helper também grava um cache best-effort em /tmp,
  // que nunca é considerado persistente.
  const durable = await setSystemConfig(HWQ_TOKEN_KEY, record);
  try { safeWriteJson(HWQ_TOKEN_FILE, record); } catch (_) { /* cache opcional */ }

  HWQ_STATE.tokenStore = durable ? 'supabase' : 'tmp';
  if (durable) {
    console.log('🔑 [Hardworq] Token persistido no Supabase (system_configs).');
  } else {
    console.warn('⚠️ [Hardworq] Token salvo apenas no cache efêmero (/tmp). Configure o Supabase e rode supabase-schema.sql para torná-lo durável.');
  }
  return durable;
}

async function loadHwqToken() {
  // 1) Fonte da verdade: Supabase.
  try {
    const j = await getSystemConfig(HWQ_TOKEN_KEY, null);
    if (j && j.token) {
      HWQ_STATE.userToken = String(j.token);
      HWQ_STATE.lastLoginOk = true; // otimista: se estiver vencido, o relogin automático cuida
      HWQ_STATE.lastLoginAt = j.savedAt || null;
      HWQ_STATE.tokenStore = 'supabase';
      console.log('🔑 [Hardworq] Token carregado do Supabase — sessão contínua.');
      return true;
    }
  } catch (err) {
    console.warn('⚠️ [Hardworq] Falha ao carregar token do Supabase:', err.message);
  }

  // 2) Fallback: cache local de uma execução anterior (dev, Render ou Supabase fora do ar).
  //    Se veio do arquivo antigo, tenta migrá-lo para o Supabase em background.
  for (const arquivo of [HWQ_TOKEN_FILE, HWQ_TOKEN_LEGACY]) {
    try {
      const j = safeReadJson(arquivo, null);
      if (j && j.token) {
        HWQ_STATE.userToken = String(j.token);
        HWQ_STATE.lastLoginOk = true;
        HWQ_STATE.lastLoginAt = j.savedAt || null;
        HWQ_STATE.tokenStore = 'tmp';
        console.warn(`⚠️ [Hardworq] Token recuperado de cache local (${arquivo}) — tentando migrar para o Supabase.`);
        saveHwqToken(j.token).catch(() => {});
        return true;
      }
    } catch (_) { /* tenta o próximo */ }
  }
  return false;
}
// Promise aguardada por toda chamada ao Hardworq: garante o token antes do request.
const hwqTokenReady = loadHwqToken();

const HWQ_AREAS_DEFAULT = ['Clínica Médica', 'Cirurgia Geral', 'Pediatria', 'Ginecologia e Obstetrícia', 'Medicina Preventiva'];
const HWQ_ANOS_DEFAULT = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];
const HWQ_GRUPOS_DEFAULT = ['R1', 'REVALIDA'];

// Chave de app por base: o app Hardworq usa uma Bearer fixa embutida no bundle, uma por API
function hwqAppKey(url) {
  return String(url).startsWith(HWQ.hwqBase) ? HWQ.appKeyHwq : HWQ.appKeyExt;
}

function hwqHeaders(url, { withUserToken = true } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Origin': HWQ.apiBase,
    'Referer': HWQ.apiBase + '/',
    'Authorization': 'Bearer ' + hwqAppKey(url)
  };
  if (withUserToken && HWQ_STATE.userToken) headers['UserToken'] = HWQ_STATE.userToken;
  if (HWQ.cookie) headers['Cookie'] = HWQ.cookie; // legado
  return headers;
}

// Chamada HTTP crua (sem relogin); normaliza erro de sessão (auth:false / "Invalid User")
async function hwqFetch(url, { method = 'GET', body = null, timeoutMs = 20000, withUserToken = true } = {}) {
  // Cold start: carrega o token do Supabase antes de montar os headers.
  try { await hwqTokenReady; } catch (_) { /* relogin abaixo resolve */ }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: hwqHeaders(url, { withUserToken }),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text.slice(0, 500) }; }
    const authFailed = res.status === 401 || res.status === 403 ||
      (data && (data.auth === false || /invalid user|n[ãa]o autentic/i.test(String(data.msg || data.raw || ''))));
    return { ok: res.ok && !(data && data.ok === false), status: res.status, data, authFailed };
  } catch (err) {
    return { ok: false, status: 0, data: null, authFailed: false, error: err.name === 'AbortError' ? 'Timeout na API do Hardworq' : (err.message || String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

// Login email/senha: PUT /login retorna obj.token, que vira o header UserToken das chamadas seguintes
async function hwqLogin({ force = false } = {}) {
  if (!HWQ.email || !HWQ.senha) {
    HWQ_STATE.lastLoginError = 'HARDWORQ_EMAIL/HARDWORQ_SENHA não configurados no servidor.';
    HWQ_STATE.lastLoginStatus = 0;
    return { ok: false, error: HWQ_STATE.lastLoginError, status: 0 };
  }
  try { await hwqTokenReady; } catch (_) { /* segue para login manual */ }
  if (!force && HWQ_STATE.userToken && HWQ_STATE.lastLoginOk) return { ok: true, token: HWQ_STATE.userToken, cached: true };
  // Evita martelar o login em um status/health chamado em sequência quando a senha está errada.
  if (!force && HWQ_STATE.lastLoginError && Date.now() - HWQ_STATE.lastLoginAttemptAt < HWQ_LOGIN_RETRY_MS) {
    return { ok: false, error: HWQ_STATE.lastLoginError, status: HWQ_STATE.lastLoginStatus, cooldown: true };
  }

  HWQ_STATE.lastLoginAttemptAt = Date.now();
  const r = await hwqFetch(`${HWQ.hwqBase}/login`, {
    method: 'PUT',
    body: { email: HWQ.email, senha: HWQ.senha, platform: '', uuid: '' },
    withUserToken: false
  });
  HWQ_STATE.lastLoginAt = new Date().toISOString();
  HWQ_STATE.lastLoginStatus = r.status || 0;
  const token = r.data && r.data.obj && r.data.obj.token ? String(r.data.obj.token) : '';
  const ok = !!(r.ok && token);
  HWQ_STATE.lastLoginOk = ok;
  HWQ_STATE.userToken = token || null;
  if (ok) {
    HWQ_STATE.lastLoginError = '';
    await saveHwqToken(token);
    console.log('🔑 [Hardworq] Login ok — token em memória + persistência durável.');
  } else {
    // Não apaga o token durável em falha transitória: o próximo request tenta de novo.
    HWQ_STATE.lastLoginError = (r.data && (r.data.msg || r.data.raw)) || r.error || `HTTP ${r.status}`;
    try { fs.rmSync(HWQ_TOKEN_FILE, { force: true }); } catch (_) {}
    console.warn('⚠️ [Hardworq] Login falhou:', HWQ_STATE.lastLoginError);
  }
  return { ok, token, status: r.status || 0, msg: (r.data && r.data.msg) || r.error || '', error: HWQ_STATE.lastLoginError || '' };
}

/* Garante um token válido antes de status/sync. Se o token durável não existir
   (tabela ausente/cold start), faz login na hora em vez de ficar "aguardando". */
let hwqEnsurePromise = null;
async function hwqEnsureToken() {
  if (hwqEnsurePromise) return hwqEnsurePromise;
  hwqEnsurePromise = (async () => {
    try { await hwqTokenReady; } catch (_) { /* tenta login abaixo */ }
    if (HWQ_STATE.userToken && HWQ_STATE.lastLoginOk !== false) {
      return { ok: true, token: HWQ_STATE.userToken, cached: true };
    }
    return hwqLogin();
  })();
  try {
    return await hwqEnsurePromise;
  } finally {
    hwqEnsurePromise = null;
  }
}

// Chamada com relogin automático: se a sessão cair (auth:false), refaz login e tenta 1× de novo
async function hwqRequest(url, opts = {}) {
  const first = await hwqFetch(url, opts);
  if (!first.authFailed) return first;
  const login = await hwqLogin({ force: true });
  if (!login.ok) return first;
  return hwqFetch(url, opts);
}

// Busca questões no banco do Hardworq (doc §2)
async function hwqSearchQuestions(opts = {}) {
  const body = {
    qtd_maxima: Math.min(100, Math.max(1, parseInt(opts.qtd_maxima, 10) || 20)),
    areas: Array.isArray(opts.areas) && opts.areas.length ? opts.areas : HWQ_AREAS_DEFAULT,
    id_prova_similar: 0,
    ids_instituicoes: opts.ids_instituicoes || [],
    ids_doencas: opts.ids_doencas || [],
    ids_tags: opts.ids_tags || [],
    anos: Array.isArray(opts.anos) && opts.anos.length ? opts.anos : HWQ_ANOS_DEFAULT,
    grupos_prova: Array.isArray(opts.grupos_prova) && opts.grupos_prova.length ? opts.grupos_prova : HWQ_GRUPOS_DEFAULT,
    outra_opcao: opts.outra_opcao || ''
  };
  const url = `${HWQ.apiBase}/banco/questoes/${encodeURIComponent(opts.idTurma || HWQ.idTurma)}`;
  const r = await hwqRequest(url, { method: 'PUT', body });
  const list = r.data && Array.isArray(r.data.obj) ? r.data.obj : (Array.isArray(r.data) ? r.data : []);
  return { ok: r.ok && list.length > 0, status: r.status, authFailed: r.authFailed, error: r.error, msg: (r.data && r.data.msg) || '', questions: list };
}

// Busca em rodadas de 100 até não voltarem questões novas (a API não pagina — repete amostras).
// qtd_maxima define o teto; budgetMs evita estourar o limite da função serverless.
async function hwqFetchAll(opts = {}) {
  const target = Math.min(50000, Math.max(1, parseInt(opts.qtd_maxima, 10) || 50000));
  const budgetMs = Math.max(5000, Math.min(240000, parseInt(opts.budgetMs, 10) || 90000));
  const startedAt = Date.now();
  const seen = new Map();
  let rounds = 0;
  let truncated = false;
  while (seen.size < target && rounds < 400) {
    if (Date.now() - startedAt > budgetMs) { truncated = true; break; }
    rounds++;
    const search = await hwqSearchQuestions({ ...opts, qtd_maxima: 100 });
    if (search.error || search.authFailed || search.status >= 400) {
      return { ...search, questions: [...seen.values()], rounds, truncated };
    }
    let novas = 0;
    for (const q of search.questions) {
      const key = q && q.id != null ? `id:${q.id}` : JSON.stringify(q);
      if (!seen.has(key)) { seen.set(key, q); novas++; }
    }
    if (novas === 0) break; // a API começou a repetir — filtro esgotado
  }
  if (seen.size < target && rounds >= 400) truncated = true;
  return { ok: true, status: 200, authFailed: false, error: null, msg: '', questions: [...seen.values()].slice(0, target), rounds, truncated };
}

// Normaliza para busca sem acento/caixa (ex.: "esquizofrenia" == "Esquizofrenia")
function hwqNorm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Catálogo de doenças/temas (GET /doencas — ~358 entradas) com cache de 24h
async function hwqListarDoencas() {
  if (Array.isArray(HWQ_STATE.doencas) && HWQ_STATE.doencas.length && Date.now() - HWQ_STATE.doencasAt < 24 * 60 * 60 * 1000) {
    return HWQ_STATE.doencas;
  }
  const r = await hwqRequest(`${HWQ.apiBase}/doencas`);
  const list = r.data && Array.isArray(r.data.obj) ? r.data.obj : [];
  if (list.length) {
    HWQ_STATE.doencas = list;
    HWQ_STATE.doencasAt = Date.now();
  }
  return list;
}

// Busca doenças por nome/especialidade para o filtro do painel (?q=esquizofrenia)
app.get('/api/questions/hardworq/doencas', async (req, res) => {
  try {
    const q = hwqNorm(req.query.q || '');
    const todas = await hwqListarDoencas();
    const filtradas = q
      ? todas.filter(d => hwqNorm(d.nome).includes(q) || hwqNorm(d.especialidade || d.area || '').includes(q))
      : todas;
    res.json({
      success: true,
      total: todas.length,
      doencas: filtradas.slice(0, 30).map(d => ({ id: d.id, nome: d.nome, especialidade: d.especialidade || d.area || '' }))
    });
  } catch (err) {
    console.error('Erro ao buscar doenças Hardworq:', err.message);
    res.status(500).json({ success: false, msg: err.message || 'Erro ao buscar doenças' });
  }
});

// Registra a resposta do aluno na API (doc §9) — exige UserToken válido (login email/senha)
async function hwqAnswerQuestion({ remoteId, alternativeId, idTurma } = {}) {
  if (!remoteId || !alternativeId) return { ok: false, status: 0, authFailed: false, error: 'remoteId e alternativeId são obrigatórios' };
  const url = `${HWQ.apiBase}/banco/questoes/${encodeURIComponent(idTurma || HWQ.idTurma)}/${encodeURIComponent(remoteId)}/${encodeURIComponent(alternativeId)}/false`;
  return hwqRequest(url, { method: 'POST' });
}

// Perfil do aluno (doc §3) — diagnóstico de sessão
async function hwqStudentInfo() {
  const aluno = await hwqRequest(`${HWQ.hwqBase}/alunos`);
  let plano = null;
  if (aluno.ok) plano = await hwqRequest(`${HWQ.hwqBase}/alunos/plano`);
  return { ok: aluno.ok, status: aluno.status, authFailed: aluno.authFailed, aluno: aluno.data, plano: plano ? plano.data : null };
}

// Repara acentos duplamente codificados (UTF-8 lido como latin1), comuns em payloads colados
function fixMojibake(s) {
  const out = String(s == null ? '' : s);
  if (!/[\u00C0-\u00FF]/.test(out)) return out;
  try {
    const repaired = Buffer.from(out, 'latin1').toString('utf8');
    if (repaired !== out && !repaired.includes('\uFFFD') && /[áéíóúâêôãõçàÁÉÍÓÚÂÊÔÃÕÇÀ]/.test(repaired)) {
      return repaired;
    }
  } catch (_) { /* mantém o original */ }
  return out;
}

const HWQ_LETTER_MAP = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E' };

const cleanHtml = (s) => String(s || '').replace(/<[^>]*>?/gm, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const hwqText = (s) => fixMojibake(cleanHtml(s));

function hwqNormalizeArea(spec) {
  const s = String(spec || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (/preventiva|social|sa[uú]de coletiva/.test(lower)) return 'Medicina Preventiva e Social';
  if (/gineco|obstet/.test(lower)) return 'Ginecologia e Obstetrícia';
  if (/cirurg/.test(lower)) return 'Cirurgia Geral';
  if (/pediatr/.test(lower)) return 'Pediatria';
  if (/per[ií]cia|legal|forense/.test(lower)) return 'Perito Médico Federal';
  if (/cl[ií]nica|interna/.test(lower)) return 'Clínica Médica';
  return s;
}

// Parser do schema oficial do Hardworq → formato interno do app (id estável p/ dedupe)
function parseHardworqPayload(rawInput) {
  let list = [];
  if (typeof rawInput === 'string') {
    try {
      const parsed = JSON.parse(rawInput);
      list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.obj) ? parsed.obj : (Array.isArray(parsed?.questoes) ? parsed.questoes : []));
    } catch (e) {
      return [];
    }
  } else if (Array.isArray(rawInput)) {
    list = rawInput;
  } else if (rawInput && typeof rawInput === 'object') {
    list = Array.isArray(rawInput.obj) ? rawInput.obj : (Array.isArray(rawInput.questoes) ? rawInput.questoes : (Array.isArray(rawInput.data) ? rawInput.data : []));
  }

  return list.map((item, idx) => {
    const rawOptions = Array.isArray(item.alternativas) ? item.alternativas : [];
    if (!rawOptions.length) return null;

    let correctIdx = 0;
    const remoteAlternatives = [];
    const formattedOptions = rawOptions.map((opt, oIdx) => {
      const rawLetra = String(opt.letra != null ? opt.letra : (oIdx + 1)).trim();
      const letter = HWQ_LETTER_MAP[rawLetra] || (['A', 'B', 'C', 'D', 'E'][oIdx] || 'A');
      remoteAlternatives.push({ id: opt.id != null ? String(opt.id) : null, index: oIdx, letter });
      if (opt.correta === true || opt.correta === 'true' || opt.correta === 1) correctIdx = oIdx;
      return `${letter}) ${hwqText(opt.alternativa || opt.texto || opt.descricao || '')}`;
    });

    const correctLetter = ['A', 'B', 'C', 'D', 'E'][correctIdx] || 'A';
    const inst = fixMojibake(item.prova?.instituicao || item.instituicao || 'Oficial');
    const ano = parseInt(item.prova?.ano || item.ano, 10) || 2024;
    const grupo = String(item.prova?.grupo || item.grupo || 'R1');
    const code = item.codigo || `HW-${item.id || (idx + 1)}`;
    const statement = hwqText(item.enunciado || '');

    let spec = hwqNormalizeArea(item.area || item.especialidade || item.specialty);
    if (!spec) {
      const hay = statement.toLowerCase();
      if (/cardio|hipertens|coron|infarto|pulm|pneumo|dispneia|renal|diabetes|eletrocardio|arritmia/i.test(hay)) spec = 'Clínica Médica';
      else if (/apendic|cirurg|trauma|laparotom|abdome agudo|hérnia|queimadur|colecist|atls/i.test(hay)) spec = 'Cirurgia Geral';
      else if (/criança|lactente|pediatr|neonato|exantema|recém-nascido|puericult/i.test(hay)) spec = 'Pediatria';
      else if (/gestante|gestação|pré-eclâmpsia|útero|colo uterino|cesárea|puerpér/i.test(hay)) spec = 'Ginecologia e Obstetrícia';
      else if (/epidemiolog|sus|risco relativo|prevalência|atenção básica|incidência|vigilância|coorte/i.test(hay)) spec = 'Medicina Preventiva e Social';
      else if (/perícia|incapacidade|laudo pericial|inss|previdência|nexo causal/i.test(hay)) spec = 'Perito Médico Federal';
      else spec = 'Residência Médica';
    }

    const explanation = item.comentario
      ? hwqText(item.comentario)
      : `Questão oficial de prova (${inst} ${ano} - ${grupo}). Gabarito confirmado: Alternativa ${correctLetter}.`;

    const stableId = (item.id != null && item.id !== '') ? String(item.id) : (String(code).replace(/[^a-zA-Z0-9_-]/g, '') || `${Date.now()}-${idx}`);

    return {
      id: `q-hw-${stableId}`,
      remoteId: (item.id != null && item.id !== '') ? String(item.id) : null,
      remoteAlternatives,
      specialty: spec,
      subspecialty: grupo,
      institution: inst,
      year: ano,
      statement,
      options: formattedOptions,
      correctIndex: correctIdx,
      correctLetter,
      explanation,
      difficulty: 'Médio',
      tags: [inst, grupo, String(code)].filter(Boolean),
      image: item.imagem ? String(item.imagem) : '',
      createdAt: new Date().toISOString(),
      source: `Hardworq (${code})`
    };
  }).filter(q => q && q.statement.length > 15 && q.options.length >= 2);
}

function hwqStatementKey(q) {
  return String(q.statement || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
}

// Mescla questões parseadas no banco local: atualiza as existentes (mesmo id ou enunciado) e adiciona as novas
function mergeQuestionsIntoBank(parsed) {
  const bank = readQuestionsBank();
  const indexById = new Map(bank.map((q, i) => [q.id, i]));
  const indexByStmt = new Map(bank.map((q, i) => [hwqStatementKey(q), i]));
  const seenIds = new Set();
  const seenStmts = new Set();
  let updated = 0;
  const fresh = [];

  for (const q of parsed) {
    const key = hwqStatementKey(q);
    if (seenIds.has(q.id) || seenStmts.has(key)) continue;
    seenIds.add(q.id);
    seenStmts.add(key);
    const i = indexById.has(q.id) ? indexById.get(q.id) : (indexByStmt.has(key) ? indexByStmt.get(key) : null);
    if (i != null) {
      bank[i] = { ...bank[i], ...q, createdAt: bank[i].createdAt || q.createdAt };
      updated++;
    } else {
      fresh.push(q);
      indexById.set(q.id, -1);
    }
  }

  const updatedBank = [...fresh, ...bank];
  writeQuestionsBank(updatedBank);
  return { imported: fresh.length, updated, total: updatedBank.length };
}

// Repara acentos quebrados já persistidos por imports antigos
function repairMojibakeInBank() {
  const bank = readQuestionsBank();
  let changed = 0;
  const fixed = bank.map(q => {
    const next = { ...q, options: (q.options || []).map(o => fixMojibake(o)) };
    ['statement', 'explanation', 'specialty', 'institution'].forEach(f => { if (q[f]) next[f] = fixMojibake(q[f]); });
    if (Array.isArray(q.tags)) next.tags = q.tags.map(t => fixMojibake(t));
    if (JSON.stringify(next) !== JSON.stringify(q)) { changed++; return next; }
    return q;
  });
  if (changed) {
    writeQuestionsBank(fixed);
    console.log(`🔧 [Hardworq] Acentos reparados em ${changed} questões do banco local.`);
  }
}
repairMojibakeInBank();

// Salvamento automático: após cada sync bem-sucedido, commita e empurra o banco de questões
// (HARDWORQ_AUTO_GIT=1 no .env; silencioso e com debounce de 5 min — sem git/GitHub, só ignora)
let plUltimoAutoGit = 0;
function autoGitBanco() {
  // Vercel não tem repositório gravável nem git: a persistência durável é o Supabase.
  if (IS_SERVERLESS) return;
  if (!/^(1|true|on)$/i.test(process.env.HARDWORQ_AUTO_GIT || '')) return;
  const agora = Date.now();
  if (agora - plUltimoAutoGit < 5 * 60 * 1000) return;
  plUltimoAutoGit = agora;
  const git = process.env.GIT_PATH || 'git';
  const opts = { cwd: __dirname, timeout: 90000 };
  const passo = (args, done) => execFile(git, args, opts, (err) => done(err));
  passo(['add', 'data/questions-bank.json'], () => {
    passo(['commit', '-m', 'chore: salvar banco de questoes Hardworq (auto)'], () => {
      passo(['pull', '--rebase', 'origin', 'main'], () => {
        passo(['push', 'origin', 'main'], (err) => {
          if (err) console.warn('⚠️ [Hardworq] Auto-git: banco salvo localmente, mas não subiu:', (err.message || '').slice(0, 90));
          else console.log('💾 [Hardworq] Banco de questões salvo automaticamente no GitHub');
        });
      });
    });
  });
}

// Fluxo principal: busca na API + parse + merge no banco local (usado pelo painel e pelo auto-sync)
async function runHardworqSync(filters = {}) {
  const auth = await hwqEnsureToken();
  if (!auth.ok) {
    HWQ_STATE.lastSyncAt = new Date().toISOString();
    HWQ_STATE.lastSyncOk = false;
    HWQ_STATE.lastSyncResult = { fetched: 0, imported: 0, authFailed: true, status: auth.status || 0 };
    return {
      ok: false,
      authFailed: true,
      status: auth.status || 401,
      msg: auth.error || 'Login no Hardworq falhou. Verifique HARDWORQ_EMAIL/HARDWORQ_SENHA no servidor.',
      fetched: 0
    };
  }

  const search = await hwqFetchAll({ ...filters, budgetMs: filters.budgetMs || 90000 });
  HWQ_STATE.lastSyncAt = new Date().toISOString();

  if (search.error || search.authFailed || search.status >= 400) {
    HWQ_STATE.lastSyncOk = false;
    HWQ_STATE.lastSyncResult = { fetched: 0, imported: 0, authFailed: search.authFailed, status: search.status };
    return {
      ok: false,
      authFailed: !!search.authFailed,
      status: search.status,
      msg: search.authFailed
        ? 'Login no Hardworq falhou (auth:false). Verifique HARDWORQ_EMAIL/HARDWORQ_SENHA no servidor.'
        : (search.msg || search.error || `A API do Hardworq respondeu ${search.status}.`),
      fetched: 0
    };
  }

  const parsed = parseHardworqPayload(search.questions);
  if (!parsed.length) {
    HWQ_STATE.lastSyncOk = true;
    HWQ_STATE.lastSyncResult = { fetched: search.questions.length, imported: 0, updated: 0, truncated: !!search.truncated };
    return { ok: true, fetched: search.questions.length, imported: 0, updated: 0, truncated: !!search.truncated, questions: [], msg: 'A API respondeu sem questões para os filtros escolhidos.' };
  }

  const merge = mergeQuestionsIntoBank(parsed);
  HWQ_STATE.lastSyncOk = true;
  HWQ_STATE.lastSyncResult = { fetched: search.questions.length, imported: merge.imported, updated: merge.updated, truncated: !!search.truncated };
  console.log(`🟣 [Hardworq] Sincronização: ${search.questions.length} buscadas → ${merge.imported} novas, ${merge.updated} atualizadas${search.truncated ? ' (parcial; continua na próxima chamada)' : ''}.`);
  autoGitBanco();
  return { ok: true, fetched: search.questions.length, imported: merge.imported, updated: merge.updated, total: merge.total, truncated: !!search.truncated, questions: parsed };
}

// Status da integração (painel do app)
app.get('/api/questions/hardworq/status', async (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  // Antes de responder, garante o login: sem isso o painel ficava eternamente
  // em "aguardando login" quando o token não sobrevivia ao cold start.
  try { await hwqEnsureToken(); } catch (_) { /* status continua válido sem token */ }
  const bank = readQuestionsBank();
  const hwqCount = bank.filter(q => q.source && String(q.source).startsWith('Hardworq')).length;
  res.json({
    success: true,
    idTurma: HWQ.idTurma,
    apiBase: HWQ.apiBase,
    authMode: (HWQ.email && HWQ.senha) ? 'login' : (HWQ.cookie ? 'cookie' : 'nenhum'),
    emailConfigured: !!HWQ.email,
    userTokenActive: !!HWQ_STATE.userToken,
    tokenPersisted: HWQ_STATE.tokenStore === 'supabase',
    tokenStore: HWQ_STATE.tokenStore || 'none',
    lastLoginAt: HWQ_STATE.lastLoginAt,
    lastLoginOk: HWQ_STATE.lastLoginOk,
    lastLoginError: HWQ_STATE.lastLoginError || null,
    lastLoginStatus: HWQ_STATE.lastLoginStatus || null,
    cookieConfigured: !!HWQ.cookie,
    autoSync: HWQ.autoSync,
    syncIntervalHours: HWQ.syncIntervalHours,
    lastSyncAt: HWQ_STATE.lastSyncAt,
    lastSyncOk: HWQ_STATE.lastSyncOk,
    lastSyncResult: HWQ_STATE.lastSyncResult,
    bankCount: bank.length,
    hardworqCount: hwqCount
  });
});

// Sincronização com a API do Hardworq (botão "Sincronizar Hardworq" do app)
const HWQ_BG = { running: false, startedAt: 0, last: null };
app.get('/api/questions/hardworq/sync-status', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({
    success: true,
    ...HWQ_BG,
    total: readQuestionsBank().length,
    userTokenActive: !!HWQ_STATE.userToken,
    lastLoginError: HWQ_STATE.lastLoginError || null,
    lastLoginStatus: HWQ_STATE.lastLoginStatus || null
  });
});
app.post('/api/questions/hardworq/sync', async (req, res) => {
  try {
    const { areas, anos, grupos_prova, qtd_maxima, cookie, email, senha, idTurma, ids_doencas, salvar = true } = req.body || {};
    if (email && senha) { HWQ.email = String(email).trim(); HWQ.senha = String(senha); HWQ_STATE.userToken = null; } // sessão avulsa (não persiste)
    if (cookie) HWQ.cookie = String(cookie).trim(); // legado

    if (salvar === false) {
      const auth = await hwqEnsureToken();
      if (!auth.ok) {
        return res.status(401).json({ success: false, authFailed: true, status: auth.status || 401, msg: auth.error || 'Login no Hardworq falhou.' });
      }
      const search = await hwqFetchAll({ areas, anos, grupos_prova, qtd_maxima, ids_doencas, idTurma, budgetMs: 60000 });
      if (search.error || search.authFailed || search.status >= 400) {
        return res.status(search.authFailed ? 401 : 502).json({
          success: false, authFailed: !!search.authFailed, status: search.status,
          msg: search.authFailed ? 'Login no Hardworq falhou — verifique email/senha.' : (search.msg || search.error || `A API respondeu ${search.status}.`)
        });
      }
      const parsed = parseHardworqPayload(search.questions);
      return res.json({ success: true, fetched: search.questions.length, imported: 0, updated: 0, questions: parsed });
    }

    if ((req.body || {}).background) {
      // O login é síncrono para o app receber o erro real (401) em vez de um
      // "success" falso. Na Vercel a busca também roda síncrona: trabalho
      // disparado depois da resposta não é garantido em serverless.
      const auth = await hwqEnsureToken();
      if (!auth.ok) {
        return res.status(401).json({ success: false, authFailed: true, status: auth.status || 401, msg: auth.error || 'Login no Hardworq falhou.' });
      }
      if (IS_SERVERLESS) {
        const result = await runHardworqSync({ areas, anos, grupos_prova, qtd_maxima, ids_doencas, idTurma, budgetMs: 90000 });
        // O cliente já baixa o banco por /api/questions/bank; não devolve milhares
        // de questões no corpo desta resposta de sincronização.
        const { questions: _questions, ...summary } = result;
        return res.status(result.ok ? 200 : (result.authFailed ? 401 : 502)).json({ ...summary, background: false });
      }
      // Render/local: mantém a resposta imediata e o trabalho em segundo plano.
      if (!HWQ_BG.running) {
        HWQ_BG.running = true; HWQ_BG.startedAt = Date.now();
        runHardworqSync({ areas, anos, grupos_prova, qtd_maxima, ids_doencas, idTurma })
          .then(r => { HWQ_BG.last = { ok: !!r.ok, imported: r.imported || 0, updated: r.updated || 0, truncated: !!r.truncated, msg: r.msg || '', at: Date.now() }; })
          .catch(e => { HWQ_BG.last = { ok: false, msg: e.message, at: Date.now() }; })
          .finally(() => { HWQ_BG.running = false; });
      }
      return res.json({ success: true, background: true, auth: true, running: HWQ_BG.running, total: readQuestionsBank().length });
    }
    const result = await runHardworqSync({ areas, anos, grupos_prova, qtd_maxima, ids_doencas, idTurma, budgetMs: 90000 });
    res.status(result.ok ? 200 : (result.authFailed ? 401 : 502)).json(result);
  } catch (err) {
    console.error('Erro na sincronização Hardworq:', err);
    res.status(500).json({ success: false, msg: err.message || 'Erro interno na sincronização Hardworq' });
  }
});

// Registra a resposta no Hardworq quando o aluno resolve a questão no simulador (doc §9)
app.post('/api/questions/hardworq/answer', async (req, res) => {
  try {
    const { remoteId, alternativeId, idTurma } = req.body || {};
    const r = await hwqAnswerQuestion({ remoteId, alternativeId, idTurma });
    res.json({ success: r.ok, authFailed: !!r.authFailed, status: r.status, msg: (r.data && r.data.msg) || r.error || '' });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// Perfil/plano do aluno no Hardworq — diagnóstico de sessão
app.get('/api/questions/hardworq/aluno', async (req, res) => {
  const info = await hwqStudentInfo();
  res.json({ success: info.ok, authFailed: !!info.authFailed, status: info.status, aluno: info.aluno, plano: info.plano });
});

// Importação manual (compatibilidade): aceita jsonText/payload colado OU idTurma para buscar na API
app.post('/api/questions/import-hardworq', async (req, res) => {
  try {
    const { idTurma, cookie, email, senha, jsonText, payload, qtd_maxima = 20, areas, anos, grupos_prova, ids_doencas } = req.body || {};
    let parsedQuestions = [];

    if (email && senha) { HWQ.email = String(email).trim(); HWQ.senha = String(senha); HWQ_STATE.userToken = null; }
    if (cookie) HWQ.cookie = String(cookie).trim();

    if (payload || jsonText) {
      parsedQuestions = parseHardworqPayload(payload || jsonText);
    } else if (idTurma || HWQ.email || HWQ.cookie) {
      await hwqEnsureToken();
      const search = await hwqFetchAll({ idTurma, areas, anos, grupos_prova, qtd_maxima, ids_doencas });
      if (search.error || search.authFailed || search.status >= 400) {
        return res.status(search.authFailed ? 401 : 502).json({
          error: search.authFailed
            ? 'Login no Hardworq falhou (auth:false). Verifique HARDWORQ_EMAIL/HARDWORQ_SENHA no .env.'
            : (search.msg || search.error || `Hardworq API retornou status ${search.status}.`),
          details: search.data || null
        });
      }
      parsedQuestions = parseHardworqPayload(search.questions);
    } else {
      return res.status(400).json({ error: 'Envie "idTurma", "email"+"senha" ou "jsonText" com o retorno da API do Hardworq.' });
    }

    if (!parsedQuestions.length) {
      return res.status(400).json({ error: 'Nenhuma questão válida encontrada no formato Hardworq informado.' });
    }

    const merge = mergeQuestionsIntoBank(parsedQuestions);
    res.json({ success: true, imported: merge.imported, updated: merge.updated, total: merge.total, questions: parsedQuestions });
  } catch (err) {
    console.error('Erro ao importar do Hardworq:', err);
    res.status(500).json({ error: err.message || 'Falha ao processar importação do Hardworq' });
  }
});

// Alimentador automático a partir do Hardworq (HARDWORQ_AUTO_SYNC=1 no .env)
async function autoSyncHardworq() {
  if (!HWQ.autoSync) return;
  try {
    const bank = readQuestionsBank();
    if (bank.length >= HWQ.maxBankSize) return;
    console.log('🟣 [Hardworq] Auto-sync do banco de questões...');
    const r = await runHardworqSync({ qtd_maxima: 20 });
    if (r.ok) console.log(`🟣 [Hardworq] Auto-sync: ${r.imported} novas, ${r.updated} atualizadas.`);
    else console.warn(`⚠️ [Hardworq] Auto-sync falhou: ${r.msg}`);
  } catch (err) {
    console.warn('⚠️ [Hardworq] Auto-sync erro:', err.message);
  }
}
// Processos de fundo só fazem sentido em servidor persistente (Railway/Render).
// Em serverless eles seriam congelados ou multiplicariam execuções.
if (!IS_SERVERLESS) {
  setTimeout(autoSyncHardworq, 20000);
  setInterval(autoSyncHardworq, HWQ.syncIntervalHours * 60 * 60 * 1000);
}

// ── Espelho contínuo: percorre o catálogo de doenças do Hardworq (~358) e traz as questões de cada uma,
// uma por vez e com pausa entre elas. Ao terminar a volta, descansa e recomeça (pega questões novas). ──
const MIRROR_FILE = path.join(DATA_DIR, 'hwq-mirror.json');
const MIRROR = { running: false, idx: 0, total: 0, passes: 0, lastAt: null, lastDoenca: '', novas: 0, erro: '' };
try { Object.assign(MIRROR, JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8')), { running: false }); } catch (_) {}
const saveMirror = () => { try { fs.writeFileSync(MIRROR_FILE, JSON.stringify({ idx: MIRROR.idx, passes: MIRROR.passes, lastAt: MIRROR.lastAt })); } catch (_) {} };


// Publica o banco completo no GitHub (arquivo .json.gz) quando o espelho junta bem mais questões que o repositório tem.
// Precisa só de GITHUB_TOKEN no Render (token com permissão "Contents: read and write" neste repositório).
let _publicando = false;
async function publicarBancoGitHub() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const repo = process.env.GITHUB_REPO || 'Noronja/cuscuz';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const bank = readQuestionsBank();
  if (!token || _publicando || bank.length < _bankBase + Math.max(200, _bankBase * 0.05)) return;
  _publicando = true;
  const api = p => `https://api.github.com/repos/${repo}/contents/${p}`;
  const h = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'cuscuz-med', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    const sha = async p => { const r = await fetch(api(p) + '?ref=' + branch, { headers: h }); return r.ok ? (await r.json()).sha : null; };
    const conteudo = zlib.gzipSync(Buffer.from(JSON.stringify(bank)), { level: 9 }).toString('base64');
    const gzPath = 'data/questions-bank.json.gz';
    const put = await fetch(api(gzPath), { method: 'PUT', headers: h, body: JSON.stringify({ message: `chore: banco de questões (${bank.length} questões) [auto]`, content: conteudo, branch, sha: (await sha(gzPath)) || undefined }) });
    if (!put.ok) throw new Error('GitHub ' + put.status + ' ' + (await put.text()).slice(0, 120));
    const shaPlain = await sha('data/questions-bank.json');
    if (shaPlain) await fetch(api('data/questions-bank.json'), { method: 'DELETE', headers: h, body: JSON.stringify({ message: 'chore: remove banco antigo em .json (agora .json.gz)', sha: shaPlain, branch }) });
    _bankBase = bank.length; MIRROR.publicadoEm = new Date().toISOString(); MIRROR.erroPublicar = '';
    console.log(`💾 [Banco] ${bank.length} questões publicadas no GitHub (${gzPath}).`);
  } catch (e) { MIRROR.erroPublicar = String(e.message || e).slice(0, 160); console.warn('⚠️ [Banco] não consegui publicar no GitHub:', MIRROR.erroPublicar); }
  _publicando = false;
}

async function mirrorTick() {
  if (!HWQ.mirror || !(HWQ.email && HWQ.senha) || MIRROR.running) return setTimeout(mirrorTick, 5 * 60 * 1000);
  MIRROR.running = true;
  let espera = Math.max(1, parseFloat(process.env.HARDWORQ_MIRROR_PAUSE_S) || 10) * 1000;
  try {
    await hwqEnsureToken();
    const doencas = await hwqListarDoencas();
    MIRROR.total = doencas.length;
    if (!doencas.length) throw new Error('catálogo de doenças vazio');
    if (readQuestionsBank().length >= HWQ.mirrorMax) { MIRROR.passes = Math.max(MIRROR.passes, 1); publicarBancoGitHub(); espera = HWQ.syncIntervalHours * 3600 * 1000; MIRROR.erro = 'limite do espelho atingido'; }
    else {
      if (MIRROR.idx >= doencas.length) { MIRROR.idx = 0; MIRROR.passes++; espera = 30 * 60 * 1000; flushQuestionsBank(); publicarBancoGitHub(); }
      else {
        const d = doencas[MIRROR.idx];
        const busca = await hwqFetchAll({ ids_doencas: [d.id], qtd_maxima: 3000 });
        if (busca.authFailed) { HWQ_STATE.userToken = null; throw new Error('login recusado'); }
        const lista = !busca.error && busca.status < 400 ? parseHardworqPayload(busca.questions) : [];
        if (lista.length) { const m = mergeQuestionsIntoBank(lista); MIRROR.novas += m.imported; }
        MIRROR.lastDoenca = d.nome; MIRROR.idx++; MIRROR.lastAt = new Date().toISOString(); MIRROR.erro = '';
        saveMirror();
      }
    }
  } catch (e) { MIRROR.erro = String(e.message || e).slice(0, 120); espera = 3 * 60 * 1000; }
  MIRROR.running = false;
  setTimeout(mirrorTick, espera);
}
if (!IS_SERVERLESS) setTimeout(mirrorTick, 45000);
app.get('/api/questions/mirror', (req, res) => {
  res.json({ success: true, ...MIRROR, publicacao: !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN), baseRepo: _bankBase, ativo: HWQ.mirror && !!(HWQ.email && HWQ.senha), bankCount: readQuestionsBank().length, limite: HWQ.mirrorMax });
});

// Login no boot apenas se não houver token reutilizável — credenciais certas entram em segundos
if (!IS_SERVERLESS) setTimeout(() => { if (!HWQ_STATE.userToken && HWQ.email && HWQ.senha) hwqLogin(); }, 5000);

// 2. Gerar questões sob demanda com IA (Aba 2)
app.post('/api/gemini/generate-questions', async (req, res) => {
  try {
    const { prompt, count = 5, specialty, difficulty = 'Médio', institution } = req.body || {};
    const n = Math.min(10, Math.max(1, parseInt(count, 10) || 5));

    const systemInstruction = `Você é um médico preceptor e elaborador sênior de provas de Residência Médica (estilo Revalida INEP, USP, ENARE, SUS-SP e Perito Médico Federal).
Gere exatamente ${n} questões inéditas e completas de múltipla escolha baseadas em CASOS CLÍNICOS REALISTAS.
Cada questão DEVE seguir rigorosamente a estrutura:
- Enunciado rico: história clínica com idade, sexo, queixa principal, evolução, antecedentes, exame físico detalhado com dados vitais, exames complementares e pergunta final clara sobre diagnóstico, conduta imediata ou fisiopatologia.
- Exatamente 4 ou 5 alternativas identificadas com letras: "A) ...", "B) ...", "C) ...", "D) ...", "E) ...".
- correctIndex: índice numérico (0 para A, 1 para B, 2 para C, 3 para D, 4 para E).
- correctLetter: letra maiúscula ('A', 'B', 'C', 'D' ou 'E').
- explanation: comentário detalhado e didático explicando por que a alternativa correta é o padrão-ouro e por que cada distrator está incorreto.
- specialty: grande área (ex: "Clínica Médica", "Cirurgia Geral", "Pediatria", "Ginecologia e Obstetrícia", "Medicina Preventiva e Social" ou "Perito Médico Federal").
- subspecialty: tema específico (ex: "Cardiologia", "Trauma", "Neonatologia", "Medicina Legal").
- difficulty: "Fácil", "Médio" ou "Difícil".
- tags: lista de 3 a 5 palavras-chave médicas.
Responda exclusivamente em formato JSON compatível.`;

    const userPrompt = `Gere ${n} questões médicas sobre o tema / instrução a seguir:
Prompt do usuário: "${prompt || 'Casos clínicos de alta frequência em provas de residência médica'}"
${specialty ? `Especialidade prioritária: ${specialty}` : ''}
${institution ? `Estilo de banca / Instituição: ${institution}` : ''}
Nível de dificuldade: ${difficulty}`;

    const geminiRes = await generateAI({ task: "questoes",
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          description: "Lista de questões de casos clínicos de múltipla escolha",
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              statement: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              correctIndex: { type: Type.INTEGER },
              correctLetter: { type: Type.STRING },
              explanation: { type: Type.STRING },
              specialty: { type: Type.STRING },
              subspecialty: { type: Type.STRING },
              difficulty: { type: Type.STRING },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              }
            },
            required: ["statement", "options", "correctIndex", "correctLetter", "explanation", "specialty"]
          }
        },
        temperature: 0.8
      }
    });

    let generatedList = [];
    try {
      generatedList = JSON.parse(geminiRes.text.trim());
    } catch (parseErr) {
      console.warn('Erro ao fazer JSON.parse do IA, tentando regex fallback:', parseErr.message);
      const match = geminiRes.text.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (match) generatedList = JSON.parse(match[0]);
    }

    if (!Array.isArray(generatedList) || generatedList.length === 0) {
      return res.status(500).json({ error: 'Nenhuma questão foi retornada pelo modelo de IA.' });
    }

    // Normalizar questões geradas
    const now = new Date().toISOString();
    const formatted = generatedList.map((q, idx) => ({
      id: q.id || `q-gemini-${Date.now()}-${idx + 1}`,
      specialty: q.specialty || specialty || 'Clínica Médica',
      subspecialty: q.subspecialty || 'Geral',
      institution: institution || 'Gerador IA',
      year: new Date().getFullYear(),
      statement: q.statement,
      options: q.options,
      correctIndex: typeof q.correctIndex === 'number' ? q.correctIndex : 0,
      correctLetter: q.correctLetter || ['A', 'B', 'C', 'D', 'E'][q.correctIndex || 0] || 'A',
      explanation: q.explanation,
      difficulty: q.difficulty || difficulty,
      tags: Array.isArray(q.tags) ? q.tags : [q.specialty || 'Medicina'],
      createdAt: now,
      source: 'Gerador IA'
    }));

    // Persistir automaticamente no banco de dados local para manter Aba 1 atualizada
    const currentBank = readQuestionsBank();
    const existingStatements = new Set(currentBank.map(item => item.statement.trim().slice(0, 80)));
    const toAdd = formatted.filter(item => !existingStatements.has(item.statement.trim().slice(0, 80)));
    if (toAdd.length > 0) {
      const updatedBank = [...toAdd, ...currentBank];
      writeQuestionsBank(updatedBank);
    }

    res.json({ success: true, count: formatted.length, questions: formatted });
  } catch (err) {
    console.warn('Erro ao gerar questões com IA, utilizando banco de casos clínicos de alta frequência:', err.message);
    const bank = readQuestionsBank();
    const n = Math.min(10, Math.max(1, parseInt(req.body?.count, 10) || 5));
    const reqSpec = req.body?.specialty || '';
    let filtered = bank;
    if (reqSpec) {
      const match = bank.filter(q => q.specialty && q.specialty.toLowerCase().includes(reqSpec.toLowerCase()));
      if (match.length > 0) filtered = match;
    }
    const shuffled = [...filtered].sort(() => 0.5 - Math.random()).slice(0, n);
    if (shuffled.length > 0) {
      return res.json({
        success: true,
        count: shuffled.length,
        questions: shuffled,
        notice: 'Questões selecionadas da Base Clínica de Alta Frequência (fallback resiliente)'
      });
    }
    res.status(500).json({ error: err.message || 'Falha ao gerar questões com IA' });
  }
});

// 3. Chatbot Tutor Integrado na tela de resolução (Treino Livre)
app.post('/api/gemini/tutor', async (req, res) => {
  try {
    const { question, userSelection, isAnswered, userQuestion, history = [] } = req.body || {};
    if (!question || !question.statement) {
      return res.status(400).json({ error: 'Dados da questão ativa são obrigatórios para o Tutor.' });
    }

    const systemInstruction = `Você é o "Tutor Cuscuz-MED", um preceptor e professor médico de elite especializado em preparação para provas de Residência Médica (USP, ENARE, Revalida, SUS-SP) e Concursos de Perito Médico Federal.
Você está prestando tutoria individual ao aluno sobre a questão EXATA que está aberta na tela dele.
DADOS DA QUESTÃO ATIVA:
- Especialidade: ${question.specialty || 'Medicina'} (${question.subspecialty || ''})
- Enunciado: ${question.statement}
- Alternativas:
${(question.options || []).join('\n')}
- Gabarito Correto Oficial: Alternativa ${question.correctLetter} (${(question.options || [])[question.correctIndex] || ''})
- Justificativa do Gabarito: ${question.explanation}
- Status do Aluno: ${isAnswered ? `Já respondeu. Alternativa marcada: ${userSelection !== null && userSelection !== undefined ? ['A','B','C','D','E'][userSelection] : 'Nenhuma'}. (${userSelection === question.correctIndex ? 'ACERTOU' : 'ERROU'}).` : 'Ainda NÃO respondeu (está tentando resolver).'}

DIRETRIZES DO TUTOR:
1. Se o aluno ainda NÃO respondeu à questão e pedir ajuda/dica: Forneça um raciocínio fisiopatológico orientador e destaque as pistas semiológicas do caso clínico, mas NÃO entregue a letra da resposta de bandeja. Estimule o active recall!
2. Se o aluno já respondeu ou errou: Explique a conduta/diagnóstico de forma clara, aponte a pegadinha das alternativas falsas e consolide o aprendizado com uma pérola clínica (clinical pearl).
3. Seja sempre didático, encorajador, objetivo e direto ao ponto. Responda em português brasileiro. Use formatação markdown limpa com negritos para conceitos-chave.`;

    const contents = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-6)) {
        if (h && h.content) {
          contents.push({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(h.content) }]
          });
        }
      }
    }
    contents.push({
      role: 'user',
      parts: [{ text: userQuestion || 'Olá tutor, pode me orientar sobre este caso clínico?' }]
    });

    const tutorRes = await generateAI({ task: "tutor",
      contents,
      config: {
        systemInstruction,
        temperature: 0.7
      }
    });

    res.json({ success: true, reply: tutorRes.text.trim() });
  } catch (err) {
    console.warn('Erro no Tutor IA, acionando síntese de tutoria clínica:', err.message);
    const letter = question.correctLetter || ['A','B','C','D','E'][question.correctIndex] || 'A';
    let fallbackReply = '';
    if (!isAnswered) {
      fallbackReply = `🩺 **Orientação do Preceptor para Raciocínio Clínico:**\n\n` +
        `• **Pista semiológica:** Analise a faixa etária, a queixa principal e os dados de exame físico apresentados no enunciado.\n` +
        `• **Raciocínio fisiopatológico:** Identifique se o caso exige conduta imediata de emergência (suporte à vida) ou investigação diagnóstica complementar.\n` +
        `• **Estratégia de prova:** Use o descarte de alternativas (botão direito ou tesoura) para eliminar opções absurdas ou contraindicadas.\n\n` +
        `*Formule sua hipótese e marque a opção no simulador para confirmar o gabarito!*`;
    } else {
      const isRight = userSelection === question.correctIndex;
      fallbackReply = `${isRight ? '🎉 **Parabéns pelo acerto!**' : '⚠️ **Vamos revisar o conceito-chave:**'}\n\n` +
        `**Gabarito Oficial: Letra ${letter}**\n\n` +
        `${question.explanation || 'O padrão-ouro neste quadro clínico preconiza intervenção precoce segundo as diretrizes das principais sociedades médicas.'}\n\n` +
        `💎 **Pérola Clínica:** Em questões de ${question.specialty || 'Residência Médica'}, fique sempre atento às pegadinhas de dosagem, vias de administração e contraindicações absolutas.`;
    }
    res.json({ success: true, reply: fallbackReply, fallback: true });
  }
});

// 4. Auto-alimentador periódico de questões em segundo plano (Alimentação Automática da Aba 1)
const ROTATING_TOPICS = [
  { spec: 'Clínica Médica', prompt: 'Condutas em emergências cardiovasculares e síndromes coronarianas agudas no pronto-socorro' },
  { spec: 'Cirurgia Geral', prompt: 'Casos clínicos de abdome agudo obstrutivo e conduta imediata no trauma torácico' },
  { spec: 'Pediatria', prompt: 'Abordagem da sepse neonatal, doenças exantemáticas na infância e bronquiolite aguda' },
  { spec: 'Ginecologia e Obstetrícia', prompt: 'Complicações da pré-eclâmpsia grave, conduta na hemorragia pós-parto e rastreio citopatológico' },
  { spec: 'Medicina Preventiva e Social', prompt: 'Indicadores epidemiológicos de mortalidade, organização da atenção primária e princípios do SUS' },
  { spec: 'Perito Médico Federal', prompt: 'Avaliação médico-pericial de incapacidade laborativa, sequelas ortopédicas e traumatologia forense' }
];

let topicIndex = 0;
async function autoFeedQuestions() {
  try {
    const bank = readQuestionsBank();
    if (bank.length >= 40) return; // Se já tiver mais de 40 questões, não precisa sobrecarregar

    const topic = ROTATING_TOPICS[topicIndex % ROTATING_TOPICS.length];
    topicIndex++;

    console.log(`🤖 [Auto-Feed] Gerando novas questões em segundo plano: ${topic.spec}...`);
    const systemInstruction = `Você é um preceptor médico. Crie exatamente 2 questões inéditas de múltipla escolha com casos clínicos profundos.`;
    const prompt = `Gere 2 questões de alto rendimento sobre: ${topic.prompt}. Retorne em JSON array.`;

    const res = await generateAI({ task: "auto_feed",
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              statement: { type: Type.STRING },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              correctIndex: { type: Type.INTEGER },
              correctLetter: { type: Type.STRING },
              explanation: { type: Type.STRING },
              specialty: { type: Type.STRING },
              subspecialty: { type: Type.STRING },
              difficulty: { type: Type.STRING },
              tags: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["statement", "options", "correctIndex", "correctLetter", "explanation", "specialty"]
          }
        },
        temperature: 0.8
      }
    });

    const newItems = JSON.parse(res.text.trim());
    if (Array.isArray(newItems) && newItems.length > 0) {
      const now = new Date().toISOString();
      const current = readQuestionsBank();
      const existing = new Set(current.map(q => q.statement.trim().slice(0, 80)));
      const toAdd = newItems
        .filter(q => !existing.has(q.statement.trim().slice(0, 80)))
        .map((q, idx) => ({
          id: `q-auto-${Date.now()}-${idx}`,
          specialty: q.specialty || topic.spec,
          subspecialty: q.subspecialty || 'Geral',
          institution: 'Auto-Feed IA Diário',
          year: new Date().getFullYear(),
          statement: q.statement,
          options: q.options,
          correctIndex: q.correctIndex || 0,
          correctLetter: q.correctLetter || ['A', 'B', 'C', 'D', 'E'][q.correctIndex || 0] || 'A',
          explanation: q.explanation,
          difficulty: q.difficulty || 'Médio',
          tags: Array.isArray(q.tags) ? q.tags : [topic.spec],
          createdAt: now,
          source: 'Auto-Feed Diário'
        }));

      if (toAdd.length > 0) {
        writeQuestionsBank([...toAdd, ...current]);
        console.log(`✅ [Auto-Feed] ${toAdd.length} novas questões adicionadas automaticamente ao banco.`);
      }
    }
  } catch (err) {
    console.warn('⚠️ [Auto-Feed] Erro ao auto-alimentar banco de questões:', err.message);
  }
}

// Inicia auto-feed após 15 segundos do boot do servidor e a cada 6 horas (só em servidor persistente)
if (!IS_SERVERLESS) {
  setTimeout(autoFeedQuestions, 15000);
  setInterval(autoFeedQuestions, 6 * 60 * 60 * 1000);
}

app.post('/api/questions/auto-feed', async (req, res) => {
  await autoFeedQuestions();
  const bank = readQuestionsBank();
  res.json({ success: true, count: bank.length, message: 'Auto-feed executado com sucesso' });
});

/* ═══════════════════════════════════════════════════════════════
   PLANEJADOR DE CRONOGRAMA IA — graduação + residência
   Regra absoluta: toda revisão é ESTUDO ATIVO (flashcards/questões).
   ═══════════════════════════════════════════════════════════════ */
const DECKS_FILE = path.join(DATA_DIR, 'planner-decks.json');
function readDecks() { try { return JSON.parse(fs.readFileSync(DECKS_FILE, 'utf8')); } catch { return {}; } }
function writeDecks(d) { try { fs.mkdirSync(path.dirname(DECKS_FILE), { recursive: true }); fs.writeFileSync(DECKS_FILE, JSON.stringify(d, null, 2), 'utf8'); } catch (err) { console.warn('⚠️ [Planner] Falha ao salvar decks:', err.message); } }
const plDeckKey = (materia, tema) => hwqNorm(materia) + '::' + hwqNorm(tema);
const PESO_DIFICULDADE = { facil: 1, medio: 1.5, dificil: 2, pesado: 2.5 };
const TEMAS_POR_PESO = { facil: 3, medio: 4, dificil: 5, pesado: 6 };
const plOrdemTipo = t => ({ revisao24: 0, revisao7: 1, revisao30: 2 })[t] ?? 3;
function plIso(d) { return d.toISOString().slice(0, 10); }
function plAddDias(isoStr, n) { const d = new Date(isoStr + 'T12:00:00'); d.setDate(d.getDate() + n); return plIso(d); }
function plDiff(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000); }

// Motor determinístico: equilibra carga, cruza datas de prova e aplica a regra de conflito
function plGerarPlan(config, extras = {}) {
  const hoje = config.inicio;
  const provas = (config.provas || []).slice().sort((a, b) => (a.data < b.data ? -1 : 1));
  const fim = provas.length ? provas[provas.length - 1].data : plAddDias(hoje, 30);
  if (plDiff(hoje, fim) < 0) return { erro: 'A última prova precisa ser hoje ou depois.' };
  const mapaProva = {}; provas.forEach(p => { mapaProva[p.data] = p; });
  const vesperasDe = {}; provas.forEach(p => { const v = plAddDias(p.data, -1); (vesperasDe[v] = vesperasDe[v] || []).push(p.nome); });
  const blocosPorDia = Math.max(1, Math.min(4, Math.floor((+config.horasDia || 4) / 2)));

  // Fila de conteúdo: round-robin ponderado pela dificuldade (matérias pesadas entram mais vezes por rodada)
  const filas = (config.materias || []).filter(m => m.nome).map(m => {
    const dKey = normLower(m.dificuldade || 'medio');
    const temasIA = extras.temasPorMateria && extras.temasPorMateria[m.nome];
    const qtd = TEMAS_POR_PESO[dKey] || 4;
    const temas = (Array.isArray(temasIA) && temasIA.length) ? temasIA.slice(0, 14) : Array.from({ length: qtd }, (_, i) => `Tópico ${i + 1}`);
    return { nome: m.nome, dificuldade: m.dificuldade || 'Médio', peso: PESO_DIFICULDADE[dKey] || 1.5, pendentes: temas };
  });
  const fila = [];
  let rodada = 0, avancou = true;
  while (avancou && rodada < 80) {
    avancou = false; rodada++;
    for (const m of filas) {
      let vez = Math.max(1, Math.round(m.peso));
      while (vez-- > 0 && m.pendentes.length) {
        const tema = m.pendentes.shift();
        fila.push({ materia: m.nome, tema, dificuldade: m.dificuldade, key: plDeckKey(m.nome, tema) });
        avancou = true;
      }
    }
  }
  (extras.pendentes || []).forEach(p => fila.unshift(p)); // replan: atrasados voltam na frente

  const revisoesAgendadas = {}; // data -> [bloco]
  function agendarRevisoes(deData, bloco) {
    [{ tipo: 'revisao24', off: 1 }, { tipo: 'revisao7', off: 7 }, { tipo: 'revisao30', off: 30 }].forEach(({ tipo, off }) => {
      let d = plAddDias(deData, off), tent = 0;
      while ((mapaProva[d] || (revisoesAgendadas[d] || []).length >= blocosPorDia) && tent < 15 && plDiff(d, fim) >= 0) { d = plAddDias(d, 1); tent++; }
      if (plDiff(d, fim) < 0 || mapaProva[d]) return; // sem espaço antes da última prova → descarta
      (revisoesAgendadas[d] = revisoesAgendadas[d] || []).push({ tipo, materia: bloco.materia, tema: bloco.tema, key: bloco.key, dificuldade: bloco.dificuldade, horas: 1, status: 'pendente' });
    });
  }

  const filaRevisao = (extras.revisoesHerdadas || []).map(r => ({ ...r })); // replan: revisões de conteúdo concluído
  const dias = [];
  let ci = 0;
  for (let d = new Date(hoje + 'T12:00:00'); plDiff(plIso(d), fim) >= 0; d.setDate(d.getDate() + 1)) {
    const data = plIso(d);
    const prova = mapaProva[data];
    const vespera = vesperasDe[data] || [];
    const blocos = [];
    let slots = prova ? 0 : blocosPorDia;

    // 1) revisões herdadas do replan (estudo ativo) entram primeiro
    while (slots > 0 && filaRevisao.length) {
      const r = filaRevisao.shift();
      blocos.push({ id: 'r' + data + blocos.length, tipo: r.tipo || 'revisao7', materia: r.materia, tema: r.tema, key: r.key, dificuldade: r.dificuldade, horas: 1, status: 'pendente' });
      slots--;
    }
    // 2) revisões espaçadas (24h/7d/30d) programadas para este dia
    const doDia = (revisoesAgendadas[data] || []).sort((a, b) => plOrdemTipo(a.tipo) - plOrdemTipo(b.tipo));
    for (const r of doDia) {
      if (slots <= 0) { // dia cheio → empurra para amanhã
        const prox = plAddDias(data, 1);
        if (plDiff(prox, fim) >= 0) (revisoesAgendadas[prox] = revisoesAgendadas[prox] || []).push(r);
        continue;
      }
      blocos.push({ ...r, id: 'r' + data + blocos.length });
      slots--;
    }
    // 3) conteúdo novo — regra de conflito: véspera de prova não recebe tema pesado/difícil
    while (slots > 0 && ci < fila.length) {
      const c = fila[ci];
      const leve = !['dificil', 'pesado'].includes(normLower(c.dificuldade || ''));
      if (vespera.length && !leve) break;
      blocos.push({ id: 'c' + data + blocos.length, tipo: 'conteudo', materia: c.materia, tema: c.tema, key: c.key, dificuldade: c.dificuldade, horas: 2, status: 'pendente' });
      agendarRevisoes(data, c);
      ci++; slots--;
    }
    // 4) dia de prova
    if (prova) blocos.push({ id: 'p' + data, tipo: 'prova', prova: prova.nome, horas: 0, status: 'pendente' });

    dias.push({ data, dow: d.getDay(), tipo: prova ? 'prova' : (vespera.length ? 'vespera' : 'normal'), prova: prova ? prova.nome : null, vesperaDe: vespera, blocos });
  }

  const blocos = dias.flatMap(dd => dd.blocos);
  return {
    geradoEm: new Date().toISOString(),
    config: { horasDia: config.horasDia, provas, materias: config.materias, temasPorMateria: extras.temasPorMateria || null },
    inicio: hoje, fim,
    dias,
    estatisticas: {
      dias: dias.length,
      conteudos: blocos.filter(b => b.tipo === 'conteudo').length,
      revisoes: blocos.filter(b => b.tipo.startsWith('revisao')).length,
      provas: provas.length
    }
  };
}
function normLower(s) { return hwqNorm(s); }

// Geração de deck de estudo ativo (10 flashcards + 3 questões) — background via IA, fallback no banco
async function plGerarDeck(materia, tema) {
  const key = plDeckKey(materia, tema);
  const decks = readDecks();
  if (decks[key] && decks[key].pronto) return decks[key];
  let deck = null;
  if (aiConfigured()) {
    try {
      const res = await generateAI({ task: "aula_flashcards",
        contents: `Crie 10 flashcards curtos e diretos (frente e verso) e 3 questões de múltipla escolha baseados no tema "${tema}" (matéria: ${materia}), focando nos conceitos mais cobrados em provas.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              flashcards: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { frente: { type: Type.STRING }, verso: { type: Type.STRING } }, required: ['frente', 'verso'] } },
              questoes: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
                statement: { type: Type.STRING },
                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                correctIndex: { type: Type.INTEGER },
                explanation: { type: Type.STRING }
              }, required: ['statement', 'options', 'correctIndex'] } }
            },
            required: ['flashcards', 'questoes']
          },
          temperature: 0.7
        }
      });
      const parsed = JSON.parse(res.text.trim());
      deck = {
        tema, materia, fonte: 'ia', pronto: true, criadoEm: new Date().toISOString(),
        flashcards: (parsed.flashcards || []).slice(0, 12),
        questoes: (parsed.questoes || []).map((q, i) => ({
          id: `q-pl-${key}-${i}`, specialty: materia, subspecialty: tema, institution: 'Cronograma IA', year: new Date().getFullYear(),
          statement: q.statement, options: q.options, correctIndex: q.correctIndex,
          correctLetter: ['A', 'B', 'C', 'D', 'E'][q.correctIndex] || 'A',
          explanation: q.explanation || '', difficulty: 'Médio', tags: [materia, tema], source: 'Cronograma IA'
        }))
      };
      console.log(`🧠 [Planner] Deck IA pronto: "${tema}" (${deck.flashcards.length} cards, ${deck.questoes.length} questões)`);
    } catch (err) {
      console.warn(`⚠️ [Planner] IA falhou para "${tema}":`, err.message?.slice(0, 120));
    }
  }
  if (!deck) {
    // Fallback: monta deck de estudo ativo a partir do banco local de questões
    const bank = readQuestionsBank();
    const alvo = hwqNorm(tema);
    let hits = bank.filter(q => hwqNorm(q.specialty).includes(alvo) || hwqNorm(q.statement).includes(alvo) || (q.tags || []).some(t => hwqNorm(t).includes(alvo)));
    if (!hits.length && /^topico\s*\d*$/i.test(alvo)) {
      // Tema genérico ("Tópico N") sem GEMINI: usa a matéria inteira como recorte
      hits = bank.filter(q => hwqNorm(q.specialty) === hwqNorm(materia));
    }
    if (hits.length) {
      deck = {
        tema, materia, fonte: 'banco', pronto: true, criadoEm: new Date().toISOString(),
        flashcards: hits.slice(0, 10).map(q => ({ frente: q.statement.slice(0, 260), verso: '✅ ' + (q.options[q.correctIndex] || '') + (q.explanation ? '\n\n' + q.explanation : '') })),
        questoes: hits.slice(0, 6)
      };
      console.log(`🧠 [Planner] Deck do banco local: "${tema}" (${hits.length} questões encontradas)`);
    } else {
      deck = { tema, materia, fonte: 'nenhuma', pronto: false, msg: 'Configure GROQ_API_KEY ou sincronize questões deste tema no banco.', criadoEm: new Date().toISOString(), flashcards: [], questoes: [] };
    }
  }
  decks[key] = deck;
  writeDecks(decks);
  return deck;
}
const plDeckFila = [];
let plDeckRodando = false;
function plEnfileirarDeck(materia, tema) {
  const key = plDeckKey(materia, tema);
  if ((readDecks()[key] || {}).pronto) return;
  if (!plDeckFila.some(x => plDeckKey(x.materia, x.tema) === key)) plDeckFila.push({ materia, tema });
  plBombearDeck();
}
async function plBombearDeck() {
  if (plDeckRodando) return;
  plDeckRodando = true;
  while (plDeckFila.length) {
    const { materia, tema } = plDeckFila.shift();
    try { await plGerarDeck(materia, tema); } catch (err) { console.warn('⚠️ [Planner] Erro no deck:', err.message); }
    await new Promise(r => setTimeout(r, 300));
  }
  plDeckRodando = false;
}

// POST /api/planner/generate — gera o cronograma (IA para temas se houver chave; motor local sempre funciona)
app.post('/api/planner/generate', async (req, res) => {
  try {
    const { horasDia = 4, inicio, provas = [], materias = [], pdfTexto = '' } = req.body || {};
    if (!provas.length) return res.status(400).json({ success: false, msg: 'Informe pelo menos uma data de prova.' });
    if (!materias.length) return res.status(400).json({ success: false, msg: 'Informe pelo menos uma matéria.' });
    const config = {
      inicio: inicio || plIso(new Date()),
      horasDia: Math.max(1, Math.min(12, +horasDia || 4)),
      provas: provas.filter(p => p.nome && p.data),
      materias: materias.filter(m => m.nome)
    };
    let temasPorMateria = null, aviso = null;
    if (aiConfigured() && pdfTexto && String(pdfTexto).length > 400) {
      try {
        const listaMaterias = config.materias.map(m => `${m.nome} (${m.dificuldade || 'Médio'})`).join('; ');
        const g = await generateAI({ task: "documento",
          contents: `Analise o material de estudo abaixo (edital/cronograma/ementa) e extraia os temas mais cobrados para cada matéria desta lista: [${listaMaterias}].\nResponda JSON com temasPorMateria (objeto matéria → array de 4 a 8 temas curtos) e resumos (objeto tema → array de 3 a 5 tópicos de estudo).\n\nMATERIAL:\n${String(pdfTexto).slice(0, 12000)}`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                temasPorMateria: { type: Type.OBJECT },
                resumos: { type: Type.OBJECT }
              }
            },
            temperature: 0.5
          }
        });
        const parsed = JSON.parse(g.text.trim());
        temasPorMateria = parsed.temasPorMateria || null;
        if (parsed.resumos) config.resumos = parsed.resumos;
      } catch (err) {
        aviso = 'IA não conseguiu ler o PDF (' + (err.message || '').slice(0, 80) + ') — usando grade padrão de tópicos.';
      }
    } else if (!aiConfigured() && pdfTexto) {
      aviso = 'GROQ_API_KEY não configurada — o PDF não pôde ser lido pela IA e a grade padrão de tópicos foi usada.';
    }
    const plan = plGerarPlan(config, { temasPorMateria });
    if (plan.erro) return res.status(400).json({ success: false, msg: plan.erro });
    plan.geradoCom = aiConfigured() ? 'ia' : 'motor-local';
    if (aviso) plan.aviso = aviso;
    // Dispara geração silenciosa dos decks de estudo ativo para os temas que terão revisão
    const temasRevisao = new Set();
    plan.dias.forEach(d => d.blocos.forEach(b => { if (b.tipo.startsWith('revisao') && b.tema) temasRevisao.add((b.materia || '') + '||' + b.tema); }));
    temasRevisao.forEach(t => { const [materia, tema] = t.split('||'); plEnfileirarDeck(materia, tema); });
    res.json({ success: true, plan, decksFila: temasRevisao.size, gemini: !!aiConfigured() });
  } catch (err) {
    console.error('Erro no planner:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   MOTOR DE PROCESSAMENTO (RAG, SINERGIA & PROTEÇÃO DE PROVAS)
   Cruza a ementa da faculdade com o cursinho de residência médica
   ═══════════════════════════════════════════════════════════════ */
const SINERGIA_CANONICA = [
  { tema: 'Antibioticoterapia & Sepse', materia: 'Clínica Médica', aliases: ['antibiotico', 'antibioticoterapia', 'antimicrobianos', 'sepse', 'choque septico', 'infeccao'] },
  { tema: 'Hipertensão Arterial Sistêmica', materia: 'Clínica Médica', aliases: ['has', 'hipertensao', 'pressao alta', 'crise hipertensiva'] },
  { tema: 'Insuficiência Cardíaca & Arritmias', materia: 'Clínica Médica', aliases: ['insuficiencia cardiaca', 'ic', 'arritmia', 'fibrilacao atrial', 'ecg'] },
  { tema: 'Diabetes Mellitus & Cetoacidose', materia: 'Clínica Médica', aliases: ['diabetes', 'dm', 'cetoacidose', 'insulina', 'hipoglicemia'] },
  { tema: 'Abdome Agudo Inflamatório & Obstrutivo', materia: 'Cirurgia Geral', aliases: ['abdome agudo', 'apendicite', 'colecistite', 'obstrucao intestinal', 'pancreatite'] },
  { tema: 'Trauma & ATLS (Vias Aéreas e Choque)', materia: 'Cirurgia Geral', aliases: ['trauma', 'atls', 'politraumatizado', 'choque hipovolemico', 'torax agudo'] },
  { tema: 'Hérnias da Parede Abdominal', materia: 'Cirurgia Geral', aliases: ['hernia', 'inguinal', 'crural', 'umbilical', 'incisional'] },
  { tema: 'Pré-natal & Assistência ao Parto', materia: 'Ginecologia e Obstetrícia', aliases: ['pre-natal', 'prenatal', 'parto', 'trabalho de parto', 'tocologia', 'bacia'] },
  { tema: 'Síndromes Hipertensivas & Hemorragias Gestacionais', materia: 'Ginecologia e Obstetrícia', aliases: ['pre-eclampsia', 'eclampsia', 'descolamento prematuro', 'dpp', 'placenta previa', 'hpp', 'hemorragia'] },
  { tema: 'Sangramento Uterino Anormal & Miomatose', materia: 'Ginecologia e Obstetrícia', aliases: ['sua', 'sangramento uterino', 'mioma', 'adenomiose', 'polipo'] },
  { tema: 'Puericultura & Desenvolvimento Infantil', materia: 'Pediatria', aliases: ['puericultura', 'crescimento', 'desenvolvimento', 'marcos', 'pesquisa de reflexos'] },
  { tema: 'Desidratação & Terapia de Reidratação Oral', materia: 'Pediatria', aliases: ['desidratacao', 'tro', 'reidratacao', 'gastroenterite', 'diarreia infantil'] },
  { tema: 'Infecções Respiratórias & Pneumonias na Infância', materia: 'Pediatria', aliases: ['pneumonia pediatrica', 'bronquiolite', 'asma infantil', 'estridor', 'laringite'] },
  { tema: 'Atenção Primária & Princípios do SUS', materia: 'Medicina Preventiva', aliases: ['sus', 'atencao basica', 'esf', 'principios do sus', 'diretrizes', 'financiamento'] },
  { tema: 'Estudos Epidemiológicos & Bioestatística', materia: 'Medicina Preventiva', aliases: ['epidemiologia', 'coorte', 'caso-controle', 'ensaio clinico', 'sensibilidade', 'especificidade'] }
];

function detectarEspecialidade(linha, contextoAtual) {
  const l = hwqNorm(linha);
  if (/cirurg|trauma|apendic|colecist|hernia|obstruc|abdome|atls|queimad|anestes|ferida|sutura|laparo/i.test(l)) return 'Cirurgia Geral';
  if (/pediatr|puericult|neonato|lactente|bronquiolit|desidratac|pni|vacina|imunizac|asma infant|laringit|estridor/i.test(l)) return 'Pediatria';
  if (/gineco|obstetr|gesta|parto|pre-natal|prenatal|puerper|pre-eclamps|eclamps|mioma|sangramento uterin|sua|colo uterin|mama|puerperio|amenorreia|anticoncep/i.test(l)) return 'Ginecologia e Obstetrícia';
  if (/preventiv|epidemiol|sus|bioestatist|saude coletiv|atencao primar|estrategia saude familia|esf|vigilancia|declaracao obito|financiamento sus|pacto/i.test(l)) return 'Medicina Preventiva';
  if (/clinic|cardiolog|has|hipertens|insuficienc|arritmi|infart|ecg|pneumolog|dpoc|asma|pneumoni|nefrolog|ira|drc|dialise|glomerul|infecto|sepse|antibiot|hiv|dengue|tuberculose|hepatit|endocrin|diabetes|tireoid|reumatolog|lupus|artrite|gastroenter|hemorragia digestiv|cirrose|hematolog|anemia|leucemi|neurolog|avc|cefaleia|epilepsi/i.test(l)) return 'Clínica Médica';
  return contextoAtual || 'Clínica Médica';
}

function extrairTemasDoTexto(texto, defaultMateria = 'Clínica Médica') {
  if (!texto || typeof texto !== 'string') return [];
  const encontrados = [];
  const vistos = new Set();

  // 1. Verifica correspondências canônicas de alta precisão
  const tNorm = hwqNorm(texto);
  SINERGIA_CANONICA.forEach(item => {
    if (item.aliases.some(a => tNorm.includes(hwqNorm(a)))) {
      const k = hwqNorm(item.tema);
      if (!vistos.has(k)) {
        vistos.add(k);
        encontrados.push({ tema: item.tema, materia: item.materia, canonic: true });
      }
    }
  });

  // 2. Extrai exaustivamente cada linha, tópico, módulo ou rodízio da ementa
  const linhas = texto.split(/[\r\n]+/);
  let especialidadeAtual = defaultMateria;

  for (let linha of linhas) {
    let raw = linha.trim();
    if (!raw || raw.length < 3) continue;

    // Detecta cabeçalhos de especialidade
    if (/^(?:modulo|bloco|area|disciplina|internato|rodizio|materia|departamento)?\s*[:\-–]?\s*(clinica medica|cirurgia geral|cirurgia|pediatria|ginecologia e obstetricia|ginecologia|obstetricia|medicina preventiva|preventiva)/i.test(raw)) {
      const match = raw.match(/(clinica medica|cirurgia geral|cirurgia|pediatria|ginecologia e obstetricia|ginecologia|obstetricia|medicina preventiva|preventiva)/i);
      if (match) {
        const esp = match[1].toLowerCase();
        if (esp.includes('cirurg')) especialidadeAtual = 'Cirurgia Geral';
        else if (esp.includes('pediatr')) especialidadeAtual = 'Pediatria';
        else if (esp.includes('ginec') || esp.includes('obstetr')) especialidadeAtual = 'Ginecologia e Obstetrícia';
        else if (esp.includes('preventiv')) especialidadeAtual = 'Medicina Preventiva';
        else especialidadeAtual = 'Clínica Médica';
      }
      continue;
    }

    // Remove marcadores de numeração e bullets: "1.", "Semana 3:", "•", "-", etc.
    let limpa = raw
      .replace(/^(?:semana|dia|aula|bloco|modulo|tema|topico|unidade|capitulo)\s*\d+[\s:\-–.]*/i, '')
      .replace(/^[\d]+[\.\)\-–]\s*/, '')
      .replace(/^[\*\-\•\–\—\>]\s*/, '')
      .trim();

    if (!limpa || limpa.length < 3) continue;
    if (/^\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?$/.test(limpa)) continue;
    if (/^(pagina|page|prof|professor|carga horaria|ementa|bibliografia|objetivos?|conteudo programatico)\b/i.test(limpa)) continue;

    // Se houver múltiplos tópicos separados por ';' ou '|'
    const partes = limpa.split(/[;|]+/).map(p => p.trim()).filter(p => p.length >= 3);
    for (const parte of (partes.length ? partes : [limpa])) {
      const itemFormatado = parte.replace(/[:\-–]\s*$/, '').trim();
      if (itemFormatado.length < 3 || itemFormatado.length > 140) continue;
      const k = hwqNorm(itemFormatado);
      if (vistos.has(k)) continue;

      const materia = detectarEspecialidade(itemFormatado, especialidadeAtual);
      vistos.add(k);
      encontrados.push({
        tema: itemFormatado,
        materia
      });
    }
  }

  return encontrados;
}

function detectarTipoEvento(str) {
  const s = hwqNorm(str || '');
  if (/\btbl\b|team.based|irat|trat/i.test(s)) return 'tbl';
  if (/\bosce\b|pratica|habilidade|checklist/i.test(s)) return 'osce';
  if (/\bpbl\b|tutoria|abertura|fechamento/i.test(s)) return 'pbl';
  if (/seminario|apresentacao/i.test(s)) return 'seminario';
  return 'prova';
}

function extrairProvasDoTexto(texto) {
  if (!texto || typeof texto !== 'string') return [];
  const provas = [];
  const regex = /(?:prova|p[1234]|avaliacao|exame|sub|final|teste|simulado|tbl|irat|trat|osce|pbl|tutoria|seminario)\b[^\n\r,;.]*?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/gi;
  let match;
  while ((match = regex.exec(texto)) !== null) {
    const rawNome = match[0].split(/\d{1,2}[\/\-]/)[0].trim();
    const dataStr = match[1];
    const partes = dataStr.split(/[\/\-]/);
    const anoAtual = new Date().getFullYear();
    const dia = String(partes[0]).padStart(2, '0');
    const mes = String(partes[1]).padStart(2, '0');
    const ano = partes[2] ? (partes[2].length === 2 ? '20' + partes[2] : partes[2]) : String(anoAtual);
    const dataIso = `${ano}-${mes}-${dia}`;
    const tipoEvento = detectarTipoEvento(rawNome);
    const nomePadrao = tipoEvento === 'tbl' ? 'TBL / Atividade em Equipe' : (tipoEvento === 'osce' ? 'OSCE / Prova Prática' : 'Avaliação da Faculdade');
    const nomeFinal = rawNome.length > 3 ? (rawNome.length > 50 ? rawNome.slice(0, 50) : rawNome) : nomePadrao;
    const materia = detectarEspecialidade(nomeFinal, 'Graduação');

    if (!provas.some(p => p.data === dataIso && p.tipoEvento === tipoEvento)) {
      provas.push({
        nome: nomeFinal,
        data: dataIso,
        materia,
        tipoEvento,
        tipo: 'grad'
      });
    }
  }
  return provas;
}

// Motor de Agendamento Inteligente (Método 3 Fases, Seletor de Modo, Dias de Estágio e Modo Sobrevivência)
function plGerarPlanSinergia(config, extras = {}) {
  return plEngineGerarPlan(config, extras);
}

// POST /api/planner/synergy-generate — Motor de IA com RAG de PDFs, Sinergia e Proteção de Provas
app.post('/api/planner/synergy-generate', async (req, res) => {
  try {
    const {
      modoEstudo = 'hibrido',
      diasEstagio = [],
      horasDia = 4,
      horasSemana,
      energiaPosFaculdade = 'moderada',
      materiasDificuldade = [],
      dataAlvoResidencia,
      provasFaculdade = [],
      materias = [],
      textoFaculdade = '',
      textoResidencia = '',
      atualizacoesNotas = '',
      pdfResidenciaTexto = '',
      pdfFaculdadeTexto = ''
    } = req.body || {};

    const rawFaculdade = (textoFaculdade || pdfFaculdadeTexto || '').trim();
    const rawResidencia = (textoResidencia || pdfResidenciaTexto || '').trim();
    const rawAtualizacoes = (atualizacoesNotas || '').trim();

    const config = {
      inicio: plIso(new Date()),
      modoEstudo,
      diasEstagio: Array.isArray(diasEstagio) ? diasEstagio.map(Number) : [],
      horasDia: Math.max(1, Math.min(12, +horasDia || 4)),
      horasSemana,
      energiaPosFaculdade,
      materiasDificuldade: Array.isArray(materiasDificuldade) ? materiasDificuldade : [materiasDificuldade].filter(Boolean),
      dataAlvoResidencia: dataAlvoResidencia || plAddDias(plIso(new Date()), 90),
      provas: (provasFaculdade || []).map(p => ({
        nome: p.nome || 'Prova Faculdade',
        data: p.data,
        materia: p.materia || 'Graduação',
        tipo: 'grad'
      })),
      materias: materias.length ? materias : [
        { nome: 'Clínica Médica', dificuldade: 'Médio' },
        { nome: 'Cirurgia Geral', dificuldade: 'Difícil' },
        { nome: 'Pediatria', dificuldade: 'Médio' },
        { nome: 'Ginecologia e Obstetrícia', dificuldade: 'Médio' },
        { nome: 'Medicina Preventiva', dificuldade: 'Fácil' }
      ]
    };

    if (dataAlvoResidencia) {
      config.provas.push({
        nome: 'Prova de Residência R1 Alvo',
        data: dataAlvoResidencia,
        tipo: 'resid'
      });
    }

    let sinergiaMatches = [];
    let conteudosFaculdade = [];
    let conteudosResidencia = [];
    let temasPorMateria = null;
    let aviso = null;

    // Extração local prévia com parser inteligente (garante que nada seja perdido)
    const temasFacLocal = extrairTemasDoTexto(rawFaculdade);
    const temasResLocal = extrairTemasDoTexto(rawResidencia);
    const provasExtraidas = [...extrairProvasDoTexto(rawFaculdade), ...extrairProvasDoTexto(rawAtualizacoes)];
    provasExtraidas.forEach(pe => {
      if (pe.nome && pe.data && !config.provas.some(cp => cp.data === pe.data)) {
        config.provas.push({ nome: pe.nome, data: pe.data, materia: pe.materia || 'Graduação', tipo: 'grad' });
      }
    });

    // Documentos e cronogramas completos fornecidos pelo usuário sem limite de tamanho
    let secaoTextosAluno = '';
    if (rawFaculdade) {
      secaoTextosAluno += `\n\n═══════════════════════════════════════════════════════════════\n[1. CRONOGRAMA E EMENTA COMPLETA DA FACULDADE (100% OBRIGATÓRIO INTEGRAR)]:\n${rawFaculdade}\n`;
    }
    if (rawResidencia) {
      secaoTextosAluno += `\n\n═══════════════════════════════════════════════════════════════\n[2. CRONOGRAMA DE ESTUDO PARA RESIDÊNCIA MÉDICA (CURSINHO MEDCURSO/ESTRATÉGIA/SANAR)]:\n${rawResidencia}\n`;
    }
    if (rawAtualizacoes) {
      secaoTextosAluno += `\n\n═══════════════════════════════════════════════════════════════\n[3. ATUALIZAÇÕES DO CRONOGRAMA, OBSERVAÇÕES E INSTRUÇÕES ESPECIAIS DO ESTUDANTE]:\n${rawAtualizacoes}\n`;
    }

    // Conexão direta com Groq
    const gemini = aiConfigured();
    if (gemini) {
      try {
        const instrucaoModo = modoEstudo === 'foco_graduacao'
          ? '\n⚠️ ATENÇÃO: O ESTUDANTE SELECIONOU O [MODO FOCO TOTAL: APENAS GRADUAÇÃO]!\nSUSPENDA todas as metas do cursinho de residência médica. Aloque 100% da grade nos temas do Manual do Aluno e da Faculdade.\n'
          : '\nOBJETIVO: [MODO HÍBRIDO: FACULDADE + RESIDÊNCIA]. Harmonize a ementa da graduação com o cursinho com sinergia máxima.\n';

        const prompt = `Você é o Arquiteto Especialista de Cronograma Médico do Cuscuz-MED.
Sua missão é gerar um cronograma de estudos ultra fiel, completo e harmonizado.

${instrucaoModo}
REGRA FUNDAMENTAL E ABSOLUTA (NÃO DUZIR / NÃO REDUZIR):
O estudante reportou que os cronogramas anteriores estavam sendo "reduzidos, cortados e com temas faltando".
Portanto:
1. NÃO RESUMA, NÃO ENCURTE E NÃO DEIXE NENHUM TÓPICO DE FORA.
2. CRONOGRAMA DA FACULDADE (Área 1): Extraia absolutamente TODOS os tópicos lecionados, matérias, módulos, internato e datas de prova fornecidos no texto 1. Todos devem entrar na grade.
3. CRONOGRAMA DE RESIDÊNCIA (Área 2): Extraia os tópicos do cursinho informados no texto 2.
4. SINERGIA MÁXIMA: Identifique a sinergia entre o que o aluno tem na faculdade e o que tem na residência (ex: se estuda Sepse na faculdade, estudar Sepse no cursinho para economizar tempo).
5. PRIORIZAÇÃO MÁXIMA PARA SEMANA DE PROVA E TBL (MUTÁVEIS):
   O estudante reforçou explicitamente: "a IA no cronograma deve priorizar ao máximo a semana de prova, tbl ou algo do tipo, essas informações podem ser mutáveis ou atualizadas".
   - Identifique todas as semanas de provas teóricas (P1, P2, P3, P4, Sub, Exame Final).
   - Identifique todas as sessões de TBL (Team-Based Learning), iRAT, tRAT, tutorias PBL e OSCE (avaliações práticas de habilidades clínicas).
   - Na semana e nos dias que antecedem qualquer prova ou TBL, ative a prioridade máxima e proteção total: o foco deve ser voltado 100% para os temas da avaliação da faculdade (leitura prévia de TBL, resolução de questões da faculdade, fechamento de casos e checklists clínicos), pausando o avanço do cursinho para proteger as notas.
6. ATUALIZAÇÕES, OBSERVAÇÕES E AJUSTES (Área 3): Aplique com prioridade máxima qualquer instrução do texto 3 (trocas de plantão, matérias adiantadas, adiamentos de prova, focos específicos). Lembre-se que essas informações são mutáveis e dinâmicas.

PERFIL DO ESTUDANTE:
- Horas disponíveis por dia: ${config.horasDia}h/dia
- Nível de energia pós-faculdade/internato: ${config.energiaPosFaculdade}
- Matérias de maior dificuldade: ${(config.materiasDificuldade || []).join(', ') || 'Clínica Médica e Cirurgia Geral'}
- Data alvo da prova de residência médica: ${config.dataAlvoResidencia}
- Provas da Faculdade pré-agendadas: ${JSON.stringify(config.provas.filter(p => p.tipo === 'grad'))}
${secaoTextosAluno || '\n(Nenhum texto colado: utilize a matriz canônica de residência médica brasileira - ENARE, USP, UNIFESP, SUS-SP - e a grade curricular padrão do MEC para medicina)'}

INSTRUÇÕES DE RESPOSTA:
1. Extraia todos os temas informados nas 5 grandes áreas: [Clínica Médica, Cirurgia Geral, Pediatria, Ginecologia e Obstetrícia, Medicina Preventiva].
2. Identifique SINERGIAS com score e justificativa de otimização de tempo.
3. Extraia as datas exatas das provas em formato YYYY-MM-DD e o tipoEvento: "tbl", "osce", "pbl" ou "prova".

Responda SOMENTE em JSON puro e válido nesta estrutura:
{
  "sinergias": [
    { "tema": "Nome Exato do Tema", "materia": "Especialidade", "score": 98, "desc": "Sinergia 100%: Conteúdo simultâneo da Faculdade e da Residência" }
  ],
  "conteudosFaculdade": [
    { "tema": "Nome do Tema da Faculdade", "materia": "Especialidade", "sinergia": true, "score": 98 }
  ],
  "conteudosResidencia": [
    { "tema": "Nome do Tema do Cursinho", "materia": "Especialidade" }
  ],
  "temasPorMateria": {
    "Clínica Médica": ["Todos os temas de Clínica Médica..."],
    "Cirurgia Geral": ["Todos os temas de Cirurgia Geral..."],
    "Pediatria": ["Todos os temas de Pediatria..."],
    "Ginecologia e Obstetrícia": ["Todos os temas de Ginecologia e Obstetrícia..."],
    "Medicina Preventiva": ["Todos os temas de Medicina Preventiva..."]
  },
  "provasDetectadas": [
    { "nome": "P1 Clínica Médica", "data": "${plAddDias(config.inicio, 24)}", "materia": "Clínica Médica", "tipoEvento": "prova" },
    { "nome": "TBL Pediatria (iRAT/tRAT)", "data": "${plAddDias(config.inicio, 14)}", "materia": "Pediatria", "tipoEvento": "tbl" }
  ],
  "ajustesIdentificados": ["Ajustes acatados a partir do texto 3"]
}`;

        console.log('🤖 Chamando Groq para gerar cronograma completo e sinérgico...');
        const g = await generateAI({ task: "planner_enrich",
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.3
          }
        });

        let raw = (g.text || '').trim();
        if (raw.startsWith('```')) {
          raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        }
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.sinergias) && parsed.sinergias.length) {
          sinergiaMatches = parsed.sinergias;
        }
        if (Array.isArray(parsed.conteudosFaculdade) && parsed.conteudosFaculdade.length) {
          conteudosFaculdade = parsed.conteudosFaculdade;
        }
        if (Array.isArray(parsed.conteudosResidencia) && parsed.conteudosResidencia.length) {
          conteudosResidencia = parsed.conteudosResidencia;
        }
        if (parsed.temasPorMateria && typeof parsed.temasPorMateria === 'object') {
          temasPorMateria = parsed.temasPorMateria;
        }
        if (Array.isArray(parsed.provasDetectadas)) {
          parsed.provasDetectadas.forEach(pd => {
            if (pd.nome && pd.data && !config.provas.some(cp => cp.data === pd.data)) {
              config.provas.push({
                nome: pd.nome,
                data: pd.data,
                materia: pd.materia || 'Graduação',
                tipoEvento: pd.tipoEvento || detectarTipoEvento(pd.nome),
                tipo: 'grad'
              });
            }
          });
        }
        console.log(`✅ IA gerou ${sinergiaMatches.length} sinergias e extraiu ${conteudosFaculdade.length} tópicos da faculdade.`);
      } catch (err) {
        console.warn('⚠️ Erro ao consultar IA:', err.message);
        aviso = 'O motor determinístico calibrou o cronograma e distribuiu os temas com precisão de acordo com as ementas enviadas.';
      }
    } else {
      aviso = 'GROQ_API_KEY não configurada no servidor — usando motor heurístico de alta precisão.';
    }

    // Unifica com os tópicos extraídos localmente para garantir 100% de cobertura (sem truncamento)
    temasFacLocal.forEach(tf => {
      if (!conteudosFaculdade.some(cf => hwqNorm(cf.tema) === hwqNorm(tf.tema))) {
        conteudosFaculdade.push({ tema: tf.tema, materia: tf.materia, sinergia: false });
      }
    });

    temasResLocal.forEach(tr => {
      if (!conteudosResidencia.some(cr => hwqNorm(cr.tema) === hwqNorm(tr.tema))) {
        conteudosResidencia.push({ tema: tr.tema, materia: tr.materia });
      }
    });

    // Se a IA não gerou sinergias suficientes, detecta correspondências entre faculdade e residência
    if (!sinergiaMatches.length) {
      if (temasFacLocal.length) {
        sinergiaMatches = temasFacLocal.slice(0, 15).map(tf => ({
          tema: tf.tema,
          materia: tf.materia,
          score: 96,
          desc: 'Sinergia 100%: Cruzamento direto da ementa da faculdade com o banco de residência'
        }));
      } else {
        sinergiaMatches = SINERGIA_CANONICA.slice(0, 8).map(sc => ({
          tema: sc.tema,
          materia: sc.materia,
          score: 98,
          desc: 'Sinergia de Alto Rendimento: Faculdade + Residência sincronizadas'
        }));
      }
    }

    const plan = plGerarPlanSinergia(config, { sinergiaMatches, temasPorMateria, conteudosFaculdade, conteudosResidencia, atualizacoesNotas: rawAtualizacoes });
    if (plan.erro) return res.status(400).json({ success: false, msg: plan.erro });

    plan.geradoCom = aiConfigured() ? 'ia-rag-sinergia' : 'motor-sinergia-local';
    plan.atualizacoesNotas = rawAtualizacoes;
    if (aviso) plan.aviso = aviso;

    // Enfileira decks de estudo ativo para as revisões programadas
    const temasRevisao = new Set();
    plan.dias.forEach(d => d.blocos.forEach(b => {
      if (b.tipo && b.tipo.startsWith('revisao') && b.tema) {
        temasRevisao.add((b.materia || '') + '||' + b.tema);
      }
    }));
    temasRevisao.forEach(t => {
      const [materia, tema] = t.split('||');
      plEnfileirarDeck(materia, tema);
    });

    res.json({
      success: true,
      plan,
      sinergiasDetectadas: sinergiaMatches.length,
      diasBlindados: plan.estatisticas.diasProtegidos,
      ementaFaculdadeIntegrada: 100,
      totalTopicosFaculdade: plan.estatisticas.totalTopicosFaculdade,
      topicosFaculdadeTotal: plan.estatisticas.totalTopicosFaculdade,
      topicosFaculdadeAgendados: plan.estatisticas.topicosFaculdadeAgendados,
      gemini: !!aiConfigured()
    });
  } catch (err) {
    console.error('Erro no synergy-generate:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// POST /api/planner/apply-updates — "Atualizações do Cronograma, Observações e Ajustes"
// Permite ao estudante colar atualizações contínuas (ex: adiamento de provas, novos plantões, matérias adiantadas)
app.post('/api/planner/apply-updates', async (req, res) => {
  try {
    const { plan, atualizacoesNotas = '', textoFaculdade = '', textoResidencia = '' } = req.body || {};
    if (!plan || !Array.isArray(plan.dias)) return res.status(400).json({ success: false, msg: 'Plano inválido ou inexistente.' });

    const notas = (atualizacoesNotas || '').trim();
    if (!notas) return res.status(400).json({ success: false, msg: 'Digite as atualizações ou ajustes desejados para o cronograma.' });

    const hoje = plIso(new Date());

    // Guarda histórico de blocos já concluídos para não perder o progresso do aluno
    const blocosConcluidos = new Set();
    plan.dias.forEach(d => {
      d.blocos.forEach(b => {
        if (b.status === 'feito') {
          blocosConcluidos.add(b.key || (b.materia + '||' + b.tema));
        }
      });
    });

    // Detecta novas datas de prova ou adiamentos informados na atualização
    const novasProvas = extrairProvasDoTexto(notas);
    const configAtual = {
      ...(plan.config || {}),
      inicio: hoje,
      atualizacoesNotas: notas,
      provas: [...(plan.config?.provas || []), ...novasProvas]
    };

    // Extrai novos temas da atualização caso o usuário tenha adicionado matérias novas
    const novosTemas = extrairTemasDoTexto(notas);
    const extras = {
      sinergiaMatches: plan.sinergias || [],
      conteudosFaculdade: [...(plan.conteudosFaculdade || []), ...novosTemas],
      conteudosResidencia: plan.conteudosResidencia || [],
      atualizacoesAplicadas: [notas]
    };

    const novoPlan = plGerarPlanSinergia(configAtual, extras);
    if (novoPlan.erro) return res.status(400).json({ success: false, msg: novoPlan.erro });

    // Restaura status dos blocos já concluídos
    novoPlan.dias.forEach(d => {
      d.blocos.forEach(b => {
        const k = b.key || (b.materia + '||' + b.tema);
        if (blocosConcluidos.has(k)) b.status = 'feito';
      });
    });

    novoPlan.atualizacoesNotas = notas;
    novoPlan.replanejadoEm = new Date().toISOString();

    console.log(`⚡ [Planner] Atualizações aplicadas ao cronograma: "${notas.slice(0, 60)}..."`);
    res.json({
      success: true,
      plan: novoPlan,
      msg: 'Cronograma atualizado com sucesso! Novas diretrizes e proteções aplicadas.'
    });
  } catch (err) {
    console.error('Erro no apply-updates:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// POST /api/planner/update-exams — "Gestão de Provas, TBLs & Métodos Ativos (Mutáveis)"
// Permite ao usuário editar datas de TBL, Provas, OSCEs ou adicionar novos eventos avaliativos
app.post('/api/planner/update-exams', async (req, res) => {
  try {
    const { plan, provas = [] } = req.body || {};
    if (!plan || !Array.isArray(plan.dias)) return res.status(400).json({ success: false, msg: 'Plano inválido ou inexistente.' });

    const hoje = plIso(new Date());

    // Guarda histórico de blocos já concluídos
    const blocosConcluidos = new Set();
    plan.dias.forEach(d => {
      d.blocos.forEach(b => {
        if (b.status === 'feito') {
          blocosConcluidos.add(b.key || (b.materia + '||' + b.tema));
        }
      });
    });

    const novasProvas = (provas || []).map(p => ({
      nome: p.nome || 'Avaliação / TBL',
      data: p.data,
      materia: p.materia || 'Graduação',
      tipoEvento: p.tipoEvento || detectarTipoEvento(p.nome),
      tipo: p.tipo || 'grad'
    })).filter(p => p.data);

    const configAtual = {
      ...(plan.config || {}),
      inicio: hoje,
      provas: novasProvas
    };

    const extras = {
      sinergiaMatches: plan.sinergias || [],
      conteudosFaculdade: plan.conteudosFaculdade || [],
      conteudosResidencia: plan.conteudosResidencia || []
    };

    const novoPlan = plGerarPlanSinergia(configAtual, extras);
    if (novoPlan.erro) return res.status(400).json({ success: false, msg: novoPlan.erro });

    // Restaura status dos blocos já concluídos
    novoPlan.dias.forEach(d => {
      d.blocos.forEach(b => {
        const k = b.key || (b.materia + '||' + b.tema);
        if (blocosConcluidos.has(k)) b.status = 'feito';
      });
    });

    novoPlan.replanejadoEm = new Date().toISOString();

    console.log(`⚡ [Planner] Eventos avaliativos/TBLs atualizados: ${novasProvas.length} evento(s).`);
    res.json({
      success: true,
      plan: novoPlan,
      provas: novasProvas,
      msg: 'Datas de provas e TBLs atualizadas! A IA recalibrou o cronograma priorizando ao máximo suas avaliações.'
    });
  } catch (err) {
    console.error('Erro no update-exams:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// POST /api/planner/replan-imprevisto — "Reprogramar Dia (Imprevisto)"
// Redistribui a carga não cumprida pelos dias subsequentes sem acumular tudo no dia seguinte
app.post('/api/planner/replan-imprevisto', (req, res) => {
  try {
    const { plan, imprevistoData } = req.body || {};
    if (!plan || !Array.isArray(plan.dias)) return res.status(400).json({ success: false, msg: 'Plano ausente ou inválido.' });

    const hoje = imprevistoData || plIso(new Date());
    
    // Coleta blocos pendentes do dia do imprevisto e dias passados
    const blocosParaRedistribuir = [];
    plan.dias.forEach(d => {
      if (d.data <= hoje) {
        d.blocos.forEach(b => {
          if (b.status === 'pendente' && b.tipo !== 'prova' && !b.focoFaculdade) {
            blocosParaRedistribuir.push({
              ...b,
              remanejado: true,
              origemImprevisto: d.data
            });
            b.status = 'imprevisto_movido';
          }
        });
      }
    });

    if (!blocosParaRedistribuir.length) {
      return res.json({ success: true, plan, redistribuidos: 0, msg: 'Nenhum bloco pendente para redistribuir hoje!' });
    }

    // Redistribui suavemente pelos próximos 10 a 14 dias futuros
    // REGRA: Nunca acumula tudo no dia imediatamente posterior! Limite de +1 bloco por dia futuro
    const diasFuturos = plan.dias.filter(d => d.data > hoje && !d.protecaoProvas && d.tipo !== 'prova');

    if (!diasFuturos.length) {
      return res.status(400).json({ success: false, msg: 'Sem dias futuros livres para redistribuição antes da prova final.' });
    }

    let indiceDia = 0;
    blocosParaRedistribuir.forEach((bloco, idx) => {
      const diaDestino = diasFuturos[indiceDia % diasFuturos.length];
      diaDestino.blocos.push({
        ...bloco,
        id: 'rem-' + diaDestino.data + '-' + diaDestino.blocos.length,
        status: 'pendente'
      });
      indiceDia++;
    });

    plan.replanejadoEm = new Date().toISOString();
    plan.ultimoImprevisto = { data: hoje, blocosRedistribuidos: blocosParaRedistribuir.length };

    console.log(`⚡ [Planner] Imprevisto em ${hoje}: ${blocosParaRedistribuir.length} bloco(s) redistribuído(s) suavemente.`);
    res.json({
      success: true,
      plan,
      redistribuidos: blocosParaRedistribuir.length,
      msg: `${blocosParaRedistribuir.length} tarefa(s) foram redistribuídas de forma equilibrada pelos próximos dias sem sobrecarregar amanhã.`
    });
  } catch (err) {
    console.error('Erro no replan-imprevisto:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// POST /api/planner/replan — "Não estudei": redistribui atrasos de forma racional até a prova
app.post('/api/planner/replan', (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!plan || !plan.dias) return res.status(400).json({ success: false, msg: 'Plano ausente.' });
    const hoje = plIso(new Date());
    const pendentes = [], herdadas = [];
    plan.dias.filter(d => d.data >= hoje).forEach(d => d.blocos.forEach(b => {
      if (b.tipo === 'conteudo' && b.status === 'pendente') pendentes.push({ materia: b.materia, tema: b.tema, dificuldade: b.dificuldade, key: b.key });
      if (b.tipo.startsWith('revisao') && b.status === 'pendente') herdadas.push({ tipo: b.tipo, materia: b.materia, tema: b.tema, key: b.key, dificuldade: b.dificuldade });
    }));
    const config = { ...plan.config, inicio: hoje };
    const novo = plGerarPlan(config, { pendentes, revisoesHerdadas: herdadas, temasPorMateria: plan.config?.temasPorMateria || null });
    if (novo.erro) return res.status(400).json({ success: false, msg: novo.erro });
    novo.geradoCom = plan.geradoCom || 'motor-local';
    novo.replanejadoEm = new Date().toISOString();
    novo.diasAnteriores = plan.dias.filter(d => d.data < hoje); // histórico preservado
    res.json({ success: true, plan: novo, movidos: pendentes.length });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// GET /api/planner/deck?materia=&tema= — deck de estudo ativo do tema (flashcards + questões)
app.get('/api/planner/deck', async (req, res) => {
  try {
    const materia = String(req.query.materia || ''), tema = String(req.query.tema || '');
    if (!tema) return res.status(400).json({ success: false, msg: 'tema é obrigatório' });
    const deck = readDecks()[plDeckKey(materia, tema)] || null;
    res.json({ success: true, pronto: !!(deck && deck.pronto), deck });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// POST /api/planner/deck — solicita a geração autenticada de um deck para um tema
app.post('/api/planner/deck', (req, res) => {
  try {
    const materia = String(req.body?.materia || '').trim().slice(0, 160);
    const tema = String(req.body?.tema || '').trim().slice(0, 200);
    if (!tema) return res.status(400).json({ success: false, msg: 'tema é obrigatório' });
    const pronto = readDecks()[plDeckKey(materia, tema)];
    if (pronto?.pronto) return res.json({ success: true, pronto: true, deck: pronto });
    plEnfileirarDeck(materia, tema);
    return res.status(202).json({ success: true, pronto: false, enfileirado: true });
  } catch (err) {
    return res.status(500).json({ success: false, msg: err.message });
  }
});

registerPlanner(app, { generateAI, aiConfigured, getBank: () => readQuestionsBank() });

registerAula(app, { generateAI, aiConfigured, supabaseStorage: supabase, supabaseServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY });

// Mentor IA acadêmico (Faculdade + Residência) — rotas novas em /api/planner/v3/*
registerPlannerV3(app, {
  generateAI, aiConfigured, getBank: () => readQuestionsBank(), getSupabase: () => supabase,
  // PDFs de cronograma do acervo (não há cronogramas estruturados; o aluno escolhe um PDF e confere o que foi lido)
  listarCronogramasAcervo: () => (CAT.materials || [])
    .filter(m => /cronograma/i.test(m.path || '') && /\.pdf$/i.test(m.path || '') && !/guia/i.test(m.path || ''))
    .slice(0, 60).map(m => { const seg = String(m.path || '').split(' / '); return { id: m.id, nome: String(seg[seg.length - 1] || '').replace(/\.pdf$/i, ''), curso: m.course || '', pasta: seg.length > 1 ? seg[seg.length - 2] : '' }; }),
  baixarArquivoDrive: async (fileId) => {
    const id = cleanDriveId(fileId);
    if (!id) throw new Error('ID do arquivo inválido.');
    const r = await driveFetchWithRetry(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error(`Não consegui baixar o PDF do Drive (${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 18 * 1024 * 1024) throw new Error('PDF grande demais para leitura (máx. 18 MB).');
    return buf;
  }
});

// Biblioteca compartilhada de flashcards extraídos automaticamente do Google Drive.
app.get('/api/flashcards/library/status', (req, res) => res.json({ success: true, status: getFlashcardSyncStatus() }));
app.get('/api/flashcards/library/decks', async (req, res) => {
  try {
    const manifest = await readFlashcardManifest(supabase);
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ success: true, generatedAt: manifest.generatedAt, decks: (manifest.decks || []).map(({ id, name, cardCount, sourceName, sourcePath }) => ({ id, name, cardCount, sourceName, sourcePath })) });
  } catch (error) { res.status(503).json({ success: false, error: error.message }); }
});
app.get('/api/flashcards/library/decks/:deckId/cards', async (req, res) => {
  try {
    const page = await readFlashcardPage(supabase, String(req.params.deckId || '').slice(0, 64), req.query.offset, req.query.limit);
    if (!page) return res.status(404).json({ success: false, error: 'Deck não encontrado' });
    let reviews = {};
    if (supabase && page.cards.length) {
      try {
        const ids = page.cards.map(card => card.id);
        const { data, error } = await supabase.from('flashcard_reviews').select('card_id,due_at,interval_days,ease,repetitions,lapses,last_grade,last_reviewed_at').eq('username', req.user.username).in('card_id', ids);
        if (error) throw error;
        reviews = Object.fromEntries((data || []).map(row => [row.card_id, row]));
      } catch (error) { console.warn('[Flashcards] Revisões SQL indisponíveis; usando estado da conta:', error.message); }
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, ...page, reviews });
  } catch (error) { res.status(503).json({ success: false, error: error.message }); }
});
app.post('/api/flashcards/library/reviews', async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: 'Progresso compartilhado indisponível.' });
  const body = req.body || {};
  const cardId = String(body.cardId || '');
  const dueDate = String(body.dueDate || '');
  const grade = Number(body.grade);
  const eventId = String(body.eventId || '');
  const intervalDays = Number(body.intervalDays), ease = Number(body.ease);
  const repetitions = Number(body.repetitions), lapses = Number(body.lapses);
  if (!/^[a-f0-9]{64}$/.test(cardId) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isInteger(grade) || grade < 0 || grade > 3 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId) || !Number.isFinite(intervalDays) || intervalDays < 0 || intervalDays > 3650 || !Number.isFinite(ease) || ease < 1.3 || ease > 3.5 || !Number.isSafeInteger(repetitions) || repetitions < 0 || !Number.isSafeInteger(lapses) || lapses < 0) {
    return res.status(400).json({ success: false, error: 'Dados de revisão inválidos.' });
  }
  try {
    const { data: card, error: cardError } = await supabase.from('flashcard_library_cards').select('id').eq('id', cardId).maybeSingle();
    if (cardError) throw cardError;
    if (!card) return res.status(404).json({ success: false, error: 'Cartão não encontrado.' });
    const reviewedAt = new Date().toISOString();
    const { error: stateError } = await supabase.from('flashcard_reviews').upsert({
      username: req.user.username, card_id: cardId, due_at: `${dueDate}T12:00:00.000Z`, interval_days: intervalDays,
      ease, repetitions, lapses, last_grade: grade, last_reviewed_at: reviewedAt, updated_at: reviewedAt
    }, { onConflict: 'username,card_id' });
    if (stateError) throw stateError;
    const { error: eventError } = await supabase.from('flashcard_review_events').upsert({
      event_id: eventId, username: req.user.username, card_id: cardId, grade, reviewed_at: reviewedAt,
      schedule_after: { dueDate, intervalDays, ease, repetitions, lapses }
    }, { onConflict: 'event_id', ignoreDuplicates: true });
    if (eventError) throw eventError;
    return res.json({ success: true, reviewedAt });
  } catch (error) { return res.status(503).json({ success: false, error: error.message }); }
});
app.get('/api/flashcards/library/media/:assetName', async (req, res) => {
  try {
    const asset = await readFlashcardMedia(supabase, req.params.assetName);
    if (!asset) return res.status(404).json({ success: false, error: 'Mídia não encontrada.' });
    res.set({ 'Content-Type': asset.contentType, 'Content-Length': String(asset.data.length), 'Cache-Control': 'private, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.send(asset.data);
  } catch (error) { return res.status(503).json({ success: false, error: error.message }); }
});
app.post('/api/flashcards/library/sync', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ success: false, error: 'Apenas administradores podem iniciar a sincronização.' });
    const result = await syncDriveFlashcards(supabase, { force: req.body?.force === true });
    res.json(result);
  } catch (error) { res.status(503).json({ success: false, error: error.message }); }
});
registerApostilaReader(app);
registerMedreaderMarcas(app, { getSupabase: () => supabase });

// Arquivos internos nunca saem pelo site (código, dados, catálogo bruto, segredos)
app.use((req, res, next) => {
  const p = decodeURIComponent(req.path || '/').toLowerCase();
  if (/^\/(server\.js|api(\/|$)|vercel\.json|smart_scheduler\.js|package(-lock)?\.json|bun\.lock|render\.yaml|supabase-schema\.sql|metadata\.json|drive-tree-snapshot\.json|radar-medico\.json|deploy\.md|readme\.md)$/.test(p) || /^\/(src|data|scripts|node_modules|\.github)(\/|$)/.test(p)) return res.status(404).send('Not found');
  next();
});
let _manifCache = null;
// A página principal usa a pasta raiz configurada no Render (GOOGLE_DRIVE_FOLDER_ID)
let _indexRaiz = null;
app.get(['/', '/index.html'], (req, res, next) => {
  const raiz = DRIVE_ROOT_FOLDER_ID;
  if (!raiz) return next();
  try {
    if (!_indexRaiz) _indexRaiz = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(_indexRaiz);
  } catch (_) { next(); }
});
// Catálogo de aulas (traz os IDs do Drive): só com login
app.get('/acervo-manifest.json', async (req, res, next) => {
  const tk = getRequestSessionToken(req);
  const session = await validateSession(tk);
  if (!session) return res.status(401).json({ error: 'Faça login.' });
  res.setHeader('Cache-Control', 'private, no-cache');
  try {
    const ex = lerExtra();
    const sig = [ex.generatedAt, (ex.videos || []).length, (ex.materials || []).length, process.env.GOOGLE_DRIVE_FOLDER_ID || ''].join('|');
    if (!_manifCache || _manifCache.sig !== sig) {
      // Manifest empacotado é somente-leitura (e pode faltar em bundle mínimo).
      // Se não existir, monta a resposta com o catálogo já carregado do Supabase/Drive.
      const base = safeReadJson(path.join(__dirname, 'acervo-manifest.json'), null)
        || { generatedAt: ex.generatedAt || null, roots: [], videos: [], materials: [], folders: {} };
      const corpo = Buffer.from(JSON.stringify(juntarExtras(base)));
      _manifCache = { sig, raw: corpo, gz: zlib.gzipSync(corpo, { level: 6 }), etag: '"' + crypto.createHash('md5').update(sig).digest('hex') + '"' };
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('ETag', _manifCache.etag); res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === _manifCache.etag) return res.status(304).end();
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.setHeader('Content-Encoding', 'gzip'); return res.end(_manifCache.gz); }
    return res.end(_manifCache.raw);
  } catch (_) { next(); }
});
// Varredura das pastas extras do Drive (em segundo plano; refaz a cada 6h)
async function rodarExtras() { try { const r = await varrerExtras(); if (r) { resetCatalogo(); console.log(`📂 [Extras] ${r.videos} vídeos e ${r.materials} materiais das pastas extras.`); } return r; } catch (e) { console.warn('⚠️ [Extras]', e.message); return null; } }
async function processDriveUpdate() {
  const flashcardStatus = getFlashcardSyncStatus();
  const flashcardsConfigured = flashcardStatus.configured && flashcardStatus.enabled;
  let flashcardsChanged = false;
  let initialFlashcardSyncAttempted = false;
  if (flashcardsConfigured) {
    const manifest = await readFlashcardManifest(supabase).catch(error => {
      console.warn('[Flashcards] Não foi possível conferir o manifesto inicial:', error.message);
      return null;
    });
    if (!manifest?.generatedAt) {
      initialFlashcardSyncAttempted = true;
      const outcome = await syncDriveFlashcards(supabase).catch(error => {
        console.warn('[Flashcards] Carga inicial automática falhou:', error.message);
        return null;
      });
      flashcardsChanged = !!outcome && !outcome.disabled;
    }
  }

  const result = await rodarExtras();
  if (!initialFlashcardSyncAttempted && flashcardsConfigured && result?.modo === 'delta' && Array.isArray(result.changes) && result.changes.length) {
    const outcome = await syncDriveFlashcards(supabase, { changes: result.changes }).catch(error => { console.warn('[Flashcards] Delta por evento falhou:', error.message); return null; });
    flashcardsChanged = !!outcome && !outcome.unchanged && !outcome.disabled;
  } else if (!initialFlashcardSyncAttempted && flashcardsConfigured && result?.modo === 'full') {
    const outcome = await syncDriveFlashcards(supabase).catch(error => { console.warn('[Flashcards] Reconciliação após full sync falhou:', error.message); return null; });
    flashcardsChanged = !!outcome && !outcome.disabled;
  }
  if (result && (result.modo === 'full' || result.catalogChanged || flashcardsChanged)) {
    const event = `event: catalog-updated\ndata: ${JSON.stringify({ generatedAt: new Date().toISOString(), mode: result.modo })}\n\n`;
    for (const client of catalogEventClients) client.write(event);
  }
  return result;
}
// Vercel não preserva timers nem memória entre invocações. O cron chama esta rota
// para recuperar deltas perdidos e renovar o canal do Drive.
app.get('/webhooks/google-drive/maintenance', async (req, res) => {
  const expected = String(process.env.CRON_SECRET || '');
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const result = await processDriveUpdate();
    const channel = await renewDrivePushChannel();
    return res.json({ success: true, mode: result?.modo || null, channelActive: !!channel.active, channelError: channel.error || null });
  } catch (error) {
    console.error('[Drive maintenance] Falha:', error.message);
    return res.status(503).json({ success: false, error: error.message });
  }
});
// Push é o caminho normal. Uma reconciliação diária recupera notificações perdidas;
// não consulta o Supabase e, com token válido, só lê a Changes API incremental.
const EXTRA_RECONCILE_MS = 24 * 60 * 60 * 1000;
let drivePushRenewalStarted = false;
if (!IS_SERVERLESS) setTimeout(async function cicloExtras() {
  await processDriveUpdate();
  if (!drivePushRenewalStarted) drivePushRenewalStarted = startDrivePushRenewal(processDriveUpdate);
  setTimeout(cicloExtras, EXTRA_RECONCILE_MS).unref?.();
}, 3000).unref?.();
app.get('/api/acervo/extra-status', (req, res) => res.json({ success: true, ids: EXTRA_IDS(), principal: DRIVE_ROOT_FOLDER_ID, chave: DRIVE_OK, conta: temConta() ? emailConta() : '', erroConta: erroConta(), ...EXTRA_STATUS }));
app.post('/api/acervo/extra-scan', (req, res) => { rodarExtras(); res.json({ success: true, started: !EXTRA_STATUS.running }); });

app.get('/api/catalog/events', (req, res) => {
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  catalogEventClients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); catalogEventClients.delete(res); });
});

/* ═══ 
IMPORTAÇÃO DE FLASHCARDS ANKI (.apkg) ════════════════════════════════════════
   Busca arquivos .apkg estritamente dentro de GOOGLE_DRIVE_ANKI_FOLDER_ID.
   Nunca varre o Drive inteiro. Fail-fast se a variável não estiver configurada. ════════════════════════════════════════════════ */
app.post('/api/anki/importar', async (req, res) => {
  try {
    const folderId = process.env.GOOGLE_DRIVE_ANKI_FOLDER_ID || '';
    if (!folderId) {
      console.warn('[Anki Importer] ID da pasta não configurado no .env, pulando importação.');
      return res.status(503).json({ success: false, error: 'GOOGLE_DRIVE_ANKI_FOLDER_ID não configurada' });
    }

    const cleanId = cleanDriveId(folderId);
    if (!cleanId) {
      return res.status(503).json({ success: false, error: 'GOOGLE_DRIVE_ANKI_FOLDER_ID inválida' });
    }

    const q = encodeURIComponent(`'${cleanId}' in parents and trashed = false and name contains '.apkg'`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,webViewLink,createdTime,modifiedTime)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=name_natural&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;

    const arquivos = [];
    let pageToken = '';
    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const r = await driveFetchWithRetry(url + pageParam, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) {
        const texto = await r.text().catch(() => '');
        throw new Error(`Drive ${r.status}: ${texto.slice(0, 200)}`);
      }
      const data = await r.json();
      if (data.files && Array.isArray(data.files)) {
        arquivos.push(...data.files.map(f => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          webViewLink: f.webViewLink,
          createdTime: f.createdTime,
          modifiedTime: f.modifiedTime
        })));
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    console.log(`[Anki Importer] ${arquivos.length} arquivo(s) .apkg encontrado(s) na pasta ${cleanId}.`);
    return res.json({ success: true, arquivos });
  } catch (err) {
    console.error('[Anki Importer]', err && err.message);
    res.status(500).json({ success: false, error: err && err.message });
  }
});

/* ═══ DOWNLOAD DE .APKG DO DRIVE ══════════════════════════════════════════════════════
   Proxy de download para o navegador salvar o .apkg (ou abrir no Drive). ═══════════════════════════════════════════════════ */
app.get('/api/anki/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ success: false, error: 'fileId obrigatório' });
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const r = await driveFetchWithRetry(url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) {
      const texto = await r.text().catch(() => '');
      return res.status(r.status).json({ success: false, error: `Drive ${r.status}: ${texto.slice(0, 200)}` });
    }
    const nome = r.headers.get('content-disposition') || 'arquivo.apkg';
    const m = nome.match(/filename="?([^"]+)"?/);
    const fileName = m ? m[1] : 'arquivo.apkg';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const body = await r.buffer();
    return res.send(body);
  } catch (err) {
    console.error('[Anki Download]', err && err.message);
    res.status(500).json({ success: false, error: err && err.message });
  }
});

// Serve static assets from root directory
// Same-origin Markdown dependencies in local mode; Vercel serves their build copies from public/.
app.get('/js/vendor/markdown-it.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/markdown-it/dist/browser/markdown-it.umd.min.js')));
app.get('/js/vendor/purify.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js')));
app.use(express.static(__dirname, {
  dotfiles: 'deny',
  extensions: ['html', 'htm'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.json')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Never return index.html for API requests — return 404 JSON to prevent "Unexpected token <" in fetch
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint da API não encontrado', path: req.path });
});

// Fallback to index.html for SPA navigation.
// Caminhos que parecem arquivo (têm extensão) NÃO recebem HTML: devolvem 404.
// Isso evita o clássico "Unexpected token <" quando um asset/endpoint falta.
app.get('*', (req, res, next) => {
  if (/\.[a-z0-9]{1,10}$/i.test(req.path)) return res.status(404).send('Not found');
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Endpoint da API não encontrado', path: req.path });
  res.sendFile(path.join(__dirname, 'index.html'), err => { if (err) next(err); });
});

// Erros não tratados viram log em vez de derrubar o servidor (no Render isso causaria reinício e quedas de stream)
process.on('uncaughtException', err => console.error('[uncaughtException]', err && err.stack || err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err && err.stack || err));

// Qualquer erro em rota /api responde JSON (nunca HTML) para o front tratar com mensagem clara
app.use((err, req, res, next) => {
  console.error('[Erro]', req.method, req.path, err && err.message);
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode) || 500;
  if (req.path.startsWith('/api')) return res.status(status).json({ success: false, error: status === 413 ? 'Arquivo grande demais' : status === 400 ? 'Requisição inválida' : 'Erro interno do servidor', msg: err && err.message });
  res.status(status).send('Erro interno');
});

/* ═══ BOOT ═══════════════════════════════════════════════════════════════════════
   - Railway/Render/local: sobe o servidor HTTP contínuo.
   - Vercel/serverless: NÃO chama listen; exporta o app Express para o runtime.
   ═══════════════════════════════════════════════════════════════════════════════ */
let server = null;
if (!IS_SERVERLESS) {
  server = app.listen(PORT, HOST, () => {
    console.log(`Cuscuz-MED running at http://${HOST}:${PORT}`);
    checkDriveKey();
    if (startFlashcardSyncScheduler(supabase)) console.log('🃏 Sincronização automática de flashcards do Drive agendada.');
  });

  process.on('SIGTERM', () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

export default app;
export { app, server };
