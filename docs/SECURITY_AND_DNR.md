# 安全状态与网络请求头

> 本文档描述 Chrome Manifest V3 的 declarativeNetRequest 规则、安全状态查询完整链路、以及已知安全风险。

## 1. 网络请求头修改（declarativeNetRequest）

```js
CONFIG.DNR.RULES = [
  {
    id: 1, priority: 1,
    condition: { urlFilter: 'douyinvod.com', resourceTypes: ['media', 'image', 'xmlhttprequest'] },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://www.douyin.com/' },
        { header: 'Origin',  operation: 'set', value: 'https://www.douyin.com' },
      ],
    },
  },
  {
    id: 2, priority: 1,
    condition: { urlFilter: 'douyinpic.com', resourceTypes: ['image', 'xmlhttprequest'] },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://www.douyin.com/' },
      ],
    },
  },
];
```

- 扩展使用 Chrome Manifest V3 的 `declarativeNetRequest` API 修改视频/图片 CDN 请求头
- `douyinvod.com`（视频 CDN）：强制设置 `Referer` 和 `Origin` 为抖音域名，防止防盗链拒绝
- `douyinpic.com`（图片 CDN）：强制设置 `Referer` 为抖音域名
- 这是详情页视频播放和封面图片加载能正常工作的关键
- `setupDeclarativeNetRequest()` 在 `onInstalled` 和 `onStartup` 时通过 `updateDynamicRules` 动态注册（幂等更新）

## 2. 安全状态查询完整链路

**完整链路**：
```
options.js (SecurityStatus.openPanel)
  → services.bgMsg({ type: 'GET_SECURITY_STATUS' })
  → background.js sendToTab('GET_SECURITY_STATUS', { timeout: 5000 })
  → content.js requestResponse('DY_GET_SECURITY_STATUS_REQUEST', 'DY_GET_SECURITY_STATUS_RESULT', 5000)
  → inject.js collectSecurityStatus()
  → 回传
```

**关键点**：
- `GET_SECURITY_STATUS` 是**同步 handler**，`collectSecurityStatus()` 在 inject.js 中立即执行并返回结果
- `requestResponse` 模式现在**先 `addEventListener(resultEvent)` 再 `dispatchEvent(requestEvent)`**，同步 handler 不再需要 `setTimeout(0)` workaround

### SecurityStatus 数据模型（inject.js → options.js）

`collectSecurityStatus()` 在 inject.js 主世界被 `DY_GET_SECURITY_STATUS_REQUEST` 触发，返回结构：
```js
{
  key: string,                  // 来自 localStorage[SECURITY_KEY]，剥离 pub. 前缀
  keyUpdatedAt: number,         // 读取时刻 (Date.now())；key 为空时为 0
  signatures: {
    detail:    { value, updatedAt },
    following: { value, updatedAt },
    post:      { value, updatedAt },
    favorite:  { value, updatedAt },
    collection:{ value, updatedAt },
  },                            // updatedAt 来自 Map.__dyCaptureTime
  hooks: { fetch: bool, xhr: bool },
}
```

签名 `value` 是序列化后的 `k=v&k2=v2` 字符串；`updatedAt` 来自 `captureFromUrl()` 写入的 `params.__dyCaptureTime`（注意：是 Map 实例上的 JS 属性，不是 Map entry，不参与 `entries()` 遍历）。

## 3. 安全风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| 密钥过期 | localStorage 中的 `SECURITY_KEY` 可能过期，取消请求被拒绝 | options.js 检测 `AUTH_FAILED` 时弹 toast 提示用户刷新抖音页面 |
| 登出风险 | 服务器可能因无效 ticket-guard 密钥拒绝请求，极端情况下导致登出 | 同上 |
| 部分失败可继续 | 单条 XHR 失败不中断，由 background 收集到 `errors[]`；`CANCEL_DONE` 报告汇总 | 用户可看 toast 中的成功/失败数量，失败的项仍在数据库中可手动处理 |
| 前端耦合 | 按钮注入依赖 CSS 选择器；React fiber 遍历获取 `awemeInfo` | 抖音 React 升级可能失效，需重新适配 |
| 签名依赖 | 需从页面真实请求中捕获 a_bogus 等签名参数 | 冷启动无签名时立即报 `NO_SIGNATURE` 错误，无等待 |
