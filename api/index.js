/* Entrada serverless da Vercel.
   O server.js exporta o app Express (sem listen) quando detecta ambiente serverless. */
import app from '../server.js';

export default app;

// Limite de execução para o runtime Node da Vercel (o vercel.json também define).
export const config = { maxDuration: 60 };
