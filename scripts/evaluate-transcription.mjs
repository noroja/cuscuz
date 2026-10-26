import fs from 'node:fs';
import { scoreTranscriptionSamples } from '../src/transcription-metrics.js';

const path = process.argv[2];
if (!path || path === '--help') {
  console.log('Uso: node scripts/evaluate-transcription.mjs <amostras.json>');
  console.log('Cada amostra: id, pipeline, audioVariant, reference, hypothesis, durationSeconds, latencyMs, costUsd e medicalTerms[].');
  process.exit(path === '--help' ? 0 : 2);
}

try {
  const input = JSON.parse(fs.readFileSync(path, 'utf8'));
  const report = scoreTranscriptionSamples(input);
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), normalization: 'minúsculas; pontuação/símbolos removidos; acentos preservados; espaços normalizados', report }, null, 2) + '\n');
} catch (error) {
  console.error('Não foi possível avaliar as amostras:', error.message);
  process.exitCode = 1;
}
