/* ═══════════════════════════════════════════════════════════════════════════════
   SYSTEM CONFIG — estado durável de configuração no Supabase.

   Na Vercel o sistema de arquivos da aplicação é somente leitura e /tmp é
   apagado entre invocações (cold start). Tokens e segredos de integração NÃO
   podem viver em arquivo: a fonte da verdade é a tabela `system_configs`.

       key   text primary key
       value jsonb not null
       updated_at timestamptz not null

   Estratégia de leitura (em ordem):
     1. cache em memória da invocação;
     2. Supabase (system_configs);
     3. cache local em /tmp — apenas fallback para dev/offline.

   Estratégia de escrita:
     1. memória;
     2. cache local em /tmp (best-effort, nunca lança);
     3. UPSERT no Supabase (durável).

   Nenhuma função lança exceção: falha de rede/Supabase vira retorno falsy.
   ═══════════════════════════════════════════════════════════════════════════════ */
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { safeReadJson, safeWriteJson, TMP_DIR } from './fs-safe.js';

const TABLE = 'system_configs';
const LOCAL_CACHE = path.join(TMP_DIR, 'system-configs.json');

const memory = new Map();
let client = null;
let clientTried = false;
let missingTableWarned = false;

function getClient() {
  if (clientTried) return client;
  clientTried = true;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = serviceKey || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('⚠️ [SystemConfig] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes: usando apenas cache efêmero em /tmp.');
    return null;
  }
  if (!serviceKey) {
    console.warn('⚠️ [SystemConfig] Sem SUPABASE_SERVICE_ROLE_KEY: a RLS de system_configs bloqueia a chave anon. O token ficará só no /tmp.');
  }
  try {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    // Evita manter o processo acordado desnecessariamente em serverless.
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
  // Best-effort: em ambiente somente leitura o helper apenas devolve false.
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

/**
 * Lê uma configuração durável.
 * @param {string} key
 * @param {*} fallback valor devolvido quando a chave não existe ou o Supabase falha
 */
export async function getSystemConfig(key, fallback = null) {
  if (!key) return fallback;
  if (memory.has(key)) return memory.get(key);

  const sb = getClient();
  let supabaseAnswered = false;
  if (sb) {
    try {
      const { data, error } = await withTimeout(
        sb.from(TABLE).select('value').eq('key', key).maybeSingle(),
        6000,
        `leitura de "${key}"`
      );

      if (!error) {
        // O Supabase respondeu: ele é a fonte da verdade, inclusive quando não há linha.
        supabaseAnswered = true;
        if (data && data.value !== null && data.value !== undefined) {
          memory.set(key, data.value);
          saveLocalCache(key, data.value);
          return data.value;
        }
      } else if (!isMissingTable(error)) {
        console.warn(`⚠️ [SystemConfig] Falha ao ler "${key}" do Supabase:`, error.message);
      } else if (!missingTableWarned) {
        missingTableWarned = true;
        console.warn(`⚠️ [SystemConfig] Tabela "${TABLE}" ausente. Rode supabase-schema.sql para habilitar o estado durável.`);
      }
    } catch (err) {
      console.warn(`⚠️ [SystemConfig] Exceção ao ler "${key}":`, err.message);
    }
  }

  // Se o Supabase respondeu que a chave não existe, NÃO ressuscita cache local.
  if (supabaseAnswered) return fallback;

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
  if (!sb) return false;

  try {
    const { error } = await withTimeout(
      sb.from(TABLE).upsert(
        { key, value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      ),
      8000,
      `gravação de "${key}"`
    );

    if (error) {
      if (isMissingTable(error) && !missingTableWarned) {
        missingTableWarned = true;
        console.warn(`⚠️ [SystemConfig] Tabela "${TABLE}" ausente — a configuração "${key}" ficou só no cache efêmero. Rode supabase-schema.sql.`);
      } else if (!isMissingTable(error)) {
        console.warn(`⚠️ [SystemConfig] Falha ao gravar "${key}" no Supabase:`, error.message);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`⚠️ [SystemConfig] Exceção ao gravar "${key}":`, err.message);
    return false;
  }
}

/** Remove uma configuração durável. Nunca lança. */
export async function deleteSystemConfig(key) {
  if (!key) return false;
  memory.delete(key);
  saveLocalCache(key, undefined);

  const sb = getClient();
  if (!sb) return false;

  try {
    const { error } = await withTimeout(sb.from(TABLE).delete().eq('key', key), 6000, `remoção de "${key}"`);
    if (error && !isMissingTable(error)) {
      console.warn(`⚠️ [SystemConfig] Falha ao remover "${key}":`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`⚠️ [SystemConfig] Exceção ao remover "${key}":`, err.message);
    return false;
  }
}

/** Diagnóstico seguro (sem expor valores). */
export function systemConfigStatus() {
  return {
    table: TABLE,
    supabaseConfigured: !!getClient(),
    cachedKeys: [...memory.keys()]
  };
}
