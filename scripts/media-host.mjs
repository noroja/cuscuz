// Sobe o app em modo "só mídia" (MEDIA_ONLY): serve apenas /m/* (vídeos/PDFs do Drive) e /api/health.
// Feito para rodar no seu PC atrás de um túnel HTTPS, enquanto o site/API ficam na Vercel.
// Multiplataforma (Windows/macOS/Linux): não depende de sintaxe de variável de ambiente do shell.
process.env.MEDIA_ONLY = '1';
process.env.PORT = process.env.MEDIA_PORT || process.env.PORT || '3001';
await import('../server.js');
