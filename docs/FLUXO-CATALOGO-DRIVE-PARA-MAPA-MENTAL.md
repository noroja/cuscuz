# Especificação para mapa mental: Drive, catálogo e flashcards

## Objetivo

Desenhar um mapa mental técnico, de ponta a ponta, mostrando como arquivos de uma pasta do Google Drive chegam ao catálogo do Cuscuz-MED, como decks Anki viram flashcards interativos, como mudanças são detectadas e como o site recebe os dados. O desenho deve distinguir o comportamento de servidor persistente do comportamento serverless na Vercel e indicar claramente os pontos ainda dependentes de configuração ou validação em produção.

## Prompt pronto para uma IA de diagramas

> Crie um mapa mental hierárquico, em português, com o nó central **“Google Drive → Cuscuz-MED: catálogo, aulas e flashcards”**. Organize os ramos em: (1) configuração e autenticação, (2) descoberta inicial do acervo, (3) ingestão/conversão de Anki, (4) persistência/cache, (5) detecção de mudanças sem polling do Supabase, (6) consumo pelo site e aulas teóricas, (7) operação na Vercel, (8) falhas, limites e verificações. Mostre as APIs, funções, formatos, identificadores e buckets nomeados abaixo. Use setas direcionais para o fluxo dos dados e setas tracejadas para reconciliação/recuperação. Diferencie “tempo real por webhook” de “reconciliação diária de segurança”. Marque dependências não configuradas com “configurar” e limitações conhecidas com “validar/limite”. Não sugira reorganização ou escrita no Drive: o fluxo descrito é leitura e indexação.

## Componentes e dados

### 1. Configuração e autenticação

- `GOOGLE_DRIVE_FOLDER_ID`: raiz geral usada pelo catálogo de materiais/aulas.
- `GOOGLE_DRIVE_EXTRA_FOLDERS`: raízes adicionais do catálogo, quando configuradas.
- `GOOGLE_DRIVE_FLASHCARDS_ROOTS`: raízes específicas dos decks, no formato `ID|caminho;ID|outro caminho`.
- Pasta privada: autenticação por `GOOGLE_SERVICE_ACCOUNT_JSON`; a conta de serviço precisa ter acesso de leitura à pasta.
- `GOOGLE_DRIVE_API_KEY`: alternativa apenas quando os arquivos são acessíveis por API key; não substitui permissão em Drive privado.
- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` para operações administrativas no Storage privado; `SUPABASE_ANON_KEY` é a chave pública do cliente e não deve ser presumida como autorizada a criar bucket ou gravar.
- Push: `DRIVE_PUSH_WEBHOOK_URL`, `DRIVE_PUSH_WEBHOOK_TOKEN`.
- Cron Vercel: `CRON_SECRET`, enviado por Vercel como `Authorization: Bearer ...`.
- Não exibir valores secretos no mapa ou no relatório.

### 2. Descoberta e catálogo geral

1. `server.js` carrega `src/load-env.js` antes dos módulos que leem variáveis.
2. `src/drive-auth.js` autentica via conta de serviço ou API key e fornece `driveFetch`/`driveFetchWithRetry`.
3. `src/extra-drive.js` lê pastas e metadados pela Google Drive API; o acervo geral conserva IDs, nomes, tipos, caminhos e datas relevantes.
4. `src/supabase-catalog.js` baixa/publica o manifesto durável no Storage do Supabase (bucket `acervo`, objeto `acervo-manifest.json`).
5. O cursor incremental do Drive é persistido no bucket `acervo`, objeto `drive-change-token.json`; não usar timer que consulte o Supabase.
6. A interface usa o catálogo para encontrar materiais e iniciar as experiências de aula/apostila; assets estáticos são publicados pela Vercel CDN.

### 3. Ingestão Anki → cartões interativos

1. Enumerar somente as raízes de `GOOGLE_DRIVE_FLASHCARDS_ROOTS` e suas subpastas.
2. Selecionar arquivos `.apkg` e `.colpkg` e obter metadados/IDs pelo Drive.
3. Baixar o pacote para diretório temporário; respeitar `FLASHCARD_MAX_PACKAGE_BYTES` e o limite de duração/armazenamento do runtime.
4. `anki-apkg-parser` extrai notas, modelos, templates, decks, tags e cartões.
5. Converter templates frente/verso e lacunas cloze para conteúdo textual navegável; limpar HTML.
6. Identidade estável do cartão: hash de `Drive file ID + note ID + card ordinal`.
7. Gravar cartões em chunks de até 500 no bucket privado `flashcards-library`, caminhos `library/decks/<deck-id>/<chunk>.json`.
8. Atualizar `library/manifest.json` com decks, contagens, arquivo de origem, caminho, data de modificação e estado de processamento.
9. Remoções/mudanças invalidam chunks antigos e removem decks de arquivos que saíram das raízes.

### 4. Consumo no site

- `GET /api/flashcards/library/decks`: lê o manifesto e retorna metadados dos decks.
- `GET /api/flashcards/library/decks/:deckId/cards?offset=&limit=`: lê somente os chunks necessários para a página solicitada.
- `POST /api/flashcards/library/sync`: sincronização manual restrita a administrador.
- A UI carrega os cartões em páginas para reduzir memória/tráfego e apresenta frente, verso, tags, deck e fonte.
- A experiência de aula teórica consulta o catálogo geral de materiais; ela é um fluxo irmão, não uma etapa da conversão Anki.

### 5. Mudanças sem polling do Supabase

1. Sincronização inicial/reconciliação lê a Google Drive Changes API e grava o cursor em Supabase Storage.
2. Google Drive `changes.watch` envia POST para `DRIVE_PUSH_WEBHOOK_URL` quando o conteúdo muda.
3. Validar `x-goog-channel-token` com comparação em tempo constante e exigir ID do canal.
4. Buscar o delta da Changes API usando o cursor salvo; não varrer toda a árvore em cada alteração.
5. Atualizar somente itens afetados no catálogo e decks Anki; persistir novos manifestos e cursor.
6. Notificações do Drive não carregam a lista de arquivos: elas apenas disparam a leitura do delta.
7. Uma reconciliação diária refaz o delta e renova o canal (janela de expiração de aproximadamente seis dias).

### 6. Diferença de execução por hospedagem

**Servidor persistente (execução local/Railway/Render):**

- O processo pode manter timers, fila em memória e conexões SSE abertas.
- Inicialização/reconciliação e renovação periódica são executadas pelo processo.
- Webhook pode responder rapidamente e enfileirar o processamento.

**Vercel serverless:**

- O processo pode ser reciclado; memória, timers e `/tmp` não são estado durável.
- O webhook processa o delta dentro da invocação antes de responder.
- Cron diário em `vercel.json` chama `/webhooks/google-drive/maintenance`, autenticado por `CRON_SECRET`; faz reconciliação e renova o canal.
- A função está configurada com `maxDuration: 300`; limites do plano e o tamanho do pacote podem interromper uma importação grande.
- **Limitação a validar:** `catalogEventClients`/SSE vive em memória de uma instância. Uma função webhook pode não alcançar os navegadores ligados a outra instância. Para atualização instantânea confiável entre instâncias, publicar evento num canal Supabase Realtime ou outro pub/sub via websocket; isso não é polling, mas precisa implementação/validação específica.
- O Cron existe apenas após deploy de produção e precisa da variável `CRON_SECRET` definida no projeto Vercel.

## Falhas e observabilidade para incluir no mapa

- Credencial Google ausente/inválida; conta de serviço sem permissão sobre a pasta privada.
- ID de raiz inválido ou pasta fora do escopo permitido.
- Cursor expirado/inválido: exige sincronização completa de recuperação.
- Limites/quota da Google Drive API; `driveFetchWithRetry` faz retry em limites temporários.
- Pacote Anki corrompido, grande demais, sem cartões úteis ou com template não suportado.
- Supabase Storage indisponível, bucket sem permissão ou manifesto/chunk inconsistente.
- Timeout/memória de função serverless durante importação inicial.
- Notificação perdida/expirada: recuperação no Cron diário.
- Consultar estado por `getFlashcardSyncStatus`, logs `[Drive Push]`, `[Flashcards]`, `/api/acervo/extra-status` e endpoints de biblioteca.

## Critérios visuais

- Nós principais em ordem: **Drive → detecção → processamento → Supabase → site**.
- Usar uma cor para fluxo geral de aulas/materiais, outra para flashcards e uma terceira para gatilhos/erros.
- Mostrar duas entradas para detecção de mudanças: **push imediato** e **Cron diário de segurança**.
- Marcar Supabase como persistência/consulta de dados, nunca como fonte de polling de mudanças do Drive.
- Não desenhar operações de renomear, mover ou apagar arquivos no Drive; o sincronizador descrito é somente leitura.
