# Auditoria e melhorias — Aula do Dia

Data: 2026-10-23  
Revisão do repositório iniciada em `ceab4458ce35d1e3a9abbedd88750b3b4d6d97a5`.  
Escopo: servidor, prompts, gravação/importação de áudio, materiais de estudo, armazenamento e testes. Testes de processamento usaram conteúdo sintético e provedores simulados; nenhum áudio ou documento pessoal foi enviado a uma IA externa.

## Diagnóstico inicial

O projeto já continha transcrição em trechos na gravação, revisão editável, histórico de versões, uma base intermediária de fatos, verificações determinísticas sem IA e métricas WER/CER implementadas como funções de avaliação. Essas partes foram preservadas. A implementação existente não tinha envio de arquivo de áudio pela tela.

| Critério | Funcionalidade inicial | Qualidade inicial | Problemas comprovados no código | Prioridade inicial |
|---|---|---:|---|---|
| Transcrição | Parcial | 6/10 | Sem envio de arquivo; estados de falha pouco informativos; ausência de dados humanos para validar WER/CER e erros médicos críticos. | Alta |
| Resumo e capítulos | Parcial | 5/10 | A divisão e seleção de fonte podia deixar conteúdo de fora; respostas vazias podiam ser aceitas como materiais concluídos. | Crítica |
| Flashcards | Parcial | 5/10 | Havia teto artificial de geração, validação limitada e origem insuficiente quando derivados da base de fatos. | Alta |
| Mapa mental | Parcial | 4/10 | Não cobria corretamente todas as janelas e não possuía uma representação intermediária com relações e origem. | Alta |
| Integração e persistência | Parcial | 5/10 | Falhas em etapas podiam deixar estado ambíguo; não havia uma experiência de importação e acompanhamento do áudio. | Alta |

As notas medem robustez estrutural observável, não precisão clínica. A auditoria inicial anterior está em `outputs/auditoria-aula-dia-inicial.md`.

## Melhorias implementadas

- **Cobertura da fonte:** as janelas de texto agora são contíguas, preservam offsets e podem reconstruir a transcrição integralmente. O mapa de tópicos envia o texto de cada janela ao modelo, não só instruções sobre ela. A consolidação só substitui os fragmentos quando limites e cobertura permanecem válidos; removi o corte fixo de 14 capítulos.
- **Falhas explícitas:** mapa sem capítulos, resumo ou capítulo vazio, fechamento sem síntese e mapa mental sem estrutura válida retornam erro. O frontend preserva o que já foi concluído e permite retomar o pipeline.
- **Base reutilizável e origem:** fatos extraídos recebem offsets da janela correspondente na transcrição. Flashcards gerados a partir dessa base usam esses offsets; bases antigas sem origem ficam marcadas como `base`, sem fingir que apontam ao áudio.
- **Flashcards:** geração percorre todas as janelas, não tem teto fixo de 100, ajusta a densidade à preferência de material, valida dificuldade e mantém edição, remoção e envio ao Treino já existentes. O handler agora aceita os dois nomes usados pelos botões de regeneração (`flash` e `flashcards`).
- **Mapa mental:** o formato em árvore existente continua disponível ao renderizador. A API também devolve JSON versionado com IDs únicos, nós hierárquicos, relações `hierarquia` e offsets de origem por trecho.
- **Preferências de estudo:** a tela oferece aula expositiva, discussão de caso, revisão para prova e aula prática/procedimento; e material enxuto, equilibrado ou detalhado. As escolhas ficam salvas no navegador. O tamanho ajusta os materiais, sem alterar a transcrição nem permitir omissão de valores, exceções ou ressalvas.
- **Importação de áudio:** envio de MP3, M4A, WAV, OGG, WebM e FLAC, com detecção de duração, metadados visíveis, cópia no IndexedDB antes da transcrição, retry e mensagem de erro. Preferências da aula seguem para o pipeline; a duração real aparece no histórico e no resultado.
- **Aulas longas e Vercel:** arquivos de até 3 MiB usam o endpoint normal. Arquivos maiores recebem uma URL assinada e vão do navegador diretamente ao bucket privado `aula-audio` no Supabase, sem passar pelo limite de 4,5 MB da Vercel. O bucket é criado/ajustado para 50 MB; o servidor baixa o objeto para transcrever e o remove ao terminar. A cópia local continua disponível para retry.
- **Roteamento de transcrição:** o limite padrão da Groq é 25 MB por arquivo, com opção documentada `GROQ_STT_MAX_FILE_BYTES` até 100 MB para contas que tenham esse tier. Acima do limite configurado, o fluxo usa o Gemini `gemini-3.5-transcribe`, quando disponível. Cada arquivo pode ter até 60 minutos; para gravações acima de 30 minutos o pedido não inclui timestamps, pois esse recurso reduz o teto do Gemini para 30 minutos. Para 1 hora, MP3 mono a 64–96 kbps costuma ficar entre 28,8 e 43,2 MB; WAV PCM mono 16 kHz/16 bits fica em cerca de 115,2 MB e excede o limite de 50 MB.
- **Limites e confiança:** o navegador informa o limite efetivo, exige Gemini para arquivos acima do teto Groq e não tenta decodificar/converter automaticamente áudios longos para WAV, evitando pico de memória. Segmentos Groq com baixa confiança recebem sinalização heurística para revisão humana; isso não equivale a precisão clínica.

## Avaliação após as alterações

| Critério | Estado atual | Nota estrutural | Evidência e pendência principal |
|---|---|---:|---|
| Transcrição | Parcial | 7/10 | Upload direto até 50 MB/60 min, gravação segmentada, timestamps Groq, edição e retry. WER/CER e erros críticos ainda não foram medidos em aulas com referência humana; arquivos acima de 60 min não são segmentados automaticamente. |
| Resumo | Parcial | 7/10 | Todas as janelas chegam ao processamento e respostas vazias falham explicitamente. Ainda falta avaliação pedagógica humana e validação clínica. |
| Flashcards | Parcial | 7/10 | Sem teto artificial, dificuldade validada, edição e origem por janela. Duplicidade semântica e rastreio até sentença específica não estão garantidos. |
| Mapa mental | Parcial | 7/10 | JSON com IDs, hierarquia e origem, mantendo compatibilidade com a árvore atual. Relações fisiopatológicas ainda não são tipadas como causa, mecanismo ou consequência; o frontend ainda usa a árvore. |
| Integração e armazenamento | Parcial | 7/10 | Extração reutilizada e materiais parciais preservados para retomar. Histórico versiona resumo/cartões, mas não todos os artefatos como um conjunto versionado. |

## Testes e comparação antes/depois

- `npm test`: **passou**, incluindo testes de provedores simulados, qualidade, Aula do Dia, cobertura de fonte, fluxo de IA, regressões do console e testes Node.
- `npm run build`: **passou**, copiando 13 itens para `public/`.
- `node --check` nos arquivos JavaScript alterados e `git diff --check`: **passaram**.
- Testes sintéticos longos confirmam mais de 14 janelas, texto integral incluído nos prompts, offsets sem lacunas/sobreposição e reconstrução exata da transcrição. Capítulos, extração, resumo, flashcards e mapa mental preservam a última janela.
- Teste de upload longo usa um arquivo binário sintético de 4 MiB, Supabase e Gemini simulados em loopback; confirma URL assinada, roteamento ao modelo dedicado sem timestamps para 60 min e remoção do arquivo temporário. Nenhum áudio real foi enviado.
- Testes induzem capítulos, resumo, fechamento e mapa mental incompletos e confirmam que a API não os publica como completos.
- A regressão de regeneração confirma ambos os aliases dos cartões no frontend.

Não há comparativo real de WER, CER, taxa de erros médicos, qualidade clínica, latência ou custo. As funções WER/CER e de erros críticos existem e têm testes unitários, mas não há amostra de áudio com transcrição de referência humana neste trabalho. A suíte sintética prova cobertura de código e tratamento de falhas, não acurácia médica.

## Arquivos alterados

- `aula-dia.js` — envio de áudio, preferências, duração/tamanho, estados e erros, retry, confiança de segmentos e aliases de regeneração.
- `src/aula.js` — segmentação integral, prompts, cobertura, origem dos fatos/cartões, validação de respostas e JSON do mapa mental.
- `src/ai-provider.js` — preservação dos metadados de confiança, suporte a Buffer binário e seleção explícita do Gemini para áudio longo.
- `server.js` — injeta o cliente Supabase com privilégio de servidor nas rotas da Aula do Dia.
- `.env.example` — documenta o limite de arquivo da Groq e a configuração opcional do tier dev.
- `package.json` — inclusão do teste de cobertura no comando `npm test`.
- `scripts/tests/aula-source-coverage.test.mjs` — teste sintético de cobertura e origem.
- `scripts/tests/aula-dia.test.mjs`, `scripts/tests/ai-provider.test.mjs` e `scripts/tests/console-regressions.test.mjs` — regressões de prompts, metadados e interface.
- `outputs/auditoria-aula-dia-inicial.md` — diagnóstico inicial já existente; `outputs/relatorio-auditoria-aula-dia.md` — relatório desta execução.

## Pendências e prioridades

1. **Avaliação com material autorizado:** montar um conjunto de áudios e transcrições de referência revisadas por humanos; medir WER/CER e erros críticos por modelo, incluindo termos, doses e unidades.
2. **Áudio longo:** gravação ao vivo divide automaticamente em trechos de cerca de 90 segundos; arquivos importados são processados como uma unidade até 60 min/50 MB. O limite global do projeto Supabase precisa permitir 50 MB (o plano Free limita esse valor a 50 MB); acima disso, reduzir o bitrate ou usar uma configuração compatível. Arquivos com mais de 60 min ainda precisam ser divididos manualmente; segmentação automática com sobreposição e união sem duplicações continua pendente. Um arquivo temporário pode permanecer no bucket se o navegador for fechado depois do upload e antes de chamar a transcrição; uma limpeza agendada para esse caso ainda não foi adicionada.
3. **Rastreabilidade fina:** flashcards derivados da base apontam à janela original, não ao timestamp ou frase exata. Isso exige timestamps alinhados e preservados pela extração.
4. **Validação médica e custos:** notas automáticas continuam sendo triagem; revisar com professor, testar os casos clínicos e registrar latência/tokens por etapa antes de afirmar qualidade ou economia.
5. **Mapa semântico:** o JSON atual descreve hierarquia e origem por janela; adicionar relações causais tipadas requer mudanças no prompt, schema, validador e visualização, com casos médicos de referência.

O envio de áudio não foi testado com um arquivo real nem com chaves do ambiente; a integração com o bucket Supabase real depende da configuração de `SUPABASE_SERVICE_ROLE_KEY` e do limite global de Storage. Nenhuma implantação ou publicação foi feita nesta etapa.

## Referências de limites

- Groq Speech to Text: https://console.groq.com/docs/speech-to-text
- Limites de Vercel Functions: https://vercel.com/docs/functions/limitations
- Gemini Audio transcription: https://ai.google.dev/gemini-api/docs/transcribe?hl=en
- Gemini Files API: https://ai.google.dev/gemini-api/docs/files?hl=en
- Supabase Storage file limits: https://supabase.com/docs/guides/storage/uploads/file-limits

## Addendum — qualidade e fluxo dos flashcards (2026-10-23)

### Diagnóstico comprovado

- A geração já tinha prévia, edição, remoção, versões anteriores, envio manual ao Treino e metadados de origem.
- O prompt, porém, tratava toda aula como revisão para residência e estimava o volume apenas pelo tamanho do texto. Os formatos não eram identificados no material; a validação não apresentava dimensões de qualidade nem levava o aluno ao trecho que originou o cartão.
- A checagem já era determinística. Ela identificava frases curtas, respostas longas, números ausentes e duplicatas prováveis, mas não verificava correção clínica. Isso permanece verdadeiro.

### Mudanças implementadas

- O foco pedagógico agora acompanha o tipo de aula: expositiva, caso clínico, revisão para prova ou prática. Conteúdo básico não recebe conduta clínica artificial; recomendações e frequências de prova não são completadas sem apoio na fonte.
- O volume estimado usa a quantidade de fatos extraídos quando disponível, ou palavras como aproximação quando não há base; a preferência enxuta/equilibrada/detalhada ajusta essa estimativa. O prompt diz explicitamente que ela não é cota.
- Cada cartão pode registrar formato (pergunta, mecanismo, comparativo, sequência ou vinheta) e dificuldade. Os dados de formato seguem para o Treino junto da origem já existente.
- A tela expõe cinco notas heurísticas de 0 a 10: contexto da pergunta, concisão, números encontrados na aula, duplicação provável e origem registrada. Continua sem uma nota de verdade clínica; um aviso deixa essa limitação explícita.
- Valores numéricos/unidades, doses, medicamentos, critérios, condutas e vinhetas clínicas recebem sinal para revisão humana. Números que não aparecem na aula e referências de origem inválidas aparecem como alertas; esses sinais pedem conferência e não provam erro.
- O aluno pode abrir o trecho usado na geração, editar ou remover cartões e confirmar antes do envio ao Treino. A confirmação também ocorre ao fechar o ciclo, que pode publicar os cartões e criar revisões.

Arquivos desta etapa: `src/aula.js` (prompt, volume estimado e metadados), `src/aula-qualidade.js` (dimensões e sinais de revisão), `aula-dia.js` (prévia, origem e confirmação), `package.json` e `scripts/tests/aula-flashcards-unit.test.mjs`, `scripts/tests/aula-qualidade.test.mjs`, `scripts/tests/aula-dia.test.mjs` e `scripts/tests/console-regressions.test.mjs`.

### Verificação desta etapa

- Passaram `node scripts/tests/aula-flashcards-unit.test.mjs`, `node scripts/tests/aula-qualidade.test.mjs`, `node scripts/tests/console-regressions.test.mjs`, `node --check` dos arquivos JavaScript alterados, validação JSON de `package.json`, `git diff --check` e `npm run build`.
- O novo teste direto cobre adaptação do prompt, normalização de formato/dificuldade, as cinco dimensões, alerta de revisão humana e referência de origem, usando um provedor de IA simulado e sem rede.
- Na primeira tentativa, a sandbox bloqueou conexões de loopback (`EACCES 127.0.0.1`); essa restrição não permitiu rodar os testes HTTP naquele momento.

### Revalidação antes do envio (2026-10-23)

- `npm test`: passou com código de saída 0, incluindo os testes HTTP de `aula-dia.test.mjs`, cobertura da fonte, fluxo de IA, testes Node e regressões de interface.
- `npm run build`: passou e copiou 13 itens para `public/`.
- `git diff --check`: passou.
- Os testes usam conteúdo sintético e provedores simulados; isso valida os fluxos automatizados, mas não mede precisão médica em aulas reais.

### Pendências

- Não existe amostra de referência revisada por professor; portanto não há WER/CER comparável nem avaliação de correção médica real.
- A origem ainda aponta para uma janela da transcrição ou para o bloco estruturado, não à frase ou timestamp exatos. As cinco notas avaliam sinais de forma e rastreabilidade, não precisão, cobertura semântica ou segurança clínica.
