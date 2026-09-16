// background/main.js — 组合根 + 入口：App 类 + 实例化 + 启动（init / onMessage 监听）

import { CONFIG, utils, runtimeConfig } from "./core.js";
import { credentials } from "./identity/credentials.js";
import { independentClient } from "./identity/independent-client.js";
import { tabBridge } from "./identity/tab-bridge.js";
import { worksHandlers, followingsHandlers, likesHandlers, favoritesHandlers } from "./data/domain-handlers.js";
import { groups } from "./data/groups.js";
import { dataTools } from "./data/data-tools.js";
import { scanTasks } from "./tasks/scan-tasks.js";
import { independentTasks } from "./tasks/independent-tasks.js";
import { storage } from "./data/storage.js";

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

      const worksGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS);
      if (!worksGroups.length) {
        await storage.putGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS, CONFIG.DEFAULT_GROUPS);
      }

      const followingsGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS);
      if (!followingsGroups.length) {
        await storage.putGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS, CONFIG.DEFAULT_GROUPS);
      }

      const likesGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.LIKES_GROUPS);
      if (!likesGroups.length) {
        await storage.putGroups(CONFIG.STORAGE_KEYS.LIKES_GROUPS, CONFIG.DEFAULT_GROUPS);
      }

      const favoritesGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.FAVORITES_GROUPS);
      if (!favoritesGroups.length) {
        await storage.putGroups(CONFIG.STORAGE_KEYS.FAVORITES_GROUPS, CONFIG.DEFAULT_GROUPS);
      }
    } catch (e) {
      console.warn("[DY] onInstalled partial failure:", e.message);
    }
  }

  init() {
    chrome.runtime.onInstalled.addListener(async () => {
      await this.onInstalled();
    });

    if (chrome.runtime.onStartup) {
      chrome.runtime.onStartup.addListener(() => this.setupDeclarativeNetRequest());
    }

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
    // 会静默失效（校准开关另有 isCalibrateEnabled 惰性加载兜底，两者幂等无冲突）。
    // 监听器已在上方同步注册，reload 在事件送达前完成，不阻塞消息路由。
    runtimeConfig.reload().catch((e) => console.warn("[DY] runtimeConfig reload failed:", e.message));
  }

  // 路由保持同步函数：返回 true 表示稍后异步 sendResponse（与 chrome.runtime.onMessage 契约一致）
  route(message, sendResponse) {
    switch (message.type) {
      // 作品域
      case "SAVE_WORKS":
        return utils.asyncHandler(() => worksHandlers.save(message.works, sendResponse), sendResponse);
      case "GET_WORKS":
        return utils.asyncHandler(() => worksHandlers.get(message.groupId, sendResponse), sendResponse);
      case "DELETE_WORKS":
        return utils.asyncHandler(() => worksHandlers.delete(message.awemeIds, sendResponse), sendResponse);
      case "MOVE_WORKS":
        return utils.asyncHandler(
          () => worksHandlers.move(message.awemeIds, message.targetGroupId, sendResponse),
          sendResponse,
        );
      case "GET_WORK":
        return utils.asyncHandler(() => worksHandlers.getOne(message.awemeId, sendResponse), sendResponse);

      // 点赞域
      case "GET_LIKES":
        return utils.asyncHandler(() => likesHandlers.get(message.groupId, sendResponse), sendResponse);
      case "DELETE_LIKES":
        return utils.asyncHandler(() => likesHandlers.delete(message.awemeIds, sendResponse), sendResponse);
      case "MOVE_LIKES":
        return utils.asyncHandler(
          () => likesHandlers.move(message.awemeIds, message.targetGroupId, sendResponse),
          sendResponse,
        );

      // 收藏域
      case "GET_FAVORITES":
        return utils.asyncHandler(() => favoritesHandlers.get(message.groupId, sendResponse), sendResponse);
      case "DELETE_FAVORITES":
        return utils.asyncHandler(() => favoritesHandlers.delete(message.awemeIds, sendResponse), sendResponse);
      case "MOVE_FAVORITES":
        return utils.asyncHandler(
          () => favoritesHandlers.move(message.awemeIds, message.targetGroupId, sendResponse),
          sendResponse,
        );

      // 关注域
      case "SAVE_FOLLOWINGS":
        return utils.asyncHandler(() => followingsHandlers.save(message.followings, sendResponse), sendResponse);
      case "GET_FOLLOWINGS":
        return utils.asyncHandler(() => followingsHandlers.get(message.groupId, sendResponse), sendResponse);
      case "DELETE_FOLLOWINGS":
        return utils.asyncHandler(() => followingsHandlers.delete(message.uids, sendResponse), sendResponse);
      case "MOVE_FOLLOWINGS":
        return utils.asyncHandler(
          () => followingsHandlers.move(message.uids, message.targetGroupId, sendResponse),
          sendResponse,
        );

      // 分组管理 (域感知)
      case "GET_GROUPS":
        return utils.asyncHandler(() => groups.get(message.domain, sendResponse), sendResponse);
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
          () => dataTools.import(message.data, message.domain || CONFIG.STORAGE_KEYS.WORKS, sendResponse),
          sendResponse,
        );
      case "EXPORT_DATA":
        return utils.asyncHandler(() => dataTools.export(message.domain, sendResponse), sendResponse);
      case "RESET_DOMAIN":
        return utils.asyncHandler(() => dataTools.reset(message.domain, sendResponse), sendResponse);
      case "GET_STATS":
        return utils.asyncHandler(() => dataTools.getStats(sendResponse), sendResponse);

      // 独立模式 / Tab 转发
      case "FETCH_FOLLOWING":
        return utils.asyncHandler(async () => {
          const im = await independentClient.loadMode();
          if (im) return independentTasks.fetchFollowing(message.secUid, sendResponse);
          return scanTasks.fetchFollowing(message.secUid, sendResponse);
        }, sendResponse);
      case "CALIBRATE_FOLLOWING":
        return utils.asyncHandler(() => scanTasks.calibrateOne(message.uid, message.secUid, sendResponse), sendResponse);
      case "FETCH_FAVORITES":
        return utils.asyncHandler(async () => {
          // 点赞列表无独立模式分支（favorite 端点 Turing 风控，见 docs/05）
          return scanTasks.fetchFavorites(message.secUid, message.persist, sendResponse);
        }, sendResponse);
      case "FETCH_COLLECTION":
        return utils.asyncHandler(async () => {
          const im = await independentClient.loadMode();
          if (im) return independentTasks.fetchCollection(message.persist, sendResponse);
          return scanTasks.fetchCollection(message.persist, sendResponse);
        }, sendResponse);
      case "SYNC_WORKS":
        return utils.asyncHandler(async () => {
          const im = await independentClient.loadMode();
          if (im) return independentTasks.syncWorks(message.awemeIds, sendResponse);
          return scanTasks.syncWorks(message.awemeIds, sendResponse);
        }, sendResponse);
      case "FETCH_WORKS_PAGE":
        return utils.asyncHandler(async () => {
          const im = await independentClient.loadMode();
          if (im) return independentTasks.fetchWorksPage(message.secUid, message.cursor || "", sendResponse);
          return tabBridge.fetchWorksPage(message, sendResponse);
        }, sendResponse);
      case "CANCEL_LIKE":
        return utils.asyncHandler(async () => {
          // 点赞取消无独立模式分支（a_bogus 与 XHR 原型链深度绑定，SW 无法直连，见 docs/06）
          if (await independentClient.loadMode()) {
            return sendResponse({ ok: false, error: "UNSUPPORTED_INDEPENDENT" });
          }
          return scanTasks.runCancelBatch(message.awemeIds, "CANCEL_ONE_LIKE", "CANCEL_PROGRESS", message.domain, sendResponse);
        }, sendResponse);
      case "CANCEL_COLLECTION":
        return utils.asyncHandler(async () => {
          const im = await independentClient.loadMode();
          if (im) return independentTasks.cancel(message.awemeIds, "collection", message.domain, sendResponse);
          return scanTasks.runCancelBatch(message.awemeIds, "CANCEL_ONE_COLLECTION", "CANCEL_PROGRESS", message.domain, sendResponse);
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
