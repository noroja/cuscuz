// Materiais de uma aula que ficam em pastas IRMÃS da pasta do vídeo.
// Ex.: .../01 - Arritmias I/Video aula (vídeo) e .../01 - Arritmias I/Apostila (HTML/PDF).
const NOME_DE_MATERIAL = /apostila|resumo|material|materiais|pdf|slide|b[oô]nus|mapa/i;
const EH_HTML = (n) => /\.(html?|htm)$/i.test(n || '');
const EH_PDF = (n) => /\.pdf$/i.test(n || '') || /\.(docx?|pptx?)$/i.test(n || '');

/**
 * @param {Record<string,{name?:string,parent?:string|null}>} folders  mapa id -> pasta
 * @param {{id:string,d?:string,pid?:string}[]} materials              materiais do catálogo
 * @param {string} pastaDoVideo
 * @returns {{pdfs:object[],apostilas:object[]}|null}
 */
export function materiaisDeIrmaos(folders, materials, pastaDoVideo) {
  const avo = folders && folders[pastaDoVideo] && folders[pastaDoVideo].parent;
  if (!avo) return null;
  const irmas = new Set(Object.keys(folders).filter((id) =>
    id !== pastaDoVideo && folders[id].parent === avo && NOME_DE_MATERIAL.test(folders[id].name || '')));
  if (!irmas.size) return null;

  // pasta (filha direta do avô) à qual um arquivo pertence, mesmo que esteja em subpasta
  const raiz = (pid) => {
    let cur = pid; let guarda = 0;
    while (cur && folders[cur] && folders[cur].parent !== avo && guarda++ < 12) cur = folders[cur].parent;
    return cur && folders[cur] && folders[cur].parent === avo ? cur : null;
  };

  const pdfs = []; const apostilas = [];
  const vistos = new Set();
  for (const m of materials || []) {
    if (!m || !m.pid || !irmas.has(raiz(m.pid))) continue;
    const nome = String(m.d || '');
    const chave = nome.toLowerCase();
    if (vistos.has(chave)) continue;
    if (EH_HTML(nome)) { vistos.add(chave); apostilas.push({ id: m.id, nome, isHtml: true }); }
    else if (EH_PDF(nome)) { vistos.add(chave); pdfs.push({ id: m.id, nome, isHtml: false }); }
  }
  return pdfs.length || apostilas.length ? { pdfs, apostilas } : null;
}
