import re

with open(r'C:\Users\Teste\Documents\Projeto Padrão\cuscuz/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Encontrar o início e fim da função apostilaInlineOpen
start_pattern = r'// ═══ LEITOR DE APOSTILAS EMBUTIDO \(inline\) ═══\nfunction apostilaInlineOpen\(fileId, fileName\) \{'
end_pattern = r'\nfunction apostilaInlineClose\(\) \{'

start_match = re.search(start_pattern, content)
end_match = re.search(end_pattern, content)

if start_match and end_match:
    start_pos = start_match.start()
    end_pos = end_match.start()
    
    new_func = '''// ═══ LEITOR DE APOSTILAS EMBUTIDO (MedReader) ═══
let medReader = null;

function initMedReader() {
  if (medReader) return medReader;
  medReader = new MedReaderCore({
    container: '#medreader-reader-container',
    theme: 'default',
    fontSize: 'medium',
    fontFamily: 'sans'
  });
  return medReader;
}

function apostilaInlineOpen(fileId, fileName) {
  const reader = initMedReader();
  let container = $('medreader-reader-container');

  if (!container) {
    const wrap = document.createElement('div');
    wrap.id = 'apostila-reader-wrap';
    wrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#0a0a0a;z-index:9999;display:flex;flex-direction:column;overflow:hidden';
    document.body.appendChild(wrap);

    const tb = document.createElement('div');
    tb.id = 'apostila-reader-toolbar';
    tb.className = 'medreader-toolbar';
    tb.innerHTML = `
      <button onclick="medReader.setTheme('default')">Padrão</button>
      <button onclick="medReader.setTheme('sepia')">Sépia</button>
      <button onclick="medReader.setTheme('night')">Noturno</button>
      <select id="medreader-font-family"><option value="sans">Arial (Sans)</option><option value="serif">Times (Serif)</option><option value="mono">Courier (Mono)</option></select>
      <select id="medreader-font-size"><option value="small">Pequena</option><option value="medium" selected>Média</option><option value="large">Grande</option><option value="extra-large">Extra Grande</option></select>
      <button class="medreader-close" onclick="apostilaInlineClose()">Fechar</button>
    `;
    wrap.appendChild(tb);

    const rc = document.createElement('div');
    rc.id = 'medreader-reader-container';
    rc.style.cssText = 'flex:1;overflow:auto';
    wrap.appendChild(rc);

    document.body.style.overflow = 'hidden';

    document.getElementById('medreader-font-family').addEventListener('change', (e) => reader.setFontFamily(e.target.value));
    document.getElementById('medreader-font-size').addEventListener('change', (e) => reader.setFontSize(e.target.value));
  }

  container = $('medreader-reader-container');
  const tb = $('apostila-reader-toolbar');
  if (tb) tb.style.display = 'flex';

  fetch(`/api/apostila/html/${encodeURIComponent(fileId)}`, {
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('cuscuz_token') || '') }
  })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(html => {
      reader.loadContent(html);
    })
    .catch(err => {
      console.error('[Apostila Inline]', err);
      if (container) container.innerHTML = `<div style="padding:40px;color:var(--text-muted);text-align:center"><i class="ph ph-warning-circle" style="font-size:40px;color:var(--rose)"></i><div>Erro ao carregar: ${err.message}</div></div>`;
    });
}

function apostilaInlineClose() {
  const wrap = $('apostila-reader-wrap');
  if (wrap) {
    wrap.style.display = 'none';
    document.body.style.overflow = '';
  }
  if (medReader) {
    medReader.destroy();
    medReader = null;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const wrap = $('apostila-reader-wrap');
    if (wrap && wrap.style.display !== 'none') {
      apostilaInlineClose();
    }
  }
});'''

    new_content = content[:start_pos] + new_func + content[end_pos:]
    
    with open(r'C:\Users\Teste\Documents\Projeto Padrão\cuscuz/index.html', 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    print("Função substituída com sucesso!")
else:
    if not start_match:
        print("Start pattern não encontrado")
    if not end_match:
        print("End pattern não encontrado")
