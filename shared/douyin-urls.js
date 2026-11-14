// ---------- 抖音 URL 构造（background / options 单一来源） ----------
// 纯常量/纯函数模块：不依赖 chrome.* / DOM。

export const URL_BASE = "https://www.douyin.com";
export const URL_USER_SELF = URL_BASE + "/user/self";

// 个人主页 tab 查询串（键名沿用域语义）
export const TAB_QUERY = Object.freeze({
  favorites: "?showTab=like",
  collections: "?showTab=favorite_collection",
  followings: "?showTab=following",
});

// 个人主页 tab 完整 URL（favorites/collections/followings）
export function tabUrl(domain) {
  return URL_USER_SELF + (TAB_QUERY[domain] || "");
}

// 作者主页 URL（入参为 secUid；与既有落库值保持同一拼接口径，空值得到 URL_BASE + "/user/"）
export function profileUrl(secUid) {
  return URL_BASE + "/user/" + (secUid || "");
}
