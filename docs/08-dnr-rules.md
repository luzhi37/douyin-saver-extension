# 08 · DNR 规则（Declarative Net Request）

> 职责边界：扩展注册的全部动态 DNR 规则——匹配条件、头改写动作、优先级关系，以及每条规则存在的网络层原因。规则定义于 `background/background.js` 的 `CONFIG.DNR_RULES`，是独立模式各端点可用性的共同前提（02–07 各文档不再重复）。

## 概述

MV3 Service Worker 发起的跨域请求有两个先天问题：

1. **Sec-Fetch-* / Origin 元数据暴露身份**：SW fetch 的这些头是 `chrome-extension://` 语义，抖音服务端直接拒绝；
2. **forbidden header 无法用 JS 设置**：Referer 在 fetch headers 里会被浏览器静默忽略。

DNR 是唯一能在网络层改写这些头的手段。全部 7 条规则在 `onInstalled` / `onStartup` 时经 `updateDynamicRules` 注册：先 `getDynamicRules()` 取现有 id 全量 remove，再 add 当前 `CONFIG.DNR_RULES`（声明式对账，代码即最终态）。所有作用于 douyin API 的规则都带 `excludedInitiatorDomains: ["www.douyin.com","douyin.com"]`，保证**抖音页面自身请求的原生头不被触碰**。

## 核心流程图（文字描述）

### 规则生效链

```
chrome.runtime.onInstalled / onStartup
  → setupDeclarativeNetRequest()
      getDynamicRules() → existingIds
      updateDynamicRules({ removeRuleIds: existingIds, addRules: CONFIG.DNR_RULES })
      失败仅 console.warn("[DY-Manager] DNR setup failed")

请求命中判定顺序（同 URL 可能命中多条，按 priority + id 决胜）：
  SW 发起 listcollection POST ─→ rule 4 (p2) 覆盖 rule 3 (p1)
  SW 发起取消收藏 POST       ─→ rule 5 (p2) 覆盖 rule 3 (p1)
  SW 发起取消点赞 POST       ─→ rule 6 (p2) 覆盖 rule 3 (p1)
  SW 发起其他 aweme/v1/web GET（同步作品/关注/校准/作者列表）─→ 仅 rule 3 (p1)
  SW 发起 mssdk.bytedance.com 兑换                            ─→ rule 7 (p1)
  页面内媒体/图片直链加载                                     ─→ rule 1 / rule 2 (p1)
```

## 接口 / 方法签名

```js
// background.js
async function setupDeclarativeNetRequest()   // 幂等全量对账注册；无入参出参
// chrome.runtime.onInstalled.addListener(… setupDeclarativeNetRequest + 默认分组初始化 + reloadRuntimeConfig …)
// chrome.runtime.onStartup.addListener(setupDeclarativeNetRequest)
```

规则对象即标准 MV3 DNR Rule 结构：`{ id, priority, condition: { urlFilter, resourceTypes, excludedInitiatorDomains }, action: { type:"modifyHeaders", requestHeaders:[{header, operation:"set"|"remove", value?}] } }`。

## 规则明细表

| ID | priority | 匹配 | 动作 | 用途 |
|----|----------|------|------|------|
| 1 | 1 | `douyinvod.com`，media/image/xhr | Set `Referer: https://www.douyin.com/`、`Origin: https://www.douyin.com` | 视频 CDN 防盗链（详情播放器、下载取流） |
| 2 | 1 | `douyinpic.com`，image/xhr | Set `Referer: https://www.douyin.com/` | 图片 CDN 防盗链 |
| 3 | 1 | `\|\|douyin.com/aweme/v1/web/`，xhr/other，排除 douyin.com 发起方 | Remove `Sec-Fetch-Site/-Mode/-Dest/-User/-Storage-Access`、`Origin`、`Accept-Language`；Set `Accept-Encoding: gzip, deflate`、`Referer: https://www.douyin.com/` | 独立模式所有 API 请求的基线改写：剥离扩展身份元数据、伪装页面 Referer |
| 4 | **2** | `\|\|douyin.com/aweme/v1/web/aweme/listcollection/`，xhr/other，排除 douyin.com 发起方 | Set `Sec-Fetch-Site: same-origin`、`Sec-Fetch-Mode: cors`、`Sec-Fetch-Dest: empty`、`Accept-Language: zh-CN,zh;q=0.9`、`Referer: …/user/self?showTab=favorite_collection` | 收藏扫描 POST（05）：POST 端点严格校验同源 fetch 元数据，需补回 Sec-Fetch-*；priority 2 压过 rule 3 的 remove。**绝不可 set Origin**——真实同源请求不带 Origin，same-origin+Origin 非法组合被 WAF 拦截 |
| 5 | **2** | `\|\|douyin.com/aweme/v1/web/aweme/collect/`，xhr，排除 douyin.com 发起方 | 同 rule 4 的五项 set（Referer 为 `showTab=favorite_collection`） | 取消收藏 POST（06）：与 rule 4 同理补回元数据并使精确 Referer 真正生效（原先与 rule 3 同级、低 id 被覆盖，实际一直用的是 rule 3 泛用值——升 p2 后才修正） |
| 6 | **2** | `\|\|douyin.com/aweme/v1/web/commit/item/digg/`，xhr，排除 douyin.com 发起方 | 同 rule 4 的五项 set（Referer 为 `showTab=like`） | 取消点赞 POST：与 rule 5 同理。注意该端点目前只有 Tab 模式 XHR 使用（XHR 不受 DNR 影响场景为页面内发起，被 excludedInitiatorDomains 排除）；rule 6 服务于未来可能的独立分支 |
| 7 | 1 | `\|\|mssdk.bytedance.com/`，xhr/other，排除 douyin.com 发起方 | Set `Origin: https://www.douyin.com`、`Referer: https://www.douyin.com/` | msToken 兑换（05）：SW 兑换请求 Origin 是 extension:// 且 fetch 设不了 Referer，服务端校验这两头否则拒签——表现为 mintMsToken 拿不到 Set-Cookie、静默走随机兜底 |

> resourceTypes 说明：API 类规则含 `"other"` 是因为 SW 发出的部分请求在 DNR 视角归为 other 类型；漏写会导致规则不命中且无任何报错。

## 关键代码片段

```js
// rule 4 注释原文承载的关键结论（rule 5/6 同理）：
// 关键点：真实同源请求【不会】携带 Origin 头（Origin 仅跨域请求才有），因此这里只补
// Sec-Fetch-*，绝不可 set Origin —— same-origin + Origin 的非法组合会被抖音 WAF 拦截。
// 标签页模式在 douyin.com 页面内发起请求天然携带这些头；SW 跨界请求被 rule 3 剥离，
// 此规则（优先级更高）仅对 listcollection 补回 Sec-Fetch-*，与页面内/GET 行为一致。

// mintMsToken 侧的双保险（rule 7 之外）：
const resp = await fetch(CONFIG.MSSDK.API, {
  method: "POST",
  credentials: "include",
  referrer: "https://www.douyin.com/",        // referrer 选项能影响请求头，headers.Referer 不能
  referrerPolicy: "unsafe-url",
  …
});
```

## 异常场景及处理

| 场景 | 表现 | 处理/排查 |
|------|------|-----------|
| DNR 权限缺失或注册异常 | 启动时 console.warn，规则不存在 | 独立模式所有请求 403（extension 身份暴露）；检查 manifest `declarativeNetRequest` 权限 |
| 新增 POST 端点但未加 p2 规则 | 被 rule 3 剥掉 Sec-Fetch-* 后 403 | 照 rule 4/5/6 模板复制一条 priority 2 规则，勿动 rule 3 |
| 给同源形态端点误设 Origin | WAF 直接拦截（非法组合） | 只 set Sec-Fetch-* 与 Referer/Accept-Language |
| 规则 resourceTypes 漏 "other" | 规则静默不命中 | 对照上表补全 xhr/other |
| rule 7 缺失或被改 | mintMsToken 无 Set-Cookie，getMsToken 静默降级随机 token，严格端点（listcollection）403 | 检查 rule 7；症状与 05 文档 msToken 五级来源判别手段一致 |
| 用户在抖音页面的原生请求被误伤 | 页面功能异常 | 确认规则的 `excludedInitiatorDomains` 未被删除 |
| 动态规则被其他逻辑残留污染 | 行为与代码不符 | 重载扩展触发 onInstalled 全量对账重建 |

## 配置项说明

| 配置 | 位置 | 作用 |
|------|------|------|
| `CONFIG.DNR_RULES` | background.js | 7 条规则的唯一事实来源；修改后重载扩展生效 |
| manifest `permissions` | manifest.json | 必含 `declarativeNetRequest` |
| manifest `host_permissions` | manifest.json | `*://*.douyin.com/*` / `douyinvod.com` / `douyinpic.com` / `mssdk.bytedance.com` / `mcs.zijieapi.com` / `ttwid.bytedance.com`（后者当前无代码使用，属遗留待清理） |
| `CONFIG.DOUYIN_URL_PATTERN` / `DOUYIN_EXCLUDE_DOMAIN` | background.js | Tab 模式选 tab 用（非 DNR），与 excludedInitiatorDomains 语义互补：一个管"发到哪"，一个管"谁发起的不改" |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | 双模路由总览（哪些流程依赖哪些规则） |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | rule 3 消费方：detail GET |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | rule 3 消费方：following/profile-other GET |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | rule 4 + rule 7 消费方：listcollection POST 与 mssdk 兑换 |
| 06 | [06-independent-cancel-collection.md](./06-independent-cancel-collection.md) | rule 5 消费方：取消收藏 POST；fetch referrer 双保险 |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | Tab模式为何不需要 rule 4–6（页面内请求天然携带元数据） |
