import assert from 'node:assert/strict';
import { selecionarComCobertura } from '../../src/questoes-aula.js';

const topics = [
  { topicId: 'uti.ventilacao.pressao_suporte', name: 'Pressão de suporte', synonyms: ['PSV'], sourceKind: 'catalog_metadata', evidence: [] },
  { topicId: 'uti.ventilacao.nao_invasiva', name: 'Ventilação não invasiva', synonyms: ['VNI'], sourceKind: 'catalog_metadata', evidence: [] },
  { topicId: 'uti.ventilacao.desmame', name: 'Desmame ventilatório', synonyms: [], sourceKind: 'catalog_metadata', evidence: [] }
];
const question = (id, statement, options, correctIndex, difficulty = 'Médio', explanation = '') => ({
  id, statement, options, correctIndex, difficulty, explanation, specialty: 'Terapia Intensiva', tags: ['Ventilação mecânica']
});
const bank = [
  question('q-psv', 'Na ventilação mecânica, como a pressão de suporte auxilia o paciente?', ['Aumenta o suporte inspiratório', 'Reduz a FiO2', 'Substitui a PEEP', 'Impede o disparo'], 0, 'Fácil'),
  question('q-vni', 'Em uma exacerbação de DPOC, quando considerar ventilação não invasiva?', ['Somente após intubação', 'Na presença de critérios clínicos apropriados', 'Nunca', 'Como substituto de oxigênio em todos os casos'], 1, 'Difícil'),
  question('q-both', 'Na ventilação não invasiva, o modo com pressão de suporte permite o quê?', ['Assistir a inspiração com pressão acima da expiração', 'Eliminar toda necessidade de monitorização', 'Garantir intubação', 'Dispensar ajuste de interface'], 0, 'Médio'),
  question('q-vni-duplicate', 'Em uma exacerbação de DPOC, quando considerar ventilação não invasiva?', ['Somente após intubação', 'Na presença de critérios clínicos apropriados', 'Nunca', 'Como substituto de oxigênio em todos os casos'], 1, 'Médio'),
  question('q-no-key', 'Quando indicar desmame ventilatório?', ['Avaliar prontidão clínica', 'Sempre após uma hora', 'Nunca', 'Sem avaliar o paciente'], -1),
  question('q-asthma', 'Qual é o mecanismo da hiper-reatividade brônquica na asma?', ['Inflamação das vias aéreas', 'Falha de bomba cardíaca', 'Obstrução urinária', 'Lesão renal'], 0)
];

const result = selecionarComCobertura(bank, {
  tema: 'Ventilação mecânica', topics, limit: 3, mode: 'review', includeComplementary: true
});
assert.ok(result.questions.length > 0 && result.questions.length <= 3, 'respeita o limite solicitado sem preencher com redundância');
assert.ok(result.questions.every(item => item.curriculumMatch?.relations?.length), 'cada questão selecionada deve ter relação curricular registrada');
assert.ok(!result.questions.some(item => item.id === 'q-asthma'), 'remove questões irrelevantes');
assert.ok(!result.questions.some(item => item.id === 'q-vni-duplicate'), 'remove enunciados duplicados');
assert.ok(result.objectives.some(item => item.topicId === 'uti.ventilacao.pressao_suporte' && item.relation !== 'uncovered'));
assert.ok(result.objectives.some(item => item.topicId === 'uti.ventilacao.nao_invasiva' && item.relation !== 'uncovered'));
assert.equal(result.objectives.find(item => item.topicId === 'uti.ventilacao.desmame').relation, 'uncovered');
assert.equal(result.coverage.nominal, 2 / 3, 'cobertura nominal reflete objetivos com ao menos uma relação lexical');
assert.equal(result.coverage.weighted, null, 'não inventa pesos de objetivos');
assert.equal(result.coverage.cognitive, null, 'não inventa classificação cognitiva');
assert.equal(result.coverage.evidenceMode, 'metadata_lexical_estimate');
assert.ok(result.diagnostics.missingAnswerCount >= 1, 'reporta questões sem gabarito elegível');

const unanswered = selecionarComCobertura(bank, {
  tema: 'Ventilação mecânica', topics, limit: 10, excludeAnswered: true,
  excludedIds: ['q-psv', 'q-both'], difficulty: 'hard', mode: 'reinforcement', prioritizeIds: ['q-vni']
});
assert.ok(unanswered.questions.every(item => item.id === 'q-vni'), 'aplica dificuldade e exclusão de respondidas antes da seleção');
assert.equal(unanswered.diagnostics.excludedAnsweredCount, 2);

const directOnly = selecionarComCobertura(bank, {
  tema: 'Ventilação mecânica', topics, limit: 10, includeComplementary: false
});
assert.ok(directOnly.questions.every(item => item.curriculumMatch.directTopicIds.length > 0), 'sem complementares, mantém relações diretas');

const letterGabarito = question('q-letter', 'Como reconhecer pressão de suporte na ventilação mecânica?', ['Assistência inspiratória', 'Redução de PEEP', 'Sedação contínua', 'Ausência de disparo'], -1);
letterGabarito.correctLetter = 'A';
const letterSelection = selecionarComCobertura([letterGabarito], { tema: 'pressão de suporte', topics: [topics[0]], limit: 1 });
assert.equal(letterSelection.questions.length, 1, 'gabarito por letra também é reconhecido');

const metadataFallback = selecionarComCobertura(bank, { tema: 'pressão de suporte ventilação', limit: 1 });
assert.ok(metadataFallback.coverage.nominal === null || metadataFallback.objectives.length > 0, 'fallback funciona sem índice do vídeo');
assert.ok(metadataFallback.diagnostics.limitations.some(text => text.includes('metadados')), 'explicita limite sem evidência do conteúdo do vídeo');

const emptyBank = selecionarComCobertura([], { tema: 'ventilação mecânica', topics: [topics[0]], limit: 5 });
assert.equal(emptyBank.questions.length, 0, 'banco vazio não inventa questões');
assert.equal(emptyBank.total, 0);
assert.equal(emptyBank.objectives[0].relation, 'uncovered', 'objetivo sem questão permanece como lacuna');

const lowConfidence = selecionarComCobertura(bank, {
  tema: '', modulo: '', topics: [{ topicId: 'uncertain.topic', name: 'Asma', sourceKind: 'transcript', confidence: 0.2, evidence: [] }]
});
assert.equal(lowConfidence.objectives.length, 0, 'tópico de baixa confiança não vira objetivo confirmado');
assert.equal(lowConfidence.diagnostics.lowConfidenceTopicCount, 1);
assert.ok(lowConfidence.diagnostics.limitations.some(text => text.includes('excluídos')));

console.log('OK — Smart Questions: cobertura nominal, relações, filtros, deduplicação, ausência de gabarito e limites explícitos.');
