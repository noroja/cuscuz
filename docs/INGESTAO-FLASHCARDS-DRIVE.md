# Ingestão automática de flashcards do Google Drive

## O que entrou no Cuscuz-MED

- O servidor usa `data/flashcard-drive-index.json` para pacotes Anki e `data/flashcard-pdf-index.json` para PDFs candidatos. O segundo índice é gerado de `acervo-manifest.json` por `npm run index:flashcards-pdf`; atualmente contém 299 PDFs cujo nome ou pasta indica flashcard. Os metadados dos IDs são atualizados no Drive e combinados com a varredura das raízes configuradas.
- A sincronização compara `modifiedTime`, `size` e `md5Checksum` antes de transferir; um processo sequencial transmite cada pacote para uma pasta temporária, valida nomes e limites do ZIP, extrai notas, modelos, cartões e tags e converte cada cartão para JSON versionado.
- Os cartões são publicados em blocos de 500 no bucket privado `flashcards-library`; o manifesto só é atualizado depois do processamento do pacote.
- A migração `supabase/migrations/20261021_flashcard_library.sql` cria as tabelas normalizadas de origens, jobs, decks, notas, cartões (`flashcard_library_cards`), mídia, estado SRS por usuário e eventos de revisão. O nome isolado evita colisão com a tabela legada `public.flashcards`, que pode ter IDs UUID; o worker usa hashes estáveis de texto. A UI lê e grava revisões identificadas pela sessão do Cuscuz-MED.
- O ID do cartão é estável por arquivo Drive, nota e modelo. Reprocessamentos substituem os mesmos blocos e não criam cartões repetidos.
- A área SRS mostra a biblioteca compartilhada por deck. O estado SRS e os eventos ficam no Supabase associados ao usuário da sessão; `FCSRS` continua como espelho compatível com o estado da conta existente. IDs estáveis fazem o progresso sobreviver a correções de conteúdo.
- Na inicialização, faz uma carga inicial ou retoma pelo cursor persistido. Depois, usa notificações push do Google Drive para consultar apenas o feed incremental e processar os pacotes alterados. Uma reconciliação incremental diária recupera notificações perdidas; não há consulta periódica ao Supabase. Sem webhook configurado, a recuperação diária continua disponível.
- HTML Anki passa por uma lista de elementos/atributos permitidos. Imagens raster referenciadas são extraídas, deduplicadas por SHA-256 e guardadas no Storage privado; cartões usam uma rota autenticada do Cuscuz-MED. SVG, áudio, vídeo e arquivos acima dos limites viram placeholders e não são publicados nesta fase.
- Cloze permanece marcado como `type: cloze`, conserva a lacuna no enunciado, registra respostas e revela a resposta ao virar o cartão.
- PDFs candidatos são baixados dentro do limite `FLASHCARD_MAX_PDF_BYTES` (18 MiB por padrão) e passam por extração de texto. Só se tornam cartões quando o PDF contém marcadores explícitos `Frente:`/`Verso:`, `Pergunta:`/`Resposta:`, `Front:`/`Back:`, `Question:`/`Answer:` ou `Q:`/`A:` em linhas separadas. Cada cartão conserva o ID e o caminho do PDF original e recebe disciplina/curso do catálogo.

## Configuração do servidor

Configure no ambiente de execução:

```env
GOOGLE_DRIVE_FLASHCARDS_ROOTS=ID|CAMINHO_DA_PASTA;ID|OUTRO_CAMINHO
GOOGLE_DRIVE_FLASHCARDS_CATALOG_PATH=
GOOGLE_DRIVE_FLASHCARDS_SYNC=true
FLASHCARD_MAX_PACKAGE_BYTES=104857600
FLASHCARD_MAX_PDF_BYTES=18874368
FLASHCARD_MAX_UNPACKED_BYTES=536870912
FLASHCARD_MAX_ARCHIVE_ENTRIES=50000
FLASHCARD_MAX_MEDIA_FILE_BYTES=26214400
FLASHCARD_MAX_MEDIA_TOTAL_BYTES=262144000
DRIVE_PUSH_WEBHOOK_URL=https://seu-dominio.com/webhooks/google-drive
DRIVE_PUSH_WEBHOOK_TOKEN=segredo-aleatorio-longo
GOOGLE_SERVICE_ACCOUNT_JSON=JSON_DA_CONTA_DE_SERVICO
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=COLE_A_CHAVE_NO_SECRETO_DA_VERCEL
```

Compartilhe cada pasta configurada com o e-mail da conta de serviço com permissão de leitor. Cada item em `GOOGLE_DRIVE_FLASHCARDS_ROOTS` é `ID|caminho`, separado por ponto e vírgula. Acrescente raízes para cada diretório que venha a receber decks; as pastas que já contêm pacotes constam em `flashcards-drive-candidates.json` no catálogo local. Também é aceito `GOOGLE_DRIVE_FLASHCARDS_ROOT_ID` para uma raiz única.

A chave `SUPABASE_SERVICE_ROLE_KEY` é obrigatória para o worker e deve ficar somente no servidor. Antes de habilitar a ingestão, aplique a migração SQL acima no Supabase; ela bloqueia acesso direto a usuários anon/autenticados e permite acesso apenas à service role. O servidor cria o bucket privado de armazenamento quando a chave tiver permissão administrativa. Use Node 22.13 ou superior e a conta de serviço autorizada no Drive. O arquivo índice padrão já vem no repositório; `GOOGLE_DRIVE_FLASHCARDS_CATALOG_PATH` pode apontar para outro catálogo compatível. O webhook é autenticado pelo ID do canal e por `DRIVE_PUSH_WEBHOOK_TOKEN`; a reconciliação diária recupera notificações perdidas.

O scanner procura recursivamente qualquer `.apkg`/`.colpkg` abaixo das raízes configuradas. Prefira as pastas que contêm decks, não a raiz inteira do Drive.

## Rotas autenticadas

- `GET /api/flashcards/library/status` — estado da rotina.
- `GET /api/flashcards/library/decks` — decks e quantidades disponíveis para estudo.
- `GET /api/flashcards/library/decks/:deckId/cards?offset=0&limit=100` — página de cartões.
- `POST /api/flashcards/library/reviews` — salva estado e evento de uma resposta (grau 0–3).
- A rota paginada de cartões inclui o estado SRS do usuário somente para os IDs daquela página e não permite cache compartilhado.
- `POST /api/flashcards/library/sync` — sincronização imediata, somente usuário com papel `admin`; corpo opcional `{ "force": true }` para reprocessar arquivos sem alteração aparente.
- `GET /api/flashcards/library/media/:assetName` — serve imagens raster deduplicadas do bucket privado, com autenticação de sessão.
- `POST /webhooks/google-drive` — callback HTTPS do Google Drive; não requer sessão de usuário, mas valida canal e segredo antes de enfileirar o delta.

## Limites e segurança

- `.colpkg` é lido como pacote de coleção; o processo não o importa numa coleção Anki ativa nem altera dados do Anki.
- O limite inicial é 100 MiB comprimidos e 512 MiB expandidos para proteger a função serverless. Pacotes maiores do catálogo ficam registrados como erro até serem processados por um worker com mais disco/tempo e limites explicitamente revistos.
- Pacotes com modelos incomuns podem produzir frente/verso incompletos; cartões vazios são omitidos e registrados no job/manifesto.
- Os testes usam um APKG sintético local com dois templates, Cloze e imagem; nenhum pacote do Drive foi baixado ou importado para Supabase durante esta implementação.
- PDFs sem texto selecionável (escaneados), sem os pares de marcadores aceitos ou com layout ambíguo terminam como `failed` com motivo no job/origem e não são publicados como cartões. OCR e revisão de layout ficam para uma etapa posterior; não há geração de conteúdo por IA nesta conversão.
- O índice é uma seleção semântica do catálogo local, não uma leitura atual do Drive. Arquivos novos ficam cobertos quando estão sob uma raiz configurada e têm `.pdf` com “flashcard” no nome ou caminho; para arquivos já catalogados que não correspondem ao nome/caminho, gere o índice após atualizar `acervo-manifest.json`.
- Um arquivo removido da pasta deixa de aparecer no catálogo depois de uma varredura bem-sucedida. O progresso SRS pessoal permanece salvo, mas o conteúdo-fonte deixa de ser servido.

## Operação

Após configurar as variáveis e reiniciar o servidor, a carga inicial começa automaticamente e o canal push é criado assim que houver cursor. A biblioteca aberta recebe eventos do servidor por uma conexão SSE autenticada e atualiza o manifesto e a lista de aulas sem polling. Para acompanhar, consulte a rota de status autenticada e os logs do host. A tela **Treino → Flashcards → Biblioteca do Drive** lista os decks publicados e inicia a revisão interativa com o SRS existente.
