# Diagnóstico inicial — Aula do Dia — 2026-10-23
Base: cfc0e3a. Inspeção anterior a alterações funcionais nesta auditoria.

| Critério | Funcionalidade | Qualidade estrutural /10 | Problemas comprovados | Prioridade | Solução |
|---|---|---|---|---|---|
| Transcrição | Parcial | 6 | revisão falha silenciosamente e recebe status revisado; parágrafos extensos excedem janelas | Alta | status parcial, segmentação limitada, revisão manual |
| Resumo | Parcial | 5 | src/aula.js:278 elimina meio do capítulo; mapa limita14 capítulos | Alta | processamento integral por segmentos |
| Flashcards | Parcial | 5 | limite100 interrompe leitura; ausência de origem; vazios tratados como sucesso | Alta | rastreabilidade, validação e recuperação seletiva |
| Mapa mental | Parcial | 4 | somente primeira janela da transcrição; falha de regeneração substitui mapa anterior | Alta | união das janelas e preservação da última versão |
| Persistência | Parcial | 5 | falhas IndexedDB ignoradas; retranscrição deixa derivados desatualizados | Alta | propagar falhas, histórico e invalidação |

Notas avaliam implementação observada, não precisão médica. WER, CER e erros médicos reais não medidos: faltam áudio e referência humana autorizados. Perda em fronteiras de gravação é hipótese, exige teste com áudio de referência.

Arquitetura a preservar: MediaRecorder por trechos, IndexedDB para áudio/documentos, localStorage para índice; APIs /api/aula/status, transcrever, revisar, mapa, capitulo, fechamento, flashcards, processar, extrair, resumo-geral, mapa-mental. Base extraída reutilizada por fechamento/cartões/material. Fila por provedor e fallback existentes; modelos dependem da configuração. Prompts e limites em src/aula.js, roteamento em src/ai-workflow.js e src/ai-provider.js; UI em aula-dia.js.

Não serão enviados documentos pessoais a provedores externos. Testes sintéticos não constituem avaliação clínica. Implementação priorizará perda de conteúdo, integridade de dados e estados falsos antes de novas funções.
