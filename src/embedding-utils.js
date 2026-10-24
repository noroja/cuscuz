const ehVetor = value => Array.isArray(value) && value.length > 0 && value.every(Number.isFinite);

function mediaVetor(tokens) {
  const validos = tokens.filter(ehVetor);
  if (!validos.length) return null;
  const dimensoes = validos[0].length;
  if (validos.some(vector => vector.length !== dimensoes)) return null;
  const result = new Array(dimensoes).fill(0);
  for (const vector of validos) for (let i = 0; i < dimensoes; i++) result[i] += vector[i];
  return result.map(value => value / validos.length);
}

// Providers podem devolver vetor por texto ou vetor por token; neste último caso, usa mean pooling.
export function sentenceVectors(data, count) {
  if (!Array.isArray(data) || !Number.isInteger(count) || count < 1) return null;
  if (count === 1 && ehVetor(data)) return [data];
  if (data.length === count && data.every(ehVetor)) return data;
  if (count === 1 && data.every(ehVetor)) return [mediaVetor(data)];
  if (data.length === count && data.every(tokens => Array.isArray(tokens) && tokens.every(ehVetor))) {
    const pooled = data.map(mediaVetor);
    return pooled.every(Boolean) ? pooled : null;
  }
  return null;
}
