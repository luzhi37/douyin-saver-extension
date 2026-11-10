// ---------- Groups ----------
import { config, dom, state, services, store } from '../core.js';
import { noteProgrammaticScroll } from '../grids/virtual-grid.js';
import { batch } from './batch.js';
import { dialog } from '../components/dialog.js';
import { detail } from '../components/detail.js';

// ---------- Groups ----------
class Groups {
  // 新增分组请求进行中：防双击重复提交
  #addingGroup = false;
  // 重建代际：GET_DOMAIN_GROUPS 往返期间若又发生重建（域切换/分组 CRUD），旧帧作废
  #renderGen = 0;

  // 名称与计数拆成两个 span：计数用更弱的字号/颜色，同时保留文本级 diff 以维持
  // 高频计数刷新的短路径（不重建 tab、不重置横向滚动与滑块）
  #setTabContent(tab, name, count) {
    const nameEl = tab.querySelector(".group-tab-name");
    const countEl = tab.querySelector(".group-tab-count");
    if (!nameEl || !countEl) return false;
    let dirty = false;
    if (nameEl.textContent !== name) {
      nameEl.textContent = name;
      dirty = true;
    }
    const countText = count == null ? "" : String(count);
    if (countEl.textContent !== countText) {
      countEl.textContent = countText;
      dirty = true;
    }
    return dirty;
  }

  // 单次原子快照渲染：GET_DOMAIN_GROUPS 只读 *_groups 一张小表（count 字段，O(分组数)），
  // 名称/顺序/计数同一响应到达后一次渲染，tab 一次成型——不保留快照、不显示进度计数。
  // 计数由 background 写入同事务维护，不扫数据表；域切换时先 clearForDomainSwitch()
  // 清空旧域 tab，快照到达后直接落正确名称/顺序/数字
  async renderGroupTabs() {
    const gen = ++this.#renderGen;
    // 先发分组快照，再发存储指示器字节查询，避免 bytesOnly 抢后台消息队列
    const pending = services.loadDomainGroups(state.domain);
    this.#refreshStorageIndicator();
    try {
      const snapshot = await pending;
      if (gen !== this.#renderGen) return; // 期间已触发新一次重建：本帧作废
      this.#renderTabs(snapshot.groups, snapshot.counts);
    } catch (err) {
      // 快照失败：退回分组名（无数字），不显示旧域/旧计数
      console.warn("[DDM] load domain groups failed:", err);
      if (gen !== this.#renderGen) return;
      try {
        const groupList = await services.loadGroups();
        if (gen !== this.#renderGen) return;
        this.#renderTabs(groupList, {});
      } catch {
        /* 分组也取不到：保持空栏，等待下一次重建 */
      }
    }
  }

  // tab 集合/顺序/名称未变时只 patch 文本，不重建节点：计数类刷新（STORE_CHANGED 收口、
  // 详情删除等）高频走这条短路径，保横向滚动位置、hover/focus 与滑块连续性；结构有变
  //（域切换/分组增删改名排序）才整条重建
  #renderTabs(groupList, counts) {
    const existing = dom.groupTabs.querySelectorAll(".group-tab");
    let sameStructure = existing.length > 0 && existing.length === groupList.length;
    if (sameStructure) {
      for (let i = 0; i < groupList.length; i++) {
        const tab = existing[i];
        if (tab.dataset.groupId !== groupList[i].id || tab.dataset.groupName !== groupList[i].name) {
          sameStructure = false;
          break;
        }
      }
    }
    if (sameStructure) {
      let dirty = false;
      for (let i = 0; i < groupList.length; i++) {
        const g = groupList[i];
        const tab = existing[i];
        const active = g.id === state.currentGroupId;
        if (tab.classList.contains("active") !== active) {
          tab.classList.toggle("active", active);
          dirty = true;
        }
        if (this.#setTabContent(tab, g.name, counts?.[g.id])) dirty = true;
      }
      // 数字位数影响 tab 宽度：只在视觉真变时重定滑块/遮罩
      if (dirty) {
        this.updateGroupSlider(false);
        this.updateTabMask();
      }
      return;
    }
    dom.groupTabs.innerHTML = "";
    for (const g of groupList) {
      const tab = document.getElementById("groupTabTemplate").content.cloneNode(true).firstElementChild;
      tab.classList.toggle("active", g.id === state.currentGroupId);
      tab.dataset.groupId = g.id;
      tab.dataset.groupName = g.name;
      this.#setTabContent(tab, g.name, counts?.[g.id]);
      tab.addEventListener("click", () => this.#switchGroup(g.id));
      dom.groupTabs.appendChild(tab);
    }
    // 滑块随重建重建：只在新集合落定时无动画就位（带动画会从旧位置横穿飞过）
    const slider = document.createElement("div");
    slider.className = "group-slider";
    dom.groupTabs.appendChild(slider);
    this.updateGroupSlider(false);
    this.updateTabMask();
  }

  // 域切换：旧域的名称/顺序/计数全部失效，立即清空（随后 renderGroupTabs 用新域快照重建）
  clearForDomainSwitch() {
    this.#renderGen++;
    dom.groupTabs.innerHTML = "";
  }

  // 首页权威 total 到达即校正当前分组的 tab 数字（搜索栏只显示 K，不再展示该总量）：
  // 快照通常已含正确计数；page-0 与快照之间若发生写入，以 page-0 的当前分组 total 为准
  onGridTotal({ domain, groupId, total } = {}) {
    if (!domain || domain !== state.domain || total == null) return;
    const tab = dom.groupTabs.querySelector(`.group-tab[data-group-id="${groupId}"]`);
    if (!tab || !tab.isConnected) return;
    this.#setTabContent(tab, tab.dataset.groupName || "", total);
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
              await dialog.runTask({
                progressTitle: "正在删除…",
                task: async () => {
                  const res = await services.bgMsg({ type: "DELETE_GROUP", domain: state.domain, groupId: g.id });
                  if (!res || res.ok !== true) throw new Error(res?.error || "未知错误");
                  item.remove();
                  store.refreshGroups();
                },
                successText: `已删除"${g.name}"`,
                failPrefix: "删除失败: ",
              });
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
    // 两行式：数值在上、单位在下（窄导航轨内单行放不下，原先被 overflow 裁切）
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
    noteProgrammaticScroll();
    store.set("currentGroupId", groupId);
  }
}

export const groups = new Groups();

// page-0 权威 total 到达即校正当前分组 tab 数字（快照已含计数；写入间隙以 page-0 为准）
store.on("grid-total", (payload) => groups.onGridTotal(payload));
