# 安全状态与网络请求头

> 本文档描述 declarativeNetRequest 规则、安全状态查询链路、以及已知安全风险。

## 1. declarativeNetRequest 规则

定义在 `background.js` 的 `CONFIG.DNR_RULES` 中，通过 `updateDynamicRules` 在 `onInstalled` / `onStartup` 时注册。共 6 条规则：

| ID | 匹配                                                                   | 行为                                                                     | 用途                                                                                      |
|----|------------------------------------------------------------------------|--------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| 1  | `douyinvod.com` media/image/xhr                                        | Set `Referer: https://www.douyin.com/`, `Origin: https://www.douyin.com` | 视频 CDN 防盗链                                                                           |
| 2  | `douyinpic.com` image/xhr                                              | Set `Referer: https://www.douyin.com/`                                   | 图片 CDN 防盗链                                                                           |
| 3  | `douyin.com/aweme/v1/web/` xhr (非 douyin.com 发起方)                  | Remove `Sec-Fetch-*`/`Origin`, Set `Referer` + `Accept-Encoding`         | 独立模式 API 请求（Chrome SW 的 fetch 中 Sec-Fetch/Origin 为 extension://，会被抖音拒绝） |
| 4  | `douyin.com/aweme/v1/web/aweme/listcollection/` xhr (非 douyin.com 发起方) | Set `Sec-Fetch-Site: same-origin`/`Sec-Fetch-Mode: cors`/`Sec-Fetch-Dest: empty`/`Accept-Language: zh-CN,zh;q=0.9` (priority 2) | 收藏扫描是独立模式唯一 POST 端点；POST 比 GET 更严格校验同源 fetch 元数据。**同源请求不带 Origin**，故只补 Sec-Fetch-*，绝不可 set Origin（否则 same-origin+Origin 非法组合被 WAF 拦截）。优先级高于 rule 3，仅作用于此 POST 端点 |
| 5  | `douyin.com/aweme/v1/web/aweme/collect/` xhr (非 douyin.com 发起方)    | Set `Sec-Fetch-Site: same-origin`/`Sec-Fetch-Mode: cors`/`Sec-Fetch-Dest: empty`/`Accept-Language`/`Referer: /user/self?showTab=favorite_collection` (priority 2) | 取消收藏 POST：与 rule 4 同理提升到 priority 2 覆盖 rule 3 的 remove，补回 Sec-Fetch-* + Accept-Language（不带 Origin），并使精确 Referer 真正生效 |
| 6  | `douyin.com/aweme/v1/web/commit/item/digg/` xhr (非 douyin.com 发起方) | Set `Sec-Fetch-Site: same-origin`/`Sec-Fetch-Mode: cors`/`Sec-Fetch-Dest: empty`/`Accept-Language`/`Referer: /user/self?showTab=like` (priority 2) | 取消点赞 POST：与 rule 5 同理，补回 Sec-Fetch-* + Accept-Language（不带 Origin），并使精确 Referer 真正生效 |

`excludedInitiatorDomains: ['www.douyin.com', 'douyin.com']` 确保抖音页面自身的 API 请求的 `Sec-Fetch-*` / `Origin` 头不被移除。

## 2. 安全状态查询链路

```
options.js → GET_SECURITY_STATUS → background.js sendToTab({ timeout: 5000 })
  → content.js requestResponse('DY_GET_SECURITY_STATUS_REQUEST', 'DY_GET_SECURITY_STATUS_RESULT', 5000)
  → inject.js collectSecurityStatus() → 回传
```

`GET_SECURITY_STATUS` 为同步 handler，`collectSecurityStatus()` 立即执行并返回。

### 数据模型

```js
{
  key: string,                // localStorage[SECURITY_KEY]，剥 pub. 前缀
  keyUpdatedAt: number,       // Date.now()；空时为 0
  signatures: {
    detail/following/post/favorite/collection: { value, updatedAt }
  },                          // updatedAt 来自 Map.__dyCaptureTime
  hooks: { fetch: bool, xhr: bool },
}
```

## 3. 风险清单

| 风险           | 说明                                                | 缓解                                  |
|----------------|-----------------------------------------------------|---------------------------------------|
| 密钥过期       | localStorage SECURITY_KEY 可能过期，取消被拒        | `AUTH_FAILED` 时弹 toast 提示刷新页面 |
| 登出风险       | 无效 ticket-guard 密钥可能触发服务端登出            | 同上                                  |
| 部分失败可继续 | 单条 XHR 失败不中断，background 收集到 `errors[]`   | toast 显示成功/失败数量               |
| 前端耦合       | 按钮注入依赖 CSS 选择器；React fiber 获取 awemeInfo | 抖音 React 升级可能失效需重新适配     |
| 签名依赖       | 需从页面真实请求捕获 a_bogus                        | 冷启动无签名时立即报 `NO_SIGNATURE`   |