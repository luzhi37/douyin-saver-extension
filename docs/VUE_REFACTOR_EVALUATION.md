# Vue 重构可行性评估

> 一次性评估，不进版本控制。结论：**不建议全面 Vue 重构**。

## 1. 项目结构与可改造边界

| 文件 | 行数 | 角色 | 能否 Vue 化 |
|---|---:|---|:---:|
| `background/background.js` | 753 | Service Worker：消息路由、DNR、存储操作 | ❌ |
| `background/storage.js` | — | IndexedDB 封装 | ❌ |
| `content/content.js` | 232 | 隔离世界桥接：CustomEvent ↔ chrome.runtime.sendMessage | ❌ |
| `content/inject.js` | 1109 | **主世界脚本**：fetch hook、XHR hook、签名捕获、抓取分页 | ❌ |
| `options/options.html` | 462 | 管理 UI 结构 | ✅ |
| `options/options.js` | 3194 | 管理 UI 逻辑（11 个 class） | ✅（但只 50% 适合） |
| `options/options.css` | ~1200 | UI 样式 | ⚠️ 局部 |

**能 Vue 化的代码量 < 30%**（约 4500 / ~7000 行）。inject.js / content.js / background.js 三者合计 ~2100 行承载了核心抓取能力，受 Manifest V3 强制分层限制（主世界 fetch hook、隔离世界桥接、Service Worker），任何 UI 框架都动不了。

## 2. options.js 内部构成分析

| 模块 | 性质 | Vue 适配度 |
|---|---|:---:|
| `VirtualGrid`（基类） | IntersectionObserver + 分块 + 骨架替换 | ❌ 性能关键 |
| `Dialog` | 命令式 `showDialog(title, body, footer)` | ❌ 命令式 API |
| `FollowingsGrid` / `WorksGrid` | 渲染卡片 + 事件委托 + 复杂 hover 视频预览 | ❌ 性能 + 命令式 |
| `Groups` | 分组 tab + 拖拽排序 + 弹窗表单 | ⚠️ 部分适合 |
| `Batch` | 状态机 + 选中集（Set） + 多步确认 | ❌ |
| `ImportExport` | 文件 IO + 多阶段进度 | ⚠️ |
| `Sidebar` | 拖拽 resize + 滚动分页 + getBoundingClientRect | ❌ 大量命令式 |
| `Sync` | **核心状态机**：requestId 跟踪、取消信号、进度去重、错误回滚 | ❌ |
| `Favorites` | 跨域状态 + 取消信号 + 多阶段 UI | ❌ |
| `SecurityStatus` | 面板渲染 + 展开/收起 | ⚠️ |
| `Detail` | **核心状态机**：视频/图文双模式 + 循环模式 + 键盘/滚轮导航 + 下载流程 | ❌ |

**真正能被 Vue 改善的代码估计 500-800 行**（Groups 列表、SecurityStatus 面板、ImportExport 流程表单），其它都是性能/状态机/命令式，Vue 反而会变成包袱。

## 3. 引入 Vue 的实际成本

### 3.1 必须引入的工具链
- `package.json` + `npm install`（项目目前明确"无 npm、无 package.json、无 bundler"）
- Vite（最轻量的 Vue 编译工具，~10MB node_modules）
- `vue@3` runtime（~50KB min+gzip）
- 选择方案：CDN 引用 vs SFC + build
  - CDN：免 build 但失去 SFC 优势，仍然要拉 50KB
  - SFC：保留 Vue 优势但要 build → dev 时 `npm run watch` 改 .vue → rebuild → chrome 刷新扩展

### 3.2 Chrome 扩展开发的 Vue 体验
- **没有 HMR**。Vue 项目的卖点之一就是 HMR，但 options page 是 chrome 扩展的 popup/options 页，chrome 不支持对扩展页面的 HMR 注入。
- 调试链路：`source.vue` → Vite 编译 → `options.js` (bundled) → chrome 刷新 → DevTools 断点
- 每次改 .vue 都要走完整编译（即使 Vite 增量，1-3 秒 + chrome reload）
- 报错栈指向 bundled 后的代码，需要 source map

### 3.3 VirtualGrid 性能退化的具体场景
当前实现：
```js
// 先渲染 50 个骨架，IntersectionObserver 触发后再替换为完整卡片
const card = skelTmpl.content.cloneNode(true).firstElementChild;
card.dataset[itemKey] = items[i][itemKey];
fragment.appendChild(card);
```
**优势**：零 diff 成本、零 vnode 树、零 proxy 拦截。

Vue 化后：
- 1000 件作品 → Vue 创建 1000 个 vnode → 创建 1000 个真实 DOM → 1000 个 reactive proxy
- `v-for` 触发 keyed diff，每次数据变化都重算（即使变化只是 1 件）
- 视频 hover 预览需要在 `nextTick` 里操作 DOM（Vue 的弱项）
- **性能下降估计 30%-50%**，对当前 1000+ 作品场景肉眼可见

### 3.4 命令式 API 的范式冲突

当前 `Dialog` 是命令式：
```js
dialog.showDialog('删除确认', confirmBody, [
  { text: '取消', ghost: true, callback: () => dialog.closeDialog() },
  { text: '删除', danger: true, callback: async () => { /* ... */ } }
]);
```

Vue 化要么：
- **方案 A**：保留命令式 API，用 `markRaw` + ref 操作 DOM → Vue 化了个寂寞
- **方案 B**：改成 `<Dialog v-model="open" @confirm="...">` 风格 → 11 个 class 全部要改调用方，估时翻倍

### 3.5 跨文件重构
- inject.js 的 `paginatedFetcher` 用了 `setActiveTask()` 全局句柄
- background.js 的 `sendToTab` 用了 `crypto.randomUUID()` + `requestId` 跨链路追踪
- options.js 的 Sync/Favorites 都用 `#requestId` 过滤过期进度事件

这些**与 Vue 完全无关**，但 Vue 改造时容易被误改：开发者看到 `state.x = ...` 想直接 `reactive(state)`，结果 `state.requestId` 被 proxy 包裹，深层比较失效。

## 4. 真正的痛点（Vue 也解决不了）

| 痛点 | Vue 能否解决 | 真正方案 |
|---|:---:|---|
| options.js 3200 行太厚 | ❌ | 拆文件成 modules |
| 11 个 class 互相引用 | ❌ | 依赖注入 / 事件总线（现有 store 已基本是） |
| 加新功能要改 5 个地方 | ❌ | 抽出 feature module |
| 没有类型提示 | ❌ | JSDoc → 逐步 TypeScript |
| 没有单元测试 | ❌ | 加测试 |
| 浏览器扩展调试麻烦 | ❌ | chrome devtools + 日志规范 |
| 视频预览卡顿 | ❌ | 优化 hover 检测，不是换框架 |
| IndexedDB 操作难追踪 | ❌ | 加 storage 抽象层 |

**没有任何一项痛点必须用 Vue 才能解决。**

## 5. 量化收益/成本

### 全面 Vue 重构（不建议）

| 维度 | 数值 |
|---|---|
| 估时 | 2-3 月 |
| 代码量 | 3200 行 options.js + 462 行 html + 1200 行 css → ~3500 行 .vue（差不多持平或略多） |
| 学习曲线 | 团队成员需熟悉 Vue 3 Composition API + 浏览器扩展 + Manifest V3 |
| 运行时开销 | +50KB Vue runtime |
| 构建时间 | 首次 10-20s，增量 1-3s |
| 性能 | VirtualGrid 退化 30-50% |
| 可维护性 | 提升 < 20%（本来就按 class 分好了） |
| 风险 | 高（核心功能回归、签名抓取链路是项目命脉） |

### 替代方案：结构性重构（推荐）

| 维度 | 数值 |
|---|---|
| 估时 | 2-3 周 |
| 改动 | options.js 拆 8-12 个模块文件 + 加 JSDoc 类型 + 引入 chrome.* 类型 |
| 学习曲线 | 几乎为零（仍是纯 JS） |
| 运行时开销 | 0 |
| 构建时间 | 0（仍是直读） |
| 性能 | 不变（VirtualGrid 不动） |
| 可维护性 | 提升 50-100%（每个文件 < 400 行） |
| 风险 | 低（API 表面不变，纯物理拆分） |

## 6. 结论

**不推荐把 Vue 作为整体重构目标。** 原因：
1. 可改造范围 < 30%，剩下 70%（inject/content/background）框架无关
2. 真正痛点（文件大、class 耦合）用"拆文件"就解决，不需要换范式
3. 性能敏感的 VirtualGrid 在 Vue 里会退化
4. 状态机密集（Sync / Favorites / Detail）从命令式改成响应式是负向收益
5. 引入构建工具的成本（npm + Vite + 失去 HMR）远超收益
6. 项目当前架构（"无构建工具、无 bundler"）是经过权衡的选择，Vue 化是反方向

**唯一合理的 Vue 场景**：如果团队成员全是 Vue 背景，且未来要把这个扩展演化成"管理多平台数据"（不止抖音），那么 Vue 可以作为**新功能模块**的引入方式，而不是整体重构。已稳定的 3200 行 options.js 不动，新加的"小红书"模块用 Vue 写。这种"局部引入"成本可控、风险隔离。

## 7. 如果坚持要做，分阶段建议

1. **第 0 阶段（必须先做）**：拆 options.js 为 8-12 个独立 module，建立清晰的 import 边界。先解决结构问题，再考虑框架。
2. **第 1 阶段**：保留 options.js 不动，**只**为新功能（如果要做）单独建一个 Vue 子项目。
3. **第 2 阶段（可选）**：等业务稳定、新功能模块跑通后，再考虑把 VirtualGrid 之外的部分慢慢迁移。**永远不要动 VirtualGrid 和 inject.js**。
