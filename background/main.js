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
import { storage } from "./data/storage.js";

// 作品型三域共用同一 handler 接口：按消息类型分派，避免 GET/DELETE/MOVE 三组 case 重复
const WORK_RECORD_HANDLERS = {
  GET_WORKS: worksHandlers,
  GET_FAVORITES: favoritesHandlers,
  GET_COLLECTIONS: collectionsHandlers,
  DELETE_WORKS: worksHandlers,
  DELETE_FAVORITES: favoritesHandlers,
  DELETE_COLLECTIONS: collectionsHandlers,
  MOVE_WORKS: worksHandlers,
  MOVE_FAVORITES: favoritesHandlers,
  MOVE_COLLECTIONS: collectionsHandlers,
};

// ---------- App ----------
// 初始化 + 消息路由（吸收原 route 内全部分支）
class App {
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

  // 双模路由样板：独立模式优先；两分支以闭包传入，保持各自调用参数不变
  #byMode(sendResponse, independentFn, tabFn) {
    return utils.asyncHandler(async () => {
      const im = await independentClient.loadMode();
      return im ? independentFn() : tabFn();
    }, sendResponse);
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

  // 路由保持同步函数：返回 true 表示稍后异步 sendResponse（与 chrome.runtime.onMessage 契约一致）
  route(message, sendResponse) {
    switch (message.type) {
      // 作品域
      case "SAVE_WORKS":
        return utils.asyncHandler(() => worksHandlers.save(message.works, sendResponse), sendResponse);
      // 作品型三域共用同一 handler 接口：按消息类型分派，避免 GET/DELETE/MOVE 三组 case 重复
      case "GET_WORKS":
      case "GET_FAVORITES":
      case "GET_COLLECTIONS":
        return utils.asyncHandler(
          () =>
            WORK_RECORD_HANDLERS[message.type].get(
              {
                groupId: message.groupId,
                page: message.page,
                cursor: message.cursor,
                ascending: message.ascending,
                sort: message.sort,
                direction: message.direction,
              },
              sendResponse,
            ),
          sendResponse,
        );
      case "DELETE_WORKS":
      case "DELETE_FAVORITES":
      case "DELETE_COLLECTIONS":
        return utils.asyncHandler(
          () => WORK_RECORD_HANDLERS[message.type].delete(message.awemeIds, sendResponse),
          sendResponse,
        );
      case "MOVE_WORKS":
      case "MOVE_FAVORITES":
      case "MOVE_COLLECTIONS":
        return utils.asyncHandler(
          () => WORK_RECORD_HANDLERS[message.type].move(message.awemeIds, message.targetGroupId, sendResponse),
          sendResponse,
        );
      // 作品型三域通用按 id 补拉（bulk STORE_CHANGED 收口的配套通道）：域由消息指定，
      // 无需逐域重复消息形态（GET_WORKS/GET_FAVORITES/GET_COLLECTIONS 的 keyset 分页不适用
      // 任意 id 集——主键直取即可）
      case "GET_WORKS_BY_IDS": {
        const handlers = {
          [CONFIG.STORAGE_KEYS.WORKS]: worksHandlers,
          [CONFIG.STORAGE_KEYS.FAVORITES]: favoritesHandlers,
          [CONFIG.STORAGE_KEYS.COLLECTIONS]: collectionsHandlers,
        }[message.domain];
        if (!handlers) {
          sendResponse({ error: "BAD_DOMAIN" });
          return true;
        }
        return utils.asyncHandler(() => handlers.getByIds(message.ids, sendResponse), sendResponse);
      }
      // 随机回顾抽样（五域通用）：只按主键抽样 + 主键批量取记录，不物化整域；
      // options 侧「回顾」页签用返回的 items 直接渲染随机卡片网格
      case "GET_RANDOM_RECORDS": {
        const handlers = {
          [CONFIG.STORAGE_KEYS.WORKS]: worksHandlers,
          [CONFIG.STORAGE_KEYS.FAVORITES]: favoritesHandlers,
          [CONFIG.STORAGE_KEYS.COLLECTIONS]: collectionsHandlers,
          [CONFIG.STORAGE_KEYS.FOLLOWINGS]: followingsHandlers,
          [CONFIG.STORAGE_KEYS.CANDIDATES]: candidatesHandlers,
        }[message.domain];
        if (!handlers) {
          sendResponse({ error: "BAD_DOMAIN" });
          return true;
        }
        return utils.asyncHandler(
          () =>
            handlers.pickRandom(
              { groupId: message.groupId, count: message.count, excludeIds: message.excludeIds },
              sendResponse,
            ),
          sendResponse,
        );
      }
      // 回顾域（真实域，只持久化批次引用）：
      case "GET_REVIEW":
        return utils.asyncHandler(() => reviewHandlers.get(message.groupId, sendResponse), sendResponse);
      case "SAVE_REVIEW_BATCH":
        return utils.asyncHandler(
          () =>
            reviewHandlers.saveBatch(
              message.sourceDomain,
              message.sourceIds,
              message.groupId,
              message.append === true,
              sendResponse,
            ),
          sendResponse,
        );
      case "DELETE_REVIEW":
        return utils.asyncHandler(
          () => reviewHandlers.deleteBySource(message.sourceDomain, message.sourceIds, sendResponse),
          sendResponse,
        );
      case "MOVE_REVIEW":
        return utils.asyncHandler(
          () =>
            reviewHandlers.moveBySource(
              message.sourceDomain,
              message.sourceIds,
              message.targetGroupId,
              sendResponse,
            ),
          sendResponse,
        );

      // 关注域
      case "SAVE_FOLLOWINGS":
        return utils.asyncHandler(() => followingsHandlers.save(message.followings, sendResponse), sendResponse);
      case "GET_FOLLOWINGS":
        return utils.asyncHandler(
          () => followingsHandlers.get({ groupId: message.groupId }, sendResponse),
          sendResponse,
        );
      case "DELETE_FOLLOWINGS":
        return utils.asyncHandler(() => followingsHandlers.delete(message.uids, sendResponse), sendResponse);
      case "MOVE_FOLLOWINGS":
        return utils.asyncHandler(
          () => followingsHandlers.move(message.uids, message.targetGroupId, sendResponse),
          sendResponse,
        );

      // 候选域（作者档案型，扩展自建）
      case "SAVE_CANDIDATES":
        return utils.asyncHandler(() => candidatesHandlers.save(message.candidates, sendResponse), sendResponse);
      case "GET_CANDIDATES":
        return utils.asyncHandler(
          () => candidatesHandlers.get({ groupId: message.groupId }, sendResponse),
          sendResponse,
        );
      case "DELETE_CANDIDATES":
        return utils.asyncHandler(() => candidatesHandlers.delete(message.uids, sendResponse), sendResponse);
      case "MOVE_CANDIDATES":
        return utils.asyncHandler(
          () => candidatesHandlers.move(message.uids, message.targetGroupId, sendResponse),
          sendResponse,
        );
      // 作者域成员资格主键集（作品卡作者状态 chip）：两域主键并行直取（keyPath=uid），
      // 不物化记录；供 options 建 Set 做 O(1) 判定
      case "GET_AUTHOR_UID_SETS":
        return utils.asyncHandler(async () => {
          const [followings, candidates] = await Promise.all([
            followingsHandlers.getAllKeys(),
            candidatesHandlers.getAllKeys(),
          ]);
          sendResponse({ ok: true, followings, candidates });
        }, sendResponse);
      // 按 uid 直取关注/候选两域作者档案（侧栏作者头跨域补头像/统计）：
      // 主键单条读取，不物化作者域全量
      case "GET_AUTHOR_BY_UID":
        return utils.asyncHandler(async () => {
          const uid = String(message.uid || "");
          if (!uid) return sendResponse({ error: "BAD_PARAMS" });
          const [following, candidate] = await Promise.all([
            storage.get(CONFIG.STORAGE_KEYS.FOLLOWINGS, uid),
            storage.get(CONFIG.STORAGE_KEYS.CANDIDATES, uid),
          ]);
          sendResponse({ ok: true, followings: following || null, candidates: candidate || null });
        }, sendResponse);
      // 单条记录状态（抖音标签页保存按钮角标）：作品域按 awemeId、候选域按 uid 主键直读，
      // 不物化整域；只返回存在性，不解析分组
      case "GET_RECORD_STATUS":
        return utils.asyncHandler(async () => {
          const awemeId = String(message.awemeId || "");
          const uid = String(message.uid || "");
          if (!awemeId && !uid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
          const [work, candidate] = await Promise.all([
            awemeId ? storage.get(CONFIG.STORAGE_KEYS.WORKS, awemeId) : null,
            uid ? storage.get(CONFIG.STORAGE_KEYS.CANDIDATES, uid) : null,
          ]);
          sendResponse({
            ok: true,
            work: { exists: !!work },
            author: { uid, candidate: !!candidate },
          });
        }, sendResponse);

      // 分组管理 (域感知)
      case "GET_GROUPS":
        return utils.asyncHandler(() => groups.get(message.domain, sendResponse), sendResponse);
      case "GET_DOMAIN_GROUPS":
        return utils.asyncHandler(() => groups.getWithStats(message.domain, sendResponse), sendResponse);
      case "ADD_GROUP":
        return utils.asyncHandler(() => groups.add(message.domain, message.name, sendResponse), sendResponse);
      case "RENAME_GROUP":
        return utils.asyncHandler(
          () => groups.rename(message.domain, message.groupId, message.newName, sendResponse),
          sendResponse,
        );
      case "DELETE_GROUP":
        return utils.asyncHandler(() => groups.delete(message.domain, message.groupId, sendResponse), sendResponse);
      case "REORDER_GROUPS":
        return utils.asyncHandler(() => groups.reorder(message.domain, message.groupIds, sendResponse), sendResponse);

      // 数据工具 (域感知)
      case "IMPORT_DATA":
        return utils.asyncHandler(
          () => dataTools.import(message.text, message.domain || CONFIG.STORAGE_KEYS.WORKS, sendResponse),
          sendResponse,
        );
      case "EXPORT_DATA":
        return utils.asyncHandler(() => dataTools.export(message.domain, sendResponse), sendResponse);
      case "RESET_DOMAIN":
        return utils.asyncHandler(() => dataTools.reset(message.domain, sendResponse), sendResponse);
      case "GET_STATS":
        return utils.asyncHandler(() => dataTools.getStats(sendResponse, message), sendResponse);

      // 独立模式 / Tab 转发
      case "FETCH_FOLLOWING":
        return this.#byMode(
          sendResponse,
          () => independentTasks.fetchFollowing(message.secUid, sendResponse),
          () => scanTasks.fetchFollowing(message.secUid, sendResponse),
        );
      case "CALIBRATE_FOLLOWING":
        return utils.asyncHandler(
          () => scanTasks.calibrateOne(message.uid, message.secUid, CONFIG.STORAGE_KEYS.FOLLOWINGS, sendResponse),
          sendResponse,
        );
      case "CALIBRATE_FOLLOWINGS":
        return utils.asyncHandler(
          () => scanTasks.calibrateAll(CONFIG.STORAGE_KEYS.FOLLOWINGS, sendResponse),
          sendResponse,
        );
      case "CALIBRATE_CANDIDATE":
        return utils.asyncHandler(
          () => scanTasks.calibrateOne(message.uid, message.secUid, CONFIG.STORAGE_KEYS.CANDIDATES, sendResponse),
          sendResponse,
        );
      case "CALIBRATE_CANDIDATES":
        return utils.asyncHandler(
          () => scanTasks.calibrateAll(CONFIG.STORAGE_KEYS.CANDIDATES, sendResponse),
          sendResponse,
        );
      case "FETCH_FAVORITES":
        return utils.asyncHandler(async () => {
          // 点赞列表无独立模式分支（favorite 端点 Turing 风控，见 docs/05）
          return scanTasks.fetchFavorites(message.secUid, message.persist, sendResponse);
        }, sendResponse);
      case "FETCH_COLLECTION":
        return this.#byMode(
          sendResponse,
          () => independentTasks.fetchCollection(message.persist, sendResponse),
          () => scanTasks.fetchCollection(message.persist, sendResponse),
        );
      case "SYNC_WORKS":
        return this.#byMode(
          sendResponse,
          () => independentTasks.syncWorks(message.awemeIds, sendResponse),
          () => scanTasks.syncWorks(message.awemeIds, sendResponse),
        );
      case "FETCH_WORKS_PAGE":
        return this.#byMode(
          sendResponse,
          () => independentTasks.fetchWorksPage(message.secUid, message.cursor || "", sendResponse),
          () => tabBridge.fetchWorksPage(message, sendResponse),
        );

      // 入库：作者作品 → 作品域（分页循环长任务）/ 作者档案 → 候选域（单请求短操作）
      case "IMPORT_USER_WORKS":
        return this.#byMode(
          sendResponse,
          () => independentTasks.importUserWorks(message.secUid, sendResponse),
          () => scanTasks.importUserWorks(message.secUid, sendResponse),
        );
      case "IMPORT_CANDIDATE":
        return utils.asyncHandler(() => scanTasks.importCandidate(message.secUid, sendResponse), sendResponse);
      // 工具弹窗 uid → 主页链接（双模只读查询，不落库）
      case "RESOLVE_USER_PROFILE":
        return utils.asyncHandler(() => scanTasks.resolveUserProfile(message.uid, sendResponse), sendResponse);
      case "CANCEL_FAVORITES":
        return utils.asyncHandler(async () => {
          // 点赞取消无独立模式分支（a_bogus 与 XHR 原型链深度绑定，SW 无法直连，见 docs/06）
          if (await independentClient.loadMode()) {
            return sendResponse({ ok: false, error: "UNSUPPORTED_INDEPENDENT" });
          }
          return scanTasks.runCancelBatch(message.awemeIds, "CANCEL_ONE_FAVORITES", "CANCEL_PROGRESS", message.domain, sendResponse);
        }, sendResponse);
      case "CANCEL_COLLECTION":
        return this.#byMode(
          sendResponse,
          () => independentTasks.cancel(message.awemeIds, message.domain, sendResponse),
          () => scanTasks.runCancelBatch(message.awemeIds, "CANCEL_ONE_COLLECTION", "CANCEL_PROGRESS", message.domain, sendResponse),
        );
      // 侧边栏作品卡：单作品点赞/收藏状态切换（active=true 添加并落库，false 取消并删本地）
      case "SET_FAVORITES":
        return utils.asyncHandler(async () => {
          if (!message.awemeId) return sendResponse({ ok: false, error: "EMPTY" });
          if (await independentClient.loadMode()) {
            return sendResponse({ ok: false, error: "UNSUPPORTED_INDEPENDENT" });
          }
          const remote = await tabBridge.sendAsync("SET_ONE_FAVORITES", this.#reactionMessage(message));
          await this.#applyReaction(favoritesHandlers, remote, message, sendResponse);
        }, sendResponse);
      case "SET_COLLECTION":
        return utils.asyncHandler(async () => {
          if (!message.awemeId) return sendResponse({ ok: false, error: "EMPTY" });
          const im = await independentClient.loadMode();
          const remote = im
            ? await independentTasks.setReaction(message.awemeId, message.active === true)
            : await tabBridge.sendAsync("SET_ONE_COLLECTION", this.#reactionMessage(message));
          await this.#applyReaction(collectionsHandlers, remote, message, sendResponse);
        }, sendResponse);
      case "GET_SECURITY_STATUS":
        tabBridge.getSecurityStatus(sendResponse);
        return true;

      // 存储 / 配置
      case "SET_MODE":
        return utils.asyncHandler(() => independentClient.setMode(message, sendResponse), sendResponse);
      case "CAPTURE_BROWSER_FEATURES":
        return utils.asyncHandler(() => credentials.captureBrowserFeatures(message, sendResponse), sendResponse);
      case "GET_COOKIE_INFO":
        return utils.asyncHandler(() => credentials.getCookieInfo(sendResponse), sendResponse);
      case "GET_BROWSER_FEATURES":
        return utils.asyncHandler(() => credentials.getBrowserFeatures(sendResponse), sendResponse);
      case "GET_CACHE_TIMES":
        return utils.asyncHandler(() => credentials.getCacheTimes(sendResponse), sendResponse);
      case "RESOLVE_SEC_UID":
        return utils.asyncHandler(async () => {
          const secUid = await independentClient.resolveSelfSecUid();
          sendResponse({ ok: !!secUid, secUid });
        }, sendResponse);
      case "REFRESH_MSTOKEN":
        return utils.asyncHandler(() => credentials.refreshMsToken(sendResponse), sendResponse);
      case "REFRESH_WEBID":
        return utils.asyncHandler(() => credentials.refreshWebId(sendResponse), sendResponse);
      case "REFRESH_BROWSER_FEATURES":
        return utils.asyncHandler(() => credentials.refreshBrowserFeatures(sendResponse), sendResponse);
      case "REFRESH_COOKIE":
        return utils.asyncHandler(() => credentials.refreshCookie(sendResponse), sendResponse);
      case "CANCEL_ACTIVE_TASK":
        tabBridge.cancelActiveTask(sendResponse);
        return true;
      case "RELOAD_CONFIG":
        return utils.asyncHandler(async () => {
          await runtimeConfig.reload();
          sendResponse({ ok: true });
        }, sendResponse);

      default:
        sendResponse({ error: `Unknown message type: ${message.type}` });
    }
  }
}
const app = new App();

// ---------- 启动 ----------
app.init();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => app.route(message, sendResponse));
