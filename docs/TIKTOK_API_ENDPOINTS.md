# 参考项目功能/端点对照

> 本文档系统梳理参考项目 **TikTokDownloader**（[JoeanAmier/TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader)，源码路径 `D:\User\Downloader\TikTokDownloader\src\`）实现的所有抖音/TikTok Web API 端点，与本浏览器扩展（`douyin-saver-extension`）的 6 大主流程需求做对照。
>
> 与 [docs/TIKTOK_ALGORITHMS.md](./TIKTOK_ALGORITHMS.md)（签名/凭据算法）配套阅读。

---

## 目录

- [一、6 大主流程需求逐项对照](#一6-大主流程需求逐项对照)
  - [1. 同步作品](#1-同步作品detail)
  - [2. 同步关注](#2-同步关注)
  - [3. 扫描点赞](#3-扫描点赞account-favorite)
  - [4. 扫描收藏](#4-扫描收藏collection)
  - [5. 取消点赞](#5-取消点赞)
  - [6. 取消收藏](#6-取消收藏)
- [二、6 大需求小结表](#二6-大需求小结表)
- [三、参考项目可顺手"白嫖"的彩蛋能力](#三参考项目可顺手白嫖的彩蛋能力)
- [四、参考项目未实现的盲区（扩展要自己处理）](#四参考项目未实现的盲区扩展要自己处理)
- [五、架构观察](#五架构观察)
- [六、端点总表（Quick Reference）](#六端点总表quick-reference)
- [七、本扩展相关文档](#七本扩展相关文档)

---

## 一、6 大主流程需求逐项对照

### 1. 同步作品（`Detail`）

| 字段 | 值 |
|---|---|
| 参考类 | `Detail`（`src\interface\detail.py:13`） |
| API URL | `https://www.douyin.com/aweme/v1/web/aweme/detail/` |
| 方法 | **GET** |
| 必需参数 | `aweme_id` + 通用 device params |
| 响应字段 | `aweme_detail`（**单条**对象，非列表） |
| 分页 | 无（`single_page=True`） |
| 状态 | ✅ **可直接采用** |

**关键代码（`src\interface\detail.py:23-33`）**：

```python
self.api = f"{self.domain}aweme/v1/web/aweme/detail/"
return self.params | {
    "aweme_id": self.detail_id,
    "version_code": "190500",
    "version_name": "19.5.0",
}
```

**与扩展现状关系**：扩展当前在 `inject.js` 抓取此接口。endpoint、响应键 `aweme_detail` 与本扩展一致 — **可作为独立模式的 endpoint 参考**。

---

### 2. 同步关注

| 字段 | 值 |
|---|---|
| 参考类 | **❌ 未提供** |
| API URL | （无） |
| 状态 | ❌ **参考项目不覆盖** |

参考项目仅有 `User` 类（`src\interface\user.py:12`）返回**用户简介**（含关注数 `following_count` / `follower_count`），但**不提供关注列表分页**。

**结论**：扩展**保持现状** — 继续依赖 `inject.js` 对 `/aweme/v1/web/user/following/list/` 的 fetch hook 捕获路径。

---

### 3. 扫描点赞（`Account` `favorite`）

| 字段 | 值 |
|---|---|
| 参考类 | `Account(tab="favorite")`（`src\interface\account.py:12`） |
| API URL | `https://www.douyin.com/aweme/v1/web/aweme/favorite/` |
| 方法 | **GET** |
| 必需参数 | `sec_user_id`, `max_cursor`, `min_cursor=0`, `count`, `publish_video_strategy_type=2`, `whale_cut_token=""`, `cut_version=1` |
| 响应字段 | `aweme_list` |
| 分页字段 | `max_cursor` / `has_more`（**非默认 cursor**） |
| 默认 count | 18 |
| Referer | `https://www.douyin.com/user/{sec_user_id}?showTab=like` |
| TikTok 变体 | `AccountTikTok`（`src\interface\account_tiktok.py:11`） — 端点 `/api/favorite/item_list/`，参数 camelCase |
| 状态 | ✅ **可作为 endpoint 参考** |

**关键代码（`src\interface\account.py:173-184`）**：

```python
def generate_favorite_params(self) -> dict:
    return self.params | {
        "sec_user_id": self.sec_user_id,
        "max_cursor": self.cursor,
        "min_cursor": "0",
        "whale_cut_token": "",
        "cut_version": "1",
        "count": self.count,
        "publish_video_strategy_type": "2",
        "version_code": "170400",
        "version_name": "17.4.0",
    }
```

**与扩展现状关系**：扩展当前在 `background.js` 走 `sendToTab → inject` 路径，inject 中捕获 `/aweme/v1/web/aweme/favorite/` 响应。**独立模式可参考此 endpoint 与参数 schema**，但要注意 cursor 字段是 `max_cursor` 而非 `cursor`。

**应用验证**：`src\application\main_terminal.py:586-589` 中，`Account(tab="favorite")` 用 owner 自己的 `sec_user_id` 调用此接口下载自己的点赞 — **证明 endpoint 对"自己的点赞"也有效**。

---

### 4. 扫描收藏（`Collection`）

| 字段 | 值 |
|---|---|
| 参考类 | `Collection`（`src\interface\collection.py:11`） |
| API URL | `https://www.douyin.com/aweme/v1/web/aweme/listcollection/` |
| 方法 | **POST** |
| Query 参数 | `publish_video_strategy_type=2`, `version_code=170400`, `version_name=17.4.0` |
| **Body 参数** | `count=10`, `cursor=0` ⚠️ **cursor 和 count 在 body 中，不在 query** |
| 响应字段 | `aweme_list` |
| 分页字段 | `cursor` / `has_more`（标准） |
| Referer | `https://www.douyin.com/user/self?showTab=favorite_collection` |
| 状态 | ✅ **可作为 endpoint 参考** |

**关键代码（`src\interface\collection.py:73-79`）**：

```python
def generate_data(self) -> dict:
    return {
        "count": self.count,
        "cursor": self.cursor,
    }
```

**与扩展现状关系**：扫描收藏是扩展少数几个需要 POST 的接口之一，cursor 在 body 而非 query — **参考项目印证了扩展的现有做法**。

**额外彩蛋 — 收藏夹文件夹**：

| 类 | 端点 | 方法 | 响应 |
|---|---|---|---|
| `Collects`（`src\interface\collects.py:12`） | `/aweme/v1/web/collects/list/` | GET | `collects_list`（收藏夹文件夹列表，含 `collects_id_str` + `collects_name`） |
| `CollectsDetail`（`src\interface\collects.py:70`） | `/aweme/v1/web/collects/video/list/` | GET | `aweme_list`（指定收藏夹内作品，params 加 `collects_id`） |

---

### 5. 取消点赞

| 字段 | 值 |
|---|---|
| 参考类 | **❌ 未提供** |
| 状态 | ❌ **参考项目不覆盖** |

参考项目是**纯只读下载器**，`grep` 在 `src/` 下搜索 `dislike|unlike|uncollect|取消点赞|取消收藏|delete_aweme|remove_aweme|digg/cancel` 返回 0 匹配。

**结论**：扩展**保持现状** — 继续使用现有 inject.js XHR 路径（`AGENTS.md` 已说明"a_bogus 签名与 XHR 原型链深度绑定"）。

---

### 6. 取消收藏

| 字段 | 值 |
|---|---|
| 参考类 | **❌ 未提供** |
| 状态 | ❌ **参考项目不覆盖** |

**结论**：扩展**保持现状**。

---

## 二、6 大需求小结表

| 需求 | 参考类 | API 端点 | 方法 | 状态 |
|---|---|---|---|---|
| 同步作品 | `Detail` | `/aweme/v1/web/aweme/detail/` | GET | ✅ 可参考 endpoint |
| 同步关注 | — | — | — | ❌ 保持 inject hook |
| 扫描点赞 | `Account(tab="favorite")` | `/aweme/v1/web/aweme/favorite/` | GET | ✅ 可参考 endpoint（注意 `max_cursor`） |
| 扫描收藏 | `Collection` | `/aweme/v1/web/aweme/listcollection/` | POST | ✅ 可参考 endpoint（cursor 在 body） |
| 取消点赞 | — | — | — | ❌ 保持 inject XHR |
| 取消收藏 | — | — | — | ❌ 保持 inject XHR |

**直接覆盖 3/6**（作品、点赞、收藏）。其他 3 项**未覆盖**，但参考项目验证了 endpoint 的正确性。

---

## 三、参考项目可顺手"白嫖"的彩蛋能力

如果扩展未来想扩展功能，参考项目还实现了以下接口（**本扩展当前不覆盖**）：

| 能力 | 类 | API 端点 | 方法 | 响应 | 备注 |
|---|---|---|---|---|---|
| **作者作品分页** | `Account(tab="post")` | `/aweme/v1/web/aweme/post/` | GET | `aweme_list` | **本扩展侧边栏已在用** |
| 用户简介 | `User` | `/aweme/v1/web/user/profile/other/` | GET | `user` | 单页，可获 `follower_count` / `following_count` |
| 批量用户信息 | `Info` | `/aweme/v1/web/im/user/info/` | POST | `data` | body: `sec_user_ids=["uid1","uid2"]`（字符串形式的 JSON 数组） |
| 综合搜索 | `Search(channel=0)` | `/aweme/v1/web/general/search/single/` | GET | `data` | — |
| 视频搜索 | `Search(channel=1)` | `/aweme/v1/web/search/item/` | GET | `data` | — |
| 用户搜索 | `Search(channel=2)` | `/aweme/v1/web/discover/search/` | GET | `user_list` | — |
| 直播搜索 | `Search(channel=3)` | `/aweme/v1/web/live/search/` | GET | `data.lives` | — |
| 评论列表 | `Comment` | `/aweme/v1/web/comment/list/` | GET | `comments` | count=20 |
| 评论回复 | `Reply` | `/aweme/v1/web/comment/list/reply/` | GET | `comments` | 额外加 `comment_id`, `item_id` |
| 合集作品 | `Mix` | `/aweme/v1/web/mix/aweme/` | GET | `aweme_list` | 需 `mix_id`（可从作品详情自动提取） |
| 收藏的合集 | `CollectsMix` | `/aweme/v1/web/mix/listcollection/` | GET | `mix_infos` | — |
| 收藏的短剧 | `CollectsSeries` | `/aweme/v1/web/series/collections/` | GET | `series_infos` | — |
| 收藏的音乐 | `CollectsMusic` | `/aweme/v1/web/music/listcollection/` | GET | `mc_list` | — |
| 直播间（web_rid） | `Live.with_web_rid` | `live.douyin.com/webcast/room/web/enter/` | GET | — | params: `web_rid`, `live_id=1`, `enter_from=web_share_link` |
| 直播间（room_id） | `Live.with_room_id` | `webcast.amemv.com/webcast/room/reflow/info/` | GET | — | 需 `headers_download`（无 cookie） |
| 抖音热榜 | `Hot` | `/aweme/v1/web/hot/search/list/` | GET | `data.word_list` | `board_type` / `board_sub_type` 过滤（娱乐/社会/挑战） |
| TikTok 作品详情 | `DetailTikTok` | `https://www.tiktok.com/api/item/detail/` | GET | `itemInfo.itemStruct` | — |
| TikTok 作者作品 | `AccountTikTok(tab="post")` | `/api/user/post/` | GET | `itemList` | cursor: `cursor`, hasMore: `hasMore` |
| TikTok 作者点赞 | `AccountTikTok(tab="favorite")` | `/api/favorite/item_list/` | GET | `itemList` | — |
| TikTok 评论 | `CommentTikTok` | `/api/comment/list/` | GET | `comments` | — |
| TikTok 直播间 | `LiveTikTok` | `webcast.us.tiktok.com/webcast/room/enter/` | POST | — | body: `room_id`, `enter_source` |
| TikTok 用户信息 | `InfoTikTok` | `/api/user/detail/` | GET | `userInfo.user` | — |
| TikTok 合集 | `MixTikTok` | `/api/mix/list/` | GET | `mixInfos` | — |
| TikTok 合集详情 | `MixListTikTok` | `/api/mix/item_list/` | GET | `itemList` | — |

**优先级建议**（与扩展的"作品/关注/点赞/收藏"主流程相关）：

| 优先级 | 能力 | 原因 |
|---|---|---|
| 高 | 作者作品（`Account(tab="post")`） | 扩展侧边栏已用，验证 endpoint 一致性 |
| 中 | 合集（`Mix`） | 详情页可加"查看合集"入口 |
| 中 | 搜索（`Search`） | 扩展可加"搜索作品"功能 |
| 低 | 用户简介（`User`） | 关注列表展示用 |
| 低 | 收藏夹文件夹（`Collects`） | 二级收藏夹分类展示 |

---

## 四、参考项目未实现的盲区（扩展要自己处理）

| 盲区 | 说明 | 扩展现状 |
|---|---|---|
| 关注列表分页 | 抖音 web 关注列表 endpoint 不在参考项目 | inject hook `/aweme/v1/web/user/following/list/` |
| 取消点赞 / 取消收藏 | 写入操作 | inject XHR 路径（`AGENTS.md` 说明） |
| 抖音安全密钥（`bd-ticket-guard-ree-public-key`） | 用于取消操作签名 | inject `localStorage` 读取 |
| 视频下载（`www.iesdouyin.com` 短链） | `Slides`（图集）stub 化（`run()` 仅 `pass`） | 扩展不涉及 |
| Hashtag 挑战详情 | `HashTag`（`src\interface\hashtag.py:13`）stub 化（`run()` 仅 `pass`） | 扩展不涉及 |

---

## 五、架构观察

以下模式值得在独立模式设计中参考：

1. **通用 params 块**（`src\interface\template.py:31-63`）：30 个固定 key（`device_platform`/`aid`/`channel`/`version_*`/...）在所有抖音端点中复用，与本扩展 `inject.js` 中的 `DEVICE_PARAMS` 几乎一致。

2. **`a_bogus` 签名注入**（`src\interface\template.py:443`）：每个 URL 自动拼接 `&a_bogus={ab.get_value(params, method)}`。本扩展依赖页面上下文签名而非外置 — 这是关键差异。

3. **POST 用于收藏**（`src\interface\collection.py:42`）：`Collection` 是参考项目中**唯一**使用 POST 的分页端点，cursor/count 在 body 而非 query。

4. **POST 用于批量用户信息**（`src\interface\info.py:52`）：body 是字符串形式的 JSON 数组 `sec_user_ids=["uid1","uid2"]`，可用于批量 profile 查询。

5. **Cursor 字段名变化**：
   - 大多数端点：`cursor`
   - 作者作品/点赞（`Account`）：`max_cursor`（`src\interface\account.py:49, 176, 189`）
   - TikTok 变体（`AccountTikTok`）：翻回 `cursor`（`src\interface\account_tiktok.py:54`）
   - **必须参数化**，不可硬编码。本扩展的 `requestId` 抽象已覆盖此需求。

6. **所有 GET 在 template**：`API.request_data()`（`src\interface\template.py:248`）支持 GET/POST，自带 `@Retry.retry` 装饰器。本扩展已有等价重试 + 超时机制。

7. **`__generate_params` 怪癖**（`src\interface\template.py:100-105`）：从 params 字典中 pop `msToken` 后再签名（msToken 是签名输入的一部分）。本扩展的签名策略已处理此情况。

8. **TikTok 域完全独立**：所有 TikTok 类继承自 `APITikTok`（`src\interface\template.py:503`），使用 `X-Bogus` + `X-Gnarly` 而非 `a_bogus`，且 `X-Bogus` / `X-Gnarly` 来自不同 base64 表。两个域的代码完全隔离。

---

## 六、端点总表（Quick Reference）

### 抖音域（`https://www.douyin.com/aweme/v1/web/...`）

| 端点 | 方法 | 关键参数 | 响应键 | 对应类 |
|---|---|---|---|---|
| `/aweme/detail/` | GET | `aweme_id` | `aweme_detail` | `Detail` |
| `/aweme/post/` | GET | `sec_user_id`, `max_cursor`, `count` | `aweme_list` | `Account(tab="post")` |
| `/aweme/favorite/` | GET | `sec_user_id`, `max_cursor`, `count` | `aweme_list` | `Account(tab="favorite")` |
| `/aweme/listcollection/` | **POST** | body: `cursor`, `count` | `aweme_list` | `Collection` |
| `/collects/list/` | GET | — | `collects_list` | `Collects` |
| `/collects/video/list/` | GET | `collects_id` | `aweme_list` | `CollectsDetail` |
| `/mix/aweme/` | GET | `mix_id` | `aweme_list` | `Mix` |
| `/mix/listcollection/` | GET | — | `mix_infos` | `CollectsMix` |
| `/series/collections/` | GET | — | `series_infos` | `CollectsSeries` |
| `/music/listcollection/` | GET | — | `mc_list` | `CollectsMusic` |
| `/user/profile/other/` | GET | `sec_user_id` | `user` | `User` |
| `/im/user/info/` | **POST** | body: `sec_user_ids=[...]` | `data` | `Info` |
| `/comment/list/` | GET | `aweme_id`, `cursor`, `count` | `comments` | `Comment` |
| `/comment/list/reply/` | GET | `aweme_id`, `comment_id`, `cursor` | `comments` | `Reply` |
| `/general/search/single/` | GET | `keyword`, `cursor` | `data` | `Search(channel=0)` |
| `/search/item/` | GET | `keyword`, `cursor` | `data` | `Search(channel=1)` |
| `/discover/search/` | GET | `keyword`, `cursor` | `user_list` | `Search(channel=2)` |
| `/live/search/` | GET | `keyword`, `cursor` | `data.lives` | `Search(channel=3)` |
| `/hot/search/list/` | GET | `board_type` | `data.word_list` | `Hot` |
| `/aweme/v1/web/aweme/favorite/`（自己） | GET | `sec_user_id`（=自己） | `aweme_list` | `Account(tab="favorite")` |
| `/user/following/list/` | GET | `user_id`, `max_time` | `followings` | **参考项目未实现** |

### 直播域（`live.douyin.com` / `webcast.amemv.com`）

| 端点 | 方法 | 关键参数 | 对应类 |
|---|---|---|---|
| `live.douyin.com/webcast/room/web/enter/` | GET | `web_rid`, `live_id=1`, `enter_from=web_share_link` | `Live.with_web_rid` |
| `webcast.amemv.com/webcast/room/reflow/info/` | GET | `room_id`（需 `headers_download` 无 cookie） | `Live.with_room_id` |

### TikTok 域（`https://www.tiktok.com/api/...`）

| 端点 | 方法 | 关键参数 | 响应键 | 对应类 |
|---|---|---|---|---|
| `/api/item/detail/` | GET | `itemId` | `itemInfo.itemStruct` | `DetailTikTok` |
| `/api/user/post/` | GET | `secUid`, `cursor`, `count` | `itemList` | `AccountTikTok(tab="post")` |
| `/api/favorite/item_list/` | GET | `secUid`, `cursor`, `count` | `itemList` | `AccountTikTok(tab="favorite")` |
| `/api/comment/list/` | GET | `aweme_id`, `cursor` | `comments` | `CommentTikTok` |
| `/api/user/detail/` | GET | `secUid` | `userInfo.user` | `InfoTikTok` |
| `/api/mix/list/` | GET | `userId` | `mixInfos` | `MixListTikTok` |
| `/api/mix/item_list/` | GET | `mixId` | `itemList` | `MixTikTok` |
| `webcast.us.tiktok.com/webcast/room/enter/` | POST | `room_id`, `enter_source` | — | `LiveTikTok` |

---

## 七、本扩展相关文档

| 文档 | 用途 |
|---|---|
| [docs/TIKTOK_ALGORITHMS.md](./TIKTOK_ALGORITHMS.md) | 参考项目 8 个算法/凭据模块对照（ABogus/XBogus/XGnarly/msToken/ttwid/verifyFp/webID/device_id） |
| [docs/INDEPENDENT_MODE.md](./INDEPENDENT_MODE.md) | 独立模式架构（不依赖抖音标签页运行） |
| [docs/FETCH_AND_CACHE.md](./FETCH_AND_CACHE.md) | 当前依赖标签页模式的抓取与缓存机制 |
| [docs/INJECT_INTERNALS.md](./INJECT_INTERNALS.md) | inject.js 注入、抓取、签名捕获内部细节 |
| [docs/SYNC_AND_SCAN.md](./SYNC_AND_SCAN.md) | 同步/扫描/取消完整链路 |
| [docs/SECURITY_AND_DNR.md](./SECURITY_AND_DNR.md) | DNR 规则与安全状态 |
| [docs/STORAGE_AND_MERGE.md](./STORAGE_AND_MERGE.md) | IndexedDB 结构、作品合并、关注丢失检测、导入分组去重合并 |
| [docs/CSS_AND_UI.md](./CSS_AND_UI.md) | CSS 架构、VirtualGrid 渲染约定、弹窗/详情页/UI 约定 |
