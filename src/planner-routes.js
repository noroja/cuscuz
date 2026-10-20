import { Type } from './ai-provider.js';
import * as PE from './planner-engine.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

export const hojeBR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
export const okHoje = h => (/^\d{4}-\d{2}-\d{2}$/.test(h || '') ? h : hojeBR());

/* Streaming opcional para rotas de IA (Vercel corta conexões ociosas).
   O cliente pede SSE com Accept: text/event-stream (ou body.stream = true).
   Mandamos comentários a cada 10s para manter a conexão viva e, no fim,
   um evento "result" com o JSON que antes ia direto no res.json. */
export function enableSSE(req, res) {
  const quer = req.body?.stream === true || /text\/event-stream/i.test(req.headers.accept || '');
  if (!quer) return false;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  const ping = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (_) {} }, 10000);
  const parar = () => clearInterval(ping);
  res.on('close', parar);
  res.json = (obj) => {
    parar();
    try {
      res.write('event: result\ndata: ' + JSON.stringify(obj) + '\n\n');
      res.end();
    } catch (_) { /* conexão já encerrada */ }
    return res;
  };
  return true;
}

const PERFIL_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    objetivo: { type: Type.STRING, description: 'graduacao | residencia | ambos (vazio se não informado)' },
    alvo: { type: Type.STRING }, dataProva: { type: Type.STRING, description: 'YYYY-MM-DD' }, semData: { type: Type.BOOLEAN },
    provasFaculdade: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { disciplina: { type: Type.STRING }, data: { type: Type.STRING }, assuntos: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['disciplina', 'data'] } },
    semProvas: { type: Type.BOOLEAN },
    horas: { type: Type.ARRAY, items: { type: Type.INTEGER }, description: '7 valores em minutos: domingo..sábado' },
    dificuldades: { type: Type.ARRAY, items: { type: Type.STRING } }, fortes: { type: Type.ARRAY, items: { type: Type.STRING } }, semDificuldades: { type: Type.BOOLEAN },
    metodo: { type: Type.STRING, description: 'aulas | resumos | questoes | equilibrado' },
    cursos: { type: Type.ARRAY, items: { type: Type.STRING } },
    semConteudo: { type: Type.BOOLEAN }, conteudoConfirmado: { type: Type.BOOLEAN }, disciplinasConfirmadas: { type: Type.ARRAY, items: { type: Type.STRING } },
    anseios: { type: Type.STRING, description: 'restrições, rotina, preferências ou desejos livres ditos agora' }
  }
};

export function registerPlanner(app, { generateAI, aiConfigured, getBank }) {
  // GET /api/planner/v2/catalogo — o que existe no acervo
  app.get('/api/planner/v2/catalogo', (_req, res) => res.json({ success: true, ...PE.resumoCatalogo() }));

  // POST /api/planner/chat — entrevista adaptativa
  app.post('/api/planner/chat', async (req, res) => {
    enableSSE(req, res);
    const hoje = okHoje(req.body && req.body.hoje);
    try {
      const bruto = Array.isArray(req.body.messages) ? req.body.messages.slice(-14) : [];
      let perfil = PE.sanePerfil(req.body.perfil || null, {});
      // tudo que o aluno cola/escreve de longo vira "material" guardado (o mentor lê inteiro, sempre); no histórico fica só um aviso curto
      const novosMats = [];
      const msgs = bruto.map((m, i) => {
        const c = String(m.content || '');
        if (m.role === 'user' && c.length > 700) {
          novosMats.push({ nome: 'Enviado no chat em ' + hoje, texto: c.slice(0, 60000) });
          return { role: 'user', content: `(Enviei este material: "${c.slice(0, 120).replace(/\s+/g, ' ')}…" — ${c.length} caracteres, veja em MATERIAL ENVIADO PELO ALUNO.)` };
        }
        return { role: m.role === 'user' ? 'user' : 'model', content: c.slice(0, 3000) };
      });
      if (novosMats.length) perfil = PE.sanePerfil(perfil, { materiais: novosMats });
      const asking = req.body.asking || '';
      const ultima = [...msgs].reverse().find(m => m.role === 'user');
      const jaExtras = !!req.body.jaExtras;
      let usouIA = false, reply = '', quick = [], extrasPerguntado = jaExtras;

      // Cronograma colado (avaliações + aulas com data): leitura exata, sem IA, preservando o nome da disciplina
      const brutoUlt = Array.isArray(req.body.messages) ? [...req.body.messages].reverse().find(m => m && m.role === 'user') : null;
      const det = ultima ? PE.parseCronograma(String((brutoUlt && brutoUlt.content) || ultima.content).slice(0, 80000), hoje) : null;
      let notaDet = '';
      if (det && det.provas.length) {
        perfil = PE.mesclarCronograma(perfil, det);
        const prox = det.provas.filter(x => x.data >= hoje).sort((x, y) => x.data.localeCompare(y.data)).slice(0, 6).map(x => `${x.disciplina} ${x.tipo} ${x.data.slice(8)}/${x.data.slice(5, 7)}`).join('; ');
        const resumoDet = `Li o cronograma da faculdade: ${det.disciplinas ? det.disciplinas.length : 1} disciplina(s) (${det.disciplinas ? det.disciplinas.join(', ') : det.disciplina}), ${det.provas.length} avaliação(ões) e ${det.aulas.length} aula(s) com data. Próximas provas: ${prox || 'nenhuma futura'}. Os assuntos de cada prova ficaram na ordem das aulas.`;
        if (aiConfigured()) {
          // o mentor segue a conversa já sabendo do cronograma (o texto bruto não vai para a IA, só o resumo)
          msgs[msgs.lastIndexOf(ultima)] = { role: 'user', content: '(Enviei o cronograma da minha faculdade.)' };
          notaDet = resumoDet;
        } else {
          const q = PE.proximaPergunta(perfil, extrasPerguntado, hoje);
          return res.json({ success: true, ia: false, perfil, asking: q ? q.campo : '', jaExtras: extrasPerguntado, reply: resumoDet + (q ? '\n\n' + q.reply : '\n\nTudo certo — confira o resumo e gere o cronograma.'), quickReplies: q ? q.quick : ['Gerar meu cronograma'], pronto: PE.faltando(perfil, hoje).length === 0, resumo: PE.resumoPerfil(perfil) });
        }
      }
      if (ultima && aiConfigured()) {
        try {
          const falta = PE.faltando(perfil, hoje);
          const sistema = `Você é o mentor de estudos de um estudante de medicina brasileiro, dentro do app Cuscuz-MED. Hoje é ${hoje}. Conduza uma CONVERSA curta e natural (português do Brasil, tom próximo, sem enrolação) para montar um cronograma 100% personalizado.
Regras:
- Faça UMA pergunta por vez. Reconheça brevemente o que o aluno disse e adapte a próxima pergunta às respostas e anseios dele (cansaço, plantão, estágio, medo de uma matéria, etc.).
- Extraia tudo que ele disse para o campo "perfil" (apenas o que mudou). Datas em YYYY-MM-DD (ano atual ${hoje.slice(0, 4)} salvo indicação). horas = 7 inteiros em minutos [domingo, segunda, ..., sábado]. Se disser "não sei a data" use semData=true; "sem provas" semProvas=true; "sem dificuldade" semDificuldades=true.
- Matérias válidas do acervo: ${PE.DISCS.filter(d => d.peso > 0).map(d => d.nome).join(', ')}. Cursos: MEDCURSO, Estratégia, APOSTILAS.
- Quando o aluno informar provas da faculdade, o conteúdo de cada prova (assuntos) é ESSENCIAL: registre em provasFaculdade[].assuntos exatamente como ele escreveu, na ordem. Se faltar, peça e diga que ele pode anexar o PDF do manual do aluno com o botão de clipe. Se disser que não tem, semConteudo=true.
- Campos essenciais ainda faltando: ${falta.length ? falta.join(', ') : 'nenhum'} (prova=prova de residência e data; faculdade=provas da graduação com datas; conteudo=assuntos de cada prova da faculdade que ainda não vieram; conteudoOk=conferência do conteúdo com o aluno; horas; dificuldades; metodo=aulas/resumos/questoes/equilibrado).
- CONTEÚDO É PRIORIDADE: se alguma prova futura estiver sem assuntos (conteudo), pergunte ESPECIFICAMENTE por ela, uma disciplina por vez, citando o nome real e a data ("Qual o conteúdo da PR2 de Imagenologia, 18/11?") e lembre que ele pode colar o cronograma/ementa. Quando o conteúdo já estiver completo e ainda faltar conteudoOk, faça a CONFERÊNCIA POR DISCIPLINA, UMA DE CADA VEZ, sempre a indicada em "PRÓXIMA CONFERÊNCIA" abaixo: mostre ao aluno exatamente o que você leu daquela disciplina (provas com data, assuntos de cada uma e as aulas com datas) e pergunte "é isso mesmo?", convidando a incluir, tirar ou corrigir temas (professor reforçou? não cai? já domina?). Só quando ele confirmar ou corrigir, devolva disciplinasConfirmadas com o nome dessa disciplina (nunca mais de uma por resposta) e passe para a próxima. Acréscimos que ele ditou entram em provasFaculdade[].assuntos da prova certa; o resto vai em anseios. Só proponha gerar o cronograma quando todas estiverem confirmadas.
- Se faltar algo essencial, pergunte o primeiro que falta (a menos que o aluno tenha levantado algo urgente). Se nada falta, faça um resumo de 2 linhas do que entendeu e pergunte se quer ajustar algo antes de gerar; quickReplies = ["Gerar meu cronograma", "Quero ajustar algo"].
- O perfil traz provasFaculdade (cada prova com seus assuntos na ordem das aulas) e aulasFaculdade (data + tema de cada aula). Use isso: cite a próxima prova e as próximas aulas pelo nome real, aponte conflitos (várias provas na mesma semana), diga o que já passou e precisa de reforço e o que vem a seguir. NUNCA renomeie disciplinas nem mude provas/aulas já lidas; não devolva provasFaculdade/aulasFaculdade no perfil.
- Nunca invente aulas, links ou datas. Não prometa resultados. quickReplies: no máximo 4 respostas curtas e úteis para a sua pergunta.
${(req.body.nota || notaDet) ? 'Acabou de acontecer: ' + String(notaDet || req.body.nota).slice(0, 900) + ' (comente isso brevemente e siga para o que falta).' : ''}
PRÓXIMA CONFERÊNCIA: ${(() => { const d = PE.proximaConferencia(perfil, hoje); return d ? d + '\n' + PE.textoConferencia(perfil, d, hoje) : '(nenhuma pendente)'; })()}

MATERIAL ENVIADO PELO ALUNO (é a fonte de verdade: cronogramas, ementas, conteúdos de prova, pedidos — LEIA TUDO antes de responder; no começo da resposta confirme em 1 linha o que você leu dele, com nomes reais de disciplinas, provas e aulas; nunca generalize nem troque disciplinas):
${(perfil.materiais || []).map(m => '### ' + m.nome + '\n' + m.texto).join('\n\n').slice(0, 90000) || '(nenhum material enviado ainda)'}

Perfil atual (JSON, sem o material): ${JSON.stringify({ ...perfil, materiais: undefined })}`;
          const r = await generateAI({
            contents: msgs.map(m => ({ role: m.role, parts: [{ text: m.content }] })),
            config: {
              systemInstruction: sistema, temperature: 0.6, responseMimeType: 'application/json',
              responseSchema: { type: Type.OBJECT, properties: { reply: { type: Type.STRING }, perfil: PERFIL_SCHEMA, quickReplies: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['reply', 'perfil'] }
            }
          });
          const j = JSON.parse(r.text.trim());
          if (j && typeof j.reply === 'string' && j.reply.trim()) {
            const patchIA = Object.assign({}, j.perfil || {});
            if ((perfil.provasFaculdade || []).length) {
              // a IA só pode ACRESCENTAR assuntos a provas já lidas (mesma disciplina e data); não renomeia nem cria provas
              const ex = perfil.provasFaculdade.map(x => ({ ...x }));
              for (const ip of Array.isArray(patchIA.provasFaculdade) ? patchIA.provasFaculdade : []) {
                const alvo = ex.find(x => PE.norm(x.disciplina) === PE.norm(ip && ip.disciplina) && x.data === (ip && ip.data));
                if (alvo && Array.isArray(ip.assuntos)) alvo.assuntos = [...new Set([...(alvo.assuntos || []), ...PE.limparAssuntos(ip.assuntos, alvo.disciplina)])];
              }
              patchIA.provasFaculdade = ex; delete patchIA.aulasFaculdade;
            }
            { const pend = PE.proximaConferencia(perfil, hoje); const dc = Array.isArray(patchIA.disciplinasConfirmadas) ? patchIA.disciplinasConfirmadas : []; patchIA.disciplinasConfirmadas = (pend && ultima && dc.some(x => PE.norm(x) === PE.norm(pend))) ? [pend] : []; }
            perfil = PE.sanePerfil(perfil, patchIA);
            reply = j.reply.trim().slice(0, 1200);
            quick = (Array.isArray(j.quickReplies) ? j.quickReplies : []).map(q => String(q).slice(0, 60)).slice(0, 4);
            usouIA = true;
          }
        } catch (e) { console.warn('[Planner chat] IA indisponível, usando roteiro:', e.message); }
      }
      if (!usouIA && brutoUlt && String(brutoUlt.content || '').length > 500 && !(det && det.provas.length)) {
        // texto longo que não consegui entender com segurança: guardo como material, mas não invento provas a partir dele
        const q0 = PE.proximaPergunta(perfil, extrasPerguntado, hoje);
        return res.json({ success: true, ia: false, perfil, asking: q0 ? q0.campo : '', jaExtras: extrasPerguntado, reply: `Guardei o seu texto (${String(brutoUlt.content).length} caracteres), mas não consegui identificar com segurança as disciplinas, datas e aulas nesse formato — e prefiro não chutar. Formatos que eu leio: "1. Disciplina" com itens "* 04/08/26 (hora): conteúdo", ou calendário por data ("* **16/09**" com "* **07:50 às 10:30:** Disciplina - Tema"). Se puder, reenvie num deles.`, quickReplies: q0 ? q0.quick : [], pronto: false, resumo: PE.resumoPerfil(perfil) });
      }
      if (!usouIA) {
        const nota = String(req.body.nota || '').slice(0, 600);
        if (ultima && asking && !req.body.anexo) {
          const patch = PE.interpretarResposta(asking, ultima.content, hoje, perfil.provasFaculdade, perfil.disciplinasConfirmadas);
          if (asking === 'extras') extrasPerguntado = true;
          perfil = PE.sanePerfil(perfil, patch);
          if (!Object.keys(patch).length && asking !== 'extras') {
            const q = PE.proximaPergunta(perfil, extrasPerguntado, hoje);
            return res.json({ success: true, ia: false, perfil, asking: q ? q.campo : '', jaExtras: extrasPerguntado, reply: 'Não consegui entender essa resposta. ' + (q ? q.reply : ''), quickReplies: q ? q.quick : [], pronto: false, resumo: PE.resumoPerfil(perfil) });
          }
        }
        const q = PE.proximaPergunta(perfil, extrasPerguntado, hoje);
        if (q) { reply = q.reply; quick = q.quick; extrasPerguntado = extrasPerguntado || q.campo === 'extras'; return res.json({ success: true, ia: false, perfil, asking: q.campo, jaExtras: extrasPerguntado, reply: (nota ? nota + ' ' : ultima ? 'Anotado. ' : '') + reply, quickReplies: quick, pronto: false, resumo: PE.resumoPerfil(perfil) }); }
        reply = 'Perfeito, já tenho o que preciso. Confira o resumo abaixo e, se estiver certo, gere o cronograma.';
        quick = ['Gerar meu cronograma', 'Quero ajustar algo'];
      }
      const pronto = PE.faltando(perfil, hoje).length === 0 && (usouIA ? /gerar|ajust|resum|confer|certo/.test(reply.toLowerCase()) || msgs.length >= 8 : true);
      res.json({ success: true, ia: usouIA, perfil, asking: '', jaExtras: true, reply, quickReplies: quick, pronto: PE.faltando(perfil, hoje).length === 0 && pronto, resumo: PE.resumoPerfil(perfil) });
    } catch (err) {
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // POST /api/planner/manual — lê o manual do aluno/ementa (PDF ou texto) e extrai provas, conteúdo e aulas com data
  app.post('/api/planner/manual', async (req, res) => {
    enableSSE(req, res);
    const hoje = okHoje(req.body && req.body.hoje);
    try {
      const { nome = 'manual', mime = '', base64 = '', texto = '' } = req.body || {};
      let perfil = PE.sanePerfil(req.body.perfil || null, {});
      const ehPdf = /pdf/i.test(mime) || /\.pdf$/i.test(nome);
      let bytes = null, txt = String(texto || '');
      if (base64) { bytes = Buffer.from(base64, 'base64'); if (bytes.length > 18 * 1024 * 1024) return res.status(413).json({ success: false, msg: 'PDF muito grande (máx. 18 MB). Envie só as páginas de ementa/avaliações.' }); }
      if (bytes && !ehPdf) txt = bytes.toString('utf8');
      const prompt = `Este é o manual do aluno / plano de ensino de um curso de Medicina. Extraia SOMENTE o que está escrito no documento, sem inventar. Hoje é ${hoje}; datas sem ano são do ano letivo corrente (${hoje.slice(0, 4)}), formato YYYY-MM-DD.
REGRAS: (1) "nome" da disciplina = o nome MAIS ESPECÍFICO do módulo/área como aparece no documento (ex.: "Saúde Mental", "Cardiologia", "Pediatria"), nunca só o curso/ciclo genérico quando houver módulo. (2) "assuntos" = SOMENTE os temas de conteúdo cobrados (ex.: "Transtornos de ansiedade", "Esquizofrenia"), um por item, em ordem. NUNCA coloque neles datas, horários, nomes de prova (P1/PR1/Prova Teórica), professor, sala, nome de arquivo, o próprio nome da disciplina ou frases explicativas suas. Se o documento é só um calendário de avaliações sem conteúdo, deixe "assuntos" vazio. (3) Devolva as provas em ordem cronológica. Não repita a mesma prova.
Para cada disciplina/módulo informe: provas/avaliações (data, tipo como P1/P2/TBL/prática/recuperação, e a lista de ASSUNTOS/conteúdo programático cobrados naquela avaliação, na ordem em que aparecem, com nomes quase literais do documento) e, se o documento tiver cronograma por data, as aulas/TBLs/atividades (data + tema). Ignore regras administrativas.${req.body.conteudoProva ? '\nInformação extra do aluno (prioridade): ' + String(req.body.conteudoProva).slice(0, 3000) : ''}`;
      let ext = null, usouIA = false, lidoExato = false;
      if (bytes && ehPdf && !txt) {
        const tmp0 = path.join(os.tmpdir(), 'man0-' + Date.now() + '.pdf');
        fs.writeFileSync(tmp0, bytes);
        txt = await new Promise(ok => execFile('pdftotext', ['-layout', tmp0, '-'], { maxBuffer: 30 * 1024 * 1024 }, (err, out) => { try { fs.unlinkSync(tmp0); } catch (_) {} ok(err ? '' : out); }));
      }
      if (txt && txt.trim().length > 40) perfil = PE.sanePerfil(perfil, { materiais: [{ nome, texto: txt }] });
      const det = txt ? PE.parseCronograma(txt, hoje) : null;
      if (det && det.provas.length) {
        ext = { disciplinas: [{ nome: det.disciplina, provas: det.provas.map(x => ({ data: x.data, tipo: x.tipo, assuntos: x.assuntos })), aulas: det.aulas }] };
        lidoExato = true;
      }
      if (!ext && aiConfigured() && (bytes || txt)) {
        try {
          const partes = (bytes && ehPdf) ? [{ inlineData: { mimeType: 'application/pdf', data: base64 } }, { text: prompt }] : [{ text: prompt + '\n\nDOCUMENTO:\n' + txt.slice(0, 180000) }];
          const r = await generateAI({ contents: [{ role: 'user', parts: partes }], config: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: { type: Type.OBJECT, properties: { disciplinas: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { nome: { type: Type.STRING }, provas: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { data: { type: Type.STRING }, tipo: { type: Type.STRING }, assuntos: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['data'] } }, aulas: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { data: { type: Type.STRING }, tema: { type: Type.STRING } }, required: ['data', 'tema'] } } }, required: ['nome'] } } }, required: ['disciplinas'] } } });
          ext = JSON.parse(r.text.trim()); usouIA = true;
        } catch (e) { console.warn('[Planner manual] IA falhou:', e.message); }
      }
      if (!ext) {
        if (bytes && ehPdf && !txt) {
          const tmp = path.join(os.tmpdir(), 'man-' + Date.now() + '.pdf');
          fs.writeFileSync(tmp, bytes);
          txt = await new Promise(ok => execFile('pdftotext', ['-layout', tmp, '-'], { maxBuffer: 30 * 1024 * 1024 }, (err, out) => { try { fs.unlinkSync(tmp); } catch (_) {} ok(err ? '' : out); }));
        }
        const achadas = [];
        for (const l of txt.split(/\n/)) if (/prova|avalia|p1|p2|p3|tbl/i.test(l)) achadas.push(...PE.parseFaculdade(l, hoje));
        ext = { disciplinas: achadas.map(pr => ({ nome: pr.disciplina, provas: [{ data: pr.data, assuntos: pr.assuntos }] })) };
      }
      if (lidoExato) {
        const d0 = PE.parseCronograma(txt, hoje);
        perfil = PE.mesclarCronograma(perfil, d0);
        const reply0 = `Li o "${nome}" (${d0.disciplina}): ${d0.provas.length} avaliação(ões) e ${d0.aulas.length} aula(s) com data. Cada prova ficou com os assuntos das aulas dadas até ela, em ordem.`;
        return res.json({ success: true, ia: false, perfil, reply: reply0, resumo: PE.resumoPerfil(perfil), faltando: PE.faltando(perfil, hoje) });
      }
      const provas = (perfil.provasFaculdade || []).map(x => ({ ...x }));
      const aulas = [];
      for (const d of ext.disciplinas || []) {
        for (const pr of d.provas || []) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(pr.data || '')) continue;
          const ass = PE.limparAssuntos(pr.assuntos || [], d.nome);
          const ex = provas.find(x => PE.norm(x.disciplina) === PE.norm(d.nome) && x.data === pr.data);
          if (ex) ex.assuntos = [...new Set([...ass, ...(ex.assuntos || [])])];
          else provas.push({ disciplina: d.nome, data: pr.data, tipo: pr.tipo || '', assuntos: ass });
        }
        for (const a of d.aulas || []) if (/^\d{4}-\d{2}-\d{2}$/.test(a.data || '')) aulas.push({ disciplina: d.nome, data: a.data, tema: a.tema });
      }
      perfil = PE.sanePerfil(perfil, { provasFaculdade: provas, aulasFaculdade: aulas.length ? aulas : undefined, manualNome: nome, semProvas: false });
      const nAss = provas.reduce((a, x) => a + (x.assuntos || []).length, 0);
      const reply = (usouIA ? `Li o "${nome}". Encontrei ${provas.length} avaliação(ões), ${nAss} assuntos de prova e ${aulas.length} aula(s)/TBL(s) com data.` : `Recebi o "${nome}". Sem a chave do Gemini no servidor a leitura é simples: achei ${provas.length} prova(s) com data e ${nAss} assunto(s).${provas.some(x => !(x.assuntos || []).length) ? ' Diga aqui no chat o conteúdo das provas que ficaram sem assuntos.' : ''}`) + (provas.length ? ' Confira o resumo abaixo — se algo estiver errado, me diga que eu corrijo.' : ' Não achei provas com data; me diga as datas e o conteúdo aqui no chat.');
      res.json({ success: true, ia: usouIA, perfil, reply, resumo: PE.resumoPerfil(perfil), faltando: PE.faltando(perfil, hoje) });
    } catch (err) {
      console.error('[Planner manual]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // POST /api/planner/generate-tasks — cronograma real (aulas, PDFs, questões) a partir do perfil
  app.post('/api/planner/generate-tasks', (req, res) => {
    try {
      const hoje = okHoje(req.body.hoje);
      let perfil = PE.sanePerfil(null, req.body.perfil || {});
      // O cronograma que o aluno enviou é a fonte de verdade: relê todo material guardado e as mensagens longas do chat antes de gerar
      const fontes = [...(perfil.materiais || []).map(m => m.texto), ...(Array.isArray(req.body.textos) ? req.body.textos : []).map(x => String(x).slice(0, 80000))];
      const avisos = [];
      for (const tx of fontes) {
        const det0 = tx && tx.length > 150 ? PE.parseCronograma(tx, hoje) : null;
        if (det0 && det0.provas && det0.provas.length) perfil = PE.mesclarCronograma(PE.sanePerfil(perfil, { materiais: [{ nome: 'Cronograma enviado', texto: tx }] }), det0);
      }
      const semNome = (perfil.provasFaculdade || []).filter(x => /^prova da faculdade$|^disciplina$/.test(PE.norm(x.disciplina).trim()));
      if (semNome.length) avisos.push('Algumas provas estão sem o nome da disciplina (vieram de uma leitura antiga). Cole de novo o cronograma da faculdade no chat do planner.');
      const semConteudo = (perfil.provasFaculdade || []).filter(x => !(x.assuntos || []).length && x.data >= hoje);
      if (semConteudo.length) avisos.push('Sem conteúdo informado para: ' + [...new Set(semConteudo.map(x => x.disciplina))].slice(0, 6).join(', ') + '. Envie o cronograma de aulas dessas disciplinas.');
      if (!perfil.objetivo) return res.status(400).json({ success: false, msg: 'Perfil incompleto: falta o objetivo.' });
      const retidas = Array.isArray(req.body.retidas) ? req.body.retidas.filter(t => t && t.data && t.data < hoje && t.status === 'feito').slice(0, 2000) : [];
      const dias = req.body.dias ? Math.max(7, Math.min(120, +req.body.dias)) : undefined;
      const plan = PE.gerarTarefas({ perfil: { ...perfil, horas: perfil.horas || null }, hoje, inicio: hoje, dias, retidas, banco: typeof getBank === 'function' ? getBank() : null });
      plan.tarefas.forEach(t => delete t._vids);
      plan.avisos = avisos;
      res.json({ success: true, plan });
    } catch (err) {
      console.error('[Planner generate-tasks]', err);
      res.status(500).json({ success: false, msg: err.message });
    }
  });

  // POST /api/planner/enrich — IA reescreve passos/observações das tarefas com foco específico no tema
  app.post('/api/planner/enrich', async (req, res) => {
    enableSSE(req, res);
    try {
      if (!aiConfigured()) return res.json({ success: true, ia: false, itens: {} });
      const tarefas = (Array.isArray(req.body.tarefas) ? req.body.tarefas : []).filter(t => t && t.tipo === 'estudo').slice(0, 8);
      const p = PE.sanePerfil(null, req.body.perfil || {});
      if (!tarefas.length) return res.json({ success: true, ia: true, itens: {} });
      const entrada = tarefas.map(t => ({ id: t.id, disciplina: t.materia, tema: t.tema, titulo: t.titulo, contexto_da_faculdade: String(t.contexto || '').slice(0, 900), trechos_do_material_do_aluno: PE.trechosDoMaterial(p, String(t.tema || '').replace(/\([^)]*\)/g, ' '), 1800), passos: (t.passos || []).map(s => ({ acao: s.acao, minutos: s.minutos })) }));
      const r = await generateAI({
        contents: `Você é o mentor de estudos de um aluno de medicina (${p.objetivo === 'graduacao' ? 'prova da faculdade' : 'residência'}). Preferências/anseios do aluno: ${JSON.stringify({ metodo: p.metodo, dificuldades: p.dificuldades, fortes: p.fortes, anseios: p.anseios })}. Pedidos recentes dele no chat (respeite-os): ${JSON.stringify((Array.isArray(req.body.pedidos) ? req.body.pedidos : []).slice(-6).map(x => String(x).slice(0, 400)))}.
Reescreva o texto de cada passo (mesma ordem e mesmo "acao") de forma ESPECÍFICA e ACIONÁVEL para o tema, usando o "contexto_da_faculdade" (roteiro real da aula e assuntos da prova) e os "trechos_do_material_do_aluno" (o que ele mesmo enviou — cite os itens que aparecem lá, com as palavras dele):
- aula/resumo: liste os 3–5 pontos CONCRETOS do tema que precisam sair dominados (nomes de doenças, classificações, critérios, condutas de 1ª linha, sinais de alarme — só o que você tem certeza que é padrão), em ordem de cobrança provável; diga o que comparar com o quê.
- questoes: diga que tipo de questão treinar neste tema (ex.: caso clínico → próxima conduta; critério diagnóstico; diagnóstico diferencial) e como corrigir os erros.
- flashcards: dê 2–3 exemplos de cartões (pergunta curta → resposta curta) já sobre este tema.
Proibido: frases genéricas ("estude no seu material principal", "anote o essencial"), repetir o título, inventar doses/números/links ou citar aula que não esteja no contexto. 2–3 frases por passo, português do Brasil. Em "observacoes" (1 frase) diga como esta aula se liga à prova.
Tarefas: ${JSON.stringify(entrada)}`,
        config: {
          temperature: 0.4, responseMimeType: 'application/json',
          responseSchema: { type: Type.OBJECT, properties: { itens: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, passos: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { acao: { type: Type.STRING }, texto: { type: Type.STRING } }, required: ['acao', 'texto'] } }, observacoes: { type: Type.STRING } }, required: ['id', 'passos'] } } }, required: ['itens'] }
        }
      });
      const j = JSON.parse(r.text.trim());
      const itens = {};
      for (const it of j.itens || []) {
        const orig = tarefas.find(t => t.id === it.id);
        if (!orig || !Array.isArray(it.passos) || it.passos.length !== orig.passos.length) continue;
        if (!it.passos.every((s, i) => s.acao === orig.passos[i].acao && String(s.texto || '').length > 15)) continue;
        itens[it.id] = { passos: it.passos.map(s => String(s.texto).slice(0, 700)), observacoes: String(it.observacoes || '').slice(0, 400) };
      }
      res.json({ success: true, ia: true, itens });
    } catch (err) {
      console.warn('[Planner enrich]', err.message);
      res.json({ success: true, ia: false, itens: {} });
    }
  });
}
