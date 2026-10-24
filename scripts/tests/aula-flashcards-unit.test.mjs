// Rotas da Aula do Dia chamadas diretamente: valida geração e qualidade sem abrir porta local.
import assert from 'node:assert/strict';
import { registerAula } from '../../src/aula.js';

const rotas = new Map(); const prompts = [];
const app = { get: (p, f) => rotas.set('GET ' + p, f), post: (p, f) => rotas.set('POST ' + p, f) };
const generateAI = async ({ task, contents }) => {
  if (task !== 'aula_flashcards') throw new Error('Tarefa inesperada: ' + task);
  prompts.push(contents);
  return { text: JSON.stringify([
    { frente: 'Qual dose foi citada para adrenalina na PCR?', verso: '1 mg', tema: 'PCR', dificuldade: 'facil', formato: 'comparativo' },
    { frente: 'Por que o mecanismo muda a resposta?', verso: 'Relação causal do trecho.', tema: 'PCR', dificuldade: 'impossivel', formato: 'nao-existe' }
  ]) };
};
registerAula(app, { generateAI, aiConfigured: () => true });

async function chamar(path, body) {
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(j) { this.data = j; return this; } };
  await rotas.get('POST ' + path)({ body }, res);
  return res;
}

const transcricao = 'Aula sobre PCR. O professor citou adrenalina 1 mg e explicou o mecanismo da resposta. '.repeat(3);
const base = { fatos: [{ capitulo: 'PCR', tipo: 'dose', texto: 'Adrenalina 1 mg', origem: null }] };
const gerado = await chamar('/api/aula/flashcards', { transcricao, base, tipoAula: 'caso-clinico', preferenciaMaterial: 'detalhado' });
assert.equal(gerado.statusCode, 200);
assert.equal(gerado.data.flashcards.length, 2);
assert.equal(gerado.data.flashcards[0].formato, 'comparativo');
assert.equal(gerado.data.flashcards[0].dificuldade, 'facil');
assert.equal(gerado.data.flashcards[1].formato, 'pergunta');
assert.equal(gerado.data.flashcards[1].dificuldade, 'media');
assert.ok(prompts[0].includes('MOTOR PEDAGÓGICO UNIVERSAL'));
assert.ok(prompts[0].includes('Não transforme conteúdo básico em decisão clínica'));
assert.ok(prompts[0].includes('estimativa, não uma cota'));
assert.ok(!prompts[0].includes('residência médica'));

const qualidade = await chamar('/api/aula/qualidade', {
  fonte: transcricao, fonteRastreio: transcricao,
  flashcards: gerado.data.flashcards, base
});
assert.equal(qualidade.statusCode, 200);
assert.equal(qualidade.data.relatorio.flashcards.dimensoes.length, 5);
assert.equal(qualidade.data.relatorio.flashcards.revisaoHumana.length, 1);
assert.ok(!qualidade.data.relatorio.flashcards.itens[0].flags.includes('sem referência de origem verificável'));
console.log('Aula flashcards direct-route tests: generation profile, metadata, quality dimensions and source validation OK');
