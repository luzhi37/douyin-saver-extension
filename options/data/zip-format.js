// ---------- ZIP 格式构建（纯函数，zip.js 主线程降级与 zip-worker.js 共享单一实现） ----------
// 手写 ZIP 容器格式：Local File Header + 数据 + Central Directory + End of Central Directory。
// 条目名 UTF-8（通用标志位 0x0800），CRC-32 查表，DOS 时间/日期取当前时间；单条目 < 4GB 不涉及 ZIP64。
// 统一 STORE 方式（method=0）：媒体条目（mp4/jpeg/webp）本身已压缩，deflate 收益 ≈0 且是
// 打包的最大 CPU 开销——STORE 下数据分片直接引用原 Blob，不复制不压缩。
// 仅 crc32 与 assembleStoreZip 对外；格式常量与头部构建函数均为模块内部实现细节。

const ZIP_SIG_LOCAL = 0x04034b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
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

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value, true);
}

export function buildLocalHeader(nameBytes, method, crc, csize, usize, dos) {
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

export function buildCentralHeader(nameBytes, method, crc, csize, usize, dos, offset) {
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

export function buildEocd(recordCount, cdSize, cdOffset) {
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

// ---------- 组装 ----------
// entryData = [{ name, crc, blob }]（crc 已由调用方算好）：全部 STORE 方式组装——数据分片
// 直接引用原 Blob，new Blob(parts) 为引用层物化，峰值内存 ≈ 1× 媒体体积（无中间副本）
export function assembleStoreZip(entryData) {
  const encoder = new TextEncoder();
  const dos = dosDateTime(new Date());
  const parts = [];
  const records = [];
  let offset = 0;

  for (const entry of entryData) {
    const nameBytes = encoder.encode(entry.name);
    const usize = entry.blob.size;
    parts.push(buildLocalHeader(nameBytes, ZIP_METHOD_STORE, entry.crc, usize, usize, dos), entry.blob);
    records.push({ nameBytes, crc: entry.crc, usize, offset });
    offset += LOCAL_HEADER_SIZE + nameBytes.length + usize;
  }

  const centralParts = records.map((rec) =>
    buildCentralHeader(rec.nameBytes, ZIP_METHOD_STORE, rec.crc, rec.usize, rec.usize, dos, rec.offset),
  );
  const cdSize = records.reduce((sum, rec) => sum + CENTRAL_HEADER_SIZE + rec.nameBytes.length, 0);
  parts.push(...centralParts, buildEocd(records.length, cdSize, offset));
  return new Blob(parts, { type: "application/zip" });
}
