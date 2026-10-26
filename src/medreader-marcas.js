// Marcações do MedReader por usuário e apostila (Supabase: tabela medreader_marcas)
const ID_OK = /^[A-Za-z0-9_-]{5,120}$/;
const MAX_MARCAS = 2000;

export function registerMedreaderMarcas(app, { getSupabase }) {
  app.get('/api/medreader/marcas/:id', async (req, res) => {
    const supabase = getSupabase();
    if (!supabase) return res.json({ success: false, offline: true });
    if (!ID_OK.test(req.params.id)) return res.status(400).json({ success: false, msg: 'ID inválido' });
    try {
      const { data, error } = await supabase.from('medreader_marcas').select('marcas, atualizado')
        .eq('username', req.user.username).eq('apostila_id', req.params.id).maybeSingle();
      if (error) return res.json({ success: false, offline: true, msg: error.message });
      res.json({ success: true, dados: data ? { marcas: data.marcas || [], atualizado: Number(data.atualizado) || 0 } : null });
    } catch (e) {
      res.json({ success: false, offline: true, msg: e.message });
    }
  });

  app.put('/api/medreader/marcas/:id', async (req, res) => {
    const supabase = getSupabase();
    if (!supabase) return res.json({ success: false, offline: true });
    if (!ID_OK.test(req.params.id)) return res.status(400).json({ success: false, msg: 'ID inválido' });
    const { marcas, atualizado } = req.body || {};
    if (!Array.isArray(marcas) || marcas.length > MAX_MARCAS) return res.status(400).json({ success: false, msg: 'Marcações inválidas' });
    const limpas = marcas.map((m) => ({
      id: String(m.id || '').slice(0, 40),
      tipo: ['sublinhar', 'bookmark', 'nota', 'duvida'].includes(m.tipo) ? m.tipo : 'sublinhar',
      cor: ['amarelo', 'verde', 'azul', 'rosa'].includes(m.cor) ? m.cor : 'amarelo',
      inicio: Number(m.inicio) || 0,
      fim: Number(m.fim) || 0,
      trecho: String(m.trecho || '').slice(0, 5000),
      nota: String(m.nota || '').slice(0, 2000),
      criado: Number(m.criado) || 0,
      atualizado: Number(m.atualizado) || 0,
    })).filter((m) => m.id && m.fim > m.inicio);
    try {
      const { error } = await supabase.from('medreader_marcas').upsert({
        username: req.user.username, apostila_id: req.params.id, marcas: limpas,
        atualizado: Number(atualizado) || Date.now(),
      }, { onConflict: 'username,apostila_id' });
      if (error) return res.json({ success: false, offline: true, msg: error.message });
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, offline: true, msg: e.message });
    }
  });
}
