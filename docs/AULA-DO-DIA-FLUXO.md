# Aula do dia — auditoria e fluxo-alvo

Arquivos: `aula-dia.js` (tela, gravação, pipeline), `src/aula.js` (rotas `/api/aula/*`), `src/questoes-aula.js` (questões por tema).
Este documento separa **o que foi medido ou lido no código** do **que é projeção**. Nenhuma IA real foi chamada nos testes.

## 1. Fluxo atual
1. Gravação no navegador em trechos de 90 s (`MediaRecorder`, 32 kbps). O áudio fica no IndexedDB.
2. Cada trecho vai a `/api/aula/transcrever` (Whisper da Groq, com marcas de tempo para o karaokê).
3. Ao finalizar, `pipeline()` roda **em série**: revisão da transcrição (blocos de 9 mil caracteres) → mapa de capítulos → capítulos "Crônicas" (um por chamada) → fechamento → flashcards → "cai na prova"/assuntos do plano.
4. Extras sob demanda: Resumo Geral, mapa mental, karaokê, exportação em .md (inclui NotebookLM).

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
- O app dispara geração de questões por IA ao abrir (observado nos testes: 4 chamadas ao carregar a página). Isso consome cota que a aula precisa. Não investigado a fundo.

### 2.4 Rendimento de estudo (o que falta)
A aula termina em material (resumo, cartões), mas **não fecha o ciclo**: não testa o aluno, não agenda revisões no Mentor, não alimenta a priorização. O resultado é conteúdo bem feito que precisa de disciplina manual para virar retenção.

## 3. Fluxo-alvo

### Fase 1 — implementada
1. **Status honesto** (`transcricao`, `texto`, `paralelo`) e tela coerente: sem Whisper, usa legenda ao vivo, guarda o áudio para transcrever depois e ainda gera resumo a partir do texto.
2. **Whisper com continuidade:** prompt = contexto + glossário do plano + ponta do trecho anterior (≤ 700 caracteres, a ponta no fim).
3. **Pipeline paralelo com teto global:** revisão e capítulos em paralelo; mapa primeiro; depois resumo ∥ flashcards ∥ "cai na prova". Teto de chamadas simultâneas = `paralelo` (1 só com Groq, por causa do limite por minuto; 3 com Gemini/OpenRouter). Retomada por índice: capítulos já prontos não são refeitos.
Verificado: testes de servidor (status e prompt) e E2E no navegador contra IA **falsa** (`scripts/e2e/aula-pipeline.py`): ordem dos capítulos, retomada, concorrência ≤ 3 (e = 1 no modo só-Groq). Tempo real depende da IA; o ganho esperado é redução do tempo de espera, não medida.

### Fase 2 — proposta: ler uma vez, derivar muitas
Hoje cada saída relê a aula. Proposta:
1. **Extração única por janela**, feita já *durante* a gravação (a cada ~5 min de texto): JSON com capítulos, fatos (número, conduta, critério, pegadinha, definição), termos, questões lidas, candidatos a flashcard e o que o professor marcou como "cai".
2. **Derivar da base**, sem reler a aula: mapa, fechamento, flashcards, "cai na prova", cobertura do plano, mapa mental. Só os **capítulos Crônicas** continuam lendo o trecho original (fidelidade).
3. **Revisão do texto fora do caminho crítico** (em segundo plano, só para exibição/karaokê).
Resultado esperado: de ~7 leituras para ~3 e a maior parte do trabalho pronta quando a aula termina. É projeção: precisa de medição com aula real e de checagem de fidelidade (nada pode ser omitido).
Também na fase 2: corte do trecho no silêncio (VAD simples com o analisador de áudio que já existe), transcrição de reserva por Gemini (áudio) quando a Groq estiver em limite, e botão ❓ "dúvida" durante a aula.

### Fase 3 — proposta: fechar o ciclo de aprendizado
Ao terminar a aula:
1. **Teste imediato** (5–8 questões do banco por tema via `/api/questions/match`): recuperação ativa em vez de só reler.
2. **Revisões espaçadas no Mentor:** criar tarefas de revisão (D+1, D+3, D+7, D+14) pelo mesmo mecanismo de `agendarRevisoes` do planejador, em vez de só mandar flashcards para o Treino.
3. **Planejador:** marcar a tarefa "Aula/Prévia" do dia como feita, atualizar a cobertura dos assuntos da prova e dar peso extra ao que o professor marcou como "cai" ou o aluno marcou com ⭐ (fator da priorização).
4. **Sincronização** das aulas pela nuvem (Supabase), com o áudio opcional.
5. **Indicador de consumo** por aula (tokens usados via `usage`) para controlar as cotas.

## 4. Riscos e não verificado
- Nenhuma chamada real à Groq, ao Gemini ou ao OpenRouter foi feita; os E2E usam uma IA falsa.
- Qualidade da transcrição com o prompt de continuidade: não medida.
- Paralelismo com o Gemini grátis: o limite por minuto dele não foi testado.
- Os números de tokens por aula são estimativas de ordem de grandeza.
