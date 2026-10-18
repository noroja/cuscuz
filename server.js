import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  driveFetch, cleanDriveId, driveReady, GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_DRIVE_RECORDINGS_FOLDER_ID, getDriveStatus, uploadToDrive,
  createFolder, findFolderByName, listFolder, getFileMeta, temConta, emailConta
} from './src/drive.js';

// Importar auth com tratamento de erro
let registerAuthRoutes, authMiddleware;
try {
  const authModule = await import('./src/auth-multiuser.js');
  registerAuthRoutes = authModule.registerAuthRoutes;
  authMiddleware = authModule.authMiddleware;
  console.log('✅ [Auth] Módulo de autenticação carregado com sucesso');
} catch (e) {
  console.error('❌ [Auth] Falha ao carregar módulo de autenticação:', e.message);
  registerAuthRoutes = (app) => {
    app.post('/api/auth/login', (req, res) => {
      res.status(500).json({ success: false, error: 'Módulo de autenticação não carregado' });
    });
  };
  authMiddleware = (req, res, next) => next();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Log de requisições para debug
app.use('/api', (req, res, next) => {
  console.log(`[API] ${req.method} ${req.path}`);
  next();
});

// Registrar rotas de autenticação (Supabase + fallback local)
try {
  registerAuthRoutes(app);
  console.log('✅ [Auth] Rotas de autenticação registradas');
} catch (e) {
  console.error('❌ [Auth] Falha ao registrar rotas de autenticação:', e.message);
}

// Middleware de autenticação para rotas /api (exceto /api/auth/*, /api/health, /api/config e /api/drive/*)
app.use('/api', authMiddleware);

// Servir arquivos estáticos (index.html, css, js, etc.)
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

// Fallback para SPA: rotas não-API devolvem o index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Em hospedagens (Render, Railway...) a porta vem do ambiente; 3000 é o padrão local
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

// ── Healthcheck ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', drive: driveReady ? 'configured' : 'missing_config', timestamp: new Date().toISOString() });
});

// ── Status do Drive ──
app.get('/api/drive/status', async (_req, res) => {
  const status = await getDriveStatus();
  res.json(status);
});

// ── Listar materiais (PDFs e apostilas HTML) no Drive ──
// Estrutura: curso > disciplina > aula > subpasta "Apostila"
app.get('/api/drive/materials', async (req, res) => {
  const course = (req.query.course || '').trim();
  const disc = (req.query.disc || '').trim();
  const aula = (req.query.aula || '').trim();
  if (!course || !disc) return res.status(400).json({ error: 'course e disc são obrigatórios', materials: [] });
  if (!driveReady) return res.status(503).json({ error: 'Drive não configurado', materials: [] });

  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const limpaTnome = n => norm(String(n || ''));

  try {
    const cleanRoot = cleanDriveId(GOOGLE_DRIVE_FOLDER_ID);
    if (!cleanRoot) return res.json({ materials: [], hint: 'GOOGLE_DRIVE_FOLDER_ID não configurado' });

    async function listFolder(folderId) {
      const files = [];
      let pageToken = '';
      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
        const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,shortcutDetails,webViewLink,parents,size,modifiedTime)');
        const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=folder,name_natural&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pageParam}`;
        const r = await driveFetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) break;
        const data = await r.json();
        if (data.files) files.push(...data.files);
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return files;
    }

    async function getFileMeta(fileId) {
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,shortcutDetails,webViewLink,parents,size,modifiedTime&supportsAllDrives=true&includeItemsFromAllDrives=true`;
      const r = await driveFetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      return r.json();
    }

    function isApostilaFolder(name) {
      const n = String(name || '').toLowerCase();
      return n.includes('apostila') || n === 'apostilas';
    }

    function classifyFile(f) {
      const nome = String(f.name || '');
      const nomeNorm = norm(nome);
      const isShortcut = f.mimeType === 'application/vnd.google-apps.shortcut';
      const effectiveId = isShortcut && f.shortcutDetails?.targetId ? f.shortcutDetails.targetId : f.id;
      const effectiveMime = isShortcut && f.shortcutDetails?.targetMimeType ? f.shortcutDetails.targetMimeType : f.mimeType;
      const isFolder = effectiveMime === 'application/vnd.google-apps.folder';

      const pdfExt = /\.(pdf|doc|docx)$/i;
      const htmlExt = /\.(html?|htm)$/i;

      const isPdf = !isFolder && (!nomeNorm.match(htmlExt)) && (pdfExt.test(nome) || /pdf|document|presentation/i.test(effectiveMime));
      const isHtml = !isFolder && (htmlExt.test(nome) || /html/i.test(effectiveMime));

      return { nome, nomeNorm, isShortcut, effectiveId, effectiveMime, isFolder, isPdf, isHtml };
    }

    async function processarPastaAula(aulaFolderId, aulaNome) {
      const aulaFiles = await listFolder(aulaFolderId);
      const apostilaPasta = aulaFiles.find(f => (f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder) && isApostilaFolder(f.name));

      let arquivosParaProcessar = [];

      if (apostilaPasta) {
        const apostilaFolderId = apostilaPasta.shortcutDetails?.targetId || apostilaPasta.id;
        const apostilaFiles = await listFolder(apostilaFolderId);
        arquivosParaProcessar = apostilaFiles;
      } else {
        arquivosParaProcessar = aulaFiles.filter(f => {
          const { isFolder, isPdf, isHtml } = classifyFile(f);
          return !isFolder && (isPdf || isHtml);
        });
      }

      const resultados = [];
      for (const f of arquivosParaProcessar) {
        const { nome, nomeNorm, isShortcut, effectiveId, effectiveMime, isFolder, isPdf, isHtml } = classifyFile(f);
        if (isFolder) continue;
        if (!isPdf && !isHtml) continue;

        resultados.push({
          id: effectiveId,
          nome: nome.replace(/\.(pdf|html?|htm|doc|docx)$/i, '').trim(),
          rawName: nome,
          mimeType: effectiveMime,
          isFolder: false,
          isPdf,
          isHtml,
          curso: course,
          disc: disc,
          aulaId: aulaFolderId,
          aulaNome,
          webViewLink: f.webViewLink || `https://drive.google.com/file/d/${effectiveId}/preview`
        });
      }
      return resultados;
    }

    // 1. Encontrar a pasta do curso na raiz do Drive
    const rootFiles = await listFolder(cleanRoot);
    const cursoPasta = rootFiles.find(f => {
      const nome = String(f.name || '').toLowerCase();
      const c = String(course || '').toLowerCase();
      return nome.includes(c) || c.includes(nome) || limpaTnome(f.name) === limpaTnome(course);
    });

    if (!cursoPasta) return res.json({ materials: [], hint: 'Pasta do curso não encontrada no Drive' });

    const cursoId = cursoPasta.shortcutDetails?.targetId || cursoPasta.id;

    // 2. Encontrar a pasta da disciplina dentro do curso
    const cursoFiles = await listFolder(cursoId);
    const discNorm = norm(disc);

    const discPasta = cursoFiles.find(f => {
      if (f.mimeType !== 'application/vnd.google-apps.folder' && !f.isFolder) return false;
      const nome = String(f.name || '').toLowerCase();
      const nNorm = norm(nome);
      return nNorm.includes(discNorm) || discNorm.includes(nNorm.replace(/\.(pdf|html?|htm|doc|docx)$/i, '')) || limpaTnome(f.name) === limpaTnome(disc);
    });

    if (!discPasta) return res.json({ materials: [], hint: 'Pasta da disciplina não encontrada no Drive' });

    const discFolderId = discPasta.shortcutDetails?.targetId || discPasta.id;

    // 3. Listar subpastas da disciplina (as aulas)
    const discFiles = await listFolder(discFolderId);
    const aulaPastas = discFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder' || f.isFolder);

    // 4. Determinar qual pasta de aula usar
    let targetAulaPasta = null;

    if (aula) {
      const aulaNorm = norm(aula);
      const encontradaPorNome = aulaPastas.find(f => {
        const nome = String(f.name || '').toLowerCase();
        const nNorm = norm(nome);
        return nNorm.includes(aulaNorm) || aulaNorm.includes(nNorm) || limpaTnome(f.name) === limpaTnome(aula);
      });

      if (encontradaPorNome) {
        targetAulaPasta = encontradaPorNome;
      } else {
        try {
          const meta = await getFileMeta(aula);
          if (meta && meta.parents && meta.parents.length > 0) {
            const parentId = meta.parents[0];
            const paiEhAula = aulaPastas.find(f => {
              const fid = f.shortcutDetails?.targetId || f.id;
              return fid === parentId;
            });
            if (paiEhAula) {
              targetAulaPasta = paiEhAula;
            } else {
              const metaPai = await getFileMeta(parentId);
              if (metaPai && metaPai.parents && metaPai.parents.length > 0) {
                const avôId = metaPai.parents[0];
                const avoEhAula = aulaPastas.find(f => {
                  const fid = f.shortcutDetails?.targetId || f.id;
                  return fid === avôId;
                });
                if (avoEhAula) {
                  targetAulaPasta = avoEhAula;
                }
              }
            }
          }
        } catch (e) {
          console.warn('[Drive Materials] Falha ao obter meta do arquivo aula:', e.message);
        }

        if (!targetAulaPasta) {
          targetAulaPasta = null;
        }
      }
    }

    if (!targetAulaPasta) {
      const materials = [];
      for (const aulaPasta of aulaPastas) {
        const aulaFolderId = aulaPasta.shortcutDetails?.targetId || aulaPasta.id;
        const aulaNome = aulaPasta.name || 'Aula sem nome';
        const mats = await processarPastaAula(aulaFolderId, aulaNome);
        materials.push(...mats);
      }
      const uniq = materials.filter((m, idx, self) => idx === self.findIndex(m2 => m2.id === m.id));
      return res.json({ materials: uniq, total: uniq.length, course, disc, aula: null, source: 'drive-all-aulas' });
    }

    const aulaFolderId = targetAulaPasta.shortcutDetails?.targetId || targetAulaPasta.id;
    const aulaNome = targetAulaPasta.name || 'Aula sem nome';
    const materials = await processarPastaAula(aulaFolderId, aulaNome);

    return res.json({ materials, total: materials.length, course, disc, aula: aula, source: 'drive-recursive' });
  } catch (err) {
    console.error('[Drive Materials]', err.message);
    return res.status(500).json({ error: err.message, materials: [] });
  }
});

// ── Upload de gravação de aula ──
app.post('/api/recordings', async (req, res) => {
  if (!driveReady) return res.status(503).json({ error: 'Drive não configurado', success: false });

  try {
    const { fileName, mimeType = 'audio/webm', aulaId, aulaNome, disciplina, data } = req.body || {};

    if (!req.body || !req.body.fileData) {
      return res.status(400).json({ error: 'fileData é obrigatório', success: false });
    }

    const fileData = req.body.fileData;
    const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData, 'base64');

    // Nome do arquivo: aula-AAAA-MM-DD-HHmm.webm
    const agoraSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const yyyy = agoraSP.getFullYear();
    const mm = String(agoraSP.getMonth() + 1).padStart(2, '0');
    const dd = String(agoraSP.getDate()).padStart(2, '0');
    const hh = String(agoraSP.getHours()).padStart(2, '0');
    const mi = String(agoraSP.getMinutes()).padStart(2, '0');

    const dateFolder = `${yyyy}-${mm}-${dd}`;
    const fileBaseName = `aula-${yyyy}-${mm}-${dd}-${hh}${mi}`;
    const finalFileName = fileName || `${fileBaseName}.webm`;

    // Determinar pasta de destino
    let targetFolderId = GOOGLE_DRIVE_RECORDINGS_FOLDER_ID || GOOGLE_DRIVE_FOLDER_ID;

    // Se já há gravações no mesmo dia, criar subpasta AAAA-MM-DD
    let dateFolderId = null;
    if (GOOGLE_DRIVE_RECORDINGS_FOLDER_ID) {
      const cleanRecordingsId = cleanDriveId(GOOGLE_DRIVE_RECORDINGS_FOLDER_ID);
      if (cleanRecordingsId) {
        const existingDateFolder = await findFolderByName(dateFolder, cleanRecordingsId);
        if (existingDateFolder) {
          dateFolderId = existingDateFolder.shortcutDetails?.targetId || existingDateFolder.id;
        } else {
          const created = await createFolder(dateFolder, cleanRecordingsId);
          dateFolderId = created.id;
        }
        targetFolderId = dateFolderId || targetFolderId;
      }
    }

    const resultado = await uploadToDrive(buffer, finalFileName, mimeType, targetFolderId);

    res.json({
      success: true,
      file: {
        id: resultado.id,
        name: resultado.name,
        webViewLink: resultado.webViewLink,
        mimeType: resultado.mimeType,
        size: resultado.size,
        createdTime: resultado.createdTime,
        dateFolder: dateFolder,
        aulaId: aulaId || null,
        aulaNome: aulaNome || null,
        disciplina: disciplina || null
      },
      message: 'Gravação salva no Drive com sucesso'
    });
  } catch (err) {
    console.error('[Recordings]', err.message);
    res.status(500).json({ error: err.message, success: false });
  }
});

// ── Iniciar o servidor ──
app.listen(PORT, HOST, () => {
  console.log(`🚀 Cuscuz-MED server running on http://${HOST}:${PORT}`);
  console.log(`   Drive: ${driveReady ? 'configurado' : 'NÃO configurado'}`);
  if (driveReady) {
    console.log(`   Pasta principal: ${GOOGLE_DRIVE_FOLDER_ID}`);
    if (GOOGLE_DRIVE_RECORDINGS_FOLDER_ID) {
      console.log(`   Pasta de gravações: ${GOOGLE_DRIVE_RECORDINGS_FOLDER_ID}`);
    }
  }
  console.log(`   Auth routes: registradas`);
});
