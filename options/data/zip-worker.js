// ---------- zip 打包 Worker（module worker，options 页同源加载无需 web_accessible_resources） ----------
// crc32 逐字节循环与组包整体移出主线程：50MB 视频的主线程直算 ≈ 100-300ms 冻结/条，
// 批量下载按条累积为秒级无响应。Blob 跨 postMessage 为引用传递（零拷贝），逐条完成后
// 回传进度，全部完成回传最终 zip Blob（STORE 方式，见 zip-format.js）。

import { crc32, assembleStoreZip } from "./zip-format.js";

self.onmessage = (e) => {
  const { id, entries } = e.data;
  (async () => {
    try {
      const entryData = [];
      for (let i = 0; i < entries.length; i++) {
        const { name, blob } = entries[i];
        const buf = await blob.arrayBuffer();
        entryData.push({ name, crc: crc32(new Uint8Array(buf)), blob });
        self.postMessage({ id, type: "progress", index: i + 1, total: entries.length });
      }
      const blob = assembleStoreZip(entryData);
      self.postMessage({ id, type: "done", blob });
    } catch (err) {
      self.postMessage({ id, type: "error", message: err?.message || String(err) });
    }
  })();
};
