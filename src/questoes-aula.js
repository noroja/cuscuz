// Seleção de questões que CORRESPONDEM à videoaula (tema do vídeo + módulo), não ao assunto "em geral".
// Pontuação por palavras raras (IDF) do tema, com cobertura mínima: a questão precisa falar do que a aula fala.

const STOP = new Set(['de','da','do','das','dos','em','para','com','sem','por','sobre','que','uma','uns','umas','aula','aulas','curso','modulo','parte','bloco','extensivo','intensivo','geral','medicina','video','videos','videoaula','apostila','introducao','conceitos','principais','doencas','doenca','tratamento','diagnostico','clinica','quadro','revisao','resumo','casos','caso','tema','temas','na','no','nas','nos','ao','aos','as','os','e','ou','um','a','o','se','sua','seu','mais','como','pre','pos','med','medcurso','estrategia','sanar','rmais','bonus','extra','videoaula','gravada','ao','vivo','live']);

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();

// Sinônimos/siglas clínicas: casar qualquer um conta como o mesmo conceito
const SIN = [
  ['hipertensao','has','anti-hipertensiv','pressao arterial'],
  ['insuficiencia cardiaca','icfer','icfep','icc'],
  ['infarto','iam','sindrome coronariana','sca','coronariana'],
  ['fibrilacao atrial','fa','flutter'],
  ['diabetes','dm','diabetico','hiperglicemi'],
  ['tireoide','tireoid','hipotireoidismo','hipertireoidismo','tsh'],
  ['pneumonia','pac','pneumonias'],
  ['asma','broncoespasmo'],
  ['dpoc','enfisema','bronquite cronica'],
  ['avc','acidente vascular','ave'],
  ['sepse','choque septico','sepsis'],
  ['apendicite','apendic'],
  ['colecistite','colecist','colelitiase'],
  ['pancreatite','pancreat'],
  ['pre-eclampsia','preeclampsia','eclampsia','dheg','hipertensao gestacional'],
  ['tuberculose','tb'],
  ['hiv','aids'],
  ['dengue','arbovirose'],
  ['lupus','les'],
  ['artrite reumatoide','ar'],
  ['sdra','sindrome do desconforto respiratorio'],
  ['injuria renal aguda','ira','lesao renal aguda'],
  ['doenca renal cronica','drc','insuficiencia renal cronica'],
  ['cirrose','hepatopatia cronica'],
  ['leucemia','leucemias'],
  ['linfoma','linfomas'],
  ['anemia','anemias']
];

function sinonimosDe(tok) {
  const out = new Set([tok]);
  for (const g of SIN) if (g.some(x => x === tok || (x.length > 4 && tok.length > 4 && (x.startsWith(tok) || tok.startsWith(x))))) g.forEach(x => out.add(x));
  return [...out];
}

const stemOf = t => (t.length > 6 ? t.slice(0, t.length - 2) : t.length > 4 ? t.slice(0, t.length - 1) : t);

function tokens(texto) {
  return norm(texto).split(' ').filter(t => t.length > 2 && !STOP.has(t) && !/\d/.test(t));
}

// Índice por questão (cache por referência ao banco)
let _idx = null, _idxFor = null;
function indexar(bank) {
  if (_idxFor === bank && _idx) return _idx;
  const docs = bank.map(q => {
    const st = norm(String(q.statement || '').slice(0, 900));
    const ex = norm(String(q.explanation || '').slice(0, 500));
    const op = norm((Array.isArray(q.options) ? q.options : []).join(' ').slice(0, 900));
    const meta = norm([q.subspecialty, q.specialty, ...(Array.isArray(q.tags) ? q.tags : [])].join(' '));
    return { q, st, ex, op, meta, all: ' ' + st + ' ' + ex + ' ' + op + ' ' + meta + ' ' };
  });
  _idx = docs; _idxFor = bank;
  return docs;
}

// siglas curtas (≤3 letras) só casam como palavra inteira; o resto casa no começo da palavra (plural/derivações)
const temPalavra = (texto, stem) => stem.length <= 3 ? texto.includes(' ' + stem + ' ') : texto.includes(' ' + stem);

function selecionar(bank, { tema, modulo, disc, limit = 40 } = {}) {
  const docs = indexar(bank);
  const tt = tokens(tema);
  const mt = tokens(modulo).filter(t => !tt.includes(t));
  // Se o título do vídeo é genérico ("38", "Índice"), o módulo vira o tema
  const principais = tt.length ? tt : mt;
  const secundarios = tt.length ? mt : [];
  if (!principais.length) return { questions: [], total: 0, exatas: 0, termos: [] };

  const N = docs.length || 1;
  const conceito = tok => {
    const syn = sinonimosDe(tok).map(x => (x.length <= 3 ? x : stemOf(x)));
    let df = 0;
    for (const d of docs) if (syn.some(s => temPalavra(d.all, s))) df++;
    return { tok, syn, idf: Math.log(1 + N / (1 + df)), df };
  };
  const cp = principais.map(conceito);
  const cs = secundarios.map(conceito);
  const totalIdf = cp.reduce((a, c) => a + c.idf, 0) || 1;
  const frase = tt.length >= 2 ? norm(tema) : '';
  const discN = norm(disc);

  const pontuadas = [];
  for (const d of docs) {
    let hit = 0, score = 0;
    for (const c of cp) {
      const onde = c.syn.some(s => temPalavra(d.meta, s)) ? 1.6
        : c.syn.some(s => temPalavra(d.st, s)) ? 1
        : c.syn.some(s => temPalavra(d.ex, s)) ? 0.6
        : c.syn.some(s => temPalavra(d.op, s)) ? 0.4 : 0;
      if (onde) { hit += c.idf; score += c.idf * onde; }
    }
    if (!hit) continue;
    const cobertura = hit / totalIdf;
    // exige que a questão cubra a maior parte dos conceitos do tema (tema curto: todos)
    const minCob = principais.length === 1 ? 0.99 : principais.length === 2 ? 0.55 : principais.length === 3 ? 0.6 : 0.6;
    const fraseOk = frase && (d.st.includes(frase) || d.ex.includes(frase));
    if (cobertura < minCob && !fraseOk) continue;
    if (fraseOk) score += 6;
    for (const c of cs) if (c.syn.some(s => temPalavra(d.st, s) || temPalavra(d.ex, s))) score += c.idf * 0.35;
    if (discN && (norm(d.q.specialty).includes(discN) || discN.includes(norm(d.q.specialty)) || norm(d.q.subspecialty).includes(discN))) score += 0.8;
    pontuadas.push({ q: d.q, score, cobertura, fraseOk });
  }
  pontuadas.sort((a, b) => b.score - a.score || (b.q.year || 0) - (a.q.year || 0));
  const exatas = pontuadas.filter(p => p.cobertura >= 0.99 || p.fraseOk).length;
  const sel = pontuadas.slice(0, limit).map(p => Object.assign({}, p.q, { _rel: p.cobertura >= 0.99 || p.fraseOk ? 'alta' : 'media', _matchScore: p.score }));
  return { questions: sel, total: pontuadas.length, exatas, termos: principais };
}

function questionId(question) {
  return String(question?.id || question?.remoteId || '').trim();
}

function hasTerm(text, term) {
  const phrase = norm(term);
  if (!phrase) return false;
  if (phrase.includes(' ')) return (` ${text} `).includes(` ${phrase} `);
  return text.split(' ').some(word => word === phrase || (phrase.length >= 5 && word.startsWith(phrase)) || (word.length >= 5 && phrase.startsWith(word)));
}

function topicTerms(topic) {
  return [...new Set(tokens(topic.name || '').filter(token => token.length >= 3))].slice(0, 12);
}

function difficultyLevel(value) {
  const text = norm(value);
  if (/facil|easy|basico/.test(text)) return 'easy';
  if (/dificil|hard|avancado/.test(text)) return 'hard';
  if (/medio|moderado|intermediario/.test(text)) return 'medium';
  return 'unknown';
}

function answerIndex(question) {
  const options = Array.isArray(question.options) ? question.options : Array.isArray(question.opts) ? question.opts : [];
  const explicit = [question.correctIndex, question.ans].find(index => Number.isInteger(index) && index >= 0 && index < options.length);
  const fromLetter = /^[A-Z]$/i.test(String(question.correctLetter || '')) ? String(question.correctLetter).toUpperCase().charCodeAt(0) - 65 : -1;
  const index = Number.isInteger(explicit) ? explicit : fromLetter >= 0 && fromLetter < options.length ? fromLetter
    : typeof question.correctAnswer === 'string' ? options.indexOf(question.correctAnswer) : -1;
  return index >= 0 && index < options.length ? index : -1;
}

// Cobertura lexical verificável; não substitui validação pedagógica nem classificação humana.
function selecionarComCobertura(bank, {
  tema, modulo, disc, limit = 10, topics = [], mode = 'review', difficulty = 'all',
  excludeAnswered = false, excludedIds = [], prioritizeIds = [], includeComplementary = true
} = {}) {
  const max = Math.max(1, Math.min(60, Number.parseInt(limit, 10) || 10));
  const rawProvided = Array.isArray(topics) ? topics.filter(topic => topic && typeof topic.name === 'string' && topic.name.trim()).slice(0, 30) : [];
  const lowConfidenceTopics = rawProvided.filter(topic => topic.confidence != null && topic.confidence !== '' &&
    Number.isFinite(Number(topic.confidence)) && Number(topic.confidence) < 0.45);
  const provided = rawProvided.filter(topic => !lowConfidenceTopics.includes(topic));
  const themeTerms = tokens(tema);
  const fallbackNames = (themeTerms.length ? themeTerms : tokens(modulo)).slice(0, 8);
  const objectives = provided.length ? provided.map((topic, index) => ({
    id: String(topic.topicId || topic.id || `topic:${index}`), name: topic.name.trim(),
    synonyms: Array.isArray(topic.synonyms) ? topic.synonyms.slice(0, 12) : [],
    sourceKind: String(topic.sourceKind || topic.origin || 'catalog_metadata'),
    confidence: topic.confidence != null && topic.confidence !== '' && Number.isFinite(Number(topic.confidence)) ? Number(topic.confidence) : null,
    evidence: Array.isArray(topic.evidence) ? topic.evidence.slice(0, 4) : []
  })) : fallbackNames.map((name, index) => ({
    id: `metadata:${index}:${name}`, name, synonyms: [], sourceKind: 'lesson_metadata', confidence: null, evidence: []
  }));
  const docs = indexar(bank || []);
  const candidateScores = new Map();
  const searchableObjectives = objectives.map(objective => ({
    objective, phrase: norm(objective.name), nameTerms: topicTerms(objective),
    synonymPhrases: [...new Set(objective.synonyms.map(norm).filter(Boolean))].slice(0, 12)
  }));
  for (const doc of docs) {
    const id = questionId(doc.q);
    if (!id) continue;
    let score = 0;
    for (const item of searchableObjectives) {
      const phraseHit = item.phrase.length >= 4 && hasTerm(doc.all, item.phrase);
      const synonymHit = item.synonymPhrases.some(phrase => hasTerm(doc.all, phrase));
      const nameHitCount = item.nameTerms.filter(term => hasTerm(doc.all, term)).length;
      if (phraseHit || synonymHit || nameHitCount >= Math.min(2, item.nameTerms.length) && nameHitCount > 0) {
        score += (phraseHit || synonymHit ? 2 : 0) + nameHitCount;
      }
    }
    if (score > 0) candidateScores.set(id, { question: doc.q, score });
  }

  const excluded = new Set((Array.isArray(excludedIds) ? excludedIds : []).map(String).slice(0, 500));
  const prioritize = new Set((Array.isArray(prioritizeIds) ? prioritizeIds : []).map(String).slice(0, 500));
  const requiredDifficulty = difficultyLevel(difficulty);
  const seenQuestions = new Set();
  let duplicateCount = 0, missingAnswerCount = 0, excludedAnsweredCount = 0;
  const candidates = [];
  for (const [id, entry] of candidateScores) {
    const question = entry.question;
    if (excludeAnswered && excluded.has(id)) { excludedAnsweredCount++; continue; }
    if (answerIndex(question) < 0) { missingAnswerCount++; continue; }
    if (requiredDifficulty !== 'unknown' && requiredDifficulty !== 'all' && difficultyLevel(question.difficulty) !== requiredDifficulty) continue;
    const statementKey = norm(question.statement || question.q || question.enunciado || '').replace(/\s+/g, ' ').trim();
    const optionsKey = norm((Array.isArray(question.options) ? question.options : Array.isArray(question.opts) ? question.opts : []).join(' '));
    const questionKey = statementKey ? `${statementKey} | ${optionsKey}` : '';
    if (questionKey && seenQuestions.has(questionKey)) { duplicateCount++; continue; }
    if (questionKey) seenQuestions.add(questionKey);

    const statement = norm(question.statement || question.q || question.enunciado || '');
    const options = optionsKey;
    const explanation = norm(question.explanation || '');
    const metadata = norm([question.specialty, question.subspecialty, ...(Array.isArray(question.tags) ? question.tags : [])].join(' '));
    const all = ` ${statement} ${options} ${explanation} ${metadata} `;
    const relations = [];
    for (const objective of objectives) {
      const terms = topicTerms(objective);
      const synonymPhrases = [...new Set(objective.synonyms.map(norm).filter(Boolean))].slice(0, 12);
      const directHits = terms.filter(term => hasTerm(` ${statement} ${options} `, term));
      const allHits = terms.filter(term => hasTerm(all, term));
      const directCoverage = terms.length ? directHits.length / terms.length : 0;
      const anyCoverage = terms.length ? allHits.length / terms.length : 0;
      const phrase = norm(objective.name);
      const exactPhrase = phrase.length >= 7 && (` ${statement} ${options} `).includes(` ${phrase} `);
      const directSynonym = synonymPhrases.some(synonym => hasTerm(` ${statement} ${options} `, synonym));
      const contextualSynonym = synonymPhrases.some(synonym => hasTerm(all, synonym));
      const minimumNameHits = Math.min(2, terms.length);
      const relation = exactPhrase || directSynonym || (minimumNameHits > 0 && directHits.length >= minimumNameHits) ? 'direct'
        : contextualSynonym || (minimumNameHits > 0 && allHits.length >= minimumNameHits) ? 'partial' : 'none';
      if (relation === 'none') continue;
      relations.push({ topicId: objective.id, name: objective.name, relation, directCoverage, anyCoverage,
        evidence: directHits.length || directSynonym ? 'statement_or_options' : allHits.length || contextualSynonym ? 'explanation_or_metadata' : 'phrase',
        lessonEvidence: objective.evidence.slice(0, 4) });
    }
    if (!includeComplementary && !relations.some(relation => relation.relation === 'direct')) continue;
    if (!relations.length) continue;
    const directTopicIds = relations.filter(relation => relation.relation === 'direct').map(relation => relation.topicId);
    const partialTopicIds = relations.filter(relation => relation.relation === 'partial').map(relation => relation.topicId);
    candidates.push({
      question: Object.assign({}, question, {
        _rel: directTopicIds.length ? 'alta' : 'media',
        curriculumMatch: { directTopicIds, partialTopicIds, relations }
      }),
      id, relations, baseScore: entry.score,
      priority: prioritize.has(id),
      difficulty: difficultyLevel(question.difficulty)
    });
  }

  const selected = [], covered = new Set(), difficultyCounts = { easy: 0, medium: 0, hard: 0, unknown: 0 };
  while (selected.length < max && candidates.length) {
    let bestIndex = -1, bestScore = -Infinity;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const direct = candidate.relations.filter(row => row.relation === 'direct');
      const partial = candidate.relations.filter(row => row.relation === 'partial');
      const newDirect = direct.filter(row => !covered.has(row.topicId)).length;
      const newPartial = partial.filter(row => !covered.has(row.topicId)).length;
      const redundant = direct.length + partial.length - newDirect - newPartial;
      const base = Math.tanh(Math.max(0, candidate.baseScore) / 10);
      let score = 0.25 + newDirect * 3 + newPartial * 1.1 - redundant * 0.35 + base * 0.6 + (candidate.priority ? 2 : 0);
      if (mode === 'fixation') score += ({ easy: 0.8, medium: 0.3, hard: 0, unknown: 0 })[candidate.difficulty];
      if (mode === 'proof') score += ({ easy: 0, medium: 0.3, hard: 0.15, unknown: 0 })[candidate.difficulty] - difficultyCounts[candidate.difficulty] * 0.45;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    if (bestIndex < 0 || bestScore <= 0) break;
    const [next] = candidates.splice(bestIndex, 1);
    selected.push(next.question);
    next.relations.filter(row => row.relation === 'direct' || row.relation === 'partial').forEach(row => covered.add(row.topicId));
    difficultyCounts[next.difficulty]++;
  }

  const matrix = objectives.map(objective => {
    const rows = selected.map(question => ({
      questionId: questionId(question),
      relation: question.curriculumMatch?.relations?.find(row => row.topicId === objective.id)?.relation || 'none'
    }));
    const directCount = rows.filter(row => row.relation === 'direct').length;
    const partialCount = rows.filter(row => row.relation === 'partial').length;
    return {
      topicId: objective.id, name: objective.name,
      relation: directCount ? 'direct' : partialCount ? 'partial' : 'uncovered',
      directCount, partialCount, matrix: rows,
      sourceKind: objective.sourceKind, confidence: objective.confidence, evidence: objective.evidence
    };
  });
  const nominalCovered = matrix.filter(row => row.relation !== 'uncovered').length;
  const allMetadata = objectives.every(topic => ['catalog_metadata', 'catalog_title', 'catalog_path', 'lesson_metadata'].includes(topic.sourceKind));
  return {
    questions: selected,
    total: candidates.length + selected.length,
    objectives: matrix,
    coverage: {
      nominal: objectives.length ? nominalCovered / objectives.length : null,
      weighted: null,
      cognitive: null,
      evidenceMode: allMetadata ? 'metadata_lexical_estimate' : 'content_topic_lexical_estimate'
    },
    diagnostics: {
      candidateCount: candidates.length + selected.length, selectedCount: selected.length,
      excludedAnsweredCount, duplicateCount, missingAnswerCount,
      lowConfidenceTopicCount: lowConfidenceTopics.length,
      limitations: [
        'A relação questão–tópico é uma estimativa lexical e não substitui validação curricular humana.',
        'Cobertura ponderada e cognitiva não foram calculadas porque o acervo não possui pesos nem níveis cognitivos validados.',
        ...(lowConfidenceTopics.length ? [`${lowConfidenceTopics.length} tópico(s) com confiança abaixo de 0,45 foram excluídos da cobertura automática.`] : []),
        ...(allMetadata ? ['Os tópicos disponíveis vêm de metadados do catálogo; não há evidência de conteúdo da videoaula indexada.'] : [])
      ]
    }
  };
}

// Acha no catálogo de doenças do Hardworq (~358) as que correspondem à aula, para buscar no banco completo (30 mil+)
function acharDoencas(doencas, tema, modulo) {
  const cobre = (dTok, base) => dTok.every(d => {
    const sd = stemOf(d);
    return base.some(b => { const sb = stemOf(b); return sb === sd || (sd.length >= 5 && sb.length >= 5 && (sb.startsWith(sd) || sd.startsWith(sb))) || sinonimosDe(b).some(x => stemOf(x) === sd); });
  });
  const baseT = tokens(tema), baseM = tokens(modulo);
  const out = [];
  for (const d of doencas || []) {
    const dt = tokens(d.nome);
    if (!dt.length) continue;
    if (cobre(dt, baseT)) out.push({ d, peso: 2 + dt.length });
    else if (!baseT.length && cobre(dt, baseM)) out.push({ d, peso: 1 + dt.length });
  }
  out.sort((a, b) => b.peso - a.peso);
  return out.slice(0, 3).map(x => x.d);
}

export { selecionar, selecionarComCobertura, norm, tokens, acharDoencas };
