# 抖音数据管理 (Douyin Data Manager)

Chrome Manifest V3 扩展，统一管理抖音的作品、关注、候选、点赞与收藏数据。扩展本体纯原生 JavaScript，零运行时依赖、无构建步骤，加载扩展不需要 npm。

## 功能

- **作品管理** — 同步/浏览/搜索/播放/下载抖音作品（视频和图文笔记），支持分组
- **保存前状态提示** — 抖音视频页「保存」按钮右上角绿色 ✓ 表示作品已在作品域，右下角蓝色「候」表示作者已在候选域；普通点击保存作品，Ctrl/Cmd+点击把当前作者加入候选域，避免重复收录
- **关注管理** — 扫描关注列表，检测取关用户，分组归类；校准粉丝数/作品数与最近更新时间
- **候选作者** — 扩展自建的候选作者池，支持链接收录、关注域批量入库、分组管理、作品侧栏与手动校准
- **点赞扫描** — 遍历历史点赞；未关注作者作品可在「工具」弹窗中清理
- **收藏扫描** — 遍历收藏作品，支持批量取消收藏
- **作者入库** — 粘贴作者主页链接，分页导入其全部作品，或将作者档案收录到候选域
- **批量操作** — 勾选删除/移动/下载；关注域可批量入库到候选域；批量下载打包为单个 zip
- **随机回顾** — 从任意域随机抽取一批数据，在「回顾」页签以卡片网格浏览；通过顶栏「随机」按钮换一批，来源域与本轮数量在「回顾」域顶栏配置
- **分组系统** — 自定义分组、拖拽排序、批量移动
- **数据维护** — 五域 JSON 全量导出/导入（含分组对账还原）与重置
- **独立模式** — 后台直接请求 API（多数链路无需打开抖音页面；点赞扫描、安全状态与浏览器特征刷新仍需抖音页面）
- **内置播放器** — 视频/图集详情播放、下载，对齐抖音播放界面

## 安装

1. 克隆或下载本仓库
2. 打开 Chrome，进入 `chrome://extensions`
3. 开启「开发者模式」（右上角开关）
4. 点击「加载已解压的扩展程序」，选择本项目文件夹

扩展图标出现在工具栏后，点击即可打开管理页面（Edge 等 Chromium 内核浏览器同样可加载）。

## 使用要点

- **域切换** — 作品/点赞/收藏/关注/候选五个数据域相互独立，随时切换；另设「回顾」域，持久化随机批次引用并支持搜索/详情浏览
- **双模式** — 默认标签页模式（转发到打开的抖音页面执行请求）；「设置」面板可开启独立模式（后台直连），并管理 Cookie/msToken/webid/浏览器特征缓存
- **入库** — 菜单「工具」粘贴作者主页链接，分页导入其作品到作品域（新条目落「未分组」，已在域保留原分组），或将作者档案收录到候选域；关注域批量模式勾选作者后也可「入库」到候选域
- **数据备份** — 菜单「维护」集中导出/导入/重置五域数据（含分组对账还原）

## 架构概览

```
inject.js (主世界)          — 拦截 fetch/XHR，捕获 API 响应与签名参数
    ↓ CustomEvent
content.js (隔离世界)       — 桥接层，requestResponse 模式
    ↓ chrome.runtime.sendMessage
background/ (Service Worker) — 消息路由（App.route）、存储操作、分页循环（ES 模块化：core.js + identity/data/tasks 子目录 + main.js）
    ↓ chrome.runtime.sendMessage
options/ (管理 UI)        — 响应式 store、虚拟网格、播放器（ES 模块化：core.js + grids/components/data/sync + main.js）
```

两种运行模式：
- **标签页模式**：background 将请求转发到打开的抖音页面，由页面的 `window.fetch` 执行（自动携带 cookie 和签名）
- **独立模式**：background 直接 HTTP 请求，使用 `crypto.js` 中的 ABogus 算法计算签名

## 存储

IndexedDB 库 `douyin-saver`，五数据域 + 回顾引用域，作品型三域含 `savedAt_id` / `groupId_savedAt_id` 复合索引（keyset 分页）：

| 域       | IndexedDB 表        | 主键      | 说明                              |
|----------|---------------------|-----------|-----------------------------------|
| 作品     | `works`             | `awemeId` | 视频/图文笔记，含视频直链与过期时间 |
| 点赞     | `favorites`         | `awemeId` | 与作品同构                        |
| 收藏     | `collections`       | `awemeId` | 与作品同构                        |
| 关注     | `followings`        | `uid`     | 账号原生关注镜像，计数经校准写入    |
| 候选     | `candidates`        | `uid`     | 扩展自建候选作者池，复用作者档案字段 |
| 回顾     | `review`            | `reviewId` | 仅存批次引用（来源域 + 源记录 id + 分组），展示时回源域 hydration，不复制完整记录 |
| 分组     | `*_groups`（×6）    | `id`      | 每域独立的分组定义                |

## 文档

| 文档 | 阅读场景 |
|------|----------|
| [docs/01-project-architecture.md](./docs/01-project-architecture.md) | 项目架构：双模运行、代码约束、存储、通信 |
| [docs/02-independent-sync-works.md](./docs/02-independent-sync-works.md) | 独立模式：同步作品 |
| [docs/03-independent-sync-followings.md](./docs/03-independent-sync-followings.md) | 独立模式：同步关注 |
| [docs/04-independent-calibrate-followings.md](./docs/04-independent-calibrate-followings.md) | 独立模式：校准关注 |
| [docs/05-independent-scan-collection.md](./docs/05-independent-scan-collection.md) | 独立模式：扫描收藏（含 webSign 逆向定案） |
| [docs/06-independent-cancel-collection.md](./docs/06-independent-cancel-collection.md) | 独立模式：取消收藏 |
| [docs/07-independent-fetch-user-works.md](./docs/07-independent-fetch-user-works.md) | 作者主页作品分页（双模分支） |
| [docs/08-dnr-rules.md](./docs/08-dnr-rules.md) | DNR 规则全表与排障 |
| [docs/09-inject-tab-mode.md](./docs/09-inject-tab-mode.md) | Inject.js Tab模式技术方案 |
| [docs/10-storage-write-and-import.md](./docs/10-storage-write-and-import.md) | 存储写入与导入合并 |
| [docs/11-options-ui.md](./docs/11-options-ui.md) | 管理页渲染与交互（虚拟化/媒体体系/弹窗） |
| [docs/12-class-map.md](./docs/12-class-map.md) | 类职责总表（options 侧 + background 侧） |
| [docs/13-design-red-lines.md](./docs/13-design-red-lines.md) | 设计红线与知识点陷阱完整版 |
| [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md)   | TikTokDownloader 参考 + API 端点总表      |
| [AGENTS.md](./AGENTS.md)                                 | AI Agent 技术参考（架构、协议、设计陷阱） |

## 参考项目

- [TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader) — 本项目独立模式的签名算法（a_bogus / Argus webSign）、凭据获取链路与抖音 API 端点参考了该项目，实现细节对照见 [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md)。感谢 [@JoeanAmier](https://github.com/JoeanAmier) 的开源贡献。

## 验证

```powershell
# 语法检查（node --check 自动识别 ES 模块）
Get-ChildItem background,content,options -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

实机测试：`chrome://extensions` → 重新加载 → 打开抖音页面验证。

## 许可证

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 授权，Copyright (C) 2026 daoist。

本扩展的签名算法实现与部分常量参考自 [TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader)（GPL-3.0），因此本扩展整体以 GPL-3.0 分发；任何再分发须遵守 GPL-3.0 并保留上述来源声明，实现对照详见 [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md)。

## 免责声明

1. 本项目仅供学习交流与技术研究，**禁止用于任何商业用途**。
2. 本项目不破解、不绕过任何付费内容或访问控制：所有数据均来自用户本人登录后可见的页面，仅做本地化管理；请求签名仅服务于用户本人的登录会话。
3. 通过本项目获取的内容仅限个人学习研究，其版权归原权利人所有，禁止二次分发或商用。
4. 用户因使用本项目而产生的一切行为及后果由用户自行承担，与作者无关。
5. 如本项目侵害了您的合法权益，请通过 Issue 联系，核实后将第一时间处理。
