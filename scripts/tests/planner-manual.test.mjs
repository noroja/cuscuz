import assert from 'node:assert/strict';
import express from 'express';
import { parseData, parseFaculdade, interpretarResposta } from '../../src/planner-engine.js';
import { registerPlanner } from '../../src/planner-routes.js';

const hoje = '2026-10-21';
assert.equal(parseData('Prova teórica: conteúdo a confirmar', hoje), null);
assert.deepEqual(parseFaculdade('As provas e avaliações seguem as orientações do professor.', hoje), []);
assert.equal(parseData('Prova em 5 de novembro de 2026', hoje), '2026-11-05');
assert.equal(parseData('Prova dia 7 de março de 2027', hoje), '2027-03-07');
assert.equal(parseData('Prova em 05/11/2026', hoje), '2026-11-05');
assert.equal(parseData('Prova em dezembro de 2026', hoje), '2026-12-15');
assert.equal(parseData('Marcos de desenvolvimento', hoje), null);
assert.equal(interpretarResposta('prova', 'novembro', hoje).dataProva, '2026-11-15');

const app = express(); app.use(express.json());
registerPlanner(app, { generateAI: async () => { throw new Error('Não deveria chamar IA'); }, aiConfigured: () => false, getBank: () => null });
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
try {
  const texto = 'Manual do aluno: as provas teóricas e avaliações são realizadas conforme as orientações de cada disciplina. Consulte o professor para confirmar as datas.';
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/planner/manual`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'manual-sem-datas.txt', texto, hoje })
  });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.success, true);
  assert.equal(j.documento.texto, texto);
  assert.equal(j.perfil.provasFaculdade.length, 0);
  assert.match(j.reply, /Não achei provas com data/);
  console.log('OK — manual sem datas não interrompe a leitura; meses por extenso e texto extraído preservados.');
} finally { await new Promise(resolve => server.close(resolve)); }
