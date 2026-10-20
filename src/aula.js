// Aula do dia — transcrição fiel por trechos, revisão do texto, resumo "Crônicas de Residência" (MD) e flashcards
import { Type, transcribeAudio, aiTpm } from './ai-provider.js';

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

// ── Orçamento por requisição ──
// A Groq cobra por "tokens por minuto" (TPM: 8000 no free tier do gpt-oss-120b). Nenhum prompt sai acima
// do teto: cada pedido reserva do orçamento o que gasta com instruções/schema + a saída esperada, e o
// que sobra vira characters de transcrição. Se a janela do minuto fechar, o provider espera o retry-after.
const CARACTERES_POR_TOKEN = 3.4; // PT-BR falado rende ~3,6 caracteres por token — margem apertada de propósito
const janelaChars = (reservaTokens) => Math.max(1600, Math.round(Math.max((aiTpm() || 8000) * 0.85 - Math.max(reservaTokens, 600), 1000) * CARACTERES_POR_TOKEN));

// Divide por parágrafos em janelas ≤ maxChars, guardando o offset ABSOLUTO de início/fim de cada janela
// e de cada parágrafo dentro dela (ps/lens) — é isso que permite recortar a transcrição por capítulo.
const fatiarComOffsets = (texto, maxChars = 20000) => {
  const t = String(texto || '');
  const parags = []; let pos = 0;
  for (const p of t.split(/\n{2,}/)) {
    const at = t.indexOf(p, pos); const ini = at >= 0 ? at : pos;
    pos = ini + p.length;
    if (!p.trim()) continue;
    parags.push({ ini, len: p.length });
  }
  const janelas = []; let cur = null;
  for (const p of parags) {
    if (!cur) cur = { ini: p.ini, fim: p.ini + p.len, ps: [], lens: [] };
    else if (p.ini + p.len - cur.ini > maxChars && cur.ps.length) { janelas.push(cur); cur = { ini: p.ini, fim: p.ini + p.len, ps: [], lens: [] }; }
    cur.fim = p.ini + p.len; cur.ps.push(p.ini - cur.ini); cur.lens.push(p.len);
  }
  if (cur) janelas.push(cur);
  return janelas.map(j => ({ texto: t.slice(j.ini, j.fim), ini: j.ini, fim: j.fim, ps: j.ps, lens: j.lens }));
};

// "paragrafoFim" (0-based, contado dentro da janela f) → offset absoluto do FIM desse parágrafo em t.
const fimDoParagrafo = (f, idx) => {
  const n = Math.max(0, Math.min(Number.isFinite(idx) ? idx : f.ps.length - 1, f.ps.length - 1));
  return f.ini + f.ps[n] + f.lens[n];
};

const palavrasChave = (s) => new Set(String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]{4,}/g) || []);

// Fallback sem mapa: escolhe as janelas da transcrição que mais falam dos pontos do capítulo (por palavras-chave)
// até encher o orçamento de caracteres — mantém a ordem da aula.
const recortePorPalavras = (t, capitulo, maxChars) => {
  const termos = palavrasChave([capitulo.titulo, ...(capitulo.pontos || [])].join(' '));
  const janelas = fatiarComOffsets(t, 2400);
  if (!termos.size || janelas.length <= 1) return t.slice(0, maxChars);
  const achadas = janelas.map((f, i) => { let sc = 0; for (const w of palavrasChave(f.texto)) if (termos.has(w)) sc++; return { i, sc, f }; })
    .filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
  if (!achadas.length) return t.slice(0, maxChars);
  const escolhidas = []; let usados = 0;
  for (const x of achadas) {
    if (usados + x.f.texto.length > maxChars) { if (escolhidas.length) break; continue; }
    escolhidas.push(x); usados += x.f.texto.length;
  }
  return escolhidas.sort((a, b) => a.i - b.i).map(x => x.f.texto).join('\n\n');
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

  // 3) Mapa prévio: temas/capítulos da aula (inventário de tudo que foi dito), em janelas que respeitam o
  //    teto de TPM da Groq. Cada janela devolve capítulos-fragmento com "de"/"ate" (offsets em caracteres da
  //    transcrição), e a consolidação junta fragmentos consecutivos do mesmo tema.
  app.post('/api/aula/mapa', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', parte = '' } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 200) return res.status(400).json({ success: false, msg: 'Transcrição curta demais para resumir.' });
      const partes = fatiarComOffsets(t, janelaChars(1400));
      // A) inventário trecho a trecho, rastreando onde cada capítulo termina
      const frgs = []; let temQuestoes = false;
      for (let i = 0; i < partes.length; i++) {
        const f = partes[i];
        const r = await generateAI({
          contents: `Inventarie os tópicos deste TRECHO de uma aula de Medicina (trecho ${i + 1} de ${partes.length}; área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}${parte ? '; ' + parte : ''}).
Agrupe os tópicos, na ordem em que aparecem, em capítulos coerentes (1 a 6 para este trecho). Para cada capítulo informe:
- "titulo": nome curto do tema;
- "pontos": tudo que ele cobre (conceitos, números, casos, classificações, condutas, comentários do professor, questões lidas) — nada do trecho fica fora de algum capítulo;
- "paragrafoFim": número (0-based) do PARÁGRAFO DO TRECHO onde o capítulo termina (parágrafos são separados por linha em branco; o último capítulo termina no último parágrafo do trecho).
Diga também se no trecho o professor leu/comentou alguma questão real de prova (temQuestoes).`,
          config: {
            temperature: 0.2, responseMimeType: 'application/json',
            responseSchema: { type: Type.OBJECT, required: ['capitulos'], properties: {
              capitulos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['titulo', 'pontos', 'paragrafoFim'], properties: { titulo: { type: S }, disciplina: { type: S }, pontos: { type: Type.ARRAY, items: { type: S } }, paragrafoFim: { type: Type.INTEGER } } } },
              temQuestoes: { type: Type.BOOLEAN }
            } }
          }
        });
        const j = JSON.parse(String(r.text).trim());
        let frente = frgs.length ? frgs[frgs.length - 1].ate : f.ini;
        for (const c of (j.capitulos || [])) {
          if (!c || !c.titulo) continue;
          const de = Math.max(frente, f.ini);
          const ate = Math.max(fimDoParagrafo(f, Number(c.paragrafoFim)), de + 1);
          frgs.push({ titulo: String(c.titulo), disciplina: String(c.disciplina || ''), pontos: (c.pontos || []).map(String).filter(Boolean).slice(0, 16), de, ate });
          frente = ate;
        }
        if (j.temQuestoes) temQuestoes = true;
      }
      if (!frgs.length) return res.json({ success: true, mapa: { capitulos: [], temQuestoes } });
      let mapa = { capitulos: frgs.slice(0, 14), temQuestoes };
      // B) consolidação — entrada pequena (só fragmentos), cabe em qualquer teto
      if (frgs.length > 1) {
        try {
          const r = await generateAI({
            contents: `Abaixo está o inventário, em ordem de aparição na transcrição de uma aula de Medicina, de fragmentos de capítulos. Cada fragmento tem "de" e "ate" (limites em CARACTERES da transcrição).
Junta em um único capítulo os fragmentos CONSECUTIVOS que claramente tratam do MESMO tema (mantenha o MENOR "de" e o MAIOR "ate" e una os "pontos", sem duplicar). Devolve de 1 a 12 capítulos finais, NA ORDEM da aula, sem deixar nenhum fragmento fora e sem fragmento aparecer em dois capítulos.
FRAGMENTOS:
${JSON.stringify(frgs.map(f => ({ titulo: f.titulo, de: f.de, ate: f.ate, pontos: f.pontos.slice(0, 4) })))}`,
            config: {
              temperature: 0.1, responseMimeType: 'application/json',
              responseSchema: { type: Type.OBJECT, required: ['capitulos'], properties: {
                capitulos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['titulo', 'de', 'ate'], properties: { titulo: { type: S }, de: { type: Type.INTEGER }, ate: { type: Type.INTEGER }, pontos: { type: Type.ARRAY, items: { type: S } } } } }
              } }
            }
          });
          const j = JSON.parse(String(r.text).trim());
          const limpos = (j.capitulos || []).filter(c => c && c.titulo && Number.isFinite(Number(c.de)) && Number.isFinite(Number(c.ate)))
            .map(c => ({ titulo: String(c.titulo), disciplina: '', pontos: (c.pontos || []).map(String).filter(Boolean).slice(0, 16), de: Math.max(0, Number(c.de) | 0), ate: Math.min(t.length, Math.max(Number(c.ate) | 0, 1)) }))
            .filter(c => c.ate > c.de).sort((a, b) => a.de - b.de);
          for (let i = 1; i < limpos.length; i++) if (limpos[i].de < limpos[i - 1].ate) limpos[i].de = limpos[i - 1].ate;
          const finais = limpos.filter(c => c.ate > c.de).map(c => {
            const deDentro = frgs.filter(f => f.de >= c.de && f.ate <= c.ate);
            if (deDentro.length && (!c.pontos.length || deDentro.length === 1)) c.pontos = deDentro.flatMap(f => f.pontos).slice(0, 16);
            return c;
          }).slice(0, 14);
          if (finais.length) mapa = { capitulos: finais, temQuestoes };
        } catch (_) { /* consolidação falhou: os fragmentos entram como capítulos diretos */ }
      }
      res.json({ success: true, mapa });
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
      // Fonte do capítulo: o mapa marca "de"/"ate" (offsets em caracteres) onde o capítulo começa e termina;
      // sem essas marcas (mapas antigos), cai para recorte por palavras-chave do título/pontos.
      const deN = Number(capitulo.de), ateN = Number(capitulo.ate);
      const maxFonte = janelaChars(2600); // regras + saída longa reservados do teto de TPM
      let fonte;
      if (Number.isFinite(deN) && Number.isFinite(ateN) && ateN > deN) {
        fonte = t.slice(Math.max(0, (deN | 0) - 500), Math.min(t.length, (ateN | 0) + 500));
        if (fonte.length > maxFonte) fonte = fonte.slice(0, maxFonte - 2600) + '\n\n[…trecho do meio omitido para caber no limite por minuto da IA…]\n\n' + fonte.slice(-1800);
      } else {
        fonte = recortePorPalavras(t, capitulo, maxFonte);
      }
      const r = await generateAI({
        contents: `${REGRAS_CRONICAS}

TAREFA: escreva SOMENTE o capítulo ${numero} de ${total} do volume (área: ${area || 'n/i'}; conteúdo da aula: ${conteudo || 'n/i'}). Comece direto por:
## ${numero}.0 — ${capitulo.titulo}
(breadcrumb em itálico logo abaixo: *${area || 'Aula'} — ${capitulo.titulo}*) e desenvolva a fórmula completa (Atos 1–8 que couberem).
Pontos que este capítulo DEVE cobrir integralmente (do mapa prévio): ${JSON.stringify(capitulo.pontos || [])}.
Cor de Magia do volume: ${cor} (apenas registro; não altera o texto).
Não repita o que pertence a outros capítulos. Não escreva capa, índice, considerações finais nem gabarito geral. Sem preâmbulo e sem "CONTINUA".

TRECHO DA TRANSCRIÇÃO (fonte única — cobre integralmente este capítulo):
${fonte}`,
        config: { temperature: 0.4 }
      });
      res.json({ success: true, markdown: String(r.text || '').trim() });
    } catch (err) {
      console.error('[Aula capitulo]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 5) Fechamento do volume: Considerações Finais + Revisão Final (+ Gabarito se houver questões) — por janelas
  app.post('/api/aula/fechamento', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', capitulos = [], temQuestoes = false } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      const partes = fatiarComOffsets(t, janelaChars(2200));
      const separa = (md) => { const cons = [], rev = []; let alvo = null; for (const l of String(md).split('\n')) { if (/^#{1,4}.*(considera|síntese|sintese)/i.test(l)) alvo = cons; else if (/^#{1,4}.*(revis|fatos|memoriz)/i.test(l)) alvo = rev; else if (alvo) alvo.push(l); } return { cons, rev }; };
      const cons = [], rev = [];
      for (let i = 0; i < partes.length; i++) {
        const r = await generateAI({
          contents: `TRECHO ${i + 1} de ${partes.length} de uma aula de Medicina (área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}). Extraia DESTE TRECHO, em Markdown, exatamente duas seções:
### Síntese do trecho
(3 a 6 bullets "-" amarrando os conceitos centrais do trecho ENTRE SI — relações e lógica clínica, sem repetição mecânica do roteiro)
### Memória do trecho
(lista densa de memorização, um item "-" por linha: números, doses, cortes de ponto, condutas de escolha, pegadinhas, mnemônicos — SOMENTE o que o trecho disse; nada inventado)
Sem preâmbulo, sem título de volume, sem "CONTINUA", sem fecho.
TRECHO:
${partes[i].texto}`,
          config: { temperature: 0.3 }
        });
        const s = separa(r.text);
        cons.push(...s.cons); rev.push(...s.rev);
      }
      const limpa = (a) => a.join('\n').replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');
      let md = `## Considerações Finais\n\n${limpa(cons) || '*(nada a sintetizar)*'}\n\n## Revisão Final — Fatos e Relações Essenciais\n\n${limpa(rev) || '*(nada listado)*'}`;
      if (temQuestoes) md += '\n\n## Gabarito Geral\n(as questões reais lidas na aula estão comentadas nos capítulos, nas caixas "BANCA | ANO" com gabarito em negrito)';
      md += `\n\n— Fim deste volume das Crônicas · @cuscuz-klan —`;
      res.json({ success: true, markdown: md.trim() });
    } catch (err) {
      console.error('[Aula fechamento]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 6) Flashcards de revisão da aula (a partir da transcrição revisada) — por janelas, com dedupe no fim
  app.post('/api/aula/flashcards', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', capitulos = [] } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      const palavras = t.split(/\s+/).length;
      const alvo = Math.max(10, Math.min(80, Math.round(palavras / 90)));
      const nomeCaps = capitulos.map(c => c.titulo || c).filter(Boolean);
      const partes = fatiarComOffsets(t, janelaChars(1800));
      const porParte = Math.max(6, Math.round(alvo / partes.length));
      const cartoes = []; const vistos = new Set();
      for (let i = 0; i < partes.length; i++) {
        const r = await generateAI({
          contents: `Crie flashcards de REVISÃO para residência médica a partir EXCLUSIVAMENTE deste TRECHO de aula (trecho ${i + 1} de ${partes.length}; área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}).
Regras: cerca de ${porParte} cartões cobrindo os pontos importantes NA ORDEM do trecho; um fato por cartão (pergunta direta na frente, resposta curta e completa no verso); inclua números, doses, critérios, classificações, condutas de escolha e pegadinhas ditas pelo professor; use "____" (lacuna) quando for melhor para memorizar; sem duplicar; sem conhecimento externo; português do Brasil. Em "tema" coloque o capítulo/tópico ao qual o cartão pertence${nomeCaps.length ? ' (preferir um destes: ' + JSON.stringify(nomeCaps) + ')' : ''}.
TRECHO:
${partes[i].texto}`,
          config: {
            temperature: 0.2, responseMimeType: 'application/json',
            responseSchema: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['frente', 'verso'], properties: { frente: { type: S }, verso: { type: S }, tema: { type: S } } } }
          }
        });
        const arr = JSON.parse(String(r.text).trim());
        for (const c of (Array.isArray(arr) ? arr : [])) {
          if (!c || !c.frente || !c.verso) continue;
          const k = String(c.frente).trim().toLowerCase();
          if (vistos.has(k)) continue;
          vistos.add(k);
          cartoes.push({ frente: String(c.frente), verso: String(c.verso), tema: String(c.tema || '') });
          if (cartoes.length >= 100) break;
        }
        if (cartoes.length >= 100) break;
      }
      res.json({ success: true, flashcards: cartoes });
    } catch (err) {
      console.error('[Aula flashcards]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 7) Processamento geral (resumo curto, cai na prova, questões, assuntos do plano) — por janelas, fundido em JS
  app.post('/api/aula/processar', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', disciplina = '', tema = '', assuntosPlano = [], marcas = [] } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 80) return res.status(400).json({ success: false, msg: 'Transcrição curta demais para processar.' });
      const ctx = `Você é um monitor de Medicina. Com base SOMENTE no trecho da aula abaixo (disciplina: ${disciplina || 'não informada'}${tema ? '; tema: ' + tema : ''}), produza material de estudo fiel ao que foi dito. Não acrescente informação que o professor não tenha dito; se algo parecer errado ou impreciso na fala, sinalize em "duvidas". Português do Brasil.\n`;
      const ctxAss = assuntosPlano.length ? `Assuntos esperados na prova (do manual do aluno): ${JSON.stringify(assuntosPlano.slice(0, 60))}. Em "assuntosCobertos" liste, copiando exatamente, apenas os que foram realmente abordados NESTE TRECHO.\n` : '';
      const ctxMarcas = marcas.length ? `O aluno marcou estes momentos como importantes (mm:ss): ${marcas.join(', ')}.\n` : '';
      const partes = fatiarComOffsets(t, janelaChars(2000));
      const out = { titulo: '', resumo: '', topicos: [], termos: [], caiNaProva: [], duvidas: [], assuntosCobertos: [] };
      const vistos = { termo: new Set(), prova: new Set(), assunto: new Set() };
      for (let i = 0; i < partes.length; i++) {
        const r = await generateAI({
          contents: `${ctx}${ctxAss}${ctxMarcas}
TRECHO ${i + 1} de ${partes.length}:
${partes[i].texto}`,
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
        if (!out.titulo && j.titulo) out.titulo = String(j.titulo);
        if (j.resumo) out.resumo += (out.resumo ? '\n\n' : '') + String(j.resumo);
        for (const tp of (j.topicos || [])) if (tp && tp.titulo) out.topicos.push({ titulo: String(tp.titulo), pontos: (tp.pontos || []).map(String) });
        for (const tm of (j.termos || [])) { const k = String(tm?.termo || '').trim().toLowerCase(); if (k && !vistos.termo.has(k)) { vistos.termo.add(k); out.termos.push({ termo: String(tm.termo), definicao: String(tm.definicao || '') }); } }
        for (const p of (j.caiNaProva || [])) { const k = String(p).trim().toLowerCase(); if (k && !vistos.prova.has(k)) { vistos.prova.add(k); out.caiNaProva.push(String(p)); } }
        for (const d of (j.duvidas || [])) out.duvidas.push(String(d));
        for (const a of (j.assuntosCobertos || [])) { const k = String(a).trim().toLowerCase(); if (k && !vistos.assunto.has(k)) { vistos.assunto.add(k); if (assuntosPlano.includes(String(a))) out.assuntosCobertos.push(String(a)); } }
      }
      out.assuntosCobertos = out.assuntosCobertos.filter(a => assuntosPlano.includes(a));
      res.json({ success: true, resultado: out });
    } catch (err) {
      console.error('[Aula processar]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });
}

export { dividir };
