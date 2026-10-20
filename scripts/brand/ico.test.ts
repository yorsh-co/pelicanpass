import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { packIco } from './ico.ts';

describe('packIco', () => {
  const small = Buffer.from('aaaa');
  const large = Buffer.from('bbbbbbbb');

  it('writes the ICONDIR header', () => {
    const ico = packIco([{ size: 48, png: small }]);

    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 1);
  });

  it('lists each image with its size, length and offset', () => {
    const ico = packIco([
      { size: 48, png: small },
      { size: 32, png: large },
    ]);
    const dataStart = 6 + 16 * 2;

    assert.equal(ico.readUInt16LE(4), 2);

    assert.equal(ico.readUInt8(6), 48);
    assert.equal(ico.readUInt8(7), 48);
    assert.equal(ico.readUInt16LE(6 + 4), 1);
    assert.equal(ico.readUInt16LE(6 + 6), 32);
    assert.equal(ico.readUInt32LE(6 + 8), small.length);
    assert.equal(ico.readUInt32LE(6 + 12), dataStart);

    assert.equal(ico.readUInt8(22), 32);
    assert.equal(ico.readUInt8(23), 32);
    assert.equal(ico.readUInt32LE(22 + 8), large.length);
    assert.equal(ico.readUInt32LE(22 + 12), dataStart + small.length);

    assert.deepEqual(ico.subarray(dataStart), Buffer.concat([small, large]));
  });

  it('writes 256 px as 0', () => {
    const ico = packIco([{ size: 256, png: small }]);

    assert.equal(ico.readUInt8(6), 0);
    assert.equal(ico.readUInt8(7), 0);
  });

  it('rejects sizes an entry cannot hold', () => {
    assert.throws(() => packIco([{ size: 257, png: small }]), RangeError);
    assert.throws(() => packIco([{ size: 0, png: small }]), RangeError);
  });
});
