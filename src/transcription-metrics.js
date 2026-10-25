const normalizarPalavras = texto => String(texto || '')
  .normalize('NFC')
  .toLocaleLowerCase('pt-BR')
  .replace(/[\p{P}\p{S}]+/gu, ' ')
  .trim()
  .split(/\s+/u)
  .filter(Boolean);

const normalizarCaracteres = texto => String(texto || '')
  .normalize('NFC')
  .toLocaleLowerCase('pt-BR')
  .replace(/[\p{P}\p{S}]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

function alinharPalavras(ref, hyp) {
  const linhas = hyp.length + 1, celulas = (ref.length + 1) * linhas;
  if (celulas > 100_000_000) throw new RangeError('A amostra é grande demais para alinhamento em memória; divida a gravação em trechos antes de avaliar.');
  const ops = new Uint8Array(Math.ceil(celulas / 4)); // 2 bits por célula: diagonal, omissão ou inserção
  const escrever = (indice, op) => { const byte = indice >> 2, shift = (indice & 3) * 2; ops[byte] = (ops[byte] & ~(3 << shift)) | (op << shift); };
  const ler = indice => (ops[indice >> 2] >> ((indice & 3) * 2)) & 3;
  let anterior = new Uint32Array(linhas), atual = new Uint32Array(linhas);
  for (let j = 1; j < linhas; j++) { anterior[j] = j; escrever(j, 2); }
  for (let i = 1; i <= ref.length; i++) {
    atual[0] = i; escrever(i * linhas, 1);
    for (let j = 1; j < linhas; j++) {
      const diagonal = anterior[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const omissao = anterior[j] + 1;
      const insercao = atual[j - 1] + 1;
      // Empate favorece alinhamento/substituição, depois omissão; deixa inserção por último.
      if (diagonal <= omissao && diagonal <= insercao) { atual[j] = diagonal; escrever(i * linhas + j, 0); }
      else if (omissao <= insercao) { atual[j] = omissao; escrever(i * linhas + j, 1); }
      else { atual[j] = insercao; escrever(i * linhas + j, 2); }
    }
    [anterior, atual] = [atual, anterior];
  }
  let i = ref.length, j = hyp.length, substituicoes = 0, omissoes = 0, insercoes = 0;
  while (i || j) {
    const op = ler(i * linhas + j);
    if (i && j && op === 0) { if (ref[i - 1] !== hyp[j - 1]) substituicoes++; i--; j--; }
    else if (i && (!j || op === 1)) { omissoes++; i--; }
    else { insercoes++; j--; }
  }
  return { substituicoes, omissoes, insercoes, erros: substituicoes + omissoes + insercoes };
}

function ocorrencias(frase, palavras) {
  const termos = normalizarPalavras(frase);
  if (!termos.length) return 0;
  let n = 0;
  for (let i = 0; i <= palavras.length - termos.length; i++) {
    if (termos.every((termo, j) => palavras[i + j] === termo)) n++;
  }
  return n;
}

function medirAmostra(amostra) {
  if (!amostra || typeof amostra.reference !== 'string' || typeof amostra.hypothesis !== 'string') throw new TypeError('Cada amostra exige reference e hypothesis como texto.');
  const referencia = normalizarPalavras(amostra.reference), hipotese = normalizarPalavras(amostra.hypothesis);
  const caracteresReferencia = [...normalizarCaracteres(amostra.reference)], caracteresHipotese = [...normalizarCaracteres(amostra.hypothesis)];
  const palavras = alinharPalavras(referencia, hipotese), caracteres = alinharPalavras(caracteresReferencia, caracteresHipotese);
  const termosMedicos = [...new Set((Array.isArray(amostra.medicalTerms) ? amostra.medicalTerms : []).map(String).map(x => x.trim()).filter(Boolean))]
    .map(term => ({ term, referenceOccurrences: ocorrencias(term, referencia), hypothesisOccurrences: ocorrencias(term, hipotese) }))
    .filter(item => item.referenceOccurrences !== item.hypothesisOccurrences);
  const durationInput = amostra.durationSeconds == null || amostra.durationSeconds === '' ? NaN : Number(amostra.durationSeconds);
  const latencyInput = amostra.latencyMs == null || amostra.latencyMs === '' ? NaN : Number(amostra.latencyMs);
  const costInput = amostra.costUsd == null || amostra.costUsd === '' ? NaN : Number(amostra.costUsd);
  const durationSeconds = Number.isFinite(durationInput) && durationInput > 0 ? durationInput : null;
  const latencyMs = Number.isFinite(latencyInput) && latencyInput >= 0 ? latencyInput : null;
  const costUsd = Number.isFinite(costInput) && costInput >= 0 ? costInput : null;
  return {
    id: String(amostra.id || ''), pipeline: String(amostra.pipeline || amostra.model || 'não informado'), audioVariant: String(amostra.audioVariant || 'original'),
    referenceWords: referencia.length, hypothesisWords: hipotese.length, referenceCharacters: caracteresReferencia.length, hypothesisCharacters: caracteresHipotese.length,
    wer: referencia.length ? palavras.erros / referencia.length : null,
    cer: caracteresReferencia.length ? caracteres.erros / caracteresReferencia.length : null,
    wordErrors: palavras, characterErrors: caracteres,
    omissionRate: referencia.length ? palavras.omissoes / referencia.length : null,
    insertionRate: hipotese.length ? palavras.insercoes / hipotese.length : null,
    medicalTermMismatches: termosMedicos,
    durationSeconds, latencyMs, costUsd,
    latencySecondsPerAudioHour: durationSeconds > 0 && latencyMs != null ? latencyMs / 1000 / (durationSeconds / 3600) : null,
    costUsdPerAudioHour: durationSeconds > 0 && costUsd != null ? costUsd / (durationSeconds / 3600) : null
  };
}

export function scoreTranscriptionSamples(input) {
  const samples = Array.isArray(input) ? input : input && input.samples;
  if (!Array.isArray(samples) || !samples.length) throw new TypeError('Forneça um array não vazio de amostras revisadas.');
  const results = samples.map(medirAmostra), groups = new Map();
  for (const sample of results) {
    const key = `${sample.pipeline}\u0000${sample.audioVariant}`;
    if (!groups.has(key)) groups.set(key, { pipeline: sample.pipeline, audioVariant: sample.audioVariant, samples: 0, referenceWords: 0, hypothesisWords: 0, referenceCharacters: 0, hypothesisCharacters: 0, wordErrors: { substituicoes: 0, omissoes: 0, insercoes: 0, erros: 0 }, characterErrors: { substituicoes: 0, omissoes: 0, insercoes: 0, erros: 0 }, medicalTermMismatches: 0, durationSeconds: 0, durationSamples: 0, latencyMsTotal: 0, latencySamples: 0, costUsdTotal: 0, costSamples: 0 });
    const group = groups.get(key); group.samples++; group.referenceWords += sample.referenceWords; group.hypothesisWords += sample.hypothesisWords; group.referenceCharacters += sample.referenceCharacters; group.hypothesisCharacters += sample.hypothesisCharacters;
    for (const kind of ['substituicoes', 'omissoes', 'insercoes', 'erros']) { group.wordErrors[kind] += sample.wordErrors[kind]; group.characterErrors[kind] += sample.characterErrors[kind]; }
    group.medicalTermMismatches += sample.medicalTermMismatches.length;
    if (sample.durationSeconds != null) { group.durationSeconds += sample.durationSeconds; group.durationSamples++; }
    if (sample.latencyMs != null) { group.latencyMsTotal += sample.latencyMs; group.latencySamples++; }
    if (sample.costUsd != null) { group.costUsdTotal += sample.costUsd; group.costSamples++; }
  }
  const summaries = [...groups.values()].map(group => ({ ...group,
    wer: group.referenceWords ? group.wordErrors.erros / group.referenceWords : null,
    cer: group.referenceCharacters ? group.characterErrors.erros / group.referenceCharacters : null,
    omissionRate: group.referenceWords ? group.wordErrors.omissoes / group.referenceWords : null,
    insertionRate: group.hypothesisWords ? group.wordErrors.insercoes / group.hypothesisWords : null,
    durationSeconds: group.durationSamples === group.samples ? group.durationSeconds : null,
    latencyMs: group.latencySamples === group.samples ? group.latencyMsTotal : null,
    costUsd: group.costSamples === group.samples ? group.costUsdTotal : null,
    latencySecondsPerAudioHour: group.durationSamples === group.samples && group.latencySamples === group.samples && group.durationSeconds > 0 ? group.latencyMsTotal / 1000 / (group.durationSeconds / 3600) : null,
    costUsdPerAudioHour: group.durationSamples === group.samples && group.costSamples === group.samples && group.durationSeconds > 0 ? group.costUsdTotal / (group.durationSeconds / 3600) : null
  }));
  return { samples: results, groups: summaries };
}
