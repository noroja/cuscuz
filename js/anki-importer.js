/* ══════════════════════════════════════════════════════════════════════════════════
   ANKI IMPORTER — Importação de flashcards (.apkg) do Google Drive
   ─────────────────────────────────────────────────────────────────────────────
   Chama o endpoint /api/anki/importar no servidor, que faz a busca no Drive
   usando credenciais de backend (conta de serviço ou chave de API). Nunca varre
   o Drive inteiro — restrito estritamente à pasta GOOGLE_DRIVE_ANKI_FOLDER_ID.
   ═════════════════════════════════════════════════════════════════════════════════ */

/* Importa arquivos .apkg do Drive via endpoint do servidor.
   Retorna a lista de arquivos ou [] se não houver pasta configurada/erro. */
export async function importarAnki() {
  try {
    const r = await fetch('/api/anki/importar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!r.ok) {
      const texto = await r.text().catch(() => '');
      console.warn('[Anki Importer] Erro no servidor:', r.status, texto.slice(0, 200));
      return [];
    }
    const j = await r.json();
    if (!j || !Array.isArray(j.arquivos)) return [];
    console.log(`[Anki Importer] ${j.arquivos.length} arquivo(s) .apkg encontrado(s).`);
    return j.arquivos;
  } catch (e) {
    console.error('[Anki Importer] Falha ao chamar endpoint:', e.message);
    return [];
  }
}
