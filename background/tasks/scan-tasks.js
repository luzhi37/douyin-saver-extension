// background/tasks/scan-tasks.js — Tab 模式长任务（calibrateAll / calibrateStats / calibrateOne / fetchFollowing / fetchFavorites / fetchCollection / runCancelBatch / importUserWorks / syncWorks / importCandidate，另含短查询 resolveUserProfile / resolveAuthorStats）
// + 扫描分块确认写 createScanWriter（关注/点赞/收藏三扫描 Tab 与独立双模共用，independent-tasks 亦引用）

import { CONFIG, formatters, utils, runtimeConfig } from "../core.js";
import { credentials } from "../identity/credentials.js";
import { independentClient } from "../identity/independent-client.js";
import { tabBridge } from "../identity/tab-bridge.js";
import { storage } from "../data/storage.js";
import { domainStore } from "../data/domain-store.js";
import { runAuthorWorksImport } from "./author-works-import.js";
import { independentTasks } from "./independent-tasks.js";
import { taskRegistry } from "./task-registry.js";

// ---------- ScanTasks ----------
// Tab 模式长任务（经 TabBridge 循环）
class ScanTasks {
  // 关注列表接口返回的 aweme_count/follower_count 是滞后快照值（与主页展示差异大），
  // 逐用户请求 user/profile/other 用权威计数覆盖；列表接口的昵称/头像同样是列表快照，
  // 一并按 profile 权威值刷新（空值保留旧值）——改名不走同步链路，靠校准收口。
  // fetchStats(secUid) 由调用方按模式提供（tab 转发 / 独立直连 / 本类 #fetchProfileUser 双模）；
  // 单条失败静默跳过保留旧值。进度由 report(processed) 回调上报（任务坞 TASK_PROGRESS）。
  // 返回实际处理条数（取消时 < list.length）
  async calibrateStats(list, fetchStats, isCancelled, requestId, report) {
    let processed = 0;
    // 闸门票据取消守卫：同一条车道上排队中的请求在任务取消时被丢弃
    const gateOpts = { priority: 1, gatePriority: 1, isCancelled };
    for (const entry of list) {
      if (isCancelled()) break;
      // 队列接入点 2：暂停请求在此让出
      await taskRegistry.checkpoint(requestId);
      if (isCancelled()) break;
      processed += 1;
      const m = String(entry.profileUrl || "").match(/\/user\/([^/?#]+)/);
      if (m && m[1]) {
        try {
          const stats = await fetchStats(m[1], gateOpts);
          entry.awemeCount = stats.awemeCount;
          entry.followerCount = stats.followerCount;
          // 档案字段（昵称/头像）同 profile 权威值：仅在取到非空值时覆盖，失败/空值保留旧值
          if (stats.nickname) entry.nickname = stats.nickname;
          if (stats.avatarLarger) entry.avatarLarger = stats.avatarLarger;
        } catch (_e) {}
        // 最近更新日期：作品第一页 max(create_time)；失败静默保留旧值（含未校准 0）
        try {
          const t = await this.#fetchLatestWorkTime(m[1], gateOpts);
          if (t) entry.lastUpdateAt = t;
        } catch (_e) {}
      }
      report(processed);
      if (!isCancelled()) {
        await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("syncFollowings")));
      }
    }
    return processed;
  }

  // 单用户校准：打开侧边栏时触发，取 profile/other
  // 权威计数与档案字段（昵称/头像）后直接落库；options 端据返回值更新 state 与可见卡片。
  // domain 区分作者域：followings=原生关注域，candidates=候选域
  async calibrateOne(uid, secUid, domain, sendResponse) {
    try {
      if (!uid || !secUid || !domain) return sendResponse({ ok: false, error: "BAD_PARAMS" });
      const ds = domainStore.facade(domain);
      if (!(await ds.get(String(uid)))) return sendResponse({ ok: false, error: "NOT_FOUND" });
      // 先取数、再单事务补丁：网络等待期间用户可能移动/删除该记录，禁止把读到的
      // 整条旧快照写回（会覆盖 groupId 并复活已删记录）
      const stats = await this.#fetchProfileUser({ secUid });
      const latest = (await this.#fetchLatestWorkTime(secUid).catch(() => 0)) || 0;
      const fields = {
        awemeCount: stats.awemeCount,
        followerCount: stats.followerCount,
      };
      // 档案字段（昵称/头像）同 profile 权威值：仅在取到非空值时覆盖，空值保留旧值
      if (stats.nickname) fields.nickname = stats.nickname;
      if (stats.avatarLarger) fields.avatarLarger = stats.avatarLarger;
      // 最近更新日期：作品第一页 max(create_time)；失败/为 0 时不写，保留旧值
      if (latest) fields.lastUpdateAt = latest;
      await domainStore.patchAuthors(domain, [{ uid: String(uid) }], () => fields);
      const saved = await ds.get(String(uid));
      if (!saved) return sendResponse({ ok: false, error: "NOT_FOUND" });
      sendResponse({ ok: true, ...stats, lastUpdateAt: latest || saved.lastUpdateAt || 0 });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  // 作者域批量校准（工具弹窗手动触发，与同步流程彻底分离）：全部作者逐个取 profile/other
  // 权威计数 + 档案字段（昵称/头像）+ lastUpdateAt，复用 calibrateStats 迭代器（进度经
  // TASK_PROGRESS 上报，取消走 TaskRegistry）；收尾整批 patchAuthors 字段补丁落库——
  // update-only（任务期间被删除的作者不复活）、0 值保护生效、groupId 不参与写回；
  // patched>0 才广播 STORE_CHANGED。取消时已校准部分照常落库（与旧行为一致）。
  async calibrateAll(domain, sendResponse, taskId) {
    // 单实现内部逐条 loadMode()；开头解析一次供 registry.mode 决定 CANCEL_TASK 是否转发页面侧中断
    const mode = (await independentClient.loadMode()) ? "independent" : "tab";
    const kind = domain === CONFIG.STORAGE_KEYS.CANDIDATES ? "calibrateCandidates" : "calibrateFollowings";
    // 启动前校验：空域无需登记任务（直接 ack 错误，坞行由 starter 的 fail 收口）
    const recordMap = await storage.getAll(domain);
    const all = Object.values(recordMap);
    if (all.length === 0) return sendResponse({ ok: false, error: "EMPTY" });

    const task = taskRegistry.start({
      taskId, kind, mode, domain, total: all.length,
    });
    if (!task) return sendResponse({ ok: false, error: "QUEUE_FULL" });
    const requestId = task.taskId;
    const isCancelled = () => taskRegistry.isCancelled(requestId);
    sendResponse({ ok: true, requestId, taskId: requestId, total: all.length, status: task.status });

    const report = (processed) => {
      taskRegistry.update(requestId, { processed });
      utils.emitTaskProgress(requestId, {
        kind, domain, processed, collected: processed, total: all.length,
        phase: "calibrate", elapsed: Date.now() - task.startedAt,
      });
    };
    try {
      // 队列接入点 1：排队/暂停时在此挂起
      await taskRegistry.waitForTurn(requestId);
      const processed = await this.calibrateStats(
        all,
        (secUid, gateOpts) => this.#fetchProfileUser({ secUid, gateOpts }),
        isCancelled,
        requestId,
        report,
      );
      const cancelled = isCancelled();
      // 只回写实际处理过的前缀：取消/中止后未校准条目不参与补丁，避免用启动快照
      // 覆盖任务期间其它入口（侧栏单用户校准）刚写入的值
      const result = await domainStore.patchAuthors(domain, all.slice(0, processed), (f, old) => ({
        // 计数仅在校准取到 >0 值时覆盖（0 值保留旧值），与合并落库同一保护口径
        followerCount: f.followerCount > 0 ? f.followerCount : old.followerCount || 0,
        awemeCount: f.awemeCount > 0 ? f.awemeCount : old.awemeCount || 0,
        lastUpdateAt: f.lastUpdateAt > 0 ? f.lastUpdateAt : old.lastUpdateAt || 0,
        nickname: f.nickname || old.nickname,
        avatarLarger: f.avatarLarger || old.avatarLarger,
      }));
      if (result.patched > 0) utils.sendMessageSafe({ type: "STORE_CHANGED", domain });
      taskRegistry.finish(requestId, { status: cancelled ? "cancelled" : "done" });
      utils.emitTaskDone(requestId, {
        kind, domain, ok: true, cancelled, timedOut: cancelled,
        processed, total: all.length, elapsed: Date.now() - task.startedAt,
        updated: result.patched, changed: result.patched,
      });
    } catch (err) {
      taskRegistry.finish(requestId, { status: "failed", error: err.message });
      utils.emitTaskDone(requestId, {
        kind, domain, ok: false, error: err.message, processed: 0, total: all.length,
        elapsed: Date.now() - task.startedAt, updated: 0, changed: 0,
      });
    }
  }

  // 候选域入库：单请求收录作者档案。与批量入库同一条 mergeAndSaveAuthors 非 import
  // 分支——已在候选域的保留原分组，新作者落「未分组」（记录不预置 groupId）；
  // lastUpdateAt 借校准同款作品第一页采集，失败容忍占位 0
  // 交互式短操作：不登记 TaskRegistry，请求链显式走交互车道（Tab=priority / 独立=
  // gatePriority），只等当前在途请求，不为长任务后续票据让路
  async importCandidate(secUid, sendResponse) {
    try {
      if (!secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
      const gateOpts = { priority: 2, gatePriority: 2 };
      const user = await this.#fetchProfileUser({ secUid, gateOpts });
      if (!user.uid) throw new Error("PROFILE_FETCH_FAILED");
      const record = formatters.formatAuthorFromProfile(user);
      record.lastUpdateAt = (await this.#fetchLatestWorkTime(secUid, gateOpts).catch(() => 0)) || 0;
      const result = await domainStore.mergeAndSaveAuthors(CONFIG.STORAGE_KEYS.CANDIDATES, [record]);
      // 回读落库记录与分组名（merge 内部不回传旧分组）：added=0 即作者已在候选域，
      // 配 groupName 让 toast 能提示「已存在 / 位于哪个组」；单键 + 小列表读取代价可忽略
      const facade = domainStore.facade(CONFIG.STORAGE_KEYS.CANDIDATES);
      const [saved, groupList] = await Promise.all([facade.get(record.uid), facade.getGroups()]);
      const groups = groupList.length ? groupList : domainStore.defaultGroups(CONFIG.STORAGE_KEYS.CANDIDATES);
      const groupName = groups.find((g) => g.id === (saved?.groupId || CONFIG.GROUPS.DEFAULT_ID))?.name || "未分组";
      // 内容真有变化才广播：重复收录同一作者（字段全等）是 no-op，不该触发 options 重载
      if (result.changed > 0) {
        utils.sendMessageSafe({ type: "STORE_CHANGED", domain: CONFIG.STORAGE_KEYS.CANDIDATES });
      }
      sendResponse({ ok: true, candidate: saved || record, added: result.added, updated: result.updated, groupName });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  // 最近更新日期采集：作品列表第一页全部作品 create_time 的最大值（秒 → 毫秒）。
  // 与 fetchStats 同款按模式注入取数；失败返回 0 由调用方静默保留旧值
  async #fetchLatestWorkTime(secUid, gateOpts = null) {
    let works = [];
    if (await independentClient.loadMode()) {
      // 独立分支复用 IndependentTasks.fetchWorksPage 首页取数（同端点同参数，避免第二份
      // POST+formatWork 实现；类间循环 import 靠 live binding 在调用时消解）
      const resp = await new Promise((resolve) =>
        independentTasks.fetchWorksPage(secUid, "", resolve, gateOpts),
      );
      if (resp?.ok && Array.isArray(resp.works)) works = resp.works;
    } else {
      const resp = await tabBridge.sendAsync(
        "FETCH_WORKS_PAGE",
        { secUid, cursor: "", count: CONFIG.PAGE.POST, timeout: CONFIG.TIMEOUT.REQUEST },
        gateOpts || undefined,
      );
      if (resp?.ok && Array.isArray(resp.works)) works = resp.works;
    }
    let max = 0;
    for (const w of works) {
      const t = Number(w.createTime) || 0;
      if (t > max) max = t;
    }
    return max ? max * 1000 : 0;
  }

  // 作者档案取数（双模）：独立直连 profile/other；Tab 转发 FETCH_PROFILE_OTHER。
  // 入参 `{ secUid, uid }` 二选一：uid 走 `user_id`（数字 uid 反查 sec_uid），
  // secUid 走 `sec_user_id`（既有校准/候选入库路径）。
  // 返回归一化 user 摘要（计数 + 档案字段）；原始字段抽取与 inject 侧
  // FETCH_PROFILE_OTHER 结果对象的扁平化保持一致（calibrateOne / importCandidate / resolveUserProfile 共用）
  async #fetchProfileUser({ secUid = "", uid = "", gateOpts = null } = {}) {
    const lookup = uid ? { user_id: String(uid) } : { sec_user_id: secUid };
    if (await independentClient.loadMode()) {
      await credentials.ensureABogus();
      const data = await independentClient.request(
        CONFIG.API.PROFILE_OTHER,
        await credentials.buildBaseParams(lookup),
        gateOpts || undefined,
      );
      if (!data.user) throw new Error("PROFILE_FETCH_FAILED");
      const user = data.user;
      return {
        awemeCount: user.aweme_count || 0,
        followerCount: user.follower_count || 0,
        nickname: user.nickname || "",
        uniqueId: user.unique_id || "",
        avatarLarger: ((user.avatar_larger && user.avatar_larger.url_list) || [])[0] || "",
        uid: String(user.uid || ""),
        secUid: user.sec_uid || secUid,
      };
    }
    const resp = await tabBridge.sendAsync(
      "FETCH_PROFILE_OTHER",
      { secUid, uid, timeout: CONFIG.TIMEOUT.REQUEST },
      gateOpts || undefined,
    );
    if (!resp?.ok) throw new Error(resp?.error || "PROFILE_FETCH_FAILED");
    return {
      awemeCount: resp.awemeCount || 0,
      followerCount: resp.followerCount || 0,
      nickname: resp.nickname || "",
      uniqueId: resp.uniqueId || "",
      avatarLarger: resp.avatarLarger || "",
      uid: String(resp.uid || ""),
      secUid: resp.secUid || secUid,
    };
  }

  // uid → 主页链接（工具弹窗只读查询，双模）：数字 uid 走 profile/other 的 user_id
  // 分支换取 sec_uid，再拼主页 URL。不落库、不广播；3170=uid 不存在，2096=隐私不可见。
  async resolveUserProfile(uid, sendResponse) {
    try {
      const id = String(uid || "").trim();
      if (!/^\d{5,20}$/.test(id)) return sendResponse({ ok: false, error: "BAD_UID" });
      const user = await this.#fetchProfileUser({ uid: id });
      if (!user.secUid) return sendResponse({ ok: false, error: "UID_NOT_FOUND" });
      sendResponse({
        ok: true,
        uid: user.uid || id,
        secUid: user.secUid,
        nickname: user.nickname || "",
        uniqueId: user.uniqueId || "",
        profileUrl: CONFIG.URL_BASE + "/user/" + user.secUid,
      });
    } catch (err) {
      sendResponse({ ok: false, error: this.#mapProfileError(err) });
    }
  }

  // 作者档案统计（侧栏作者头只读查询，双模）：与候选入库/校准共用 #fetchProfileUser
  // 取 profile/other 的权威作品数/粉丝数；不落库、不广播（作者域落库由校准链路负责）
  async resolveAuthorStats(secUid, sendResponse) {
    try {
      const id = String(secUid || "").trim();
      if (!id) return sendResponse({ ok: false, error: "BAD_PARAMS" });
      const user = await this.#fetchProfileUser({ secUid: id });
      if (!user.uid) throw new Error("PROFILE_FETCH_FAILED");
      sendResponse({
        ok: true,
        uid: user.uid,
        nickname: user.nickname || "",
        avatarLarger: user.avatarLarger || "",
        awemeCount: user.awemeCount || 0,
        followerCount: user.followerCount || 0,
      });
    } catch (err) {
      sendResponse({ ok: false, error: this.#mapProfileError(err) });
    }
  }

  // profile/other 错误归一：独立模式 err.statusCode 带业务码，Tab 模式只有 message 文本
  #mapProfileError(err) {
    const msg = err?.message || String(err);
    const m = msg.match(/status_code=(\d+)/);
    const code = Number(err?.statusCode || (m ? m[1] : 0));
    if (code === 3170) return "UID_NOT_FOUND";
    if (code === 2096) return "USER_PRIVATE";
    if (code === 8) return "LOGIN_REQUIRED";
    if (code === 403) return "RATE_LIMITED";
    return msg;
  }

  // 关注同步（Tab）：分块确认写——每累计 SCAN_CHUNK 条单事务 upsert（静默，写后释放
  // 记录本体），丢失检测（结论写）只在完整扫描（无错误收尾）的终态用任务开始时的键集
  // 快照统一执行——中途失败/取消保留已写块、不出结论（回收站纹丝不动），修复旧实现
  // 「部分 collected 误算 lostUids」的假丢失。数据广播仅终态一次裸载荷。终态统一走 TASK_DONE。
  fetchFollowing(secUid, sendResponse, taskId) {
    return this.#paginate({
      fetchPage: "FETCH_FOLLOWING_PAGE",
      kind: "syncFollowings",
      delayKind: "syncFollowings",
      pageSize: CONFIG.PAGE.FOLLOWING,
      extra: { secUid },
      persist: CONFIG.STORAGE_KEYS.FOLLOWINGS,
      pageKey: "offset", // inject 侧 FETCH_FOLLOWING_PAGE 解构 offset 键
      shape: "followings",
      totalFallback: true,
      sendResponse,
      taskId,
    });
  }

  // 关注/点赞/收藏分页扫描通用循环（Tab）：三者仅消息名/延迟档/页大小/游标键/收尾形状不同。
  // 任务坞统一生命周期：start（全局单飞）→ 立即 ack → TASK_PROGRESS（逐页计数）→
  // 分块确认写 → 终态结论 → TASK_DONE。首段/进度/收尾由 startScanTask/makeScanReporter/
  // finishScanTask 共用壳承担（取消/失败保留已写块、结论写仅完整扫描——
  // 完整扫描返回 0 条同样构成完整结论：账号确无点赞/收藏 → 存量全部判丢失）。
  // 落库为分块确认写（静默，每 SCAN_CHUNK 条单事务 upsert，savedAt 戳收集时按全局下标
  // 分配保主页序，写后释放内存）；数据广播仅终态一次裸载荷（不带 id 集：万级 id 集超
  // GRID_PREMOUNT_CAP 会被 options 丢弃，纯浪费）。
  async #paginate({ fetchPage, kind, delayKind, pageSize, extra = {}, persist, pageKey = "cursor", shape = "works", totalFallback = false, sendResponse, taskId }) {
    const task = await startScanTask({ taskId, kind, mode: "tab", domain: persist, sendResponse });
    if (!task) return sendResponse({ ok: false, error: "QUEUE_FULL" });
    const requestId = task.taskId;
    const isCancelled = () => taskRegistry.isCancelled(requestId);

    const writer = createScanWriter(persist);
    let cursor = 0;
    let hasMore = true;
    let lastError = "";
    let total = 0;
    const report = makeScanReporter(requestId, task, kind, persist, writer);
    try {
      // 键集快照在 try 内取（IDB 异常走 catch 收尾，防 RUNNING 泄漏卡死 isBusy 门禁）
      await writer.snapshot();
      while (hasMore && !isCancelled()) {
        // 队列接入点 2：暂停请求在此让出（挂起前冲刷当前块）
        await taskRegistry.checkpoint(requestId, { onSuspend: () => writer.flush() });
        if (isCancelled()) break;
        const resp = await tabBridge.sendAsync(
          fetchPage,
          { ...extra, [pageKey]: cursor, count: pageSize, timeout: CONFIG.TIMEOUT.REQUEST },
          { priority: 1, isCancelled },
        );
        if (isCancelled()) break;
        if (resp?.ok && Array.isArray(resp.items)) {
          for (const w of resp.items) {
            if (w && w[writer.ds.idField]) await writer.add(w);
          }
          hasMore = resp.hasMore === true;
          cursor = resp.cursor || cursor;
          total = Number(resp.total) || 0;
        } else {
          lastError = resp?.error || "FETCH_FAILED";
          break;
        }
        report(total, hasMore);
        if (hasMore && !isCancelled()) {
          await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay(delayKind)));
        }
      }
      return finishScanTask({
        requestId, task, kind, domain: persist, writer,
        lastError, total, totalFallback, shape,
      });
    } catch (err) {
      return finishScanTask({
        requestId, task, kind, domain: persist, writer,
        lastError: err.message, total, totalFallback, shape,
      });
    }
  }

  fetchFavorites(secUid, persist, sendResponse, taskId) {
    return this.#paginate({
      fetchPage: "FETCH_FAVORITES_PAGE",
      kind: "scanFavorites",
      delayKind: "syncFavorites",
      pageSize: CONFIG.PAGE.FAVORITE,
      extra: { secUid },
      persist,
      sendResponse,
      taskId,
    });
  }

  fetchCollection(persist, sendResponse, taskId) {
    return this.#paginate({
      fetchPage: "FETCH_COLLECTION_PAGE",
      kind: "scanCollections",
      delayKind: "syncCollection",
      pageSize: CONFIG.PAGE.COLLECTION,
      persist,
      sendResponse,
      taskId,
    });
  }

  // 作者作品批量入库（Tab 模式）：FETCH_WORKS_PAGE 取页器 + runAuthorWorksImport 共用循环壳。
  // 与收藏扫描（#paginate）的差异：
  // 1. 响应字段是 works/maxCursor 而非 items/cursor，不能直接套用 #paginate；
  // 2. 无丢失检测——他人作品列表不是本域全集，扫描式丢失检测会把存量误判 lost；
  // 3. 每页即落库，取消/异常保留已扫部分（落库/进度/去重/收尾在共用壳内）。
  async importUserWorks(secUid, sendResponse, taskId) {
    return runAuthorWorksImport(
      secUid,
      async (cursor, isCancelled) => {
        const resp = await tabBridge.sendAsync(
          "FETCH_WORKS_PAGE",
          { secUid, cursor, count: CONFIG.PAGE.POST, timeout: CONFIG.TIMEOUT.REQUEST },
          { priority: 1, isCancelled },
        );
        if (!resp?.ok || !Array.isArray(resp.works)) throw new Error(resp?.error || "FETCH_FAILED");
        return {
          works: resp.works,
          hasMore: resp.hasMore === true,
          maxCursor: resp.maxCursor,
          total: resp.total || 0,
        };
      },
      sendResponse,
      taskId,
      "tab",
    );
  }

  // 批量「取消并移除」（Tab）：任务坞统一生命周期，终态走 TASK_DONE；循环壳/分块确认删
  // 见 runCancelTask（与独立模式共用）
  runCancelBatch(awemeIds, tabType, persistDomain, sendResponse, taskId) {
    return runCancelTask({
      mode: "tab",
      awemeIds,
      kind: tabType === "CANCEL_ONE_FAVORITES" ? "cancelFavorites" : "cancelCollections",
      domain: persistDomain,
      sendResponse,
      taskId,
      cancelOne: async (awemeId, isCancelled) =>
        tabBridge.sendAsync(
          tabType,
          { awemeId, timeout: CONFIG.TIMEOUT.REQUEST },
          { priority: 1, isCancelled },
        ),
    });
  }

  async syncWorks(awemeIds, sendResponse, taskId = null) {
    return runSyncWorks({
      mode: "tab",
      awemeIds,
      sendResponse,
      taskId,
      // Tab 模式与独立模式共用同一条请求车道：间隔取同一 runtimeConfig 键，
      // 排队期间取消则 sendAsync 直接回 CANCELLED
      fetchOne: async (awemeId, isCancelled) => {
        let resp;
        try {
          resp = await tabBridge.sendAsync(
            "FETCH_WORK_DETAIL",
            { awemeId, timeout: CONFIG.TIMEOUT.REQUEST },
            { priority: 1, interval: runtimeConfig.randomDelay("syncWorks"), isCancelled },
          );
        } catch (err) {
          resp = { ok: false, error: err?.message || "CANCELLED" };
        }
        if (!resp?.ok) throw new Error(resp?.error || "UNKNOWN");
        return { work: resp.work || null };
      },
    });
  }
}
const scanTasks = new ScanTasks();

// ---------- 扫描分块确认写（关注/点赞/收藏三任务共用） ----------
// 「确认写」与「结论写」解耦的落库器：每累计 SCAN_CHUNK 条单事务 upsert（静默，不发
// STORE_CHANGED——数据广播仅终态一次裸载荷），flush 后释放记录本体，内存峰值 = 一块 + 键集。
// savedAt 戳在收集时按任务级 baseTime − 全局下标分配：跨块一致，savedAt desc = 主页序
//（followings 仅新记录取戳——mergeAndSaveAuthors 的 old?.savedAt ?? stamps 口径不变；
// 点赞/收藏全量取戳重排，与旧 persistScan stamps 语义一致）。
// 丢失检测基准（起始键集快照）在任务开始时 snapshot() 一次；lostIds() 由调用方仅在
// 完整扫描的终态调用——分块确认写路径绝不产生丢失结论（部分拉取误算 lostUids 已定案废除）。
function createScanWriter(domain) {
  const ds = domainStore.facade(domain);
  const isAuthor = CONFIG.AUTHOR_RECORD_DOMAINS.includes(domain);
  return {
    ds,
    chunkSize: Math.max(1, Number(CONFIG.SYNC.SCAN_CHUNK) || 200),
    oldKeys: [],
    keys: new Set(), // 本次扫描收集到的主键集（终态 lost = oldKeys − keys）
    stamps: new Map(), // 主键 → savedAt（收集时分配，flush 后摘除已写项）
    chunk: [], // 待写缓冲（flush 即释放）
    idx: 0, // 全局下标（主页序戳）
    baseTime: 0,
    collected: 0,
    added: 0,
    updated: 0,
    changed: 0,
    // 任务开始时快照域键集（丢失检测基准）与戳基准时间
    async snapshot() {
      this.oldKeys = await ds.getAllKeys();
      this.baseTime = Date.now();
    },
    // 收集一条：记键 + 分配主页序戳 + 入块缓冲，满块即落库
    async add(item) {
      const id = String(item[ds.idField]);
      this.keys.add(id);
      this.stamps.set(id, this.baseTime - this.idx++);
      this.chunk.push(item);
      this.collected++;
      if (this.chunk.length >= this.chunkSize) await this.flush();
    },
    // 单事务 upsert 当前块（静默）；块戳表建后从全局表摘除，跨块只留未写项
    async flush() {
      if (this.chunk.length === 0) return;
      const batch = this.chunk.splice(0, this.chunk.length);
      const stamps = new Map();
      for (const x of batch) {
        const id = String(x[ds.idField]);
        stamps.set(id, this.stamps.get(id));
        this.stamps.delete(id);
      }
      const r = isAuthor
        ? await domainStore.mergeAndSaveAuthors(domain, batch, { lost: false, stamps })
        : await domainStore.mergeAndSave(domain, batch, { stamps });
      this.added += r.added;
      this.updated += r.updated;
      this.changed += r.changed;
    },
    // 结论写：丢失 = 起始键集 − 收集键集。仅完整扫描的终态调用
    lostIds() {
      return this.oldKeys.filter((k) => !this.keys.has(String(k)));
    },
  };
}

// ---------- 取消任务分块确认删（runCancelBatch / independentTasks.cancel 共用） ----------
// 与扫描族分块确认写同构的删除侧落库器：远端取消成功的 id 进缓冲，满 SYNC.SCAN_CHUNK 条
// 单事务 deleteBatch（静默，无广播）；删除按块推进——任务失败/被杀已删块不回滚、未删块
// 保留本地（远端状态与本地一致），不产生「远端已取消、本地还在」的僵尸记录。终态冲刷余块
// 后由调用方按 deletedIds>0 裸广播一次 STORE_CHANGED。
function createCancelWriter(domain) {
  const ds = domainStore.facade(domain);
  return {
    chunkSize: Math.max(1, Number(CONFIG.SYNC.SCAN_CHUNK) || 200),
    deletedIds: [], // 已确认删除的全部 id（终态 TASK_DONE 载荷，实删数）
    chunk: [], // 待删缓冲（flush 即释放）
    // 远端取消成功：入缓冲，满块即删（未满块返回已解决 Promise，循环内统一 await）
    push(awemeId) {
      this.chunk.push(String(awemeId));
      if (this.chunk.length >= this.chunkSize) return this.flush();
      return Promise.resolve();
    },
    // 单事务 deleteBatch 当前块；块失败仅告警、不阻断循环（该块保留本地，可经再次取消幂等自愈）
    async flush() {
      if (this.chunk.length === 0) return;
      const ids = this.chunk.splice(0, this.chunk.length);
      try {
        await ds.deleteBatch(ids);
        this.deletedIds.push(...ids);
      } catch (err) {
        console.warn("[DY] delete cancelled chunk failed:", ids.length, err.message);
      }
    },
  };
}

// 双模 syncWorks 共用 checkpoint：字段补丁落库（静默，三族统一——数据广播仅终态一次裸载荷，
// 由调用方在终态/异常收口按 changed>0 发出）。补丁保留 groupId/savedAt 且 update-only，
// 用户删除/移动不会被同步覆盖
async function flushSyncWorks(pending) {
  if (!pending || pending.length === 0) return 0;
  const batch = pending.splice(0, pending.length);
  const res = await domainStore.patchWorks(CONFIG.STORAGE_KEYS.WORKS, batch);
  return res.patched;
}

// 双模 syncWorks 共用收尾：checkpoint 已落库，这里只回终态（不再整批 mergeAndSave）。
// 全部成功但没有任何变化也视为完成：同步的价值是「校验链接仍可用」，不写库不代表没跑。
// processed = 已判定条数（ok+failed，循环不变量 ==i）：取消/熔断退出时 < total，未判定部分以 skipped 回报
function finishSyncWorks(
  requestId,
  { processed = 0, total = 0, refreshed = 0, failed = 0, failedAwemeIds = [], skipped = 0, changed = 0, error = "", cancelled = false } = {},
) {
  const fatal = error || (refreshed === 0 && failed === 0 && skipped === 0 ? "NO_WORKS_COLLECTED" : "");
  utils.emitTaskDone(requestId, {
    kind: "syncWorks", domain: CONFIG.STORAGE_KEYS.WORKS,
    ok: !fatal, cancelled,
    processed, total,
    refreshed, failed, failedAwemeIds, skipped, changed, error: fatal,
  });
}

// ---------- 双模共用任务壳（syncWorks / 批量取消 / 扫描族首尾） ----------
// start 返回 null 即队满：统一 ack QUEUE_FULL（域互斥闸门——导入/重置/模式切换——另行回 BUSY）

// 扫描族公共首段：登记入队 → 立即 ack → 队列接入点 1（排队/暂停时在此挂起）。
// 返回 null = 队满（调用方 ack QUEUE_FULL）
async function startScanTask({ taskId, kind, mode, domain, total = 0, sendResponse }) {
  const task = taskRegistry.start({ taskId, kind, mode, domain, total });
  if (!task) return null;
  sendResponse({ ok: true, requestId: task.taskId, taskId: task.taskId, total, status: task.status });
  // 队列接入点 1：排队/暂停时在此挂起
  await taskRegistry.waitForTurn(task.taskId);
  return task;
}

// 扫描族公共进度上报：processed = writer.collected；total/hasMore 由循环推进后传入
function makeScanReporter(requestId, task, kind, domain, writer) {
  return (total, hasMore) => {
    taskRegistry.update(requestId, { processed: writer.collected, total });
    utils.emitTaskProgress(requestId, {
      kind, domain, processed: writer.collected, collected: writer.collected,
      total, hasMore, elapsed: Date.now() - task.startedAt,
    });
  };
}

// 扫描族公共收尾：冲刷余块 → 取消/失败判定 → 结论写（丢失检测仅完整扫描执行，部分扫描
// 不出结论——回收站纹丝不动）→ 终态一次裸广播 → finish + TASK_DONE。
// shape: "followings" = 扁平 added/updated/changed + lost 计数 + total 兜底 collected；
//        "works"      = saved:{} 聚合（点赞/收藏扫描族）。timedOut 仅对 partialOnCancel
//        族生效，followings 族携带为冗余对齐（KIND_CONFIG 无该旗标则忽略）。
// lastError 传异常消息即为失败收尾（冲刷容错吞错防次生异常掩盖原错误）；取消判定统一读
// isCancelled——排队等待期被取消的异常终态如实报 cancelled（修复旧 failScanTask 强制
// failed 的误报），真失败路径 isCancelled 恒为 false，终态载荷不变
async function finishScanTask({ requestId, task, kind, domain, writer, lastError = "", total, totalFallback = false, shape }) {
  const cancelled = taskRegistry.isCancelled(requestId);
  // 终态冲刷余块（取消/失败同样保留已抓部分）；正常收尾路径冲刷异常上抛由调用方 catch 兜底
  await writer.flush().catch((e) => {
    if (!cancelled && !lastError) throw e;
  });
  // 任何非取消取数失败（含中途页失败）都以 failed 收口：扫描未完整跑完必须如实呈现，
  // 不得带着部分数据静默「done」（部分拉取误算 lostUids 已定案废除）
  const failed = !cancelled && Boolean(lastError);
  // 结论写：丢失检测仅完整扫描执行（!cancelled && !lastError 即 hasMore:false 收尾）
  const lostUids = !cancelled && !lastError ? writer.lostIds() : [];
  if (writer.changed > 0) utils.sendMessageSafe({ type: "STORE_CHANGED", domain });
  const status = failed ? "failed" : cancelled ? "cancelled" : "done";
  const doneTotal = totalFallback ? total || writer.collected : total;
  taskRegistry.update(requestId, { processed: writer.collected, total: doneTotal });
  taskRegistry.finish(requestId, { status, error: failed ? lastError : "" });
  const base = {
    kind, domain, ok: !failed, cancelled, timedOut: cancelled,
    error: failed ? lastError : "", processed: writer.collected, total: doneTotal,
    elapsed: Date.now() - task.startedAt,
  };
  utils.emitTaskDone(
    requestId,
    shape === "followings"
      ? { ...base, added: writer.added, updated: writer.updated, changed: writer.changed, lost: lostUids.length, lostUids }
      : { ...base, saved: { added: writer.added, updated: writer.updated, changed: writer.changed }, lostUids },
  );
}

// syncWorks 双模共用循环壳：逐条取详情 → 块满字段补丁落库 → report → 批间暂停。
// 双模差异收敛在 fetchOne(awemeId, isCancelled) 注入：返回 { work }（null = 响应成功但
// 无详情，计一条失败）；请求错误 throw Error(message)，message 即错误码。错误分类单一
// 出处：CANCELLED 仅本任务真被取消时中止（Tab 页面侧中断是 taskId-less 全局单槽，可能由
// 其他任务的取消转发触发，不得误杀）；RATE_LIMITED/HTTP 429 退避重试同一条，连续达上限
// 熔断；isFatalTaskError 命中中止、在途+剩余计入 skipped；其余记一条失败继续；独立模式
// AbortError 归一为 TIMEOUT（非致命）
async function runSyncWorks({ mode, awemeIds, sendResponse, taskId, preflight = null, fetchOne }) {
  if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
    return sendResponse({ ok: false, error: "EMPTY" });
  }
  const task = taskRegistry.start({
    taskId, kind: "syncWorks", mode, domain: CONFIG.STORAGE_KEYS.WORKS, total: awemeIds.length,
  });
  if (!task) return sendResponse({ ok: false, error: "QUEUE_FULL" });

  const requestId = task.taskId;
  const total = awemeIds.length;
  let acked = false;
  const pending = [];
  const failedAwemeIds = [];
  let ok = 0,
    failed = 0,
    skipped = 0,
    changed = 0,
    fatalError = "",
    rateLimitHits = 0;

  // 分块确认写：每 SYNC.SCAN_CHUNK 条（四族统一块大小）把已取到的记录以字段补丁落库。
  // update-only + 未变化不写，既不会复活用户删掉的记录，也不会打废作者视图的代际
  const flush = async () => {
    changed += await flushSyncWorks(pending);
  };
  const isCancelled = () => taskRegistry.isCancelled(requestId);
  // 暂停也是取消感知：批间长暂停期间按「暂停」提前让出，随即在 checkpoint 挂起
  const pauseAware = () => isCancelled() || taskRegistry.isPauseRequested(requestId);
  // 进度逐条上报（与取消族同节奏，消息速率 ≈ 条目速率，由 RequestGate 间隔约束）；
  // rateLimited 恒在载荷中（普通上报 false）保证坞行的限流瞬态可靠复位，extra 由限速分支覆写
  const report = (index, extra = {}) => {
    taskRegistry.update(requestId, { processed: index + 1, ok, failed, skipped, changed });
    utils.emitTaskProgress(requestId, {
      kind: "syncWorks", domain: CONFIG.STORAGE_KEYS.WORKS,
      processed: index + 1, total, ok, failed, skipped, changed,
      rateLimited: false, elapsed: Date.now() - task.startedAt, ...extra,
    });
  };
  // 单条错误分类（异常与响应 error 双入口归一后共用）：返回 "break" | "retry" | "fail"
  const classifyError = async (errMsg, index) => {
    if (errMsg === "CANCELLED") return isCancelled() ? "break" : "fail";
    if (errMsg === "RATE_LIMITED" || errMsg.startsWith("HTTP 429")) {
      rateLimitHits++;
      if (rateLimitHits < CONFIG.SYNC.RATE_LIMIT_RETRY_MAX) {
        const backoff = Math.min(
          CONFIG.SYNC.RATE_LIMIT_BACKOFF_MAX,
          CONFIG.SYNC.RATE_LIMIT_BACKOFF * 2 ** (rateLimitHits - 1),
        );
        // 限流状态立即上报：坞行徽标 RATE_LIMITED + 摘要「退避重试中」；
        // processed 停在 index——在途条目尚未判定，不计入已同步
        report(index - 1, { rateLimited: true });
        await utils.sleepWithKeepalive(backoff);
        return "retry"; // for 自增抵消，重试同一条
      }
    }
    rateLimitHits = 0;
    // 熔断/系统错误 = 中止而非作品无效：在途条目从未判定（限流≠该作品失效），与剩余
    // 条目一并计入 skipped；非本任务引发的 CANCELLED 不进入致命分类（它在 FATAL_ERRORS
    // 里），按普通失败计数
    if (errMsg !== "CANCELLED" && utils.isFatalTaskError(errMsg)) {
      fatalError = fatalError || errMsg;
      report(index - 1);
      return "break";
    }
    return "fail";
  };

  try {
    if (preflight) await preflight();
    // 先置位再 ack：sendResponse 自身抛错时 catch 不能再尝试一次，但必须照常收尾任务
    acked = true;
    sendResponse({ ok: true, requestId, taskId: requestId, total, status: task.status });
    // 队列接入点 1：排队/暂停时在此挂起（sendResponse 已 ack，循环现场保留）
    await taskRegistry.waitForTurn(requestId);
    let i = 0;
    for (; i < total && !isCancelled(); i++) {
      // 队列接入点 2：暂停请求在此让出——先落库 checkpoint，再挂起给插队任务让路
      await taskRegistry.checkpoint(requestId, { onSuspend: flush });
      if (isCancelled()) break;
      try {
        const { work } = await fetchOne(awemeIds[i], isCancelled);
        if (work) {
          pending.push(work);
          ok++;
          rateLimitHits = 0;
        } else {
          failed++;
          failedAwemeIds.push(awemeIds[i]);
        }
      } catch (e) {
        const errMsg = e && e.name === "AbortError" ? "TIMEOUT" : String(e?.message || e || "UNKNOWN");
        const verdict = await classifyError(errMsg, i);
        if (verdict === "break") break;
        if (verdict === "retry") {
          i--; // for 自增抵消，重试同一条
          continue;
        }
        failed++;
        failedAwemeIds.push(awemeIds[i]);
      }
      if (pending.length >= CONFIG.SYNC.SCAN_CHUNK) await flush();
      report(i);
      if (!isCancelled()) {
        await utils.pauseWithKeepalive(i, total, "syncWorks", { pace: false, isCancelled: pauseAware });
      }
    }
    // 中止路径（取消/熔断）与正常退出共用同一口径：i 起全部未判定 → skipped
    if (i < total) skipped += total - i;
    await flush();
    // 终态一次裸广播（三族统一：不带 id 集，万级 id 集超 GRID_PREMOUNT_CAP 会被 options 丢弃）
    if (changed > 0) utils.sendMessageSafe({ type: "STORE_CHANGED", domain: CONFIG.STORAGE_KEYS.WORKS });
    const wasCancelled = isCancelled();
    const status = wasCancelled ? "cancelled" : fatalError ? "failed" : "done";
    // 终态快照 processed = 已判定数（取消/熔断时 < total，与 runCancelTask 的 attempted 同口径）
    taskRegistry.update(requestId, { processed: ok + failed, ok, failed, skipped, changed });
    taskRegistry.finish(requestId, { status, error: fatalError });
    finishSyncWorks(requestId, {
      processed: ok + failed,
      total,
      refreshed: ok,
      failed,
      failedAwemeIds,
      skipped,
      changed,
      error: fatalError,
      cancelled: wasCancelled,
    });
  } catch (e) {
    const errMsg = String(e?.message || e || "UNKNOWN");
    await flush().catch(() => {});
    if (changed > 0) utils.sendMessageSafe({ type: "STORE_CHANGED", domain: CONFIG.STORAGE_KEYS.WORKS });
    if (!acked) sendResponse({ ok: false, error: errMsg });
    taskRegistry.finish(requestId, { status: "failed", error: errMsg });
    utils.emitTaskDone(requestId, {
      kind: "syncWorks", domain: CONFIG.STORAGE_KEYS.WORKS,
      ok: false, error: errMsg,
      processed: ok + failed, total,
      refreshed: ok, failed, skipped, changed, failedAwemeIds,
    });
  }
}

// 批量「取消并移除」双模共用循环壳：逐条远端取消 → 分块确认删（createCancelWriter：
// 远端成功 id 进缓冲满块即删，失败/被杀无僵尸记录、无假已取消结论——未发送尾部条目本地
// 保留）→ 终态冲刷余块 → STORE_CHANGED 仅终态一次（deletedIds>0）。取数差异收敛在
// cancelOne(awemeId) 注入，返回 { ok, error? }（Tab 车道 CANCELLED = 页面中断未完成，
// 不计成功也不计失败；独立直连无该形态）
async function runCancelTask({ mode, awemeIds, kind, domain, sendResponse, taskId, cancelOne }) {
  if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
    return sendResponse({ ok: false, error: "EMPTY" });
  }
  const task = taskRegistry.start({ taskId, kind, mode, domain, total: awemeIds.length });
  if (!task) return sendResponse({ ok: false, error: "QUEUE_FULL" });
  const requestId = task.taskId;
  const isCancelled = () => taskRegistry.isCancelled(requestId);
  sendResponse({ ok: true, requestId, taskId: requestId, total: awemeIds.length, status: task.status });
  // 队列接入点 1：排队/暂停时在此挂起
  await taskRegistry.waitForTurn(requestId);

  const errors = [];
  let attempted = 0; // 已结算条数（report 恰调一次/条）：终态 processed 用，cancelled 时 < total
  const total = awemeIds.length;
  const report = (index, stepStatus, awemeId) => {
    attempted = index + 1;
    taskRegistry.update(requestId, { processed: index + 1, failed: errors.length });
    utils.emitTaskProgress(requestId, {
      kind, domain, processed: index + 1, total,
      index, stepStatus, awemeId, failed: errors.length,
      elapsed: Date.now() - task.startedAt,
    });
  };
  const writer = createCancelWriter(domain);
  const done = (status, error = "") => {
    // 终态一次裸广播（已删部分如实上报，failed 路径不回滚）；仅 deletedIds>0 才发
    if (writer.deletedIds.length > 0) {
      utils.sendMessageSafe({ type: "STORE_CHANGED", domain });
    }
    taskRegistry.finish(requestId, { status, error });
    utils.emitTaskDone(requestId, {
      kind, domain, ok: status !== "failed",
      cancelled: status === "cancelled", error,
      processed: attempted, total,
      elapsed: Date.now() - task.startedAt,
      refreshed: writer.deletedIds.length,
      failed: errors.length, failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
      deletedIds: writer.deletedIds,
    });
  };
  try {
    for (let i = 0; i < total && !isCancelled(); i++) {
      // 队列接入点 2：暂停请求在此让出（挂起前冲刷待删块，与扫描族 checkpoint 落库同口径）
      await taskRegistry.checkpoint(requestId, { onSuspend: () => writer.flush() });
      if (isCancelled()) break;
      const result = await cancelOne(awemeIds[i], isCancelled);
      // 分块确认删：远端成功 id 进缓冲满块即删（在途条目取消时同样结算）
      if (result.ok) {
        await writer.push(awemeIds[i]);
        report(i, "ok", awemeIds[i]);
      } else if (result.error !== "CANCELLED") {
        errors.push({ awemeId: awemeIds[i], error: result.error || "FAILED" });
        report(i, "error", awemeIds[i]);
      }
      if (isCancelled()) break;
      if (i < total - 1) {
        await new Promise((r) =>
          setTimeout(r, runtimeConfig.randomDelay(kind === "cancelCollections" ? "cancelCollection" : "cancelFavorites")),
        );
      }
    }
    // 终态冲刷余块（取消/异常同样保留已删部分），广播在 done() 内统一收口
    await writer.flush();
    return done(isCancelled() ? "cancelled" : "done");
  } catch (err) {
    // 异常路径同样冲刷已删部分（真实删除无假结论，不回滚），残差与取消同口径
    await writer.flush().catch(() => {});
    return done("failed", err.message);
  }
}

export {
  scanTasks,
  createScanWriter,
  createCancelWriter,
  runSyncWorks,
  runCancelTask,
  startScanTask,
  makeScanReporter,
  finishScanTask,
};
