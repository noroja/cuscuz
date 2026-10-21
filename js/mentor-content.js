/* JSON is data, Markdown is presentation. Never interpret document HTML. */
(function () {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const literal = value => String(value ?? '').replace(/([\\`*_[\]{}<>#+.!|~-])/g, '\\$1').replace(/\r?\n/g, ' ');
  const label = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, x => x.toUpperCase());
  function structured(value, depth = 0) {
    if (depth > 8) return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
    if (value == null) return '—';
    if (typeof value !== 'object') return literal(value);
    if (Array.isArray(value)) {
      if (!value.length) return '_Nenhum item informado._';
      const objects = value.every(x => x && typeof x === 'object' && !Array.isArray(x));
      const keys = objects ? [...new Set(value.flatMap(x => Object.keys(x)))] : [];
      if (objects && keys.length <= 6 && value.every(x => Object.values(x).every(v => v == null || typeof v !== 'object'))) {
        return '| ' + keys.map(k => literal(label(k))).join(' | ') + ' |\n| ' + keys.map(() => '---').join(' | ') + ' |\n' + value.map(x => '| ' + keys.map(k => literal(x[k] ?? '—')).join(' | ') + ' |').join('\n');
      }
      return value.map(x => '- ' + structured(x, depth + 1).replace(/\n/g, '\n  ')).join('\n');
    }
    return Object.entries(value).map(([k,v]) => typeof v === 'object' && v !== null
      ? '\n' + '#'.repeat(Math.min(6, depth + 3)) + ' ' + literal(label(k)) + '\n\n' + structured(v, depth + 1)
      : '**' + literal(label(k)) + ':** ' + literal(v)).join('\n\n');
  }
  function markdown(input) {
    let value = input;
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/^```json\s*\n([\s\S]*?)\n```$/i, '$1');
      if (/^[{[]/.test(trimmed)) { try { value = JSON.parse(trimmed); } catch (_) {} }
    }
    if (value && !Array.isArray(value) && typeof value === 'object') {
      for (const key of ['markdown', 'reply', 'content', 'resposta']) {
        if (typeof value[key] === 'string') return value[key];
      }
    }
    return typeof value === 'string' ? value : structured(value);
  }
  let parser;
  function render(input) {
    const text = markdown(input);
    if (!window.markdownit || !window.DOMPurify) return '<p>' + escape(text).replace(/\n/g, '<br>') + '</p>';
    if (!parser) {
      parser = window.markdownit({ html: false, breaks: true, linkify: false, typographer: false });
      const heading = (tokens, index, options, env, self) => {
        if (tokens[index].tag === 'h1') tokens[index].tag = 'h2';
        return self.renderToken(tokens, index, options);
      };
      parser.renderer.rules.heading_open = heading;
      parser.renderer.rules.heading_close = heading;
    }
    const clean = window.DOMPurify.sanitize(parser.render(text), {
      ALLOWED_TAGS: ['p','br','h2','h3','h4','h5','h6','strong','em','s','ul','ol','li','blockquote','pre','code','hr','a','table','thead','tbody','tr','th','td'],
      ALLOWED_ATTR: ['href','title','start'],
      ALLOW_DATA_ATTR: false
    });
    return clean.replace(/<table>/g, '<div class="mentor-table" role="region" aria-label="Tabela do documento" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>');
  }
  function documentPreview(doc) {
    if (!doc || !doc.texto) return '';
    return '<details class="mentor-document"><summary>Ver texto extraído · ' + escape(doc.nome || 'Documento') + '</summary><p class="mentor-document-note">Texto extraído do arquivo. Confira a leitura: a diagramação original do PDF pode não ser preservada.</p><div class="mentor-prose">' + render(doc.texto) + '</div></details>';
  }
  window.MentorContent = { markdown, render, documentPreview };
})();
