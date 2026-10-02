// ---------- DomainScanSync（点赞/收藏域同步） ----------
import { config, dom, services } from '../core.js';
import { sync } from './sync.js';
import { authorImport } from './author-import.js';
import { dialog } from '../components/dialog.js';
import { groups } from '../data/groups.js';

// ---------- 点赞/收藏域同步（DomainScanSync） ----------
// 与 Sync 的差异：扫描结果由 background 直接合并落库 + 丢失检测，本类只驱动进度弹窗与 UI 刷新
class DomainScanSync {
  #running = false;
  #domain = null;
  #countEl = null;
  #summaryEl = null;
  #statusEl = null;

  isRunning() {
    return this.#running;
  }

  async syncDomain(domain) {
    if (this.#running || sync.isRunning() || authorImport.isRunning()) return;
    if (!config.WORK_RECORD_DOMAINS.includes(domain) || domain === "works") return;

    // 独立模式不支持点赞列表拉取（favorite 端点 Turing 风控），收藏不受限
    if (domain === "favorites") {
      const { independentMode } = await chrome.storage.local.get("independentMode");
      if (independentMode) {
        dialog.showToast("独立模式不支持点赞操作，请在设置中切换 Tab 模式", "error");
        return;
      }
    }

    this.#running = true;
    this.#domain = domain;
    this.#openDialog(domain);

    chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});

    try {
      // 点赞列表仅 Tab 模式；收藏双模均通。persist 让 background 直接落库并做丢失检测
      const fetchType = domain === "favorites" ? "FETCH_FAVORITES" : "FETCH_COLLECTION";
      const res = await services.bgMsg({
        type: fetchType,
        persist: domain,
        ...(domain === "favorites" ? { secUid: await services.findSecUid() } : {}),
      });
      if (!this.#running) return; // 弹窗已关闭（取消）
      if (!res || !res.ok) throw new Error(res?.error || "FETCH_FAILED");

      await services.loadDomainData();
      await groups.renderGroupTabs();

      const saved = res.saved || { added: 0, updated: 0 };
      const lostUids = res.lostUids || [];
      this.#setSummary(`新增 ${saved.added} · 更新 ${saved.updated}${lostUids.length > 0 ? ` · 已取消 ${lostUids.length} 个` : ""}`);
      if (this.#statusEl) this.#statusEl.textContent = res.timedOut ? "PARTIAL" : "DONE";

      if (res.timedOut && dom.dialogBody.querySelector(".sync-timeout-hint") === null) {
        const hint = document.createElement("p");
        hint.className = "dy-text-danger sync-timeout-hint";
        hint.textContent = "已中途取消，仅保留部分数据";
        dom.dialogBody.appendChild(hint);
      }
      if (lostUids.length > 0) {
        dialog.addTrashButton(() => this.moveLostToTrash(domain, lostUids), () => this.closeDialog());
      }
    } catch (err) {
      if (!this.#running) return;
      const msg = err.message || String(err);
      if (msg.includes("NO_SIGNATURE")) {
        this.closeDialog();
        const url = config.URL_USER_SELF + (domain === "favorites" ? config.URL_FAVORITE_TAB : config.URL_COLLECTION_TAB);
        dialog.showNoSignatureDialog(url, config.DOMAINS_META[domain].label, `同步${config.DOMAINS_META[domain].label}列表`);
        return;
      }
      this.#setSummary("");
      if (this.#statusEl) this.#statusEl.textContent = msg;
    } finally {
      this.#running = false;
      this.#domain = null;
    }
  }

  #openDialog(domain) {
    const label = config.DOMAINS_META[domain].label;
    const tmpl = document.getElementById("syncDialogBodyTemplate");
    const body = tmpl.content.cloneNode(true);
    this.#countEl = body.querySelector(".sync-count");
    this.#summaryEl = body.querySelector(".sync-summary");
    this.#statusEl = body.querySelector(".sync-status");
    this.#countEl.textContent = `已扫描作品 0`;
    this.#summaryEl.textContent = `正在获取${label}…`;
    this.#statusEl.textContent = "SYNCING";
    dialog.showDialog(`同步${label}`, body, [], () => this.closeDialog());
  }

  closeDialog() {
    dialog.closeDialog();
    this.#running = false;
    this.#domain = null;
  }

  // 进度消息入口（options 全局 listener 分发）；三链路互斥保证不串线，按 #running 门控全收
  onScanProgress(msg) {
    if (!this.#running) return;
    if (msg.type === "FAVORITES_PROGRESS" || msg.type === "COLLECTION_PROGRESS") {
      if (this.#countEl) this.#countEl.textContent = `已扫描作品 ${msg.collected}`;
    }
  }

  #setSummary(text) {
    if (this.#summaryEl) this.#summaryEl.textContent = text || "";
  }

  // 丢失条目移入本域「稍后删除」分组（分组按需创建，与关注域 moveLostFollowings 同款）
  async moveLostToTrash(domain, lostIds) {
    return services.moveToTrashGroup(domain, lostIds, (gid) => services.moveWorkRecord(domain, lostIds, gid));
  }
}

export const domainScanSync = new DomainScanSync();
