# 02 · 独立模式（逆向）— 同步作品

> 职责边界：`SYNC_WORKS` 在**独立模式**下的完整链路——background Service Worker 直接逐条调用 `aweme/detail` 端点刷新已入库作品的视频直链与元数据，不依赖抖音标签页。Tab 模式对应链路（inject `fetchOneDetail`）见 [09](./09-inject-tab-mode.md)；存储合并规则见 [01](./01-project-architecture.md)。

## 概述

同步作品的语义是"对扩展库里已有的一组 awemeId 逐条重新拉详情"。options 端发出 `SYNC_WORKS { awemeIds }`，入口有三：`sync.syncCurrentGroup()`（当前分组全量刷新）、关注卡片/侧边栏的按需同步、以及**详情页下载兜底**（视频直链失效时单条 `SYNC_WORKS` 重取，受 `runtimeConfig.timeoutRequest` 约束等待 `SYNC_DONE`）。background 按 `loadIndependentMode()` 分流到 `handleIndependentSyncWorks`。该 handler：

- 先**立即 ack** `{ ok, true, requestId, total }`（长任务协议：结果经进度消息异步回报）；
- 循环逐条 `independentRequest(CONFIG.API.DETAIL)`（GET `/aweme/v1/web/aweme/detail/`，a_bogus + webSign，后者由 request 默认叠加）；
- 每条经 `formatWork` 归一化后暂存，全部完成后一次性 `mergeAndSaveWorks(allWorks)` 落库；
- 失败条目记入 errors 不中断批次。

## 核心流程图（文字描述）

```
options: services.bgMsg({ type:"SYNC_WORKS", awemeIds })
  → background switch "SYNC_WORKS"
    → loadIndependentMode() === true
      → handleIndependentSyncWorks(awemeIds, sendResponse)
        ├─ 校验 awemeIds 非空数组（否则 { ok:false, error:"EMPTY" }）
        ├─ ensureABogus()                     // 从 browserFeatures 构造 ABogus 实例
        ├─ requestId = crypto.randomUUID()
        ├─ 注册 cancelHandler（收到 CANCEL_ACTIVE_TASK → cancelled = true）
        ├─ sendResponse({ ok:true, requestId, total })   // 立即 ack，sendResponse 到此终结
        │
        └─ for i in awemeIds（&& !cancelled）:
             params = buildBaseParams({ aweme_id, request_source:"600", origin_type:"video_page" })
             重试环（最多 CONFIG.SYNC.RETRY_MAX 次）:
                 data = independentRequest("/aweme/v1/web/aweme/detail/", params)   // GET + a_bogus
                 w = data.aweme_detail ? formatWork(data.aweme_detail) : null
                 w 为空且非末次尝试 → 页间延迟后重试；成功 → break
             w ? allWorks.push(w) : errors.push({ awemeId, error:"DELETED"|e.message })
             chrome.runtime.sendMessage(SYNC_PROGRESS { index, total, status, awemeId })
             延迟：
               (i+1)%BATCH_SIZE==0 → 批间暂停 10–20s（KEEPALIVE_INTERVAL 分段保活 SW）
               否则               → syncWorks 延迟 MIN~MAX ms
        │
        ├─ allWorks 非空 → mergeAndSaveWorks(allWorks)
        │                   → sendMessage(SYNC_DONE { ok:true, refreshed: added+updated, failed, failedAwemeIds })
        └─ 否则           → sendMessage(SYNC_DONE { ok:false, error: errors[0]?.error || "NO_WORKS_COLLECTED" })

options: 监听 SYNC_PROGRESS / SYNC_DONE（按 requestId 匹配）更新弹窗进度与结果
```

### 视频直链三级取链（formatWork，本模式的取链点）

```
① 长效 playApi：bit_rate[]（剔除 is_h265）各档 playApi 存在 → 取分辨率最高的 /aweme/v1/play/?… ID 型链接
      videoExpireAt = 0（长效，无时效参数）
② 无任何 playApi → 用最高清档 play_addr.uri 合成裸链接
      /aweme/v1/play/?video_id=<uri>&aid=6383&is_play_url=1&line=0   （实测服务端认可，访问即 302 新签直链）
      videoExpireAt = 0
③ 前两者皆缺 → CDN url_list 预签名短效直链兜底：先取最高清档，档内比 expire 取最长者
      videoExpireAt = 解析 expire 类 query 参数（秒时间戳 ×1000 / 毫秒原值 / ≤30 天视为剩余秒数）

约束：长效作为整体类目优先于 CDN，只在同类内部比分辨率。
禁止改回"混池按最高分辨率挑选"——最高清档恰好缺 playApi 时会把短效直链存进库。
此实现与 inject.js extractVideo(api 源) 是两处同款代码，改一处必须同步另一处（见 09 文档）。
```

## 接口 / 方法签名

```js
// background/tasks/independent-tasks.js
async function handleIndependentSyncWorks(awemeIds, sendResponse)
// 入参：awemeIds: string[]（非空）；立即 sendResponse({ok,requestId,total}) 后不再使用 sendResponse
// 出参（ack）：{ ok: true, requestId: string, total: number }
// 进度：SYNC_PROGRESS*N → SYNC_DONE

async function ensureABogus()            // 读 browserFeatures → new ABogus(ua, platform, features)
async function buildBaseParams(extra)    // 环境参数全集（见下），返回普通对象供 URLSearchParams 序列化
async function independentRequest(apiPath, params, options?) -> Promise<object>   // 见通用请求骨架
function formatWork(aw) -> Work|null     // 无 aweme_id 返回 null
async function mergeAndSaveWorks(works) -> Promise<{ added, updated, total }>
function mergeWork(w, old) -> Work       // 保留旧 groupId/savedAt；长效链不被短效链覆盖降级
```

### independentRequest 通用请求骨架（所有独立模式端点共用）

```js
async function independentRequest(apiPath, params, options = {}) {
  const { savedCookie } = await chrome.storage.local.get("savedCookie");
  if (!savedCookie) throw new Error("NO_COOKIE");           // 门禁：必须已有 cookie 快照
  params.msToken = await getMsToken();
  const qs = new URLSearchParams(params).toString();        // qs 即最终查询串（不含 a_bogus），键序即发送序
  const a_bogus = abOgus.getValue(qs, method, await getClockSkew());
  let urlQuery = qs + "&a_bogus=" + a_bogus;
  // webSign 默认开启（options.webSign !== false）：追加 timestamp + x-secsdk-web-signature（算法见 05）
  // … fetch(url, { credentials:"include", referrer, UA=abOgus.userAgent, signal }) …
  // 非 2xx：argus_security_code === "web_id_sign_invalid" 且未重试过
  //        → refreshWebIdChain() 刷新 webid 后整体重试一次（_webIdRetried 标志防死循环）
  // data.status_code !== 0 → throw API_ERROR
}
```

签名正确性关键约束：服务端验证 a_bogus 时剥离 a_bogus 自身、对**完整查询串**哈希，因此待签串必须与最终 URL 完全一致（键顺序也一致）；`msToken/uifid/odin_tt` 参与签名，绝不能剔除。

## 关键代码片段

### 单条请求参数组装与重试

```js
const params = await buildBaseParams({
  aweme_id: awemeIds[i],
  request_source: "600",
  origin_type: "video_page",
});
let data, w;
for (let attempt = 0; attempt < CONFIG.SYNC.RETRY_MAX; attempt++) {
  data = await independentRequest(CONFIG.API.DETAIL, params);
  w = data.aweme_detail ? formatWork(data.aweme_detail) : null;
  if (w) break;
  if (attempt === 0) { /* syncWorks 延迟后重试一次 */ }
}
if (w) allWorks.push(w);
else { errors.push({ awemeId: awemeIds[i], error: "DELETED" }); currentOk = false; }
```

### buildBaseParams 的会话敏感项

```js
// odin_tt / uifid 必须来自「当前登录会话」的实时 Cookie —— 缓存滞后会导致签名虽正确、
// 但与服务端校验所用会话参数不一致 → 403 sign invalid。实时 Cookie 缺失时才回退 savedCookie 正则提取。
const liveCookies = await chrome.cookies.getAll({ domain: "douyin.com" });
// cmap["UIFID"] → uifid；cmap["odin_tt"] → odin_tt；其余为固定环境参数 + browserFeatures 特征字段（缺省兜底
// cpu_core_num=8 / screen 1536×864 / Edge 149 / Blink / Windows 10 等）
```

## 链接拼装实例（真实数据走查）

> 样本取自扩展「导出数据」功能落盘的真实库快照（2271 条作品）。会话敏感值以 `<webid>` 等占位——它们每次会话都不同，形态见 05 文档"要素表"。

### 第一步：从作品页面链接取出 awemeId

awemeId 是 19 位纯数字，出现在三种页面 URL 里，扩展库 `works` 的键即该值：

```
https://www.douyin.com/video/7267428670501915945    → 路径尾段即 awemeId
https://www.douyin.com/note/7329466475989749002     → 图集 note 同理
https://www.douyin.com/user/MS4wLjAB…?modal_id=7267428670501915945 → modal_id 参数
```

### 第二步：业务参数叠加环境参数（buildBaseParams）

业务参数只有三键；随后并入环境参数全集（固定值 + browserFeatures 特征 + 会话 Cookie 三项）：

| 层 | 参数 | 示例值 | 含义 |
|---|---|---|---|
| 业务 | `aweme_id` | `7267428670501915945` | 目标作品 |
| 业务 | `request_source` | `600` | 页面播放器场景码（固定） |
| 业务 | `origin_type` | `video_page` | 来源页类型（固定） |
| 环境 | `device_platform` / `aid` / `channel` | `webapp` / `6383` / `channel_pc_web` | 抖音 web 端应用标识（aid 全线通用） |
| 环境 | `version_code` / `version_name` | `290100` / `29.1.0` | 客户端版本伪装值（注意 Tab 模式 inject 用的是另一套 170400/17.4.0） |
| 环境 | `browser_*` / `os_*` / `engine_*` / `screen_*` 等 | Edge 149 / Win32 / Blink … | 来自 browserFeatures 快照，缺省有兜底 |
| 环境 | `webid` / `uifid` / `odin_tt` | `<webid>` 等 | 设备/会话身份，实时 Cookie 优先 |

最后 independentRequest 追加 `msToken`。键序 = 对象插入序：环境键在前、业务键在后、msToken 最末。

### 第三步：a_bogus 签名 → 最终请求 URL

对上面整串 query（不含 a_bogus）+ 方法名 `"GET"` 由 ABogus 本地签名后拼在末尾。完整形态（截去环境中段）：

```text
GET https://www.douyin.com/aweme/v1/web/aweme/detail/
    ?device_platform=webapp&aid=6383&channel=channel_pc_web&…&webid=<webid>
     &uifid=<uifid>&odin_tt=<odin_tt>
     &aweme_id=7267428670501915945&request_source=600&origin_type=video_page
     &msToken=<msToken>&a_bogus=<a_bogus>
```

Tab 模式对照：inject `fetchOneDetail` 只填基础 + 浏览器参数并合并页面捕获的缓存 query，a_bogus/msToken/uifid 由抖音页面 fetch 包装器代注入（见 [09](./09-inject-tab-mode.md)），因此 URL 更短但同样能过验。

### 第四步：响应里视频直链的构成与含义

detail 响应的 `aweme_detail.video.bit_rate[]` 是各转码档数组，每档关键结构（字段名照录代码引用，数值示意）：

```jsonc
{
  "is_h265": false,                       // H265 档直接剔除，不参与选链
  "playApi": "/aweme/v1/play/?video_id=v0d00fg…&aid=6383&is_play_url=1&line=0",
                                          // ★ 长效 ID 型链接（相对路径，补 URL_BASE 后入库）
  "play_addr": {
    "uri": "v0d00fg10000cjdhfjrc77u4d4u5fv6g",   // 文件 ID（合成裸链接的原料）
    "height": 576,                                // 档位分辨率（同类内比高低用）
    "url_list": ["https://<节点>.douyinvod.com/…?expires=…"]  // 预签名短效 CDN 直链
  }
}
```

三级取链（详见上文流程图）落库后的三种 video 字段形态，逐一解剖：

**① 长效 playApi 链接（本库 1589 条，逐参数含义）**

```text
https://www.douyin.com/aweme/v1/play/?video_id=v0d00fg10000cjdhfjrc77u4d4u5fv6g&aid=6383&is_play_url=1&line=0
```

| 部分 | 含义 |
|---|---|
| `www.douyin.com/aweme/v1/play/` | 取流网关，不是 CDN——访问时服务端 302 到即时签名的 douyinvod 直链，因此永远不过期 |
| `video_id=v0d00fg10000cjdhfjrc77u4d4u5fv6g` | 即 `play_addr.uri` 文件 ID。前缀 `v0200f/v1e00f/v2800f/v0300f/v0d00f/v2700f` 等为转码档标识（本库分布 288/274/270/258/251/248 条） |
| `aid=6383` | 抖音 web 端应用 ID，全线 API 共用 |
| `is_play_url=1` | 声明按可播放地址处理 |
| `line=0` | 线路选择（默认主线） |

无任何时效参数 → `videoExpireAt` 记 0。当各档 playApi 全缺时，改用最高清档 `uri` 经 `encodeURIComponent` 手工拼出同款 URL（即三级取链的第②级），语义与上面完全相同。

**② CDN 短效直链兜底（通用形态，非本次导出样本）**

```text
https://<节点>.douyinvod.com/<路径…>/video/tos/cn/…/?…&expires=<过期秒级时间戳>&…
```

域名随响应节点变化；时效解析只认 **query 中键名含 expire（不区分大小写）** 的参数（秒时间戳 ×1000 / 毫秒原值 / ≤30 天视为剩余秒数）。陷阱：部分 douyinvod 直链把过期时间藏在**路径段**（`/<sig>/<8位hex 过期秒>`），query 里查不到——此时 `urlExpireAt` 返回 null，`videoExpireAt` 记 0 但实际几小时即失效。这也是"长效类目整体优先于 CDN"红线的原因。

**③ 图床家族直链解剖（用库内真实封面样例）**

```text
https://p3-pc-sign.douyinpic.com/image-cut-tos-priv/c0ba730283587bbf99551f78c6f9643f~tplv-dy-resize-origshort-autoq-75:330.jpeg
    ?lk3s=138a59ce&x-expires=2102914800&x-signature=DTkag5u7E72DihfP5LVgf1QyHYg%3D
     &from=327834062&s=PackSourceEnum_AWEME_DETAIL&se=false&sc=cover&biz_tag=pcweb_cover
     &l=20260824150324E26EAC0AE5E9D6082E73
```

| 部分 | 示例值 | 含义 |
|---|---|---|
| 主机 | `p3-pc-sign.douyinpic.com` | 图片 CDN 节点簇（p3/p9 两簇；`-sign` 后缀 = 需签名校验） |
| 桶段 | `image-cut-tos-priv` / `tos-cn-i-0813` | TOS 对象存储桶（封面裁剪私有桶 / 图集桶） |
| 文件段 | `c0ba73….jpeg` | 内容哈希文件名 |
| `~tplv-…` | `dy-resize-origshort-autoq-75:330` | 图片处理模板：缩放 + 自适应质量 75、宽 330。图集图为 `dy-aweme-images:q75.webp`，另有 `dy-cropcenter:323:430`、`noop.jpeg`（原尺寸）变体 |
| `lk3s` | `138a59ce` | 签名密钥版本号 |
| `x-expires` | `2102914800` | 过期秒级时间戳。**本例 ≈ 2036-08-21：视频封面约签发 10 年长效** |
| `x-signature` | `DTkag5u…%3D` | URL 编码的 base64 签名，与 lk3s/x-expires/文件绑定 |
| `from` | `327834062` | 场景来源码 |
| `s` | `PackSourceEnum_AWEME_DETAIL` | 打包来源接口（详情接口）；图集图为 `PackSourceEnum_PUBLISH` |
| `se` / `sc` / `biz_tag` | `false` / `cover` / `pcweb_cover` | 业务标签（PC web 封面）；图集图 `biz_tag=aweme_images` |
| `l` | `2026082415…` | 请求 trace ID，前缀即抓取时刻 |

**时效实测统计（本库 2271 条）**：视频封面 x-expires ≈ 签发后 **10 年**（1591 条实测中位 3696 天），实际近似永久；**图集图片 x-expires = 签发后 30 天**（680 条实测中位 29.99 天，几乎整 30 天），是库里唯一会批量过期的媒体——图集挂载失败重同步即可换新签名。头像与音乐是无签名公开资源，永不过期：

```text
avatarLarger: https://p3-pc.douyinpic.com/aweme/1080x1080/aweme-avatar/tos-cn-avt-0015_<hash>.jpeg?from=2956013662
music:        https://sf6-cdn-tos.douyinstatic.com/obj/ies-music/7241916918263909179.mp3
```

**边缘案例**：库内 4 条作品的 video 字段形如 `/aweme/v1/play/?video_id=https%3A%2F%2Fsf6-cdn-tos.douyinstatic.com%2Fobj%2Fies-music%2F….mp3&aid=6383&…`——上游数据的 `play_addr.uri` 本身就是完整音乐直链，被 `encodeURIComponent` 原样塞入所致，属源数据形态而非扩展缺陷。

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| `awemeIds` 为空/非数组 | 同步返回 `{ ok:false, error:"EMPTY" }` | options 侧提示 |
| `savedCookie` 缺失 | 首条即抛 `NO_COOKIE`，落入外层 catch → `{ ok:false, error }` | 引导用户在设置面板刷新 Cookie |
| 作品已被删除/不可见 | `data.aweme_detail` 缺失，重试耗尽 | 记 `DELETED`，继续下一批 |
| a_bogus 被拒（`web_id_sign_invalid` 403） | independentRequest 内部识别 | 自动 `refreshWebIdChain()` 换新 webid 重试一次 |
| HTTP 403（其他文案）/5xx/超时 | 抛 `HTTP_<code>` / AbortError | 记入 errors，跳过继续 |
| 用户关闭弹窗 | options 发 `CANCEL_ACTIVE_TASK` | cancelled 置位，循环退出，已收集部分照常落库并发 SYNC_DONE |
| SW 中途被回收 | 批次静默中断（无恢复机制） | **待补充**：可考虑把断点游标写入 storage 实现续跑；当前依赖批间保活降低概率 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `runtimeConfig.timeoutRequest` → `CONFIG.TIMEOUT.REQUEST` | 30000ms | independentRequest 单请求超时（AbortController） |
| `runtimeConfig.syncWorksDelayMin/Max` → `CONFIG.DELAY.syncWorks` | 500/1000ms | 条间随机延迟 |
| `runtimeConfig.syncBatchSize` → `CONFIG.SYNC.BATCH_SIZE` | 40 | 每 N 条触发批间暂停 |
| `runtimeConfig.syncBatchPauseMin/Max` | 10000/20000ms | 批间暂停时长区间 |
| `runtimeConfig.syncKeepaliveInterval` | 2000ms | 保活分段粒度 |
| `runtimeConfig.syncRetryMax` | 2 | 单条 detail 重试上限 |
| `CONFIG.PAGE.*` | — | 本流程不分页，不适用 |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | 长任务协议、双域存储模型、FATAL_ERRORS 分类 |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | mergeWork / mergeAndSaveWorks 的合并语义（本册只讲调用时序） |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | independentRequest 的 webSign 分支（默认开启，本流程随之生效） |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 3 为本流程所有 GET 请求注入 Referer、剥离 Sec-Fetch-* |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | Tab模式同款链路（FETCH_SINGLE_WORK → fetchOneDetail）；extractVideo 双实现同步约束 |
| — | [TIKTOK_REFERENCE.md](./TIKTOK_REFERENCE.md) | `/aweme/detail/` 端点参数表 |
