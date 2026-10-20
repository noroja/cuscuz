# Deploy do Cuscuz-MED (backend + app) no Railway.app — grátis

O GitHub Pages só hospeda arquivos estáticos — o `server.js` (sync do Hardworq, gerador de questões com IA, tutor, chat) precisa de um servidor Node de verdade. O **Railway.app** conecta direto neste repositório e sobe tudo: app + API no mesmo endereço.

## Passo a passo (5 minutos, uma vez só)

1. Acesse [railway.app](https://railway.app) → **Get Started** → entre com a sua conta **GitHub**.
2. Clique em **New Project** → **Deploy from Repo** e escolha o repositório **Noronja/cuscuz** (ou seu fork).
3. O Railway vai detectar automaticamente que é um projeto Node.js e definir o comando de start como `npm start` (que executa `node server.js`).
4. Clique em **Deploy** e aguarde o build (~2 min).
5. Após o deploy inicial, o Railway vai pedir o valor das variáveis de ambiente necessárias. Vá em **Variables** e adicione:
    - `HARDWORQ_EMAIL` / `HARDWORQ_SENHA` → as credenciais da sua conta Hardworq
      (não ficam no GitHub; ficam só no serviço)
    - `GROQ_API_KEY` → se tiver, cola a sua (ativa o gerador de questões, o tutor IA, o Mentor e a transcrição de aulas)
    - `OPENAI_API_KEY` / `SUPABASE_URL` / `SUPABASE_ANON_KEY` → opcionais
    - `APP_PASSWORD` → (opcional) senha para proteção de acesso ao app
    - Variáveis do Hardworq adicionais (se necessário):
      - `HARDWORQ_ID_TURMA` (padrão: "1273")
      - `HARDWORQ_AUTO_SYNC` (padrão: "0")
      - `HARDWORQ_SYNC_INTERVAL_H` (padrão: "6")
      - `HARDWORQ_MAX_BANK` (padrão: "2000")
      - `HARDWORQ_MIRROR` (padrão: "1")
      - `HARDWORQ_MIRROR_MAX` (padrão: "25000")
    - `GITHUB_TOKEN` → Token do GitHub (Fine-grained, Contents: read and write neste repositório) para o servidor publicar o banco catalogado (opcional, mas recomendado para atualização automática do banco)
6. Aguarde o deploy. O log mostrará `🔑 [Hardworq] Login ok` quando a sessão subir.
7. Pronto: o app fica em algo como `https://cuscuz-med-production.up.railway.app` — use esse endereço.

## O que esperar no Railway

- **Sleeping (pausa gratuita)**: após 1 hora sem acesso (no plano gratuito), o serviço "dorme" e a primeira visita demora ~30-50s para acordar. As visitas seguintes são instantâneas enquanto ativo.
- **Arquivos temporários**: questões sincronizadas e o token de sessão vivem no disco do serviço e são recriados a cada reinício/depura. O banco volta com as questões commitadas no repo (o `.json` vai junto do deploy) e o login do Hardworq se refaz sozinho — as credenciais estão nas variáveis de ambiente.
- **Banco persistente**: para questões sincronizadas sobreviverem a reinícios, você pode:
  a) Fazer commit do `data/questions-bank.json` de tempos em tempos ( pode automatizar com o workflow do GitHub Actions)
  b) Usar um plano pago do Railway com persistência de disco
  c) Rodar local no seu PC

## Variáveis de ambiente importantes

Variáveis que podem ser configuradas no Railway (aba Variables):

| Variável | Descrição | Obrigatório? |
|----------|-----------|--------------|
| `HARDWORQ_EMAIL` | Login do Hardworq | Sim (para banco de questões) |
| `HARDWORQ_SENHA` | Senha do Hardworq | Sim (para banco de questões) |
| `GROQ_API_KEY` | Chave da API da Groq (console.groq.com) | Não (ativa recursos de IA) |
| `GROQ_MODEL` | Modelo de texto (padrão `openai/gpt-oss-120b`) | Não |
| `GROQ_STT_MODEL` | Transcrição de aulas (padrão `whisper-large-v3-turbo`) | Não |
| `GROQ_TIMEOUT_MS` / `GROQ_MAX_RETRIES` | Timeout por tentativa (45000) e tentativas extras em 429/5xx (2) | Não |
| `OPENAI_API_KEY` | Chave da API da OpenAI | Não (opcional) |
| `SUPABASE_URL` | URL do Supabase | Não (opcional) |
| `SUPABASE_ANON_KEY` | Chave anonima do Supabase | Não (opcional) |
| `APP_PASSWORD` | Senha de proteção do app | Não (recomendado para acesso restrito) |
| `GITHUB_TOKEN` | Token do GitHub para publicar banco | Não (recomendado para atualização automática) |
| `HARDWORQ_ID_TURMA` | ID da turma no Hardworq | Não (padrão: "1273") |
| `HARDWORQ_AUTO_SYNC` | Sincronização automática do Hardworq | Não (padrão: "0") |
| `HARDWORQ_SYNC_INTERVAL_H` | Intervalo de sync em horas | Não (padrão: "6") |
| `HARDWORQ_MAX_BANK` | Número máximo de questões no banco | Não (padrão: "2000") |
| `HARDWORQ_MIRROR` | Ativar espelho contínuo do banco | Não (padrão: "1") |
| `HARDWORQ_MIRROR_MAX` | Limite máximo do espelho | Não (padrão: "25000") |
| `NODE_VERSION` | Versão do Node.js | Não (padrão: "22.14.0") |

## Notas importantes

- O projeto usa Node.js versão 22 (definida implicitamente pelo package.json ou pode ser definida com NODE_VERSION)
- O comando de start é `npm start` (equivalente a `node server.js`)
- Não é necessário um Procfile ou arquivo de configuração especial; o Railway detecta automaticamente projetos Node
- O health check não é configurado por padrão, mas o endpoint `/api/health` existe no servidor

## Depois do deploy

Seu app estará disponível em um subdomínio da railway.app (como no exemplo: https://cuscuz-med-production.up.railway.app/)

Você pode conectar um domínio personalizado nas settings do serviço no Railway, se desejar.

O GitHub Pages pode continuar servindo como vitrine estática ou ser desativado em Settings → Pages — o endereço do Railway é o app completo com backend e frontend.

---

# Deploy na Vercel (serverless)

A Vercel roda o mesmo `server.js`, mas em modo **função serverless**: o disco do projeto é **somente leitura** e só `/tmp` é gravável (e efêmero). O código já se adapta sozinho a esse ambiente.

## Como funciona

- **`api/index.js`** exporta o app Express (a Vercel chama essa função para tudo que não é arquivo estático).
- O `server.js` detecta o ambiente (`VERCEL`/`AWS_LAMBDA_FUNCTION_NAME`/`VERCEL_ENV` via `src/fs-safe.js`) e **não** chama `app.listen()`. Fora da Vercel nada muda: `npm start` continua subindo o servidor HTTP normal.
- **`scripts/build-public.js`** copia os assets (HTML, CSS, JS, ícones, manifest) para `public/` durante o build. A Vercel serve `public/**` pelo CDN e **ignora** o `express.static()`.
- **`vercel.json`** define `buildCommand`, `maxDuration: 60` na função e os `includeFiles` que precisam chegar ao runtime (`index.html`, `acervo-manifest.json`, `drive-tree-snapshot.json`, `data/**`).

## Persistência de estado

Na Vercel **nada** é gravado no disco do projeto. Todo o estado mutável vai para `DATA_DIR`, que em serverless aponta para `/tmp/cuscuz-med`:

- banco de questões de trabalho (`questions-bank.json`) — o `data/questions-bank.json` do repositório serve apenas de **semente** somente-leitura;
- cache do radar, token/mirror do Hardworq, decks do planner, catálogo de extras, cache das apostilas.

Como `/tmp` é por invocação, o estado durável continua vindo da nuvem (Supabase) e do repositório. As tarefas de background (auto-sync do Hardworq, espelho, varredura de extras) **não** rodam em serverless — são acionadas por requisição/endpoints.

## Passo a passo

1. Vercel → **Add New… → Project** → importe o repositório do GitHub.
2. Framework preset: **Other**. Build Command e Output são lidos do `vercel.json` (não precisa mexer).
3. Em **Settings → Environment Variables**, adicione as mesmas variáveis do Railway (`GROQ_API_KEY`, `HARDWORQ_*`, `SUPABASE_*`, `GOOGLE_DRIVE_*`, etc.).
4. **Deploy**. O build roda `node scripts/build-public.js` e a função sobe em `api/index.js`.

## Cuidados

- O diretório `public/` é **gerado no build** e está no `.gitignore` — não versione.
- Nunca copie `acervo-manifest.json`, `drive-tree-snapshot.json` nem `data/**` para `public/`: isso exporia o banco e burlaria a checagem de login do endpoint `/acervo-manifest.json`.
- Rotas que terminam em extensões estáticas (`.css`, `.js`, `.png`, `.html`, …) **não** são reescritas para a função — são servidas pelo CDN. Se um asset faltar, o resultado é 404 (e não o `index.html`), o que facilita achar erro de caminho.
- O Mentor IA responde via **SSE** (`text/event-stream`) com keep-alive, para não estourar o tempo da função em respostas longas da IA.