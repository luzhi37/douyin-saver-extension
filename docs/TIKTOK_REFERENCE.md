# TikTokDownloader 参考对照

> 系统梳理参考项目 TikTokDownloader 的算法/凭据模块与 API 端点，与本扩展对照。

## 一、签名算法

### 1. ABogus — 抖音 Web 主用 ✅

| 内部算法      | 作用                                              |
|---------------|---------------------------------------------------|
| SM3 国密哈希  | 计算 params、method、UA 的 32 字节摘要            |
| RC4 流加密    | UA 编码用 `\x00\x01\x0e` 做密钥；中间数组用 `"y"` |
| 自定义 Base64 | 5 张字母表（s0~s4），输出阶段使用 s4              |

**关键依赖链**：params→SM3(SM3(params+"cus"))→32B paramsCode；method→同理；UA→RC4→customB64→SM3→32B uaCode→组装 list_4 模板(+时间戳+三码+browserInfo)→RC4("y")→string_2→拼 12 字符随机 string_1→customB64(s4)→a_bogus。

### 2. XBogus — 旧版/备用 ❌ 已移除（2026-08-04）

MD5 + RC4 + 自定义 Base64。**本扩展已移除**（2026-08-04）——抖音 Web 仅用 a_bogus，且本扩展无 TikTok 需求。

### 3. XGnarly — TikTok Web 最新 ❌ 已移除（2026-08-04）

ChaCha20 + MD5 + 自定义 Base64（无 padding）。**本扩展已移除**（2026-08-04）——本扩展仅支持抖音中文域。

## 二、凭据对照

| # | 模块      | 算法本质                     | 获取方式                                                              |
|---|-----------|------------------------------|-----------------------------------------------------------------------|
| 4 | msToken   | 服务端下发 + 客户端 fallback | `chrome.cookies` 或 POST `mssdk.bytedance.com`；fallback 156 随机字符 |
| 5 | ttwid     | 服务端下发                   | POST `ttwid.bytedance.com`，解析 Set-Cookie                           |
| 6 | verifyFp  | 客户端生成                   | `verify_{base36(timestamp)}_{36字符}`，固定位 8/13/18/23=\_、14=4     |
| 7 | webID     | 服务端下发                   | POST `mcs.zijieapi.com/webid`                                         |
| 8 | device_id | 服务端下发                   | 未实现（本扩展未使用）                                                |

## 三、全景对照表

| #   | 模块                         | 本扩展实现                |
|-----|------------------------------|---------------------------|
| 1   | ABogus                        | ✅ `crypto.js` 实现        |
| 2–3 | XBogus/XGnarly                | ❌ 已移除（2026-08-04）     |
| 4–7 | msToken/ttwid/verifyFp/webID  | ✅ msToken/ttwid/webID 于 `background.js`；verifyFp ❌ 已移除（2026-08-04） |
| 8   | device_id                    | ❌ 未实现（本扩展不需要） |

## 四、Douyin API 端点

| 端点                              | 方法 | 参数                                     | 响应键         |
|-----------------------------------|------|------------------------------------------|----------------|
| `/aweme/detail/`                  | GET  | `aweme_id`                               | `aweme_detail` |
| `/aweme/post/`                    | GET  | `sec_user_id, max_cursor, count`         | `aweme_list`   |
| `/aweme/favorite/`                | GET  | `sec_user_id, max_cursor, count`         | `aweme_list`   |
| `/aweme/listcollection/`          | POST | body: `cursor, count`                    | `aweme_list`   |
| `/user/following/list/`           | GET  | `user_id, max_time`                      | `followings`   |
| `/aweme/v1/web/commit/item/digg/` | POST | body: `aweme_id, item_type=0, type=0`    | —              |
| `/aweme/v1/web/aweme/collect/`    | POST | body: `action=0, aweme_id, aweme_type=0` | —              |
| `/im/user/info/`                  | POST | body: `sec_user_ids=[...]`               | `data`         |
| `/comment/list/`                  | GET  | `aweme_id, cursor, count`                | `comments`     |
| `/general/search/single/`         | GET  | `keyword, cursor`                        | `data`         |
| `/user/profile/other/`            | GET  | `sec_user_id`                            | `user`         |