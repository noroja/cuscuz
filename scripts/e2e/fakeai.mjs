// IA falsa (formato OpenAI) que registra concorrência e responde conforme o prompt.
import http from 'node:http';
const port = +process.argv[2]; let voo = 0, max = 0; const log = [];
const dormir = ms => new Promise(r => setTimeout(r, ms));
http.createServer((req, res) => {
  const p = []; req.on('data', d => p.push(d)); req.on('end', async () => {
    if (req.url === '/__stats') { res.end(JSON.stringify({ max, log })); return; }
    const b = JSON.parse(Buffer.concat(p).toString() || '{}'); const txt = (b.messages || []).map(m => m.content).join('\n');
    voo++; max = Math.max(max, voo);
    let tipo = 'outro', saida = 'texto';
    if (/Inventarie os tópicos/.test(txt)) { tipo = 'mapa'; saida = JSON.stringify({ capitulos: [1, 2, 3, 4].map(i => ({ titulo: 'Tema ' + i, pontos: ['p' + i], paragrafoFim: i })), temQuestoes: false }); await dormir(100); }
    else if (/Escreva SOMENTE o capítulo (\d+)/.test(txt) || /escreva SOMENTE o capítulo (\d+)/.test(txt)) { tipo = 'cap'; const n = (/capítulo (\d+) de/.exec(txt) || [])[1]; saida = `## ${n}.0 — Cap ${n}\n\nconteúdo do capítulo ${n}`; await dormir(500); }
    else if (/Síntese do trecho/.test(txt)) { tipo = 'fech'; saida = '### Síntese do trecho\n- ligação\n### Memória do trecho\n- fato'; await dormir(200); }
    else if (/Crie flashcards/.test(txt)) { tipo = 'fc'; saida = JSON.stringify([{ frente: 'F1', verso: 'V1', tema: 'Tema 1' }, { frente: 'F2', verso: 'V2' }]); await dormir(300); }
    else if (/monitor de Medicina/.test(txt)) { tipo = 'proc'; saida = JSON.stringify({ titulo: 'T', resumo: 'r', topicos: [{ titulo: 'a', pontos: ['x'] }], caiNaProva: ['cai isto'], assuntosCobertos: [] }); await dormir(300); }
    else if (/revisa transcrições/.test(txt)) { tipo = 'rev'; saida = 'TEXTO REVISADO\n\n' + txt.slice(txt.indexOf('TEXTO:\n') + 7); await dormir(300); }
    log.push(tipo);
    voo--;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: saida }, finish_reason: 'stop' }], usage: { total_tokens: 10 }, model: 'fake' }));
  });
}).listen(port);
