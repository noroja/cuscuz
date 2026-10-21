// Responsibilities are routing defaults, not claims of clinical accuracy.
const fast = ['groq', 'gemini', 'openrouter'];
const context = ['gemini', 'openrouter', 'groq'];
const writing = ['openrouter', 'gemini', 'groq'];
export const AI_TASKS = {
  aula_revisar: { label: 'Revisar transcrição', providers: fast },
  aula_mapa: { label: 'Organizar capítulos e fontes', providers: context },
  aula_mapa_consolidar: { label: 'Consolidar inventário', providers: fast },
  aula_capitulo: { label: 'Escrever capítulos', providers: writing, families: ['nvidia/', 'minimax/', 'google/gemma'] },
  aula_fechamento: { label: 'Sintetizar e fechar o material', providers: writing, families: ['minimax/', 'nvidia/', 'google/gemma'] },
  aula_flashcards: { label: 'Gerar flashcards', providers: writing, families: ['google/gemma', 'nvidia/', 'minimax/'] },
  aula_processar: { label: 'Extrair pontos de prova', providers: fast },
  aula_resumo: { label: 'Produzir visão geral', providers: context },
  aula_mapa_mental: { label: 'Estruturar mapa mental', providers: context },
  mentor_chat: { label: 'Conversar com o Mentor', providers: fast },
  documento: { label: 'Interpretar documentos', providers: context },
  planner_enrich: { label: 'Detalhar tarefas de estudo', providers: writing, families: ['nvidia/', 'minimax/', 'google/gemma'] },
  planner_associacoes: { label: 'Conferir relações entre temas', providers: fast },
  resumo_rapido: { label: 'Resumir tópicos curtos', providers: fast },
  questoes: { label: 'Gerar questões estruturadas', providers: writing, families: ['google/gemma', 'nvidia/', 'minimax/'] },
  tutor: { label: 'Orientar raciocínio de estudo', providers: fast },
  auto_feed: { label: 'Atualizar questões em segundo plano', providers: fast }
};

const parseOrder = value => [...new Set(String(value || '').toLowerCase().split(/[\s,>]+/).filter(n => ['groq', 'gemini', 'openrouter'].includes(n)))];
export function taskOrder(task) {
  const specific = /^[a-z_]+$/.test(task || '') ? process.env['AI_ORDER_' + task.toUpperCase()] : '';
  return parseOrder(specific || AI_TASKS[task]?.providers?.join(',') || process.env.AI_ORDER);
}
export function taskModels(task, models) {
  const families = AI_TASKS[task]?.families || [];
  const rank = model => { const i = families.findIndex(f => model.startsWith(f)); return i < 0 ? families.length : i; };
  return [...models].sort((a, b) => rank(a) - rank(b));
}

// Bounded, per-process queue. All routes using generateAI share this budget.
const integer = (value, fallback, max) => Math.min(max, Math.max(1, parseInt(value, 10) || fallback));
const limits = () => ({ total: integer(process.env.AI_MAX_PARALLEL, 3, 6), groq: 1, gemini: 2, openrouter: 2 });
const active = { groq: 0, gemini: 0, openrouter: 0 };
let total = 0;
const pending = [];
const busy = () => Object.assign(new Error('Fila de IA ocupada. Tente novamente em instantes.'), { code: 'ai_queue_busy' });
function drain() {
  const cap = limits();
  for (let i = 0; i < pending.length && total < cap.total;) {
    const job = pending[i];
    if (active[job.provider] >= cap[job.provider]) { i++; continue; }
    pending.splice(i, 1); clearTimeout(job.timer); total++; active[job.provider]++;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      total--; active[job.provider]--; drain();
    });
  }
}
export function runAiJob(provider, run, { background = false } = {}) {
  if (!(provider in active)) return Promise.reject(new Error('Provedor de IA desconhecido.'));
  if (pending.length >= 24) return Promise.reject(busy());
  return new Promise((resolve, reject) => {
    const job = { provider, run, resolve, reject, background, timer: null };
    job.timer = setTimeout(() => {
      const i = pending.indexOf(job);
      if (i >= 0) { pending.splice(i, 1); reject(busy()); }
    }, integer(process.env.AI_QUEUE_WAIT_MS, 15000, 60000));
    pending.push(job); pending.sort((a,b) => Number(a.background) - Number(b.background)); drain();
  });
}
export function workflowStatus() {
  return {
    tasks: Object.fromEntries(Object.entries(AI_TASKS).map(([task, p]) => [task, { descricao: p.label, ordem: taskOrder(task), familiasOpenRouter: p.families || [] }])),
    fila: { ativos: total, aguardando: pending.length, limites: limits() }
  };
}
