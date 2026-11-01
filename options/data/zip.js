// ---------- ZIP 打包入口（STORE 模式 + Worker 化） ----------
// 媒体条目（mp4/jpeg/webp）本身已压缩，二次 deflate 收益 ≈0 且是打包的最大 CPU 开销——
// 统一走 STORE（method=0，数据分片直接引用原 Blob，峰值内存从「原 blob + 字节副本 +
// 压缩分片」的 3-4× 降到 ≈1×）。crc32 逐字节循环与组包整体移入 Web Worker（Blob 跨
// postMessage 引用传递零拷贝），主线程只收进度与结果；worker 创建/加载失败（极旧内核）
// 降级为主线程直算——两条路径共享 zip-format.js 单一实现，不维护第二套格式逻辑。

import { crc32, assembleStoreZip } from "./zip-format.js";

// 取消错误：与 fetch 的 abort 语义同名（AbortError），调用方按 name/token 识别
function createAbortError() {
  return new DOMException("Aborted", "AbortError");
}

// 单次打包的主线程降级实现：与 worker 相同的「逐条 crc + 组装」步骤
async function createZipInline(entries, onProgress, signal) {
  const entryData = [];
  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) throw createAbortError();
    const { name, blob } = entries[i];
    const buf = await blob.arrayBuffer();
    entryData.push({ name, crc: crc32(new Uint8Array(buf)), blob });
    if (onProgress) onProgress(i + 1, entries.length);
  }
  // 末条取字节期间可能已取消：组装前再确认一次，避免白组装
  if (signal?.aborted) throw createAbortError();
  return assembleStoreZip(entryData);
}

// entries = [{ name, blob }]，onProgress(done, total) 可选，signal 可选（取消即终止 worker）。
// 每次调用起一个一次性 worker（启动开销毫秒级，避免跨调用的请求路由与并发串扰），
// done/error/abort 时 terminate 回收
export function createZip(entries, onProgress, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  let worker;
  try {
    worker = new Worker(chrome.runtime.getURL("options/data/zip-worker.js"), { type: "module" });
  } catch (err) {
    console.warn("[DDM] zip worker unavailable, fallback to inline:", err?.message);
    return createZipInline(entries, onProgress, signal);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const succeed = (blob) => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      resolve(blob);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      reject(err);
    };
    const onAbort = () => fail(createAbortError());
    worker.onmessage = (e) => {
      const { type, index, total, blob, message } = e.data;
      if (type === "progress") {
        if (onProgress) onProgress(index, total);
      } else if (type === "done") {
        succeed(blob);
      } else if (type === "error") {
        fail(new Error(message || "ZIP_FAILED"));
      }
    };
    // 脚本级失败（module 加载失败等，任务未开始）：降级主线程直算，等价结果
    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      console.warn("[DDM] zip worker failed, fallback to inline:", e.message);
      createZipInline(entries, onProgress, signal).then(resolve, reject);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // 只传引用载荷（Blob 结构化克隆零拷贝），主线程不留字节副本
    worker.postMessage({
      entries: entries.map(({ name, blob }) => ({ name, blob })),
    });
  });
}
