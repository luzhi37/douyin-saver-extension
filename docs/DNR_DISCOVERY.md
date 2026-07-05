# DNR 规则发现与设计

> 本文档记录如何发现 Chrome Service Worker 的请求头限制，以及如何使用 declarativeNetRequest 绕过这些限制以支持独立模式。

## 1. 背景：独立模式需要后台 API 请求

扩展原有架构完全依赖抖音标签页中的 inject.js 执行 API 请求：

```
options → background → sendToTab → content.js → inject.js → fetch()
```

inject.js 运行在抖音页面的主世界，发出的请求是**同源**的，浏览器自动携带正确的 Cookie、Referer、Origin 等头，且 `Sec-Fetch-*` 头显示为 `same-origin` 或 `same-site`。

**独立模式**的目标是让 background.js（Service Worker）直接发出这些请求，无需标签页：

```
options → background → direct fetch()
```

## 2. 发现：Service Worker fetch 的限制

实现独立模式时，第一个请求就失败了。排查发现两个问题：

### 2a. 来源头暴露

Chrome Service Worker 发起的 `fetch()` 自动附带：

```
Sec-Fetch-Site: chrome-extension://<id>
Origin: chrome-extension://<id>
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
```

抖音服务器看到这些头就知道请求来自扩展，**直接拒绝**（返回空 body 或 403）。

### 2b. Referer 无法设置

`Referer` 属于 [forbidden request-header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header)，在 Chrome Service Worker 的 `fetch()` 中 JS 无法设置：

```js
// 下面这一行在 SW 中**没有效果**
fetch(url, { headers: { Referer: 'https://www.douyin.com/' } });
```

抖音的大多数 API 端点（特别是 `/aweme/v1/web/aweme/post/`）依赖 `Referer` 头做校验，缺了它返回 `{"status_code":0,"aweme_list":[]}`（空数据但没有错误码，难以排查）。

同样，`Cookie` 头虽然无法设置，但可以通过 `credentials: "include"` 让浏览器自动携带 cookie jar 中的值。

## 3. 方案：declarativeNetRequest modifyHeaders

Chrome Manifest V3 提供 `declarativeNetRequest` API，可以在**网络请求离开浏览器之前**修改请求头，不受 forbidden header 限制。

### 3a. 实现方式

```js
chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [{
    id: 3,
    priority: 1,
    condition: {
      urlFilter: "||douyin.com/aweme/v1/web/",
      resourceTypes: ["xmlhttprequest"],
      excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
    },
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        // 删除来源头，隐藏扩展身份
        { header: "Sec-Fetch-Site", operation: "remove" },
        { header: "Sec-Fetch-Mode", operation: "remove" },
        { header: "Sec-Fetch-Dest", operation: "remove" },
        { header: "Sec-Fetch-User", operation: "remove" },
        { header: "Sec-Fetch-Storage-Access", operation: "remove" },
        { header: "Origin", operation: "remove" },
        // 统一 Accept-Language（SW 默认的 en-US 可能被服务器用于判定来源）
        { header: "Accept-Language", operation: "remove" },
        // 修正 Accept-Encoding
        { header: "Accept-Encoding", operation: "set", value: "gzip, deflate" },
        // 注入 Referer——JS 无法设置，DNR 是唯一途径
        { header: "Referer", operation: "set", value: "https://www.douyin.com/" },
      ],
    },
  }],
});
```

### 3b. 关键细节

**`excludedInitiatorDomains`**：

```
excludedInitiatorDomains: ["www.douyin.com", "douyin.com"]
```

确保**抖音页面自身**发起的 API 请求的 `Sec-Fetch-*` 和 `Origin` 头**不被移除**。抖音页面内 JS 的请求需要这些头才能通过服务器校验。只有 Service Worker 发起的跨源请求才需要修改。

**`credentials: "include"`**：

Service Worker 的 `fetch()` 还需要设置 `credentials: "include"` 才能携带浏览器 cookie jar 中的 douyin.com cookie。注意，这与 JS 设置 `Cookie` header 是两回事——后者被 forbidden 规则禁止，但 `credentials` 标志位不受影响。

## 4. 演进：从 6 条到 5 条

最初的设计有 6 条规则：

| ID | 用途 |
|----|------|
| 1 | 视频 CDN `douyinvod.com`：设 Referer + Origin |
| 2 | 图片 CDN `douyinpic.com`：设 Referer |
| 3 | API 端点：删来源头 + 修正 Accept-Encoding |
| 4 | API 端点：设泛用 Referer（条件完全同规则 3） |
| 5 | 取消收藏 API：设精确 Referer（带 `showTab=favorite_collection`） |
| 6 | 取消点赞 API：设精确 Referer（带 `showTab=like`） |

后来发现规则 3 和规则 4 的 `condition`（`urlFilter`、`resourceTypes`、`excludedInitiatorDomains`）**完全相同**，DNR 允许在一个 rule 的 `requestHeaders` 数组中合并多个操作，因此合并：

| ID | 用途 |
|----|------|
| 3 | API 端点：删来源头 + 修正 Accept-Encoding + **设泛用 Referer**（合并原 3/4） |
| 5 | 取消收藏 API：设精确 Referer |
| 6 | 取消点赞 API：设精确 Referer |

共 **5 条规则**。

## 5. 为什么不能只设 Referer

只设 Referer（即原规则 4）不删来源头，请求仍然带有 `Sec-Fetch-Site: chrome-extension://` 和 `Origin: chrome-extension://`。实测某些端点（`/aweme/v1/web/aweme/post/`）即使 Referer 正确，暴露扩展来源仍会导致空响应。必须同时删除来源头。

反过来，只删来源头不设 Referer，端点的 `Referer` 依赖也得不到满足（SW 默认不带 Referer），同样失败。

## 6. 取消端点的精确 Referer

`POST /aweme/v1/web/aweme/collect/` 和 `POST /aweme/v1/web/commit/item/digg/` 需要带 `showTab` 参数的 Referer：

```
Referer: https://www.douyin.com/user/self?showTab=favorite_collection
Referer: https://www.douyin.com/user/self?showTab=like
```

规则 3 的泛用 `Referer: https://www.douyin.com/` 不够精确，服务器会拒绝。因此需要独立规则 5 和 6，用更精确的 `urlFilter` 匹配：

```js
urlFilter: "||douyin.com/aweme/v1/web/aweme/collect/"
urlFilter: "||douyin.com/aweme/v1/web/commit/item/digg/"
```

  规则 3 的泛用 `||douyin.com/aweme/v1/web/` 会匹配所有子路径，但 DNR 的【最高优先级规则胜出】机制保证：当请求 URL 同时匹配规则 3 和规则 5/6 时，后者的精确 Referer 覆盖前者的泛用 Referer（两个规则都是 `priority: 1`，但 DNR 对同一 `operation` 的 `set` 以规则 id 大的为准）。

## 7. 验证方法

在生产环境验证 DNR 规则是否生效：

1. 加载扩展，开启独立模式
2. 打开 Chrome DevTools → Application → Service Workers → inspect
3. 在 Service Worker 控制台执行：
   ```js
   const resp = await fetch("https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=<secUid>&count=1&aid=6383", {
     credentials: "include",
   });
   ```
4. 在 Network 面板中查看请求头，确认：
   - `Sec-Fetch-Site` / `Sec-Fetch-Mode` / `Origin` 等头 **不存在**
   - `Referer: https://www.douyin.com/` **存在**
   - `Accept-Encoding: gzip, deflate` **存在**
5. 响应应为有效的 `status_code: 0` + 数据，非空 body

## 8. 完整规则列表（当前）

```js
[
  { id: 1, urlFilter: 'douyinvod.com',  Referer+Origin },   // 视频 CDN
  { id: 2, urlFilter: 'douyinpic.com',   Referer },          // 图片 CDN
  { id: 3, urlFilter: '||douyin.com/aweme/v1/web/',         // API: 删来源头 + 泛用 Referer
    Sec-Fetch-* remove, Origin remove, Accept-Language remove,
    Accept-Encoding set('gzip, deflate'), Referer set('https://www.douyin.com/') },
  { id: 5, urlFilter: '||douyin.com/aweme/v1/web/aweme/collect/', // 取消收藏精确 Referer
    Referer set('https://www.douyin.com/user/self?showTab=favorite_collection') },
  { id: 6, urlFilter: '||douyin.com/aweme/v1/web/commit/item/digg/', // 取消点赞精确 Referer
    Referer set('https://www.douyin.com/user/self?showTab=like') },
]
```
