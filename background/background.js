import { storage } from './storage.js';

// ===== 抖音数据管理 - Background Service Worker =====

const CONFIG = {
  STORAGE_KEYS: {
    WORKS: 'works',
    WORKS_GROUPS: 'works_groups',
    FOLLOWINGS: 'followings',
    FOLLOWINGS_GROUPS: 'followings_groups',
  },
  DEFAULT_WORKS_GROUPS: [
    { id: 'all', name: '全部作品', fixed: true },
    { id: 'uncategorized', name: '未分组', fixed: true },
  ],
  DEFAULT_FOLLOWINGS_GROUPS: [
    { id: 'all', name: '全部关注', fixed: true },
    { id: 'uncategorized', name: '未分组', fixed: true },
  ],
  DNR: {
    RULES: [
      {
        id: 1, priority: 1,
        condition: { urlFilter: 'douyinvod.com', resourceTypes: ['media', 'image', 'xmlhttprequest'] },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.douyin.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.douyin.com' },
          ],
        },
      },
      {
        id: 2, priority: 1,
        condition: { urlFilter: 'douyinpic.com', resourceTypes: ['image', 'xmlhttprequest'] },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.douyin.com/' },
          ],
        },
      },
    ],
  },
  TIMEOUT: {
    DEFAULT: 300000,
    CANCEL: 120000,
    WORKS_PAGE: 60000,
    SECURITY_STATUS: 5000,
  },
  GROUPS: {
    DELETE_LATER_NAME: '稍后删除',
    ID_PREFIX: 'custom_',
    DEFAULT_ID: 'uncategorized',
  },
  EXPORT_VERSION: '2.0',
};

// STORAGE_KEYS 作为 store/group 名的唯一常量来源

// ---------- 初始化 ----------
async function setupDeclarativeNetRequest() {
  const rules = CONFIG.DNR.RULES;

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existing.map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules,
    });
  } catch (e) {
    console.warn('[DY-Manager] DNR setup failed:', e.message);
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
  const url = chrome.runtime.getURL('options/options.html');
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
  if (result && typeof result.catch === 'function') {
    result.catch(err => sendResponse({ error: err.message }));
  }
  return true;
}

const DOMAIN_CONFIG = {
  [CONFIG.STORAGE_KEYS.WORKS]: {
    storeName: CONFIG.STORAGE_KEYS.WORKS,
    groupsName: CONFIG.STORAGE_KEYS.WORKS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_WORKS_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.WORKS,
    idField: 'awemeId',
  },
  [CONFIG.STORAGE_KEYS.FOLLOWINGS]: {
    storeName: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    groupsName: CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_FOLLOWINGS_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    idField: 'uid',
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
        if (groupId && groupId !== 'all') {
          const store = await storage.getByIndex(cfg.storeName, 'groupId', groupId);
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
        const keys = ids.map(id => toStorageId(domain, id));
        await storage.deleteBatch(cfg.storeName, keys);
        const remaining = await storage.count(cfg.storeName);
        sendResponse({ ok: true, remaining });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    },

    async move(ids, targetGroupId, sendResponse) {
      try {
        const keys = ids.map(id => toStorageId(domain, id));
        const items = await Promise.all(keys.map(k => storage.get(cfg.storeName, k)));
        const toWrite = items.filter(Boolean).map(item => ({ ...item, groupId: targetGroupId }));
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
      sendResponse({ ok: false, error: 'Unknown domain: ' + domain });
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
  const valid = works.filter(w => w && w.awemeId);
  if (valid.length === 0) return { added: 0, updated: 0, total: 0 };

  const oldItems = await Promise.all(
    valid.map(w => storage.get(CONFIG.STORAGE_KEYS.WORKS, w.awemeId).then(old => ({ w, old })))
  );

  let added = 0, updated = 0;
  const toWrite = [];
  for (const { w, old } of oldItems) {
    const isNew = !old;
    toWrite.push(mergeWork(w, old));
    if (isNew) added++; else updated++;
  }
  await storage.putBatch(CONFIG.STORAGE_KEYS.WORKS, toWrite);

  const totalCount = await storage.count(CONFIG.STORAGE_KEYS.WORKS);
  return { added, updated, total: totalCount };
}

function sendSyncDone(requestId, result) {
  chrome.runtime.sendMessage({ type: 'SYNC_DONE', requestId, ...result })
    .catch(e => console.warn('[DY] sync done send failed:', e));
}

async function withDouyinTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.douyin.com/*' });
  const tab = tabs.find(t => t.url && !t.url.includes('creator.douyin.com') && t.status === 'complete');
  return tab || null;
}

function sendToTab(type, data, sendResponse) {
  const requestId = crypto.randomUUID();
  const timeoutMs = data.timeout || CONFIG.TIMEOUT.DEFAULT;
  let called = false;

  withDouyinTab().then(tab => {
    if (!tab) {
      sendResponse({ ok: false, error: 'NO_DOUYIN_TAB' });
      return;
    }

    const timer = setTimeout(() => {
      if (called) return;
      called = true;
      sendResponse({ ok: false, error: 'TIMEOUT' });
      // 超时后中止 inject.js 中的活跃任务，避免其继续运行产生后续回调
      chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_ACTIVE_TASK' }).catch(() => {});
    }, timeoutMs);

    chrome.tabs.sendMessage(tab.id, { type, requestId, ...data }, resp => {
      clearTimeout(timer);
      if (called) return;
      called = true;
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: 'NO_LISTENER' });
        return;
      }
      sendResponse(resp || { ok: false, error: 'EMPTY_RESPONSE' });
    });
  }).catch(() => {
    if (!called) sendResponse({ ok: false, error: 'TAB_QUERY_FAILED' });
  });
}

function registerProgressForwarder(sourceType, destType) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === sourceType) {
      chrome.runtime.sendMessage({ type: destType, ...message }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
  });
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    // 作品域
    case 'SAVE_WORKS':
      return asyncHandler(() => worksHandlers.save(message.works, sendResponse), sendResponse);
    case 'GET_WORKS':
      return asyncHandler(() => worksHandlers.get(message.groupId, sendResponse), sendResponse);
    case 'DELETE_WORKS':
      return asyncHandler(() => worksHandlers.delete(message.awemeIds, sendResponse), sendResponse);
    case 'MOVE_WORKS':
      return asyncHandler(() => worksHandlers.move(message.awemeIds, message.targetGroupId, sendResponse), sendResponse);
    case 'SYNC_WORKS':
      return asyncHandler(() => handleSyncWorks(message.awemeIds, sendResponse), sendResponse);
    case 'GET_WORK':
      return asyncHandler(() => handleGetWork(message.awemeId, sendResponse), sendResponse);
    case 'SYNC_PROGRESS':
      handleSyncProgress(message, sendResponse);
      return false;

    // 关注域
    case 'SAVE_FOLLOWINGS':
      return asyncHandler(() => followingsHandlers.save(message.followings, sendResponse), sendResponse);
    case 'GET_FOLLOWINGS':
      return asyncHandler(() => followingsHandlers.get(message.groupId, sendResponse), sendResponse);
    case 'DELETE_FOLLOWINGS':
      return asyncHandler(() => followingsHandlers.delete(message.uids, sendResponse), sendResponse);
    case 'MOVE_FOLLOWINGS':
      return asyncHandler(() => followingsHandlers.move(message.uids, message.targetGroupId, sendResponse), sendResponse);
    // 分组管理 (域感知)
    case 'GET_GROUPS':
      return asyncHandler(() => handleGetGroups(message.domain, sendResponse), sendResponse);
    case 'ADD_GROUP':
      return asyncHandler(() => handleAddGroup(message.domain, message.name, sendResponse), sendResponse);
    case 'RENAME_GROUP':
      return asyncHandler(() => handleRenameGroup(message.domain, message.groupId, message.newName, sendResponse), sendResponse);
    case 'DELETE_GROUP':
      return asyncHandler(() => handleDeleteGroup(message.domain, message.groupId, sendResponse), sendResponse);
    case 'REORDER_GROUPS':
      return asyncHandler(() => handleReorderGroups(message.domain, message.groupIds, sendResponse), sendResponse);

    // 数据工具 (域感知)
    case 'IMPORT_DATA':
      return asyncHandler(() => handleImportData(message.data, message.domain || CONFIG.STORAGE_KEYS.WORKS, sendResponse), sendResponse);
    case 'EXPORT_DATA':
      return asyncHandler(() => handleExportData(message.domain, sendResponse), sendResponse);
    case 'RESET_DOMAIN':
      return asyncHandler(() => handleResetDomain(message.domain, sendResponse), sendResponse);
    case 'GET_STATS':
      return asyncHandler(() => handleGetStats(sendResponse), sendResponse);

    // 导航
    case 'OPEN_DOUYIN_TAB':
      handleOpenDouyinTab(message, sendResponse);
      return false;

    // Tab 转发 (到 inject.js via content.js)
    case 'FETCH_FOLLOWING':
      sendToTab('FETCH_FOLLOWING', { secUid: message.secUid, timeout: CONFIG.TIMEOUT.DEFAULT }, sendResponse);
      return true;
    case 'FETCH_FAVORITES':
      sendToTab('FETCH_FAVORITES', { secUid: message.secUid, timeout: CONFIG.TIMEOUT.DEFAULT }, sendResponse);
      return true;
    case 'CANCEL_LIKE':
      sendToTab('CANCEL_LIKE', { awemeIds: message.awemeIds, timeout: CONFIG.TIMEOUT.CANCEL }, sendResponse);
      return true;
    case 'FETCH_COLLECTION':
      sendToTab('FETCH_COLLECTION', { timeout: CONFIG.TIMEOUT.DEFAULT }, sendResponse);
      return true;
    case 'CANCEL_COLLECTION':
      sendToTab('CANCEL_COLLECTION', { awemeIds: message.awemeIds, timeout: CONFIG.TIMEOUT.CANCEL }, sendResponse);
      return true;
    case 'FETCH_WORKS_PAGE':
      sendToTab('FETCH_WORKS_PAGE', { secUid: message.secUid, cursor: message.cursor || '', timeout: CONFIG.TIMEOUT.WORKS_PAGE }, sendResponse);
      return true;
      case 'GET_SECURITY_STATUS':
        sendToTab('GET_SECURITY_STATUS', { timeout: CONFIG.TIMEOUT.SECURITY_STATUS }, sendResponse);
        return true;

      case 'CANCEL_ACTIVE_TASK':
        withDouyinTab().then(tab => {
          if (!tab) { sendResponse({ ok: false, error: 'NO_DOUYIN_TAB' }); return; }
          chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_ACTIVE_TASK' }).catch(() => {});
          sendResponse({ ok: true });
        }).catch(() => sendResponse({ ok: false }));
        return true;

      default:
        sendResponse({ error: `Unknown message type: ${message.type}` });
    }
  });

// Progress forwarders
registerProgressForwarder('FOLLOWING_PROGRESS', 'FOLLOWING_PROGRESS');
registerProgressForwarder('FAVORITES_PROGRESS', 'FAVORITES_PROGRESS');
registerProgressForwarder('COLLECTION_PROGRESS', 'COLLECTION_PROGRESS');

// ---------- 作品域 Handler ----------

async function handleSaveWorks(works, sendResponse) {
  try {
    const result = await mergeAndSaveWorks(works);
    const invalid = works.filter(w => !w || !w.awemeId).length;
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
      return sendResponse({ ok: false, error: 'EMPTY' });
    }

    const store = await storage.getAll(CONFIG.STORAGE_KEYS.FOLLOWINGS);
    const incomingUids = new Set();
    let added = 0, updated = 0;

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
          ? (f.groupId || CONFIG.GROUPS.DEFAULT_ID)
          : (old?.groupId || f.groupId || CONFIG.GROUPS.DEFAULT_ID),
        savedAt: old?.savedAt ?? (baseTime - i),
      };
      if (!old) added++; else updated++;
    }

    // Mark users not in new list as 'lost'
    const lostUids = [];
    for (const uid of Object.keys(store)) {
      if (!incomingUids.has(uid)) {
        lostUids.push(uid);
      }
    }

    await storage.putBatch(CONFIG.STORAGE_KEYS.FOLLOWINGS, Object.values(store));
    sendResponse({ ok: true, added, updated, lost: lostUids.length, lostUids, total: Object.keys(store).length });
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
    result.forEach((g, i) => { if (!('order' in g)) g.order = i; });
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
    current.push({ id, name: name.trim(), fixed: false, order: current.length });
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
    const g = current.find(x => x.id === groupId);
    if (!g) return sendResponse({ error: '分组不存在' });
    if (g.fixed) return sendResponse({ error: '固定分组不可重命名' });
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
    const fixed = current.filter(g => g.fixed);
    const ordered = groupIds.map(id => current.find(x => x.id === id)).filter(Boolean);
    for (const g of fixed) {
      if (!ordered.some(x => x.id === g.id)) ordered.unshift(g);
    }
    ordered.forEach((g, i) => g.order = i);
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
    const g = current.find(x => x.id === groupId);
    if (!g) return sendResponse({ error: '分组不存在' });
    if (g.fixed) return sendResponse({ error: '固定分组不可删除' });

    const affected = await storage.getByIndex(storeName, 'groupId', groupId);
    const affectedList = Object.values(affected);
    for (const item of affectedList) {
      item.groupId = defaultGroupId;
    }
    if (affectedList.length > 0) await storage.putBatch(storeName, affectedList);

    const filtered = current.filter(x => x.id !== groupId);
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
  chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', ...message })
    .catch(e => console.warn('[DY] sync progress send failed:', e));
  sendResponse({ ok: true });
}

async function handleSyncWorks(awemeIds, sendResponse) {
  try {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
      return sendResponse({ ok: false, error: 'EMPTY' });
    }

    const requestId = crypto.randomUUID();
    syncSessions.set(requestId, true);

    sendToTab('SYNC_WORKS', { awemeIds, requestId, timeout: CONFIG.TIMEOUT.DEFAULT }, async (resp) => {
      if (!resp || !resp.ok) {
        sendSyncDone(requestId, { ok: false, error: (resp && resp.error) || 'SYNC_FAILED' });
        syncSessions.delete(requestId);
        return;
      }

      const incoming = resp.works || [];
      const errors = resp.errors || [];
      const result = await mergeAndSaveWorks(incoming);
      const refreshed = result.added + result.updated;
      const failedAwemeIds = errors.map(e => e.awemeId).filter(Boolean);

      sendSyncDone(requestId, { ok: true, refreshed, failed: errors.length, failedAwemeIds });
      syncSessions.delete(requestId);
    });

    sendResponse({ ok: true, requestId, total: awemeIds.length });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ---------- 数据工具 ----------

async function reconcileImportGroups(domain, data, items) {
  const importedGroups = data.groups || [];
  if (importedGroups.length === 0) return;
  const groupsName = getGroupsName(domain);
  const def = getDefaultGroups(domain);
  const existingList = await storage.getGroups(groupsName);
  const existing = existingList.length ? existingList : def;
  const fixed = existing.filter(g => g.fixed);
  const imported = importedGroups.filter(g => !g.fixed);
  const existingIds = new Set(existing.map(g => g.id));
  const existingNames = new Map(existing.map(g => [g.name, g.id]));
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
  const merged = [...fixed, ...existing.filter(g => !g.fixed), ...newGroups];
  merged.forEach((g, i) => g.order = i);
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
    const validGroupIds = new Set(currentGroups.map(g => g.id));
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
        version: CONFIG.EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        [cfg.itemKey]: Object.values(items),
        groups: groups.length ? groups : def,
      }
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
      for (const g of (groups || [])) {
        if (g.id !== 'all') groupCounts[g.id] = 0;
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
      }
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ---------- 导航 ----------

function handleOpenDouyinTab() {
  chrome.tabs.create({ url: 'https://www.douyin.com/user/self' });
}
