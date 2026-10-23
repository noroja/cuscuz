// Verificações DETERMINÍSTICAS (sem IA) da fidelidade e da cobertura dos materiais da Aula do dia.
// Não substituem revisão humana: apontam o que conferir (números/doses que não aparecem na fonte, fatos da aula sem cobertura,
// cartões duplicados ou não atômicos). Nota gerada por outra IA seria estimativa; estas contagens são verificáveis e reproduzíveis.

const UNIDADES = 'mg|mcg|µg|ug|g|kg|ml|mL|l|L|mmhg|mmHg|mmol|mEq|meq|ui|UI|u|U|%|bpm|cm|mm|mg\\/dl|mg\\/dL|h|hs|horas?|min|minutos?|dias?|semanas?|meses|mes|mês|anos?|vezes|joules?|j|J';
const RE_NUM_UN = new RegExp('(\\d+(?:[.,]\\d+)?)\\s*(?:-|a|à|–)?\\s*(\\d+(?:[.,]\\d+)?)?\\s*(' + UNIDADES + ')(?![a-zA-ZÀ-ú])', 'gi');
const STOP = new Set('de da do das dos a o as os e em um uma para por com sem que se na no nas nos ao aos ou como mais mas ser foi sao são tem têm pode deve entre sobre quando'.split(' '));

export const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const num = (s) => String(s).replace(',', '.').replace(/\.0+$/, '');
const unid = (u) => { const x = norm(u).replace(/^hs$/, 'h').replace(/^horas?$/, 'h').replace(/^minutos?$/, 'min').replace(/^dias?$/, 'dia').replace(/^semanas?$/, 'sem').replace(/^(meses|mes)$/, 'mes').replace(/^anos?$/, 'ano').replace(/^(ug|µg)$/, 'mcg').replace(/^ui$/, 'ui'); return x; };

// Pares "número+unidade" ("1 mg", "3-5 min" → 3 min e 5 min). Ignora numeração de lista/capítulo (sem unidade).
export function paresNumericos(texto) {
  const out = new Set(); const t = String(texto || '').replace(/[*_`>#|]/g, ' ');
  for (const m of t.matchAll(RE_NUM_UN)) { const u = unid(m[3]); out.add(num(m[1]) + ' ' + u); if (m[2]) out.add(num(m[2]) + ' ' + u); }
  return out;
}

const tokens = (t) => (norm(t).match(/[a-z0-9]{3,}/g) || []).filter(w => !STOP.has(w));

// Números com unidade presentes na SAÍDA e ausentes da FONTE → "conferir" (possível invenção ou erro de transcrição)
export function numerosDuvidosos(fonte, saida) {
  const f = paresNumericos(fonte), res = [];
  for (const p of paresNumericos(saida)) if (!f.has(p)) res.push(p);
  return res;
}

// Cobertura: um fato está coberto se os pares numéricos dele aparecem na saída E ≥ 50% das palavras-chave também.
export function cobertura(fatos, saida) {
  const s = norm(saida), sp = paresNumericos(saida), sTok = new Set(tokens(saida));
  const nao = []; let ok = 0;
  for (const f of fatos || []) {
    const txt = String(f.texto || f); const pn = paresNumericos(txt); const tk = [...new Set(tokens(txt))];
    const numOk = [...pn].every(p => sp.has(p));
    const palOk = tk.length ? tk.filter(w => sTok.has(w)).length / tk.length >= 0.5 : true;
    if (numOk && palOk) ok++; else nao.push({ texto: txt, motivo: !numOk ? 'número/dose ausente' : 'conceito ausente' });
  }
  const total = (fatos || []).length;
  return { total, cobertos: ok, percentual: total ? Math.round(ok / total * 100) : null, naoCobertos: nao };
}

const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };

// Cartões: duplicatas (frente semelhante ou mesmo verso), falta de atomicidade/contexto e números que não estão na fonte.
export function avaliarCartoes(cartoes, fonte) {
  const fonteP = paresNumericos(fonte);
  const itens = (cartoes || []).map((c, i) => {
    const flags = []; const f = String(c.frente || ''), v = String(c.verso || '');
    if (tokens(f).length < 3 && !f.includes('____')) flags.push('frente curta demais: sem contexto');
    if (v.length > 300) flags.push('verso longo: provável mais de um conceito');
    if ((v.match(/;|\n- /g) || []).length >= 4) flags.push('verso com lista longa: dividir em cartões menores');
    for (const p of numerosDuvidosos(fonte, f + ' ' + v)) flags.push('número/dose não encontrado na aula: ' + p);
    return { i, flags };
  });
  const dup = [];
  for (let i = 0; i < cartoes.length; i++) for (let j = i + 1; j < cartoes.length; j++) {
    const a = cartoes[i], b = cartoes[j];
    if (jaccard(tokens(a.frente), tokens(b.frente)) >= 0.7 || (norm(a.verso).trim() && norm(a.verso).trim() === norm(b.verso).trim())) { dup.push([i, j]); itens[j].flags.push('semelhante ao cartão #' + (i + 1)); }
  }
  return { itens, duplicatas: dup, comAlerta: itens.filter(x => x.flags.length).length };
}

// Relatório completo (resumo + cartões). Números duvidosos em resumos são "conferir", não erro comprovado.
export function relatorio({ fonte = '', resumoMd = '', flashcards = [], base = null } = {}) {
  const r = { geradoEm: new Date().toISOString(), aviso: 'Verificação automática sem IA: aponta o que conferir; não prova correção clínica.' };
  if (resumoMd) r.resumo = { numerosParaConferir: numerosDuvidosos(fonte, resumoMd), cobertura: base && Array.isArray(base.fatos) && base.fatos.length ? cobertura(base.fatos, resumoMd) : null };
  if (flashcards && flashcards.length) {
    r.flashcards = avaliarCartoes(flashcards, fonte);
    if (base && Array.isArray(base.fatos) && base.fatos.length) r.flashcards.cobertura = cobertura(base.fatos, flashcards.map(c => c.frente + ' ' + c.verso).join('\n'));
  }
  return r;
}

// Métricas de transcrição contra uma referência humana (para avaliar WER/CER em amostras reais)
const dist = (a, b) => { const n = a.length, m = b.length; let p = Array.from({ length: m + 1 }, (_, j) => j); for (let i = 1; i <= n; i++) { const c = [i]; for (let j = 1; j <= m; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[m]; };
export function wer(ref, hip) { const a = norm(ref).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean), b = norm(hip).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); return a.length ? dist(a, b) / a.length : null; }
export function cer(ref, hip) { const a = [...norm(ref).replace(/\s+/g, ' ').trim()], b = [...norm(hip).replace(/\s+/g, ' ').trim()]; return a.length ? dist(a, b) / a.length : null; }
// Erros "críticos": pares número+unidade da referência ausentes na hipótese (dose/valor perdido ou trocado)
export function errosCriticos(ref, hip) { const h = paresNumericos(hip); return [...paresNumericos(ref)].filter(p => !h.has(p)); }
