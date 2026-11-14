// ---------- Sync ----------
import { config, state, services } from '../core.js';
import { dialog } from '../components/dialog.js';
import { taskDock } from '../components/task-dock.js';

// ---------- Sync ----------
class Sync {
  // 从点击到登记期间的防重入（findSecUid 为异步，双击窗口内不重复排队）
  #followingsStarting = false;

  async syncAwemeIds(awemeIds) {
    // B6 队列：不再 BUSY 拒绝，直接入队排队（导航轨「同步」的同 kind 去重由 syncCurrentGroup 承担）
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return;

    const result = await taskDock.launchRemote({
      begin: {
        kind: "syncWorks",
        domain: "works",
        total: awemeIds.length,
        onTrash: (ids) => this.moveFailed(ids),
        // 数据/分组收口由 syncWorks 终态的 STORE_CHANGED 管线统一承担（refreshGroups +
        // renderGroupTabs + 无载荷整域重载兜底），不再传 onDone 重复收口
      },
      queueFullText: "已有同步任务在运行",
      payload: { type: "SYNC_WORKS", awemeIds },
    });
    if (result.bindFailed) return { error: "无法连接后台" };
    if (result.error) return { error: result.error };
    return { taskId: result.response?.taskId || result.taskId };
  }

  async syncCurrentGroup() {
    // 同 kind 去重（B6 队列：与其他域任务并行排队，仅不重复排 syncWorks）
    if (taskDock.isKindBusy("syncWorks")) {
      taskDock.expand();
      return;
    }
    if (state.domain !== "works") return;
    const awemeIds = [...new Set(state.works.map((w) => String(w.awemeId)).filter(Boolean))];
    if (awemeIds.length === 0) return;
    await this.syncAwemeIds(awemeIds);
  }

  // 关注同步：taskId 前置生成并透传，取消走 CANCEL_TASK + 控制端口；
  // 落库由 background createScanWriter 分块确认写承接（关注域无 SAVE_* 消息）。
  // B6 队列：跨域任务不互斥——同步作品暂停期间仍可入队关注同步（队首插队）；
  // 仅同域去重（关注同步/批量校准同属 followings，避免重复排队）。
  async syncFollowings() {
    if (state.domain !== "followings") return;
    if (this.#followingsStarting || taskDock.isDomainBusy("followings")) {
      taskDock.expand();
      return;
    }
    this.#followingsStarting = true;
    try {
      const secUid = await services.findSecUid();
      if (!secUid) {
        dialog.showToast("无法解析本人 sec_uid", "error");
        return;
      }
      // 登记/发送/失败收口由 launchRemote 托管（bindPort 失败已在坞行 fail 呈现）
      await taskDock.launchRemote({
        begin: {
          kind: "syncFollowings",
          domain: "followings",
          total: 0,
          hint: "关注域",
          onTrash: (ids) => this.moveLostFollowings(ids),
          onDone: (msg) => this.#onFollowingsDone(msg),
        },
        payload: { type: "FETCH_FOLLOWING", secUid },
      });
    } catch (err) {
      dialog.showToast("同步关注失败：" + (err.message || String(err)), "error");
    } finally {
      this.#followingsStarting = false;
    }
  }

  // 终态错误码：NO_SIGNATURE 需弹签名引导层，其余由坞内状态/toast 承载。
  #onFollowingsDone(msg) {
    if (msg.error === "NO_SIGNATURE") {
      dialog.showNoSignatureDialog(
        config.URL_USER_SELF + config.URL_FOLLOWING_TAB,
        "关注",
        "同步关注列表",
      );
    }
  }

  async moveFailed(failedIds) {
    return services.moveToTrashGroup("works", failedIds, (gid) =>
      services.bgMsg({ type: "MOVE_WORKS", awemeIds: failedIds, targetGroupId: gid }),
    );
  }

  async moveLostFollowings(lostUids) {
    return services.moveToTrashGroup("followings", lostUids, (gid) =>
      services.moveAuthorRecords("followings", lostUids, gid),
    );
  }
}

export const sync = new Sync();
