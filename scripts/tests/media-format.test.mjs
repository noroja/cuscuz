import assert from 'node:assert/strict';
import { detectMediaContainer } from '../../src/media-format.js';

const ts = Buffer.alloc(377);
ts[0] = 0x47;
ts[188] = 0x47;
ts[376] = 0x47;
assert.equal(detectMediaContainer(ts), 'mpegts');
assert.equal(detectMediaContainer(Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom')])), 'mp4');
assert.equal(detectMediaContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93])), 'webm');
assert.equal(detectMediaContainer(Buffer.from('FLV\x01\x00\x00\x00')), 'flv');
assert.equal(detectMediaContainer(Buffer.from('not a video')), null);
assert.equal(detectMediaContainer(ts.subarray(0, 376)), null);
console.log('media-format: 6 checks passed');
