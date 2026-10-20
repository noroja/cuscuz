# Cuscuz-MED — Melhorias e Fluidez
### Diagnóstico a partir do relatório de arquitetura + medições em produção (19/10/2026)

---

## 0. Resumo executivo

1. **Crítico:** o Supabase está com RLS habilitado, mas com policies `using (true)`. A chave anônima é pública em `/api/config`. Resultado: **qualquer pessoa lê `users` (hash/salt) e `sessions` (tokens)** — risco de takeover. Corrigir hoje.
2. **Toda visita passa pela função:** `index.html`, CSS, JS e imagens são servidos por `express.static(__dirname)` com `Cache-Control: max-age=0` e `X-Vercel-Cache: MISS`. Não há cache de borda; cada asset é uma invocação.
3. **Boot pesado no navegador:** `hydrateHeavyState()` carrega **todas** as chaves pesadas do IndexedDB (acervo de 10 MB, questões, chat) antes de liberar a UI.
4. **Catálogo grande e sem versão:** 10,5 MB crus / 1,9 MB gzip por carga completa. Existe ETag, mas não existe endpoint de versão para o cliente pular o download.
5. **Autenticação O(N):** cada instância nova executa `select *` em `users` **e** em `sessions`. Com o tempo, o cold start cresce junto com a base.
6. **Função em `iad1`:** o edge é `gru1` (São Paulo), mas a função roda em Washington. Para usuários no Brasil, cada round trip custa mais.
7. **Gemini:** cota gratuita de 20/dia por modelo, um único modelo na cascata, e o Radar ignora o circuit breaker global.

---

## 1. Evidências medidas

| Medição | Resultado | Leitura |
|---|---|---|
| `GET /` | `200`, gzip, `Cache-Control: no-cache`, `X-Vercel-Cache: MISS` | HTML sempre renderizado pela função |
| `GET /css/medreader.css` | `200`, `public, max-age=0`, `MISS`, `charset=UTF-8` | servido pelo Express, não pelo CDN |
| `GET /js/vendor/localforage.min.js` | idem | idem |
| `X-Vercel-Id` | `gru1::iad1::...` | edge em São Paulo, função em Washington |
| `GET /api/questions/bank` (auth) | `200`, gzip, `BYPASS` | gzip ok; cache de borda não se aplica a auth |
| `GET /acervo-manifest.json` | 10,5 MB crus / 1,9 MB gzip / ~1 s | pesado, mas comprimido |
| Supabase REST com anon key | `users` → `200 [{"username":"noronha"}]`; `sessions` → `200` | **RLS aberto** |
| `supabase-schema.sql` | `using (true) with check (true)` em 4 tabelas | policies permissivas |
| `loadUsersDb()` | `select('*')` em `users` e `sessions` | cold start O(N) |
| `index.html` | 677 KB / 11.272 linhas, CSS e JS inline | sem cache separado, sem code splitting |
| `hydrateHeavyState()` | itera todas as `HEAVY_KEYS` no boot | parse de dezenas de MB |

---

## 2. P0 — Segurança e correção (fazer hoje)

### 2.1 Fechar o RLS do Supabase (crítico)

**Problema:** as policies `Permitir acesso total` deixam o role `anon` ler e escrever tudo. Como a anon key é entregue ao navegador em `/api/config`, o banco inteiro está exposto. As tabelas afetadas: `users`, `sessions`, `conversations`, `medreader_marcas`.

**Correção mínima** (o servidor usa `SUPABASE_SERVICE_ROLE_KEY`, que ignora RLS):

```sql
drop policy if exists "Permitir acesso total a users" on public.users;
drop policy if exists "Permitir acesso total a sessions" on public.sessions;
drop policy if exists "Permitir acesso total a conversations" on public.conversations;
drop policy if exists "Permitir acesso total a medreader_marcas" on public.medreader_marcas;

-- RLS continua habilitado; sem policy, só service_role acessa.
```

**Antes de rodar:** confirmar que `SUPABASE_SERVICE_ROLE_KEY` está configurada na Vercel. Se o servidor estiver usando só a anon key, ele para de funcionar — nesse caso, configure a service role primeiro.

**Depois de fechar:**
- `delete from public.sessions;` → invalida todos os tokens expostos; todos refazem login.
- Considere forçar redefinição de senha: `password_hash` + `salt` estavam legíveis; scrypt com `N=16384` encarece o ataque, mas não o impede.
- Se o navegador precisar de alguma tabela no futuro, crie policies por `auth.uid()` e **nunca** exponha `password_hash`/`salt`.

**Verificação:** repetir a consulta com a anon key e esperar `401`/`[]`.

### 2.2 Fechar `/api/drive/*`

Hoje `/api/drive/*` está na whitelist do `authMiddleware`. Qualquer pessoa lista a árvore do Drive e baixa arquivos por ID. A proteção por ticket cobre só `/m/:ticket`.

- Remover `/api/drive/` da whitelist.
- Manter público apenas `/m/:ticket` (link assinado, curto).
- No front, o download em `index.html:6091` não envia token → adicionar `Authorization: Bearer`.
- Trocar URLs `?t=<token>` (`cuscuzMediaUrl` e `index.html:3947`) por tickets `/m/`; token de sessão não deve aparecer em URL, histórico ou log.
- Reduzir a validade do ticket de 12 h para 1–2 h.
- Rate-limit por usuário/IP em `/api/drive/*` e nas rotas de IA.

### 2.3 Segredo padrão dos tickets

`AUTH_SECRET` deriva de `APP_PASSWORD || 'default-secret-change-me'`. Se a variável faltar em produção, qualquer pessoa forja tickets. Falhar o boot em produção quando `APP_PASSWORD` estiver ausente (ou gerar segredo forte e persistido).

### 2.4 Limite de corpo global

`express.json({ limit: '50mb' })` vale para toda rota. Reduzir para 2–5 MB e elevar apenas em `/api/anki/importar` e importações de questões.

---

## 3. P1 — Fluidez percebida (maior ganho por esforço)

### 3.1 Cache de borda para HTML, CSS, JS e imagens

**Hoje:** `max-age=0` + `MISS` em tudo. **Meta:** `HIT` no CDN.

No `express.static`, definir por tipo:

```js
setHeaders: (res, filePath) => {
  if (/\.(css|js|png|jpg|jpeg|svg|webp|woff2?)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  } else if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
  }
}
```

- `s-maxage` deixa a **Vercel** cachear a resposta da função; `stale-while-revalidate` serve rápido enquanto revalida.
- Para o `index.html`, 60 s de defasagem após deploy é aceitável; se não for, mantenha `no-cache` só nele.
- Validar com `curl -I` procurando `X-Vercel-Cache: HIT`.
- Ganho esperado: ~15 invocações de função a menos por visita e TTFB de borda (dezenas de ms em vez de centenas).

> **Estrutural (depois):** servir os estáticos direto de `public/` pelo CDN. Hoje o catch-all do `server.js` manda tudo para a função; mudar isso exige repensar o roteamento de `/acervo-manifest.json` e `/m/*`. O cache acima resolve 80% sem esse risco.

### 3.2 Região da função

`"regions": ["gru1"]` no `vercel.json` (se o plano permitir). O edge já é `gru1`; a função em `iad1` adiciona latência em cada chamada de API. **Medir antes/depois** com TTFB do Brasil; se o Supabase estiver em `us-east`, comparar o ganho de usuário vs. latência de banco.

### 3.3 Hidratação sob demanda do IndexedDB

**Hoje:** `hydrateHeavyState()` no boot lê todas as chaves (acervo, questões, simulados, chat). Em mobile, isso pode custar segundos e muita memória.

- Hidratar por tela: `Acervo` → `cuscuz_med_acervo_cache`; `Treino` → questões; `Simulados` → respostas; `Planejar` → `planner-v2-*`.
- Expor `heavyGet(key)` assíncrono e manter um cache em memória por chave.
- Limitar `planner-v2-chat` (ex.: últimas 200 mensagens) e adicionar “limpar histórico”.
- Mostrar uso com `navigator.storage.estimate()` e um botão “limpar cache”.

Ganho: boot sem parse de dezenas de MB; primeira interação mais rápida.

### 3.4 Versão do catálogo + carga progressiva

**Hoje:** o cliente baixa 1,9 MB (gzip) para descobrir que nada mudou.

- `GET /api/acervo/version` → `{ generatedAt, videos, materials, etag }` (poucos bytes).
- O cliente compara com o que está no IndexedDB; só baixa o manifesto se mudou.
- `Cache-Control` do manifesto: `private, max-age=300, stale-while-revalidate=3600` (hoje é `no-cache`).
- **Divisão por curso:** `/acervo/<curso>.json` + um índice enxuto. O aluno abre “Clínica Médica” e baixa só aquilo.
- Virtualizar listas de 19k materiais e buscar no servidor (debounce) em vez de filtrar tudo no cliente.

Ganho: visitas sem mudança → 0 download; primeira visita → payload proporcional ao curso.

### 3.5 Questões: primeira página, não o banco inteiro

`/api/questions/bank` devolve tudo (953 hoje; pode virar 30 mil com Hardworq).

- `?limit=500&offset=0` por padrão; carregar mais sob demanda.
- Manter `/sync` incremental por cursor (já existe) e versionar o cache no IndexedDB.
- Endpoint de busca (`?q=&disciplina=`) no servidor.
- `Cache-Control: private, max-age=60` e ETag.

### 3.6 Carregamento do frontend

- **Adiar CDNs não críticos:** `pdf.js` só ao abrir PDF; YouTube IFrame API só no Lobby com áudio; Firebase só se o sync estiver ligado.
- **Vendorizar o Supabase UMD** (como já foi feito com localforage). Hoje o login depende de CDN + polling de até 8 s (`esperarLibSupabase`).
- **Extrair o CSS inline** para `css/app.css` (cache separado) e minificar; depois, extrair JS por feature.
- **Skeletons e progresso:** barra para o manifesto, skeleton nas listas, `aria-busy`.
- **Login:** labels visíveis, `autocomplete="username"`/`current-password`, botão mostrar senha, erro inline.
- **Offline:** banner + retry; fila de ações (ex.: respostas de simulado) para sincronizar depois.

### 3.7 Cold start da autenticação

`loadUsersDb()` faz `select('*')` em `users` e `sessions` a cada instância. Trocar por:

- `validateSession(token)`: `select * from sessions where token = ? maybeSingle()` + cache em memória por 5 min.
- `login/signup`: `select * from users where username = ? maybeSingle()` (índice já existe).
- Cron diário: `delete from sessions where expires_at < now()`.

Ganho: cold start constante, independente do número de sessões.

---

## 4. P2 — IA e confiabilidade

### 4.1 SSE com streaming real

Hoje o SSE mantém a conexão viva, mas o aluno só vê a resposta no `event: result`. Usar `generateContentStream` e emitir `event: delta` reduz a latência percebida de ~5–10 s para <1 s.

- `event: status` para etapas (“analisando perfil”, “montando cronograma”).
- `event: error` no `catch` + `res.end()`; hoje, erro depois de `flushHeaders` pode deixar a conexão pendurada.
- Cliente: tratar `error`, timeout e reconexão.

### 4.2 Cota do Gemini

- Cascata de modelos (cada um tem cota própria): `gemini-3.8-flash` → `gemini-2.5-flash` → `gemini-2.0-flash`.
- Radar: usar `generateWithGemini` (ou checar `geminiQuotaBlockedUntil`) para respeitar o breaker.
- Rate-limit por usuário (ex.: 20 mensagens/dia) com mensagem e horário de reset.
- Cache de prompts idênticos por 24 h (hash → resposta).
- Expor `blockedUntil` em `/api/aula/status` e mostrar “IA em modo regras” na UI.

### 4.3 Persistência de trabalhos

`/tmp` desaparece: decks, merges de questões, token HWQ, cache do Radar. Mover o que importa:

- decks → Supabase Storage (`decks/<materia>/<tema>.json`);
- banco de questões mesclado → Supabase Storage ou só GitHub Action;
- Radar → cache em Supabase (tabela `cache`) ou aceitar re-scrape.

### 4.4 Cron em vez de timers

`setInterval` não roda na Vercel. Criar rotas protegidas por `CRON_SECRET` + `vercel.json` `crons`:

- aquecer/atualizar catálogo;
- limpar sessões expiradas;
- sincronizar questões;
- aquecer o Radar.

Remover `keepalive.yml` (aponta para o Railway) ou redirecioná-lo.

### 4.5 Observabilidade

- `GET /api/version` → commit SHA, data do build, região.
- `/api/health` → fonte do catálogo, contagens, questões, `geminiBlockedUntil`, latência do Supabase.
- Log com `request-id`, método, rota, status e duração; alerta em 5xx.
- Script de smoke test (`scripts/smoke.mjs`) rodando no CI com um token de teste.

---

## 5. P3 — Manutenção

- Remover arquivos mortos: `fix_*.py`, `test_*.py`, `check_render.py`, `apply_medreader*.py`, `render.yaml`.
- `build-public.js` lista `home.html` e `app-cuscuzmed.html`, que não existem (são ignorados em silêncio).
- Unificar `BLOCKED_STATIC` e a segunda lista de bloqueio (linhas 92 e 3562) — hoje duplicam regras.
- Aposentar as rotas do planner v1 (`/generate`, `/synergy-generate`, etc.) depois de migrar o front.
- Remover a rota `GET /` customizada: ela só lê `index.html` e impede o cache de borda.
- Testes unitários para `fs-safe`, `planner-engine` e `ticketSeal/Open`.
- A longo prazo: dividir `index.html` (CSS primeiro, depois JS por feature) com um bundler leve (esbuild).

---

## 6. Matriz impacto × esforço

| # | Melhoria | Impacto | Esforço | Quando |
|---|---|---|---|---|
| 1 | Fechar RLS + invalidar sessões | **Crítico** | Baixo | Hoje |
| 2 | Fechar `/api/drive/*` e tirar token da URL | Alto | Baixo | Hoje |
| 3 | `APP_PASSWORD` obrigatório + limite de body | Alto | Baixo | Hoje |
| 4 | Cache de borda (`s-maxage`/`stale-while-revalidate`) | Alto | Baixo | Esta semana |
| 5 | Região `gru1` | Alto | Baixo | Esta semana |
| 6 | Hidratação sob demanda do IndexedDB | Alto | Médio | Esta semana |
| 7 | Versão do catálogo + carga por curso | Alto | Médio | Esta semana |
| 8 | Questões paginadas + ETag | Alto | Médio | Este ciclo |
| 9 | Adiar CDNs + vendorizar Supabase | Médio | Baixo | Este ciclo |
| 10 | Auth por token (sem `select *`) | Médio | Baixo | Este ciclo |
| 11 | Streaming de tokens no SSE | Alto | Médio | Este ciclo |
| 12 | Cascata de modelos + rate-limit de IA | Alto | Médio | Este ciclo |
| 13 | Decks/questões no Supabase + Cron | Médio | Médio | Próximo |
| 14 | `/api/version` + health rico + smoke CI | Médio | Baixo | Próximo |
| 15 | Extrair CSS/JS do `index.html` | Médio | Alto | Próximo |

---

## 7. Ordem sugerida

**Hoje (≈1 h)**
1. Aplicar o SQL do RLS e confirmar `401` com a anon key.
2. Invalidar sessões; avisar sobre redefinição de senha.
3. Remover `/api/drive/` da whitelist; ajustar o `fetch` de download.
4. Exigir `APP_PASSWORD` e baixar o limite de body.

**Esta semana (≈1 dia)**
5. Cache de borda nos estáticos + validar `HIT`.
6. `regions: ["gru1"]` e medir TTFB.
7. Hidratação do IndexedDB por tela.
8. `GET /api/acervo/version` + cache do manifesto.
9. Vendorizar Supabase e adiar `pdf.js`/Firebase/YouTube.

**Este ciclo (≈3–5 dias)**
10. Questões paginadas e busca no servidor.
11. Auth por token e cron de limpeza.
12. SSE com `delta`/`status`/`error`.
13. Cascata de modelos e rate-limit de IA.

**Próximo**
14. Persistência de decks/questões e Cron jobs.
15. Observabilidade e smoke test no CI.
16. Extração de CSS/JS do monólito.

---

## 8. Métricas para provar o ganho

| Métrica | Hoje (estimado) | Meta |
|---|---|---|
| `X-Vercel-Cache` em CSS/JS | `MISS` | `HIT` |
| TTFB de `/` no Brasil | função `iad1` | borda `gru1` |
| Payload do manifesto (visita sem mudança) | 1,9 MB gzip | 0 (só `/version`) |
| Questões no primeiro load | 1,3 MB | ≤ 150 KB |
| Boot do front (hidratação) | todas as chaves | só a tela atual |
| Cold start da auth | `select *` em 2 tabelas | 1 query por token |
| Latência percebida do Mentor IA | resposta única | primeiro token <1 s |

> Estimativas baseadas no código e nas respostas medidas; validar com Lighthouse/WebPageTest e com os headers da Vercel após cada mudança.

---

## 9. Anexo — Checklist de verificação pós-correção

```bash
# RLS fechado (deve dar 401 ou [])
curl -s -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  "$SUPABASE_URL/rest/v1/users?select=username&limit=1"

# assets com cache de borda
curl -sI https://cuscuz-nu.vercel.app/css/medreader.css | grep -i "x-vercel-cache\|cache-control"

# função na região certa
curl -sI https://cuscuz-nu.vercel.app/api/health | grep -i "x-vercel-id"

# drive fechado (deve dar 401)
curl -s -o /dev/null -w "%{http_code}\n" https://cuscuz-nu.vercel.app/api/drive/list

# versão do build
curl -s https://cuscuz-nu.vercel.app/api/version
```
