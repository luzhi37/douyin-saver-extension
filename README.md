# 抖音数据管理 (Douyin Data Manager)

Chrome Manifest V3 扩展，统一管理抖音作品、关注、点赞与收藏数据。**纯原生 JS，无构建工具、无 npm、无 package.json。**

## 功能

- **作品管理** — 同步/浏览/搜索/播放/下载抖音作品（视频和图文笔记），支持分组
- **关注管理** — 扫描关注列表，检测取关用户，分组归类
- **点赞扫描** — 遍历历史点赞，按是否仍关注作者过滤
- **收藏扫描** — 遍历收藏作品，支持取消收藏
- **批量取消** — 批量取消点赞或取消收藏
- **分组系统** — 自定义分组、拖拽排序、批量移动
- **导入导出** — JSON 格式全量导出/导入，含分组还原
- **独立模式** — 无需打开抖音页面，后台直接请求 API
- **内置播放器** — 视频/图文详情播放、循环、下载、画中画

## 安装

1. 克隆或下载本仓库
2. 打开 Chrome，进入 `chrome://extensions`
3. 开启「开发者模式」（右上角开关）
4. 点击「加载已解压的扩展程序」，选择本项目文件夹

扩展图标出现在工具栏后，点击即可打开管理页面。

## 架构概览

```
inject.js (主世界)          — 拦截 fetch/XHR，捕获 API 响应与签名参数
    ↓ CustomEvent
content.js (隔离世界)       — 桥接层，requestResponse 模式
    ↓ chrome.runtime.sendMessage
background.js (Service Worker) — 消息路由、IndexedDB 操作、分页循环
    ↓ chrome.runtime.sendMessage
options.js (管理 UI)        — 响应式 store、虚拟网格、播放器
```

两种运行模式：
- **标签页模式**：background 将请求转发到打开的抖音页面，由页面的 `window.fetch` 执行（自动携带 cookie 和签名）
- **独立模式**：background 直接 HTTP 请求，使用 `crypto.js` 中的 ABogus 算法计算签名

## 存储

| 域       | IndexedDB 表        | 主键      | 说明          |
|----------|---------------------|-----------|---------------|
| 作品     | `works`             | `awemeId` | 视频/图文笔记 |
| 作品分组 | `works_groups`      | `id`      | 分组定义      |
| 关注     | `followings`        | `uid`     | 关注用户      |
| 关注分组 | `followings_groups` | `id`      | 分组定义      |

## 文档

| 文档 | 阅读场景 |
|------|----------|
| [docs/01-project-architecture.md](./docs/01-project-architecture.md) | 项目架构：双模运行、代码约束、存储、通信 |
| [docs/02-independent-sync-works.md](./docs/02-independent-sync-works.md) | 独立模式：同步作品 |
| [docs/03-independent-sync-followings.md](./docs/03-independent-sync-followings.md) | 独立模式：同步关注 |
| [docs/04-independent-calibrate-followings.md](./docs/04-independent-calibrate-followings.md) | 独立模式：校准关注 |
| [docs/05-independent-scan-collection.md](./docs/05-independent-scan-collection.md) | 独立模式：扫描收藏（含 webSign 逆向定案） |
| [docs/06-independent-cancel-collection.md](./docs/06-independent-cancel-collection.md) | 独立模式：取消收藏 |
| [docs/07-independent-fetch-user-works.md](./docs/07-independent-fetch-user-works.md) | 独立模式：获取用户作品列表 |
| [docs/08-dnr-rules.md](./docs/08-dnr-rules.md) | DNR 规则全表与排障 |
| [docs/09-inject-tab-mode.md](./docs/09-inject-tab-mode.md) | Inject.js Tab模式技术方案 |
| [docs/10-storage-write-and-import.md](./docs/10-storage-write-and-import.md) | 存储写入与导入合并 |
| [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md)   | TikTokDownloader 参考 + API 端点总表      |
| [AGENTS.md](./AGENTS.md)                                 | AI Agent 技术参考（架构、协议、设计陷阱） |

## 验证

```powershell
# 语法检查
node --check background/background.js content/content.js content/inject.js options/options.js
```

实机测试：`chrome://extensions` → 重新加载 → 打开抖音页面验证。