# Fetch 调用方式与缓存保护机制

## 背景

inject.js 在 Douyin 页面运行时需要拦截网络请求来捕获签名参数（`verifyFp`、`msToken`、`a_bogus` 等），同时扩展自身也需要发起 API 请求（同步作品、扫描点赞/收藏等）。

这两件事共用 `window.fetch` 时产生了冲突：扩展自身的请求走完 Fetch Hook 后，Hook 内的 `captureFromUrl` 将请求 URL 参数回写入缓存，污染了下一次请求使用的签名参数。

---

## 两条 fetch 路径

### 1. `origFetch.call(window, url, ...)` — 绕过 Hook

```js
const origFetch = window.fetch;   // 在 Hook 安装前捕获
const resp = await origFetch.call(window, url, { ... });
```

- **不做**任何 Hook 处理（无 capture、无 work 提取）
- 请求 URL 完全由调用方构造，不依赖 Hook 注入
- 风险：Douyin 可能通过覆盖 `window.fetch` 来注入 token，走 `origFetch` 会错过这个注入

### 2. `window.fetch(url, ...)` — 经 Hook

```js
const resp = await window.fetch(url, { ... });
```

- 经过 Fetch Hook → Hook 内的 `origFetch`（可能是 Douyin 的 wrapper 或原生 fetch）
- **优势**：若 Douyin 通过覆盖 `window.fetch` 注入 token，走这条路可以自动获得
- **代价**：Hook 的 `captureFromUrl` 会将请求 URL 参数回写入对应缓存，造成自污染

---

## 六类 API 请求

| 函数 | 端点 | 合并的缓存变量 | 保护机制 |
|---|---|---|---|---|
| `fetchOneDetail` | `/aweme/detail/` | `__lastCapturedDetailQuery` | fetch options 中 `_dyInternal: true` |
| `fetchOneFavoritesPage` | `/aweme/favorite/` | `__capturedFavoriteQuery` | fetch options 中 `_dyInternal: true` |
| `fetchOneCollectionPage` | `/aweme/listcollection/` | `__capturedCollectionQuery` | fetch options 中 `_dyInternal: true` |
| `fetchAuthorWorks` | `/aweme/post/` | `__capturedPostQuery` | fetch options 中 `_dyInternal: true` |
| `fetchFollowingPage` | `/user/following/list` | `__capturedFollowingQuery` | fetch options 中 `_dyInternal: true` |
| `cancelOne` | 收藏/点赞取消 | 无（XHR，不走 fetch） | 不适用 |

**注意**：`fetchFollowingPage` 还有后备逻辑——当 `__capturedFollowingQuery` 为空时按优先级尝试其他缓存的签名参数：

```js
const sigSource = __capturedFollowingQuery || __capturedPostQuery
                || __capturedFavoriteQuery || __capturedCollectionQuery;
```

---

## `_dyInternal` 保护机制

### 为什么需要

每个 fetch 函数在请求前会从缓存变量合并签名参数到 URL。如果该请求走 `window.fetch`，Fetch Hook 响应后调用 `captureFromUrl`，将包含完整 URL 参数（含合并进来的签名）的 Map 重新写入缓存。下一次请求再读取时，缓存中的签名参数是为上一个 `aweme_id` 计算的，导致抖音拒绝请求（空 body → `RATE_LIMITED`）。

#### 为什么抖音请求不污染，而扩展请求会？

| | 抖音真实请求 | 扩展请求（无 `_dyInternal`） |
|---|---|---|
| **签名来源** | 抖音 JS **现场实时计算** | `mergeParams` 从缓存 **复用** 的旧签名 |
| **capture 结果** | 新鲜签名写入缓存 → 缓存被 **更新** ✅ | 旧签名 + 扩展特定参数（`aweme_id`、`cursor` 等）写回缓存 → **自污染** ❌ |
| **下次请求后果** | 缓存中的签名参数是最新的，请求通过 | 缓存中的签名参数搭配的是上一个请求的 `aweme_id`，服务器校验不通过 → `RATE_LIMITED` |

抖音的请求是**签名的生产者**——它们是缓存数据的唯一来源。扩展的请求应当是**签名的消费者**——它们读取缓存但不应写回。`_dyInternal` 让扩展请求在 Hook 中"隐身"：不 capture、不 dispatch，只透传到网络层。

### 工作原理

每个 API 函数在 fetch options 中添加 `_dyInternal: true` 标志，Hook 检测到该标志后完全跳过 `captureFromUrl` 和 `dispatchWorks`：

```js
// 在 API 函数中
const resp = await window.fetch(url, {
  credentials: "include",
  _dyInternal: true,  // ← 标记为扩展内部请求
});

// 在 Fetch Hook 中
const options = args[1] || {};
const isInternal = options._dyInternal === true;
const parsedUrl = !isInternal && ... ? shouldCapture(url) : null;
// ...
if (response.ok && !isInternal && ...) {
  captureFromUrl(url);  // 仅限非内部请求
}
```

### 相比 save/restore 的优势

1. **消除自污染** — Hook 完全不处理扩展请求的响应
2. **不丢弃并发真实捕获** — 扩展请求期间若抖音产生真实请求，Hook 正常更新缓存。旧 save/restore 在 `finally` 中会覆盖掉并发捕获的新 Map
3. **无样板代码** — 6 个监听器不再需要手动 save/restore
4. **一处控制** — Hook 内根据标志判断，调用方只需加一个属性

### 覆盖范围

| 函数 | 保护方式 |
|---|---|
| `fetchOneDetail` | `fetch()` options 中 `_dyInternal: true` |
| `fetchOneFavoritesPage` | `fetch()` options 中 `_dyInternal: true` |
| `fetchOneCollectionPage` | `fetch()` options 中 `_dyInternal: true` |
| `fetchAuthorWorks` | `fetch()` options 中 `_dyInternal: true` |
| `fetchFollowingPage` | `fetch()` options 中 `_dyInternal: true` |
| `cancelOne` | XHR，不走 fetch，不适用 |

---

## 历史决策

### 初始状态（saver + tools 合并）

代码库由两个独立项目合并而来：

- **saver**（`fetchOneDetail`、按钮注入、保存逻辑）：使用 `window.fetch`，无缓存保护
- **tools**（`fetchOneFavoritesPage`、`fetchOneCollectionPage`、`fetchAuthorWorks`、`fetchFollowingPage`、取消逻辑）：使用 `origFetch.call(window, ...)` 绕过 Hook

合并后 Fetch Hook 被引入用于签名捕获，tools 方的函数因为用 `origFetch.call` 从未触发自污染。saver 方的 `fetchOneDetail` 是唯一遗漏未改的函数。

### 第一次统一（save/restore）

发现 `fetchOneDetail` 的 `window.fetch` 造成 `__lastCapturedDetailQuery` 自污染 → 重载扩展后第一个同步作品成功、后续全 `RATE_LIMITED`。

尝试方案：
1. `origFetch.call(window, ...)` → 缓存为空时（扩展重载后尚未浏览抖音详情页）无 token，全部失败 ❌
2. `window.fetch` + save/restore → 缓存为空时仍无 token，但不会恶化；缓存非空时 token 正确且不被污染 ✅

首次统一将全部 6 个 API 请求函数改为 `window.fetch` + save/restore 模式。

### 第二次统一（`_dyInternal`）

save/restore 存在两个问题：
1. 样板代码散落在 6 个监听器中，容易遗漏
2. `finally` 恢复原 Map 时会覆盖请求期间真实抖音请求捕获的新签名

改用 `_dyInternal` 标志彻底解决：Hook 直接跳过内部请求的处理，无需依赖事后恢复。
