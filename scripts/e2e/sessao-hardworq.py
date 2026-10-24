# E2E opcional: um 401 do Hardworq (login externo falhou) não pode deslogar o aluno.
import json, sys, time, datetime, urllib.request, subprocess, os
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _usuario import criar_usuario_local, login_cookie
SP=3987; S=os.path.dirname(os.path.abspath(__file__)); ROOT=os.path.abspath(os.path.join(S,'..','..'))
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
        b=p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        ctx=b.new_context(); ctx.add_cookies([{'name':'cuscuz_session','value':tok,'url':BASE}]); ctx.add_init_script(f"localStorage.setItem('medplan_logged','1');localStorage.setItem('medplan_user','{u}');localStorage.setItem('hasSeenTou','1')")
        ctx.route('**/api/questions/hardworq/sync', lambda r: r.fulfill(status=401, content_type='application/json', body='{"success":false,"authFailed":true}'))
        pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        pg.goto(BASE+'/'); pg.wait_for_timeout(2500)
        pg.evaluate("fetch('/api/questions/hardworq/sync',{method:'POST'})"); pg.wait_for_timeout(1500)
        res.append((ctx.cookies() and any(c['name']=='cuscuz_session' for c in ctx.cookies()), '401 do Hardworq não desloga o aluno', ''))
        res.append((not errs, 'sem erros de JS', str(errs)))
        b.close()
finally:
    srv.terminate(); os.system(f'cd {ROOT} && git checkout -q -- data 2>/dev/null; rm -f data/users.json data/sessions.json')
for ok,n,d in res: print(('OK   — ' if ok else 'FALHOU — ')+n+('' if ok else ' :: '+d))
sys.exit(0 if all(r[0] for r in res) else 1)
