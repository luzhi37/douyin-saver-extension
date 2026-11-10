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
