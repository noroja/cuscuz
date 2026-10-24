import '../src/load-env.js';
import { createClient } from '@supabase/supabase-js';
import { indexAcervoSemantic } from '../src/acervo-semantic-indexer.js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para publicar o índice privado.');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const result = await indexAcervoSemantic(supabase, {
  onProgress: progress => console.log(`[Busca semântica] ${progress}`)
});

console.log(`[Busca semântica] Índice publicado: ${result.quantidade} itens, ${result.dimensoes} dimensões, ${result.kilobytes} KB de vetores.`);
