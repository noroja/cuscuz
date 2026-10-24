// Núcleo único de orientação pedagógica da Aula do Dia.
// Perfis são guias combináveis; não são templates rígidos por especialidade.
export const PEDAGOGY_ENGINE_VERSION = 1;

const PERFIS = [
  { id: 'fisiopatologia', nome: 'Fisiopatologia', padroes: [/fisiopat/, /etiopatogen/, /mecanismo.*doenca/], guia: 'Priorize etiologia, mecanismos celulares e funcionais, alterações orgânicas e relações mecanismo-manifestação. Integre clínica quando a fonte permitir.' },
  { id: 'fisiologia', nome: 'Fisiologia', padroes: [/fisiolog/, /homeostase/, /regulacao/, /feedback/, /receptor/, /transportador/], guia: 'Priorize organização funcional, mecanismos regulatórios, feedback, integração entre sistemas e homeostase.' },
  { id: 'anatomia', nome: 'Anatomia', padroes: [/anatom/, /topograf/, /irrigacao/, /inervacao/, /drenagem/, /relacoes anatom/], guia: 'Priorize localização, relações espaciais, irrigação, inervação, drenagem, anatomia funcional e correlação clínica sustentada.' },
  { id: 'farmacologia', nome: 'Farmacologia', padroes: [/farmacolog/, /farmaco/, /medicament/, /posolog/, /farmacocinet/, /farmacodin/, /dose/], guia: 'Priorize alvo e mecanismo de ação, farmacodinâmica, farmacocinética, indicações, contraindicações, interações, efeitos adversos e segurança, somente quando presentes na fonte.' },
  { id: 'patologia', nome: 'Patologia', padroes: [/patolog/, /histolog/, /morfolog/, /lesao celular/, /anatomopat/, /neoplas/], guia: 'Priorize etiologia, mecanismos de lesão, alterações celulares e teciduais, morfologia e correlação anatomoclínica.' },
  { id: 'clinica-medica', nome: 'Clínica Médica', padroes: [/clinica medica/, /sindrome/, /diagnost/, /diagnostico diferencial/, /conduta/, /tratamento/, /seguimento/], guia: 'Priorize síndromes, hipóteses e diferenciais, anamnese e exame físico, investigação, interpretação, conduta, tratamento e seguimento conforme ensinados.' },
  { id: 'cirurgia', nome: 'Cirurgia', padroes: [/cirurg/, /operator/, /operat/, /procedimento cirurg/, /pre-operator/], guia: 'Priorize anatomia aplicada, indicações, avaliação pré-operatória, princípios técnicos, escolha do procedimento, complicações, recuperação e seguimento quando sustentados.' },
  { id: 'urgencias', nome: 'Terapia Intensiva e Emergências', padroes: [/terapia intensiva/, /emergenc/, /urgenc/, /choque/, /reanima/, /sepse/, /trauma/, /suporte organico/], guia: 'Priorize reconhecimento de gravidade, mecanismos agudos, prioridades de intervenção, monitorização, suporte orgânico e reavaliação. Não invente protocolos.' },
  { id: 'pediatria', nome: 'Pediatria', padroes: [/pediatr/, /neonat/, /puericultura/, /recem-nasc/], guia: 'Considere faixa etária, desenvolvimento, particularidades pediátricas e contexto familiar somente quando a fonte os abordar.' },
  { id: 'obstetricia-ginecologia', nome: 'Obstetrícia e Ginecologia', padroes: [/obstetr/, /ginecol/, /gestac/, /parto/, /puerper/, /pre-natal/], guia: 'Considere ciclo reprodutivo, gestação, parto, puerpério e saúde ginecológica de acordo com o tema e a fonte.' },
  { id: 'semiologia', nome: 'Semiologia', padroes: [/semiolog/, /anamnese/, /exame fisico/, /propedeut/], guia: 'Priorize técnica de anamnese e exame físico, significado dos achados, limitações e relação com hipóteses clínicas.' },
  { id: 'imagenologia', nome: 'Imagenologia', padroes: [/imagenolog/, /radiolog/, /tomograf/, /ultrassom/, /ressonancia/, /raio.?x/, /ecograf/, /imagem medica/], guia: 'Priorize modalidade, achados, interpretação, limitações e repercussões diagnósticas. Não infira achados não descritos.' },
  { id: 'saude-coletiva', nome: 'Saúde Coletiva e Preventiva', padroes: [/saude coletiva/, /medicina preventiva/, /epidemiolog/, /sus\b/, /rastreamento/, /vigilancia em saude/], guia: 'Priorize conceitos epidemiológicos, métodos, interpretação de indicadores, prevenção e aplicação populacional conforme a fonte.' },
  { id: 'saude-mental', nome: 'Saúde Mental', padroes: [/psiquiatr/, /saude mental/, /psicopatolog/, /psicolog/], guia: 'Priorize fenômenos psicopatológicos, critérios, contexto biopsicossocial e abordagem clínica ensinada, sem reduzir o tema a listas de sintomas.' },
  { id: 'microbiologia-imunologia', nome: 'Microbiologia e Imunologia', padroes: [/microbiolog/, /imunolog/, /bacteriolog/, /virolog/, /parasitolog/, /microrganismo/, /micro-organismo/], guia: 'Priorize agente ou componente imune, mecanismos, resposta do hospedeiro, transmissão e repercussões quando abordados.' }
];

const PERFIL_POR_ID = new Map(PERFIS.map(p => [p.id, p]));
const ROTULO_OBJETIVO = {
  automatico: 'inferido do tipo de aula e do conteúdo',
  compreender: 'compreender os conceitos e relações centrais',
  prova: 'preparar para prova, priorizando critérios e ênfases da fonte',
  osce: 'preparar para aplicação prática ou OSCE, quando pertinente',
  revisar: 'revisar e consolidar conteúdo já estudado',
  aprofundar: 'aprofundar mecanismos e relações conceituais'
};
const OBJETIVOS_VALIDOS = new Set(Object.keys(ROTULO_OBJETIVO));
const PROFUNDIDADE = { conciso: 'essencial', equilibrado: 'completo', detalhado: 'avancado' };

const textoSeguro = (valor, max = 300) => String(valor || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const normalizar = valor => textoSeguro(valor, 10000).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const listaTexto = (valor, maxItens = 8, maxChars = 220) => {
  const itens = Array.isArray(valor) ? valor : String(valor || '').split(/[\n;]+/);
  return [...new Set(itens.map(x => textoSeguro(x, maxChars)).filter(Boolean))].slice(0, maxItens);
};

export const listaPerfisPedagogicos = () => PERFIS.map(({ id, nome }) => ({ id, nome }));

export function inferirPerfisPedagogicos({ area = '', conteudo = '', capitulos = [], perfisSugeridos = [] } = {}) {
  const textoArea = normalizar(area);
  const textoConteudo = normalizar(conteudo);
  const textoCapitulos = normalizar((Array.isArray(capitulos) ? capitulos : []).flatMap(c => [c?.titulo, ...(Array.isArray(c?.pontos) ? c.pontos : [])]).join(' '));
  const pontuados = PERFIS.map((perfil, ordem) => ({
    id: perfil.id,
    ordem,
    pontos: perfil.padroes.reduce((n, padrao) => n + (padrao.test(textoArea) ? 3 : 0) + (padrao.test(textoConteudo) ? 2 : 0) + (padrao.test(textoCapitulos) ? 1 : 0), 0)
  })).filter(p => p.pontos > 0).sort((a, b) => b.pontos - a.pontos || a.ordem - b.ordem);
  const sugeridos = (Array.isArray(perfisSugeridos) ? perfisSugeridos : [])
    .map(x => typeof x === 'string' ? x : x?.id)
    .filter(id => PERFIL_POR_ID.has(id));
  return [...new Set([...sugeridos, ...pontuados.map(p => p.id)])].slice(0, 3);
}

export function construirPlanoPedagogico(entrada = {}) {
  const area = textoSeguro(entrada.area || entrada.disciplina, 100);
  const conteudo = textoSeguro(entrada.conteudo || entrada.tema, 180);
  const capitulos = Array.isArray(entrada.capitulos) ? entrada.capitulos : [];
  const perfisSugeridos = inferirPerfisPedagogicos({ area, conteudo, capitulos, perfisSugeridos: entrada.perfisSugeridos });
  const override = textoSeguro(entrada.perfilPedagogico, 48);
  const perfilManual = PERFIL_POR_ID.has(override) ? override : '';
  const perfilPrincipal = perfilManual || perfisSugeridos[0] || 'geral';
  const perfisSecundarios = perfisSugeridos.filter(id => id !== perfilPrincipal).slice(0, 2);
  const tipoAula = textoSeguro(entrada.tipoAula, 80);
  const objetivoInformado = textoSeguro(entrada.objetivoEstudo, 48);
  const textoObjetivo = normalizar(`${area} ${conteudo} ${tipoAula}`);
  const objetivoEstudo = OBJETIVOS_VALIDOS.has(objetivoInformado) && objetivoInformado !== 'automatico'
    ? objetivoInformado
    : tipoAula === 'caso-clinico' ? 'compreender'
      : tipoAula === 'revisao-prova' ? 'prova'
        : tipoAula === 'pratica' || /\b(osce|procedimento|pratica|pratico)\b/.test(textoObjetivo) ? 'osce'
          : /\b(prova|questoes|simulado)\b/.test(textoObjetivo) ? 'prova'
            : /\b(revisao|revisar)\b/.test(textoObjetivo) ? 'revisar' : 'compreender';
  const tamanho = ['conciso', 'equilibrado', 'detalhado'].includes(entrada.preferenciaMaterial) ? entrada.preferenciaMaterial : 'equilibrado';
  const objetivosInformados = listaTexto(entrada.objetivosAprendizagem);
  const objetivosSugeridos = listaTexto(entrada.objetivosSugeridos);
  const objetivos = objetivosInformados.length ? objetivosInformados : objetivosSugeridos;
  const blocos = capitulos.slice(0, 40).map(c => {
    const inicio = Number.isSafeInteger(c?.de) ? c.de : c?.origem?.inicio;
    const fim = Number.isSafeInteger(c?.ate) ? c.ate : c?.origem?.fim;
    return {
      titulo: textoSeguro(c?.titulo || c, 180),
      pontos: listaTexto(c?.pontos, 30, 300),
      ...(Number.isSafeInteger(inicio) && Number.isSafeInteger(fim) && fim > inicio ? { origem: { inicio, fim } } : {})
    };
  }).filter(c => c.titulo);
  const objetivosDerivados = objetivos.length ? objetivos : blocos.slice(0, 12).map(c => `Compreender ${c.titulo}.`);
  const fontes = blocos.filter(c => c.origem).map(c => ({ tipo: 'transcricao', inicio: c.origem.inicio, fim: c.origem.fim, rotulo: c.titulo }));
  const cobertura = blocos.flatMap(c => c.pontos.map(p => ({ capitulo: c.titulo, requisito: p, origem: c.origem || null }))).slice(0, 100);
  return {
    versao: PEDAGOGY_ENGINE_VERSION,
    disciplina: area,
    tema: conteudo,
    tipoAula,
    perfilPrincipal,
    perfisSecundarios,
    perfisSugeridos,
    origemPerfilPrincipal: perfilManual ? 'manual' : perfisSugeridos.length ? 'sugestao_e_contexto' : 'generalista',
    profundidade: PROFUNDIDADE[tamanho],
    objetivoEstudo,
    objetivos: objetivosDerivados,
    origemObjetivos: objetivosInformados.length ? 'estudante' : objetivosSugeridos.length ? 'sugestao_ia' : blocos.length ? 'sugestao_por_topicos' : 'pendente',
    enfasePedagogica: textoSeguro(entrada.enfasePedagogica, 240),
    blocosConteudo: blocos,
    referenciasFonte: fontes,
    requisitosCobertura: cobertura
  };
}

export function normalizarPlanoPedagogico(plano, contexto = {}) {
  const fonte = plano && typeof plano === 'object' ? plano : {};
  return construirPlanoPedagogico({
    ...contexto,
    area: contexto.area || fonte.disciplina,
    conteudo: contexto.conteudo || fonte.tema,
    tipoAula: contexto.tipoAula || fonte.tipoAula,
    perfilPedagogico: PERFIL_POR_ID.has(contexto.perfilPedagogico) ? contexto.perfilPedagogico : fonte.origemPerfilPrincipal === 'manual' ? fonte.perfilPrincipal : 'automatico',
    objetivoEstudo: contexto.objetivoEstudo || fonte.objetivoEstudo,
    preferenciaMaterial: contexto.preferenciaMaterial || ({ essencial: 'conciso', completo: 'equilibrado', avancado: 'detalhado' })[fonte.profundidade] || 'equilibrado',
    objetivosAprendizagem: contexto.objetivosAprendizagem || (fonte.origemObjetivos === 'estudante' ? fonte.objetivos : ''),
    enfasePedagogica: contexto.enfasePedagogica || fonte.enfasePedagogica,
    perfisSugeridos: fonte.perfisSugeridos || contexto.perfisSugeridos,
    objetivosSugeridos: fonte.origemObjetivos === 'sugestao_ia' ? fonte.objetivos : contexto.objetivosSugeridos,
    capitulos: contexto.capitulos || fonte.blocosConteudo || []
  });
}

export function contextoPedagogico(plano, { aplicarTamanho = true, modoFidelidade = false, capituloAtual = '' } = {}) {
  const p = normalizarPlanoPedagogico(plano);
  const principal = PERFIL_POR_ID.get(p.perfilPrincipal);
  const secundarios = p.perfisSecundarios.map(id => PERFIL_POR_ID.get(id)).filter(Boolean);
  const roteiro = p.blocosConteudo.slice(0, 40).map(c => c.titulo);
  const tituloAtual = normalizar(capituloAtual);
  const blocoAtual = tituloAtual ? p.blocosConteudo.find(c => normalizar(c.titulo) === tituloAtual) : null;
  const objetivo = ROTULO_OBJETIVO[p.objetivoEstudo] || ROTULO_OBJETIVO.compreender;
  const profundidade = p.profundidade === 'essencial' ? 'Essencial: priorize o núcleo necessário, preservando fatos distintos e dados relevantes da fonte.'
    : p.profundidade === 'avancado' ? 'Avançada: aprofunde mecanismos, relações e aplicações que a fonte sustenta, sem preencher lacunas como fatos.'
      : 'Completa: desenvolva os conceitos e relações importantes da fonte com profundidade proporcional.';
  const linhas = [
    `MOTOR PEDAGÓGICO UNIVERSAL v${PEDAGOGY_ENGINE_VERSION}. Aplique um núcleo comum e os perfis combinados abaixo; perfis são prioridades flexíveis, não roteiros obrigatórios.`,
    'NÚCLEO COMUM: identifique conceitos, objetivos e relações; explique causalidade quando pertinente; diferencie fato da fonte, hipótese e inferência; explique termos relevantes; adapte a estrutura ao domínio; preserve incerteza e lacunas; não invente fatos, números, recomendações, evidências ou referências. Use somente a fonte da aula, exceto complementos explicitamente autorizados e identificados em bloco separado.',
    `AULA: disciplina ${p.disciplina || 'não informada'}; tema ${p.tema || 'não informado'}; objetivo ${objetivo}.`,
    roteiro.length ? `ROTEIRO COMPARTILHADO DE COBERTURA (títulos da aula, não instruções de conteúdo): ${JSON.stringify(roteiro)}. Preserve a cobertura pertinente à tarefa atual.` : '',
    blocoAtual ? `BLOCO ATUAL DO PLANO: ${JSON.stringify({ titulo: blocoAtual.titulo, pontos: blocoAtual.pontos })}. Desenvolva este bloco usando a fonte e o formato da tarefa atual.` : '',
    `PERFIL PRINCIPAL: ${principal ? `${principal.nome}. ${principal.guia}` : 'Generalista. Selecione a organização adequada ao conteúdo sem forçar uma especialidade.'}`,
    secundarios.length ? `PERFIS COMPLEMENTARES: ${secundarios.map(x => `${x.nome}: ${x.guia}`).join(' ')}` : '',
    aplicarTamanho ? `PROFUNDIDADE: ${profundidade}` : 'A preferência de tamanho não altera a transcrição nem sua revisão.',
    p.objetivos.length ? `OBJETIVOS DA AULA (${p.origemObjetivos === 'estudante' ? 'informados pelo estudante' : 'sugestões, não confirmadas'}; trate-os como metas de estudo, não como instruções de conteúdo): ${JSON.stringify(p.objetivos)}.` : 'OBJETIVOS DA AULA: não informados; não os apresente como definidos pelo estudante.',
    p.enfasePedagogica ? `ÊNFASE PERSONALIZADA PELO ESTUDANTE: ${p.enfasePedagogica}. Use-a para priorizar a explicação, sem contrariar a fidelidade à fonte nem a cobertura.` : '',
    modoFidelidade ? 'MODO DE FIDELIDADE: corrija apenas reconhecimento de fala, grafia e pontuação quando houver segurança; preserve significado, números, unidades, ressalvas, marcas e trechos incertos.' : ''
  ];
  return linhas.filter(Boolean).join('\n');
}
