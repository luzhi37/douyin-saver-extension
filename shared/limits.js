// ---------- 跨层数值上限（background / options 单一来源） ----------
// 纯常量模块：不依赖 chrome.* / DOM。改数值只改这里。

// options 活动 DOM 硬上限；background 网格首屏页大小必须与之相等——
// 小于它首帧铺不满活动窗口，大于它白拉一批不可挂载的记录。
export const GRID_MOUNT_MAX = 600;

// 回顾：默认抽取数量 / 单批上限 / 排除集上限。
// options 用于设置面板与抽取钳制，background 用于抽样与落库截断，两侧必须同值。
export const REVIEW_DEFAULT_COUNT = 20;
export const REVIEW_MAX_COUNT = 500;
export const REVIEW_MAX_EXCLUDE = 2000;

// 消息分块：chrome.runtime 单条消息（请求/响应同限）硬上限 64MiB，大文本双向传输必须分块。
// 按字符数计量：CJK 内容序列化后最多 ~3 字节/字符，8M 字符 ≈ 最大 24MB 消息体，留足余量。
// 阈值/块大小两侧必须同值（options 决定切分，background 决定缓冲拼合）。
export const EXPORT_CHUNK_CHARS = 8 * 1024 * 1024;         // 导出每块目标长度（字符）
export const TRANSFER_SESSION_TTL = 5 * 60 * 1000;         // 分块传输会话过期（导出键快照 + 导入缓冲，滑动续期）
export const IMPORT_TRANSFER_THRESHOLD = 16 * 1024 * 1024; // 导入文件超过该字符数时分块上行
export const IMPORT_TRANSFER_CHUNK = 8 * 1024 * 1024;      // 导入单块字符数
export const EXPORT_BATCH_KEYS = 500;                      // 导出块内逐批 getBatch 的键批大小
