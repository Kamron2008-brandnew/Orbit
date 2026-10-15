import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { makeZip } from "../web-capture/js/zip.js";

// Read a zip back by hand: the central directory lists every file with its size, CRC and offset.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, "central directory entry");
    const crc = view.getUint32(at + 16, true),
      size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true),
      offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(offset, true), 0x04034b50, "local header");
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    entries.push({ name, crc, size, data: bytes.subarray(dataStart, dataStart + size) });
    at += 46 + nameLength;
  }
  return entries;
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

test("a zip lists every file with the right name, size, checksum and content", async () => {
  const jpeg = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31 + (i >> 5)) & 255);
  const json = JSON.stringify({ ü: "unicode" }); // "ü" takes two bytes
  const zip = await makeZip([
    { name: "images/kf_000.jpg", data: new Blob([jpeg]) },
    { name: "scan.json", data: json },
    { name: "README.txt", data: "hello" },
    { name: "empty.bin", data: new Blob([]) },
  ]);
  assert.equal(zip.type, "application/zip");
  const entries = readZip(await bytesOf(zip));
  assert.deepEqual(
    entries.map((e) => e.name),
    ["images/kf_000.jpg", "scan.json", "README.txt", "empty.bin"],
  );
  assert.deepEqual(
    entries.map((e) => e.size),
    [5000, new TextEncoder().encode(json).length, 5, 0],
  );
  for (const e of entries) assert.equal(e.crc, crc32(e.data), `checksum of ${e.name}`);
  assert.deepEqual(entries[0].data, jpeg);
  assert.equal(new TextDecoder().decode(entries[2].data), "hello");
});

test("progress is reported once per file", async () => {
  const seen = [];
  await makeZip(
    [
      { name: "a", data: "1" },
      { name: "b", data: "2" },
      { name: "c", data: "3" },
    ],
    (p) => seen.push(p),
  );
  assert.deepEqual(seen, [1 / 3, 2 / 3, 1]);
});
