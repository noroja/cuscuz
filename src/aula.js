// Aula do dia — transcrição fiel por trechos, revisão do texto, resumo (estilo pedagógico por padrão; "Crônicas de Residência" opcional) e flashcards
import { Type, transcribeAudio, aiJanelaChars, aiStatus } from './ai-provider.js';
import { relatorio as relatorioQualidade } from './aula-qualidade.js';

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

// Estilo PEDAGÓGICO (padrão): material de estudo hierárquico, fiel à aula, com mecanismos explicados em cadeia causal.
const REGRAS_PEDAGOGICAS = `Você escreve material de estudo médico APROFUNDADO, esquematizado e didático para provas de Residência e para o raciocínio clínico. Português do Brasil, Markdown.

FIDELIDADE (inviolável):
- Baseie TODAS as afirmações na transcrição. Preserve exatamente números, doses, unidades, classificações, critérios diagnósticos, exceções e ressalvas ditas pelo professor.
- Não invente diretrizes, referências, condutas, estatísticas nem "incidência em prova". Se a fonte for omissa, contraditória ou incompreensível, sinalize: "⚠️ A aula não detalha..." / "⚠️ Trecho incerto...".
- Se complementar com conhecimento externo para ligar ideias (fisiologia de base, por exemplo), faça em bloco separado iniciado por "> 📎 **Complemento (não dito na aula):**" e curto. Tudo o que não estiver nesses blocos deve ter vindo da aula.
- Cobertura integral do trecho: nada de "entre outros"/"etc." que esconda itens ditos; condense a redação, nunca o conteúdo. Não omita detalhe importante só para economizar espaço.
- NÃO invente questões. Só inclua uma questão se o professor a leu/comentou, com banca/ano se citados.

ESTRUTURA de cada assunto (use os blocos que couberem ao conteúdo; pule os que a aula não sustenta, sem encher linguiça):
### Conceito central
Definição objetiva e contexto.
### Fundamentos
Anatomia, fisiologia, bioquímica ou fisiopatologia necessárias para entender o assunto (apenas o que a aula traz; extras só como 📎 Complemento).
### Mecanismo explicado
Cadeia causal numerada ou com setas: Causa → Mecanismo → Alteração fisiológica → Manifestação clínica → Consequência. Explique o PORQUÊ de cada elo, não só o nome.
### Aplicação clínica
Sinais, sintomas, exames, diagnóstico, conduta, conforme a aula. Algoritmos como "Se X → conduta A / Se Y → conduta B" ou tabela de decisão (nunca espremidos em parágrafo).
### Esquema
Tabelas comparativas, hierarquias, fluxogramas em texto, sequências — o que organizar visualmente.
### Pontos para a prova
Bullets objetivos: o que o professor enfatizou/indicou que cai, pegadinhas, valores de corte, exceções. Sem estatísticas inventadas.
### Revisão final do capítulo
Síntese dos conceitos indispensáveis em 3 a 6 bullets.

FORMATAÇÃO: títulos hierárquicos; **negrito** para termos-chave e dados de prova; blocos curtos com linha em branco entre eles; sem blocos extensos sem organização; sem repetir informação entre seções do mesmo capítulo; termos técnicos explicados na primeira ocorrência.`;

const dividir = (texto, max = 9000) => {
  const paragrafos = String(texto || '').split(/\n{2,}/);
  const blocos = []; let atual = '';
  for (const p of paragrafos) {
    if ((atual + '\n\n' + p).length > max && atual) { blocos.push(atual); atual = p; } else atual = atual ? atual + '\n\n' + p : p;
  }
  if (atual) blocos.push(atual);
  return blocos;
};

// ── Orçamento por requisição (consciente do roteamento) ──
// Com o Gemini no fluxo (AI_PROVIDER=auto com as 2 chaves, ou gemini fixado), a janela é ampla:
// a transcrição INTEIRA da aula vai em 1 chamada (contexto de ~1M tokens do Gemini). Sem Gemini,
// a janela respeita o teto de TPM da Groq (8000 no free tier) e o provider espera o retry-after.
const janelaChars = (reservaTokens) => aiJanelaChars(reservaTokens);

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

// Prompt do Whisper (limite de 224 tokens ≈ 700 caracteres; o modelo dá mais peso ao FINAL do prompt):
// contexto e glossário primeiro, e por último a ponta do trecho anterior — dá continuidade ao corte de 90 s.
export function promptWhisper({ disciplina = '', tema = '', termos = [], anterior = '' } = {}) {
  const cabeca = [disciplina && ('Aula de ' + disciplina + (tema ? ': ' + tema : '') + '.'), termos.length && ('Termos: ' + termos.join(', '))].filter(Boolean).join(' ').slice(0, 430);
  let ponta = String(anterior || '').replace(/\s+/g, ' ').trim().slice(-220);
  const sp = ponta.indexOf(' '); if (ponta.length >= 220 && sp > 0) ponta = ponta.slice(sp + 1); // não começa no meio de uma palavra
  return [cabeca, ponta].filter(Boolean).join(' ').slice(-700);
}


// ── Fase 2: "ler uma vez, derivar muitas" ──
// /api/aula/extrair lê a transcrição UMA vez e devolve uma base estruturada (fatos, sínteses, termos, "cai na prova"…).
// Fechamento, flashcards e processar aceitam `base` e trabalham a partir dela, sem reler a aula.
const baseValida = (b) => !!b && typeof b === 'object' && Array.isArray(b.fatos) && b.fatos.length > 0;
const baseEmTexto = (b) => [
  ...(b.sintese || []).map(x => 'SÍNTESE: ' + x),
  ...b.fatos.map(f => `[${f.capitulo || 'geral'}] (${f.tipo || 'fato'}) ${f.texto}`),
  ...(b.termos || []).map(t => `TERMO: ${t.termo} = ${t.definicao}`),
  ...(b.caiNaProva || []).map(x => 'CAI NA PROVA: ' + x)
].join('\n');

export function registerAula(app, { generateAI, aiConfigured }) {
  const exigeIA = (res) => { if (!aiConfigured()) { res.status(503).json({ success: false, msg: 'GROQ_API_KEY não configurada.' }); return false; } return true; };

  // gemini = há IA de TEXTO (qualquer provedor; nome legado). transcricao = há transcrição (Whisper da Groq ou, de reserva, áudio no Gemini; sem Gemini/Groq não há).
  // paralelo = quantas chamadas de texto o cliente pode disparar juntas sem estourar o teto por minuto:
  // só Groq (8000 TPM no free tier) → 1; com Gemini/OpenRouter na fila → 3.
  app.get('/api/aula/status', (_req, res) => {
    const st = aiStatus();
    const soGroq = st.provider === 'groq' || (st.provider === 'auto' && st.groq && !st.gemini && !st.openrouter);
    res.json({ success: true, gemini: !!aiConfigured(), texto: !!aiConfigured(), transcricao: !!(st.groq || st.gemini), transcricaoReserva: !!(st.groq && st.gemini), paralelo: soGroq ? 1 : st.workflow.fila.limites.total, ia: st });
  });

  // 1) Transcreve um trecho de áudio fielmente
  app.post('/api/aula/transcrever', async (req, res) => {
    try {
      if (!aiConfigured()) return res.status(503).json({ success: false, msg: 'Transcrição indisponível: GROQ_API_KEY não configurada.' });
      const { audio = '', mime = 'audio/webm', disciplina = '', tema = '', anterior = '', glossario = [] } = req.body || {};
      if (!audio || audio.length < 200) return res.status(400).json({ success: false, msg: 'Áudio vazio.' });
      if (audio.length > 28 * 1024 * 1024) return res.status(413).json({ success: false, msg: 'Trecho de áudio grande demais.' });
      const mimeBase = String(mime).split(';')[0] || 'audio/webm';
      const termos = (Array.isArray(glossario) ? glossario : []).map(String).filter(Boolean).slice(0, 80);
      const ria = await transcribeAudio({ audioBase64: audio, mime: mimeBase, language: 'pt', timestamps: true, prompt: promptWhisper({ disciplina, tema, termos, anterior }) });
      let texto = typeof ria === 'string' ? ria : ria.texto;
      const segmentos = (ria && typeof ria === 'object' && Array.isArray(ria.segmentos)) ? ria.segmentos : [];
      if (/^\[sem fala\]$/i.test(texto)) texto = '';
      res.json({ success: true, texto, segmentos });
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
      const r = await generateAI({ task: "aula_revisar",
        contents: `Você revisa transcrições de aulas de Medicina (área: ${area || 'não informada'}; conteúdo: ${conteudo || 'não informado'}).
Revise o texto abaixo SEM mudar o significado nem remover informação:
- corrija erros de reconhecimento de fala e a grafia de termos médicos, siglas e fármacos (use o contexto da aula);
- una frases cortadas na emenda entre trechos, remova repetições acidentais da emenda e reconstrua pontuação e parágrafos;
- mantenha números, doses e unidades exatamente como estão; não resuma; não acrescente conteúdo; mantenha [inaudível] onde o trecho é irrecuperável; mantenha INTACTAS, cada uma na própria linha, as marcas do aluno "⭐ [mm:ss]" e "❓ [mm:ss]";
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
        const r = await generateAI({ task: "aula_mapa",
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
      // B) consolidação — entrada pequena (só fragmentos), cabe em qualquer teto.
      //    Com janela única (Gemini no fluxo), o modelo já entregou os capítulos finais — nada a fundir.
      if (partes.length > 1 && frgs.length > 1) {
        try {
          const r = await generateAI({ task: "aula_mapa_consolidar",
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
      const { transcricao = '', area = '', conteudo = '', capitulo = {}, numero = 1, total = 1, cor = COR_PADRAO, estilo = 'pedagogico' } = req.body || {};
      const cronicas = estilo === 'cronicas';
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
      const r = await generateAI({ task: "aula_capitulo",
        contents: `${cronicas ? REGRAS_CRONICAS : REGRAS_PEDAGOGICAS}

TAREFA: escreva SOMENTE o capítulo ${numero} de ${total} do volume (área: ${area || 'n/i'}; conteúdo da aula: ${conteudo || 'n/i'}). Comece direto por:
## ${numero}.0 — ${capitulo.titulo}
(breadcrumb em itálico logo abaixo: *${area || 'Aula'} — ${capitulo.titulo}*) e desenvolva ${cronicas ? 'a fórmula completa (Atos 1–8 que couberem)' : 'a estrutura pedagógica completa (blocos que couberem ao conteúdo)'}.
Pontos que este capítulo DEVE cobrir integralmente (do mapa prévio): ${JSON.stringify(capitulo.pontos || [])}.
${cronicas ? 'Cor de Magia do volume: ' + cor + ' (apenas registro; não altera o texto).\n' : ''}Não repita o que pertence a outros capítulos. Não escreva capa, índice, considerações finais nem gabarito geral. Sem preâmbulo e sem "CONTINUA".

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
      const { transcricao = '', area = '', conteudo = '', capitulos = [], temQuestoes = false, estilo = 'pedagogico' } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      if (baseValida(req.body.base)) {
        // Sem IA: as sínteses e os fatos já foram extraídos da aula (fiéis ao que foi dito).
        const b = req.body.base;
        const bl = (x) => '- ' + String(x).replace(/^\s*[-•]\s*/, '');
        const cons = (b.sintese || []).map(bl).join('\n') || '*(nada a sintetizar)*';
        const rev = b.fatos.map(f => `- ${f.tipo ? '**' + f.tipo + ':** ' : ''}${f.texto}`).join('\n');
        let md = `## Considerações Finais\n\n${cons}\n\n## Revisão Final — Fatos e Relações Essenciais\n\n${rev}`;
        if (temQuestoes) md += '\n\n## Gabarito Geral\n(as questões reais lidas na aula estão comentadas nos capítulos, nas caixas "BANCA | ANO" com gabarito em negrito)';
        if (estilo === 'cronicas') md += `\n\n— Fim deste volume das Crônicas · @cuscuz-klan —`;
        return res.json({ success: true, markdown: md.trim(), semIA: true });
      }
      const partes = fatiarComOffsets(t, janelaChars(2200));
      const separa = (md) => { const cons = [], rev = []; let alvo = null; for (const l of String(md).split('\n')) { if (/^#{1,4}.*(considera|síntese|sintese)/i.test(l)) alvo = cons; else if (/^#{1,4}.*(revis|fatos|memoriz)/i.test(l)) alvo = rev; else if (alvo) alvo.push(l); } return { cons, rev }; };
      const cons = [], rev = [];
      for (let i = 0; i < partes.length; i++) {
        const r = await generateAI({ task: "aula_fechamento",
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
      if (estilo === 'cronicas') md += `\n\n— Fim deste volume das Crônicas · @cuscuz-klan —`;
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
      const usaBase = baseValida(req.body.base);
      const partes = fatiarComOffsets(usaBase ? baseEmTexto(req.body.base).replace(/\n/g, '\n\n') : t, janelaChars(1800));
      const porParte = Math.max(6, Math.round(alvo / partes.length));
      const cartoes = []; const vistos = new Set();
      for (let i = 0; i < partes.length; i++) {
        const r = await generateAI({ task: "aula_flashcards",
          contents: `Crie flashcards de REVISÃO para residência médica a partir EXCLUSIVAMENTE deste ${usaBase ? 'RESUMO ESTRUTURADO de fatos extraídos da aula' : 'TRECHO de aula'} (parte ${i + 1} de ${partes.length}; área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}).
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
      if (baseValida(req.body.base)) {
        const b = req.body.base;
        const r = await generateAI({ task: "aula_processar",
          contents: `${ctx}Abaixo está um RESUMO ESTRUTURADO de fatos já extraídos da aula (não a transcrição). Produza o título, um resumo de 5 a 10 linhas e os tópicos agrupando os pontos, usando SOMENTE esses fatos.\n${baseEmTexto(b)}`,
          config: {
            temperature: 0.3, responseMimeType: 'application/json',
            responseSchema: { type: Type.OBJECT, required: ['titulo', 'resumo', 'topicos'], properties: {
              titulo: { type: S }, resumo: { type: S },
              topicos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['titulo', 'pontos'], properties: { titulo: { type: S }, pontos: { type: Type.ARRAY, items: { type: S } } } } }
            } }
          }
        });
        const j = JSON.parse(String(r.text).trim());
        const outB = { titulo: String(j.titulo || ''), resumo: String(j.resumo || ''),
          topicos: (j.topicos || []).filter(tp => tp && tp.titulo).map(tp => ({ titulo: String(tp.titulo), pontos: (tp.pontos || []).map(String) })),
          termos: (b.termos || []).filter(x => x && x.termo), caiNaProva: (b.caiNaProva || []).map(String), duvidas: (b.duvidas || []).map(String),
          assuntosCobertos: (b.assuntosCobertos || []).map(String).filter(a => assuntosPlano.includes(a)) };
        return res.json({ success: true, resultado: outB, semLerAula: true });
      }
      const partes = fatiarComOffsets(t, janelaChars(2000));
      const out = { titulo: '', resumo: '', topicos: [], termos: [], caiNaProva: [], duvidas: [], assuntosCobertos: [] };
      const vistos = { termo: new Set(), prova: new Set(), assunto: new Set() };
      for (let i = 0; i < partes.length; i++) {
        const r = await generateAI({ task: "aula_processar",
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

  // Verificação de fidelidade/cobertura SEM IA (números e doses fora da fonte, fatos não cobertos, cartões duplicados/não atômicos)
  app.post('/api/aula/qualidade', (req, res) => {
    try {
      const { fonte = '', resumoMd = '', flashcards = [], base = null } = req.body || {};
      if (String(fonte).trim().length < 50) return res.status(400).json({ success: false, msg: 'Fonte (transcrição) ausente.' });
      res.json({ success: true, relatorio: relatorioQualidade({ fonte: String(fonte), resumoMd: String(resumoMd), flashcards: Array.isArray(flashcards) ? flashcards.slice(0, 300) : [], base }) });
    } catch (err) { console.error('[Aula qualidade]', err); res.status(500).json({ success: false, msg: err.message }); }
  });

  // 7b) EXTRAÇÃO ÚNICA (fase 2): lê a transcrição por janelas e devolve a base de fatos para derivar o resto sem reler.
  app.post('/api/aula/extrair', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', capitulos = [], assuntosPlano = [], marcas = [], duvidasMarcas = [] } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      const nomeCaps = capitulos.map(c => c.titulo || c).filter(Boolean);
      const partes = fatiarComOffsets(t, janelaChars(2400));
      const base = { fatos: [], sintese: [], termos: [], caiNaProva: [], duvidas: [], assuntosCobertos: [] };
      const vistos = { fato: new Set(), termo: new Set(), prova: new Set() };
      const ass = assuntosPlano.length ? `Assuntos esperados na prova: ${JSON.stringify(assuntosPlano.slice(0, 60))}. Em "assuntosCobertos" copie exatamente só os realmente abordados NESTE TRECHO.\n` : '';
      const mk = (marcas.length ? `O aluno marcou estes momentos como importantes (mm:ss): ${marcas.join(', ')}.\n` : '') + (duvidasMarcas.length ? `Linhas "❓ [mm:ss]" no texto são momentos em que o ALUNO teve dúvida (${duvidasMarcas.join(', ')}): em "duvidas" registre, para cada uma que aparecer neste trecho, o ponto que o professor explicava logo antes, no formato "[mm:ss] assunto".\n` : '');
      for (let i = 0; i < partes.length; i++) {
        const r = await generateAI({ task: "aula_extrair",
          contents: `Você é um monitor de Medicina. Extraia, SOMENTE do TRECHO ${i + 1} de ${partes.length} desta aula (área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}), uma base de estudo fiel ao que o professor disse. Nada de conhecimento externo; preserve números, doses, cortes e ressalvas exatamente. Português do Brasil.
- "fatos": um item por fato memorizável, com "tipo" (numero, dose, criterio, conduta, classificacao, pegadinha, definicao, mnemonico ou questao), "texto" curto e completo e "capitulo"${nomeCaps.length ? ' (preferir um destes: ' + JSON.stringify(nomeCaps) + ')' : ''}.
- "sintese": 3 a 6 bullets amarrando os conceitos centrais do trecho entre si.
- "termos": termo e definição dados na aula. "caiNaProva": o que o professor indicou que cai ou enfatizou. "duvidas": falas que pareçam imprecisas.
${ass}${mk}TRECHO:
${partes[i].texto}`,
          config: { temperature: 0.2, responseMimeType: 'application/json',
            responseSchema: { type: Type.OBJECT, required: ['fatos', 'sintese'], properties: {
              fatos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['texto'], properties: { tipo: { type: S }, texto: { type: S }, capitulo: { type: S } } } },
              sintese: { type: Type.ARRAY, items: { type: S } },
              termos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['termo', 'definicao'], properties: { termo: { type: S }, definicao: { type: S } } } },
              caiNaProva: { type: Type.ARRAY, items: { type: S } },
              duvidas: { type: Type.ARRAY, items: { type: S } },
              assuntosCobertos: { type: Type.ARRAY, items: { type: S } }
            } } }
        });
        const j = JSON.parse(String(r.text).trim());
        for (const f of (j.fatos || [])) { const k = String(f?.texto || '').trim().toLowerCase(); if (k && !vistos.fato.has(k)) { vistos.fato.add(k); base.fatos.push({ tipo: String(f.tipo || ''), texto: String(f.texto), capitulo: String(f.capitulo || '') }); } }
        for (const x of (j.sintese || [])) if (String(x).trim()) base.sintese.push(String(x));
        for (const tm of (j.termos || [])) { const k = String(tm?.termo || '').trim().toLowerCase(); if (k && !vistos.termo.has(k)) { vistos.termo.add(k); base.termos.push({ termo: String(tm.termo), definicao: String(tm.definicao || '') }); } }
        for (const p of (j.caiNaProva || [])) { const k = String(p).trim().toLowerCase(); if (k && !vistos.prova.has(k)) { vistos.prova.add(k); base.caiNaProva.push(String(p)); } }
        for (const d of (j.duvidas || [])) base.duvidas.push(String(d));
        for (const a of (j.assuntosCobertos || [])) if (assuntosPlano.includes(String(a)) && !base.assuntosCobertos.includes(String(a))) base.assuntosCobertos.push(String(a));
      }
      if (!base.fatos.length) return res.status(502).json({ success: false, msg: 'A extração não encontrou fatos.' });
      res.json({ success: true, base });
    } catch (err) {
      console.error('[Aula extrair]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 8) RESUMO GERAL — material de estudo autossuficiente, extremamente detalhado (Markdown)
  app.post('/api/aula/resumo-geral', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', parte = '', capitulos = [] } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 100) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      const capRoteiro = (capitulos || []).length
        ? `Roteiro da aula (guia de cobertura — NADA pode ficar fora): ${JSON.stringify((capitulos || []).map(c => ({ titulo: c.titulo, pontos: (c.pontos || []).slice(0, 10) })))}\n`
        : '';
      const ctx = `Fonte: aula de Medicina (área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}${parte && parte !== 'Única' ? '; ' + parte : ''}).\n${capRoteiro}`;

      const REGRAS_RESUMO_GERAL = `Você escreve um RESUMO GERAL EXTREMAMENTE DETALHADO e abrangente de TODO o conteúdo relevante da fonte, material de estudo AUTOSUFICIENTE, fiel e útil para compreender e revisar o assunto, em MARKDOWN.

ANTES DE REDIGIR: examine a fonte por completo e organize tópicos e subtópicos — não deixe de fora conceitos, seções, exemplos, ressalvas ou relações importantes. Desenvolva cada tópico com profundidade proporcional ao conteúdo; não limite a síntese curta.

FIDELIDADE (inviolável): baseie TODAS as afirmações na transcrição; preserve números, nomes, unidades, condições e ressalvas EXATAMENTE como ditos; não invente dados nem apresente inferência como fato; se a fonte for omissa, contraditória ou incerta, sinalize com ⚠️ explicitamente; condensar é reescrever melhor, NUNCA omitir. Explique termos técnicos na primeira ocorrência.

ESTRUTURA (hierarquia sem saltos de nível): título principal (#), visão geral e índice, capítulos (##), seções (###) e subseções (####), com nomes informativos.
EM CADA TEMA, quando aplicável: **definição e terminologia**; contexto e fundamentos; componentes, tipos e classificações; etapas, mecanismos e relações de causa e efeito (listas numeradas); características e exemplos; aplicações ou consequências; critérios, procedimentos e condutas; vantagens, limitações, exceções e condições; distinções entre conceitos semelhantes (*negrito-itálico* nos pares que costumam ser confundidos); conexões com os demais temas.
FORMATAÇÃO: **negrito** em termos-chave, definições e dados de prova; listas numeradas para sequências; bullets para conjuntos; tabelas com cabeçalhos claros para comparações/classificações; parágrafos legíveis; alertas e pontos de fixação apenas quando sustentados pela fonte.
FECHO OBRIGATÓRIO: ## Síntese Integradora (relações entre os temas centrais) e ## Revisão de Véspera (única lista densa de memorização: números, doses, cortes de ponto, critérios, escores, condutas de escolha, pegadinhas).
NÃO gere quiz. Comece direto pelo título do resumo.`;

      const partes = fatiarComOffsets(t, janelaChars(2400));
      let md = '';
      for (let i = 0; i < partes.length; i++) {
        const adicional = partes.length > 1
          ? `\n\nObs.: este é o TRECHO ${i + 1} de ${partes.length} da transcrição. Redija SOMENTE as seções correspondentes ao que o trecho traz${i === 0 ? ' (comece pelo título e pelo índice)' : ' (sem repetir índice/título; continue a hierarquia)'};\n`
          : '';
        const r = await generateAI({ task: "aula_resumo",
          contents: `${ctx}${REGRAS_RESUMO_GERAL}${adicional}
FONTE (transcrição da aula):
${partes[i].texto}`,
          config: { temperature: 0.25 }
        });
        md += (md ? '\n\n' : '') + String(r.text || '').trim();
      }
      res.json({ success: true, markdown: md.trim() });
    } catch (err) {
      console.error('[Aula resumo-geral]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // 9) MAPA MENTAL — árvore hierárquica (até 4 níveis) para renderização interativa no app
  app.post('/api/aula/mapa-mental', async (req, res) => {
    try {
      if (!exigeIA(res)) return;
      const { transcricao = '', area = '', conteudo = '', capitulos = [] } = req.body || {};
      const t = String(transcricao).trim();
      if (t.length < 80) return res.status(400).json({ success: false, msg: 'Transcrição curta demais.' });
      const roteiro = (capitulos || []).length ? `Concentre a estrutura nos capítulos já mapeados (nada pode faltar, nada inventado): ${JSON.stringify((capitulos || []).map(c => ({ titulo: c.titulo, pontos: (c.pontos || []).slice(0, 8) })))}\n` : '';
      const r = await generateAI({ task: "aula_mapa_mental",
        contents: `Monte o MAPA MENTAL hierárquico desta aula de Medicina (área: ${area || 'n/i'}; conteúdo: ${conteudo || 'n/i'}).
Estrutura: "t" do nó raiz (tema central da aula, 2-5 palavras); filhos (2 a 7): temas grandes da aula; cada tema tem filhos (2 a 7): subtemas; cada subtema tem filhos (1 a 6 FOLHAS): pontos curtos e memoráveis (máx. 8 palavras; cite números/doses/nomes EXATAMENTE como ditos quando foram ditos).
Fidelidade: só o que está na fonte; sem jargão vago ("outros assuntos"); sem repetir o mesmo nó em ramos diferentes.
${roteiro}FONTE:
${t.slice(0, janelaChars(1200))}`,
        config: {
          temperature: 0.2, responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT, required: ['t'], properties: {
              t: { type: S },
              f: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['t'], properties: {
                t: { type: S },
                f: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['t'], properties: {
                  t: { type: S },
                  f: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['t'], properties: { t: { type: S } } } }
                } } }
              } } }
            }
          }
        }
      });
      const j = JSON.parse(String(r.text).trim());
      res.json({ success: true, raiz: normalizarArvore(j) });
    } catch (err) {
      console.error('[Aula mapa-mental]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });
}

// Amarra a árvore recebida da IA: limita níveis/ramos, corta títulos longos, descarta lixo.
export function normalizarArvore(no, nivel = 0) {
  if (!no || typeof no !== 'object' || !no.t) return null;
  const filhos = (Array.isArray(no.f) ? no.f : []).filter(x => x && x.t).slice(0, nosPorNivel(Math.max(0, nivel)));
  return { t: String(no.t).slice(0, 64), f: nivel >= 3 ? undefined : filhos.map(f => normalizarArvore(f, nivel + 1)).filter(Boolean) };
}
const nosPorNivel = (nivel) => [7, 7, 8, 8][Math.min(nivel, 3)];


export { dividir };
