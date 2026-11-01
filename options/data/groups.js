// ---------- Groups ----------
import { config, dom, state, services, store } from '../core.js';
import { batch } from './batch.js';
import { dialog } from '../components/dialog.js';
import { detail } from '../components/detail.js';

// ---------- Groups ----------
class Groups {
  // 新增分组请求进行中：防双击重复提交
  #addingGroup = false;
  // 重建代际：GET_GROUPS/GET_STATS 往返期间若又发生重建（域切换/分组 CRUD），旧帧作废
  #renderGen = 0;

  // 两段式重建（消除「切域时分组栏慢一拍」）：① 轻量 GET_GROUPS 先出分组名 + 激活态，tab
  // 结构即刻就位；② 按当前域异步补计数（GET_STATS {domain} 只统计一个域，不再为一个域的
  // 按钮拖上全部五域聚合）。存储指示器走独立 fire-and-forget，不占本关键路径
  async renderGroupTabs() {
    const gen = ++this.#renderGen;
    this.#refreshStorageIndicator();
    const groupList = await services.loadGroups();
    if (gen !== this.#renderGen) return; // 期间已触发新一次重建：本帧作废
    // 首段先带出已知计数（同一 state.gridTotals 缓存：page-0 total 与 GET_STATS 都写入，
    // 与搜索栏 K/N 同源）——命中时直接带数字，未命中（本会话首访）先只出名字，page-0 /
    // 第二段回填
    dom.groupTabs.innerHTML = "";
    const pairs = [];
    for (const g of groupList) {
      const tab = document.getElementById("groupTabTemplate").content.cloneNode(true).firstElementChild;
      tab.classList.toggle("active", g.id === state.currentGroupId);
      tab.dataset.groupId = g.id;
      tab.dataset.groupName = g.name;
      const c = state.gridTotals[`${state.domain}|${g.id}`];
      tab.textContent = c == null ? g.name : `${g.name} (${c})`;
      tab.addEventListener("click", () => this.#switchGroup(g.id));
      dom.groupTabs.appendChild(tab);
      pairs.push([g, tab]);
    }
    // 滑块随重建重建：只在新集合落定时无动画就位（带动画会从旧位置横穿飞过）
    const slider = document.createElement("div");
    slider.className = "group-slider";
    dom.groupTabs.appendChild(slider);
    this.updateGroupSlider(false);
    this.updateTabMask();

    // 第二段（不 await）：计数是装饰性补丁。GET_STATS 的分组 count 在 3 万级库上与
    // 首页 page-0 / 续页游标读并发会抢 IDB（实测把首页往返从 ~150ms 拖到 ~1s、把首段
    // 计数增长拖住），故分两级延后：首屏渲染落笔后 → 网格加载空闲（最多 5s）再取；
    // 期间 tab 沿用 state.gridTotals 缓存（page-0 会即时校正当前分组）
    const domain = state.domain;
    const waitedGroupId = state.currentGroupId;
    services.whenFirstScreen(domain, waitedGroupId).then(() => {
      if (gen !== this.#renderGen) return; // 期间已重建：跳过，新帧会自行补计数
      // 续页保护窗：GET_STATS 的分组 count 在大域上与续页游标读并发，会把「600 → 增长」
      // 的首段拖住（切 3 万域实测首段停顿数百 ms）；等网格加载空闲（最多 5s，期间 tab
      // 沿用 state.gridTotals 缓存计数）后再取，避免与续页抢 IDB
      const start = performance.now();
      const kick = () => {
        if (gen !== this.#renderGen) return;
        if (services.isGridLoading() && performance.now() - start < 5000) {
          setTimeout(kick, 100);
          return;
        }
        this.#fillGroupCounts(gen, domain, pairs).catch(() => {});
      };
      kick();
    });
  }

  async #fillGroupCounts(gen, domain, pairs) {
    const stats = await services.loadStats(domain);
    if (gen !== this.#renderGen) return; // 期间已重建：跳过，新帧会自行补计数
    const domainStats = stats[domain] || { total: 0, groupCounts: {} };
    // 权威总量同步进 state 缓存：搜索栏切域/切组的「0/Total」占位、分组 tab 首段数字与
    // page-0 校正共用同一份（见 onGridTotal）
    for (const [gid, count] of Object.entries(domainStats.groupCounts || {})) {
      state.gridTotals[`${domain}|${gid}`] = count;
    }
    for (const [g, tab] of pairs) {
      if (!tab.isConnected) continue; // 已被替换的游离节点：跳过
      tab.textContent = `${g.name} (${domainStats.groupCounts?.[g.id] ?? 0})`;
    }
    this.updateGroupSlider(false); // 计数改变了 tab 宽度：滑块重定
    this.updateTabMask();
  }

  // 首页权威 total 到达即校正当前分组的 tab 数字（与搜索栏 K/N 的 N 同源）：tab 集合在
  // page-0 之前重建，本会话首访时只有名字——这里补上数字，不必等 GET_STATS（大域上被
  // 延后到加载空闲）；缓存在 state.gridTotals 中与切域「0/Total」占位共用
  onGridTotal({ domain, groupId, total } = {}) {
    if (!domain || domain !== state.domain || total == null) return;
    const tab = dom.groupTabs.querySelector(`.group-tab[data-group-id="${groupId}"]`);
    if (!tab || !tab.isConnected) return;
    tab.textContent = `${tab.dataset.groupName || ""} (${total})`;
    this.updateGroupSlider(false); // 数字改变了 tab 宽度：滑块重定
    this.updateTabMask();
  }

  // 进度式分组计数（加载中的「全部」视图逐页累计）：非当前分组 tab 数字随续页出现并增长
  //（与 K/N 的「已加载」口径一致），不必等延后的 GET_STATS；「全部」tab 用 page-0 权威
  // total，不参与累计；加载完成后 GET_STATS 会把数字校正为权威值
  onGridTotals({ domain, counts } = {}) {
    if (!domain || domain !== state.domain || !counts) return;
    let changed = false;
    for (const [gid, c] of Object.entries(counts)) {
      if (gid === "all") continue;
      const tab = dom.groupTabs.querySelector(`.group-tab[data-group-id="${gid}"]`);
      if (!tab || !tab.isConnected) continue;
      const text = `${tab.dataset.groupName || ""} (${c})`;
      if (tab.textContent !== text) {
        tab.textContent = text;
        changed = true;
      }
    }
    if (!changed) return;
    this.updateGroupSlider(false); // 数字改变了 tab 宽度：滑块重定
    this.updateTabMask();
  }

  // 分组切换的轻量同步（tab 集合未变）：只切 active 类 + 滑块带动画滑动，
  // 不重建 tab——滑块元素跨切换存活才有滑动起点
  syncActiveTabs() {
    for (const tab of dom.groupTabs.querySelectorAll(".group-tab")) {
      tab.classList.toggle("active", tab.dataset.groupId === state.currentGroupId);
    }
    this.updateGroupSlider(true);
  }

  // 滑块定位到 active tab（offsetLeft/offsetWidth 相对 .group-tabs）。
  // animated=false（重建/resize）时 no-anim 瞬移：尺寸变化绝不允许滑块横穿飞行
  updateGroupSlider(animated) {
    const slider = dom.groupTabs.querySelector(".group-slider");
    if (!slider) return;
    if (!animated) slider.classList.add("no-anim");
    const active = dom.groupTabs.querySelector(".group-tab.active");
    if (!active) {
      // active 缺失（如删除当前分组的重建瞬间）：收拢滑块，绝不残留旧位置高亮
      slider.style.width = "0px";
      return;
    }
    slider.style.transform = `translateX(${active.offsetLeft}px)`;
    slider.style.width = `${active.offsetWidth}px`;
    if (!animated) {
      slider.getBoundingClientRect();
      slider.classList.remove("no-anim");
    }
  }

  updateTabMask() {
    const el = dom.groupTabs;
    const overflow = el.scrollWidth > el.clientWidth;
    if (!overflow) {
      el.classList.remove("tab-overflow", "tab-at-start", "tab-at-end");
      return;
    }
    el.classList.add("tab-overflow");
    el.classList.toggle("tab-at-start", el.scrollLeft <= config.TAB_SCROLL_THRESHOLD);
    el.classList.toggle("tab-at-end", el.scrollLeft + el.clientWidth >= el.scrollWidth - config.TAB_SCROLL_THRESHOLD);
  }

  async showGroupManage() {
    const tmpl = document.getElementById("groupManageTemplate");
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog("分组管理", body, null, null, { autoFocus: false });
    state.preventDialogClose = true;
    try {
      // 打开时只刷弹窗内列表：顶栏分组栏本就没变，重建纯属无谓开销（曾致「数字白闪一次」）
      await this.#renderDialogGroupList();
    } finally {
      state.preventDialogClose = false;
    }

    const input = dom.dialogBody.querySelector("#newGroupInput");
    const addBtn = dom.dialogBody.querySelector("#addGroupBtn");
    if (input && addBtn) {
      addBtn.addEventListener("click", async () => {
        const name = input.value.trim();
        if (!name || this.#addingGroup) return;
        this.#addingGroup = true;
        try {
          const res = await services.bgMsg({ type: "ADD_GROUP", domain: state.domain, name });
          if (res.ok) {
            input.value = "";
            await this.#refreshGroupList();
          }
        } finally {
          this.#addingGroup = false;
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addBtn.click();
      });
    }
  }

  // 顶栏 + 弹窗双侧刷新（分组增删改后用）：顶栏重建（首段带出缓存计数，不再白闪）+ 弹窗列表重建
  async #refreshGroupList() {
    await this.renderGroupTabs();
    await this.#renderDialogGroupList();
  }

  // 只重建弹窗内的分组列表（打开弹窗 / 增删改后用）：顶栏未变时不牵动顶栏重建
  async #renderDialogGroupList() {
    const groupList = await services.loadGroups(state.domain);
    const list = dom.dialogBody.querySelector("#groupList");
    if (!list) return;
    list.innerHTML = "";
    for (const g of groupList.filter((g) => !g.fixed)) {
      const item = document.getElementById("groupListItemTemplate").content.cloneNode(true).firstElementChild;
      item.dataset.groupId = g.id;
      item.querySelector(".group-name").textContent = g.name;
      item.querySelector(".rename-btn").addEventListener("click", () => {
        const nameSpan = item.querySelector(".group-name");
        const oldName = nameSpan.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.value = oldName;
        input.maxLength = config.GROUP_NAME_MAX_LEN;
        input.className = "group-rename-input";
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        const done = async () => {
          const newName = input.value.trim();
          if (newName && newName !== oldName) {
            await services.bgMsg({ type: "RENAME_GROUP", domain: state.domain, groupId: g.id, newName });
            store.refreshGroups();
            nameSpan.textContent = newName;
          } else nameSpan.textContent = oldName;
          input.replaceWith(nameSpan);
        };
        input.addEventListener("blur", done);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
          }
          if (e.key === "Escape") {
            input.value = oldName;
            input.blur();
          }
        });
      });
      item.querySelector(".delete-btn").addEventListener("click", () => {
        const delTmpl = document.getElementById("confirmDeleteGroupTemplate");
        const delBody = delTmpl.content.cloneNode(true);
        delBody.querySelector(".confirm-delete-group-name").textContent = g.name;
        // pushDialog 叠于分组管理之上：确认/删除后回到管理列表（父层原地保留，item 保持连接、移除即生效）
        dialog.pushDialog("确认删除", delBody, [
          {
            text: "删除",
            danger: true,
            callback: async () => {
              dialog.updateDialog("正在删除…", "");
              state.preventDialogClose = true;
              try {
                const res = await services.bgMsg({ type: "DELETE_GROUP", domain: state.domain, groupId: g.id });
                if (!res || res.ok !== true) {
                  dialog.closeDialog();
                  dialog.showToast("删除失败: " + (res?.error || "未知错误"), "error");
                  return;
                }
                item.remove();
                store.refreshGroups();
                dialog.closeDialog();
                dialog.showToast(`已删除"${g.name}"`, "success");
              } catch (err) {
                dialog.closeDialog();
                dialog.showToast("删除失败: " + (err.message || String(err)), "error");
              } finally {
                state.preventDialogClose = false;
              }
            },
          },
        ]);
      });
      list.appendChild(item);
    }
    this.#setupDragSort(list);
  }

  #setupDragSort(container) {
    let dragItem = null;
    container.addEventListener("dragover", (e) => e.preventDefault());
    container.addEventListener("drop", (e) => e.preventDefault());
    container.querySelectorAll('.group-list-row[draggable="true"]').forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        dragItem = el;
        el.style.opacity = "0.5";
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        el.style.opacity = "1";
        dragItem = null;
        this.#saveOrder();
      });
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dragItem && dragItem !== el) {
          const mid = el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
          if (e.clientY < mid) container.insertBefore(dragItem, el);
          else container.insertBefore(dragItem, el.nextSibling);
        }
      });
    });
  }

  async #saveOrder() {
    const items = dom.dialogBody.querySelectorAll(".group-list-row");
    const customIds = Array.from(items).map((el) => el.dataset.groupId);
    const groups = await services.loadGroups(state.domain);
    const defaultIds = groups.filter((g) => g.fixed).map((g) => g.id);
    await services.bgMsg({ type: "REORDER_GROUPS", domain: state.domain, groupIds: [...defaultIds, ...customIds] });
    store.refreshGroups();
  }

  // 存储指示器独立刷新（fire-and-forget，不阻塞分组 tab 重建）：只取字节数（bytesOnly 不做 count）
  #refreshStorageIndicator() {
    services
      .loadStorageBytes()
      .then((bytes) => this.#applyStorageIndicator(bytes))
      .catch(() => {});
  }

  #applyStorageIndicator(bytes) {
    const pct = bytes / config.STORAGE_MAX_BYTES;
    const used = (bytes / 1024 / 1024).toFixed(pct > 0.1 ? 1 : 2);
    // 两行式：数值在上、单位在下（窄栏 48px 内单行放不下，原先被 overflow 裁切）
    dom.menuStorage.innerHTML = `<span class="storage-num">${used}</span><span class="storage-unit">MB</span>`;
  }

  #switchGroup(groupId) {
    // 分组切换保留批量模式（批量栏与勾选框随新分组继续可用）：只清空选区与 Shift
    // 锚点（旧分组条目不在新视图）；域切换仍退出批量（AppShell.switchDomain）
    batch.resetSelection();
    detail.closeDetail();
    // 滚动容器是 #mainGrid 自身（overflow-y:auto），window.scrollTo 不作用于它；
    // 清场 wipe 会 clamp 归零，这里显式复位保证语义正确
    dom.mainGrid.scrollTop = 0;
    store.set("currentGroupId", groupId);
  }
}

export const groups = new Groups();

// page-0 权威 total 到达即校正当前分组 tab 数字（与搜索栏 K/N 同源；见 onGridTotal）；
// 加载中的其余分组数字随续页进度累计（见 onGridTotals）
store.on("grid-total", (payload) => groups.onGridTotal(payload));
store.on("grid-totals", (payload) => groups.onGridTotals(payload));
