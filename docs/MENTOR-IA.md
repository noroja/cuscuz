# Mentor IA acadêmico (Faculdade + Residência)

Evolução da área de planejamento existente (`planner-v2.js` + `src/planner-engine.js`). Não é um app separado.

## Provedor de IA
Groq (API compatível com OpenAI) por `src/ai-provider.js`. Variáveis: `GROQ_API_KEY`, `GROQ_MODEL` (padrão `openai/gpt-oss-120b`), `GROQ_STT_MODEL` (`whisper-large-v3-turbo`), `GROQ_TIMEOUT_MS`, `GROQ_MAX_RETRIES`, `GROQ_BASE_URL`, `AI_PROVIDER`.
Sem a chave o app funciona com o motor determinístico; só o que depende de IA retorna mensagem clara. O `main` agora tem um provedor híbrido (commit 21712fe): com `AI_PROVIDER=auto` e as duas chaves, há roteamento e fallback mútuo Groq↔Gemini; `AI_PROVIDER=groq` ou `gemini` fixa um só. Veja os comentários no topo de `src/ai-provider.js`.
O OpenRouter (`OPENROUTER_API_KEY`, padrão Nemotron `nvidia/nemotron-3.5-super-vl:free`) é um 3º provedor: no modo `auto` é o último recurso; com `AI_PROVIDER=openrouter` é o único. Atenção: modelos `:free` têm cota diária baixa e, conforme a política do provedor, podem registrar prompts; a transcrição de áudio continua exigindo `GROQ_API_KEY`.

## Roteamento entre os 3 provedores (modo `auto`)
1. **Elegibilidade por tamanho:** Groq só recebe prompt que cabe no TPM do minuto (`GROQ_TPM`); Gemini e OpenRouter pelo teto de caracteres de cada um.
2. **Preferência:** Groq → Gemini → OpenRouter entre os elegíveis (rápido e barato primeiro; contexto enorme para o que não cabe; gratuito como rede de segurança). `AI_ORDER` muda a ordem.
3. **Saúde:** quem falha 2x seguidas no último minuto é rebaixado para o fim da fila; limite diário/de janela liga o disjuntor do provedor (sem esperar nem insistir).
4. **Falha rápida:** havendo outro provedor livre, o atual gasta no máximo 1 retry antes de passar a bola.
5. **Troca por:** limite, 5xx, timeout, rede, chave inválida, resposta cortada ou JSON inválido. Erros de entrada (PDF sem texto, tipo não suportado) não trocam.
6. **Transparência:** cada resposta traz `tentativas` (quem foi tentado e por que falhou); `/api/health` mostra `aiProvedores` (modelo, saúde, limite, latência média). Log por chamada sem conteúdo.
A transcrição de áudio só usa a Groq (Whisper).

## Fluxo
1. **Conferir** (`POST /api/planner/v3/conferir`): lê texto colado, `.txt`/`.md` ou PDF com texto selecionável (regras primeiro; IA só se as regras não reconhecerem o formato). Devolve um **rascunho**, ambiguidades e itens faltando. Não altera nada.
2. O aluno corrige o rascunho na interface.
3. **Confirmar** (`/confirmar-faculdade`, `/confirmar-residencia`): revalida no servidor e gera o perfil atualizado; o plano é replanejado preservando o histórico.

Não suportados: imagens, PDF escaneado, `.docx`.

## Trilhas
Cada tarefa tem `trilha`: `faculdade`, `residencia` ou `compartilhada`.
- Faculdade: provas, prévias de aula, véspera de prova e blocos do "modo prova".
- Residência: cronograma do aluno (`cronogramaResidencia`) e blocos do acervo.
- Compartilhada: sessão principal quando um assunto aparece nas duas trilhas; revisões herdam a trilha dos temas que revisam.

## Associações faculdade ↔ residência
- **Alta**: ≥ 2 termos específicos em comum cobrindo ≥ 60% do menor tema. Aplicada automaticamente; o aluno pode rejeitar.
- **Média**: ≥ 1 termo específico + disciplina compatível. Só vale depois de confirmada pelo aluno (ou de parecer positivo da IA, que devolve apenas um booleano por par conhecido).
- Palavras genéricas ("tratamento", "diagnóstico"…) são ignoradas. A decisão do aluno (confirmada/rejeitada) persiste entre replanejamentos.
- Integração reversível: na sessão compartilhada a teoria é feita uma vez; a outra tarefa mantém só questões/flashcards/erros (ou sai do plano ativo se sobrar apenas teoria). Rejeitar a associação restaura as tarefas originais.

## Priorização (heurística — não validada cientificamente)
Pontuação 0–100 = média ponderada de fatores 0–1. Pesos padrão (configuráveis em *Perfil e configurações*):

| Fator | Peso | Como é calculado |
|---|---|---|
| prova | 30 | proximidade da prova: faculdade até 45 dias; residência até 180 dias (×0,6) |
| desempenho | 20 | taxa de erro da matéria (exige ≥ 5 respostas; senão 0,5 neutro) |
| revisao | 15 | dias desde a última tarefa concluída do tema (30 dias = máximo; nunca feita = 0,6) |
| volume | 10 | participação da matéria no conteúdo pendente |
| conteudo | 10 | campo `peso` de `DISCS` (incidência aproximada em provas de residência) |
| sinergia | 10 | 1 se compartilhada |
| material | 5 | há aula/PDF/questões/flashcards do acervo |
| destaque | 5 | 1 se a tarefa veio da Aula do dia com "cai na prova" indicado pelo professor ou momento marcado com ⭐ |

Cada tarefa mostra a justificativa (até 3 fatores relevantes).

## Ações e replanejamento (`/acao`, `/replanejar`)
Concluir, reabrir, adiar, editar (campos permitidos: título, data, minutos, observações, trilha) e cancelar, todas registradas em `plano.historico`. Adiar escolhe o próximo dia com tempo livre antes da prova; se todos estiverem cheios, escolhe o menos sobrecarregado e avisa o excedente.
Replanejar preserva concluídas, canceladas, edições futuras e histórico; atrasadas viram `reagendada` (ficam registradas) e o conteúdo volta ao plano; tarefas canceladas não são recriadas. As rotas legadas `/api/planner/replan` e `/replan-imprevisto` (plano `planner-ia-plan`) permanecem inalteradas.

## Persistência
- Local: IndexedDB (`planner-v2-plan`, `planner-v2-chat`, `planner-v3-perfil`).
- Firebase (opcional): o `payload()` agora inclui `plv3`.
- Supabase: tabela `planner_estado` (rode o bloco 5 de `supabase-schema.sql`). `GET/PUT /api/planner/v3/estado`, isolado por `username`. Sem Supabase, a rota responde `offline` e o app segue só com o armazenamento local.
- O app guarda dados locais por aparelho (o logout não apaga o armazenamento local): em aparelho compartilhado, o isolamento entre usuários vale para a nuvem, não para o navegador.

## Origem das informações
Datas, provas e conteúdos = informados pelo aluno; aulas, PDFs e questões = acervo; textos marcados com ✨ = IA (podem errar). Os prompts proíbem inventar referências, diretrizes e fontes. A IA é apoio ao estudo, não substitui diretrizes nem fontes primárias.

## Cronogramas do acervo
O catálogo não tem cronogramas estruturados; tem PDFs de cronograma (Extensivo, turmas, reta final, MEDCURSO). A tela de Residência lista esses PDFs, extrai o texto e passa pela etapa de conferência. A leitura de PDFs em formato de tabela pode ser imperfeita.

## Testes
`npm test` (provedor e planejador, com Groq e Supabase simulados).

## Leitura formatada de documentos e JSON (21/10/2026)

O Mentor usa Markdown para apresentar mensagens e o conteúdo de objetos JSON. Os envelopes com `reply`, `markdown`, `content` ou `resposta` (string) exibem o campo textual. Objetos e listas de dados viram seções, listas ou tabelas. JSON incompleto continua legível como texto. O transporte da API permanece em JSON; o texto original da conversa é preservado.

Após carregar PDF/TXT/MD, a conversa oferece uma seção recolhível com o texto extraído e uma leitura organizada dos dados identificados. A importação acadêmica também mostra o texto e a leitura estruturada junto aos campos de conferência existentes. A confirmação do cronograma continua explícita. O extrator de PDF da rota manual usa a biblioteca já disponível na aplicação, dispensando o executável externo pdftotext.

Apresentação: títulos hierárquicos, ênfase, listas, citações, código e tabelas com rolagem horizontal e foco por teclado. Mantidos azul-marinho, turquesa e a tipografia do produto. Markdown-it com HTML desativado; resultado sanitizado pelo DOMPurify. Dependências servidas no mesmo domínio, com cópias estáticas no build da Vercel e rotas locais dedicadas. Falha de carregamento mantém texto escapado legível.

Formato de mensagem suportado, por exemplo:

```json
{"reply":"## Conteúdo da semana\n\n- **Clínica médica:** revisar os assuntos informados.\n- Conferir datas antes de confirmar."}
```

Validação: npm test e build aprovados; testes de JSON, tabelas, fallback, conteúdo extraído e regressões anteriores. Fluxo real local de upload verificado com PDF válido de teste da biblioteca pdf-parse; conteúdo e leitura exibidos na conversa. Sanitização conferida em navegador real contra script, imagem com evento e link javascript. Nenhum PDF foi enviado a uma conta de produção. Chamadas reais aos provedores de IA não foram necessárias para esse teste.

Prévia demonstrativa conferida visualmente em 1440, 768 e 390 px: 0 falhas e 0 avisos no inspetor. A diagramação, fontes e tabelas originais do PDF não são reconstruídas fielmente: a prévia apresenta o texto extraído; a extração estruturada organiza o que foi identificado. PDFs escaneados continuam exigindo texto selecionável/OCR externo. O extrator existente limita a leitura a cerca de 60 mil caracteres e sinaliza truncamento.

## Correção do manual e modelo Gemini padrão (21/10/2026)

O interpretador de datas define os meses utilizados pela leitura de manuais e aceita dias por extenso com ou sem a palavra dia. O teste de regressão cobre texto administrativo sem data numérica, que antes interrompia a leitura com MESES is not defined.

O modelo Gemini padrão passa a gemini-3.8-flash, validado com mensagem técnica fictícia na conta configurada localmente. A API recusou gemini-2.5-flash para novos usuários dessa conta. GEMINI_MODEL explícito no ambiente continua tendo prioridade: se a Vercel fixar o modelo anterior, é necessário atualizar essa variável no painel. O .env local não é enviado ao GitHub nem copiado para a produção.

## Vários modelos no OpenRouter (21/10/2026)

OPENROUTER_MODELS aceita uma lista de IDs separados por vírgulas, em ordem de prioridade. Quando preenchida, substitui OPENROUTER_MODEL. Itens vazios e repetidos são removidos. Uma lista vazia preserva o campo singular e seu padrão anterior. Um model explícito na chamada restringe aquela requisição ao modelo informado.

Exemplo validado no catálogo oficial:

```env
OPENROUTER_MODELS=nvidia/nemotron-3.5-super-vl:free,minimax/minimax-m3.1-flash:free,google/gemma-4-26b-a4b-it:free
```

A requisição usa o campo models do OpenRouter para o fallback nativo. O retorno registra o modelo que efetivamente respondeu; /api/health mostra os modelos configurados. As tentativas json_schema e json_object preservam a mesma lista. AI_ORDER continua controlando a ordem entre Groq, Gemini e OpenRouter.

Os modelos do exemplo estavam no catálogo como gratuitos e com suporte a respostas estruturadas na consulta desta rodada. Disponibilidade e limites podem mudar. A lista contém só opções :free; modelos pagos podem ser configurados explicitamente. Trocar modelos não reinicia cotas compartilhadas da conta.

Validação: testes simulados de prioridade, remoção de duplicados, seleção do modelo reserva, compatibilidade singular, modelo explícito, JSON e limite compartilhado. Uma chamada real com mensagem fictícia usando a lista foi atendida pelo Nemotron. Nenhum PDF foi usado no teste.

Para produção, preencher OPENROUTER_MODELS nas variáveis da Vercel e efetuar novo deploy. O .env local permanece fora do GitHub.

Referência: https://openrouter.ai/docs/guides/routing/model-fallbacks
