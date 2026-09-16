# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **单一事实源**：本项目的全部技术参考统一维护在 [AGENTS.md](./AGENTS.md)（四层架构、双域存储模型、消息协议、设计约定与陷阱、config 分组速查、docs 文档索引）。本文档不复制其内容；**更新技术文档时只改 AGENTS.md 与对应的 docs/*.md，不要同步维护两份**。

## Project Snapshot

Chrome Manifest V3 extension for managing Douyin (抖音) user data — works (videos/notes), followings, likes, and collections. **Pure vanilla JS. No npm, no build tools, no package.json.** Load as an unpacked extension in Chrome.

## Commands

```powershell
# Syntax check all JS files
node --check background/main.js background/core.js background/identity/credentials.js background/identity/independent-client.js background/identity/tab-bridge.js background/data/domain-store.js background/data/domain-handlers.js background/data/groups.js background/data/data-tools.js background/tasks/scan-tasks.js background/tasks/independent-tasks.js background/identity/crypto.js background/data/storage.js content/content.js content/inject.js options/main.js options/core.js options/grids/virtual-grid.js options/grids/works-grid.js options/grids/followings-grid.js options/components/dialog.js options/components/search-bar.js options/components/sidebar.js options/components/detail.js options/components/settings.js options/components/app-shell.js options/data/groups.js options/data/batch.js options/data/import-export.js options/sync/sync.js options/sync/domain-scan-sync.js
```

## Where to Look

| 需要了解 | 查看 |
|----------|------|
| 架构总览 / 存储模型 / 消息协议表 / 设计约定与已知陷阱 / config 速查 | [AGENTS.md](./AGENTS.md) |
| 项目架构：双模运行、代码约束、存储、通信 | [docs/01-project-architecture.md](./docs/01-project-architecture.md) |
| 独立模式同步作品 / 同步关注 / 校准关注 | [docs/02](./docs/02-independent-sync-works.md) · [03](./docs/03-independent-sync-followings.md) · [04](./docs/04-independent-calibrate-followings.md) |
| 独立模式扫描收藏 / 取消收藏 / 作者作品分页 | [docs/05](./docs/05-independent-scan-collection.md) · [06](./docs/06-independent-cancel-collection.md) · [07](./docs/07-independent-fetch-user-works.md) |
| DNR 规则全表与排障 | [docs/08-dnr-rules.md](./docs/08-dnr-rules.md) |
| inject.js Tab模式技术方案（签名捕获/Hook/事件桥） | [docs/09-inject-tab-mode.md](./docs/09-inject-tab-mode.md) |
| 存储写入与导入合并（mergeWork/对账） | [docs/10-storage-write-and-import.md](./docs/10-storage-write-and-import.md) |
| 参考算法与抖音 API 端点总表 | [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md) |
