import '../src/load-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { indexIscCatalog, loadIscCatalog, loadIscTaxonomy } from '../src/isc-indexer.js';

const args = new Set(process.argv.slice(2));
const values = process.argv.slice(2);
const argValue = name => values.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const maxArg = values.find(arg => arg.startsWith('--max-resources='));
const maxResources = maxArg ? Number(maxArg.slice('--max-resources='.length)) : Infinity;
if (Number.isFinite(maxResources) && (!Number.isInteger(maxResources) || maxResources < 0)) throw new Error('--max-resources precisa ser um inteiro não negativo.');

const apply = args.has('--apply');
const allowLocalCatalog = args.has('--allow-local-catalog');
const metadataOnly = args.has('--metadata-only');
const catalogFile = argValue('--catalog-file');
const mergeBasePath = argValue('--merge-base') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'acervo-manifest.json');
const hasServiceCredentials = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = hasServiceCredentials ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
}) : null;
const { catalog, source } = await loadIscCatalog(supabase, mergeBasePath, { catalogFile, mergeBasePath: catalogFile ? mergeBasePath : null });
const taxonomy = await loadIscTaxonomy();

if (apply && !supabase) throw new Error('Para --apply, configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no servidor local.');
if (apply && source !== 'supabase_storage' && source !== 'explicit_local_catalog' && !allowLocalCatalog) {
  throw new Error('O catálogo do Storage não foi encontrado. O catálogo local pode estar desatualizado; use --allow-local-catalog apenas após conferi-lo.');
}

const result = await indexIscCatalog(supabase || {}, catalog, {
  taxonomy,
  apply,
  metadataOnly,
  maxResources,
  onProgress: progress => console.log(`[ISC] Recursos indexados: ${progress.processed}/${progress.total}; segmentos ${progress.segments}.`)
});

console.log(JSON.stringify({ source, metadataOnly, ...result }, null, 2));
if (!apply) console.log('[ISC] Prévia sem gravação no banco e sem chamadas ao provedor de embeddings. Para aplicar, confira o catálogo e execute com --apply.');
