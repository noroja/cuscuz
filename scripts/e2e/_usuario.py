# Cria um usuário LOCAL de teste em data/users.json (o cadastro público foi desativado). Só para os E2E; use antes de iniciar o servidor.
import hashlib, json, os
def criar_usuario_local(root, username, password='senha-teste-123'):
    d=os.path.join(root,'data'); os.makedirs(d, exist_ok=True); f=os.path.join(d,'users.json')
    try: lista=json.load(open(f,encoding='utf8'))
    except Exception: lista=[]
    salt=os.urandom(16); h=hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)
    lista=[u for u in lista if u.get('username')!=username]+[{'username':username,'displayName':'A','passwordHash':h.hex(),'salt':salt.hex(),'role':'user','settings':{},'isActive':True}]
    json.dump(lista, open(f,'w',encoding='utf8'))

import urllib.request
def login_cookie(base, username, password='senha-teste-123'):
    """Faz login e devolve o valor do cookie HttpOnly de sessão (a sessão não vem mais no corpo da resposta)."""
    req=urllib.request.Request(base+'/api/auth/login', data=json.dumps({'username':username,'password':password}).encode(), headers={'Content-Type':'application/json'}, method='POST')
    r=urllib.request.urlopen(req, timeout=60)
    for k,v in r.getheaders():
        if k.lower()=='set-cookie' and v.startswith('cuscuz_session='): return v.split(';')[0].split('=',1)[1]
    raise RuntimeError('login sem cookie de sessão')
