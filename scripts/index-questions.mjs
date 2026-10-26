import '../src/load-env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { assertQuestionIndexTarget, indexQuestionBank, loadQuestionIndexTaxonomy } from '../src/question-index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argValue = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const apply = args.includes('--apply');
const targetRef = argValue('--target-ref');
const embed = args.includes('--embed');
const bankPath = path.resolve(argValue('--bank-file') || path.join(ROOT, 'data', 'questions-bank.json'));

const bank = JSON.parse(await fs.readFile(bankPath, 'utf8'));
if (!Array.isArray(bank)) throw new Error('O arquivo do banco de questões precisa conter uma lista JSON.');
const taxonomy = await loadQuestionIndexTaxonomy();

let supabase = null;
if (apply) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('A aplicação do índice exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do servidor.');
  }
  assertQuestionIndexTarget(process.env.SUPABASE_URL, targetRef);
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

const report = await indexQuestionBank(supabase, bank, taxonomy, {
  apply, embed,
  onProgress: progress => progress.embeddingsTotal != null
    ? console.log(`[Questões] Embeddings: ${progress.embeddingsProcessed}/${progress.embeddingsTotal}.`)
    : console.log(`[Questões] Persistidas: ${progress.processed}/${progress.total}.`)
});
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('[Questões] Prévia somente local. --embed nesta etapa apenas estima o lote; somente --apply --embed envia texto ao provedor configurado.');
