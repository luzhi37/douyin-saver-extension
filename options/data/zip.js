// ---------- ZIP 打包（零依赖：CompressionStream deflate-raw，不支持时回退 STORE） ----------
// 手写 ZIP 容器格式：Local File Header + 数据 + Central Directory + End of Central Directory。
// 条目名 UTF-8（通用标志位 0x0800），CRC-32 查表，DOS 时间/日期取当前时间；单条目 < 4GB 不涉及 ZIP64。

const ZIP_SIG_LOCAL = 0x04034b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// ---------- 基础工具 ----------
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function deflateRaw(blob) {
  const stream = blob.stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Response(stream).blob();
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value, true);
}

// ---------- 头部构建 ----------
function buildLocalHeader(nameBytes, method, crc, csize, usize, dos) {
  const buf = new ArrayBuffer(LOCAL_HEADER_SIZE + nameBytes.length);
  const view = new DataView(buf);
  writeU32(view, 0, ZIP_SIG_LOCAL);
  writeU16(view, 4, ZIP_VERSION);
  writeU16(view, 6, ZIP_FLAG_UTF8);
  writeU16(view, 8, method);
  writeU16(view, 10, dos.time);
  writeU16(view, 12, dos.date);
  writeU32(view, 14, crc);
  writeU32(view, 18, csize);
  writeU32(view, 22, usize);
  writeU16(view, 26, nameBytes.length);
  writeU16(view, 28, 0);
  new Uint8Array(buf, LOCAL_HEADER_SIZE).set(nameBytes);
  return buf;
}

function buildCentralHeader(nameBytes, method, crc, csize, usize, dos, offset) {
  const buf = new ArrayBuffer(CENTRAL_HEADER_SIZE + nameBytes.length);
  const view = new DataView(buf);
  writeU32(view, 0, ZIP_SIG_CENTRAL);
  writeU16(view, 4, ZIP_VERSION);
  writeU16(view, 6, ZIP_VERSION);
  writeU16(view, 8, ZIP_FLAG_UTF8);
  writeU16(view, 10, method);
  writeU16(view, 12, dos.time);
  writeU16(view, 14, dos.date);
  writeU32(view, 16, crc);
  writeU32(view, 20, csize);
  writeU32(view, 24, usize);
  writeU16(view, 28, nameBytes.length);
  writeU16(view, 30, 0);
  writeU16(view, 32, 0);
  writeU16(view, 34, 0);
  writeU16(view, 36, 0);
  writeU32(view, 38, 0);
  writeU32(view, 42, offset);
  new Uint8Array(buf, CENTRAL_HEADER_SIZE).set(nameBytes);
  return buf;
}

function buildEocd(recordCount, cdSize, cdOffset) {
  const buf = new ArrayBuffer(EOCD_SIZE);
  const view = new DataView(buf);
  writeU32(view, 0, ZIP_SIG_EOCD);
  writeU16(view, 4, 0);
  writeU16(view, 6, 0);
  writeU16(view, 8, recordCount);
  writeU16(view, 10, recordCount);
  writeU32(view, 12, cdSize);
  writeU32(view, 16, cdOffset);
  writeU16(view, 20, 0);
  return buf;
}

// ---------- 入口 ----------
export async function createZip(entries) {
  const encoder = new TextEncoder();
  const dos = dosDateTime(new Date());
  const parts = [];
  const records = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(bytes);
    let method = ZIP_METHOD_DEFLATE;
    let dataBlob;
    try {
      dataBlob = await deflateRaw(entry.blob);
    } catch {
      method = ZIP_METHOD_STORE;
      dataBlob = entry.blob;
    }
    const csize = dataBlob.size;
    const usize = bytes.byteLength;
    parts.push(buildLocalHeader(nameBytes, method, crc, csize, usize, dos), dataBlob);
    records.push({ nameBytes, method, crc, csize, usize, offset });
    offset += LOCAL_HEADER_SIZE + nameBytes.length + csize;
  }

  const centralParts = records.map((rec) =>
    buildCentralHeader(rec.nameBytes, rec.method, rec.crc, rec.csize, rec.usize, dos, rec.offset),
  );
  const cdSize = records.reduce((sum, rec) => sum + CENTRAL_HEADER_SIZE + rec.nameBytes.length, 0);
  parts.push(...centralParts, buildEocd(records.length, cdSize, offset));
  return new Blob(parts, { type: "application/zip" });
}
