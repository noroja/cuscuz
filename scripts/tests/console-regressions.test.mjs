import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync('index.html','utf8');
const aula=fs.readFileSync('aula-dia.js','utf8');
// Execute the actual renderer, including nested branches, collapse and redraw.
const box={innerHTML:''};
const context=vm.createContext({box,Set});
const start=aula.indexOf('  const mm = {');
const end=aula.indexOf('  function mmAceitar',start);
vm.runInContext(`const sessAtual={mindmap:{t:'Aula',f:[{t:'Tema',f:[{t:'Dose 5 mg'},{t:'Diagnóstico'}]},{t:'Outro'}]}}; const $=()=>box; const E=s=>s; ${aula.slice(start,end)}` ,context);
for(const action of ['desenharMindmap()','mmTudo(true)','mmTudo(false)','mmClique("0")','mmClique("0")']){
 vm.runInContext(action,context);
 assert.doesNotMatch(box.innerHTML,/NaN|undefined/);
 const paths=[...box.innerHTML.matchAll(/<path d="([^"]+)"/g)];
 if(action!=='mmTudo(true)') assert.ok(paths.length>0);
 for(const [,d] of paths) assert.match(d,/^M[\d.]+,[\d.]+ C[\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
}
// All targets used by local/Drive flashcard sessions must exist exactly once.
for(const id of ['quiz-list-screen','quiz-runner-screen','quiz-runner']) assert.equal(html.split(`id="${id}"`).length-1,1,id);
const elements=Object.fromEntries(['quiz-list-screen','quiz-runner-screen','quiz-runner'].map(id=>[id,{style:{},innerHTML:''}]));
let rendered=0;
const fc=vm.createContext({$:id=>elements[id],fcDue:x=>x,buildFCList:()=>[{f:'Pergunta',b:'Resposta'}],shuffle:x=>x,renderFC:()=>rendered++,renderDecks:()=>{},toast:()=>{}});
vm.runInContext('let FCR=null;'+html.slice(html.indexOf('function startFC()'),html.indexOf('window.openDriveFlashcardLibrary')),fc);
vm.runInContext('startFC()',fc);
assert.equal(rendered,1);
Object.assign(fc,{fcState:()=>({iv:0,e:2.5}),fcKey:()=>'',pct:()=>0,esc:s=>s,MOD:()=>null,renderDriveFlashcardHtml:(_html,text)=>text});
vm.runInContext(html.slice(html.indexOf('function renderFC()'),html.indexOf('function gradeFC(')),fc);
vm.runInContext('renderFC()',fc);
assert.ok(elements['quiz-runner'].innerHTML.includes('Pergunta'));
assert.ok(elements['quiz-runner'].innerHTML.includes('Mostrar resposta'));
vm.runInContext('FCR.shown=true;renderFC()',fc);
assert.ok(elements['quiz-runner'].innerHTML.includes('Resposta'));
assert.ok(elements['quiz-runner'].innerHTML.includes('gradeFC(3)'));
assert.equal(elements['quiz-runner-screen'].style.display,'block');assert.equal(elements['quiz-list-screen'].style.display,'none');
vm.runInContext(html.match(/function quitFC\(\)\{[^\n]+/)[0]+';quitFC()',fc);
assert.equal(elements['quiz-runner-screen'].style.display,'none');assert.equal(elements['quiz-list-screen'].style.display,'block');
for(const tag of html.match(/<iframe[^>]+class="apostila-reader-frame"[^>]*>/g)){
 assert.match(tag,/allow-same-origin/);assert.doesNotMatch(tag,/allow-scripts/);
}
assert.doesNotMatch(html,/contentWindow\.eval/);
// Aula do Dia: upload, limites transparentes e preferências estão conectados ao fluxo.
assert.match(aula,/id="ad-audio-file" name="audio" type="file"/);
assert.match(aula,/let audioUploadDireto = false/);
assert.match(aula,/limiteAudioBytes/);
assert.match(aula,/const AUDIO_MAX_BYTES = \(\) => audioUploadDireto \? audioMaxBytes/);
assert.match(aula,/function obterDuracaoAudio\(file\)/);
assert.match(aula,/b\.size > AUDIO_MAX_BYTES\(\)/);
assert.match(aula,/uploadToSignedUrl\(init\.path, init\.token, blob/);
assert.match(aula,/\/api\/aula\/audio\/transcrever/);
assert.match(aula,/Cada arquivo pode ter até 60 minutos/);
assert.match(aula,/await idbPut\(sess\.id \+ ':0', file\)/);
assert.match(aula,/transcreverTrecho\(sess, 0, file\)/);
assert.match(aula,/id="ad-audio-meta" class="file-meta" role="status" aria-live="polite"/);
assert.match(aula,/name="tipoAula" onchange="auladia\.salvarPreferencias\(\)"/);
assert.match(aula,/name="preferenciaMaterial" onchange="auladia\.salvarPreferencias\(\)"/);
assert.match(aula,/name="perfilPedagogico"/);
assert.match(aula,/name="objetivoEstudo"/);
assert.match(aula,/name="objetivosAprendizagem" maxlength="1600"/);
assert.match(aula,/name="enfasePedagogica" maxlength="300"/);
assert.match(aula,/perfilPedagogico: s\.perfilPedagogico \|\| 'automatico'/);
assert.match(aula,/planoPedagogico: s\.planoPedagogico \|\| null/);
assert.match(aula,/mapeado\.planoPedagogico/);
assert.match(aula,/baixaConfianca: Number\.isFinite\(avg\) && avg <= -1 \|\| Number\.isFinite\(semFala\) && semFala >= 0\.6/);
assert.match(aula,/Isso não avalia precisão médica/);
assert.match(aula,/const regenerarCartoes = tipo === 'flash' \|\| tipo === 'flashcards'/);
assert.match(aula,/auladia\.verOrigem\(\$\{i\}\)/);
assert.match(aula,/Aprovar \$\{s\.flashcards\.length\} cartões para o Treino/);
assert.match(aula,/Indicadores automáticos \(heurísticos\)/);
// Parse every inline script to catch syntax errors in the edited search fallback.
for(const [,code] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(code);
console.log('Console regressions: mindmap, flashcards, reader sandbox and inline syntax OK');


const musicConfig=html.slice(html.indexOf("  const playerVars = {",html.indexOf("window.onYouTubeIframeAPIReady")),html.indexOf("  if (cfg.playlistId)",html.indexOf("window.onYouTubeIframeAPIReady")));
assert.equal(vm.runInNewContext(musicConfig+";playerVars.origin",{window:{location:{origin:"https://cuscuz-nu.vercel.app"}}}),"https://cuscuz-nu.vercel.app");
