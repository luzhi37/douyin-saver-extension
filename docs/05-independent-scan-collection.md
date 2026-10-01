# 05 · 独立模式（逆向）— 扫描收藏

> 职责边界：`FETCH_COLLECTION` 在**独立模式**下的完整链路——background 直接翻页 POST `/aweme/v1/web/aweme/listcollection/`。该端点被服务端 Argus 额外校验，必须携带 **webSign 签名**（`IndependentClient.request` 已默认开启 webSign，独立模式全端点生效）；本文同时收录该签名的逆向定案、绑定域实验结论与盐轮换处置指南。

## 概述

options「扫描收藏」→ `collections.openScanDialog(cfg)`（`needSecUid:false`，收藏归属由 Cookie 决定，不传 sec_user_id）→ `FETCH_COLLECTION` → background 分流到 `handleIndependentFetchCollection`：

- while 循环翻页：环境参数走 query（`buildBaseParams()`），业务分页参数 `count/cursor` 走 urlencoded body——空 body 的 POST 固定被 Argus 以 `Signature Not Found` 拒绝；
- 每页经 `independentRequest(..., { method:"POST", ... })` 发出，叠加 Argus webSign 三件套头（request 内默认开启）；
- 条目经 `formatWork` 归一化（带 `authorFollowed`），进度 `COLLECTION_PROGRESS` 含未关注计数；
- 结果 `{ ok, requestId, works, timedOut }` 一次性返回 options，渲染未关注作品网格并提供「添加」（SAVE_WORKS 批量入库）与「取消收藏」（见 [06](./06-independent-cancel-collection.md)）两个动作。

> 边界说明：**点赞扫描（FETCH_FAVORITES）无独立分支**——favorite GET 端点受 Turing 风控验证，独立模式不可用（待补充：如需支持须另行逆向 Turing 方案）。点赞扫描仅 Tab 模式，链路见 [09](./09-inject-tab-mode.md)。

## 核心流程图（文字描述）

```
options: collections.openScanDialog({ buildFetchArgs: () => ({ type:"FETCH_COLLECTION" }), needSecUid:false })
  → bgMsg(FETCH_COLLECTION)
    → background switch → loadIndependentMode() === true
      → handleIndependentFetchCollection(sendResponse)
          ├─ ensureABogus()
          ├─ requestId = randomUUID()；注册 cancelHandler
          └─ while (hasMore && !cancelled):
               data = independentRequest(API.COLLECTION, buildBaseParams(), {
                 method: "POST",
                 headers: { "Content-Type": "application/x-www-form-urlencoded" },
                 body: new URLSearchParams({ count: "20", cursor }).toString(),
                 referrer: "https://www.douyin.com/user/self?showTab=favorite_collection",
               })
               status_code===0 且 aweme_list 为数组？
                 ├─ 空数组 → break
                 ├─ all.push(...aweme_list.map(formatWork).filter(Boolean))
                 ├─ hasMore = has_more===true|1
                 └─ cursor = data.cursor || data.max_cursor || cursor+20
               un = all.filter(w => w.authorFollowed === false).length
               sendMessage(COLLECTION_PROGRESS { collected, unfollowedCount, hasMore, total, requestId })
               页间延迟 syncFollowings MIN~MAX ms
          ├─ 移除 cancelHandler
          └─ sendResponse({ ok:true, requestId, works: all, timedOut: cancelled })

options: 渲染 favGrid → 标题 (未关注N/总数) → 「添加 N」/「取消收藏」按钮
```

### 一次请求的完整要素表

| 要素 | 来源 | 缺失/过期的后果 |
|---|---|---|
| 登录态 Cookie | 实时 cookie jar（`credentials:"include"`）；门禁读 `savedCookie` 缓存 | 未登录 / 数据为空 |
| `webid` | 实时 Cookie → `savedWebId` 缓存 → WEBID API 兑换 | 设备身份不认 |
| `uifid` / `odin_tt` | **必须取当前登录会话的实时 Cookie**（缓存滞后会 sign invalid） | 签名与会话不一致 |
| 浏览器特征 | `browserFeatures` 缓存（cpu/屏幕/UA 族等） | 特征指纹矛盾 |
| `msToken` | 五级来源（下节） | 严格端点直接 403 |
| `a_bogus` | ABogus 类对 `qs+method` 本地签名 | 参数被认定篡改 |
| **webSign** | 本文算法（request 默认开启，全端点生效） | `Signature Not Found` |
| Referer / Sec-Fetch-* | DNR rule 3 + rule 4 注入（见 [08](./08-dnr-rules.md)） | 缺头被拦 |
| 时钟偏移 | `getClockSkew()` 校正本地钟差 | 时间戳类签名全歪 |

### msToken 五级来源

```
① savedMsToken 缓存（无过期逻辑）
② douyin.com cookie jar 的 msToken（注：页面 SDK 走 mssdk 兑换后签发域在 bytedance.com，
   jar 里没有 msToken 属正常现象）
③ mssdk 兑换：先删 bytedance.com 旧 msToken cookie → POST 静态载荷（identity/crypto.js 的
   MSSDK_STR_DATA）到 mssdk.bytedance.com/web/common（DNR rule 7 补 Origin/Referer）→
   SW 读不到 Set-Cookie，
   从 bytedance.com jar 读回新签发的真 token（参考 TikTokDownloader src/encrypt/msToken.py）
④ savedCookie 字符串正则提取 msToken=…
⑤ 兜底：generateRandomMsToken() 156 位随机字符（服务端不认，严格端点 403）
判别手段：真 token 字符集不含 - / _ = ；刷新结果带这些字符即走了兜底。
设置面板「刷新」= 删 savedMsToken 重走 getMsToken()，jar 无值时必然触发一次兑换。
```

### Argus webSign 算法（定案速查卡）

```text
ts  = floor((Date.now() + clockSkew) / 1000)            // 与 a_bogus 共用 getClockSkew()
qs' = <环境参数qs含msToken/uifid/odin_tt> + "&a_bogus=" + ab + "&timestamp=" + ts
sig = md5_hex( uifid + "_" + ts + "_" + SALT + "_" + qs' )
query = qs' + "&x-secsdk-web-signature=" + sig           // POST body: count=&cursor=

headers += { uifid, x-secsdk-web-signature: sig, x-secsdk-web-expire: String(ts) }
SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"                // CONFIG.WEB_SIGN_SALT
```

- 待签串是**最终发送的完整 query 去掉 sig 自身**（含 a_bogus 与 timestamp，键顺序一致）——改任意参数即 `Sign Invalid`；
- `uifid` 不参与待签串，但服务端另行校验其归属（不匹配返回 `Validate Error`）；
- `params.uifid` 缺失时跳过签名走旧路径（宁可 403 不可崩）；
- 盐为 secsdk 动态策略常量，2026-08 实测跨会话稳定；**抖音换策略版本则盐变更**，症状与处置见下文"复发处置"；
- 启用范围：`IndependentClient.request` 默认开启（`options.webSign !== false`），独立模式全端点生效——aweme/post 曾因风控间歇强制缺签 403 `Signature Not Found`（见 [07](./07-independent-fetch-user-works.md)），故不再按端点逐个开启；GET 点赞 favorite 在页面上也观察到 webSign 痕迹但未强制实测。

## 接口 / 方法签名

```js
// background/tasks/independent-tasks.js
async function handleIndependentFetchCollection(sendResponse)
// 出参：{ ok:true, requestId, works: Work[], timedOut: boolean }
//     | { ok:false, error }
// 进度：COLLECTION_PROGRESS { collected, unfollowedCount, hasMore, total, requestId }

async function getMsToken() -> Promise<string>      // 五级来源，结果写回 savedMsToken
async function mintMsToken() -> Promise<string>     // mssdk 兑换，失败返回 ""
async function getClockSkew() -> Promise<number>    // HEAD douyin.com 取 Date 头，缓存 5 分钟
function getWebId() / refreshWebIdChain()           // webid 三级获取 / 强制重取并回写 cookie
```

```js
// identity/crypto.js
export class Crypto { ... static md5Hex(...) -> string }   // 标准 MD5 → 32 位小写 hex（SW 无 node crypto，纯 JS 实现）

// options/ —— 下游消费
Favorites.openScanDialog(cfg)                        // cfg 见 01 文档扫描入口；needSecUid=false
#renderGrid / 「添加」按钮 → SAVE_WORKS { works: 未关注 targets }
```

Tab 模式对照：同消息走 `handleFetchCollection`，逐页 `sendToTabAsync("FETCH_COLLECTION_PAGE")` → inject `fetchOneCollectionPage`——签名方式完全不同：剥离 SDK 注入键后直接 `window.fetch`，由抖音页面自己的 fetch 包装器注入新鲜签名（详见 [09](./09-inject-tab-mode.md)）。

## 关键代码片段

### independentRequest 的 webSign 分支

```js
let urlQuery = qs + "&a_bogus=" + a_bogus;
const webSignHeaders = {};
if (options.webSign !== false) {                    // 默认开启；显式传 false 才关闭
  const uifid = String(params.uifid || "");
  if (uifid) {                                          // 无 uifid 宁可 403 不可崩
    const tsSec = Math.floor((Date.now() + (await getClockSkew())) / 1000);
    urlQuery += "&timestamp=" + tsSec;
    const sig = md5Hex(uifid + "_" + tsSec + "_" + CONFIG.WEB_SIGN_SALT + "_" + urlQuery);
    urlQuery += "&x-secsdk-web-signature=" + sig;
    webSignHeaders.uifid = uifid;
    webSignHeaders["x-secsdk-web-signature"] = sig;
    webSignHeaders["x-secsdk-web-expire"] = String(tsSec);
  }
}
const url = CONFIG.URL_BASE + apiPath + "?" + urlQuery;
```

### 线格式三段（正确形态）

```text
query 段 —— 全部是环境参数，不含业务分页参数：
  device_platform / aid / channel / version_code … browser_* / os_* / downlink /
  effective_type / round_trip_time / webid / uifid / odin_tt / msToken / a_bogus /
  timestamp / x-secsdk-web-signature
body 段 —— urlencoded 业务分页参数，仅两个：count=20&cursor=<N>
header 段 —— 必带三件套 + Content-Type：
  uifid / x-secsdk-web-signature / x-secsdk-web-expire
  Content-Type: application/x-www-form-urlencoded
```

三个反直觉要点：① count/cursor 必须在 body 不放 query（与参考项目 TikTokDownloader 同端点形态一致）；② **不传 sec_user_id**（归属由 Cookie 决定，页面真实请求里没有该参数，旧实现带它是错误形态）；③ 分页推进用响应 `has_more` + `cursor/max_cursor`。

## 一次完整请求的拼装实例（真实骨架走查）

> 会话敏感值（webid/uifid/odin_tt/msToken/各签名）每次会话都不同，以 `<占位>` 表示；作品 ID 取自扩展导出库真实数据。本节把上文算法落到"一条能直接发出的 HTTP 报文"。

### 拼装顺序（五步）

```
① buildBaseParams({})          → 环境参数全集（无业务键，注意不传 sec_user_id）
② params.msToken = getMsToken() → 五级来源取真 token
③ qs = URLSearchParams(params)  → a_bogus = ABogus(qs, "POST", clockSkew)
④ urlQuery = qs + "&a_bogus=…" + "&timestamp=<ts秒>"
   sig = md5(uifid_ts_SALT_urlQuery)
   urlQuery += "&x-secsdk-web-signature=" + sig
⑤ body = "count=20&cursor=0"    → 三段各自就位后 fetch 发出
```

### 最终报文形态

```text
POST https://www.douyin.com/aweme/v1/web/aweme/listcollection/
Cookie: （credentials:"include" 自动携带当前登录会话）
Referer: https://www.douyin.com/user/self?showTab=favorite_collection   ← DNR rule 4 网络层注入
Sec-Fetch-Site/Dest/Mode: same-origin/empty/cors                        ← DNR rule 4 补齐
uifid: <uifid>
x-secsdk-web-signature: <sig>
x-secsdk-web-expire: <ts秒>
Content-Type: application/x-www-form-urlencoded

-- query 段（全部环境参数 + 签名族，绝无业务分页键）--
device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1
&version_code=290100&…&browser_name=Edge&…&os_name=Windows&…
&downlink=10&effective_type=4g&round_trip_time=200&support_h265=0&support_dash=1
&webid=<webid>&uifid=<uifid>&odin_tt=<odin_tt>&msToken=<真token>
&a_bogus=<a_bogus>&timestamp=<ts秒>&x-secsdk-web-signature=<sig>

-- body 段（仅两个业务键）--
count=20&cursor=0
```

每个签名槽位的来历：`a_bogus` 由 ABogus 对"③ 的完整 qs + 方法名 POST"本地计算；`timestamp` 取服务器校正后的秒级时钟；`sig` 是 `md5_hex(uifid + "_" + ts + "_" + SALT + "_" + 含 a_bogus 与 timestamp 的完整 urlQuery)`——待签串就是最终 query 剥掉 sig 自身，改任何一键即 Sign Invalid（V 系列实验逐条验证过）。

### 身份归属与翻页推进

身份完全由 Cookie 决定：同一账号在任何设备扫描结果一致；query/body 均不带 sec_user_id。翻页用响应回传的游标原样回填：

```text
第 1 页  body: count=20&cursor=0   → aweme_list[20]  has_more=1  cursor=<N1>（服务端 opaque 值）
第 2 页  body: count=20&cursor=<N1> → …
…
末页    aweme_list=[] 或 has_more=0 → 收尾；timedOut 标志区分用户取消
```

响应里每条 `aweme_list[]` 即一个完整 aweme 结构（如 `aweme_id: "7267428670501915945"`），经 `formatWork` 走三级取链归一化——直链构成解剖见 [02](./02-independent-sync-works.md) 第四步。

## 异常场景及处理

### 服务端三种拒绝文案（三层校验的路标）

| 服务端返回 | 含义 | 排查方向 |
|---|---|---|
| `Signature Not Found` | 没带签名（缺 header/query，或 body 形态不对——空 body 固定触发） | 对比缺失面：diff 页面成功请求与本扩展失败请求 |
| `Sign Invalid` | 带了但算错（待签串不一致 / 盐不对 / ts 不匹配） | 逐字节比对明文；确认待签串键序 |
| `Validate Error` | 签名自洽，但 uifid 与会话归属不符 | 检查 uifid 来源是否当前登录会话 |

### 其他异常

| 场景 | 表现 | 处理 |
|------|------|------|
| `savedCookie` 缺失 | 抛 `NO_COOKIE` | 设置面板刷新 Cookie |
| msToken 只有兜底假值 | listcollection 403 | 设置面板「刷新」强制走 mssdk 兑换 |
| a_bogus 被拒 `web_id_sign_invalid` | independentRequest 自动刷新 webid 重试一次 | 内建 `_webIdRetried` 防死循环 |
| 用户取消 | `CANCEL_ACTIVE_TASK` → cancelled | 返回已收集部分，`timedOut:true`；options 显示「已超时退出，仅获取部分数据」 |
| 盐轮换（复发） | 此前能用的版本突然固定 `Signature Not Found` 且线格式无误 | 见下方处置指南 |

### 复发处置指南：盐轮换了怎么办（约几分钟）

1. 打开抖音收藏页让页面自己发一次 listcollection，抓完整请求；
2. 取出新样本的 `uifid / timestamp / x-secsdk-web-signature` 及其完整 query；
3. **反解盐**：公式已知，明文只剩盐一段未知——构造 `candidate = uifid_ts_???_qs'` 对 `???` 枚举候选段（或新旧样本联立消元）即可锁定新盐（黑盒法此时重新可用）；
4. 更新 `CONFIG.WEB_SIGN_SALT`，`chrome://extensions` 重载，重放验证。

### 逆向方法论备忘（下次遇到同类防线照此复用）

- 凭据刷新无效的 403 → 先 diff 请求形态，别死磕 Cookie；
- 响应错误文案就是规格书（Not Found=没带 / Invalid=算错 / Validate=归属不符）；
- 签名 header 名字面量全局搜索 → 一发命中生成者所在 secsdk bundle；hook `XMLHttpRequest.open` 抓调用栈定位分支（who）；
- hook `CryptoJS.MD5` 等加密原语打印明文还原公式（what）——对抗混淆性价比最高的手段；
- 黑盒爆破仅当输入无未知常量时可用；失败即提示"有盐"；
- 绑定域实验（基于已知 200 样本逐项增删改重放）摸清服务端校验语义：timestamp 参与签名、query 任意增删皆触发 Sign Invalid、sig 在 query/header 双落点、主机域名不是变量；
- 移植先用 `(明文,摘要)` 对照对逐字节验证 `md5Hex`，再做服务端端到端（含翻页）预演；
- 参考项目能抄的是架构与线格式（TikTokDownloader 无 webSign 实现），新防线通常要自己逆。

> 当时的实验脚本已随临时目录清理删除（2026-08-24）；可复用工具已内联本文附录，复发时直接取用。

## 附录 A · 复发工具箱：两段逆向钩子脚本

> 这两段是复发时的最小工具集——正文方法论中"抓调用栈定位生成者（who）"与"hook 加密原语还原公式（what）"的落地实现。Playwright 环境下使用，也可改写为 DevTools Snippet。

### A.1 hook XMLHttpRequest.open 抓调用栈（定位 webSign 附加分支）

```js
// 页面加载前包一层 open：secsdk 包装了 XHR 原型链，任何 XHR 的 new Error().stack
// 都会经过它的包装层。凡 URL 命中目标端点就记录调用栈与「URL 是否已带签名」。
async page => {
  await page.addInitScript(() => {
    const OXO = XMLHttpRequest.prototype.open;
    window.__xhrStacks = [];
    XMLHttpRequest.prototype.open = function (m, u) {
      try {
        const us = String(u);
        if (/listcollection/.test(us) && window.__xhrStacks.length < 4)
          window.__xhrStacks.push({
            hasSig: /x-secsdk-web-signature/.test(us),
            stack: String(new Error().stack || "").slice(0, 4500),
          });
      } catch (_) {}
      return OXO.apply(this, arguments);
    };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}
```

预期产出：栈中出现 secsdk bundle 的 `executeXHRRequestOpen` 帧——它在放行真正的 `open()` 前按策略开关分支，`"webSign"` 分支经 `window.use("webSignUrl")` 取签名器模块（导出入口形如 `byted_acrawler.frontierSign(url)`）。在此下断点确认每次 XHR 均命中即找到生成者。

### A.2 hook CryptoJS.MD5 打印明文（还原待签串公式）

```js
const __origMD5 = CryptoJS.MD5.bind(CryptoJS);
CryptoJS.MD5 = (msg, ...rest) => {
  console.log("[md5]", String(msg));
  return __origMD5(msg, ...rest);
};
```

预期产出：形如 `<uifid>_<ts>_<盐>_<完整query'>` 的待签明文原文（约 716 字符），与该请求自身的 URL 逐段比对即可出土公式与盐。移植 md5Hex 后，用抓到的 `(明文, 摘要)` 对照对逐字节验证实现正确性，再做服务端端到端预演（cursor=0 与 cursor=20 两页均应 200）。

## 附录 B · V 系列绑定域实验记录

以一份已知 200 的页面形态重放样本为基准（R13；落在边缘域名 `www-hj.douyin.com` 上也照常通过 → **主机不是变量**），对 URL 逐项做单参数增删改后用同一 Cookie 重放：

| 变体 | 改动 | 结果 | 结论 |
|---|---|---|---|
| V0 | 原样重放 | **200** | 短时效内重放可行 |
| V1 | timestamp=ts+1，sig 不动 | Sign Invalid | ts 参与签名 |
| V2 | 删 query 里的 sig 参数 | Signature Not Found | query 也必须有 sig（header/query 双落点） |
| V3 | 删业务参数 `probe_test=1` | Sign Invalid | 任意 query 参数都参与待签串 |
| V4 | 追加垃圾参数 | Sign Invalid | 增、改皆触发 |
| V5 | uifid 尾字符换 X | Validate Error | **uifid 不在待签串，但服务端另验其与会话的归属一致性** |
| V7 | timestamp=当前时间，sig 不动 | Sign Invalid | sig 与 ts 强绑定 |

三种服务端错误文案精确对应三层校验（正文"异常场景"表的路标即由此实验得出）。

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.WEB_SIGN_SALT` | `A96D855A08C0A9707F8BEF0D9A527E4E` | Argus webSign 盐；盐轮换时更新此处 |
| `CONFIG.PAGE.FAVORITES` | 20 | body 中每页条数 |
| `runtimeConfig.syncCollectionDelayMin/Max` | 500/1000ms | 页间延迟 |
| `runtimeConfig.timeoutRequest` | 30000ms | 单请求超时 |
| `CONFIG.MSSDK.API` + `MSSDK_STR_DATA` | — | msToken 兑换端点与静态载荷 |
| `CONFIG.WEBID_API` + `WEBID_QUERY` | — | webid 兑换端点与 query |
| DNR rule 4 / rule 3 | — | 本端点 Sec-Fetch-* 补齐与泛用 Referer（见 08） |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | chrome.storage.local 凭据缓存键表、openScanDialog 下游 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | independentRequest 非 webSign 主路径、buildBaseParams 会话敏感项 |
| 06 | [06-independent-cancel-collection.md](./06-independent-cancel-collection.md) | 扫描结果「取消收藏」动作的独立模式实现 |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | 「添加」按钮 SAVE_WORKS 进入的合并路径（mergeWork 去重保护） |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 4（本端点专用 priority 2 规则）与 rule 7（mssdk 兑换头） |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | Tab模式 fetchOneCollectionPage 的"包装器代签"方案对照 |
| — | [TIKTOK_REFERENCE.md](./TIKTOK_REFERENCE.md) | `/aweme/listcollection/` 端点表、msToken 模块对照 |
