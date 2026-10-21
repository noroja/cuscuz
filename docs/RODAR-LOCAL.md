# Rodar o Cuscuz-MED no seu computador

Node 22 ou superior. O app lê o arquivo `.env` sozinho.

## Modo 1 — tudo local (sem Vercel)
1. `npm install`
2. Copie `.env.example` para `.env` e preencha ao menos `APP_PASSWORD` e as chaves do Drive e das IAs que usa.
3. `npm run local` e abra http://localhost:3000.
4. No celular, na mesma rede Wi-Fi: `http://<IP-do-PC>:3000` (o servidor escuta em todas as interfaces; libere a porta 3000 no firewall se precisar).

Limites: só funciona com o PC ligado. Sem Supabase, usuários e sessões ficam em `data/` neste computador. Os dados de estudo (marcações, planner) ficam no navegador de cada aparelho.

## Modo 2 — híbrido: site na Vercel, vídeos e PDFs no seu PC
Objetivo: parar de gastar a "Transferência rápida de origem" (10 GB no plano Hobby). Vídeos e PDFs são o que mais pesa, e passam inteiros pela função da Vercel. Com este modo a Vercel só **redireciona** (poucos bytes) e o arquivo vem do seu PC.

1. No PC, o `.env` precisa ter o **mesmo `APP_PASSWORD`** da Vercel (é a chave que assina os links `/m/...`) e as mesmas credenciais do Drive.
2. `npm run local:midia`. Sobe na porta 3001 (mude com `MEDIA_PORT`). Esse modo responde **somente** `/m/*` e `/api/health`; todo o resto é 404, então é seguro expor num túnel.
3. Publique a porta em HTTPS, por exemplo:
   - Cloudflare: `cloudflared tunnel --url http://localhost:3001` (o endereço muda a cada execução, salvo túnel nomeado).
   - Tailscale: `tailscale funnel 3001` (endereço fixo `https://<pc>.<tailnet>.ts.net`).
4. Confira: `curl https://SEU-ENDERECO/api/health` deve responder `ok`.
5. Na Vercel, defina `MEDIA_ORIGIN=https://SEU-ENDERECO` (sem barra final) e faça o redeploy.

Como funciona: `/api/drive/stream/:id`, `/api/drive/pdf/:id` e `/m/:ticket` na Vercel respondem `307` para `MEDIA_ORIGIN/m/<ticket>`. O navegador baixa direto do seu PC. Sem `MEDIA_ORIGIN`, nada muda.

Atenção:
- Com o PC desligado ou o túnel fora do ar, vídeos e PDFs não abrem.
- A banda passa a ser a do upload da sua internet.
- Os limites e termos do túnel escolhido valem para você; não foram verificados aqui.
- Hoje as rotas `/api/drive/*` não exigem login (a proteção é só o ID do arquivo no Drive). Isso é anterior a este modo e vale também no host de mídia.
