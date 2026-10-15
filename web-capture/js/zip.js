// Minimal ZIP writer (store, no compression). JPEG/PNG/MP4 are already compressed, so storing is
// fast and the archive is the same size. Supports UTF-8 names; not ZIP64 (fine below 4 GB / 65k files).
//
// Memory: a file is read once to compute its checksum and then dropped; the archive itself is assembled from
// the original Blobs (which the browser keeps on disk), so packing a 4K scan needs a few MB, not the whole
// scan twice over, which is what used to push a phone past its limit.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ name: "images/kf_000.jpg", data: Blob | string }]
export async function makeZip(files, onProgress) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const isText = typeof f.data === "string";
    const blob = isText ? null : f.data;
    const size = isText ? 0 : blob.size;
    let body = null;
    let crc;
    if (isText) { body = enc.encode(f.data); crc = crc32(body); }
    else {
      const bytes = new Uint8Array(await blob.arrayBuffer()); // one file at a time
      crc = crc32(bytes);
    }
    const length = isText ? body.length : size;
    const name = enc.encode(f.name);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true);      // stored
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, length, true);
    lh.setUint32(22, length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, isText ? body : blob);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, length, true);
    ch.setUint32(24, length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);

    offset += 30 + name.length + length;
    onProgress?.((i + 1) / files.length);
  }

  const cdSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
