// Avalia uma transcrição contra uma referência revisada por humano.
// Uso: node scripts/avaliacao/transcricao.mjs referencia.txt hipotese.txt
import fs from 'node:fs';
import { wer, cer, errosCriticos } from '../../src/aula-qualidade.js';
const [refP, hipP] = process.argv.slice(2);
if (!refP || !hipP) { console.error('Uso: node scripts/avaliacao/transcricao.mjs referencia.txt hipotese.txt'); process.exit(2); }
const ref = fs.readFileSync(refP, 'utf8'), hip = fs.readFileSync(hipP, 'utf8');
const crit = errosCriticos(ref, hip);
console.log(JSON.stringify({ WER: +(wer(ref, hip) * 100).toFixed(2) + '%', CER: +(cer(ref, hip) * 100).toFixed(2) + '%', errosCriticos_numeroUnidadeAusenteNaHipotese: crit }, null, 2));
