# Aula do dia — auditoria e fluxo-alvo

Arquivos: `aula-dia.js` (tela, gravação, pipeline), `src/aula.js` (rotas `/api/aula/*`), `src/questoes-aula.js` (questões por tema).
Este documento separa **o que foi medido ou lido no código** do **que é projeção**. Nenhuma IA real foi chamada nos testes.

## 1. Fluxo atual
1. Gravação no navegador em trechos de até 90 s (`MediaRecorder`, 32 kbps). O áudio fica no IndexedDB.
2. Cada trecho vai a `/api/aula/transcrever` (Whisper da Groq, com Gemini configurado como reserva).
3. Ao finalizar, `pipeline()` revisa a transcrição, gera o mapa e o plano pedagógico, extrai fatos e deriva o resumo e o material de revisão. As frentes independentes usam o teto global de concorrência configurado; capítulos preservam a ordem do mapa.
4. Flashcards ficam fora do pipeline padrão e só são gerados quando o estudante pede. Depois, ele pode conferir/editar os cartões e aprová-los para o Treino.
5. A sessão oferece personalização metodológica, tutor contextual com referências à transcrição e um painel de produção/objetivos autodeclarados. Resumo Geral, mapa mental, karaokê, ciclo de revisões e exportação em .md continuam sob demanda.

## 2. Diagnóstico

### 2.1 Custo: a transcrição é relida cerca de 7 vezes (lido no código)
| Etapa | Lê a transcrição | Saída |
|---|---|---|
| revisar | 1× | ≈ 1× (devolve o texto inteiro) |
| mapa | 1× | pequena |
| capítulos (soma) | ≈ 1× (+ 500 caracteres de sobra por capítulo) | longa (Crônicas) |
| fechamento | 1× | média |
| flashcards | 1× | média |
| processar (cai na prova) | 1× | média |
| Resumo Geral (opcional) | 1× | longa |
| mapa mental (opcional) | 1× | pequena |

Ordem de grandeza: **7 a 8 leituras + 3 a 4 de saída ≈ 10× o tamanho da aula**. Uma aula de 2 h tem ordem de 30 mil tokens (estimativa: ~9 mil palavras/h), ou seja, ~300 mil tokens por aula (estimativa, não medida).
Limites do plano gratuito da Groq lidos na documentação: `openai/gpt-oss-120b` com 8 mil tokens/min e **200 mil tokens/dia**; Whisper com 7,2 mil s de áudio/h e 28,8 mil s/dia. Só com a Groq, **uma aula já estoura a cota diária de texto**. O roteador (Gemini/OpenRouter) mitiga, mas a economia continua valendo.

### 2.2 Tempo
Tudo em série. Capítulos e revisão são independentes entre si e só esperavam um ao outro.

### 2.3 Falhas de robustez encontradas
- **Bug (corrigido):** a tela considerava "IA ativa" se existisse *qualquer* chave. O Whisper exige `GROQ_API_KEY`; com só Gemini/OpenRouter, todos os trechos de áudio falhavam sem aviso e a legenda ao vivo nem ligava. Agora `/api/aula/status` informa `transcricao` separado de `texto`.
- O campo `anterior` (final do trecho anterior) era enviado pelo front e **ignorado** pelo servidor. Corrigido: entra no prompt do Whisper (ver 3.1). O efeito na qualidade não foi medido.
- Corte fixo a cada 90 s pode partir uma frase ao meio. Não corrigido (fase 2).
- Dados só no aparelho (localStorage + IndexedDB): trocar de celular ou limpar o navegador perde as aulas.
- **Consumo de IA ao abrir uma videoaula:** `/api/questions/match` gera questões por IA quando o banco tem menos de 10 que casem com o tema (cache só em memória; na Vercel cada função nova perde o cache). Quem dispara é a pré-busca da contagem de questões ao abrir a aula, não o carregamento do app. Opções: usar `ia=0` na pré-busca e gerar só quando você clicar em praticar, ou guardar as questões geradas no banco. **Corrigido:** a pré-busca ao abrir a aula usa `ia=0` (só banco); a IA só entra ao clicar em praticar, se o banco tiver menos de 10 questões.

### 2.4 Rendimento de estudo (o que falta)
A aula produz resumo e material de revisão; o fluxo do botão **Fechar o ciclo** adiciona os cartões ao Treino e agenda revisões no Mentor. O painel Progresso registra a produção e objetivos marcados pelo aluno, sem declarar domínio automaticamente.

## 3. Fluxo-alvo

### Fase 1 — implementada
1. **Status honesto** (`transcricao`, `texto`, `paralelo`) e tela coerente: sem Whisper, usa legenda ao vivo, guarda o áudio para transcrever depois e ainda gera resumo a partir do texto.
2. **Whisper com continuidade:** prompt = contexto + glossário do plano + ponta do trecho anterior (≤ 700 caracteres, a ponta no fim).
3. **Pipeline com teto global:** revisão → mapa/plano → extração; em seguida capítulos, resumo e material independente podem rodar em paralelo. Flashcards entram somente após solicitação. O teto de chamadas simultâneas é `paralelo` (1 só com Groq, por causa do limite por minuto; 3 com Gemini/OpenRouter). Retomada por índice: capítulos já prontos não são refeitos.
Verificado: testes de servidor (status e prompt) e E2E no navegador contra IA **falsa** (`scripts/e2e/aula-pipeline.py`): ordem dos capítulos, retomada, concorrência ≤ 3 (e = 1 no modo só-Groq). Tempo real depende da IA; o ganho esperado é redução do tempo de espera, não medida.

### Fase 2 — implementada (parte): ler uma vez, derivar muitas
Novo `/api/aula/extrair` lê a aula por janelas e devolve uma **base** (fatos com tipo e capítulo, sínteses, termos, "cai na prova", dúvidas, assuntos cobertos). O pipeline chama a extração depois do mapa; `fechamento`, `flashcards` e `processar` aceitam `base` e **não releem a aula**:
- fechamento: montado sem IA (sínteses = Considerações Finais; fatos = Revisão Final);
- flashcards: a IA lê só os fatos extraídos;
- processar: 1 chamada (título, resumo, tópicos); termos, "cai na prova", dúvidas e assuntos vêm da base.
Se a extração falhar, o caminho antigo roda sem mudança. Leituras da aula: de ~7 para ~4 (revisar, mapa, extrair, capítulos). Verificado com testes de servidor e E2E com IA **falsa**. **Não medido:** fidelidade da extração com IA real (um fato omitido na base some do fechamento/cartões; os capítulos continuam lendo a aula inteira).
Também feito: botão **❓ Dúvida** na gravação (marca o ponto na transcrição, a revisão preserva a marca, e a extração registra "[mm:ss] assunto" em "Suas dúvidas na aula"). Também feito:
- **Corte no silêncio:** a partir de 65 s o trecho termina na primeira pausa de fala (≥ 0,5 s, nível bem abaixo do pico recente); 90 s continua sendo o limite. Verificado no Chromium com microfone falso (`scripts/e2e/aula-gravacao.py`: trecho fechado em ~64 s em vez de 90 s). Com fala contínua real o corte pode cair em 90 s; a eficácia com a voz de um professor não foi medida.
- **Transcrição de reserva pelo Gemini:** se a Groq não tem chave, está no limite (429) ou falha, o áudio vai ao Gemini. Primeiro o modelo dedicado `gemini-3.5-transcribe` (`GEMINI_STT_MODEL`; Files API + `/v1beta/interactions`, modo verbatim, pt-BR; a documentação lista `audio/webm` como suportado e a página de preços indica gratuito no plano free); se ele falhar por outro motivo que não limite, cai no `generateContent` com áudio inline; `GEMINI_STT_MODEL=off` pula o dedicado. Sem marcas de tempo por padrão (o karaokê não sincroniza essas linhas); `GEMINI_STT_TIMESTAMPS=1` pede tempo por palavra, que a Google avisa poder reduzir a precisão. `/api/aula/status` informa `transcricaoReserva`. **Testado só com o Gemini simulado, seguindo a documentação: o formato real dos campos (upload, `/interactions`, `word_info`) não foi validado com a API e a qualidade em português médico não foi medida.**
- **Fechar o ciclo conclui a "Prévia da aula"** pendente da mesma matéria no Mentor (a mais recente até hoje, preferindo a do mesmo tema), com registro no histórico.
Pendente: extrair durante a gravação.

### Fase 2 (original) — proposta: ler uma vez, derivar muitas
Hoje cada saída relê a aula. Proposta:
1. **Extração única por janela**, feita já *durante* a gravação (a cada ~5 min de texto): JSON com capítulos, fatos (número, conduta, critério, pegadinha, definição), termos, questões lidas, candidatos a flashcard e o que o professor marcou como "cai".
2. **Derivar da base**, sem reler a aula: mapa, fechamento, flashcards, "cai na prova", cobertura do plano, mapa mental. Só os **capítulos Crônicas** continuam lendo o trecho original (fidelidade).
3. **Revisão do texto fora do caminho crítico** (em segundo plano, só para exibição/karaokê).
Resultado esperado: de ~7 leituras para ~3 e a maior parte do trabalho pronta quando a aula termina. É projeção: precisa de medição com aula real e de checagem de fidelidade (nada pode ser omitido).
Também na fase 2: corte do trecho no silêncio (VAD simples com o analisador de áudio que já existe), transcrição de reserva por Gemini (áudio) quando a Groq estiver em limite, e botão ❓ "dúvida" durante a aula.

### Fase 3 — implementada (parte): fechar o ciclo
Na tela do resultado aparece o painel **🔁 Fechar o ciclo** (assim que os flashcards existem):
1. Os cartões da aula vão para o Treino (sem duplicar).
2. O Mentor ganha **3 revisões da aula**: 24 h (flashcards), 7 dias e 30 dias (questões) — os mesmos intervalos do motor do planejador. Ids por aula+intervalo (idempotente), nunca depois da prova da matéria, e marcadas `origem: "aula-dia"`.
3. **Replanejar não as perde:** o motor preserva essas tarefas; as vencidas e não feitas vêm para hoje (com o histórico em `adiadaDe`).
4. **Prioridade:** novo fator `destaque` (peso 5, configurável): sobe a prioridade da revisão quando o professor indicou que cai na prova ou você marcou ⭐.
5. Botão **Testar agora**: abre o simulado do Treino com as questões do tema (banco; pode gerar por IA se houver poucas, como já fazia ao abrir uma aula).
Verificado: testes do motor (preservação, vencidas, destaque) e E2E no navegador com IA falsa (revisões 24 h e 7 dias criadas, a de 30 dias cortada pela prova, idempotência, cartões no Treino, prioridade calculada). Não testado com dados reais.
Ainda proposto: marcar a tarefa "Prévia/Aula" do dia como concluída, atualizar a cobertura dos assuntos da prova, sincronizar as aulas pela nuvem e mostrar o consumo de tokens por aula.

### Fase 5 — tutor contextual, personalização contínua e transparência (implementada)
- **Metodologia editável na sessão:** tipo de aula, profundidade, perfil, objetivo, objetivos de aprendizagem e ênfase podem ser atualizados depois que a sessão começou. A alteração guarda o novo plano e preserva os materiais existentes; os botões de regeneração atualizam o material escolhido.
- **Tutor IA contextual:** a aba Tutor envia a pergunta, o histórico recente, o plano, o resumo/base e até quatro janelas lexicais relevantes da transcrição para `/api/aula/tutor`. Respostas podem citar `[T1]`–`[T4]`; a interface revela o trecho e seus offsets. A conversa fica na sessão local e não é salva em nuvem.
- **Progresso sem falsa medida de domínio:** a aba Progresso distingue transcrição, resumo, verificação, cartões, mapa e revisões. Objetivos de aprendizagem podem ser marcados como revisados pelo estudante. Essas marcas são autodeclarações e não equivalem a compreensão demonstrada.
- **Flashcards sob demanda:** o pipeline não chama a rota de cartões sem solicitação explícita; a aba mostra um botão de geração e uma sessão pode ser considerada pronta sem flashcards. Após a geração, a interface mantém o estudante na aba dos cartões.
- **Acessibilidade responsiva:** abas nomeadas, estado selecionado, painel navegável, foco visível, controles maiores em telas pequenas e redução de movimento respeitada.

Verificação automatizada: teste de rota no `scripts/tests/aula-source-coverage.test.mjs` usa IA simulada para validar contexto, histórico, trechos citados e rejeição sem fonte. A tela continua sem autenticação adicional própria: ela depende do middleware autenticado comum às rotas `/api`.

### Fase 4 — qualidade verificável, edição e versões (implementada)
Motivo (lido no código): os materiais eram publicados sem conferência; não havia como editar cartões ou a transcrição, nem regenerar um material sem perder o anterior.
- **Verificação sem IA** (`src/aula-qualidade.js`, `POST /api/aula/qualidade`, aba **🔎 Qualidade**, roda ao fim do pipeline): (1) números com unidade (dose, tempo, %, mmHg…) do resumo/cartões que **não aparecem na transcrição** → "conferir"; (2) **cobertura** dos fatos extraídos da aula no resumo e nos cartões, listando o que falta; (3) cartões **duplicados**, com frente sem contexto, verso longo/lista longa (não atômicos) ou número fora da fonte.
- **Edição antes de usar:** editar/remover cartões, remover duplicatas, editar a transcrição (o original `texto` nunca é sobrescrito; `textoRevisado` guarda a versão corrigida; "Ver original").
- **Regenerar um material só** (cartões ou resumo) mantendo os demais; a versão anterior fica em "Versões anteriores" (últimas 3) com **Restaurar**; remover/editar cartões também guarda versão.
- **Avaliação de transcrição:** `node scripts/avaliacao/transcricao.mjs referencia.txt hipotese.txt` calcula WER, CER e números/doses da referência ausentes na hipótese. Precisa de amostras reais com referência humana: **nenhuma foi medida ainda**.
Limites honestos: a verificação é lexical (não entende sinônimos: "um grama" ≠ "1 g" gera alerta; um erro clínico escrito sem número não é detectado); mede fidelidade ao que foi dito, não correção médica; cobertura depende da base extraída (se a extração omitir um fato, a cobertura não o enxerga). Testes: `scripts/tests/aula-qualidade.test.mjs` (unitário) e E2E (`aula-pipeline.py`) com IA falsa.
**Resumo pedagógico (único formato; o antigo "Crônicas de Residência" foi removido a pedido do aluno — resumos já salvos continuam legíveis):** cada capítulo segue Conceito central → Fundamentos → Mecanismo explicado (Causa → Mecanismo → Alteração → Manifestação → Consequência) → Aplicação clínica → Esquema → Pontos para a prova → Revisão final, com as regras de fidelidade do prompt de auditoria (nada de diretrizes/estatísticas inventadas; conhecimento externo só em bloco "📎 Complemento (não dito na aula)"). **Não medido:** se a IA real segue a estrutura e respeita a fidelidade; o teste automático só confere o que vai no prompt.
Pendente do prompt de auditoria: classificação de cartões por dificuldade, validação clínica por IA independente, JSON estruturado do mapa mental com relações tipadas, histórico/versão da transcrição, avaliação com aulas reais.

## 4. Motor pedagógico universal (complemento arquitetural implementado)

O escopo funcional descrito nas fases anteriores continua sendo a base da Aula do Dia. A adaptação por disciplina agora usa um único motor compartilhado (`src/aula-pedagogia.js`), aplicado às etapas de mapa, capítulos, extração, flashcards, fechamento, material de revisão, Resumo Geral e mapa mental.

- O núcleo comum preserva fidelidade à fonte, objetivos, relações conceituais, incertezas e cobertura, sem impor uma estrutura clínica a aulas de fundamentos.
- O motor combina até três perfis pedagógicos. Há inferência pelo conteúdo e sugestões produzidas na chamada de mapeamento; o estudante também pode fixar um perfil principal. Os perfis disponíveis são registros de orientação combináveis, não prompts independentes por especialidade.
- Cada aula pode guardar objetivo de estudo, objetivos de aprendizagem, ênfase e profundidade. Essas escolhas são salvas na sessão e encaminhadas às saídas. O plano inclui capítulos, pontos de cobertura e offsets da transcrição quando disponíveis.
- A transcrição e sua revisão usam modo de fidelidade e não sofrem redução de tamanho. A estrutura de cada saída continua definida pela tarefa (por exemplo, formato de flashcards ou árvore do mapa mental), enquanto a orientação pedagógica vem do mesmo plano.
- A rota sem IA `POST /api/aula/plano` reconstrói o plano para sessões antigas. `/api/aula/mapa` devolve mapa e plano em conjunto, incorporando as sugestões extraídas durante o inventário.

Verificação automática: `scripts/tests/aula-pedagogia.test.mjs` cobre inferência e combinação de perfis, override manual, personalização, profundidade, objetivos e referências; `scripts/tests/aula-source-coverage.test.mjs` verifica a propagação do plano nas rotas com IA simulada. A inferência serve à organização pedagógica e não valida conteúdo clínico.

## 5. Riscos e não verificado
- Nenhuma chamada real à Groq, ao Gemini ou ao OpenRouter foi feita; os E2E usam uma IA falsa.
- Qualidade da transcrição com o prompt de continuidade: não medida.
- Paralelismo com o Gemini grátis: o limite por minuto dele não foi testado.
- Os números de tokens por aula são estimativas de ordem de grandeza.
