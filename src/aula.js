// Aula do dia — transcrição fiel por trechos, revisão do texto, resumo "Crônicas de Residência" (MD) e flashcards
import { Type, transcribeAudio } from './ai-provider.js';

const S = Type.STRING;
const COR_PADRAO = 'dourado';

// Regras do prompt "Crônicas de Residência" do aluno, adaptadas para gerar CAPÍTULO a CAPÍTULO (cada chamada cabe no tempo do servidor)
const REGRAS_CRONICAS = `Você escreve material de estudo médico no estilo "Crônicas de Residência" — resumos narrativos, didáticos e INESQUECÍVEIS para provas de Residência Médica (storytelling + didática visual + neurociência), em MARKDOWN.
HANDLE fixo: **@cuscuz-klan**.

FIDELIDADE (inviolável):
- Baseie TODAS as afirmações na transcrição da aula. Não invente dados nem acrescente conhecimento externo ao conteúdo clínico; não apresente inferência como fato.
- Preserve números, nomes, unidades, condições e ressalvas EXATAMENTE como ditos (doses, janelas de tempo, escores, percentuais, faixas etárias).
- Cobertura 100% do tema: conceitos, classificações, casos, exemplos, comentários do professor, tabelas e listas completas (vetado "entre outros"/"etc." que implique omissão). Condensar é reescrever melhor, NUNCA omitir. Síntese curta é proibida.
- Explique termos técnicos na primeira ocorrência. Se a fonte for omissa/contraditória/incerta, sinalize: "⚠️ A fonte não detalha..." / "⚠️ As fontes divergem sobre...". Trecho incompreensível: "[trecho não recuperável]".
- NÃO invente questões. Só inclua "Veja como CAIU" se o professor tiver lido/comentado uma questão real na aula (com banca/ano se citados).
- Analogias, nomes de personagens e mnemônicos são ferramentas didáticas explícitas e não alteram o conteúdo técnico.

FORMATAÇÃO MARKDOWN (padrão fixo):
- CAIXA-HISTÓRIA → blockquote de cena iniciado pelo emoji do "ator" (> 🫀 **[Cena]** ...) — UMA ideia por bloco.
- FALAS → itálico com falante: *"Doutor, o que está acontecendo comigo?"* — **Sr. Paulo**.
- PERSONAGENS/ÓRGÃOS → emoji + nome próprio em bold na 1ª aparição.
- MARCA-TEXTO → **negrito** para termos-chave e dados de prova; ***negrito-itálico*** para relações que costumam ser confundidas.
- CAIXAS DE GURU (blockquotes, títulos fixos): > 💡 **DICA SALVADORA:** · > 🧪 **SE LIGA:** · > ⚠️ **ATENÇÃO:** (pegadinhas) · > 📖 **SAIBA MAIS:** · > 🎁 **BÔNUS:** · > 🐾 **O PULO DO GATO:** · > 🧠 **MNEMÔNICO:** [LETRAS] — explicação. Use pontualmente, só quando sustentado pela aula.
- FLUXOGRAMAS/ALGORITMOS → sequência com setas (1 → 2 → 3; "Se X → conduta A / Se Y → conduta B") ou tabela de decisão. PROIBIDO espremer algoritmo em parágrafo.
- TABELAS em Markdown legível para comparações, classificações, escores e doses.
- Parágrafos curtos, linha em branco entre blocos.

FÓRMULA DO CAPÍTULO (aplicar os atos que couberem ao conteúdo):
Ato 1 Abertura: PACIENTE COM NOME PRÓPRIO (use o da aula; se não houver, crie nome brasileiro simples e rotule "(personagem didático)") em 2–4 frases com a queixa principal — cena + falas.
Ato 2 A Virada: a história avança e CADA informação da aula entra como cena, com PERGUNTAS NORTEADORAS como títulos "###" ("Mas o que é X?", "Como se manifesta?", "Beleza, mas como RESOLVER???", "E agora, [nome]?").
Ato 3 O Mecanismo: tabela/lista com setas (lado técnico 100% fiel) + analogia personificada (camada didática explícita).
Ato 4 O Guru: caixas de guru pontuais; crie um mnemônico SE a aula não trouxer, declarando-o "mnemônico didático".
Ato 5 O Recap: "Recapitulando: estamos atendendo o Sr./a Sra. [nome]...".
Ato 6: blockquote final do capítulo:
> 🎯 **RESUMO PARA A PROVA**
> - ✓ ponto-chave...
(complementa, NUNCA substitui o conteúdo integral)
Ato 7 Veja como CAIU: somente se houver questão real na aula; título + \`> 📋 **BANCA | ANO**\` + enunciado íntegro + alternativas A–E + "✅ **Gabarito: X**" com justificativa de 2–3 linhas.
Ato 8: "#### ✏️ Anotações" com 3 linhas de underscore (______).`;

const dividir = (texto, max = 9000) => {
  const paragrafos = String(texto || '').split(/\n{2,}/);
  const blocos = []; let atual = '';
  for (const p of paragrafos) {
    if ((atual + '\n\n' + p).length > max && atual) { blocos.push(atual); atual = p; } else atual = atual ? atual + '\n\n' + p : p;
  }
  if (atual) blocos.push(atual);
  return blocos;
};

export function registerAula(app, { generateAI, aiConfigured }) {
  const exigeIA = (res) => { if (!aiConfigured()) { res.status(503).json({ success: false, msg: 'GROQ_API_KEY não configurada.' }); return false; } return true; };

  app.get('/api/aula/status', (_req, res) => res.json({ success: true, gemini: !!aiConfigured() }));

  // 1) Transcreve um trecho de áudio fielmente
  app.post('/api/aula/transcrever', async (req, res) => {
    try {
      if (!aiConfigured()) return res.status(503).json({ success: false, msg: 'Transcrição indisponível: GROQ_API_KEY não configurada.' });
      const { audio = '', mime = 'audio/webm', disciplina = '', tema = '', anterior = '', glossario = [] } = req.body || {};
      if (!audio || audio.length < 200) return res.status(400).json({ success: false, msg: 'Áudio vazio.' });
      if (audio.length > 28 * 1024 * 1024) return res.status(413).json({ success: false, msg: 'Trecho de áudio grande demais.' });
      const mimeBase = String(mime).split(';')[0] || 'audio/webm';
      const termos = (Array.isArray(glossario) ? glossario : []).map(String).filter(Boolean).slice(0, 80);
      let texto = await transcribeAudio({ audioBase64: audio, mime: mimeBase, language: 'pt', prompt: [disciplina && ('Aula de ' + disciplina + (tema ? ': ' + tema : '') + '.'), termos.length && ('Termos: ' + termos.join(', '))].filter(Boolean).join(' ') });
      if (/^\[sem fala\]$/i.test(texto)) texto = '';
      res.json({ success: true, texto });
    } catch (err) {
      console.warn('[Aula transcrever]', err.message);
      const unsupported = /unsupported|invalid.*(mime|argument)|could not.*process|INVALID_ARGUMENT/i.test(err.message);
      res.status(unsupported ? 422 : 500).json({ success: false, msg: err.message, formato: unsupported });
    }
  });

  // 2) Revisão do texto transcrito (une cortes entre trechos, uniformiza termos, organiza em parágrafos) — por pedaço
  app.post('/api/aula/revisar', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { texto = '', area = '', conteudo = '', glossario = [] } = req.body || {};
      const t = String(texto).trim();
      if (t.length < 20) return res.json({ success: true, texto: t });
      if (t.length > 14000) return res.status(413).json({ success: false, msg: 'Pedaço grande demais para revisar.' });
      const r = await generateAI({
        contents: `Você revisa transcrições de aulas de Medicina (área: ${area || 'não informada'}; conteúdo: ${conteudo || 'não informado'}).
Revise o texto abaixo SEM mudar o significado nem remover informação:
- corrija erros de reconhecimento de fala e a grafia de termos médicos, siglas e fármacos (use o contexto da aula);
- una frases cortadas na emenda entre trechos, remova repetições acidentais da emenda e reconstrua pontuação e parágrafos;
- mantenha números, doses e unidades exatamente como estão; não resuma; não acrescente conteúdo; mantenha [inaudível] onde o trecho é irrecuperável;
- se uma palavra for duvidosa e o contexto não permitir certeza, mantenha como está e marque com [?].
${(glossario || []).length ? 'Grafia preferida: ' + glossario.slice(0, 80).join(', ') + '.\n' : ''}Responda SOMENTE com o texto revisado.

TEXTO:
${t}`,
        config: { temperature: 0 }
      });
      res.json({ success: true, texto: String(r.text || '').trim() || t });
    } catch (err) {
      console.warn('[Aula revisar]', err.message);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 3) Mapa prévio: temas/capítulos da aula (inventário de tudo que foi dito)
  app.post('/api/aula/mapa', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', parte = '' } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 200) return res.status(400).json({ success: false, msg: 'Transcrição curta demais para resumir.' });
      const r = await generateAI({
        contents: `Faça o MAPA PRÉVIO desta aula de Medicina (área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}${parte ? '; ' + parte : ''}): inventarie TODOS os tópicos abordados na transcrição, na ordem, agrupados em capítulos (um capítulo por tema coerente; entre 1 e 12). Nada que foi dito pode ficar fora de algum capítulo. Para cada capítulo liste os pontos que ele deve cobrir (conceitos, números, casos, classificações, condutas, comentários do professor, questões lidas). Informe também se o professor leu/comentou alguma questão real de prova (temQuestoes).
TRANSCRIÇÃO:
${t.slice(0, 220000)}`,
        config: {
          temperature: 0.2, responseMimeType: 'application/json',
          responseSchema: { type: Type.OBJECT, required: ['capitulos'], properties: {
            capitulos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['titulo', 'pontos'], properties: { titulo: { type: S }, disciplina: { type: S }, pontos: { type: Type.ARRAY, items: { type: S } } } } },
            temQuestoes: { type: Type.BOOLEAN }
          } }
        }
      });
      const j = JSON.parse(String(r.text).trim());
      j.capitulos = (j.capitulos || []).filter(c => c && c.titulo).slice(0, 14);
      res.json({ success: true, mapa: j });
    } catch (err) {
      console.error('[Aula mapa]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 4) Um capítulo do resumo Crônicas
  app.post('/api/aula/capitulo', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', capitulo = {}, numero = 1, total = 1, cor = COR_PADRAO } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100 || !capitulo || !capitulo.titulo) return res.status(400).json({ success: false, msg: 'Dados insuficientes.' });
      const r = await generateAI({
        contents: `${REGRAS_CRONICAS}

TAREFA: escreva SOMENTE o capítulo ${numero} de ${total} do volume (área: ${area || 'n/i'}; conteúdo da aula: ${conteudo || 'n/i'}). Comece direto por:
## ${numero}.0 — ${capitulo.titulo}
(breadcrumb em itálico logo abaixo: *${area || 'Aula'} — ${capitulo.titulo}*) e desenvolva a fórmula completa (Atos 1–8 que couberem).
Pontos que este capítulo DEVE cobrir integralmente (do mapa prévio): ${JSON.stringify(capitulo.pontos || [])}.
Cor de Magia do volume: ${cor} (apenas registro; não altera o texto).
Não repita o que pertence a outros capítulos. Não escreva capa, índice, considerações finais nem gabarito geral. Sem preâmbulo e sem "CONTINUA".

TRANSCRIÇÃO (fonte única):
${t.slice(0, 220000)}`,
        config: { temperature: 0.4 }
      });
      res.json({ success: true, markdown: String(r.text || '').trim() });
    } catch (err) {
      console.error('[Aula capitulo]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 5) Fechamento do volume: Considerações Finais + Revisão Final (+ Gabarito se houver questões)
  app.post('/api/aula/fechamento', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', capitulos = [], temQuestoes = false } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      const r = await generateAI({
        contents: `${REGRAS_CRONICAS}

TAREFA: escreva o FECHAMENTO do volume desta aula (área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}; capítulos: ${JSON.stringify((capitulos || []).map(c => c.titulo || c))}), nesta ordem e com estes títulos:
## Considerações Finais
(síntese integradora dos conceitos centrais — relações entre os temas, sem repetição mecânica)
## Revisão Final — Fatos e Relações Essenciais
(lista densa de memorização: números, cortes de ponto, condutas de escolha, pegadinhas, mnemônicos — a "lista de véspera de prova", apenas com o que a aula disse)
${temQuestoes ? '## Gabarito Geral\n(tabela | Nº | Banca-Ano | Resposta | apenas das questões reais comentadas na aula)\n' : ''}Termine com a linha: — Fim deste volume das Crônicas · @cuscuz-klan —
Sem preâmbulo.

TRANSCRIÇÃO (fonte única):
${t.slice(0, 220000)}`,
        config: { temperature: 0.3 }
      });
      res.json({ success: true, markdown: String(r.text || '').trim() });
    } catch (err) {
      console.error('[Aula fechamento]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 6) Flashcards de revisão da aula (a partir da transcrição revisada)
  app.post('/api/aula/flashcards', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', capitulos = [] } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      const palavras = t.split(/\s+/).length;
      const alvo = Math.max(10, Math.min(80, Math.round(palavras / 90)));
      const r = await generateAI({
        contents: `Crie flashcards de REVISÃO para residência médica a partir EXCLUSIVAMENTE desta aula (área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}).
Regras: cerca de ${alvo} cartões cobrindo TODOS os pontos importantes na ordem da aula; um fato por cartão (pergunta direta na frente, resposta curta e completa no verso); inclua números, doses, critérios, classificações, condutas de escolha e pegadinhas ditas pelo professor; use "____" (lacuna) quando for melhor para memorizar; sem duplicar; sem conhecimento externo; português do Brasil. Em "tema" coloque o capítulo/tópico ao qual o cartão pertence${capitulos.length ? ' (preferir um destes: ' + JSON.stringify(capitulos.map(c => c.titulo || c)) + ')' : ''}.
TRANSCRIÇÃO:
${t.slice(0, 220000)}`,
        config: {
          temperature: 0.2, responseMimeType: 'application/json',
          responseSchema: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['frente', 'verso'], properties: { frente: { type: S }, verso: { type: S }, tema: { type: S } } } }
        }
      });
      const arr = JSON.parse(String(r.text).trim());
      const vistos = new Set();
      const cards = (Array.isArray(arr) ? arr : []).filter(c => c && c.frente && c.verso).filter(c => { const k = c.frente.trim().toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, 100);
      res.json({ success: true, flashcards: cards });
    } catch (err) {
      console.error('[Aula flashcards]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 7) Processamento geral (resumo curto, cai na prova, questões, assuntos do plano) — mantido
  app.post('/api/aula/processar', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', disciplina = '', tema = '', assuntosPlano = [], marcas = [] } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 80) return res.status(400).json({ success: false, msg: 'Transcrição curta demais para processar.' });
      const r = await generateAI({
        contents: `Você é um monitor de Medicina. Com base SOMENTE na transcrição da aula abaixo (disciplina: ${disciplina || 'não informada'}${tema ? '; tema: ' + tema : ''}), produza material de estudo fiel ao que foi dito. Não acrescente informação que o professor não tenha dito; se algo parecer errado ou impreciso na fala, sinalize em "duvidas". Português do Brasil.
${assuntosPlano.length ? 'Assuntos esperados na prova (do manual do aluno): ' + JSON.stringify(assuntosPlano.slice(0, 60)) + '. Em "assuntosCobertos" liste, copiando exatamente, apenas os que foram realmente abordados na aula.\n' : ''}${marcas.length ? 'O aluno marcou estes momentos como importantes (mm:ss): ' + marcas.join(', ') + '.\n' : ''}
TRANSCRIÇÃO:
${t.slice(0, 170000)}`,
        config: {
          temperature: 0.3, responseMimeType: 'application/json',
          responseSchema: { type: Type.OBJECT, required: ['titulo', 'resumo', 'topicos'], properties: {
            titulo: { type: S }, resumo: { type: S, description: 'resumo em 5-10 linhas' },
            topicos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['titulo', 'pontos'], properties: { titulo: { type: S }, pontos: { type: Type.ARRAY, items: { type: S } } } } },
            termos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['termo', 'definicao'], properties: { termo: { type: S }, definicao: { type: S } } } },
            caiNaProva: { type: Type.ARRAY, items: { type: S }, description: 'o que o professor indicou que cai na prova ou enfatizou' },
            duvidas: { type: Type.ARRAY, items: { type: S } },
            assuntosCobertos: { type: Type.ARRAY, items: { type: S } }
          } }
        }
      });
      const j = JSON.parse(String(r.text).trim());
      j.assuntosCobertos = (j.assuntosCobertos || []).filter(a => assuntosPlano.includes(a));
      res.json({ success: true, resultado: j });
    } catch (err) {
      console.error('[Aula processar]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });
}

export { dividir };
