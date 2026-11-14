// ---------- DomainScanSync（点赞/收藏域同步） ----------
import { config, services } from '../core.js';
import { dialog } from '../components/dialog.js';
import { taskDock } from '../components/task-dock.js';

// ---------- 点赞/收藏域同步（DomainScanSync） ----------
// 扫描结果由 background 直接合并落库 + 丢失检测；本类只负责登记任务坞、收口后置处理。
class DomainScanSync {
  // 从点击到登记期间的防重入（isIndependentMode/findSecUid 为异步，双击窗口内不重复排队）
  #starting = false;

  async syncDomain(domain) {
    // B6 队列：同域去重（扫描进行中/暂停中不再重复排队），跨域任务正常入队
    if (this.#starting || taskDock.isDomainBusy(domain)) {
      taskDock.expand();
      return;
    }

    this.#starting = true;
    try {
      // 独立模式不支持点赞列表拉取（favorite 端点 Turing 风控），收藏不受限
      if (domain === "favorites" && (await services.isIndependentMode())) {
        dialog.showToast("独立模式不支持点赞操作，请在设置中切换 Tab 模式", "error");
        return;
      }
      // favorites 的 secUid 在载荷构造内条件解析（独立模式守卫之后）
      await taskDock.launchRemote({
        begin: {
          kind: domain === "favorites" ? "scanFavorites" : "scanCollections",
          domain,
          total: 0,
          hint: config.DOMAINS_META[domain].label,
          onTrash: (ids) => this.moveLostToTrash(domain, ids),
          onDone: (msg) => this.#onDone(domain, msg),
        },
        payload: async () => ({
          type: domain === "favorites" ? "FETCH_FAVORITES" : "FETCH_COLLECTION",
          persist: domain,
          ...(domain === "favorites" ? { secUid: await services.findSecUid() } : {}),
        }),
      });
    } catch (err) {
      dialog.showToast(`同步失败：${err.message || String(err)}`, "error");
    } finally {
      this.#starting = false;
    }
  }

  // 终态后置处理：网格/分组刷新由 background 的 STORE_CHANGED（changed>0）统一承担，
  // 这里只做必须弹窗的 NO_SIGNATURE 引导（坞内不承载）。
  #onDone(domain, msg) {
    if (msg.error !== "NO_SIGNATURE") return;
    const url = config.URL_USER_SELF + (domain === "favorites" ? config.URL_FAVORITE_TAB : config.URL_COLLECTION_TAB);
    dialog.showNoSignatureDialog(url, config.DOMAINS_META[domain].label, `同步${config.DOMAINS_META[domain].label}列表`);
  }

  // 丢失条目移入本域「稍后删除」分组（分组按需创建，与关注域 moveLostFollowings 同款）
  async moveLostToTrash(domain, lostIds) {
    return services.moveToTrashGroup(domain, lostIds, (gid) => services.moveWorkRecord(domain, lostIds, gid));
  }
}

export const domainScanSync = new DomainScanSync();
