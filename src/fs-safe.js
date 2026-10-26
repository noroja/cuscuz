/* ═══════════════════════════════════════════════════════════════════════════════
   FS-SAFE — Acesso a disco compatível com ambientes serverless (Vercel).

   Na Vercel o diretório da aplicação é SOMENTE LEITURA; apenas /tmp é gravável
   (e de forma efêmera, por invocação). Estes helpers:
     • nunca lançam exceção (falha = retorno falsy);
     • devolvem um diretório realmente gravável (o projeto quando possível, /tmp
       quando estiver em serverless ou quando o projeto for read-only);
     • centralizam leitura/escrita de JSON para eliminar `fs.writeFileSync` solto.

   Regra de arquitetura: o ESTADO DURÁVEL do catálogo vive 100% na nuvem
   (Supabase Storage/DB). Disco e /tmp servem apenas como cache efêmero.
   ═══════════════════════════════════════════════════════════════════════════════ */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** true quando rodando como função serverless (Vercel/AWS Lambda). */
export const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL_ENV);

/** Diretório temporário gravável e efêmero (nunca persistente). */
export const TMP_DIR = path.join(os.tmpdir(), 'cuscuz-med');

/**
 * Escolhe um diretório gravável.
 * Em serverless usa /tmp; fora dele prefere o diretório informado e cai para /tmp.
 * Retorna null se nada for gravável (aí o chamador deve operar 100% em memória).
 */
export function writableDir(preferred) {
  // Em serverless prioriza /tmp; fora dele prioriza o diretório pedido.
  const candidates = IS_SERVERLESS
    ? [TMP_DIR, preferred]
    : [preferred, TMP_DIR];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) { /* tenta o próximo */ }
  }
  return null;
}

/** Lê e faz parse de um JSON. Nunca lança: devolve `fallback` em qualquer erro. */
export function safeReadJson(file, fallback = null) {
  try {
    if (!file || !fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

/**
 * Grava um JSON de forma atômica (tmp + rename). Nunca lança.
 * Retorna true em sucesso, false em qualquer falha (ex.: read-only file system).
 */
export function safeWriteJson(file, obj) {
  try {
    if (!file) return false;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

/** Remove um arquivo temporário sem lançar. */
export function safeUnlink(file) {
  try { if (file) fs.unlinkSync(file); } catch (_) {}
}
