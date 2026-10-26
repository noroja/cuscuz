import '../src/load-env.js';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { indexAcervoSemantic } from '../src/acervo-semantic-indexer.js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para publicar o índice privado.');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const runId = randomUUID();
let offset = 0;
let result;
do {
  result = await indexAcervoSemantic(supabase, {
    runId,
    offset,
    onProgress: progress => console.log(`[Busca semântica] ${progress}`)
  });
  offset = result.nextOffset;
} while (!result.complete);

console.log(`[Busca semântica] Índice publicado: ${result.quantidade} itens, ${result.dimensoes} dimensões, ${result.kilobytes} KB de vetores.`);
