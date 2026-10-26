/* ═══════════════════════════════════════════════════════════════════════════════
   SYSTEM CONFIG — estado durável de configuração no Supabase.

   Na Vercel o sistema de arquivos da aplicação é somente leitura e /tmp é
   apagado entre invocações (cold start). Tokens e segredos de integração NÃO
   podem viver em arquivo: a fonte da verdade é o Supabase.

   Ordem de persistência:
     1. tabela `system_configs` (quando o SQL foi aplicado);
     2. bucket privado `system` no Supabase Storage (fallback quando a tabela
        ainda não existe, mas a SERVICE_ROLE_KEY está configurada);
     3. cache local em /tmp — apenas fallback para dev/offline.

   O bucket `system` NUNCA é público: ele guarda tokens de integração. Se já
   existir como público, tentamos torná-lo privado antes de gravar.
   ═══════════════════════════════════════════════════════════════════════════════ */
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { safeReadJson, safeWriteJson, TMP_DIR } from './fs-safe.js';

const TABLE = 'system_configs';
const LOCAL_CACHE = path.join(TMP_DIR, 'system-configs.json');
const STORAGE_BUCKET = 'system';
const STORAGE_PREFIX = 'configs';

const memory = new Map();
let client = null;
let clientTried = false;
let clientUsesServiceRole = false;
let missingTableWarned = false;
let storageReady = false;
let storageTried = false;

function getClient() {
  if (clientTried) return client;
  clientTried = true;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = serviceKey || process.env.SUPABASE_ANON_KEY;
  clientUsesServiceRole = !!serviceKey;
  if (!url || !key) {
    console.warn('⚠️ [SystemConfig] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes: usando apenas cache efêmero em /tmp.');
    return null;
  }
  if (!serviceKey) {
    console.warn('⚠️ [SystemConfig] Sem SUPABASE_SERVICE_ROLE_KEY: a RLS de system_configs e o bucket privado ficam indisponíveis. O token ficará só no /tmp.');
  }
  try {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    if (typeof client.auth?.stopAutoRefresh === 'function') client.auth.stopAutoRefresh();
  } catch (err) {
    console.warn('⚠️ [SystemConfig] Não foi possível inicializar o Supabase:', err.message);
    client = null;
  }
  return client;
}

function localCache() {
  const all = safeReadJson(LOCAL_CACHE, null);
  return all && typeof all === 'object' ? all : {};
}

function saveLocalCache(key, value) {
  const all = localCache();
  if (value === undefined) delete all[key];
  else all[key] = value;
  safeWriteJson(LOCAL_CACHE, all);
}

/* Não deixa um Supabase lento travar o cold start / login. */
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms`)), ms);
      if (timer.unref) timer.unref();
    })
  ]);
}

function isMissingTable(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  return code === '42P01' || /relation .* does not exist|could not find the table|schema cache/i.test(msg);
}

function storagePath(key) {
  return `${STORAGE_PREFIX}/${String(key).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

/* Bucket privado usado apenas quando a tabela ainda não foi criada. */
async function ensureStorage() {
  if (storageReady) return true;
  if (storageTried) return storageReady;
  storageTried = true;
  const sb = getClient();
  if (!sb || !clientUsesServiceRole) return false;
  try {
    const { data: buckets, error } = await withTimeout(sb.storage.listBuckets(), 6000, 'listBuckets');
    if (error) throw error;
    const existing = (buckets || []).find(b => b.name === STORAGE_BUCKET);
    if (existing) {
      if (existing.public) {
        const { error: updateError } = await withTimeout(
          sb.storage.updateBucket(STORAGE_BUCKET, { public: false }),
          6000,
          'updateBucket'
        );
        if (updateError) throw updateError;
        console.log('🔒 [SystemConfig] Bucket "system" estava público e foi tornado privado.');
      }
    } else {
      const { error: createError } = await withTimeout(
        sb.storage.createBucket(STORAGE_BUCKET, { public: false }),
        6000,
        'createBucket'
      );
      if (createError && !/already exists|duplicate/i.test(String(createError.message || ''))) throw createError;
      console.log('✅ [SystemConfig] Bucket privado "system" criado para estado durável.');
    }
    storageReady = true;
  } catch (err) {
    console.warn('⚠️ [SystemConfig] Storage privado indisponível:', err.message);
  }
  return storageReady;
}

async function readStorage(key) {
  if (!(await ensureStorage())) return null;
  try {
    const { data, error } = await withTimeout(
      client.storage.from(STORAGE_BUCKET).download(storagePath(key)),
      6000,
      `leitura de storage "${key}"`
    );
    if (error || !data) return null;
    const parsed = JSON.parse(await data.text());
    return parsed && parsed.value !== undefined ? parsed.value : null;
  } catch (err) {
    console.warn(`⚠️ [SystemConfig] Exceção ao ler storage de "${key}":`, err.message);
    return null;
  }
}

async function writeStorage(key, value) {
  if (!(await ensureStorage())) return false;
  try {
    const payload = JSON.stringify({ value, updatedAt: new Date().toISOString() });
    const { error } = await withTimeout(
      client.storage.from(STORAGE_BUCKET).upload(storagePath(key), payload, {
        contentType: 'application/json',
        upsert: true
      }),
      8000,
      `gravação de storage "${key}"`
    );
    if (error) {
      console.warn(`⚠️ [SystemConfig] Falha ao gravar storage de "${key}":`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`⚠️ [SystemConfig] Exceção ao gravar storage de "${key}":`, err.message);
    return false;
  }
}

async function deleteStorage(key) {
  if (!(await ensureStorage())) return false;
  try {
    const { error } = await withTimeout(
      client.storage.from(STORAGE_BUCKET).remove([storagePath(key)]),
      6000,
      `remoção de storage "${key}"`
    );
    return !error;
  } catch (_) {
    return false;
  }
}

/**
 * Lê uma configuração durável.
 * @param {string} key
 * @param {*} fallback valor devolvido quando a chave não existe ou o Supabase falha
 */
export async function getSystemConfig(key, fallback = null) {
  if (!key) return fallback;
  if (memory.has(key)) return memory.get(key);

  const sb = getClient();
  let tableAnswered = false;
  if (sb) {
    try {
      const { data, error } = await withTimeout(
        sb.from(TABLE).select('value').eq('key', key).maybeSingle(),
        6000,
        `leitura de "${key}"`
      );

      if (!error) {
        tableAnswered = true;
        if (data && data.value !== null && data.value !== undefined) {
          memory.set(key, data.value);
          saveLocalCache(key, data.value);
          return data.value;
        }
      } else if (!isMissingTable(error)) {
        console.warn(`⚠️ [SystemConfig] Falha ao ler "${key}" do Supabase:`, error.message);
      } else if (!missingTableWarned) {
        missingTableWarned = true;
        console.warn(`⚠️ [SystemConfig] Tabela "${TABLE}" ausente. Usando o bucket privado "system" como fallback. Rode supabase-schema.sql para habilitar a tabela.`);
      }
    } catch (err) {
      console.warn(`⚠️ [SystemConfig] Exceção ao ler "${key}":`, err.message);
    }
  }

  // Fallback durável: bucket privado (só com SERVICE_ROLE_KEY).
  const stored = await readStorage(key);
  if (stored !== null && stored !== undefined) {
    memory.set(key, stored);
    saveLocalCache(key, stored);
    if (sb && clientUsesServiceRole) {
      // Migra para a tabela quando ela estiver disponível.
      setSystemConfig(key, stored).catch(() => {});
    }
    return stored;
  }

  // Se o Supabase respondeu que a chave não existe, NÃO ressuscita cache local.
  if (tableAnswered) return fallback;

  // Cold start sem Supabase (ou Supabase indisponível): tenta o cache efêmero.
  const local = localCache();
  if (local[key] !== undefined && local[key] !== null) {
    memory.set(key, local[key]);
    return local[key];
  }
  return fallback;
}

/**
 * Grava (UPSERT) uma configuração durável no Supabase.
 * O cache em /tmp é escrito antes para que a mesma invocação continue
 * funcionando mesmo se o Supabase estiver momentaneamente fora.
 * @returns {Promise<boolean>} true somente quando o Supabase confirmou a gravação.
 */
export async function setSystemConfig(key, value) {
  if (!key) return false;

  memory.set(key, value);
  saveLocalCache(key, value);

  const sb = getClient();
  let tableOk = false;
  if (sb) {
    try {
      const { error } = await withTimeout(
        sb.from(TABLE).upsert(
          { key, value, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        ),
        8000,
        `gravação de "${key}"`
      );

      if (!error) {
        tableOk = true;
      } else if (isMissingTable(error) && !missingTableWarned) {
        missingTableWarned = true;
        console.warn(`⚠️ [SystemConfig] Tabela "${TABLE}" ausente — tentando o bucket privado "system". Rode supabase-schema.sql.`);
      } else if (!isMissingTable(error)) {
        console.warn(`⚠️ [SystemConfig] Falha ao gravar "${key}" na tabela:`, error.message);
      }
    } catch (err) {
      console.warn(`⚠️ [SystemConfig] Exceção ao gravar "${key}":`, err.message);
    }
  }

  if (tableOk) return true;

  const stored = await writeStorage(key, value);
  if (stored) return true;

  console.warn(`⚠️ [SystemConfig] "${key}" ficou apenas no cache efêmero (/tmp). Configure SUPABASE_SERVICE_ROLE_KEY e rode supabase-schema.sql.`);
  return false;
}

/** Remove uma configuração durável. Nunca lança. */
export async function deleteSystemConfig(key) {
  if (!key) return false;
  memory.delete(key);
  saveLocalCache(key, undefined);

  const sb = getClient();
  let ok = false;
  if (sb) {
    try {
      const { error } = await withTimeout(sb.from(TABLE).delete().eq('key', key), 6000, `remoção de "${key}"`);
      if (!error || isMissingTable(error)) ok = true;
      else console.warn(`⚠️ [SystemConfig] Falha ao remover "${key}":`, error.message);
    } catch (err) {
      console.warn(`⚠️ [SystemConfig] Exceção ao remover "${key}":`, err.message);
    }
  }
  const storageOk = await deleteStorage(key);
  return ok || storageOk;
}

/** Diagnóstico seguro (sem expor valores). */
export function systemConfigStatus() {
  return {
    table: TABLE,
    supabaseConfigured: !!getClient(),
    serviceRole: clientUsesServiceRole,
    storageReady,
    cachedKeys: [...memory.keys()]
  };
}

/** Verifica se a tabela e o bucket privado estão prontos (sem ler valores). */
export async function systemConfigHealth() {
  const out = {
    table: TABLE,
    configured: !!getClient(),
    serviceRole: clientUsesServiceRole,
    tableReady: false,
    storageReady: false,
    error: null
  };
  const sb = getClient();
  if (!sb) {
    out.error = 'SUPABASE_URL e chave não configurados';
    return out;
  }
  try {
    const { error } = await withTimeout(sb.from(TABLE).select('key').limit(1), 4000, 'health da tabela');
    if (!error) out.tableReady = true;
    else out.error = error.message;
  } catch (err) {
    out.error = err.message;
  }
  if (clientUsesServiceRole) out.storageReady = await ensureStorage();
  return out;
}
