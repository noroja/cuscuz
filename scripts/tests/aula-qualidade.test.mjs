// Verificações determinísticas da Aula do dia (fidelidade numérica, cobertura, cartões, WER/CER). Sem IA, sem rede.
import assert from 'node:assert/strict';
import { paresNumericos, numerosDuvidosos, cobertura, avaliarCartoes, relatorio, wer, cer, errosCriticos } from '../../src/aula-qualidade.js';
const t = []; const teste = (n, fn) => { try { fn(); t.push(['OK ', n]); } catch (e) { t.push(['FALHOU', n, e.message]); } };
const fonte = 'Na parada, adrenalina 1 mg a cada 3 a 5 minutos. Amiodarona 300 mg na primeira dose e 150 mg na segunda. Comprimir 100 a 120 por minuto, profundidade de 5 cm.';

teste('pares número+unidade: faixas, decimais, vírgula e plural', () => {
  const p = paresNumericos('1 mg a cada 3-5 min; 2,5 % e 3 a 5 minutos; 5 cm; Ato 1 e capítulo 2.0');
  for (const x of ['1 mg', '3 min', '5 min', '2.5 %', '5 cm']) assert.ok(p.has(x), x);
  assert.ok(![...p].some(x => x.startsWith('2 ')), 'numeração sem unidade não conta');
});
teste('número duvidoso: dose que NÃO está na fonte é apontada; as que estão não', () => {
  assert.deepEqual(numerosDuvidosos(fonte, 'Dar adrenalina 1 mg e amiodarona 300 mg.'), []);
  assert.deepEqual(numerosDuvidosos(fonte, 'Dar adrenalina 10 mg e amiodarona 300 mg.'), ['10 mg']);
});
teste('cobertura: fato com dose ausente ou conceito ausente vira não coberto (dose ausente → motivo específico)', () => {
  const fatos = [{ texto: 'Adrenalina 1 mg a cada 3-5 min' }, { texto: 'Amiodarona 300 mg na primeira dose' }, { texto: 'Compressões 100-120 por minuto' }];
  const r = cobertura(fatos, 'Adrenalina 1 mg a cada 3 a 5 minutos. Compressões de qualidade.');
  assert.equal(r.total, 3); assert.equal(r.cobertos, 1); assert.equal(r.percentual, 33);
  assert.ok(r.naoCobertos.some(x => /Amiodarona/.test(x.texto) && x.motivo === 'número/dose ausente'));
});
teste('cartões: duplicata, verso longo, frente sem contexto e dose inventada', () => {
  const r = avaliarCartoes([
    { frente: 'Qual a dose de adrenalina na PCR?', verso: '1 mg a cada 3-5 min' },
    { frente: 'Qual é a dose de adrenalina na PCR', verso: '1 mg a cada 3 a 5 minutos' },
    { frente: 'Dose?', verso: '1 mg' },
    { frente: 'Qual a dose de amiodarona na segunda dose?', verso: '500 mg' },
    { frente: 'Explique a RCP', verso: 'x'.repeat(320) }
  ], fonte);
  assert.deepEqual(r.duplicatas, [[0, 1]]);
  assert.ok(r.itens[1].flags.some(f => f.includes('semelhante')));
  assert.ok(r.itens[2].flags.some(f => f.includes('frente curta')));
  assert.ok(r.itens[3].flags.some(f => f.includes('500 mg')));
  assert.ok(r.itens[4].flags.some(f => f.includes('verso longo')));
  assert.equal(r.itens[0].flags.length, 0);
});
teste('relatório junta resumo e cartões e avisa que não prova correção clínica', () => {
  const r = relatorio({ fonte, resumoMd: 'Adrenalina 1 mg. Amiodarona 600 mg.', flashcards: [{ frente: 'Qual a dose de adrenalina na PCR?', verso: '1 mg' }], base: { fatos: [{ texto: 'Adrenalina 1 mg a cada 3-5 min' }] } });
  assert.deepEqual(r.resumo.numerosParaConferir, ['600 mg']); assert.ok(r.aviso.includes('não prova')); assert.equal(r.flashcards.comAlerta, 0);
});
teste('WER/CER/erros críticos contra referência humana', () => {
  assert.equal(wer('o paciente tem sepse grave', 'o paciente tem sepse grave'), 0);
  assert.equal(wer('o paciente tem sepse grave', 'o paciente tem sepsis grave'), 0.2);
  assert.ok(Math.abs(cer('abc', 'abd') - 1 / 3) < 1e-9);
  assert.deepEqual(errosCriticos('dar 1 mg de adrenalina e 300 mg de amiodarona', 'dar 1 mg de adrenalina e 30 mg de amiodarona'), ['300 mg']);
});
for (const l of t) console.log(l.join(' — '));
process.exit(t.every(l => l[0] === 'OK ') ? 0 : 1);
