# Autenticação privada do Cuscuz-MED

## Diagnóstico registrado

O Cuscuz-MED é uma aplicação Node.js 24 com Express e páginas HTML/JavaScript servidas pelo mesmo processo, publicada na Vercel. A aplicação mantém sua própria tabela de contas e sessões no Supabase; as senhas são derivadas com `scrypt`. O Supabase Auth valida as sessões do Google. O Firebase Realtime Database sincroniza estado de estudo e não é o provedor de login.

Na versão auditada, o frontend e `POST /api/auth/signup` permitiam cadastro aberto. O endpoint Google também criava uma conta Cuscuz-MED para qualquer e-mail Google verificado. O middleware deixava rotas de mídia fora da autenticação e aceitava tokens por query/body. As políticas SQL de `users`, `sessions`, conversas e alguns dados de estudo eram permissivas para `anon`. Uma leitura sem autenticação confirmou 15 linhas de usuários e nenhum papel administrativo; não foram lidos hashes nem tokens de sessão. Não havia fluxo de recuperação de senha no código.

Notas abaixo são uma avaliação qualitativa da implementação anterior, baseada em inspeção de código e configuração; não são métricas de uso nem teste clínico.

| Critério | Avaliação inicial | Problemas observados | Prioridade | Solução aplicada/preparada |
|---|---|---|---|---|
| Cadastro e autorização | Parcial, 2/10 | Endpoint de cadastro aberto e Google provisionava usuários automaticamente | Crítica | Negar cadastro no servidor e permitir Google apenas para conta ativa previamente autorizada |
| Sessão e APIs | Parcial, 3/10 | Token no `localStorage`, rotas de mídia sem middleware, token em URL/body e suspensão sem verificação atual | Crítica | Cookie HttpOnly, verificação de sessão no banco, middleware nas APIs e suspensão com revogação |
| Papéis e painel | Ausente, 0/10 | Sem RBAC nem gerenciamento administrativo | Alta | Papéis `user`, `admin`, `super_admin`, painel e bootstrap explícito de conta existente |
| Banco e segredos | Parcial, 2/10 | Políticas permissivas para `anon`; exposição confirmada de linhas de usuário/sessão | Crítica | Migração RLS server-only preparada; exige aplicação manual antes do deploy |
| Recuperação de senha | Ausente, 0/10 | Não havia fluxo de recuperação | Alta | E-mail Supabase + desafio hash de uso único, expiração e revogação de sessões |

**Estado operacional:** as correções estão no código e têm testes locais simulados. A migração SQL, as opções do Supabase Auth, o SMTP, as variáveis da Vercel e o primeiro `super_admin` ainda dependem de intervenção manual; até lá, a produção não está integralmente protegida por esta alteração.

## O que esta alteração implementa

- O cadastro público e a consulta pública de nomes são bloqueados no servidor; a interface informa que o acesso é exclusivo.
- Google só entra se o e-mail confirmado corresponder a uma conta ativa já existente. Não há provisionamento automático.
- Login retorna um cookie `HttpOnly`, `SameSite=Lax` e `Secure` em HTTPS. Um bearer legado só é aceito por `GET /api/auth/me` para migrar a sessão para cookie; nessa migração a validade é renovada por 30 dias. APIs privadas aceitam cookie e ignoram token de sessão em query/body ou bearer genérico. Sessões novas têm validade fixa de 30 dias.
- Toda rota privada de `/api` exige sessão, incluindo as rotas de mídia; login, convite, recuperação, health/config e cron com segredo são exceções explícitas. Suspensão consulta o estado atual e revoga as sessões armazenadas.
- `/api/health` público informa apenas disponibilidade e horário; detalhes dos provedores, Drive e o diagnóstico ativo `?deep=1` exigem uma sessão administrativa.
- O painel oferece convite, busca, reenviar convite, suspensão/reativação e alteração de papel. `admin` gerencia usuários comuns; somente `super_admin` gerencia papéis administrativos. O administrador principal não pode ser suspenso nem alterado pelo painel.
- Convites usam token aleatório armazenado como hash, expiram em uma hora (mesmo prazo padrão do Supabase Auth) e são consumidos uma vez sob bloqueio de linha no Postgres. A pessoa define uma senha de 12 caracteres ou mais.
- Se o e-mail já pertencer a uma identidade Supabase confirmada, o sistema envia um link de acesso com `shouldCreateUser=false`; a ativação da conta Cuscuz continua condicionada ao convite de uso único.
- A recuperação envia uma resposta genérica para evitar enumeração de e-mails. O link combina sessão confirmada do Supabase Auth com token aleatório armazenado apenas como hash, uso único e expiração de 20 minutos; a operação SQL altera a senha e revoga sessões na mesma transação.
- Login e ativação têm rate limit em memória por instância. Tickets de mídia não usam mais uma chave padrão conhecida; sem `MEDIA_TICKET_SECRET` ou `APP_PASSWORD`, não são emitidos.
- A migração protege dados existentes sem apagar registros. A chave `SUPABASE_SERVICE_ROLE_KEY` permanece somente no servidor.

## Preparação manual necessária

Estas etapas não foram executadas em produção.

1. Revise e aplique `supabase/migrations/20261023_private_auth.sql` no projeto Supabase. Ela remove políticas RLS de acesso público em tabelas privadas, restringe privilégios a `service_role`, cria convites/auditoria e adiciona os campos de estado. Não apaga contas nem dados de estudo. Depois disso, confirme que `SUPABASE_SERVICE_ROLE_KEY` está disponível no ambiente do servidor; a chave `anon` não substitui essa chave.
2. Configure `APP_URL` para o domínio canônico, por exemplo `https://cuscuz-nu.vercel.app`. Inclua o endereço usado para ativação e recuperação na allow list de URLs de redirecionamento do Supabase Auth. Mantenha `Email OTP Expiration` em uma hora (prazo padrão que também rege convites e recuperação) ou ajuste o TTL do app para acompanhar. Configure um SMTP de produção e revise o template de convite; o SMTP de teste do Supabase pode restringir destinatários.
3. No Supabase Auth, desative novos cadastros e logins anônimos. O app bloqueia a criação de contas próprias, mas essa configuração também impede que uma identidade Supabase sem permissão seja criada fora do fluxo administrativo. Convites enviados pelo Auth Admin devem ser testados depois da mudança.
4. Como não existe `super_admin` entre as contas observadas, escolha uma conta existente e execute, em um terminal interativo, `npm run auth:bootstrap-admin -- <usuario-existente>`. O comando mostra o host do Supabase, exige digitar o nome novamente, recusa criar contas ou alterar senhas e só funciona se ainda não existir um administrador principal. Não o execute sem conferir o projeto/ambiente carregado.
5. Faça um convite de teste, valide o e-mail recebido, ative a conta e teste login, recuperação, suspensão e a rota `/api/admin/users`. Só então planeje a implantação.

## Riscos e limites conhecidos

- O rate limit atual é por instância Node; não coordena tentativas entre diferentes funções Vercel. Para tráfego público, aplique rate limiting persistente no firewall da Vercel ou acrescente Turnstile com validação server-side.
- MFA administrativo não está imposto pelo app. Se for requisito, deve ser configurado e validado no provedor de identidade, com um desenho compatível com a senha local Cuscuz-MED.
- Contas antigas sem e-mail vinculado não podem usar recuperação por e-mail até que um administrador valide e vincule uma identidade. A recuperação não altera nem remove essas contas.
- A aplicação usa Supabase Auth para enviar o convite. SMTP e URLs permitidas são configurações do projeto e exigem validação manual.
- Cloudflare não é necessária para a autenticação implementada. Turnstile é independente do proxy e tem plano gratuito. Cloudflare Access só é adequado se a plataforma for restrita a um grupo controlado por esse IdP; um proxy não protege automaticamente o domínio `vercel.app` direto. Nenhum DNS, proxy ou recurso da Cloudflare foi alterado.
- Proteção de deployment da Vercel pode restringir também usuários legítimos do Cuscuz-MED se exigir uma conta Vercel. Por isso, mantenha a autenticação da aplicação como controle principal e avalie proteção de previews separadamente.

## Avaliação Vercel e Cloudflare

- **Vercel:** a proteção `All Deployments` com Vercel Authentication pode proteger preview e produção sem custo adicional, mas exige que cada visitante use uma conta Vercel com acesso ao projeto. Como os alunos têm contas Cuscuz-MED independentes, não recomendo ativá-la na produção sem antes validar esse modelo. Use a autenticação do app como barreira de produção e proteja previews separadamente.
- **Cloudflare Turnstile:** tem opção gratuita com desafios ilimitados e funciona sem mover DNS ou ativar proxy. Se abuso de login/recuperação justificar, pode ser adicionado nos formulários; a validação do token no servidor é obrigatória. Não foi adicionado agora porque o cadastro público já está bloqueado no app.
- **Cloudflare Access/proxy:** não é necessário para este desenho e adicionaria configuração de domínio. O acesso direto ao domínio `vercel.app` precisa ser considerado; proteger só o caminho via Cloudflare não basta sem validação de token no servidor para bloquear acessos que contornem o Access. Nenhuma configuração Cloudflare, Vercel ou DNS foi alterada.

## Testes

`scripts/tests/auth-private.test.mjs` usa uma API Supabase local simulada para verificar cadastro negado, Google sem autorização, cookie HttpOnly, suspensão, papéis, convite e recuperação de uso único, expiração, migração de bearer legado e limitação de tentativas. `scripts/tests/auth-interface.test.mjs` verifica a remoção do cadastro e a sintaxe dos scripts inline. `scripts/tests/media-origin.test.mjs` valida streaming entre processos com um usuário local fixture, sem recorrer a cadastro público.

O SQL precisa ser aplicado num projeto de teste Supabase para validar permissões/RLS e o SMTP real. Nenhum teste de produção ou mudança de configuração hospedada faz parte deste commit.
