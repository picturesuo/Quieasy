import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crc32, zipDirectory } from '../../scripts/zip.mjs';

/** Bit-by-bit CRC-32, independent of the table routine under test. */
function referenceCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  path: string;
  crc: number;
  size: number;
  data: Buffer;
}

/** Reads an archive the way an unzip program does: the end record, the central directory, then each local entry. */
function readZip(archive: Buffer): Entry[] {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  let position = archive.readUInt32LE(end + 16);
  expect(position + directorySize).toBe(end);
  const entries: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(position)).toBe(0x02014b50);
    expect(archive.readUInt16LE(position + 10)).toBe(8);
    const crc = archive.readUInt32LE(position + 16);
    const compressedSize = archive.readUInt32LE(position + 20);
    const size = archive.readUInt32LE(position + 24);
    const nameLength = archive.readUInt16LE(position + 28);
    const extraLength = archive.readUInt16LE(position + 30);
    const commentLength = archive.readUInt16LE(position + 32);
    const localOffset = archive.readUInt32LE(position + 42);
    const path = archive.toString('utf8', position + 46, position + 46 + nameLength);
    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(archive.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(archive.toString('utf8', localOffset + 30, localOffset + 30 + archive.readUInt16LE(localOffset + 26))).toBe(path);
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    entries.push({ path, crc, size, data: inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize)) });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('crc32', () => {
  it('matches the standard check value and a bitwise implementation', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) % 256));
    expect(crc32(bytes)).toBe(referenceCrc32(bytes));
  });
});

describe('zipDirectory', () => {
  let dir: string;
  const files: Record<string, Buffer> = {
    'manifest.json': Buffer.from('{"name":"Quieasy"}\n'),
    'background.js': Buffer.from('console.log("hi");\n'.repeat(50)),
    'empty.txt': Buffer.alloc(0),
    'icons/icon16.png': Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 131 + 7) % 256)),
    'icons/nested/deep.css': Buffer.from('.quieasy { color: gray }'),
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quieasy-zip-'));
    for (const [path, data] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores every file so that it inflates back to the original with the right size and CRC', () => {
    const entries = readZip(zipDirectory(dir));
    expect(entries.map((entry) => entry.path)).toEqual(Object.keys(files).sort());
    for (const entry of entries) {
      const original = readFileSync(join(dir, entry.path));
      expect(entry.data.equals(original)).toBe(true);
      expect(entry.size).toBe(original.length);
      expect(entry.crc).toBe(referenceCrc32(original));
    }
  });

  it('produces the same bytes regardless of file times', () => {
    const first = zipDirectory(dir);
    utimesSync(join(dir, 'manifest.json'), new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z'));
    expect(zipDirectory(dir).equals(first)).toBe(true);
  });
});
