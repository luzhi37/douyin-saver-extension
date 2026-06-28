import { storage } from "./storage.js";

// ===== 抖音数据管理 - Background Service Worker =====

const CONFIG = {
  STORAGE_KEYS: {
    WORKS: "works",
    WORKS_GROUPS: "works_groups",
    FOLLOWINGS: "followings",
    FOLLOWINGS_GROUPS: "followings_groups",
  },
  DEFAULT_WORKS_GROUPS: [
    { id: "all", name: "全部作品", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DEFAULT_FOLLOWINGS_GROUPS: [
    { id: "all", name: "全部关注", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DNR: {
    RULES: [
      {
        id: 1,
        priority: 1,
        condition: {
          urlFilter: "douyinvod.com",
          resourceTypes: ["media", "image", "xmlhttprequest"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://www.douyin.com/",
            },
            {
              header: "Origin",
              operation: "set",
              value: "https://www.douyin.com",
            },
          ],
        },
      },
      {
        id: 2,
        priority: 1,
        condition: {
          urlFilter: "douyinpic.com",
          resourceTypes: ["image", "xmlhttprequest"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://www.douyin.com/",
            },
          ],
        },
      },
    ],
  },
  TIMEOUT: {
    REQUEST: 30000,
    SECURITY_STATUS: 5000,
  },
  DELAY: {
    MIN: 400,
    MAX: 800,
  },
  SYNC: {
    BATCH_SIZE: 30,
    BATCH_PAUSE_MIN: 10000,
    BATCH_PAUSE_MAX: 20000,
    KEEPALIVE_INTERVAL: 2000,
  },
  GROUPS: {
    DELETE_LATER_NAME: "稍后删除",
    ID_PREFIX: "custom_",
    DEFAULT_ID: "uncategorized",
  },
};

// STORAGE_KEYS 作为 store/group 名的唯一常量来源

// ---------- 初始化 ----------
async function setupDeclarativeNetRequest() {
  const rules = CONFIG.DNR.RULES;

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

chrome.runtime.onInstalled.addListener(async () => {
  await setupDeclarativeNetRequest();

  const worksGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS);
  if (!worksGroups.length) {
    await storage.putGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS, CONFIG.DEFAULT_WORKS_GROUPS);
  }

  const followingsGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS);
  if (!followingsGroups.length) {
    await storage.putGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS, CONFIG.DEFAULT_FOLLOWINGS_GROUPS);
  }
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(setupDeclarativeNetRequest);
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

// ---------- 辅助函数 ----------

function asyncHandler(fn, sendResponse) {
  const result = fn();
  if (result && typeof result.catch === "function") {
    result.catch((err) => sendResponse({ error: err.message }));
  }
  return true;
}

const DOMAIN_CONFIG = {
  [CONFIG.STORAGE_KEYS.WORKS]: {
    storeName: CONFIG.STORAGE_KEYS.WORKS,
    groupsName: CONFIG.STORAGE_KEYS.WORKS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_WORKS_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.WORKS,
    idField: "awemeId",
  },
  [CONFIG.STORAGE_KEYS.FOLLOWINGS]: {
    storeName: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    groupsName: CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_FOLLOWINGS_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    idField: "uid",
    idToString: true,
  },
};

function getStoreName(domain) {
  return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].storeName;
}

function getGroupsName(domain) {
  return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].groupsName;
}

function getDefaultGroups(domain) {
  return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].defaultGroups;
}

function toStorageId(domain, id) {
  const cfg = DOMAIN_CONFIG[domain];
  return cfg.idToString ? String(id) : id;
}

function createDomainHandlers(domain) {
  const cfg = DOMAIN_CONFIG[domain];

  return {
    async get(groupId, sendResponse) {
      try {
        let list;
        if (groupId && groupId !== "all") {
          const store = await storage.getByIndex(cfg.storeName, "groupId", groupId);
          list = Object.values(store);
        } else {
          const store = await storage.getAll(cfg.storeName);
          list = Object.values(store);
        }
        list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        sendResponse({ [cfg.itemKey]: list });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    },

    async delete(ids, sendResponse) {
      try {
        const keys = ids.map((id) => toStorageId(domain, id));
        await storage.deleteBatch(cfg.storeName, keys);
        const remaining = await storage.count(cfg.storeName);
        sendResponse({ ok: true, remaining });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    },

    async move(ids, targetGroupId, sendResponse) {
      try {
        const keys = ids.map((id) => toStorageId(domain, id));
        const items = await Promise.all(keys.map((k) => storage.get(cfg.storeName, k)));
        const toWrite = items.filter(Boolean).map((item) => ({ ...item, groupId: targetGroupId }));
        if (toWrite.length > 0) await storage.putBatch(cfg.storeName, toWrite);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    },

    async save(items, sendResponse, isImport = false) {
      if (domain === CONFIG.STORAGE_KEYS.WORKS) {
        return handleSaveWorks(items, sendResponse);
      } else if (domain === CONFIG.STORAGE_KEYS.FOLLOWINGS) {
        return handleSaveFollowings(items, sendResponse, isImport);
      }
      sendResponse({ ok: false, error: "Unknown domain: " + domain });
    },
  };
}

const worksHandlers = createDomainHandlers(CONFIG.STORAGE_KEYS.WORKS);
const followingsHandlers = createDomainHandlers(CONFIG.STORAGE_KEYS.FOLLOWINGS);

function extractImportItems(data, domain) {
  const cfg = DOMAIN_CONFIG[domain];
  if (data[cfg.itemKey] && Array.isArray(data[cfg.itemKey])) return data[cfg.itemKey];
  return [];
}

function mergeWork(w, old) {
  return {
    ...w,
    groupId: old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID,
    savedAt: old?.savedAt || w.savedAt || Date.now(),
  };
}

async function mergeAndSaveWorks(works) {
  const valid = works.filter((w) => w && w.awemeId);
  if (valid.length === 0) return { added: 0, updated: 0, total: 0 };

  const oldItems = await Promise.all(
    valid.map((w) => storage.get(CONFIG.STORAGE_KEYS.WORKS, w.awemeId).then((old) => ({ w, old }))),
  );

  let added = 0,
    updated = 0;
  const toWrite = [];
  for (const { w, old } of oldItems) {
    const isNew = !old;
    toWrite.push(mergeWork(w, old));
    if (isNew) added++;
    else updated++;
  }
  await storage.putBatch(CONFIG.STORAGE_KEYS.WORKS, toWrite);

  const totalCount = await storage.count(CONFIG.STORAGE_KEYS.WORKS);
  return { added, updated, total: totalCount };
}

function sendSyncDone(requestId, result) {
  chrome.runtime
    .sendMessage({ type: "SYNC_DONE", requestId, ...result })
    .catch((e) => console.warn("[DY] sync done send failed:", e));
}

async function withDouyinTab() {
  const tabs = await chrome.tabs.query({ url: "*://*.douyin.com/*" });
  const tab = tabs.find((t) => t.url && !t.url.includes("creator.douyin.com") && t.status === "complete");
  return tab || null;
}

function sendToTab(type, data, sendResponse) {
  const requestId = crypto.randomUUID();
  const timeoutMs = data.timeout || CONFIG.TIMEOUT.REQUEST;
  let called = false;

  withDouyinTab()
    .then((tab) => {
      if (!tab) {
        sendResponse({ ok: false, error: "NO_DOUYIN_TAB" });
        return;
      }

      const timer = setTimeout(() => {
        if (called) return;
        called = true;
        sendResponse({ ok: false, error: "TIMEOUT" });
        // 超时后中止 inject.js 中的活跃任务，避免其继续运行产生后续回调
        chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
      }, timeoutMs);

      chrome.tabs.sendMessage(tab.id, { type, requestId, ...data }, (resp) => {
        clearTimeout(timer);
        if (called) return;
        called = true;
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: "NO_LISTENER" });
          return;
        }
        sendResponse(resp || { ok: false, error: "EMPTY_RESPONSE" });
      });
    })
    .catch(() => {
      if (!called) sendResponse({ ok: false, error: "TAB_QUERY_FAILED" });
    });
}

function sendToTabAsync(type, data) {
  return new Promise((resolve) => {
    sendToTab(type, data, (resp) => resolve(resp || { ok: false, error: "EMPTY_RESPONSE" }));
  });
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    // 作品域
    case "SAVE_WORKS":
      return asyncHandler(() => worksHandlers.save(message.works, sendResponse), sendResponse);
    case "GET_WORKS":
      return asyncHandler(() => worksHandlers.get(message.groupId, sendResponse), sendResponse);
    case "DELETE_WORKS":
      return asyncHandler(() => worksHandlers.delete(message.awemeIds, sendResponse), sendResponse);
    case "MOVE_WORKS":
      return asyncHandler(
        () => worksHandlers.move(message.awemeIds, message.targetGroupId, sendResponse),
        sendResponse,
      );
    case "SYNC_WORKS":
      return asyncHandler(() => handleSyncWorks(message.awemeIds, sendResponse), sendResponse);
    case "GET_WORK":
      return asyncHandler(() => handleGetWork(message.awemeId, sendResponse), sendResponse);
    case "SYNC_PROGRESS":
      handleSyncProgress(message, sendResponse);
      return false;

    // 关注域
    case "SAVE_FOLLOWINGS":
      return asyncHandler(() => followingsHandlers.save(message.followings, sendResponse), sendResponse);
    case "GET_FOLLOWINGS":
      return asyncHandler(() => followingsHandlers.get(message.groupId, sendResponse), sendResponse);
    case "DELETE_FOLLOWINGS":
      return asyncHandler(() => followingsHandlers.delete(message.uids, sendResponse), sendResponse);
    case "MOVE_FOLLOWINGS":
      return asyncHandler(
        () => followingsHandlers.move(message.uids, message.targetGroupId, sendResponse),
        sendResponse,
      );
    // 分组管理 (域感知)
    case "GET_GROUPS":
      return asyncHandler(() => handleGetGroups(message.domain, sendResponse), sendResponse);
    case "ADD_GROUP":
      return asyncHandler(() => handleAddGroup(message.domain, message.name, sendResponse), sendResponse);
    case "RENAME_GROUP":
      return asyncHandler(
        () => handleRenameGroup(message.domain, message.groupId, message.newName, sendResponse),
        sendResponse,
      );
    case "DELETE_GROUP":
      return asyncHandler(() => handleDeleteGroup(message.domain, message.groupId, sendResponse), sendResponse);
    case "REORDER_GROUPS":
      return asyncHandler(() => handleReorderGroups(message.domain, message.groupIds, sendResponse), sendResponse);

    // 数据工具 (域感知)
    case "IMPORT_DATA":
      return asyncHandler(
        () => handleImportData(message.data, message.domain || CONFIG.STORAGE_KEYS.WORKS, sendResponse),
        sendResponse,
      );
    case "EXPORT_DATA":
      return asyncHandler(() => handleExportData(message.domain, sendResponse), sendResponse);
    case "RESET_DOMAIN":
      return asyncHandler(() => handleResetDomain(message.domain, sendResponse), sendResponse);
    case "GET_STATS":
      return asyncHandler(() => handleGetStats(sendResponse), sendResponse);

    // Tab 转发 (到 inject.js via content.js)
    case "FETCH_FOLLOWING":
      return asyncHandler(() => handleFetchFollowing(message.secUid, sendResponse), sendResponse);
    case "FETCH_FAVORITES":
      return asyncHandler(() => handleFetchFavorites(message.secUid, sendResponse), sendResponse);
    case "CANCEL_LIKE":
      return asyncHandler(() => handleCancelLike(message.awemeIds, "CANCEL_ONE_LIKE", "CANCEL_PROGRESS", sendResponse), sendResponse);
    case "FETCH_COLLECTION":
      return asyncHandler(() => handleFetchCollection(sendResponse), sendResponse);
    case "CANCEL_COLLECTION":
      return asyncHandler(() => handleCancelCollection(message.awemeIds, "CANCEL_ONE_COLLECTION", "CANCEL_PROGRESS", sendResponse), sendResponse);
    case "FETCH_WORKS_PAGE":
      sendToTab(
        "FETCH_WORKS_PAGE",
        {
          secUid: message.secUid,
          cursor: message.cursor || "",
          timeout: CONFIG.TIMEOUT.REQUEST,
        },
        sendResponse,
      );
      return true;
    case "GET_SECURITY_STATUS":
      sendToTab("GET_SECURITY_STATUS", { timeout: CONFIG.TIMEOUT.SECURITY_STATUS }, sendResponse);
      return true;

    case "CANCEL_ACTIVE_TASK":
      withDouyinTab()
        .then((tab) => {
          if (!tab) {
            sendResponse({ ok: false, error: "NO_DOUYIN_TAB" });
            return;
          }
          chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
          sendResponse({ ok: true });
        })
        .catch(() => sendResponse({ ok: false }));
      return true;

    default:
      sendResponse({ error: `Unknown message type: ${message.type}` });
  }
});

// ---------- 分页抓取 Handler ----------

async function handleFetchFollowing(secUid, sendResponse) {
  try {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") {
        cancelled = true;
      }
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    const all = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore && !cancelled) {
      const resp = await sendToTabAsync("FETCH_FOLLOWING_PAGE", {
        secUid,
        offset,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok && Array.isArray(resp.items)) {
        all.push(...resp.items);
        hasMore = resp.hasMore === true;
        offset = resp.cursor;
      } else {
        break;
      }
      chrome.runtime
        .sendMessage({
          type: "FOLLOWING_PROGRESS",
          collected: all.length,
          hasMore,
          total: resp.total || 0,
          requestId,
        })
        .catch(() => {});
      if (hasMore && !cancelled) {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, followings: all, total: all.length });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleFetchFavorites(secUid, sendResponse) {
  try {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") {
        cancelled = true;
      }
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    const all = [];
    let cursor = 0;
    let hasMore = true;

    while (hasMore && !cancelled) {
      const resp = await sendToTabAsync("FETCH_FAVORITES_PAGE", {
        secUid,
        cursor,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok && Array.isArray(resp.items)) {
        all.push(...resp.items);
        hasMore = resp.hasMore === true;
        cursor = resp.cursor || cursor;
      } else {
        break;
      }
      const unfollowedCount = all.filter((w) => w.authorFollowed === false).length;
      chrome.runtime
        .sendMessage({
          type: "FAVORITES_PROGRESS",
          collected: all.length,
          unfollowedCount,
          hasMore,
          total: resp.total || 0,
          requestId,
        })
        .catch(() => {});
      if (hasMore && !cancelled) {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleFetchCollection(sendResponse) {
  try {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") {
        cancelled = true;
      }
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    const all = [];
    let cursor = 0;
    let hasMore = true;

    while (hasMore && !cancelled) {
      const resp = await sendToTabAsync("FETCH_COLLECTION_PAGE", {
        cursor,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok && Array.isArray(resp.items)) {
        all.push(...resp.items);
        hasMore = resp.hasMore === true;
        cursor = resp.cursor || cursor;
      } else {
        break;
      }
      const unfollowedCount = all.filter((w) => w.authorFollowed === false).length;
      chrome.runtime
        .sendMessage({
          type: "COLLECTION_PROGRESS",
          collected: all.length,
          unfollowedCount,
          hasMore,
          total: resp.total || 0,
          requestId,
        })
        .catch(() => {});
      if (hasMore && !cancelled) {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function runCancelBatch(awemeIds, tabType, progressType, sendResponse) {
  const requestId = crypto.randomUUID();
  const errors = [];
  let cancelled = false;
  const cancelHandler = (msg) => {
    if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
  };
  chrome.runtime.onMessage.addListener(cancelHandler);

  sendResponse({ ok: true, requestId, total: awemeIds.length });

  for (let i = 0; i < awemeIds.length && !cancelled; i++) {
    const resp = await sendToTabAsync(tabType, {
      awemeId: awemeIds[i],
      timeout: CONFIG.TIMEOUT.REQUEST,
    });
    if (resp?.ok) {
      // success
    } else {
      errors.push({ awemeId: awemeIds[i], error: resp?.error || "FAILED" });
    }
    chrome.runtime
      .sendMessage({
        type: progressType,
        requestId,
        index: i,
        total: awemeIds.length,
        status: resp?.ok ? "ok" : "error",
        awemeId: awemeIds[i],
      })
      .catch(() => {});

    if (!cancelled && i < awemeIds.length - 1) {
      const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  chrome.runtime.onMessage.removeListener(cancelHandler);
  chrome.runtime
    .sendMessage({
      type: "CANCEL_DONE",
      requestId,
      ok: true,
      cancelled,
      refreshed: awemeIds.length - errors.length,
      failed: errors.length,
      failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
    })
    .catch(() => {});
}

async function handleCancelLike(awemeIds, tabType, progressType, sendResponse) {
  try {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
      sendResponse({ ok: false, error: "EMPTY" });
      return;
    }
    await runCancelBatch(awemeIds, tabType, progressType, sendResponse);
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleCancelCollection(awemeIds, tabType, progressType, sendResponse) {
  try {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
      sendResponse({ ok: false, error: "EMPTY" });
      return;
    }
    await runCancelBatch(awemeIds, tabType, progressType, sendResponse);
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ---------- 作品域 Handler ----------

async function handleSaveWorks(works, sendResponse) {
  try {
    const result = await mergeAndSaveWorks(works);
    const invalid = works.filter((w) => !w || !w.awemeId).length;
    sendResponse({ ok: true, ...result, invalid });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleGetWork(awemeId, sendResponse) {
  try {
    const work = await storage.get(CONFIG.STORAGE_KEYS.WORKS, awemeId);
    sendResponse({ work: work || null });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ---------- 关注域 Handler ----------

async function handleSaveFollowings(followings, sendResponse, isImport = false) {
  try {
    if (!Array.isArray(followings) || followings.length === 0) {
      return sendResponse({ ok: false, error: "EMPTY" });
    }

    const store = await storage.getAll(CONFIG.STORAGE_KEYS.FOLLOWINGS);
    const incomingUids = new Set();
    let added = 0,
      updated = 0;

    const baseTime = Date.now();
    for (let i = 0; i < followings.length; i++) {
      const f = followings[i];
      if (!f || !f.uid) continue;
      const uid = String(f.uid);
      incomingUids.add(uid);
      const old = store[uid];
      store[uid] = {
        ...f,
        uid,
        groupId: isImport
          ? f.groupId || CONFIG.GROUPS.DEFAULT_ID
          : old?.groupId || f.groupId || CONFIG.GROUPS.DEFAULT_ID,
        savedAt: old?.savedAt ?? baseTime - i,
      };
      if (!old) added++;
      else updated++;
    }

    // Mark users not in new list as 'lost'
    const lostUids = [];
    for (const uid of Object.keys(store)) {
      if (!incomingUids.has(uid)) {
        lostUids.push(uid);
      }
    }

    await storage.putBatch(CONFIG.STORAGE_KEYS.FOLLOWINGS, Object.values(store));
    sendResponse({
      ok: true,
      added,
      updated,
      lost: lostUids.length,
      lostUids,
      total: Object.keys(store).length,
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ---------- 分组 Handler (域感知) ----------

async function handleGetGroups(domain, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const result = list.length ? list : def;
    result.forEach((g, i) => {
      if (!("order" in g)) g.order = i;
    });
    result.sort((a, b) => a.order - b.order);
    sendResponse({ groups: result });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleAddGroup(domain, name, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const id = CONFIG.GROUPS.ID_PREFIX + crypto.randomUUID();
    current.push({
      id,
      name: name.trim(),
      fixed: false,
      order: current.length,
    });
    await storage.putGroups(groupsName, current);
    sendResponse({ ok: true, group: current[current.length - 1] });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleRenameGroup(domain, groupId, newName, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const g = current.find((x) => x.id === groupId);
    if (!g) return sendResponse({ error: "分组不存在" });
    if (g.fixed) return sendResponse({ error: "固定分组不可重命名" });
    g.name = newName.trim();
    await storage.putGroups(groupsName, current);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleReorderGroups(domain, groupIds, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const fixed = current.filter((g) => g.fixed);
    const ordered = groupIds.map((id) => current.find((x) => x.id === id)).filter(Boolean);
    for (const g of fixed) {
      if (!ordered.some((x) => x.id === g.id)) ordered.unshift(g);
    }
    ordered.forEach((g, i) => (g.order = i));
    await storage.putGroups(groupsName, ordered);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleDeleteGroup(domain, groupId, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const storeName = getStoreName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const defaultGroupId = CONFIG.GROUPS.DEFAULT_ID;

    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const g = current.find((x) => x.id === groupId);
    if (!g) return sendResponse({ error: "分组不存在" });
    if (g.fixed) return sendResponse({ error: "固定分组不可删除" });

    const affected = await storage.getByIndex(storeName, "groupId", groupId);
    const affectedList = Object.values(affected);
    for (const item of affectedList) {
      item.groupId = defaultGroupId;
    }
    if (affectedList.length > 0) await storage.putBatch(storeName, affectedList);

    const filtered = current.filter((x) => x.id !== groupId);
    await storage.putGroups(groupsName, filtered);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ---------- 同步 Handler ----------

const syncSessions = new Map();

function handleSyncProgress(message, sendResponse) {
  if (!syncSessions.has(message.requestId)) {
    return sendResponse({ ok: false });
  }
  chrome.runtime
    .sendMessage({ type: "SYNC_PROGRESS", ...message })
    .catch((e) => console.warn("[DY] sync progress send failed:", e));
  sendResponse({ ok: true });
}

const FATAL_ERRORS = new Set([
  "NO_DOUYIN_TAB", "TAB_QUERY_FAILED", "NO_LISTENER", "EMPTY_RESPONSE",
  "RATE_LIMITED", "CANCELLED",
]);

async function handleSyncWorks(awemeIds, sendResponse) {
  if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
    return sendResponse({ ok: false, error: "EMPTY" });
  }

  const requestId = crypto.randomUUID();
  syncSessions.set(requestId, true);
  let cancelled = false;

  const cancelHandler = (msg) => {
    if (msg.type === "CANCEL_ACTIVE_TASK") {
      cancelled = true;
      withDouyinTab().then((tab) => {
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
      });
    }
  };
  chrome.runtime.onMessage.addListener(cancelHandler);

  sendResponse({ ok: true, requestId, total: awemeIds.length });

  const allWorks = [];
  const errors = [];

  for (let i = 0; i < awemeIds.length && !cancelled; i++) {
    const resp = await sendToTabAsync("FETCH_SINGLE_WORK", {
      awemeId: awemeIds[i],
      timeout: CONFIG.TIMEOUT.REQUEST,
    });

    if (!resp?.ok) {
      const err = resp?.error || "UNKNOWN";
      if (FATAL_ERRORS.has(err) || err.startsWith("HTTP 429") || err.startsWith("HTTP 401")) {
        for (let j = i; j < awemeIds.length; j++) {
          errors.push({ awemeId: awemeIds[j], error: j === i ? err : "BATCH_TERMINATED" });
        }
        break;
      }
      errors.push({ awemeId: awemeIds[i], error: err });
    } else if (resp.work) {
      allWorks.push(resp.work);
    }

    chrome.runtime
      .sendMessage({
        type: "SYNC_PROGRESS",
        requestId,
        index: i,
        total: awemeIds.length,
        status: resp?.ok ? "ok" : "error",
        awemeId: awemeIds[i],
      })
      .catch(() => {});

    if (!cancelled) {
      const { BATCH_SIZE, BATCH_PAUSE_MIN, BATCH_PAUSE_MAX, KEEPALIVE_INTERVAL } = CONFIG.SYNC;
      if (BATCH_SIZE > 0 && (i + 1) % BATCH_SIZE === 0) {
        const batchPause = BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
        const deadline = Date.now() + batchPause;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, KEEPALIVE_INTERVAL));
          await chrome.storage.local.get("keepalive");
        }
      } else {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  chrome.runtime.onMessage.removeListener(cancelHandler);

  try {
    if (allWorks.length > 0) {
      const result = await mergeAndSaveWorks(allWorks);
      sendSyncDone(requestId, {
        ok: true,
        refreshed: result.added + result.updated,
        failed: errors.length,
        failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
      });
    } else {
      sendSyncDone(requestId, { ok: false, error: errors[0]?.error || "NO_WORKS_COLLECTED" });
    }
  } catch (err) {
    sendSyncDone(requestId, { ok: false, error: err.message });
  }
  syncSessions.delete(requestId);
}

// ---------- 数据工具 ----------

async function reconcileImportGroups(domain, data, items) {
  const importedGroups = data.groups || [];
  if (importedGroups.length === 0) return;
  const groupsName = getGroupsName(domain);
  const def = getDefaultGroups(domain);
  const existingList = await storage.getGroups(groupsName);
  const existing = existingList.length ? existingList : def;
  const fixed = existing.filter((g) => g.fixed);
  const imported = importedGroups.filter((g) => !g.fixed);
  const existingIds = new Set(existing.map((g) => g.id));
  const existingNames = new Map(existing.map((g) => [g.name, g.id]));
  const groupIdMap = new Map();
  const newGroups = [];
  for (const g of imported) {
    if (existingIds.has(g.id)) {
      groupIdMap.set(g.id, g.id);
    } else if (existingNames.has(g.name)) {
      groupIdMap.set(g.id, existingNames.get(g.name));
    } else {
      newGroups.push(g);
      groupIdMap.set(g.id, g.id);
    }
  }
  const merged = [...fixed, ...existing.filter((g) => !g.fixed), ...newGroups];
  merged.forEach((g, i) => (g.order = i));
  await storage.putGroups(groupsName, merged);
  for (const item of items) {
    if (item.groupId && groupIdMap.has(item.groupId)) {
      item.groupId = groupIdMap.get(item.groupId);
    }
  }
}

async function handleImportData(data, domain, sendResponse) {
  try {
    const cfg = DOMAIN_CONFIG[domain];
    const items = extractImportItems(data, domain);
    if (Array.isArray(data.groups)) {
      await reconcileImportGroups(domain, data, items);
    }

    const groupsName = getGroupsName(domain);
    const def = getDefaultGroups(domain);
    const groupsList = await storage.getGroups(groupsName);
    const currentGroups = groupsList.length ? groupsList : def;
    const validGroupIds = new Set(currentGroups.map((g) => g.id));
    for (const item of items) {
      if (!validGroupIds.has(item.groupId)) item.groupId = CONFIG.GROUPS.DEFAULT_ID;
    }

    if (domain === CONFIG.STORAGE_KEYS.FOLLOWINGS) await handleSaveFollowings(items, sendResponse, true);
    else await handleSaveWorks(items, sendResponse);
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleExportData(domain, sendResponse) {
  try {
    const cfg = DOMAIN_CONFIG[domain];
    const items = await storage.getAll(cfg.storeName);
    const groups = await storage.getGroups(cfg.groupsName);
    const def = getDefaultGroups(domain);
    sendResponse({
      ok: true,
      data: {
        domain,
        exportedAt: new Date().toISOString(),
        [cfg.itemKey]: Object.values(items),
        groups: groups.length ? groups : def,
      },
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleResetDomain(domain, sendResponse) {
  try {
    const cfg = DOMAIN_CONFIG[domain];
    await storage.clear(cfg.storeName);
    await storage.putGroups(cfg.groupsName, cfg.defaultGroups);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleGetStats(sendResponse) {
  try {
    const [works, followings, works_groups, followings_groups, est] = await Promise.all([
      storage.getAll(CONFIG.STORAGE_KEYS.WORKS),
      storage.getAll(CONFIG.STORAGE_KEYS.FOLLOWINGS),
      storage.getGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS),
      storage.getGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS),
      storage.estimate(),
    ]);

    const bytes = est ? est.usage : 0;

    function buildDomainStats(items, groups) {
      const list = Object.values(items || {});
      const total = list.length;
      const groupCounts = { all: total };
      for (const g of groups || []) {
        if (g.id !== "all") groupCounts[g.id] = 0;
      }
      for (const item of list) {
        const gid = item.groupId;
        if (gid && gid in groupCounts) groupCounts[gid]++;
      }
      return { total, groupCounts };
    }

    sendResponse({
      ok: true,
      stats: {
        works: buildDomainStats(works, works_groups),
        followings: buildDomainStats(followings, followings_groups),
        bytes,
      },
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}
