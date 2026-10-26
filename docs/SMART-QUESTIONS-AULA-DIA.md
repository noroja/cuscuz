# Smart Questions e workspace da Aula do Dia

## Auditoria do estado anterior

| Área | Evidência encontrada | Estado antes da mudança |
|---|---|---|
| Associação aula–questão | `src/questoes-aula.js` pontuava tokens do título e módulo, sinônimos manuais e especialidade. A busca não organizava os resultados por objetivos da aula. | Correspondência lexical; cobertura curricular explícita ausente. |
| Banco de questões | `data/questions-bank.json` contém 953 questões locais com enunciado, alternativas, gabarito, comentário, dificuldade, especialidade, tags, ano e fonte. O servidor também mantém a integração já existente com o acervo remoto. | Registros sem IDs curriculares canônicos nem embeddings de questão. |
| Índice de videoaulas | O ISC existente persiste tópicos/evidências em `isc_resources`, `isc_resource_topics` e `isc_segments`, com controle de acesso no servidor. | Conteúdo indexado e metadados do catálogo são estados diferentes; metadados, por si só, não provam cobertura do vídeo. |
| Histórico de respostas | A interface mantém `cuscuz_exam_answers` no armazenamento do navegador e as respostas do simulado eram usadas para desempenho geral. | A conclusão do simulado de aula não atualizava consistentemente o histórico consumido pelos filtros “não respondidas” e “reforço”. |
| Aula do Dia | `aula-dia.js` concentrava preparação, configurações, gravação, materiais, ferramentas de estudo e índice em uma página longa. Havia gravação, upload, transcrição, resumo, flashcards, tutor, mapa mental e integração ISC funcionais. | Recursos presentes, mas hierarquia e descoberta dos próximos passos eram fracas; a lista de aulas não tinha busca. |

## Implementado

### Seleção de questões

- O índice lexical da questão agora inclui as alternativas, além de enunciado, comentário e metadados.
- `POST /api/questions/match` oferece seleção curricular determinística sem chamar modelos pagos nem o acervo remoto. A rota `GET` existente continua disponível com seu comportamento legado.
- O candidato é relacionado ao objetivo usando frase canônica, sinônimos completos e termos específicos do nome do tópico. Um token genérico isolado não basta para criar relação parcial.
- A seleção remove duplicatas exatas de enunciado, questões sem gabarito válido, itens já respondidos quando solicitado e itens fora da dificuldade selecionada.
- Uma seleção gulosa prioriza objetivos ainda não cobertos, penaliza redundância e usa erros anteriores para reforço. Se não houver itens suficientemente relevantes, o conjunto pode ter menos questões que o limite solicitado.
- A resposta inclui uma matriz objetivo–questão, níveis `direct`, `partial` e `uncovered`, contagens elegíveis e limitações. Cobertura ponderada e cognitiva ficam `null` até que existam pesos e classificações revisados.
- O índice persistente usa `isc_question_index` e `isc_question_index_state`, com hash do conteúdo e da taxonomia, versão do indexador, IDs canônicos candidatos, trechos de evidência, estado e busca textual em português indexada por GIN. A migração adicional `isc_question_embeddings` permite vetores por questão (1024 dimensões), vinculados ao hash do texto e ao modelo. A consulta só usa o índice quando hash e contagem confirmam uma indexação completa; sem vetores, preserva a busca textual e os tópicos.
- `npm run index:questions` prepara uma prévia local sem rede nem custo de embeddings. A aplicação requer `--apply`, credenciais `service_role` no servidor e `--target-ref=qbfcfxfzvahiuqvbflzf`; o script rejeita URLs de outros projetos, incluindo produção. Gerar vetores é uma opção separada (`--apply --embed --target-ref=qbfcfxfzvahiuqvbflzf`) e envia texto das questões ao provedor já configurado no projeto; pode consumir cota ou ter custo do provedor. A prévia `--embed` só estima o lote.
- A busca vetorial em execução exige `ISC_QUESTION_EMBEDDINGS_ENABLED=1` e um provedor de embeddings configurado (`GEMINI_API_KEY`, `COHERE_API_KEY` ou `HF_TOKEN`). Ela gera e mantém um embedding de consulta em cache por usuário/modelo/texto; falhas voltam para a consulta lexical e tópica. O recurso permanece desligado por padrão.
- Nesta versão, a classificação por IDs usa frases/sinônimos da taxonomia curada e é marcada `heuristic_unreviewed`; não gera vetor nem afirma que uma menção no enunciado seja o objetivo efetivamente avaliado.
- `GET /api/isc/video-index?id=...` exige sessão, recupera os tópicos da videoaula e suas evidências do ISC e mantém confidências/timestamps ausentes como `null`.
- A interface do acervo expõe quantidade, modo, dificuldade, exclusão de respondidas e inclusão de complementares. Ela distingue resultados apoiados por conteúdo indexado de estimativas baseadas em título/pasta.
- Ao finalizar o simulado, as respostas são persistidas no histórico local já usado pelo banco de questões. O diagnóstico por tópico sinaliza amostra insuficiente e não declara domínio clínico.
- A referência de origem da questão usa timestamp somente quando o ISC fornece um valor verificável.

### Redesign da Aula do Dia

- A preparação agora destaca gravar, enviar áudio e selecionar slides; disciplina, conteúdo e identificação da parte ficam visíveis e as preferências pedagógicas permanecem na área expansível.
- A seleção de PDF/PPTX aceita até 18 MB, fica pendente localmente e exige confirmação no índice da aula antes de envio/indexação.
- A gravação mantém cronômetro, nível de captação, estado do microfone, fila de trechos e limite real de gravação em segundo plano indicado ao usuário.
- A área de resultado organiza os recursos em **Materiais**, **Índice curricular**, **Comparar aulas** e **Estudar**. Ações de exportação/regeneração e preferências ficam recolhidas; o trilho lateral resume status, materiais e fontes indexadas.
- O histórico de aulas recebeu busca por disciplina, conteúdo, parte e data.
- As novas áreas reutilizam rotas e funções existentes. Nenhum resultado de índice, comparação ou transcrição é simulado.
- O botão de prática de questões usa o turquesa da marca com texto de alto contraste, tamanho mínimo de toque e foco visível.

## Evidência dos testes

Foram adicionados testes para classificação e hash da taxonomia, indexação incremental, recuperação persistida e os 953 registros locais; seleção e cobertura lexical, filtros, duplicatas, ausência de gabarito ou banco de questões; autenticação da rota de índice do vídeo; preservação de `null` em confiança/timestamp; e controles/responsividade da interface. Esses testes foram incluídos no comando `npm test`.

A migração `isc_question_index` foi aplicada somente no projeto Supabase de staging. O staging recebeu 953 registros; uma consulta real por “síndrome coronariana aguda” retornou três IDs com evidências de origem. Isso valida a infraestrutura e a recuperação híbrida, não a precisão pedagógica.

Os testes automatizados verificam a lógica sobre exemplos controlados; eles **não** medem precisão/recall pedagógicos sobre pares de questões e videoaulas avaliados por professores. Nenhuma melhora de precisão clínica ou semântica é afirmada.

## Limitações e próximos passos

1. A busca semântica vetorial foi implementada como opção, mas ainda não há vetores gerados no staging: a taxonomia curada atual associou 31 dos 953 registros a um ID na prévia; os demais continuam pesquisáveis por texto, mas não estão classificados curricularmente. A qualidade curricular das sugestões não foi validada por docentes.
2. Não existe conjunto aula–questão revisado por docentes. Precisão/recall, dificuldade calibrada e classificação cognitiva ainda não foram medidas. Cobertura ponderada e cognitiva não são calculadas.
3. O índice de vídeo só fornece evidência de conteúdo quando a videoaula já possui segmentos/tópicos não derivados apenas do catálogo. Se não houver, o sistema mostra essa limitação e usa metadados como pista de busca.
4. O histórico de resposta é local ao navegador, conforme o armazenamento existente; não foi criada uma tabela nova no Supabase nem um histórico entre dispositivos.
5. Os slides escolhidos antes da criação da aula ficam na memória da página até serem confirmados para indexação. Navegar para fora ou recarregar antes da confirmação exige selecioná-los novamente.
6. O conjunto de referência aula–questão revisado por docentes, a avaliação médica de questões e as métricas de precisão/recall permanecem pendentes.

## Fontes de implementação

- Motor: `src/questoes-aula.js` e `server.js`.
- Evidência do vídeo: `src/isc-routes.js`.
- Interface de questões: `index.html` e `css/cuscuz-brand.css`.
- Workspace da aula: `aula-dia.js`.
- Testes: `scripts/tests/smart-questions-selection.test.mjs`, `scripts/tests/isc-video-index.test.mjs` e `scripts/tests/aula-day-workspace.test.mjs`.
