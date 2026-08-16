# Fetch 调用方式与缓存保护机制

## 背景

inject.js 拦截网络请求捕获签名参数，同时扩展自身也需要发起 API 请求。两者共用 `window.fetch` 产生冲突：扩展请求走完 Hook 后，`captureFromUrl` 将请求 URL 参数回写入缓存，污染了下一次请求使用的签名。

## `_dyInternal` 保护

每个 API 函数在 fetch options 中添加 `_dyInternal: true` 标志，Hook 检测后完全跳过 `captureFromUrl` 和 `dispatchWorks`：

```js
fetch(url, { credentials: "include", _dyInternal: true })
```

相比旧 save/restore 模式的优势：消除自污染、不丢弃并发真实捕获、无样板代码。

## 六类 API 请求

| 函数                     | 端点                     | 合并的缓存                  | 保护方式            |
|--------------------------|--------------------------|-----------------------------|---------------------|
| `fetchOneDetail`         | `/aweme/detail/`         | `__lastCapturedDetailQuery` | `_dyInternal: true` |
| `fetchOneFavoritesPage`  | `/aweme/favorite/`      | `__capturedFavoriteQuery`   | `_dyInternal: true` |
| `fetchOneCollectionPage` | `/aweme/listcollection/` | `__capturedCollectionQuery` | `_dyInternal: true` |
| `fetchAuthorWorks`       | `/aweme/post/`           | `__capturedPostQuery`       | `_dyInternal: true` |
| `fetchFollowingPage`     | `/user/following/list`   | `__capturedFollowingQuery`  | `_dyInternal: true` |
| `cancelOne`              | 收藏/点赞取消            | 无（XHR）                   | 不适用              |

`fetchFollowingPage` 有后备逻辑：当 `__capturedFollowingQuery` 为空时按优先级尝试其他缓存的签名。

`stripPageKeys` 仅剥离分页参数（`offset`/`count`/`cursor*`/`max_*`/`min_*`）。签名使用分三种方式：
- **复用捕获签名**：`fetchOneDetail` / `fetchAuthorWorks` / `fetchFollowingPage` 直接复用页面捕获的新鲜签名（作品同步 detail API 即此模式且工作正常）
- **页面 fetch 包装器注入**：`fetchOneFavoritesPage` / `fetchOneCollectionPage` 通过 `stripSdkKeys`（`SDK_INJECT_KEYS` = `a_bogus`/`timestamp`/`x-secsdk-web-signature`/`msToken`/`verifyFp`/`fp`/`uifid`）剥离签名注入项后，`mergeParams` 复用非签名业务参数（webid/sec_user_id），**直接 `window.fetch` 发出**——抖音页面覆盖 `window.fetch` 的包装器会对"未签名" URL 自动注入与最终参数集匹配的新鲜签名（实测 200 OK）。预塞旧签名会阻止包装器处理，导致 argus `web_id_sign_invalid`（403）。页面 `byted_acrawler` SDK 无 `sign` 函数（2026 版仅剩 `frontierSign`/`init` 等），不可调用

## 自污染根源

抖音真实请求是**签名的生产者**（新鲜签名写入缓存），扩展请求应当是**签名的消费者**（只读不写）。无 `_dyInternal` 时，扩展请求的 URL 参数（包含旧签名 + 扩展特定 `aweme_id`）回写入缓存，下次请求再读取时签名搭配了错误的 `aweme_id`，服务器拒绝请求（`RATE_LIMITED`）。