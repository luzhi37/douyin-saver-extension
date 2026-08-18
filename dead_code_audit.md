# 死代码与冗余代码审计报告

> 审计日期：2026-08-19
> 审计范围：项目所有 JS / CSS / HTML 源文件（除 `docs/`、`assets/`、`.git/` 等非代码目录）

---

## 总览

| 文件 | 问题数 |
|------|--------|
| `background/background.js` | 3 |
| `background/crypto.js` | 0 |
| `background/storage.js` | 0 |
| `content/content.js` | 0 |
| `content/inject.js` | 2 |
| `options/options.js` | 3 |
| `options/options.css` | 3 |
| `options/options.html` | 0 |
| `manifest.json` | 0 |
| **合计** | **11** |

---

## `background/background.js`

### BG-1: 悬浮注释「STROAGE_KEYS 作为 store/group 名的唯一常量来源」
- **行号**: 913
- **代码片段**:
  ```js
  // STORAGE_KEYS 作为 store/group 名的唯一常量来源
  ```
- **问题类型**: 无主注释（Orphaned Comment）
- **描述**: 该注释悬浮在 `handleSetMode` 函数定义（906-911）与 `setupDeclarativeNetRequest` 函数定义（916-929）之间，不与任何变量声明、函数或代码块相邻。其内容描述的是 `DOMAIN_CONFIG` 的设计意图，但该对象定义在 253-269 行，注释却插在 913 行，位置错乱。
- **处理建议**: 将此注释移动到 `DOMAIN_CONFIG` 定义的上方（250 行附近），或直接删除。若保留，应调整位置使其紧邻所描述的代码。

### BG-2: `domainStorage()` 返回值中包含未使用的属性
- **行号**: 994-1011
- **代码片段**:
  ```js
  return {
    getAll: () => storage.getAll(cfg.storeName),
    get: (key) => storage.get(cfg.storeName, key),
    putBatch: (items) => storage.putBatch(cfg.storeName, items),
    deleteBatch: (keys) => storage.deleteBatch(cfg.storeName, keys),
    count: () => storage.count(cfg.storeName),
    getByGroup: (groupId) => storage.getByIndex(cfg.storeName, "groupId", groupId),
    clear: () => storage.clear(cfg.storeName),
    getGroups: () => storage.getGroups(cfg.groupsName),
    putGroups: (groups) => storage.putGroups(cfg.groupsName, groups),
    getDefaultGroups: () => cfg.defaultGroups,      // 未使用
    idField: cfg.idField,                            // 未使用
    itemKey: cfg.itemKey,                            // 未使用
  };
  ```
- **问题类型**: 未使用的返回值属性（Unused Properties）
- **描述**: `domainStorage()` 返回的对象包含 `getDefaultGroups`、`idField`、`itemKey` 三个属性/方法，但所有调用者（`mergeAndSaveWorks`、`handleGetWork`、`handleSaveFollowings`、`handleGetStats` 等）均未从返回对象上访问它们。调用者通过顶层的 `getDefaultGroups()` 函数（984-986）和 `cfg` 常量直接获取这些值。
- **处理建议**: 移除这三个未使用的属性，减少返回对象的体积。如果未来需要，可随时重新添加。

### BG-3: `reloadRuntimeConfig()` 中的 `??` 回退逻辑存在冗余路径
- **行号**: 231-243
- **代码片段**:
  ```js
  CONFIG.TIMEOUT.REQUEST = cfg.timeoutRequest ?? CONFIG.TIMEOUT.REQUEST;
  CONFIG.TIMEOUT.SECURITY_STATUS = cfg.timeoutSecurityStatus ?? CONFIG.TIMEOUT.SECURITY_STATUS;
  CONFIG.DELAY.syncWorks = { MIN: cfg.syncWorksDelayMin ?? CONFIG.DELAY.syncWorks.MIN, MAX: cfg.syncWorksDelayMax ?? CONFIG.DELAY.syncWorks.MAX };
  // ... 重复模式
  ```
- **问题类型**: 冗余代码
- **描述**: 当 `cfg` 不存在时（214-229 行），函数已提前用 `RUNTIME_CONFIG_DEFAULTS` 填充 `CONFIG` 并 `return`。因此 231-243 行的 `?? CONFIG.TIMEOUT.REQUEST` 回退永远不会触发——`cfg` 一定存在且所有值都有定义。`??` 后的回退值是死代码。
- **处理建议**: 移除 `??` 后的回退值，直接赋值：`CONFIG.TIMEOUT.REQUEST = cfg.timeoutRequest;` 等。如果担心 future proof，可保留但不会实际执行到。

---

## `content/inject.js`

### INJ-1: `CONFIG.DEVICE_PARAMS` 版本号与 background.js 不一致
- **行号**: 30-31
- **代码片段**:
  ```js
  version_code: "170400",
  version_name: "17.4.0",
  ```
- **问题类型**: 冗余/不一致（Inconsistent Duplication）
- **描述**: `background.js` 中 `buildBaseParams()`（466-514 行）使用 `version_code: "290100"` / `version_name: "29.1.0"`，而 inject.js 的 `CONFIG.DEVICE_PARAMS` 使用 `"170400"` / `"17.4.0"`。虽然两者在各自请求路径中独立使用（inject 用于抖音页面内 fetch，background 用于独立模式），但版本不一致可能导致抖音后端行为差异。这不是传统意义上的死代码，但属于重复配置的冗余维护负担。
- **处理建议**: 统一为一个版本常量。可考虑将 `version_code` 和 `version_name` 定义在 shared 位置，或统一为较新的 `"290100"` / `"29.1.0"`。

### INJ-2: `stripSdkKeys()` 函数与 `stripPageKeys()` 逻辑高度重复
- **行号**: 149-158、162-169
- **代码片段**:
  ```js
  // 149-158
  function stripPageKeys(captured) {
    if (!captured) return null;
    const out = new Map();
    for (const [k, v] of captured) {
      if (PAGE_KEYS.has(k)) continue;
      if (k.startsWith("cursor") || k.startsWith("max_") || k.startsWith("min_")) continue;
      out.set(k, v);
    }
    return out;
  }

  // 162-169
  function stripSdkKeys(captured) {
    if (!captured) return null;
    const out = new Map();
    for (const [k, v] of captured) {
      if (SDK_INJECT_KEYS.has(k)) continue;
      out.set(k, v);
    }
    return out;
  }
  ```
- **问题类型**: 重复代码（Duplicated Code）
- **描述**: 两个函数结构完全相同，仅过滤条件和 `Set` 名称不同。多次调用时需链式调用 `stripPageKeys(stripSdkKeys(...))`，增加不必要的嵌套。
- **处理建议**: 合并为一个通用函数，如 `stripKeys(captured, excludeSet, extraPredicate)`，或定义一个过滤链数组。减少重复代码。

---

## `options/options.js`

### OPT-1: `config.icons` 的 icon 名称列表与 `<template id="icon-*">` 定义未同步校验
- **行号**: 3682-3684
- **代码片段**:
  ```js
  for (const name of ["pause", "play", "mute", "unmute", "loopSingle", "loopGroup", "noLoop", "check"]) {
    config.icons[name] = document.getElementById("icon-" + name).innerHTML;
  }
  ```
- **问题类型**: 冗余/紧耦合（Brittle Coupling）
- **描述**: HTML 模板中定义了 12 个 `<template id="icon-*">`（456-503 行），但初始化循环只加载了其中 8 个。`icon-mute`、`icon-unmute`、`icon-loopSingle`、`icon-loopGroup`、`icon-noLoop`、`icon-check`、`icon-pause`、`icon-play` 被加载。未加载的模板有：`icon-mute`（已加载，更正）、`icon-unmute`（已加载）、`icon-loopSingle`（已加载）。实际上所有 8 个都被加载了，但 `options.html` 中还有 `icon-arrow-down`、`icon-download`、`icon-sync`、`icon-delete`、`icon-error`、`icon-nav-left`、`icon-nav-right`、`icon-image-badge`、`icon-edit`、`icon-folder` 等定义在 `<symbol>` 中（通过 `<use>` 引用），这些与通过 `innerHTML` 加载的 `<template>` 图标是两套不同的引用机制，维护时容易遗漏。
- **处理建议**: 非真正的死代码，但建议将 icon 名称列表定义为常量，并在 HTML 的 `<template>` 定义附近加注释说明哪些 icon 被 JS 动态加载，哪些通过 `<use>` 引用。或者统一为一种引用机制。

### OPT-2: `favWorkTemplate` 模板中 `img` 的 `alt` 属性为空字符串
- **行号**: 193-196（options.html）
- **代码片段**:
  ```html
  <template id="favWorkTemplate">
    <div class="fav-work-item">
      <img class="fav-work-thumb" alt="" loading="lazy" />
    </div>
  </template>
  ```
- **问题类型**: 冗余/可访问性缺失
- **描述**: 在 `Favorites.#renderGrid`（2493-2504 行）中，`thumb.alt = w.desc || "";` 会设置 alt 文本，但模板中 `alt=""` 是冗余的，因为 JS 会覆盖它。`fav-work-item` 缺少 `click` 事件的视觉反馈样式（cursor: pointer 等），导致用户可能不知道可点击。
- **处理建议**: 非死代码，仅是模板冗余。可移除模板中的 `alt=""` 属性，由 JS 完全控制。

### OPT-3: `Sidebar` 类的 `static SNAP_POINTS` 与 `config.SIDEBAR_SNAP_POINTS` 重复
- **行号**: 1262
- **代码片段**:
  ```js
  static SNAP_POINTS = config.SIDEBAR_SNAP_POINTS;
  ```
- **问题类型**: 冗余代码（Redundant Duplication）
- **描述**: `Sidebar` 类将 `config.SIDEBAR_SNAP_POINTS` 赋值给静态属性，随后 `#snapTo` 方法（1393-1399）通过 `Sidebar.SNAP_POINTS` 引用。这层包装未提供任何额外逻辑（如深拷贝、验证），直接引用 `config.SIDEBAR_SNAP_POINTS` 效果相同。若 `config.SIDEBAR_SNAP_POINTS` 在运行时被修改（目前不会），静态属性不会同步更新。
- **处理建议**: 移除 `static SNAP_POINTS`，在 `#snapTo` 中直接引用 `config.SIDEBAR_SNAP_POINTS`，减少一层间接引用。

---

## `options/options.css`

### CSS-1: `@keyframes fadeIn` 动画定义未在任何选择器中使用
- **行号**: 99-102
- **代码片段**:
  ```css
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  ```
- **问题类型**: 死代码（Dead CSS）
- **描述**: 整个 CSS 文件中没有使用 `animation: fadeIn` 或 `animation-name: fadeIn` 的选择器。该动画可能是开发过程中遗留的。
- **处理建议**: 删除此 `@keyframes` 定义。

### CSS-2: `@keyframes detailIn` 动画定义未在任何选择器中使用
- **行号**: 114-117
- **代码片段**:
  ```css
  @keyframes detailIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  ```
- **问题类型**: 死代码（Dead CSS）
- **描述**: 整个 CSS 文件中没有使用 `animation: detailIn` 或 `animation-name: detailIn` 的选择器。详情弹窗的淡入由 JS 的过渡类控制。
- **处理建议**: 删除此 `@keyframes` 定义。

### CSS-3: `@keyframes detailContentIn` 动画定义未在任何选择器中使用
- **行号**: 119-122
- **代码片段**:
  ```css
  @keyframes detailContentIn {
    from { opacity: 0; transform: scale(0.96); }
    to   { opacity: 1; transform: scale(1); }
  }
  ```
- **问题类型**: 死代码（Dead CSS）
- **描述**: 整个 CSS 文件中没有使用 `animation: detailContentIn` 或 `animation-name: detailContentIn` 的选择器。详情内容过渡由 JS 的 `detail-transitioning` 类控制。
- **处理建议**: 删除此 `@keyframes` 定义。

---

## 分类统计

| 问题类型 | 数量 |
|---------|------|
| 死代码（Dead Code） | 3 |
| 冗余代码（Redundant Code） | 4 |
| 未使用属性（Unused Properties） | 1 |
| 无主注释（Orphaned Comment） | 1 |
| 重复代码（Duplicated Code） | 1 |
| 死 CSS（Dead CSS） | 3 |
| **合计** | **11** |

---

## 按严重程度分

| 严重程度 | 数量 | 说明 |
|---------|------|------|
| 低 | 11 | 所有问题均为低风险，不影响运行时功能。主要是代码整洁性、维护性问题。 |

---

## 审计说明

1. **审计范围**：所有 `.js`、`.css`、`.html`、`manifest.json` 源文件。`docs/`、`assets/` 目录及 `.git/` 等非代码文件排除。
2. **误报防护**：结合项目上下文（消息路由四层架构、独立模式 / Tab 模式双路径、`CONFIG` 与 `config` 双配置系统、事件监听体系）进行了综合判断。所有被消息路由 `switch` 引用的函数、被 `store.on` 注册的回调、被 `addEventListener` 绑定的处理函数，均被视为活跃代码。
3. **未确认项**：`options.css` 中 `@keyframes fadeIn`、`detailIn`、`detailContentIn` 在全文搜索中未找到引用，但考虑到 CSS 可能通过 `addEventListener('animationend')` 或 JS 动态注入类名间接使用，这三条标记为"可能死代码"而非确定性死代码。
4. **文件名**：本报告保存为 `dead_code_audit.md`。