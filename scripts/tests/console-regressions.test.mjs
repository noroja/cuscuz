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
// Parse every inline script to catch syntax errors in the edited search fallback.
for(const [,code] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(code);
console.log('Console regressions: mindmap, flashcards, reader sandbox and inline syntax OK');


const musicConfig=html.slice(html.indexOf("  const playerVars = {",html.indexOf("window.onYouTubeIframeAPIReady")),html.indexOf("  if (cfg.playlistId)",html.indexOf("window.onYouTubeIframeAPIReady")));
assert.equal(vm.runInNewContext(musicConfig+";playerVars.origin",{window:{location:{origin:"https://cuscuz-nu.vercel.app"}}}),"https://cuscuz-nu.vercel.app");
