import assert from 'node:assert/strict';
import {
  construirPlanoPedagogico,
  contextoPedagogico,
  inferirPerfisPedagogicos,
  listaPerfisPedagogicos,
  normalizarPlanoPedagogico
} from '../../src/aula-pedagogia.js';

const perfis = listaPerfisPedagogicos();
assert.ok(perfis.length >= 10, 'o motor deve oferecer perfis combináveis para as disciplinas mais comuns');
assert.ok(perfis.some(p => p.id === 'fisiopatologia'));

const inferidos = inferirPerfisPedagogicos({
  area: 'Clínica Médica',
  conteudo: 'Fisiopatologia cardiovascular e farmacologia de vasopressores',
  capitulos: [{ titulo: 'Mecanismos cardiovasculares', pontos: ['dose-resposta dos vasopressores'] }]
});
assert.ok(inferidos.includes('fisiopatologia'));
assert.ok(inferidos.includes('farmacologia'));
assert.ok(inferidos.includes('clinica-medica'));

const planoAutomatico = construirPlanoPedagogico({
  area: 'Farmacologia',
  conteudo: 'Farmacocinética e anticoagulantes',
  perfisSugeridos: ['farmacologia', 'fisiopatologia'],
  objetivosSugeridos: ['Relacionar dose e resposta.'],
  tipoAula: 'revisao-prova',
  preferenciaMaterial: 'conciso',
  capitulos: [{ titulo: 'Anticoagulantes', pontos: ['mecanismo de ação'], de: 20, ate: 85 }]
});
assert.equal(planoAutomatico.perfilPrincipal, 'farmacologia');
assert.deepEqual(planoAutomatico.perfisSecundarios, ['fisiopatologia']);
assert.equal(planoAutomatico.origemPerfilPrincipal, 'sugestao_e_contexto');
assert.equal(planoAutomatico.tipoAula, 'revisao-prova');
assert.equal(planoAutomatico.objetivoEstudo, 'prova');
assert.equal(planoAutomatico.profundidade, 'essencial');
assert.equal(planoAutomatico.origemObjetivos, 'sugestao_ia');
assert.deepEqual(planoAutomatico.referenciasFonte, [{ tipo: 'transcricao', inicio: 20, fim: 85, rotulo: 'Anticoagulantes' }]);
assert.equal(planoAutomatico.requisitosCobertura[0].requisito, 'mecanismo de ação');
assert.equal(construirPlanoPedagogico({ conteudo: 'Revisão para prova de farmacocinética', tipoAula: 'expositiva' }).objetivoEstudo, 'prova', 'o objetivo automático também deve considerar o tema da aula');

const planoManual = construirPlanoPedagogico({
  area: 'Farmacologia',
  conteudo: 'Farmacocinética',
  perfilPedagogico: 'fisiologia',
  objetivoEstudo: 'aprofundar',
  objetivosAprendizagem: 'Explicar absorção e distribuição.\nRelacionar farmacocinética e resposta.',
  enfasePedagogica: 'comparar compartimentos',
  preferenciaMaterial: 'detalhado',
  capitulos: [{ titulo: 'Distribuição', origem: { inicio: 100, fim: 150 }, pontos: ['volume de distribuição'] }]
});
assert.equal(planoManual.perfilPrincipal, 'fisiologia', 'perfil manual deve substituir o perfil principal inferido');
assert.ok(planoManual.perfisSecundarios.includes('farmacologia'), 'perfil manual deve manter perfis automáticos como complementares');
assert.equal(planoManual.origemPerfilPrincipal, 'manual');
assert.equal(planoManual.profundidade, 'avancado');
assert.deepEqual(planoManual.objetivos, ['Explicar absorção e distribuição.', 'Relacionar farmacocinética e resposta.']);
assert.equal(planoManual.origemObjetivos, 'estudante');
assert.deepEqual(planoManual.referenciasFonte, [{ tipo: 'transcricao', inicio: 100, fim: 150, rotulo: 'Distribuição' }]);

const prompt = contextoPedagogico(planoManual);
assert.ok(prompt.includes('MOTOR PEDAGÓGICO UNIVERSAL'));
assert.ok(prompt.includes('PERFIL PRINCIPAL: Fisiologia.'));
assert.ok(prompt.includes('PERFIS COMPLEMENTARES:'));
assert.ok(prompt.includes('ROTEIRO COMPARTILHADO DE COBERTURA'));
assert.ok(prompt.includes('PROFUNDIDADE: Avançada'));
assert.ok(prompt.includes('informados pelo estudante'));
assert.ok(prompt.includes('comparar compartimentos'));
assert.ok(!prompt.includes('Aplicação clínica'), 'o núcleo não deve impor uma seção clínica a toda disciplina');
assert.ok(contextoPedagogico(planoManual, { capituloAtual: 'Distribuição' }).includes('BLOCO ATUAL DO PLANO'));

const reidratado = normalizarPlanoPedagogico(planoManual);
assert.deepEqual(reidratado.referenciasFonte, planoManual.referenciasFonte, 'rehidratação deve preservar offsets da fonte');
assert.equal(reidratado.perfilPrincipal, 'fisiologia');
assert.equal(normalizarPlanoPedagogico(planoManual, { perfilPedagogico: 'automatico' }).perfilPrincipal, 'fisiologia', 'o valor automático não deve apagar uma escolha manual já registrada na sessão');
assert.ok(contextoPedagogico(planoManual, { aplicarTamanho: false, modoFidelidade: true }).includes('MODO DE FIDELIDADE'));

console.log('OK — inferência e combinação de perfis, personalização por aula, objetivos, profundidade e referências rastreáveis.');
