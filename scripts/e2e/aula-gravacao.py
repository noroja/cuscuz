# E2E opcional: grava ~80 s com microfone FALSO do Chromium e confere que o corte acontece entre 65 s e 90 s (corte na pausa de fala).
# Uso: python3 scripts/e2e/aula-gravacao.py   (nenhuma IA real; sem chaves, a transcrição fica pendente)
import json, sys, time, datetime, urllib.request, subprocess, os
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _usuario import criar_usuario_local, login_cookie
SP=3985; S=os.path.dirname(os.path.abspath(__file__)); ROOT=os.path.abspath(os.path.join(S,'..','..'))
env=dict(os.environ, PORT=str(SP), AI_LOG='0', APP_PASSWORD='x')
for k in ['GROQ_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','AI_PROVIDER','SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY']: env.pop(k,None)
USR='e2e'+str(os.getpid()); criar_usuario_local(ROOT, USR)
srv=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(5)
BASE=f'http://127.0.0.1:{SP}'
def api(path, body):
    return json.loads(urllib.request.urlopen(urllib.request.Request(BASE+path, data=json.dumps(body).encode(), method='POST', headers={'Content-Type':'application/json'}), timeout=60).read())
res=[]
try:
    u=USR
    tok=login_cookie(BASE,u)
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
        ctx=b.new_context(permissions=['microphone']); ctx.add_cookies([{'name':'cuscuz_session','value':tok,'url':BASE}]); ctx.add_init_script(f"localStorage.setItem('medplan_logged','1');localStorage.setItem('medplan_user','{u}');localStorage.setItem('hasSeenTou','1')")
        ctx.route('**/api/questions/hardworq/sync', lambda r: r.fulfill(status=200, content_type='application/json', body='{"success":true}'))  # sync em segundo plano do app (não é o assunto do teste)
        pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)[:200])); pg.on('dialog', lambda d: d.accept())
        pg.goto(BASE+'/'); pg.wait_for_timeout(2500); pg.evaluate("go('view-auladia')"); pg.wait_for_timeout(1500)
        pg.evaluate("auladia.iniciar()"); pg.wait_for_timeout(1500); 
        t0=time.time()
        pg.wait_for_function("(()=>{const l=JSON.parse(localStorage.getItem('aula-dia-sessoes')||'[]');return false})()||document.querySelector('#ad-timer')!==null", timeout=15000)
        # espera o primeiro trecho ser fechado (sess.chunks recebe o item no onstop)
        pg.wait_for_function("(()=>{try{return window.auladia._chunksProntos()>=1}catch(e){return false}})()", timeout=130000)
        dt=time.time()-t0
        print('primeiro trecho fechado após %.1fs'%dt)
        res.append((60<=dt<=92, 'trecho fechado entre ~65 s e 90 s (não antes, não depois)', '%.1f'%dt))
        res.append((not errs, 'sem erros de JS', str(errs)))
        print('unit:', pg.evaluate("[auladia._deveCortar(64000,1),auladia._deveCortar(66000,0.2),auladia._deveCortar(66000,0.6),auladia._deveCortar(30000,5)]"))
        res.append((pg.evaluate("auladia._deveCortar(64000,1)===false && auladia._deveCortar(66000,0.2)===false && auladia._deveCortar(66000,0.6)===true && auladia._deveCortar(30000,5)===false"),'deveCortar: só após 65 s e com pausa ≥ 0,5 s',''))
        b.close()
finally:
    srv.terminate()
    os.system(f'cd {ROOT} && git checkout -q -- data 2>/dev/null; rm -f data/users.json data/sessions.json')
for ok,n,d in res: print(('OK   — ' if ok else 'FALHOU — ')+n+('' if ok else ' :: '+d))
sys.exit(0 if all(r[0] for r in res) else 1)
