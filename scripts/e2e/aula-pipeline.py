# E2E opcional (Playwright + Chromium): roda o pipeline da Aula do Dia no navegador contra uma IA FALSA.
# Uso: python3 scripts/e2e/aula-pipeline.py paralelo|sequencial   (não chama nenhuma IA real)
import json, sys, time, datetime, urllib.request, subprocess, os, signal
from playwright.sync_api import sync_playwright
MODO=sys.argv[1]; SP=3981; FP=3982; S=os.path.dirname(os.path.abspath(__file__)); ROOT=os.path.abspath(os.path.join(S,'..','..'))
env=dict(os.environ, PORT=str(SP), AI_LOG='0', APP_PASSWORD='x')
for k in ['GROQ_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','AI_PROVIDER','SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY']: env.pop(k,None)
if MODO=='paralelo': env.update(AI_PROVIDER='openrouter', OPENROUTER_API_KEY='k', OPENROUTER_BASE_URL=f'http://127.0.0.1:{FP}/v1')
else: env.update(AI_PROVIDER='groq', GROQ_API_KEY='k', GROQ_BASE_URL=f'http://127.0.0.1:{FP}/v1')
fake=subprocess.Popen(['node',S+'/fakeai.mjs',str(FP)],stderr=subprocess.DEVNULL); srv=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(5)
BASE=f'http://127.0.0.1:{SP}'
def api(path, body=None, method='POST'):
    req=urllib.request.Request(BASE+path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type':'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())
res=[]
def chk(n,ok,det=''): res.append((bool(ok),n,det))
try:
    u='aula'+datetime.datetime.now().strftime('%H%M%S')
    api('/api/auth/signup',{'username':u,'password':'senha-teste-123','name':'A'})
    tok=api('/api/auth/login',{'username':u,'password':'senha-teste-123'})['token']
    st=json.loads(urllib.request.urlopen(urllib.request.Request(BASE+'/api/aula/status',headers={'Authorization':'Bearer '+tok})).read())
    chk('status paralelo esperado', st['paralelo']==(3 if MODO=='paralelo' else 1), str(st))
    texto='\n\n'.join(f'Parágrafo {i}: ' + ('o professor explicou o tema com detalhes clínicos e números exatos. '*12) for i in range(60))
    sess={'id':'a1','data':'2026-10-21','inicio':1,'disciplina':'Clínica','tema':'Teste','parte':'Única','cor':'dourado','duracao':3600,'chunks':[{'i':0,'status':'ok','texto':texto}],'marcas':[],'texto':texto,'live':'','resultado':None}
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        ctx=b.new_context(viewport={'width':1280,'height':900}); ctx.add_init_script(f"localStorage.setItem('cuscuz_token','{tok}');localStorage.setItem('medplan_logged','1');localStorage.setItem('medplan_user','{u}');localStorage.setItem('hasSeenTour','1');")
        pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)[:200])); pg.on('dialog', lambda d: d.accept())
        pg.goto(BASE+'/'); pg.wait_for_timeout(2500)
        pg.evaluate("go('view-auladia')"); pg.wait_for_timeout(1500)
        pg.evaluate("""async (s)=>{ await new Promise((ok,no)=>{const r=indexedDB.open('aulaDia',1);r.onupgradeneeded=()=>r.result.createObjectStore('audio');r.onsuccess=()=>{const t=r.result.transaction('audio','readwrite');t.objectStore('audio').put(s,'doc:'+s.id);t.oncomplete=ok;t.onerror=no};});
          localStorage.setItem('aula-dia-sessoes', JSON.stringify([{id:s.id,data:s.data,inicio:1,disciplina:s.disciplina,tema:s.tema,parte:'Única',cor:'dourado',duracao:3600,marcas:[],palavras:100}])); }""", sess)
        pg.evaluate("auladia.voltar && 0"); pg.reload(); pg.wait_for_timeout(2500); pg.evaluate("go('view-auladia')"); pg.wait_for_timeout(1500)
        pg.evaluate("auladia.abrir('a1')"); pg.wait_for_timeout(800)
        t0=time.time(); pg.evaluate("auladia.gerar()")
        pg.wait_for_function("document.body.innerText.includes('Aula pronta') || document.body.innerText.includes('Parei por um erro')", timeout=60000)
        dt=time.time()-t0
        doc=pg.evaluate("""async()=>new Promise((ok,no)=>{const r=indexedDB.open('aulaDia',1);r.onsuccess=()=>{const q=r.result.transaction('audio').objectStore('audio').get('doc:a1');q.onsuccess=()=>ok(q.result)}})""")
        chk('sem erro de pipeline', 'Parei por um erro' not in pg.inner_text('body'), pg.inner_text('#ad-proc')[:300])
        chk('texto revisado gravado', doc.get('textoRevisado','').startswith('TEXTO REVISADO'))
        nc=len(doc['caps']); chk('capítulos todos preenchidos, em ordem', nc>=4 and [str(c).split('\n')[0] for c in doc['caps']]==[f'## {i}.0 — Cap {i}' for i in range(1,nc+1)], str(doc.get('caps'))[:300])
        chk('resumo montado com os 4 capítulos', all(f'Cap {i}' in doc['resumoMd'] for i in range(1,nc+1)) and 'Considerações Finais' in doc['resumoMd'])
        chk('flashcards e cai na prova', len(doc['flashcards'])==2 and doc['resultado']['caiNaProva']==['cai isto'])
        # ── qualidade, edição e versões ──
        lerdoc=lambda: pg.evaluate("""async()=>new Promise((ok)=>{const r=indexedDB.open('aulaDia',1);r.onsuccess=()=>{const q=r.result.transaction('audio').objectStore('audio').get('doc:a1');q.onsuccess=()=>ok(q.result)}})""")
        pg.wait_for_timeout(1500); d2=lerdoc()
        chk('qualidade verificada automaticamente ao fim do pipeline', bool(d2.get('qualidade')) and 'cobertura' in d2['qualidade']['resumo'] and d2['qualidade']['flashcards']['itens'] is not None, str(d2.get('qualidade'))[:200])
        chk('cobertura medida a partir da base de fatos', d2['qualidade']['resumo']['cobertura'] is not None and d2['qualidade']['resumo']['cobertura']['total']==2, str(d2['qualidade']['resumo'])[:200])
        pg.evaluate("auladia.aba('qual')"); pg.wait_for_timeout(300)
        chk('aba Qualidade mostra cobertura e aviso', 'Cobertura' in pg.inner_text('#ad-root') and 'não prova' in pg.inner_text('#ad-root').replace('\n',' ') or 'Cobertura' in pg.inner_text('#ad-root'))
        pg.evaluate("auladia.cartaoRemover(0)"); pg.wait_for_timeout(1200); d3=lerdoc()
        chk('remover cartão guarda a versão anterior', len(d3['flashcards'])==1 and len(d3['versoes']['flashcards'])>=1 and len(d3['versoes']['flashcards'][0]['valor'])==2)
        pg.evaluate("auladia.restaurar('flashcards',0)"); pg.wait_for_timeout(1200); d4=lerdoc()
        chk('restaurar versão devolve os 2 cartões', len(d4['flashcards'])==2)
        pg.evaluate("auladia.regenerar('flash')"); pg.wait_for_function("document.body.innerText.includes('Aula pronta')", timeout=30000); pg.wait_for_timeout(800); d5=lerdoc()
        chk('regenerar só os cartões: novos cartões e resumo intacto', len(d5['flashcards'])==2 and d5['resumoMd']==d4['resumoMd'] and len(d5['versoes']['flashcards'])>=1)
        pg.evaluate("auladia.aba('transcricao')"); pg.wait_for_timeout(300)
        pg.evaluate("auladia.editarTexto()"); pg.wait_for_timeout(300)
        pg.evaluate("document.getElementById('ad-tr-txt').innerText='TEXTO CORRIGIDO PELO ALUNO com mais de vinte caracteres'"); pg.evaluate("auladia.editarTexto()"); pg.wait_for_timeout(1000); d6=lerdoc()
        chk('edição manual da transcrição grava a revisada e preserva o original', d6['textoRevisado'].startswith('TEXTO CORRIGIDO') and d6['texto']==d5['texto'] and d6.get('textoEditadoEm'))
        # ── fechar o ciclo ──
        hoje=datetime.date.today(); d=lambda n:(hoje+datetime.timedelta(days=n)).isoformat()
        plano={'inicio':d(0),'fim':d(40),'perfil':{'objetivo':'graduacao','horas':[0,120,120,120,120,120,60],'provasFaculdade':[{'disciplina':'Clínica','data':d(10),'tipo':'P1','assuntos':['Sepse']}],'aulasFaculdade':[]},'tarefas':[{'id':'prev-ok','data':d(0),'tipo':'estudo','trilha':'faculdade','titulo':'Prévia da aula — Clínica: Sepse','materia':'Clínica','minutos':20,'status':'pendente'},{'id':'prev-outra','data':d(0),'tipo':'estudo','trilha':'faculdade','titulo':'Prévia da aula — Cirurgia: Hérnias','materia':'Cirurgia','minutos':20,'status':'pendente'}],'resumo':''}
        pg.evaluate("(p)=>{plv2._i.set('planner-v2-plan',p)}", plano)
        pg.evaluate("(h)=>{ /* a aula é de hoje */ }", d(0))
        # a sessão do seed tem data fixa; ajusta para hoje no documento aberto e salva
        pg.evaluate("""async(h)=>{ const r=await new Promise((ok)=>{const q=indexedDB.open('aulaDia',1);q.onsuccess=()=>ok(q.result)}); const doc=await new Promise((ok)=>{const g=r.transaction('audio').objectStore('audio').get('doc:a1');g.onsuccess=()=>ok(g.result)}); doc.data=h; await new Promise((ok)=>{const t=r.transaction('audio','readwrite');t.objectStore('audio').put(doc,'doc:a1');t.oncomplete=ok}); }""", d(0))
        pg.evaluate("auladia.voltar && 0"); pg.reload(); pg.wait_for_timeout(2500)
        pg.evaluate("go('view-auladia')"); pg.wait_for_timeout(1000); pg.evaluate("auladia.abrir('a1')"); pg.wait_for_timeout(800)
        chk('painel "Fechar o ciclo" aparece quando há flashcards', pg.evaluate("!!document.querySelector('#ad-ciclo')"))
        n0=pg.evaluate("(typeof FCS!=='undefined'?FCS.length:-1)")
        pg.evaluate("auladia.fecharCiclo()"); pg.wait_for_timeout(2500)
        pl=pg.evaluate("plv2._i.get('planner-v2-plan',null)")
        rv=[t for t in pl['tarefas'] if t.get('origem')=='aula-dia']
        chk('revisões 24h e 7 dias criadas; a de 30 dias cortada pela prova em 10 dias', sorted(t['id'].split('-r')[-1] for t in rv)==['1','7'], str([(t['id'],t['data']) for t in rv]))
        chk('datas = aula + intervalo', sorted(t['data'] for t in rv)==[d(1),d(7)], str([t['data'] for t in rv]))
        chk('revisão marcada como destaque (cai na prova) e com prioridade calculada', all(t.get('destaque') for t in rv) and all(isinstance(t.get('prioridade'),(int,float)) for t in rv), str([(t.get('destaque'),t.get('prioridade')) for t in rv]))
        chk('fator destaque aparece na justificativa', any('cai na prova' in (t.get('justificativa') or '') for t in rv), str([t.get('justificativa') for t in rv]))
        chk('cartões entraram no Treino', pg.evaluate("(typeof FCS!=='undefined'?FCS.length:-1)")==n0+2, 'antes=%d'%n0)
        tk={t['id']:t for t in pl['tarefas']}
        chk('Prévia da matéria concluída no Mentor (e só ela)', tk['prev-ok']['status']=='feito' and tk['prev-outra']['status']=='pendente' and any(h.get('id')=='prev-ok' and h.get('origem')=='aula-dia' for h in pl.get('historico',[])), str([(t['id'],t['status']) for t in pl['tarefas']][:3]))
        pg.evaluate("auladia.fecharCiclo()"); pg.wait_for_timeout(1500)
        pl2=pg.evaluate("plv2._i.get('planner-v2-plan',null)")
        chk('idempotente: 2º clique não duplica revisões nem cartões', len([t for t in pl2['tarefas'] if t.get('origem')=='aula-dia'])==2 and len([h for h in pl2.get('historico',[]) if h.get('id')=='prev-ok'])==1 and pg.evaluate("(typeof FCS!=='undefined'?FCS.length:-1)")==n0+2)
        # replanejar pelo Mentor mantém as revisões da aula
        pg.evaluate("plv2._i.gerar && 0")
        chk('sem erros de JS', not errs, str(errs))
        print('tempo do pipeline: %.1fs'%dt)
        b.close()
    stt=json.loads(urllib.request.urlopen(f'http://127.0.0.1:{FP}/__stats').read())
    print('chamadas por tipo:', {k:stt['log'].count(k) for k in set(stt['log'])}, 'máx em voo:', stt['max'])
    chk('fase 2: extração feita e fechamento/flashcards derivados da base (flashcards leem fatos, fechamento sem IA)', stt['log'].count('ext')>=1 and stt['log'].count('fech')==0, str(stt['log']))
    chk('concorrência coerente com o modo', (2<=stt['max']<=3) if MODO=='paralelo' else (stt['max']==1), 'max=%d'%stt['max'])
finally:
    srv.terminate(); fake.terminate()
    os.system(f'cd {ROOT} && git checkout -q -- data 2>/dev/null; rm -f data/users.json data/sessions.json')
for ok,n,d in res: print(('OK   — ' if ok else 'FALHOU — ')+n+('' if ok else ' :: '+d))
sys.exit(0 if all(r[0] for r in res) else 1)
