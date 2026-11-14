// background/main.js — 组合根 + 入口：App 类 + 实例化 + 启动（init / onMessage 监听）

import { CONFIG, DOMAIN_CONFIG, utils, runtimeConfig } from "./core.js";
import { credentials } from "./identity/credentials.js";
import { independentClient } from "./identity/independent-client.js";
import { tabBridge } from "./identity/tab-bridge.js";
import { worksHandlers, followingsHandlers, favoritesHandlers, collectionsHandlers, candidatesHandlers } from "./data/domain-handlers.js";
import { reviewHandlers } from "./data/review-handlers.js";
import { groups } from "./data/groups.js";
import { dataTools } from "./data/data-tools.js";
import { scanTasks } from "./tasks/scan-tasks.js";
import { independentTasks } from "./tasks/independent-tasks.js";
import { taskRegistry, PORT_NAME } from "./tasks/task-registry.js";
import { storage } from "./data/storage.js";

// 作品型三域 GET 的公共分页参数（消息载荷投影，字段名与 GET_* 协议一致）
const pagingOf = (m) => ({
  groupId: m.groupId,
  page: m.page,
  cursor: m.cursor,
  ascending: m.ascending,
  sort: m.sort,
  direction: m.direction,
});

// ---------- App ----------
// 初始化 + 消息路由（吸收原 route 内全部分支）
class App {
  #routes = null;

  constructor() {
    this.#routes = this.#createRoutes();
  }

  async setupDeclarativeNetRequest() {
    const rules = CONFIG.DNR_RULES;

    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const existingIds = existing.map((r) => r.id);
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        addRules: rules,
      });
    } catch (e) {
      console.warn("[DY-Manager] DNR setup failed:", e.message);
    }
  }

  async onInstalled() {
    try {
      await this.setupDeclarativeNetRequest();
      await independentClient.loadMode();
      await runtimeConfig.reload();

      // 各域分组播种：缺组时写入默认组（各域同构，键集中在 DOMAIN_CONFIG；新增域自动纳入）
      for (const cfg of Object.values(DOMAIN_CONFIG)) {
        const groups = await storage.getGroups(cfg.groupsName);
        if (!groups.length) await storage.putGroups(cfg.groupsName, CONFIG.DEFAULT_GROUPS);
      }
    } catch (e) {
      console.warn("[DY] onInstalled partial failure:", e.message);
    }
  }

  init() {
    chrome.runtime.onInstalled.addListener(async () => {
      await this.onInstalled();
    });

    chrome.runtime.onStartup.addListener(() => this.setupDeclarativeNetRequest());

    // 发起页控制端口：任务寿命 = 页面寿命，port 断开即取消（关页/刷新/SW 回收）
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === PORT_NAME) taskRegistry.bindPort(port);
    });

    chrome.action.onClicked.addListener(() => {
      const url = chrome.runtime.getURL("options/options.html");
      chrome.tabs.query({ url }, (tabs) => {
        if (tabs && tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, { active: true });
        } else {
          chrome.tabs.create({ url });
        }
      });
    });

    // SW 冷启动恢复运行参数：reload 此前仅挂在 onInstalled（装/更新）上，重开扩展
    // 时新 SW 实例按编译期默认值重建 CONFIG，面板已保存的时延/超时/批量/重试参数
    // 会静默失效。这里异步启动、不阻塞消息路由；极早期到达的消息仍可能读到编译期
    // 默认值，reload 完成后即恢复。
    runtimeConfig.reload().catch((e) => console.warn("[DY] runtimeConfig reload failed:", e.message));
  }

  // 双模路由样板：独立模式优先；两分支以闭包传入，保持各自调用参数不变。
  // 只返回 Promise，异常由 route() 统一兜底（不再内部包 asyncHandler）。
  async #byMode(independentFn, tabFn) {
    const im = await independentClient.loadMode();
    return im ? independentFn() : tabFn();
  }

  // 侧边栏作品卡点赞/收藏状态切换：远端设置成功后才落库（active=true，mergeAndSave
  // 自动补分组/时间戳并广播）或删本地（false），失败保持原状。点赞无独立模式分支，
  // 由路由层拒绝（a_bogus 与 XHR 原型链绑定，见 docs/06）
  async #applyReaction(handlers, remote, message, sendResponse) {
    if (!remote?.ok) return sendResponse({ ok: false, error: remote?.error || "FAILED" });
    if (!message.active) return handlers.delete([message.awemeId], sendResponse);
    if (!message.work || !message.work.awemeId) return sendResponse({ ok: false, error: "NO_WORK" });
    return handlers.save([message.work], sendResponse);
  }

  #reactionMessage(message) {
    return { awemeId: message.awemeId, active: message.active === true, timeout: CONFIG.TIMEOUT.REQUEST };
  }

  // 路由表：消息名 → 处理器(message, sendResponse)。消息名保持字面量，便于 grep；
  // 处理器可同步/异步，统一由 route() 包 asyncHandler（异常收口点只剩一处）。
  #createRoutes() {
    return {
      // —— 作品型三域 ——
      SAVE_WORKS: (m, r) => worksHandlers.save(m.works, r),
      GET_WORKS: (m, r) => worksHandlers.get(pagingOf(m), r),
      GET_FAVORITES: (m, r) => favoritesHandlers.get(pagingOf(m), r),
      GET_COLLECTIONS: (m, r) => collectionsHandlers.get(pagingOf(m), r),
      DELETE_WORKS: (m, r) => worksHandlers.delete(m.awemeIds, r),
      DELETE_FAVORITES: (m, r) => favoritesHandlers.delete(m.awemeIds, r),
      DELETE_COLLECTIONS: (m, r) => collectionsHandlers.delete(m.awemeIds, r),
      MOVE_WORKS: (m, r) => worksHandlers.move(m.awemeIds, m.targetGroupId, r),
      MOVE_FAVORITES: (m, r) => favoritesHandlers.move(m.awemeIds, m.targetGroupId, r),
      MOVE_COLLECTIONS: (m, r) => collectionsHandlers.move(m.awemeIds, m.targetGroupId, r),
      // 按 id 集补拉（bulk STORE_CHANGED 收口）：域由消息指定，主键直取，不分页
      GET_WORKS_BY_IDS: async (m, r) => {
        const handlers = {
          [CONFIG.STORAGE_KEYS.WORKS]: worksHandlers,
          [CONFIG.STORAGE_KEYS.FAVORITES]: favoritesHandlers,
          [CONFIG.STORAGE_KEYS.COLLECTIONS]: collectionsHandlers,
        }[m.domain];
        if (!handlers) return r({ error: "BAD_DOMAIN" });
        return handlers.getByIds(m.ids, r);
      },
      // 随机回顾抽样（五域通用）：只按主键抽样 + 主键批量取记录，不物化整域
      GET_RANDOM_RECORDS: async (m, r) => {
        const handlers = {
          [CONFIG.STORAGE_KEYS.WORKS]: worksHandlers,
          [CONFIG.STORAGE_KEYS.FAVORITES]: favoritesHandlers,
          [CONFIG.STORAGE_KEYS.COLLECTIONS]: collectionsHandlers,
          [CONFIG.STORAGE_KEYS.FOLLOWINGS]: followingsHandlers,
          [CONFIG.STORAGE_KEYS.CANDIDATES]: candidatesHandlers,
        }[m.domain];
        if (!handlers) return r({ error: "BAD_DOMAIN" });
        return handlers.pickRandom({ groupId: m.groupId, count: m.count, excludeIds: m.excludeIds }, r);
      },

      // —— 回顾域（只持久化批次引用）——
      GET_REVIEW: (m, r) => reviewHandlers.get(m.groupId, r),
      SAVE_REVIEW_BATCH: (m, r) => reviewHandlers.saveBatch(m.sourceDomain, m.sourceIds, m.groupId, r),
      DELETE_REVIEW: (m, r) => reviewHandlers.deleteBySource(m.sourceDomain, m.sourceIds, r),
      MOVE_REVIEW: (m, r) => reviewHandlers.moveBySource(m.sourceDomain, m.sourceIds, m.targetGroupId, r),

      // —— 授权域：关注（账号原生镜像）/ 候选（扩展自建池）——
      // 关注域无 SAVE_*：扫描落库由 background createScanWriter 承接（options 侧无发送方）
      GET_FOLLOWINGS: (m, r) => followingsHandlers.get({ groupId: m.groupId }, r),
      DELETE_FOLLOWINGS: (m, r) => followingsHandlers.delete(m.uids, r),
      MOVE_FOLLOWINGS: (m, r) => followingsHandlers.move(m.uids, m.targetGroupId, r),
      SAVE_CANDIDATES: (m, r) => candidatesHandlers.save(m.candidates, r),
      GET_CANDIDATES: (m, r) => candidatesHandlers.get({ groupId: m.groupId }, r),
      DELETE_CANDIDATES: (m, r) => candidatesHandlers.delete(m.uids, r),
      MOVE_CANDIDATES: (m, r) => candidatesHandlers.move(m.uids, m.targetGroupId, r),
      // 作者域成员资格主键集：两域主键并行直取（keyPath=uid），不物化记录
      GET_AUTHOR_UID_SETS: async (m, r) => {
        const [followings, candidates] = await Promise.all([
          followingsHandlers.getAllKeys(),
          candidatesHandlers.getAllKeys(),
        ]);
        r({ ok: true, followings, candidates });
      },
      // 按 uid 直取关注/候选作者档案（侧栏作者头跨域补头像/统计）
      GET_AUTHOR_BY_UID: async (m, r) => {
        const uid = String(m.uid || "");
        if (!uid) return r({ error: "BAD_PARAMS" });
        const [following, candidate] = await Promise.all([
          storage.get(CONFIG.STORAGE_KEYS.FOLLOWINGS, uid),
          storage.get(CONFIG.STORAGE_KEYS.CANDIDATES, uid),
        ]);
        r({ ok: true, followings: following || null, candidates: candidate || null });
      },
      // 单条记录状态（抖音标签页保存按钮角标）：主键直读，只回存在性
      GET_RECORD_STATUS: async (m, r) => {
        const awemeId = String(m.awemeId || "");
        const uid = String(m.uid || "");
        if (!awemeId && !uid) return r({ ok: false, error: "BAD_PARAMS" });
        const [work, candidate] = await Promise.all([
          awemeId ? storage.get(CONFIG.STORAGE_KEYS.WORKS, awemeId) : null,
          uid ? storage.get(CONFIG.STORAGE_KEYS.CANDIDATES, uid) : null,
        ]);
        r({ ok: true, work: { exists: !!work }, author: { uid, candidate: !!candidate } });
      },

      // —— 分组管理（域感知）——
      GET_GROUPS: (m, r) => groups.get(m.domain, r),
      GET_DOMAIN_GROUPS: (m, r) => groups.getWithStats(m.domain, r),
      ADD_GROUP: (m, r) => groups.add(m.domain, m.name, r),
      RENAME_GROUP: (m, r) => groups.rename(m.domain, m.groupId, m.newName, r),
      DELETE_GROUP: (m, r) => groups.delete(m.domain, m.groupId, r),
      REORDER_GROUPS: (m, r) => groups.reorder(m.domain, m.groupIds, r),

      // —— 数据工具（域感知）——
      // 整域导入/重置与同域同步任务互斥：两者都是整批读改写，并发会让导入的旧快照
      // 覆盖刚刷新的直链、或让重置后的域被 checkpoint 半复活
      IMPORT_DATA: (m, r) => {
        const domain = m.domain || CONFIG.STORAGE_KEYS.WORKS;
        if (taskRegistry.isBusy(domain)) return r({ ok: false, error: "BUSY" });
        if (m.transfer) return dataTools.importChunk(m, r); // 大文件分块上行，末块拼回走 import()
        return dataTools.import(m.text, domain, r, m.taskId); // taskId 透传：options 预建坞行
      },
      // 导出会话式分块拉取：EXPORT_DATA 建会话（键快照 + header/footer），EXPORT_CHUNK
      // 逐块拉文本。导出纯只读，不参与 BUSY 互斥（与导入/重置的整批读改写不同）
      EXPORT_DATA: (m, r) => dataTools.exportStart(m.domain, r),
      EXPORT_CHUNK: (m, r) => dataTools.exportChunk(m, r),
      RESET_DOMAIN: (m, r) => {
        if (taskRegistry.isBusy(m.domain)) return r({ ok: false, error: "BUSY" });
        return dataTools.reset(m.domain, r);
      },
      GET_STATS: (m, r) => dataTools.getStats(r, m),

      // —— 扫描 / 校准 / 双模长任务 ——
      FETCH_FOLLOWING: (m, r) =>
        this.#byMode(() => independentTasks.fetchFollowing(m.secUid, r, m.taskId), () => scanTasks.fetchFollowing(m.secUid, r, m.taskId)),
      CALIBRATE_FOLLOWING: (m, r) => scanTasks.calibrateOne(m.uid, m.secUid, CONFIG.STORAGE_KEYS.FOLLOWINGS, r),
      CALIBRATE_FOLLOWINGS: (m, r) => scanTasks.calibrateAll(CONFIG.STORAGE_KEYS.FOLLOWINGS, r, m.taskId),
      CALIBRATE_CANDIDATE: (m, r) => scanTasks.calibrateOne(m.uid, m.secUid, CONFIG.STORAGE_KEYS.CANDIDATES, r),
      CALIBRATE_CANDIDATES: (m, r) => scanTasks.calibrateAll(CONFIG.STORAGE_KEYS.CANDIDATES, r, m.taskId),
      // 点赞列表无独立模式分支（favorite 端点 Turing 风控，见 docs/05）
      FETCH_FAVORITES: (m, r) => scanTasks.fetchFavorites(m.secUid, m.persist, r, m.taskId),
      FETCH_COLLECTION: (m, r) =>
        this.#byMode(() => independentTasks.fetchCollection(m.persist, r, m.taskId), () => scanTasks.fetchCollection(m.persist, r, m.taskId)),
      SYNC_WORKS: (m, r) =>
        this.#byMode(
          () => independentTasks.syncWorks(m.awemeIds, r, m.taskId),
          () => scanTasks.syncWorks(m.awemeIds, r, m.taskId),
        ),
      FETCH_WORKS_PAGE: (m, r) =>
        this.#byMode(
          () => independentTasks.fetchWorksPage(m.secUid, m.cursor || "", r),
          () => tabBridge.fetchWorksPage(m, r),
        ),
      IMPORT_USER_WORKS: (m, r) =>
        this.#byMode(() => independentTasks.importUserWorks(m.secUid, r, m.taskId), () => scanTasks.importUserWorks(m.secUid, r, m.taskId)),
      IMPORT_CANDIDATE: (m, r) => scanTasks.importCandidate(m.secUid, r),
      RESOLVE_USER_PROFILE: (m, r) => scanTasks.resolveUserProfile(m.uid, r),
      RESOLVE_AUTHOR_STATS: (m, r) => scanTasks.resolveAuthorStats(m.secUid, r),
      // 点赞取消无独立模式分支（a_bogus 与 XHR 原型链深度绑定，见 docs/06）
      CANCEL_FAVORITES: async (m, r) => {
        if (await independentClient.loadMode()) return r({ ok: false, error: "UNSUPPORTED_INDEPENDENT" });
        return scanTasks.runCancelBatch(m.awemeIds, "CANCEL_ONE_FAVORITES", m.domain, r, m.taskId);
      },
      CANCEL_COLLECTION: (m, r) =>
        this.#byMode(
          () => independentTasks.cancel(m.awemeIds, m.domain, r, m.taskId),
          () => scanTasks.runCancelBatch(m.awemeIds, "CANCEL_ONE_COLLECTION", m.domain, r, m.taskId),
        ),

      // —— 侧栏单条反应：远端成功后落库/删本地，失败保持原状 ——
      SET_FAVORITES: async (m, r) => {
        if (!m.awemeId) return r({ ok: false, error: "EMPTY" });
        if (await independentClient.loadMode()) return r({ ok: false, error: "UNSUPPORTED_INDEPENDENT" });
        const remote = await tabBridge.sendAsync("SET_ONE_FAVORITES", this.#reactionMessage(m));
        await this.#applyReaction(favoritesHandlers, remote, m, r);
      },
      SET_COLLECTION: async (m, r) => {
        if (!m.awemeId) return r({ ok: false, error: "EMPTY" });
        const im = await independentClient.loadMode();
        const remote = im
          ? await independentTasks.setReaction(m.awemeId, m.active === true)
          : await tabBridge.sendAsync("SET_ONE_COLLECTION", this.#reactionMessage(m));
        await this.#applyReaction(collectionsHandlers, remote, m, r);
      },

      // —— 凭据 / 配置 / 同步应答 ——
      GET_SECURITY_STATUS: (m, r) => {
        tabBridge.getSecurityStatus(r);
      },
      // 模式开关是全局行为：队列（含 queued/paused）里的任务启动时按当前模式分流，
      // 切换会让队列语义失真；只要有未终态任务就拒绝，等队列清空再切
      SET_MODE: (m, r) => {
        if (taskRegistry.hasPending()) return r({ ok: false, error: "BUSY" });
        return independentClient.setMode(m, r);
      },
      CAPTURE_BROWSER_FEATURES: (m, r) => credentials.captureBrowserFeatures(m, r),
      GET_COOKIE_INFO: (m, r) => credentials.getCookieInfo(r),
      GET_BROWSER_FEATURES: (m, r) => credentials.getBrowserFeatures(r),
      GET_CACHE_TIMES: (m, r) => credentials.getCacheTimes(r),
      RESOLVE_SEC_UID: async (m, r) => {
        const secUid = await independentClient.resolveSelfSecUid();
        r({ ok: !!secUid, secUid });
      },
      REFRESH_MSTOKEN: (m, r) => credentials.refreshMsToken(r),
      REFRESH_WEBID: (m, r) => credentials.refreshWebId(r),
      REFRESH_BROWSER_FEATURES: (m, r) => credentials.refreshBrowserFeatures(r),
      REFRESH_COOKIE: (m, r) => credentials.refreshCookie(r),
      CANCEL_TASK: (m, r) => {
        const task = taskRegistry.get(m.taskId);
        const ok = taskRegistry.cancel(m.taskId);
        // 仅取消「正在执行循环体」的 Tab 任务时转发页面侧中断（queued/paused 无在途请求）；
        // 页面侧中断无 taskId，多任务并存会误杀，故保持单一 active
        if (ok && task && task.mode === "tab" && task.status === "running") {
          tabBridge.cancelActiveTask(() => {});
        }
        r({ ok });
      },
      PAUSE_TASK: (m, r) => r({ ok: taskRegistry.pause(m.taskId) }),
      RESUME_TASK: (m, r) => r({ ok: taskRegistry.resume(m.taskId) }),
      GET_TASK_STATE: (m, r) => {
        // 只读观察页接管进度展示：只消费非终态快照（busy/activeId 无消费方，
        // 域级闸门走 taskRegistry.isBusy 直查）
        r({ tasks: taskRegistry.snapshot() });
      },
      // 长任务只认 CANCEL_TASK；页面侧中断由其转发（tabBridge.cancelActiveTask），
      // SW 路由不再处理 CANCEL_ACTIVE_TASK——options 侧发送点已随 B6 迁移移除
      RELOAD_CONFIG: async (m, r) => {
        await runtimeConfig.reload();
        r({ ok: true });
      },
    };
  }

  route(message, sendResponse) {
    // B6 任务队列：启动类消息不再 BUSY 拒绝，一律入队排队（全局单任务由
    // TaskRegistry 的单一 active 保证；队满由 start 返回 null 回 QUEUE_FULL，
    // 域互斥闸门——导入/重置/模式切换——仍回 BUSY）
    const handler = this.#routes[message.type];
    if (!handler) {
      sendResponse({ error: "Unknown message type: " + message.type });
      return;
    }
    // async 包裹保证处理器无论同步/异步都返回 Promise（asyncHandler 依赖 .catch）
    return utils.asyncHandler(async () => handler(message, sendResponse), sendResponse);
  }
}

const app = new App();

// ---------- 启动 ----------
app.init();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => app.route(message, sendResponse));
