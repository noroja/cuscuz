import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../../server.js',import.meta.url),'utf8');
const dom=cheerio.load(html);
// Parse every executable inline script to catch malformed generated markup edits.
dom('script:not([src])').each((_i,el)=>{if(!dom(el).attr('type')||dom(el).attr('type')==='text/javascript')new vm.Script(dom(el).html());});
assert.equal(dom('#ac2-ph')[0].tagName,'button');
assert.equal(dom('#ac2-progt').attr('onclick'),undefined,'Resumo sem ação não promete expansão');
assert.equal(dom('#ac2-vol-slider').attr('aria-label'),'Volume da videoaula');
assert.equal(dom('#ac2-views').length,0,'Não exibir visualizações inventadas');
assert.ok(!html.includes('ac2CalcularLikes')&&!html.includes('ac2CalcularViews'));
assert.equal(dom('script[src="/js/vendor/mpegts.js"]').length,1,'Carregar o transmuxer local para aulas MPEG-TS');
assert.match(html,/info\.container === 'mpegts'/,'Detectar o formato real antes de escolher o player');
assert.match(html,/lazyLoad:\s*false/,'Manter o stream progressivo ativo para arquivos TS estáticos');
assert.match(html,/function ac2MpegtsCanSeek\(/,'Restringir a busca ao trecho já carregado no player MPEG-TS');
assert.match(html,/nv\._ac2Mpegts = true;\s*if \(recovery\) recovery\.hidden = true;/,'Limpar mensagens antigas de erro ao iniciar o player MPEG-TS');
assert.match(server,/const catalogoBootPromise = inicializarCatalogoNuvem\(\)\.then\(\(\) => initSnapshotIndex\(\)\);/,'Manter a promessa de carga do catálogo disponível durante o cold start');
assert.match(server,/app\.get\('\/acervo-manifest\.json',[\s\S]*?await catalogoBootPromise;[\s\S]*?const ex = lerExtra\(\);/,'Esperar o catálogo inicial antes de responder o manifesto do acervo');
const helper=html.slice(html.indexOf('function ac2StatusMensagem('),html.indexOf('/* Atualização por evento do Drive;'));
let calls=0,finish;
const ctx={Intl,ac2Atualizar:()=>{calls++;return new Promise(resolve=>{finish=resolve})}};
vm.createContext(ctx);vm.runInContext(helper,ctx);
for(const state of [null,{chave:false},{chave:true,erroConta:'segredo interno'},{chave:true,erro:'segredo interno'}]){
 const output=ctx.ac2StatusMensagem(state);assert.match(output,/Tentar novamente/);assert.ok(!output.includes('segredo interno'));assert.ok(!output.includes('GOOGLE_'));
}
assert.match(ctx.ac2StatusMensagem({chave:true,running:true}),/Atualizando/);
assert.match(ctx.ac2StatusMensagem({chave:true,videos:1000,materiais:25}),/1\.025 itens/);
assert.match(ctx.ac2StatusMensagem({chave:true,falhas:1,videos:10}),/Parte do acervo/);
const retry={disabled:false,isConnected:true,textContent:''};
const pending=ctx.ac2TentarAtualizar(retry);assert.equal(retry.disabled,true);await ctx.ac2TentarAtualizar(retry);assert.equal(calls,1);finish();await pending;assert.equal(retry.disabled,false);
// Render real generated rows: titles remain escaped and all lesson actions are native.
let rendered='';const target={dataset:{},set innerHTML(value){rendered=value}};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows={document:{querySelector:()=>target},AC2:{NOS:[{nivel:0,filhos:new Map(),aulas:[{id:'lesson-1',titulo:'Tema <especial> & revisão'}],docs:[{id:'pdf-1',titulo:'Material de apoio'}]}],atualId:null},DONE:new Set(),esc,ac2Nat:(a,b)=>a.localeCompare(b)};
const rowCode=html.slice(html.indexOf('function ac2PreencherNo('),html.indexOf('/* Abre (e preenche) todas as pastas'));
vm.createContext(rows);vm.runInContext(rowCode,rows);rows.ac2PreencherNo(0);
const renderedDom=cheerio.load(rendered);assert.equal(renderedDom('button.ac2-aula').length,2);assert.equal(renderedDom('.aula-title').first().text(),'Tema <especial> & revisão');assert.equal(renderedDom('especial').length,0);
const names=['prontas','gemini','flashcards'],elements={};
for(const name of names){elements['tab-btn-'+name]={attrs:{},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=v},focus(){this.focused=true}};elements['treino-tab-'+name]={style:{}};}
const tabs={ $:id=>elements[id],renderBankQuestionsFeed(){},renderFlashcardsTab(){} };
const tabCode=html.slice(html.indexOf('function treinoTabsKeydown('),html.indexOf('// Filtros de Alta Performance'));
vm.createContext(tabs);vm.runInContext(tabCode,tabs);tabs.switchTreinoTab('prontas');
let prevented=false;tabs.treinoTabsKeydown({key:'End',preventDefault(){prevented=true},target:{closest:selector=>selector==='#tab-btn-prontas'?{}:null}});
assert.ok(prevented);assert.equal(elements['tab-btn-flashcards'].attrs['aria-selected'],'true');assert.equal(elements['tab-btn-flashcards'].tabIndex,0);assert.ok(elements['tab-btn-flashcards'].focused);assert.equal(elements['treino-tab-prontas'].hidden,true);
console.log('OK — controles do acervo, conteúdo real, recuperação de erro, escape de títulos e abas por teclado.');
