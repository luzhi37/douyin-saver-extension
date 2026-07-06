# 点赞/收藏扫描的独立模式适配过程

## 背景

独立模式的目标是让扩展在**没有抖音标签页**的情况下也能调用 Douyin API。作品同步（`detail` API）和关注扫描（`following` API）在独立模式下工作正常，但点赞扫描（`favorite` API）和收藏扫描（`collection` API）的服务端响应始终异常。

## 现象

使用 background service worker 的 `fetch()` 直接请求：

```
GET https://www.douyin.com/aweme/v1/web/aweme/favorite/?...&msToken=...&a_bogus=...
```

服务端返回 HTTP 200，但：

- `content-length: 0` 或 `7`
- `content-type: text/plain; charset=utf-8`（而非 `application/json`）
- `bd-ticket-guard-result: 1101`
- 有时携带 `x-vc-bdturing-parameters` 头（Turing 滑块验证）

而同一账号、同一参数集在浏览器标签页的 JavaScript 环境中请求则返回正常的 JSON 数据。

## 尝试方向

### 1. 补齐 URL 参数

与正常工作请求对比，发现缺少大量参数：

- 浏览器指纹：`cpu_core_num`, `screen_width`, `screen_height`, `browser_language`, `browser_name`, `browser_version`, `browser_online`, `engine_name`, `engine_version`, `os_name`, `os_version`, `device_memory`, `downlink`, `effective_type`, `round_trip_time`
- 验证参数：`verifyFp`, `fp`
- 额外参数：`publish_video_strategy_type`, `whale_cut_token`, `cut_version`, `update_version_code`, `pc_libra_divert`, `support_h265`, `support_dash`
- 会话参数：`webid`, `uifid`

补全后，请求参数由 14 个增加到 42 个，与正常工作请求基本一致。但依然被拦截。

### 2. 获取有效 msToken

原本 `independentRequest` 从 `savedCookie` 中解析 `msToken` 值，但 `msToken` 并非 cookie 键，始终为空。

尝试了两个方向：

- **从 cookie 提取**：`parseCookieToPairs` 解析不到 msToken，因为抖音并不把 msToken 存为 cookie
- **调用 mssdk API**：仿照 TikTokDownloader，POST 到 `https://mssdk.bytedance.com/web/common` 获取真实的 `msToken`。这个 API 会通过 `Set-Cookie` 响应头设置 msToken，需要在扩展中通过 `chrome.cookies` API 读取。目前已实现为 `fetchMsToken()` + `getMsToken()`（带 1 小时 TTL 缓存到 storage）
- **随机生成回退**：如 mssdk API 不可用，生成 156 位随机字母数字串作为假 msToken

msToken 填入后，URL 参数包含 `msToken=xxx`（非空），但依然被拦截。

### 3. 获取 webid

正常工作请求中包含 `webid` 参数。参照 TikTokDownloader，调用 `https://mcs.zijieapi.com/webid` 获取。这是一个 POST 请求，携带用户代理和应用 ID 等信息，返回 `web_id` 字段。缓存策略与 msToken 类似（1 小时 TTL）。

### 4. 尝试用 DNR 改写 `sec-fetch-site`

请求被拦截时，Chrome 自动设置 `Sec-Fetch-Site: none`（因为 service worker 不是 douyin.com 的同源环境）。正常工作请求的此值为 `same-site`。

通过 `declarativeNetRequest` 的 `modifyHeaders` action，尝试将 `Sec-Fetch-Site` 改写为 `same-site`。DNR 运行在浏览器网络栈层面，理论上可以改写这些限制性头。

结果：`sec-fetch-site` 确实被改成了 `same-site`，但响应中出现了 `x-vc-bdturing-parameters` 头——服务器返回了 **Turing 滑块验证**挑战，而非 JSON 数据。

这可能是因为 DNR 改写了 `sec-fetch-site`，但其他浏览器特征信号（client hints、TLS 指纹）与 `same-site` 声明不一致，服务器判定为"伪造的浏览器请求"。

### 5. 用 DNR 删除 `sec-fetch-*` 系列（已实施）

让请求完全不带 `sec-fetch-*` 头，模拟非浏览器 HTTP 客户端（如 Python httpx）的行为模式。当前扩展的 DNR id:3 规则会删除以下头部：

- `Sec-Fetch-Site` → remove
- `Sec-Fetch-Mode` → remove
- `Sec-Fetch-Dest` → remove
- `Sec-Fetch-User` → remove
- `Sec-Fetch-Storage-Access` → remove
- `Origin` → remove
- `Accept-Language` → remove
- `Accept-Encoding` → set 为 `gzip, deflate`

同时从 `independentRequest` 的请求头中移除了 `Origin`、`Referer`、`Accept-Language`、`sec-ch-ua*` 等浏览器特有标志，缩减到只剩 `Accept`、`User-Agent`、`Cookie`。

结果：仍然出现 `x-vc-bdturing-parameters` 头，Turing 验证持续触发。说明仅靠 HTTP 头层面的清理不足以绕过抖音的安全校验。

## 与 TikTokDownloader 的行为差异

TikTokDownloader（Python httpx）只需 cookie 和 sec_uid 即可正常工作，且**不触发** Turing 验证。两者之间有一些无法统一的因素：

| 维度 | 本扩展 (background SW) | TikTokDownloader (Python httpx) |
|---|---|---|
| 网络栈 | Chrome 浏览器内置网络层 | OpenSSL / 系统 TLS |
| TLS 指纹 | Chrome 特有（GREASE 密码套件、特定扩展顺序） | Python httpx 默认（无 GREASE） |
| HTTP/2 帧 | Chrome 的 SETTINGS 帧、PRIORITY 帧 | h2 库默认值 |
| `sec-fetch-*` | Chrome 自动添加（即使 DNR 删除，部分版本/场景仍可能残留） | 完全不发送 |
| `accept-encoding` | Chrome 加 `br, zstd`（即使 DNR 改写，协商行为不同） | httpx 默认 `gzip, deflate` |
| Cookie 携带方式 | 显式 `Cookie` header（可能触发额外校验） | 显式 `Cookie` header（行为类似） |

这些因素中哪些是决定性原因，目前还不确定。可能的原因是：

- 服务器区分"浏览器请求"和"API 客户端请求"使用不同的验证路径。Chrome 的网络栈特征（TLS 指纹、HTTP/2 帧）足以让服务器识别出请求来自浏览器环境，从而启用完整的 ticket guard + Turing 验证链
- 相反，Python httpx 没有这些特征，服务器将其归为"API 客户端"，只验证 `a_bogus` 签名和参数完整性

## 当前状态

截至本文档编写时，点赞/收藏扫描在独立模式下的处理方式为：

- `FETCH_FAVORITES`：路由无独立模式分叉，始终走 `handleFetchFavorites()`（即必须使用标签页的 `sendToTab` 路径；该端点触发 Turing 验证，无法纯 background fetch）。无标签页时返回超时或错误
- `FETCH_COLLECTION` 和 `CANCEL_COLLECTION` 已实现独立 handler，不再回退标签页
- `CANCEL_LIKE`：路由无独立模式分叉，始终走 tab 模式 `runCancelBatch`

| 操作 | 独立模式 | 备注 |
|---|---|---|
| SYNC_WORKS（作品同步） | ✅ 正常工作 | `detail` API，参数简单，不触发额外验证 |
| FETCH_FOLLOWING（关注扫描） | ✅ 正常工作 | 未发现拦截 |
| FETCH_WORKS_PAGE（作者作品） | ✅ 正常工作 | `post` API，行为同 detail（DNR rule 3 注入泛用 Referer） |
| FETCH_FAVORITES（点赞扫描） | ❌ 回退到标签页 | 纯 background fetch 持续被拦，详见上文尝试记录 |
| FETCH_COLLECTION（收藏扫描） | ✅ 正常工作 | `listcollection` POST 端点，独立 handler 成功 |
| CANCEL_COLLECTION（取消收藏） | ✅ 正常工作 | 需 `browserFeatures.securityKey`；DNR rule 5（实际 id:5）注入精确 Referer |
| CANCEL_LIKE（取消点赞） | ❌ 路由无独立模式分叉，始终走 tab 模式 `runCancelBatch` | `handleIndependentCancel` 虽支持 `kind="like"`，但 background 消息路由未对其做独立模式分支 |

## 未探索的方向

如果后续需要继续推进，可能的角度：

- **程序化创建隐藏标签页**：`chrome.tabs.create({ url: "https://www.douyin.com/", active: false })` 创建一个后台标签页，在其 JavaScript 上下文中执行请求。这会让 `sec-fetch-site` 自然变为 `same-site`，client hints 完整，TLS 指纹一致。代价是首次加载需要 2-3 秒，且标签页会出现在标签栏中
- **Native Messaging Host**：通过 `chrome.runtime.connectNative()` 将请求转发给一个独立的本地进程执行，摆脱 Chrome 网络栈。代价是需要用户额外安装一个原生应用，部署门槛较高
- **观察 TikTokDownloader 的后续更新**：该项目的 `aBogus.py` 和 `msToken.py` 等模块可能会更新算法或端点，可以持续关注其变化
