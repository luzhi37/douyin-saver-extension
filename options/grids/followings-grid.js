// ---------- FollowingsGrid ----------
import { config, dom, state, utils } from '../core.js';
import { VirtualGrid } from './virtual-grid.js';
import { search } from '../components/search-bar.js';
import { batch } from '../data/batch.js';
import { detail } from '../components/detail.js';
import { sidebar } from '../components/sidebar.js';

// ---------- FollowingsGrid ----------
// 与 search-bar/batch/detail/sidebar 存在循环 import（它们各自反向引用本模块）：单例引用全部
// 发生在方法体内、模块图完全求值之后才被触达，靠 ES live binding 安全消解（AGENTS.md 设计例外）
class FollowingsGrid extends VirtualGrid {
  // 头像分帧队列，避免同步赋 src 触发批量网络/解码调度
  #avatarQueue = [];
  #avatarDrainRafId = 0;
  constructor() {
    super({
      container: dom.mainContainer,
      itemClass: "following-card",
      skeletonClass: "following-skeleton",
      itemKey: "uid",
      emptyMsg: "还没有保存的关注者",
      emptyHint: "点击菜单「同步」获取你的关注列表",
    });
  }

  renderFollowingCards(view = search.getFollowingsView()) {
    // 筛选态同作品域降档预铺（GRID_PREMOUNT_CAP_FILTER）：关注域虽单发全量加载，筛选
    // 切换同样全量拆建，预铺数直接决定切换 DOM 成本；余量滚近底部键控扩容补齐
    const filtered = search.isFilterActive();
    const premountCap = filtered ? config.GRID_PREMOUNT_CAP_FILTER : config.GRID_PREMOUNT_CAP;
    if (filtered) {
      this.render(view, "没有符合筛选条件的关注者", "调整搜索关键词后重试", 0, premountCap);
    } else {
      this.render(view, "还没有保存的关注者", "点击菜单「同步」获取你的关注列表", 0, premountCap);
    }
  }

  fillCard(card, following) {
    card.classList.remove(this.skeletonClass);
    card.dataset.uid = following.uid;

    let checkbox = card.querySelector(".following-checkbox");
    if (!checkbox) {
      // 骨架模板不含勾选框：避免批量模式一次性对上千个骨架做样式重排/重绘，仅在卡片填充时创建
      checkbox = document.createElement("div");
      checkbox.className = "following-checkbox";
      checkbox.setAttribute("role", "checkbox");
      checkbox.setAttribute("aria-checked", "false");
      checkbox.setAttribute("aria-label", "选择关注者");
      card.prepend(checkbox);
    }
    batch.updateCheckboxDOM(checkbox, state.selectedIds.has(following.uid));

    const avatar = card.querySelector(".following-avatar");
    const fallback = card.querySelector(".following-avatar-fallback");
    this.#bumpFillGen(card);
    avatar.classList.add("media-loading");
    avatar.style.display = "";
    fallback?.classList.add("hidden");

    const avatarUrl = following.avatarLarger || following.avatar || "";
    if (avatarUrl) this.#enqueueAvatar(avatar, avatarUrl, following.nickname, card.dataset.fillGen);
    else this.#showAvatarFallback(avatar, fallback, following.nickname);

    card.querySelector(".following-nickname").textContent = following.nickname || "未知";
    card.querySelector(".stat-followers").textContent = utils.formatCount(following.followerCount) + " 粉丝";
    card.querySelector(".stat-works").textContent = utils.formatCount(following.awemeCount) + " 作品";
    card.querySelector(".following-update").textContent = "最近更新 " + utils.formatUpdateTime(following.lastUpdateAt);
  }

  // 头像不可用时的占位：灰底圆圈换为昵称首字，不再让头像凭空消失
  #showAvatarFallback(avatar, fallback, nickname) {
    avatar.classList.remove("media-loading");
    avatar.style.display = "none";
    avatar.style.backgroundImage = "";
    if (!fallback) return;
    const initial = (nickname || "").trim().charAt(0).toUpperCase();
    fallback.textContent = initial || "?";
    fallback.classList.remove("hidden");
  }

  // 填充代际：卡片每次重填/降级自增，使在途探针结果过期作废，防止跨代提交旧 URL
  #bumpFillGen(card) {
    card.dataset.fillGen = String((Number(card.dataset.fillGen) || 0) + 1);
  }
  #avatarTargetAlive(img, gen) {
    if (!img.isConnected || img.closest(".following-skeleton")) return false;
    const card = img.closest(".following-card");
    return !!card && card.dataset.fillGen === gen;
  }

  // 原地还原骨架：清内容与占位样式由 .following-skeleton 类接管，根节点保留
  clearCard(card) {
    this.#bumpFillGen(card); // 在途探针立即作废
    const avatar = card.querySelector(".following-avatar");
    if (avatar) {
      avatar.style.backgroundImage = "";
      avatar.style.display = "";
      avatar.classList.remove("media-loading");
    }
    card.querySelector(".following-avatar-fallback")?.classList.add("hidden");
    card.querySelector(".following-nickname").textContent = "";
    card.querySelector(".stat-followers").textContent = "";
    card.querySelector(".stat-works").textContent = "";
    card.querySelector(".following-update").textContent = "";
    // 降级即移除勾选框（同 works-grid.clearCard：防勾选框随浏览量无界累积，回填时重建）
    card.querySelector(".following-checkbox")?.remove();
  }

  // 头像分帧预载：离屏探针先行请求，只有成功的 URL 才提交给头像节点。
  // 头像是 div+background-image：背景图失败时浏览器不绘制任何占位图标，断裂图在元素层面失去载体
  #enqueueAvatar(img, url, nickname, gen) {
    this.#avatarQueue.push({ img, url, nickname, gen });
    this.#scheduleAvatarDrain();
  }
  #scheduleAvatarDrain() {
    if (this.#avatarDrainRafId) return;
    this.#avatarDrainRafId = requestAnimationFrame(() => {
      this.#avatarDrainRafId = 0;
      let n = 0;
      while (this.#avatarQueue.length && n < config.SIDEBAR_IMG_PER_FRAME) {
        const { img, url, nickname, gen } = this.#avatarQueue.shift();
        if (!this.#avatarTargetAlive(img, gen)) continue;
        const probe = new Image();
        probe.onload = () => {
          if (!this.#avatarTargetAlive(img, gen)) return; // 已重填/降级，结果作废
          img.style.backgroundImage = utils.cssUrl(url);
          img.classList.remove("media-loading");
          detail.markMediaOk();
        };
        probe.onerror = () => {
          if (!this.#avatarTargetAlive(img, gen)) return;
          detail.markMediaFail();
          const card = img.closest(".following-card");
          this.#showAvatarFallback(img, card?.querySelector(".following-avatar-fallback"), nickname);
        };
        probe.src = url;
        n++;
      }
      if (this.#avatarQueue.length) this.#scheduleAvatarDrain();
    });
  }

  handleClick(event, following, el) {
    if (event.target.closest(".following-avatar, .following-avatar-fallback")) {
      if (state.batchMode) return;
      event.stopPropagation();
      window.open(following.profileUrl || `${config.URL_BASE}/user/${following.uid}`, "_blank");
      return;
    }

    const checkbox = el.querySelector(".following-checkbox");

    if (event.target.closest(".following-checkbox")) {
      event.stopPropagation();
      batch.toggleBatchSelect(following.uid, checkbox, event.shiftKey);
      return;
    }

    if (state.batchMode) {
      batch.toggleBatchSelect(following.uid, checkbox, event.shiftKey);
      return;
    }
    sidebar.openSidebar(following);
  }
}

export const followingsGrid = new FollowingsGrid();
