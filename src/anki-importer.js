/* ══════════════════════════════════════════════════════════════════════════════════
   ANKI IMPORTER — Importação de flashcards (.apkg) do Google Drive
   ─────────────────────────────────────────────────────────────────────────────
   Busca arquivos .apkg estritamente dentro da pasta configurada em
   GOOGLE_DRIVE_ANKI_FOLDER_ID. Nunca varre o Drive inteiro.
   ═════════════════════════════════════════════════════════════════════════════════ */

import { driveFetchWithRetry } from './drive-auth.js';

const ANKI_FOLDER_ID = process.env.GOOGLE_DRIVE_ANKI_FOLDER_ID || '';

/* Importa arquivos .apkg do Google Drive restritos a uma única pasta.
   Retorna a lista de arquivos encontrados ou [] se a pasta não estiver configurada. */
export async function importarAnki() {
  if (!ANKI_FOLDER_ID) {
    console.warn('[Anki Importer] ID da pasta não configurado no .env, pulando importação.');
    return [];
  }

  const cleanId = ANKI_FOLDER_ID.replace(/^folders\//, '').split('/')[0].split('?')[0].trim();
  if (!cleanId) {
    console.warn('[Anki Importer] ID da pasta não configurado no .env, pulando importação.');
    return [];
  }

  const q = encodeURIComponent(`'${cleanId}' in parents and trashed = false and name contains '.apkg'`);
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,webViewLink,createdTime,modifiedTime)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=name_natural&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;

  const arquivos = [];
  let pageToken = '';

  try {
    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const r = await driveFetchWithRetry(`${url}${pageParam}`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) {
        const texto = await r.text().catch(() => '');
        throw new Error(`Drive ${r.status}: ${texto.slice(0, 200)}`);
      }
      const data = await r.json();
      if (data.files && Array.isArray(data.files)) {
        arquivos.push(...data.files.map(f => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          webViewLink: f.webViewLink,
          createdTime: f.createdTime,
          modifiedTime: f.modifiedTime
        })));
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    console.log(`[Anki Importer] ${arquivos.length} arquivo(s) .apkg encontrado(s) na pasta ${cleanId}.`);
    return arquivos;
  } catch (e) {
    console.error('[Anki Importer] Falha ao buscar arquivos .apkg:', e.message);
    return [];
  }
}

export { ANKI_FOLDER_ID };
