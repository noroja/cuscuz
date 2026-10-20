# Ingestão automática de flashcards do Google Drive

## O que entrou no Cuscuz-MED

- O servidor percorre a pasta configurada e subpastas, localiza `.apkg` e `.colpkg` e lê somente arquivos novos ou alterados.
- Um processo sequencial baixa cada pacote para uma pasta temporária, extrai notas, modelos, cartões e tags e converte cada cartão para JSON canônico (`id`, `front`, `back`, `subject`, `topic`, `tags`, `source`).
- Os cartões são publicados em blocos de 500 no bucket privado `flashcards-library`; o manifesto só é atualizado depois do processamento do pacote.
- O ID do cartão é estável por arquivo Drive, nota e modelo. Reprocessamentos substituem os mesmos blocos e não criam cartões repetidos.
- A área SRS mostra a biblioteca compartilhada por deck. O histórico de revisão fica no `FCSRS` pessoal, sincronizado com a conta; o catálogo inteiro não é copiado para cada usuário.
- Na inicialização, faz uma carga inicial ou retoma pelo cursor persistido. Depois, usa notificações push do Google Drive para consultar apenas o feed incremental e processar os pacotes alterados. Uma reconciliação incremental diária recupera notificações perdidas; não há consulta periódica ao Supabase. Sem webhook configurado, a recuperação diária continua disponível.
- O conteúdo Anki é convertido para texto seguro. Imagens e áudios são indicados como placeholders; a mídia ainda não é hospedada pelo leitor de flashcards.

## Configuração do servidor

Configure no ambiente de execução:

```env
GOOGLE_DRIVE_FLASHCARDS_ROOTS=ID|CAMINHO_DA_PASTA;ID|OUTRO_CAMINHO
GOOGLE_DRIVE_FLASHCARDS_SYNC=true
FLASHCARD_MAX_PACKAGE_BYTES=6442450944
DRIVE_PUSH_WEBHOOK_URL=https://seu-dominio.com/webhooks/google-drive
DRIVE_PUSH_WEBHOOK_TOKEN=segredo-aleatorio-longo
GOOGLE_SERVICE_ACCOUNT_JSON=JSON_DA_CONTA_DE_SERVICO
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=COLE_A_CHAVE_NO_SECRETO_DA_VERCEL
```

Compartilhe cada pasta configurada com o e-mail da conta de serviço com permissão de leitor. Cada item em `GOOGLE_DRIVE_FLASHCARDS_ROOTS` é `ID|caminho`, separado por ponto e vírgula. Acrescente raízes para cada diretório que venha a receber decks; as pastas que já contêm pacotes constam em `flashcards-drive-candidates.json` no catálogo local. Também é aceito `GOOGLE_DRIVE_FLASHCARDS_ROOT_ID` para uma raiz única.

A chave de serviço do Supabase deve ficar somente no servidor. O servidor cria o bucket privado de armazenamento quando a chave tiver permissão administrativa. Use um servidor Node contínuo (Node 22.13 ou superior), um domínio HTTPS público e a conta de serviço autorizada no Drive. O webhook é autenticado pelo ID do canal e por `DRIVE_PUSH_WEBHOOK_TOKEN`; os canais são renovados antes de expirar. As notificações do Google só avisam que o feed mudou, então o servidor lê a Changes API desde o cursor salvo no bucket `acervo`. O cursor é persistido para sobreviver a reinícios. A reconciliação diária é uma proteção para indisponibilidade prolongada, não o caminho normal.

O scanner procura recursivamente qualquer `.apkg`/`.colpkg` abaixo das raízes configuradas. Prefira as pastas que contêm decks, não a raiz inteira do Drive.

## Rotas autenticadas

- `GET /api/flashcards/library/status` — estado da rotina.
- `GET /api/flashcards/library/decks` — decks e quantidades disponíveis para estudo.
- `GET /api/flashcards/library/decks/:deckId/cards?offset=0&limit=100` — página de cartões.
- `POST /api/flashcards/library/sync` — sincronização imediata, somente usuário com papel `admin`; corpo opcional `{ "force": true }` para reprocessar arquivos sem alteração aparente.
- `POST /webhooks/google-drive` — callback HTTPS do Google Drive; não requer sessão de usuário, mas valida canal e segredo antes de enfileirar o delta.

## Limites e segurança

- `.colpkg` é lido como pacote de coleção; o processo não o importa numa coleção Anki ativa nem altera dados do Anki.
- Arquivos individuais acima do limite configurado são marcados como erro. O inventário apontou um pacote de vários GB; confirme espaço temporário e tempo de execução no host antes de habilitar essa fonte.
- Pacotes com modelos incomuns podem produzir frente/verso incompletos; cartões vazios são omitidos e registrados no manifesto como rejeitados.
- Mídia Anki, HTML avançado, CSS dos modelos, fórmulas e cloze complexo não são preservados integralmente; o texto fica disponível na revisão com placeholders para mídia.
- PDFs ainda não são convertidos por esta rotina. Eles precisam de extração de texto/OCR e classificação específica; este worker não os transforma silenciosamente em cartões inventados.
- Um arquivo removido da pasta deixa de aparecer no catálogo depois de uma varredura bem-sucedida. O progresso SRS pessoal permanece salvo, mas o conteúdo-fonte deixa de ser servido.

## Operação

Após configurar as variáveis e reiniciar o servidor, a carga inicial começa automaticamente e o canal push é criado assim que houver cursor. A biblioteca aberta recebe eventos do servidor por uma conexão SSE autenticada e atualiza o manifesto e a lista de aulas sem polling. Para acompanhar, consulte a rota de status autenticada e os logs do host. A tela **Treino → Flashcards → Biblioteca do Drive** lista os decks publicados e inicia a revisão interativa com o SRS existente.
