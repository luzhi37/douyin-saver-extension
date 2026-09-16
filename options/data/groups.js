// ---------- Groups ----------
import { config, dom, state, services, store } from '../core.js';
import { dialog } from '../components/dialog.js';
import { detail } from '../components/detail.js';

// ---------- Groups ----------
class Groups {
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
    this.updateTabMask();
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
        if (!name) return;
        const res = await services.bgMsg({ type: "ADD_GROUP", domain: state.domain, name });
        if (res.ok) {
          input.value = "";
          await this.#refreshGroupList();
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
        dialog.showDialog("确认删除", delBody, [
          { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
          {
            text: "删除",
            danger: true,
            callback: async () => {
              dialog.updateDialog("正在删除…", "");
              state.preventDialogClose = true;
              try {
                await services.bgMsg({ type: "DELETE_GROUP", domain: state.domain, groupId: g.id });
                item.remove();
                store.refreshGroups();
                dom.dialogTitle.textContent = "删除完成";
                dom.dialogBody.innerHTML = `<p>已删除"${g.name}"</p>`;
                dialog.showOkDialog();
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
    window.scrollTo(0, 0);
    store.set("batchMode", false);
    store.set("currentGroupId", groupId);
  }
}

export const groups = new Groups();
