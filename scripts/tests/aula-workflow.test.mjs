import assert from 'node:assert/strict';
import express from 'express';
import { registerAula } from '../../src/aula.js';
const calls = [];
const replies = {
  aula_revisar: 'Texto revisado de teste.',
  aula_mapa: JSON.stringify({capitulos:[{titulo:'Organização do estudo',pontos:['Organizar horários'],paragrafoFim:0}],temQuestoes:false}),
  aula_capitulo: '## Capítulo de teste\n\nConteúdo da fonte.',
  aula_fechamento: '### Síntese do trecho\n- Organização\n### Memória do trecho\n- Planejar horários',
  aula_flashcards: JSON.stringify([{frente:'Qual a etapa inicial?',verso:'Planejar os horários.',tema:'Organização'}]),
  aula_processar: JSON.stringify({titulo:'Organização',resumo:'Planejamento de horários.',topicos:[],termos:[],caiNaProva:[],duvidas:[],assuntosCobertos:[]}),
  aula_resumo: '# Visão geral\n\nOrganização de horários.',
  aula_mapa_mental: JSON.stringify({t:'Organização',f:[{t:'Horários',f:[{t:'Revisão'}]}]})
};
const app = express(); app.use(express.json());
registerAula(app,{aiConfigured:()=>true,generateAI:async params=>{
  calls.push(params); assert.ok(replies[params.task], 'Tarefa deve ser identificada');
  return {text:replies[params.task],task:params.task,provider:'fake',model:'fake'};
}});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
try {
  const text='Aula fictícia sobre organização do estudo, sem conteúdo clínico. Planeje os horários disponíveis e reserve períodos de revisão. '.repeat(5);
  const routes=[['revisar','aula_revisar'],['mapa','aula_mapa'],['capitulo','aula_capitulo'],['fechamento','aula_fechamento'],['flashcards','aula_flashcards'],['processar','aula_processar'],['resumo-geral','aula_resumo'],['mapa-mental','aula_mapa_mental']];
  for(const [route,task] of routes){
    const before=calls.length;
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/aula/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texto:text,transcricao:text,capitulo:{titulo:'Organização',pontos:['Horários']},capitulos:[]})});
    const j=await r.json();assert.equal(r.status,200,route+': '+j.msg);assert.equal(j.success,true,route);
    assert.ok(calls.length>before,route);assert.ok(calls.slice(before).every(p=>p.task===task),route);
  }
  console.log('OK — revisão, mapa, capítulos, fechamento, flashcards, prova, resumo e mapa mental usam a tarefa correta.');
} finally { await new Promise(resolve=>server.close(resolve)); }
