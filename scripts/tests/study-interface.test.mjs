import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const css=fs.readFileSync(new URL('../../css/cuscuz-study.css',import.meta.url),'utf8');
const dark=css.match(/html\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1];
const colors=Object.fromEntries([...dark.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map(m=>[m[1],m[2]]));
function luminance(hex){const c=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];}
function contrast(a,b){const [l,h]=[luminance(a),luminance(b)].sort((a,b)=>a-b);return (h+.05)/(l+.05);}
for(const bg of ['--bg-void','--bg-surface','--bg-elevated','--bg-overlay'])for(const ink of ['--text-primary','--text-secondary','--text-muted'])assert.ok(contrast(colors[bg],colors[ink])>=4.5,`${ink} sobre ${bg}`);
assert.ok(contrast(colors['--teal'],colors['--text-inverse'])>=4.5,'Texto da ação principal');
assert.ok(contrast(colors['--teal'],colors['--bg-elevated'])>=3,'Foco sobre painel');
const source=fs.readFileSync(new URL('../../js/study-interface.js',import.meta.url),'utf8');
let hash='',current='view-planneria',focused=false,calls=[];
const main={scrollTop:180,focus:()=>{focused=true}},app={dataset:{get view(){return current}}};
const listeners={};
const document={getElementById:id=>id==='main-content'?main:id==='app-main'?app:['view-planneria','view-acervo'].includes(id)?{classList:{contains:()=>true}}:null};
const context={document,Map,location:{get hash(){return hash}},history:{pushState:(_s,_t,h)=>{hash=h;calls.push(h)},replaceState:(_s,_t,h)=>{hash=h}},window:{addEventListener:(name,handler)=>{listeners[name]=handler},go:(id,opts)=>{current=id;context.window.cuscuzRouteDidChange(id,opts)}}};
vm.createContext(context);vm.runInContext(source,context);
const w=context.window;
w.cuscuzBeforeNavigate();w.cuscuzRouteDidChange('view-acervo',{});assert.equal(hash,'#view-acervo');
assert.equal(w.navigateStudy({ctrlKey:true},'view-acervo'),true,'Ctrl-click mantém navegação nativa');
let prevented=false;assert.equal(w.navigateStudy({preventDefault:()=>{prevented=true}},'view-acervo'),false);assert.ok(prevented&&focused);
hash='#view-planneria';listeners.popstate();assert.equal(current,'view-planneria');assert.equal(main.scrollTop,180,'Voltar recupera posição anterior');
const count=calls.length;listeners.hashchange();assert.equal(calls.length,count,'Evento duplicado não adiciona histórico');
console.log('OK — contraste da paleta escura, navegação com URL, Ctrl-click, foco e restauração da rolagem.');
// A response arriving must not erase the next message being drafted.
const planner=fs.readFileSync(new URL('../../planner-v2.js',import.meta.url),'utf8');
const render=planner.slice(planner.indexOf('  function renderChat()'),planner.indexOf('  async function turno('));
const oldComposer={value:'Minha rotina\nsegunda-feira',selectionStart:5,selectionEnd:11};
let replaced=false,restoredFocus=false,restoredSelection=null,markup='';
const newComposer={value:'',focus:()=>{restoredFocus=true},setSelectionRange:(a,b)=>{restoredSelection=[a,b]}};
const root={querySelectorAll:()=>[]};
Object.defineProperty(root,'innerHTML',{set:value=>{markup=value;replaced=true}});
const composerCtx={root:()=>root,chatState:()=>({msgs:[],resumo:[],quick:[],pronto:false}),get:()=>null,K_PLAN:'plan',window:{},renderOverview:()=>'',E:s=>String(s??''),busy:true,document:{activeElement:oldComposer,getElementById:id=>id==='plv2-txt'?(replaced?newComposer:oldComposer):null}};
vm.createContext(composerCtx);vm.runInContext(render,composerCtx);composerCtx.renderChat();
assert.equal(newComposer.value,oldComposer.value);assert.ok(restoredFocus);assert.deepEqual(restoredSelection,[5,11]);
assert.match(markup,/aria-busy="true"/);assert.match(markup,/id="plv2-send" disabled/);assert.match(markup,/Enviando…/);
console.log('OK — o Mentor preserva rascunho, foco e seleção durante atualização e sinaliza envio em andamento.');
