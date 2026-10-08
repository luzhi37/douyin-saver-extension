// ---------- Groups ----------
import { config, dom, state, services, store } from '../core.js';
import { dialog } from '../components/dialog.js';
import { detail } from '../components/detail.js';

// ---------- Groups ----------
class Groups {
  // 新增分组请求进行中：防双击重复提交
  #addingGroup = false;

  async renderGroupTabs() {
    const [stats, groupList] = await Promise.all([services.loadStats(), services.loadGroups()]);
    this.#updateStorageIndicator(stats);
    const domainStats = stats[state.domain] || { total: 0, groupCounts: {} };
    dom.groupTabs.innerHTML = "";
    for (const g of groupList) {
      const count = domainStats.groupCounts?.[g.id] ?? 0;
      const tab = document.getElementById("groupTabTemplate").content.cloneNode(true).firstElementChild;
      tab.classList.toggle("active", g.id === state.currentGroupId);
      tab.dataset.groupId = g.id;
      tab.textContent = `${g.name} (${count})`;
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
    dialog.showDialog("分组管理", body);
    state.preventDialogClose = true;
    try {
      await this.#refreshGroupList();
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

  async #refreshGroupList() {
    await this.renderGroupTabs();
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
    container.querySelectorAll('.group-list-item[draggable="true"]').forEach((el) => {
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
    const items = dom.dialogBody.querySelectorAll(".group-list-item");
    const customIds = Array.from(items).map((el) => el.dataset.groupId);
    const defaultIds = ["all", "uncategorized"];
    await services.bgMsg({ type: "REORDER_GROUPS", domain: state.domain, groupIds: [...defaultIds, ...customIds] });
    store.refreshGroups();
  }

  #updateStorageIndicator(stats) {
    const el = dom.menuStorage;
    if (!el) return;
    const bytes = stats.bytes || 0;
    const pct = bytes / config.STORAGE_MAX_BYTES;
    const used = (bytes / 1024 / 1024).toFixed(pct > 0.1 ? 1 : 2);
    el.textContent = `${used} MB`;
  }

  #switchGroup(groupId) {
    state.selectedIds.clear();
    detail.closeDetail();
    // 滚动容器是 #mainGrid 自身（overflow-y:auto），window.scrollTo 不作用于它；
    // 清场 wipe 会 clamp 归零，这里显式复位保证语义正确
    dom.mainGrid.scrollTop = 0;
    store.set("batchMode", false);
    store.set("currentGroupId", groupId);
  }
}

export const groups = new Groups();
