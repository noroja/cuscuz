export function detectMediaContainer(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (bytes.length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return 'mpegts';
  if (bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'FLV') return 'flv';
  return null;
}
