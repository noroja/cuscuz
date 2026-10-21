# Mentor IA acadêmico (Faculdade + Residência)

Evolução da área de planejamento existente (`planner-v2.js` + `src/planner-engine.js`). Não é um app separado.

## Provedor de IA
Groq (API compatível com OpenAI) por `src/ai-provider.js`. Variáveis: `GROQ_API_KEY`, `GROQ_MODEL` (padrão `openai/gpt-oss-120b`), `GROQ_STT_MODEL` (`whisper-large-v3-turbo`), `GROQ_TIMEOUT_MS`, `GROQ_MAX_RETRIES`, `GROQ_BASE_URL`, `AI_PROVIDER`.
Sem a chave o app funciona com o motor determinístico; só o que depende de IA retorna mensagem clara. O `main` agora tem um provedor híbrido (commit 21712fe): com `AI_PROVIDER=auto` e as duas chaves, há roteamento e fallback mútuo Groq↔Gemini; `AI_PROVIDER=groq` ou `gemini` fixa um só. Veja os comentários no topo de `src/ai-provider.js`.
O OpenRouter (`OPENROUTER_API_KEY`, padrão Nemotron `nvidia/nemotron-3.5-super-vl:free`) é um 3º provedor: no modo `auto` é o último recurso; com `AI_PROVIDER=openrouter` é o único. Atenção: modelos `:free` têm cota diária baixa e, conforme a política do provedor, podem registrar prompts; a transcrição de áudio continua exigindo `GROQ_API_KEY`.

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
