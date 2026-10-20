/* ═════════════════════════════════════════════════════════════════════════════════
   SUPABASE CATALOG — Single Source of Truth para o acervo-manifest.json
   ─────────────────────────────────────────────────────────────────────────────
   - Boot do servidor: baixa o JSON consolidado do Supabase Storage (zero cota do Drive)
   - Após Delta/Full Sync no Drive: faz upload silencioso do JSON atualizado p/ Supabase
   - Fallback: se Supabase estiver fora do ar ou arquivo não existir → Full Sync de emergência no Drive
   ═════════════════════════════════════════════════════════════════════════════════ */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const BUCKET = 'acervo';
const CATALOG_PATH = 'acervo-manifest.json';
const DRIVE_TOKEN_PATH = 'drive-change-token.json';
const QUESTIONS_PATH = 'questions-bank.json';

let supabaseCat = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    supabaseCat = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (e) {
    console.warn('⚠️ [Supabase Catalog] Não foi inicializar cliente:', e.message);
  }
}

export const supabaseCatalogReady = () => !!supabaseCat;

/* Baixa o acervo-manifest.json do Supabase Storage.
   Retorna null se não existir, se houver erro ou se o Supabase não estiver configurado. */
export async function downloadCatalogFromSupabase() {
  if (!supabaseCat) return null;
  try {
    const { data, error } = await supabaseCat.storage
      .from(BUCKET)
      .download(CATALOG_PATH);
    if (error || !data) {
      if (error && error.statusCode === 404) {
        console.log('📦 [Supabase Catalog] Arquivo ainda não existe no bucket (primeira execução).');
      } else {
        console.warn('⚠️ [Supabase Catalog] Falha ao baixar:', error?.message || String(error));
      }
      return null;
    }
    const text = await data.text();
    const json = JSON.parse(text);
    console.log(`✅ [Supabase Catalog] Catálogo baixado da nuvem: ${(json.videos || []).length} vídeos, ${(json.materials || []).length} materiais (gerado em ${json.generatedAt || '?'})`);
    return json;
  } catch (e) {
    console.warn('⚠️ [Supabase Catalog] Exceção ao baixar:', e.message);
    return null;
  }
}

/* Faz upload do acervo-manifest.json para o Supabase Storage (upsert). */
export async function uploadCatalogToSupabase(catalog) {
  if (!supabaseCat) {
    console.warn('⚠️ [Supabase Catalog] Cliente não configurado — pulando upload.');
    return false;
  }
  try {
    const payload = JSON.stringify(catalog);
    const { error } = await supabaseCat.storage
      .from(BUCKET)
      .upload(CATALOG_PATH, payload, {
        contentType: 'application/json',
        upsert: true
      });
    if (error) {
      console.warn('⚠️ [Supabase Catalog] Falha ao fazer upload:', error.message);
      return false;
    }
    console.log(`📤 [Supabase Catalog] Catálogo enviado para o Supabase Storage (${Math.round(payload.length / 1024)} KB).`);
    return true;
  } catch (e) {
    console.warn('⚠️ [Supabase Catalog] Exceção ao fazer upload:', e.message);
    return false;
  }
}

/* Banco de questões — cópia durável no Supabase Storage.
   /tmp é apagado a cada cold start; se o seed empacotado não existir (ou estiver
   desatualizado), o boot tenta este arquivo antes de cair na API do Hardworq. */
export async function downloadQuestionsBankFromSupabase() {
  if (!supabaseCat) return null;
  try {
    const { data, error } = await supabaseCat.storage.from(BUCKET).download(QUESTIONS_PATH);
    if (error || !data) {
      if (error && error.statusCode !== 404) {
        console.warn('⚠️ [Supabase Catalog] Falha ao baixar banco de questões:', error.message);
      }
      return null;
    }
    const json = JSON.parse(await data.text());
    if (!Array.isArray(json) || !json.length) return null;
    console.log(`📦 [Supabase Catalog] Banco de questões baixado da nuvem: ${json.length} questões.`);
    return json;
  } catch (e) {
    console.warn('⚠️ [Supabase Catalog] Exceção ao baixar banco de questões:', e.message);
    return null;
  }
}

export async function uploadQuestionsBankToSupabase(questions) {
  if (!supabaseCat || !Array.isArray(questions) || !questions.length) return false;
  try {
    const payload = JSON.stringify(questions);
    const { error } = await supabaseCat.storage.from(BUCKET).upload(QUESTIONS_PATH, payload, {
      contentType: 'application/json',
      upsert: true
    });
    if (error) {
      console.warn('⚠️ [Supabase Catalog] Falha ao enviar banco de questões:', error.message);
      return false;
    }
    console.log(`📤 [Supabase Catalog] Banco de questões enviado (${questions.length} questões, ${Math.round(payload.length / 1024)} KB).`);
    return true;
  } catch (e) {
    console.warn('⚠️ [Supabase Catalog] Exceção ao enviar banco de questões:', e.message);
    return false;
  }
}

export async function downloadDriveChangeToken() {
  if (!supabaseCat) return null;
  try {
    const { data, error } = await supabaseCat.storage.from(BUCKET).download(DRIVE_TOKEN_PATH);
    if (error || !data) return null;
    const parsed = JSON.parse(await data.text());
    return parsed?.pageToken ? parsed : null;
  } catch (_) { return null; }
}

export async function uploadDriveChangeToken(pageToken) {
  if (!supabaseCat || !pageToken) return false;
  try {
    const { error } = await supabaseCat.storage.from(BUCKET).upload(DRIVE_TOKEN_PATH, JSON.stringify({ pageToken, savedAt: new Date().toISOString() }), { contentType: 'application/json', upsert: true });
    if (error) { console.warn('⚠️ [Supabase Catalog] Falha ao persistir token do Drive:', error.message); return false; }
    return true;
  } catch (error) { console.warn('⚠️ [Supabase Catalog] Exceção ao persistir token do Drive:', error.message); return false; }
}

/* Tenta garantir que o bucket exista (best-effort; se falhar, seguimos em frente). */
export async function ensureSupabaseBucket() {
  if (!supabaseCat) return false;
  try {
    const { data: buckets } = await supabaseCat.storage.listBuckets();
    const exists = (buckets || []).some(b => b.name === BUCKET);
    if (!exists) {
      const { error } = await supabaseCat.storage.createBucket(BUCKET, { public: false });
      if (error) {
        console.warn('⚠️ [Supabase Catalog] Não foi possível criar bucket:', error.message);
        return false;
      }
      console.log(`✅ [Supabase Catalog] Bucket '${BUCKET}' criado.`);
    }
    return true;
  } catch (e) {
    console.warn('⚠️ [Supabase Catalog] Exceção ao garantir bucket:', e.message);
    return false;
  }
}
