import assert from 'node:assert/strict';
import { scoreTranscriptionSamples } from '../../src/transcription-metrics.js';

const report = scoreTranscriptionSamples({ samples: [
  { id: 'old-omission', pipeline: 'baseline', audioVariant: 'original', reference: 'Alpha, beta gamma.', hypothesis: 'alpha gamma', durationSeconds: 3600, latencyMs: 1_800_000, costUsd: 0.04 },
  { id: 'old-insertion', pipeline: 'baseline', audioVariant: 'original', reference: 'Alpha beta gamma', hypothesis: 'alpha beta gamma delta', durationSeconds: 3600, latencyMs: 1_800_000, costUsd: 0.04 },
  { id: 'new', pipeline: 'candidate', audioVariant: 'original', reference: 'Adrenalina 1 mg', hypothesis: 'Amiodarona 1 mg', durationSeconds: 1800, latencyMs: 900_000, costUsd: 0.02, medicalTerms: ['adrenalina', 'amiodarona'] },
  { id: 'treated', pipeline: 'candidate', audioVariant: 'treated', reference: 'Adrenalina 1 mg', hypothesis: 'Adrenalina 1 mg', durationSeconds: 1800, latencyMs: 450_000, costUsd: 0.02, medicalTerms: ['adrenalina'] }
] });

assert.equal(report.samples.length, 4);
const baseline = report.groups.find(group => group.pipeline === 'baseline');
assert.equal(baseline.wer, 1 / 3);
assert.equal(baseline.wordErrors.omissoes, 1);
assert.equal(baseline.wordErrors.insercoes, 1);
assert.equal(baseline.latencySecondsPerAudioHour, 1800);
assert.equal(baseline.costUsdPerAudioHour, 0.04);
const candidateOriginal = report.samples.find(sample => sample.id === 'new');
assert.equal(candidateOriginal.medicalTermMismatches.length, 2);
const candidateTreated = report.samples.find(sample => sample.id === 'treated');
assert.equal(candidateTreated.wer, 0);
assert.equal(candidateTreated.cer, 0);
assert.equal(candidateTreated.medicalTermMismatches.length, 0);
const noReference = scoreTranscriptionSamples([{ reference: '', hypothesis: 'palavra' }]).samples[0];
assert.equal(noReference.wer, null, 'ausência de referência não deve produzir WER artificial');
const noTelemetry = scoreTranscriptionSamples([{ reference: 'fala', hypothesis: 'fala' }]).samples[0];
assert.equal(noTelemetry.latencySecondsPerAudioHour, null, 'latência ausente não deve virar zero');
assert.equal(noTelemetry.costUsdPerAudioHour, null, 'custo ausente não deve virar zero');
console.log('Transcription metrics: WER, CER, omissions, insertions, medical terms, latency and cost OK');
