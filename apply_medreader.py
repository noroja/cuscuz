import re

# Ler o arquivo
with open(r'C:\Users\Teste\Documents\Projeto Padrão\cuscuz\index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Adicionar link CSS do MedReader após <link rel="manifest">
old_css = '<link rel="manifest" href="/manifest.webmanifest">'
new_css = '<link rel="manifest" href="/manifest.webmanifest">\n<link rel="stylesheet" href="/src/medreader/medreader.css">'
if old_css in content:
    content = content.replace(old_css, new_css)
    print("CSS adicionado")
else:
    print("CSS link não encontrado")

# 2. Adicionar scripts JS antes de </body>
old_body_end = '<script src="/aula-dia.js"></script>\n</body>'
new_body_end = '<script src="/aula-dia.js"></script>\n<script src="/src/medreader/reader-core.js"></script>\n<script src="/src/medreader/reader-download.js"></script>\n<script src="/src/medreader/reader-modal.js"></script>\n<script src="/src/medreader/reader-integration.js"></script>\n</body>'
if old_body_end in content:
    content = content.replace(old_body_end, new_body_end)
    print("Scripts adicionados")
else:
    print("Scripts não encontrados - tentando alternativo")
    # Tentar achar apenas </body>
    if '</body>' in content:
        content = content.replace('</body>', '<script src="/src/medreader/reader-core.js"></script>\n<script src="/src/medreader/reader-download.js"></script>\n<script src="/src/medreader/reader-modal.js"></script>\n<script src="/src/medreader/reader-integration.js"></script>\n</body>')
        print("Scripts adicionados via </body>")

# 3. Substituir a função apostilaInlineOpen
old_func = '''// ═══ LEITOR DE APOSTILAS EMBUTIDO (inline) ═══
function apostilaInlineOpen(fileId, fileName) {
  const container = $('apostila-reader-inline');
  const frame = $('apostila-inline-frame');
  const loading = $('apostila-inline-loading');
  const titleEl = $('apostila-inline-title');

  container.style.display = 'block';
  titleEl.textContent = fileName || 'Apostila';
  loading.style.display = 'flex';
  frame.style.display = 'none';

  // Carrega o HTML processado do backend
  fetch(`/api/apostila/html/${encodeURIComponent(fileId)}`, {
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('cuscuz_token') || '') }
  })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(html => {
      frame.style.display = 'block';
      loading.style.display = 'none';
      const doc = frame.contentDocument || frame.contentWindow.document;
      doc.open();
      doc.write(html);
      doc.close();
      frame.onload = () => {
        // Aplica tema e fonte do medreader
        applyApostilaTheme();
        applyApostilaFont();
        // Extrai e renderiza o sumário (TOC)
        extractApostilaInlineToc(frame);
      };
    })
    .catch(err => {
      console.error('[Apostila Inline]', err);
      loading.innerHTML = `<i class="ph ph-warning-circle" style="font-size:40px;color:var(--rose)"></i><span>Erro ao carregar: ${err.message}</span>`;
    });
}

function apostilaInlineClose() {
  const container = $('apostila-reader-inline');
  const frame = $('apostila-inline-frame');
  container.style.display = 'none';
  frame.src = 'about:blank';
  apostilaState.currentId = null;
  apostilaState.currentName = null;
  apostilaState.toc = [];
  closeApostilaSidebar();
  document.body.style.overflow = '';
}'''

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

if old_func in content:
    content = content.replace(old_func, new_func)
    print("Função substituída com sucesso")
else:
    print("Função não encontrada exatamente. Tentando encontrar parte...")
    if 'function apostilaInlineOpen(fileId, fileName)' in content:
        print("Função existe mas com diferenças de whitespace")
    else:
        print("Função não encontrada")

# Salvar o arquivo
with open(r'C:\Users\Teste\Documents\Projeto Padrão\cuscuz\index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Arquivo salvo")
