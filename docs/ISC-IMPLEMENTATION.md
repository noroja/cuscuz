# Índice Semântico Curricular (ISC)

Atualizado em 25/10/2026. Este documento registra o que está implementado, o estado verificado do staging e as limitações conhecidas.

## Arquitetura

- `data/isc-taxonomy.json` contém a taxonomia curada e seus sinônimos; nós inferidos de pastas do catálogo são gravados como candidatos não canônicos, com confiança baixa.
- `src/isc-core.js` normaliza texto, segmenta fontes com offsets rastreáveis, associa tópicos e calcula similaridade temática, cobertura e ganho complementar. Sem evidência de conteúdo, as métricas quantitativas permanecem nulas.
- `src/isc-indexer.js` prepara indexação incremental por hash/versionamento e permite unir catálogos. `scripts/index-isc.mjs` oferece prévia sem escrita e importação explícita.
- As migrações `20261024053135`, `20261024053636` e `20261024134824` criam persistência, busca curricular/lexical e rotinas privadas. As tabelas ISC usam RLS e são acessíveis à aplicação pelo papel de serviço.
- `src/isc-routes.js` implementa busca, comparação e gestão de materiais pessoais. A propriedade é sempre derivada da sessão no servidor; tentativas de consultar, comparar ou remover materiais de outra conta são negadas.
- A busca global tenta o ISC e mantém o serviço de busca anterior como fallback. O Mentor recebe segmentos do material explicitamente indexado pelo estudante e devolve referências de origem.

## PDF e privacidade

Na Aula do Dia, o PDF é extraído no navegador com PDF.js. O arquivo não é enviado ao servidor; o aluno confirma antes de enviar o texto extraído ao provedor de embeddings configurado. O índice guarda segmentos, offsets e páginas quando disponíveis. O limite atual é 18 MB, 500 páginas e 200 mil caracteres extraídos por arquivo. PDFs escaneados sem camada de texto precisam de OCR antes do envio.

O texto e as transcrições só são enviados ao provedor de embeddings depois da confirmação explícita no fluxo. O conteúdo fica associado à conta autenticada. A opção exige `ISC_ENABLED=1`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e uma chave de embeddings reconhecida pela configuração semântica existente (`GEMINI_API_KEY`/`GOOGLE_AI_API_KEY`, `COHERE_API_KEY` ou `HF_TOKEN`). Chaves permanecem no servidor.

Para transcrições, o ISC preserva offsets de caracteres. Os timestamps existentes no karaokê ainda não são associados aos segmentos indexados: depois de revisão/correção da transcrição, não há alinhamento garantido entre o texto editado e o áudio. Cobertura e profundidade pedagógicas continuam sem rótulos automáticos; a ocorrência de um termo é evidência de tópico, não prova de cobertura completa.

## Estado do staging

Importação de metadados verificada no projeto Supabase de staging `cuscuz-med-staging`:

| Registro | Quantidade | Interpretação |
|---|---:|---|
| Recursos de catálogo | 33.660 | Títulos, caminhos e metadados; não significa que os arquivos foram lidos |
| Nós da taxonomia | 1.245 | Inclui candidatos derivados de pastas, marcados como não canônicos |
| Relações recurso-tópico | 11.259 | Evidências preliminares de título/caminho |
| Segmentos de conteúdo | 0 | Nenhum PDF ou vídeo do catálogo foi baixado/transcrito para esta importação |
| Embeddings do catálogo | 0 prontos | Recursos aguardam a indexação de conteúdo; busca lexical está disponível |

A busca por palavras e filtros curriculares foi exercitada no staging. Similaridade, cobertura e ganho baseados no conteúdo não são reportados para estes metadados. O banco de produção não foi alterado. A taxonomia curada atual tem 27 nós (13 disciplinas, 8 assuntos, 2 subassuntos e 4 objetivos); a expansão para todo o currículo médico e a revisão por docentes continuam pendentes. Não há pré-requisitos curriculares ou filtros por cronograma/perfil implementados ainda.

## Verificação e limites

`npm test` e `npm run build` passaram nesta implementação. Os testes ISC usam exemplos sintéticos revisados manualmente para schemas, offsets/páginas, filtros, isolamento, busca lexical, hashes e cálculo das métricas. Eles não substituem avaliação clínica humana nem WER/CER contra transcrições de referência. Ainda faltam amostras reais anotadas, OCR, extração automática de conceitos por LLM, avaliação de profundidade/cobertura e recomendações por perfil.

O catálogo importado não tem embeddings de conteúdo porque as credenciais de provedor não estavam disponíveis nesta execução. O modo lexical continua útil para busca por título/caminho; sem indexar transcrições ou PDFs, a classificação e a comparação de materiais do catálogo permanecem preliminares.

## Aula do Dia: slides, fala e comparação com o acervo

- A Aula do Dia reutiliza os recursos privados ISC para manter um índice por fonte: transcrição (`transcript`) e slides (`slides`). O endpoint `/api/isc/lesson-index` consolida tópicos por identificador canônico, sem apagar a origem, página/slide ou trecho de evidência.
- PDF é extraído no navegador com PDF.js; PPTX é lido localmente de sua estrutura XML/ZIP. O arquivo original não é enviado. Após confirmação, o texto extraído, as referências e os segmentos seguem ao backend/provedor de embeddings existente. Limites: 18 MB por arquivo, 500 páginas/slides, 200 mil caracteres e 12 fontes por Aula do Dia.
- Figuras de PPTX são detectadas e identificadas por slide, mas não interpretadas visualmente. PDF escaneado e imagem sem camada textual exigem OCR, que ainda não está implementado. Tabelas com texto em PPTX entram como texto; diagramas e imagens não são semanticamente lidos.
- A revisão permite remover tópicos reconhecidos da seleção e adicionar assuntos/objetivos canônicos que a extração não reconheceu. Uma adição manual é apenas um objetivo de busca salvo na sessão; ela não vira evidência atribuída aos slides ou à fala.
- `/api/isc/recommendations` retorna candidatas relacionadas e trechos rastreáveis quando há conteúdo indexado. `/api/isc/lesson-compare` exige duas a quatro videoaulas e compara a seleção com slides, fala e índice consolidado. Percentuais de cobertura ficam nulos quando o catálogo só tem metadados; títulos e caminhos servem como pistas preliminares, não prova de cobertura ou ausência.
- Roteiro de estudo e início de reprodução usam o player/catalogo existente. Timestamps só podem ser recomendados quando estão armazenados em segmentos de conteúdo; transcrições revisadas ainda não têm alinhamento temporal garantido.
- A migração `20261025180328_isc_slides_source_kind.sql` amplia as restrições de `source_kind` sem recriar tabelas. Foi aplicada e verificada no projeto Supabase de staging `cuscuz-med-staging` (migração `20261025180328`); produção não foi alterada.

Os testes da nova integração usam fontes sintéticas e verificam consolidação, correção manual de objetivos, isolamento por usuário, recomendações preliminares e a recusa de pontuar cobertura de vídeo quando só há metadados. Ainda não há validação ponta a ponta com slides reais, vídeo transcrito ou avaliação docente.
