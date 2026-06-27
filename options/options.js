// ---------- config ----------
const config = {
  // 视频重试
  VIDEO_RETRY_DELAYS: [200, 400, 600],
  VIDEO_RETRY_MAX: 3,
  VIDEO_RETRY_FALLBACK_DELAY: 1000,

  // 超时
  FETCH_RETRY_DELAY: 1000,
  SYNC_TIMEOUT: 30000,
  VIDEO_FALLBACK_TIMEOUT: 5000,

  // UI 延迟
  HOVER_PREVIEW_DELAY: 200,
  BLOB_REVOKE_DELAY: 10000,
  NOTE_AUTO_PLAY_INTERVAL: 3000,

  // 侧边栏
  SIDEBAR_SNAP_POINTS: [650, 0],
  SIDEBAR_SCROLL_THRESHOLD: 100,
  SIDEBAR_MIN_WIDTH: 80,
  SIDEBAR_FILL_THRESHOLD: 50,

  // 卡片
  CARD_SIZE_FALLBACK: 261,
  CARD_GAP: 9,
  CARD_HEIGHT_OFFSET: 35,

  // 详情页
  DETAIL_TITLE_MAX_LEN: 40,
  TOAST_DURATION: 2000,
  DOWNLOAD_MAX_RETRY: 1,

  // 分块渲染
  RENDER_CHUNK_SIZE: 50,
  OBSERVER_ROOT_MARGIN: '400px',
  CARD_FILL_MAX_CONCURRENT: 12,

  // 分组/存储
  TAB_SCROLL_THRESHOLD: 2,
  GROUP_NAME_MAX_LEN: 20,
  STORAGE_MAX_BYTES: 10 * 1024 * 1024,
  TRASH_GROUP_NAME: '稍后删除',

  // URL
  URLS: {
    BASE: 'https://www.douyin.com',
    USER_SELF: 'https://www.douyin.com/user/self',
    LIKE_TAB: '?showTab=like',
    COLLECTION_TAB: '?showTab=favorite_collection',
    FOLLOWING_TAB: '?showTab=following',
  },

  // 正则
  SEC_UID_REGEX: /^\/user\/([^/?]+)/,

  // 图标（运行时填充）
  icons: {},
};

// ---------- dom ----------
const dom = {
  domainSwitch: document.querySelector('.domain-switch'),
  dsSlider: document.querySelector('.ds-slider'),
  groupTabSlider: document.querySelector('.group-tabs-slider'),
  groupTabs: document.querySelector('#groupTabs'),
  mainContainer: document.querySelector('#mainContainer'),
  emptyState: document.querySelector('#emptyState'),
  batchMove: document.querySelector('#btnBatchMove'),
  batchDelete: document.querySelector('#btnBatchDelete'),
  batchSelectAll: document.querySelector('#btnBatchSelectAll'),
  detailOverlay: document.querySelector('#detailOverlay'),
  detailClose: document.querySelector('#detailClose'),
  detailVideoContainer: document.querySelector('#detailVideoContainer'),
  detailVideoWrap: document.querySelector('#detailVideoWrap'),
  detailVideo: document.querySelector('#detailVideo'),
  detailImageContainer: document.querySelector('#detailImageContainer'),
  detailImage: document.querySelector('#detailImage'),
  detailAudio: document.querySelector('#detailAudio'),
  detailImgCounter: document.querySelector('#detailImgCounter'),
  detailNavLeft: document.querySelector('#detailNavLeft'),
  detailNavRight: document.querySelector('#detailNavRight'),
  detailProgressSlider: document.querySelector('#detailProgressSlider'),
  detailPlayBtn: document.querySelector('#detailPlayBtn'),
  detailTime: document.querySelector('#detailTime'),
  detailAuthor: document.querySelector('#detailAuthor'),
  detailTitle: document.querySelector('#detailTitle'),
  detailMuteBtn: document.querySelector('#detailMuteBtn'),
  detailRemoveBtn: document.querySelector('#detailRemoveBtn'),
  detailLoopBtn: document.querySelector('#detailLoopBtn'),
  detailSyncBtn: document.querySelector('#detailSyncBtn'),
  detailDownloadBtn: document.querySelector('#detailDownloadBtn'),
  detailCounter: document.querySelector('#detailCounter'),
  dialogOverlay: document.querySelector('#dialogOverlay'),
  dialogTitle: document.querySelector('#dialogTitle'),
  dialogBody: document.querySelector('#dialogBody'),
  dialogFooter: document.querySelector('#dialogFooter'),
  dialogClose: document.querySelector('#dialogClose'),
  fileInput: document.querySelector('#fileInput'),
  btnImport: document.querySelector('#btnImport'),
  btnExport: document.querySelector('#btnExport'),
  btnSync: document.querySelector('#btnSync'),
  btnReset: document.querySelector('#btnReset'),
  btnBatch: document.querySelector('#btnBatch'),
  btnGroupManage: document.querySelector('#btnGroupManage'),
  mainGrid: document.querySelector('#mainGrid'),
  errorState: document.querySelector('#errorState'),
  btnMenu: document.querySelector('#btnMenu'),
  menuDropdown: document.querySelector('#menuDropdown'),
  menuStorage: document.querySelector('#menuStorage'),
  btnRetry: document.querySelector('#btnRetry'),
  btnSecurityStatus: document.querySelector('#btnSecurityStatus'),
  sidebar: document.querySelector('#sidebar'),
  sidebarBody: document.querySelector('#sidebarBody'),
  sidebarWorksGrid: document.querySelector('#sidebarWorksGrid'),
  sidebarLoader: document.querySelector('#sidebarLoader'),
  sidebarResizeHandle: document.querySelector('#sidebarResizeHandle'),
  btnFavorites: document.querySelector('#btnFavorites'),
  btnCollections: document.querySelector('#btnCollections'),
};

// ---------- state ----------
const state = {
  domain: 'works',
  works: [],
  followings: [],
  currentGroupId: 'all',
  batchMode: false,
  selectedIds: new Set(),
  activeDialog: null,
  syncDialog: null,
  currentFollowingUid: null,
  currentFollowingSecUid: null,
  sidebarCursor: null,
  sidebarLoading: false,
  // Favorites 内部状态：仅 Favorites class 读写，不需 store.set() 响应式通知
  favoriteWorks: [],
  favoriteFetching: false,
  cancelingFavorites: false,
  favRequestId: null,
  collectionWorks: [],
  collectionFetching: false,
  cancelingCollections: false,
  collectionRequestId: null,
  // 短操作弹窗锁：为 true 时禁止点击 X 关闭，待操作完成才解锁
  preventDialogClose: false,
};

// ---------- store ----------
const store = {
  _listeners: new Map(),

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  },

  notify(event, ...args) {
    const fns = this._listeners.get(event);
    if (!fns) return;
    requestAnimationFrame(() => {
      fns.forEach((fn) => fn(...args));
    });
  },

  set(key, val) {
    const old = state[key];
    state[key] = val;
    if (old !== val) this.notify(key, val, old);
  },

  updateWork(awemeId, newWork) {
    const idx = state.works.findIndex((w) => w.awemeId === awemeId);
    if (idx === -1) return false;
    state.works[idx] = newWork;
    this.notify('work-updated', awemeId, newWork);
    return true;
  },

  removeWorksSilent(idSet) {
    state.works = state.works.filter((w) => !idSet.has(w.awemeId));
  },

  removeFollowingsSilent(idSet) {
    state.followings = state.followings.filter((f) => !idSet.has(f.uid));
  },

  spliceWork(idx, deleteCount = 1) {
    state.works.splice(idx, deleteCount);
    this.notify('works', state.works);
  },
};

// ---------- utils ----------
const utils = {
  SPINNER_HTML: '<div class="spinner"></div>',
  pickHttpsUrl(url) {
    if (!url) return '';
    return url.startsWith('//') ? 'https:' + url : url;
  },
  formatCount(num) {
    if (!num && num !== 0) return '0';
    const n = Number(num);
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  },
  setImagePlaceholder(el, emoji) {
    el.classList.add('img-placeholder');
    el.alt = emoji;
  },
  getVideoUrl(work) {
    return this.pickHttpsUrl(work?.video || '');
  },
  secUidFromUrl(url) {
    if (!url) return '';
    const m = url.split('/user/');
    return m.length > 1 ? m[1].split('?')[0] : '';
  },
};

// ---------- services ----------
const services = {
  bgMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(res || {});
        }
      });
    });
  },

  async findSecUid() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.url) {
      try {
        const m = new URL(tabs[0].url).pathname.match(config.SEC_UID_REGEX);
        if (m) return m[1];
      } catch (_) { }
    }
    const dt = await chrome.tabs.query({ url: '*://*.douyin.com/user/*' });
    for (const t of dt) {
      if (t.url?.includes('creator.douyin.com')) continue;
      try {
        const m2 = new URL(t.url).pathname.match(config.SEC_UID_REGEX);
        if (m2) return m2[1];
      } catch (_) { }
    }
    return '';
  },

  async loadStats() {
    const res = await this.bgMsg({ type: 'GET_STATS' });
    const s = res.stats || {};
    return {
      works: s.works || { total: 0, groupCounts: {} },
      followings: s.followings || { total: 0, groupCounts: {} },
      bytes: s.bytes || 0,
    };
  },

  async loadWorks(groupId) {
    const res = await this.bgMsg({ type: 'GET_WORKS', groupId });
    const works = res.works || [];
    const seen = new Set();
    const deduped = [];
    for (const w of works) {
      if (!w || !w.awemeId) continue;
      const id = String(w.awemeId);
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push({ ...w, awemeId: id });
    }
    return deduped;
  },

  async loadFollowings(groupId) {
    const res = await this.bgMsg({ type: 'GET_FOLLOWINGS', groupId: groupId || state.currentGroupId });
    const list = res.followings || [];
    const seen = new Set();
    const deduped = [];
    for (const f of list) {
      if (!f || !f.uid) continue;
      const uid = String(f.uid);
      if (seen.has(uid)) continue;
      seen.add(uid);
      deduped.push({ ...f, uid });
    }
    return deduped;
  },

  async loadGroups(domain) {
    const res = await this.bgMsg({ type: 'GET_GROUPS', domain: domain || state.domain });
    return res.groups || [];
  },

  async loadDomainData() {
    if (state.domain === 'works') {
      store.set('works', await this.loadWorks(state.currentGroupId));
    } else {
      store.set('followings', await this.loadFollowings(state.currentGroupId));
    }
  },

  async deleteFollowings(uids) {
    return this.bgMsg({ type: 'DELETE_FOLLOWINGS', uids });
  },

  async moveFollowings(uids, targetGroupId) {
    return this.bgMsg({ type: 'MOVE_FOLLOWINGS', uids, targetGroupId });
  },

  async refreshSingleWork(awemeId) {
    const res = await this.bgMsg({ type: 'SYNC_WORKS', awemeIds: [awemeId] });
    if (!res || !res.requestId) throw new Error('NO_SYNC');
    const done = await new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.type === 'SYNC_DONE' && msg.requestId === res.requestId) {
          chrome.runtime.onMessage.removeListener(handler);
          resolve(msg);
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(handler);
        resolve(null);
      }, config.SYNC_TIMEOUT);
    });
    if (!done || !done.ok) throw new Error('SYNC_FAILED');
    const workRes = await this.bgMsg({ type: 'GET_WORK', awemeId });
    return workRes.work || null;
  },

  isWorksData(data) {
    if (data.works && Array.isArray(data.works)) return data.works.length > 0;
    return false;
  },

  isFollowingsData(data) {
    if (data.followings && Array.isArray(data.followings)) return data.followings.length > 0;
    return false;
  },
};

// ---------- VirtualGrid ----------
class VirtualGrid {
  #observer = null;
  #fillQueue = [];
  #filling = 0;
  #itemMap = new Map();
  #boundClickHandler = null;
  #container = null;
  #skeletonClass = '';
  #itemClass = '';
  #itemKey = '';
  #dataAttr = '';
  #emptyMsg = '';
  #emptyHint = '';

  constructor({ container, itemClass, skeletonClass, itemKey, emptyMsg, emptyHint }) {
    this.#container = container;
    this.#itemClass = itemClass;
    this.#skeletonClass = skeletonClass;
    this.#itemKey = itemKey;
    this.#dataAttr = itemKey.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    this.#emptyMsg = emptyMsg || '';
    this.#emptyHint = emptyHint || '';
    this.#boundClickHandler = this.#onClick.bind(this);
    this.#container.addEventListener('click', this.#boundClickHandler);
  }

  render(items, emptyMsg, emptyHint) {
    this.#container.className = 'main-container';
    this.#container.innerHTML = '';
    dom.emptyState.classList.add('hidden');
    dom.errorState.classList.add('hidden');

    if (items.length === 0) {
      dom.emptyState.classList.remove('hidden');
      dom.emptyState.querySelector('p').textContent = emptyMsg;
      dom.emptyState.querySelector('.empty-hint').textContent = emptyHint;
      this.#container.classList.add('hidden');
      return;
    }

    dom.emptyState.classList.add('hidden');
    this.#container.classList.remove('hidden');

    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }

    this.#itemMap = new Map(items.map(item => [item[this.#itemKey], item]));
    this.#fillQueue = [];
    this.#filling = 0;

    const skelTmpl = document.getElementById(
      this.#skeletonClass.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + 'Template'
    );
    let index = 0;

    const renderChunk = () => {
      const fragment = document.createDocumentFragment();
      const end = Math.min(index + config.RENDER_CHUNK_SIZE, items.length);

      for (let i = index; i < end; i++) {
        const card = skelTmpl.content.cloneNode(true).firstElementChild;
        card.dataset[this.#itemKey] = items[i][this.#itemKey];
        fragment.appendChild(card);
      }

      this.#container.appendChild(fragment);
      index = end;

      this.#observeNewSkeletons();

      if (index < items.length) {
        requestAnimationFrame(renderChunk);
      } else {
        this.#finishRender();
      }
    };

    renderChunk();
  }

  removeItems(idSet) {
    for (const id of idSet) {
      this.#itemMap.delete(id);
      const card = this.#container.querySelector(`[data-${this.#dataAttr}="${id}"]`);
      if (card) {
        if (this.#observer) this.#observer.unobserve(card);
        card.remove();
      }
    }
    if (this.#container.children.length === 0) {
      this.#container.classList.add('hidden');
      dom.emptyState.classList.remove('hidden');
      dom.emptyState.querySelector('p').textContent = this.#emptyMsg;
      dom.emptyState.querySelector('.empty-hint').textContent = this.#emptyHint;
    }
  }

  #observeNewSkeletons() {
    if (!this.#observer) {
      this.#observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = entry.target;
          this.#observer.unobserve(card);
          this.#enqueueFill(card);
        }
      }, { rootMargin: config.OBSERVER_ROOT_MARGIN });
    }
    this.#container.querySelectorAll('.' + this.#skeletonClass + ':not([data-observed])').forEach(c => {
      c.dataset.observed = '1';
      this.#observer.observe(c);
    });
  }

  #finishRender() {
    if (state.batchMode) {
      this.#container.querySelectorAll('.' + this.#skeletonClass + ' .work-checkbox, .' + this.#skeletonClass + ' .following-checkbox').forEach(cb => {
        cb.style.display = '';
      });
    }
  }

  #enqueueFill(card) {
    if (this.#filling < config.CARD_FILL_MAX_CONCURRENT) {
      this.#filling++;
      this.#doFill(card);
    } else {
      this.#fillQueue.push(card);
    }
  }

  #doFill(card) {
    const key = card.dataset[this.#itemKey];
    const item = this.#itemMap.get(key);
    if (item && card.classList.contains(this.#skeletonClass)) {
      this.populateItem(card, item);
    }
    this.#filling--;
    const next = this.#fillQueue.shift();
    if (next) this.#doFill(next);
  }

  populateItem(skeleton, item) {
    if (!skeleton.parentNode) return;
    const fullCard = this.createItem(item);
    skeleton.parentNode.replaceChild(fullCard, skeleton);
    fullCard.style.animation = 'cardFadeIn 0.3s ease forwards';
    fullCard.style.opacity = '0';
  }

  #onClick(event) {
    const itemEl = event.target.closest('.' + this.#itemClass);
    if (!itemEl) return;
    const key = itemEl.dataset[this.#itemKey];
    const item = this.#itemMap.get(key);
    if (item) this.handleClick(event, item, itemEl);
  }

  // 子类必须实现
  createItem(item) { throw new Error('子类必须实现 createItem'); }
  handleClick(event, item, itemEl) { throw new Error('子类必须实现 handleClick'); }
}

// ---------- Dialog ----------
class Dialog {
  constructor() {
    this.__toastTimer = null;
  }

  showDialog(title, body, footerBtns, onClose) {
    dom.dialogOverlay.classList.remove('hidden');
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = '';
    state.activeDialog = onClose || null;

    if (typeof body === 'string') {
      dom.dialogBody.innerHTML = body;
    } else if (body instanceof DocumentFragment || body instanceof HTMLElement) {
      dom.dialogBody.appendChild(body);
    }

    dom.dialogFooter.innerHTML = '';
    if (footerBtns) {
      for (const btn of footerBtns) {
        const el = document.createElement('button');
        el.className = `dy-btn flex-inline-center ${btn.primary ? 'dy-btn-primary' : ''} ${btn.danger ? 'dy-btn-danger' : ''} ${btn.ghost ? 'dy-btn-ghost' : ''}`;
        el.textContent = btn.text;
        el.addEventListener('click', btn.callback);
        dom.dialogFooter.appendChild(el);
      }
    }
  }

  closeDialog() {
    // 关键防御:防止重复关闭触发栈溢出或重复回调
    if (dom.dialogOverlay.classList.contains('hidden')) {
      state.activeDialog = null;
      return;
    }
    state.activeDialog = null;
    dom.dialogOverlay.classList.add('hidden');
  }

  updateDialog(title, bodyHtml) {
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = bodyHtml || '';
    dom.dialogFooter.innerHTML = '';
  }

  addDialogBtn(text, type, cb) {
    const btn = document.createElement('button');
    btn.className = `dy-btn flex-inline-center dy-btn-${type}`;
    btn.textContent = text;
    btn.addEventListener('click', cb);
    dom.dialogFooter.appendChild(btn);
  }

  showOkDialog() {
    this.addDialogBtn('好的', 'primary', () => this.closeDialog());
  }

  showToast(message) {
    const toast = document.getElementById('dy-options-toast');
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    if (this.__toastTimer) clearTimeout(this.__toastTimer);
    this.__toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-20px)';
    }, config.TOAST_DURATION);
  }

  showGroupSelectDialog(title, groups, onSelect) {
    const list = document.createElement('div');
    list.className = 'group-select-list';
    const tmpl = document.getElementById('groupSelectItemTemplate');
    for (const g of groups.filter((g) => !g.fixed)) {
      const el = tmpl.content.cloneNode(true).firstElementChild;
      el.dataset.groupId = g.id;
      el.appendChild(document.createTextNode(' ' + g.name));
      el.addEventListener('click', () => onSelect(g.id));
      list.appendChild(el);
    }
    this.showDialog(title, list);
  }

  showNoSignatureDialog(tabUrl, stepLabel, scanLabel) {
    dom.dialogTitle.textContent = '未捕获到签名';
    dom.dialogBody.innerHTML = `
      <p>扩展需要先从抖音页面捕获请求签名才能${scanLabel}。</p>
      <p style="margin-top:8px">请按以下步骤操作：</p>
      <ol style="margin-top:4px;padding-left:20px;line-height:1.8">
        <li>在浏览器中打开 <code style="font-size:12px">${tabUrl}</code></li>
        <li>在打开的页面上点击「${stepLabel}」标签（页面会自动加载列表）</li>
        <li>回到本扩展，再次点击「${scanLabel}」</li>
      </ol>
    `;
    this.showOkDialog();
  }

  showFetchErrorDialog(msg) {
    dom.dialogTitle.textContent = '获取失败';
    let hint = msg;
    if (msg.includes('NO_DOUYIN_TAB')) hint = '未找到抖音页面，请确保已打开抖音';
    else if (msg.includes('TIMEOUT')) hint = '获取超时，可能是网络问题或内容过多';
    dom.dialogBody.innerHTML = `<p>${hint}</p>`;
    this.showOkDialog();
  }

  showNoDouyinTabDialog() {
    const noTabTmpl = document.getElementById('noDouyinTabTemplate');
    this.showDialog('未找到已打开的抖音页面', noTabTmpl.content.cloneNode(true), [
      { text: '取消', ghost: true, callback: () => this.closeDialog() },
      {
        text: '打开抖音',
        primary: true,
        callback: async () => {
          this.closeDialog();
          await services.bgMsg({ type: 'OPEN_DOUYIN_TAB' });
        },
      },
    ]);
  }
}

const dialog = new Dialog();

// ---------- FollowingsGrid ----------
class FollowingsGrid extends VirtualGrid {
  constructor() {
    super({
      container: dom.mainContainer,
      itemClass: 'following-card',
      skeletonClass: 'following-skeleton',
      itemKey: 'uid',
      emptyMsg: '还没有保存的关注者',
      emptyHint: '点击菜单「同步关注」获取你的关注列表',
    });
  }

  renderFollowingCards() {
    this.render(
      state.followings,
      '还没有保存的关注者',
      '点击菜单「同步关注」获取你的关注列表'
    );
  }

  createItem(following) {
    const card = document.getElementById('followingCardTemplate').content.cloneNode(true).firstElementChild;
    card.dataset.uid = following.uid;

    const checkbox = card.querySelector('.following-checkbox');
    batch.updateCheckboxDOM(checkbox, state.selectedIds.has(following.uid));
    checkbox.style.display = state.batchMode ? '' : 'none';

    const avatar = card.querySelector('.following-avatar');
    const avatarUrl = following.avatarLarger || following.avatar || '';
    avatar.src = avatarUrl;
    avatar.onerror = () => { avatar.style.display = 'none'; };

    card.querySelector('.following-nickname').textContent = following.nickname || '未知';
    card.querySelector('.stat-followers').textContent = utils.formatCount(following.followerCount) + ' 粉丝';

    return card;
  }

  handleClick(event, following, el) {
    if (event.target.closest('.following-avatar')) {
      if (state.batchMode) return;
      event.stopPropagation();
      window.open(following.profileUrl || `${config.URLS.BASE}/user/${following.uid}`, '_blank');
      return;
    }

    const checkbox = el.querySelector('.following-checkbox');

    if (event.target.closest('.following-checkbox')) {
      event.stopPropagation();
      batch.toggleBatchSelect(following.uid, checkbox);
      return;
    }

    if (state.batchMode) {
      batch.toggleBatchSelect(following.uid, checkbox);
      return;
    }
    sidebar.openSidebar(following);
  }
}

const followingsGrid = new FollowingsGrid();

// ---------- Groups ----------
class Groups {
  async renderGroupTabs() {
    const [stats, groupList] = await Promise.all([services.loadStats(), services.loadGroups()]);
    this.#updateStorageIndicator(stats);
    const domainStats = state.domain === 'works' ? stats.works : stats.followings;
    dom.groupTabs.innerHTML = '';
    for (const g of groupList) {
      const count = domainStats.groupCounts?.[g.id] ?? 0;
      const tab = document.getElementById('groupTabTemplate').content.cloneNode(true).firstElementChild;
      tab.classList.toggle('active', g.id === state.currentGroupId);
      tab.dataset.groupId = g.id;
      tab.textContent = `${g.name} (${count})`;
      tab.addEventListener('click', () => this.#switchGroup(g.id));
      dom.groupTabs.appendChild(tab);
    }
    this.updateTabMask();
    updateGroupTabSlider(state.currentGroupId);
  }

  updateTabMask() {
    const el = dom.groupTabs;
    const overflow = el.scrollWidth > el.clientWidth;
    if (!overflow) {
      el.classList.remove('tab-overflow', 'tab-at-start', 'tab-at-end');
      return;
    }
    el.classList.add('tab-overflow');
    el.classList.toggle('tab-at-start', el.scrollLeft <= config.TAB_SCROLL_THRESHOLD);
    el.classList.toggle('tab-at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - config.TAB_SCROLL_THRESHOLD);
  }

  async showGroupManage() {
    const tmpl = document.getElementById('groupManageTemplate');
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog('分组管理', body);
    state.preventDialogClose = true;
    try {
      await this.#refreshGroupList();
    } finally {
      state.preventDialogClose = false;
    }

    const input = dom.dialogBody.querySelector('#newGroupInput');
    const addBtn = dom.dialogBody.querySelector('#addGroupBtn');
    if (input && addBtn) {
      addBtn.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        const res = await services.bgMsg({ type: 'ADD_GROUP', domain: state.domain, name });
        if (res.ok) {
          input.value = '';
          await this.#refreshGroupList();
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addBtn.click();
      });
    }
  }

  async #refreshGroupList() {
    await this.renderGroupTabs();
    const groupList = await services.loadGroups(state.domain);
    const list = dom.dialogBody.querySelector('#groupList');
    if (!list) return;
    list.innerHTML = '';
    for (const g of groupList.filter((g) => !g.fixed)) {
      const item = document.getElementById('groupListItemTemplate').content.cloneNode(true).firstElementChild;
      item.dataset.groupId = g.id;
      item.querySelector('.group-name').textContent = g.name;
      item.querySelector('.rename-btn').addEventListener('click', () => {
        const nameSpan = item.querySelector('.group-name');
        const oldName = nameSpan.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldName;
        input.maxLength = config.GROUP_NAME_MAX_LEN;
        input.className = 'group-rename-input';
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        const done = async () => {
          const newName = input.value.trim();
          if (newName && newName !== oldName) {
            await services.bgMsg({ type: 'RENAME_GROUP', domain: state.domain, groupId: g.id, newName });
            store.notify('groups');
            nameSpan.textContent = newName;
          } else nameSpan.textContent = oldName;
          input.replaceWith(nameSpan);
        };
        input.addEventListener('blur', done);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          }
          if (e.key === 'Escape') {
            input.value = oldName;
            input.blur();
          }
        });
      });
      item.querySelector('.delete-btn').addEventListener('click', () => {
        const delTmpl = document.getElementById('confirmDeleteGroupTemplate');
        const delBody = delTmpl.content.cloneNode(true);
        delBody.querySelector('.confirm-delete-group-name').textContent = g.name;
        dialog.showDialog('确认删除', delBody, [
          { text: '取消', ghost: true, callback: () => dialog.closeDialog() },
          {
            text: '删除',
            danger: true,
            callback: async () => {
              dialog.updateDialog('正在删除…', utils.SPINNER_HTML);
              state.preventDialogClose = true;
              try {
                await services.bgMsg({ type: 'DELETE_GROUP', domain: state.domain, groupId: g.id });
                item.remove();
                store.notify('groups');
                dom.dialogTitle.textContent = '删除完成';
                dom.dialogBody.innerHTML = `<p>已删除"${g.name}"</p>`;
                dialog.showOkDialog();
              } finally {
                state.preventDialogClose = false;
              }
            },
          },
        ]);
      });
      list.appendChild(item);
    }
    this.#setupDragSort(list);
  }

  #setupDragSort(container) {
    let dragItem = null;
    container.addEventListener('dragover', (e) => e.preventDefault());
    container.addEventListener('drop', (e) => e.preventDefault());
    container.querySelectorAll('.group-list-item[draggable="true"]').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        dragItem = el;
        el.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        el.style.opacity = '1';
        dragItem = null;
        this.#saveOrder();
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragItem && dragItem !== el) {
          const mid = el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
          if (e.clientY < mid) container.insertBefore(dragItem, el);
          else container.insertBefore(dragItem, el.nextSibling);
        }
      });
    });
  }

  async #saveOrder() {
    const items = dom.dialogBody.querySelectorAll('.group-list-item');
    const customIds = Array.from(items).map((el) => el.dataset.groupId);
    const defaultIds = ['all', 'uncategorized'];
    await services.bgMsg({ type: 'REORDER_GROUPS', domain: state.domain, groupIds: [...defaultIds, ...customIds] });
    store.notify('groups');
  }

  #updateStorageIndicator(stats) {
    const el = dom.menuStorage;
    if (!el) return;
    const bytes = stats.bytes || 0;
    const pct = bytes / config.STORAGE_MAX_BYTES;
    const used = (bytes / 1024 / 1024).toFixed(pct > 0.1 ? 1 : 2);
    el.textContent = `${used} MB`;
  }

  #switchGroup(groupId) {
    state.selectedIds.clear();
    detail.closeDetail();
    window.scrollTo(0, 0);
    store.set('batchMode', false);
    store.set('currentGroupId', groupId);
  }
}

const groups = new Groups();

// ---------- Batch ----------
class Batch {
  toggleSelect(id) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      return false;
    }
    state.selectedIds.add(id);
    return true;
  }

  toggleBatchMode() {
    const newMode = !state.batchMode;
    if (!newMode) state.selectedIds.clear();
    return newMode;
  }

  selectAll() {
    const items = state.domain === 'works' ? state.works : state.followings;
    const idKey = state.domain === 'works' ? 'awemeId' : 'uid';
    const allSelected = items.every((w) => state.selectedIds.has(w[idKey]));
    if (allSelected) {
      state.selectedIds.clear();
      return 'none';
    }
    for (const w of items) state.selectedIds.add(w[idKey]);
    return 'all';
  }

  #clearAllCheckboxes() {
    const selector = state.domain === 'works' ? '.work-checkbox' : '.following-checkbox';
    document.querySelectorAll(selector).forEach((el) => this.updateCheckboxDOM(el, false));
  }

  async #executeBatchOp(serviceFn, { conditionallyRemove = false } = {}) {
    if (state.selectedIds.size === 0) return null;
    const ids = Array.from(state.selectedIds);
    const isFollowings = state.domain === 'followings';

    await serviceFn(ids, isFollowings);
    state.selectedIds.clear();

    const grid = isFollowings ? followingsGrid : worksGrid;
    const removeSilent = isFollowings ? store.removeFollowingsSilent : store.removeWorksSilent;
    if (!conditionallyRemove || state.currentGroupId !== 'all') {
      removeSilent.call(store, new Set(ids));
      grid.removeItems(new Set(ids));
    }

    this.#clearAllCheckboxes();
    dom.batchSelectAll.innerHTML = '全选';
    store.notify('groups');
    return { count: ids.length, isFollowings };
  }

  deleteSelected() {
    return this.#executeBatchOp((ids, isFollowings) =>
      isFollowings
        ? services.deleteFollowings(ids)
        : services.bgMsg({ type: 'DELETE_WORKS', awemeIds: ids })
    );
  }

  moveSelected(targetGroupId) {
    return this.#executeBatchOp((ids, isFollowings) =>
      isFollowings
        ? services.moveFollowings(ids, targetGroupId)
        : services.bgMsg({ type: 'MOVE_WORKS', awemeIds: ids, targetGroupId })
      , { conditionallyRemove: true });
  }

  isSelected(id) {
    return state.selectedIds.has(id);
  }

  selectedCount() {
    return state.selectedIds.size;
  }

  updateCheckboxDOM(checkboxEl, isSelected) {
    if (isSelected) {
      checkboxEl.classList.add('checked');
      checkboxEl.innerHTML = (config.icons && config.icons.check) || '';
    } else {
      checkboxEl.classList.remove('checked');
      checkboxEl.textContent = '';
    }
  }

  toggleBatchSelect(id, checkboxEl) {
    const selected = this.toggleSelect(id);
    this.updateCheckboxDOM(checkboxEl, selected);
  }

  handleBatchToggle() {
    const newMode = this.toggleBatchMode();
    store.set('batchMode', newMode);
    if (!newMode) {
      document.querySelectorAll('.work-checkbox').forEach((el) => {
        el.style.display = 'none';
        el.innerHTML = '';
        el.classList.remove('checked');
      });
      document.querySelectorAll('.following-checkbox').forEach((el) => {
        el.style.display = 'none';
        el.innerHTML = '';
        el.classList.remove('checked');
      });
      dom.batchSelectAll.innerHTML = `全选`;
    } else {
      document.querySelectorAll('.work-checkbox').forEach((el) => (el.style.display = ''));
      document.querySelectorAll('.following-checkbox').forEach((el) => (el.style.display = ''));
    }
  }

  handleBatchSelectAll() {
    const result = this.selectAll();
    dom.batchSelectAll.innerHTML = result === 'all' ? `取消全选` : `全选`;
    const selector = state.domain === 'followings' ? '.following-checkbox' : '.work-checkbox';
    document.querySelectorAll(selector).forEach((el) => {
      const id = el.closest('[data-aweme-id]')?.dataset?.awemeId || el.closest('[data-uid]')?.dataset?.uid;
      this.updateCheckboxDOM(el, this.isSelected(id));
    });
  }

  async handleBatchDelete() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    const isFollowings = state.domain === 'followings';
    const name = isFollowings ? '关注者' : '作品';
    const delBody = document.createElement('p');
    delBody.className = 'confirm-delete-msg';
    delBody.textContent = `确定删除选中的 ${count} 个${name}？此操作不可撤销。`;
    dialog.showDialog('确认删除', delBody, [
      { text: '取消', ghost: true, callback: () => dialog.closeDialog() },
      {
        text: '删除',
        danger: true,
        callback: async () => {
          dialog.updateDialog('正在移除…', `<p>正在移除 ${count} 个${name}…</p>${utils.SPINNER_HTML}`);
          state.preventDialogClose = true;
          try {
            const result = await this.deleteSelected();
            if (result) {
              dom.dialogTitle.textContent = '移除完成';
              dom.dialogBody.innerHTML = `<p>已移除 ${count} 个${name}</p>`;
              dialog.showOkDialog();
            }
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
    ]);
  }

  async handleBatchMove() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    const name = state.domain === 'followings' ? '关注者' : '作品';
    dialog.showGroupSelectDialog(`移动到分组...`, await services.loadGroups(), async (groupId) => {
      dialog.updateDialog('正在移动…', `<p>正在移动 ${count} 个${name}…</p>${utils.SPINNER_HTML}`);
      state.preventDialogClose = true;
      try {
        const result = await this.moveSelected(groupId);
        if (result) {
          dom.dialogTitle.textContent = '移动完成';
          dom.dialogBody.innerHTML = `<p>已移动 ${count} 个${name}</p>`;
          dialog.showOkDialog();
        }
      } finally {
        state.preventDialogClose = false;
      }
    });
  }
}

const batch = new Batch();

// ---------- ImportExport ----------
class ImportExport {
  async handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    dom.fileInput.value = '';
    dialog.showDialog('正在导入…', `<p>正在读取文件…</p>${utils.SPINNER_HTML}`);
    state.preventDialogClose = true;
    try {
      const raw = await file.text();
      const data = JSON.parse(raw);
      const domain = state.domain;

      if (domain === 'followings' ? !services.isFollowingsData(data) : !services.isWorksData(data)) {
        const expected = domain === 'followings' ? '关注数据' : '作品数据';
        dom.dialogTitle.textContent = '导入失败';
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">文件内容不是${expected}</p>`;
        dialog.showOkDialog();
        return;
      }

      dom.dialogTitle.textContent = '正在保存…';
      dom.dialogBody.innerHTML = '<p>正在保存数据…</p>';
      const res = await services.bgMsg({ type: 'IMPORT_DATA', data, domain });

      if (domain === 'works') {
        const works = await services.loadWorks(state.currentGroupId);
        store.set('works', works);
      } else {
        const followings = await services.loadFollowings(state.currentGroupId);
        store.set('followings', followings);
      }

      await groups.renderGroupTabs();
      dom.dialogBody.innerHTML = '';
      if (res.ok) {
        const importTmpl = document.getElementById('importResultTemplate');
        const importBody = importTmpl.content.cloneNode(true);
        importBody.querySelector('.import-file-name').textContent = file.name;
        importBody.querySelector('.import-added').textContent = res.added;
        importBody.querySelector('.import-updated').textContent = res.updated;
        importBody.querySelector('.import-invalid').textContent = res.invalid || 0;
        importBody.querySelector('.import-total').textContent = res.total;
        dom.dialogTitle.textContent = '导入完成';
        dom.dialogBody.appendChild(importBody);
        dialog.showOkDialog();
      } else {
        dom.dialogTitle.textContent = '导入失败';
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">${res.error || '解析失败，请检查文件格式'}</p>`;
        dialog.showOkDialog();
      }
    } catch (err) {
      dom.dialogTitle.textContent = '导入失败';
      dom.dialogBody.innerHTML = `<p class="dy-text-danger">文件解析错误：${err.message}</p>`;
      dialog.showOkDialog();
    } finally {
      state.preventDialogClose = false;
    }
  }

  async handleExport() {
    const domain = state.domain || 'works';
    dialog.showDialog('正在导出…', `<p>正在打包数据…</p>${utils.SPINNER_HTML}`);
    state.preventDialogClose = true;
    try {
      const res = await services.bgMsg({ type: 'EXPORT_DATA', domain });
      if (!res.ok || !res.data) {
        dom.dialogTitle.textContent = '导出失败';
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">${res?.error || '未知错误'}</p>`;
        dialog.showOkDialog();
        return;
      }
      const dateStr = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
      const filename = `${domain}-${dateStr}.json`;
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      dom.dialogTitle.textContent = '导出完成';
      dom.dialogBody.innerHTML = `<p>文件已下载：${filename}</p>`;
      dialog.showOkDialog();
    } catch (err) {
      dom.dialogTitle.textContent = '导出失败';
      dom.dialogBody.innerHTML = `<p class="dy-text-danger">${err.message}</p>`;
      dialog.showOkDialog();
    } finally {
      state.preventDialogClose = false;
    }
  }
}

const importExport = new ImportExport();

// ---------- Sidebar ----------
class Sidebar {
  static SNAP_POINTS = config.SIDEBAR_SNAP_POINTS;
  static STORAGE_KEY = 'douyin_sidebar_width';
  #dragStartX = 0;
  #dragStartW = 0;
  #onResizeDown = (e) => {
    this.#dragStartX = e.clientX;
    this.#dragStartW = dom.sidebar.classList.contains('sidebar-zero') ? 0 : dom.sidebar.getBoundingClientRect().width;
    dom.sidebarResizeHandle.classList.add('active');
    document.addEventListener('mousemove', this.#onResizeMove);
    document.addEventListener('mouseup', this.#onResizeUp);
    e.preventDefault();
  };
  #onResizeMove = (e) => {
    const w = this.#dragStartW - (e.clientX - this.#dragStartX);
    this.setSidebarWidth(this.#snapTo(w));
  };
  #onResizeUp = () => {
    const finalWidth = this.#snapTo(dom.sidebar.classList.contains('sidebar-zero') ? 0 : dom.sidebar.getBoundingClientRect().width);
    this.setSidebarWidth(finalWidth);
    this.saveSidebarWidth(finalWidth);
    dom.sidebarResizeHandle.classList.remove('active');
    document.removeEventListener('mousemove', this.#onResizeMove);
    document.removeEventListener('mouseup', this.#onResizeUp);
  };

  initSidebar() {
    const savedWidth = this.#loadWidth();
    const snapped = this.#snapTo(savedWidth);
    this.setSidebarWidth(snapped);
    this.#initResize();
    dom.sidebarBody.addEventListener('scroll', () => {
      if (dom.sidebarBody.scrollTop + dom.sidebarBody.clientHeight >= dom.sidebarBody.scrollHeight - config.SIDEBAR_SCROLL_THRESHOLD) {
        this.#loadMoreWorks();
      }
    });
  }

  setSidebarWidth(w) {
    if (w === 0) {
      dom.sidebar.classList.add('sidebar-zero');
      dom.sidebar.style.width = '';
      document.body.classList.remove('sidebar-open');
    } else {
      dom.sidebar.classList.remove('sidebar-zero');
      dom.sidebar.style.width = w + 'px';
      document.body.classList.add('sidebar-open');
    }
  }

  saveSidebarWidth(width) {
    localStorage.setItem(Sidebar.STORAGE_KEY, String(width));
  }

  clearSidebarActive() {
    const active = dom.mainContainer.querySelector('.following-card.sidebar-active');
    if (active) active.classList.remove('sidebar-active');
  }

  updateSidebarActive() {
    const cards = dom.mainContainer.querySelectorAll('.following-card');
    for (let i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('sidebar-active', cards[i].dataset.uid === state.currentFollowingUid);
    }
  }

  openSidebar(following) {
    this.clearSidebarActive();
    const card = dom.mainContainer.querySelector(`[data-uid="${following.uid}"]`);
    if (card) card.classList.add('sidebar-active');

    state.currentFollowingUid = following.uid;
    state.currentFollowingSecUid = utils.secUidFromUrl(following.profileUrl);
    state.sidebarCursor = null;
    state.sidebarLoading = false;

    const currentWidth = dom.sidebar.classList.contains('sidebar-zero') ? 0 : dom.sidebar.getBoundingClientRect().width;
    if (currentWidth < config.SIDEBAR_MIN_WIDTH) {
      const target = this.#loadWidth() || 650;
      this.setSidebarWidth(target);
      this.saveSidebarWidth(target);
    }

    dom.sidebarWorksGrid.innerHTML = '';
    this.loadSidebarWorks(state.currentFollowingSecUid, null, true);
  }

  async loadSidebarWorks(secUid, cursor, reset) {
    if (state.sidebarLoading) return;
    state.sidebarLoading = true;
    dom.sidebarLoader.classList.remove('hidden');

    try {
      const res = await services.bgMsg({
        type: 'FETCH_WORKS_PAGE',
        secUid,
        cursor: cursor || '',
      });

      if (reset) dom.sidebarWorksGrid.innerHTML = '';

      if (res.ok && res.works) {
        for (const w of res.works) {
          const item = this.#createWorkItem(w);
          dom.sidebarWorksGrid.appendChild(item);
        }
        state.sidebarCursor = res.hasMore ? (res.maxCursor || '') : null;
      }
      dom.sidebarLoader.classList.add('hidden');
    } catch (_e) {
      console.error('[DY] sidebar load failed:', _e);
      dom.sidebarLoader.querySelector('.spinner')?.remove();
      dom.sidebarLoader.textContent = '加载失败' + (_e.message ? ': ' + _e.message : '');
    }

    state.sidebarLoading = false;

    if (state.sidebarCursor && dom.sidebarBody.scrollHeight <= dom.sidebarBody.clientHeight + config.SIDEBAR_FILL_THRESHOLD) {
      this.#loadMoreWorks();
    }
  }

  #loadWidth() {
    return parseInt(localStorage.getItem(Sidebar.STORAGE_KEY)) || 0;
  }

  #snapTo(v) {
    let n = Sidebar.SNAP_POINTS[0];
    for (let i = 0; i < Sidebar.SNAP_POINTS.length; i++) {
      if (Math.abs(Sidebar.SNAP_POINTS[i] - v) < Math.abs(n - v)) n = Sidebar.SNAP_POINTS[i];
    }
    return n;
  }

  #initResize() {
    dom.sidebarResizeHandle.addEventListener('mousedown', this.#onResizeDown);
  }

  #loadMoreWorks() {
    if (state.sidebarLoading || !state.sidebarCursor || !state.currentFollowingSecUid) return;
    this.loadSidebarWorks(state.currentFollowingSecUid, state.sidebarCursor, false);
  }

  #createWorkItem(work) {
    const item = document.getElementById('sidebarWorkTemplate').content.cloneNode(true).firstElementChild;
    const link = item.querySelector('a');
    const type = work.type === 'note' ? 'note' : 'video';
    link.href = `${config.URLS.BASE}/${type}/${work.awemeId}`;

    const img = item.querySelector('.sidebar-work-cover');
    const placeholder = item.querySelector('.sidebar-work-cover-placeholder');
    if (work.cover) { img.src = work.cover; placeholder.style.display = 'none'; }
    else { img.style.display = 'none'; }

    const plays = (work.statistics && work.statistics.play_count) ? utils.formatCount(work.statistics.play_count) : '';
    const playsEl = item.querySelector('.sidebar-work-plays');
    if (plays) { playsEl.textContent = '\u25B6 ' + plays; }
    else { playsEl.style.display = 'none'; }

    return item;
  }
}

const sidebar = new Sidebar();

// ---------- Sync ----------
class Sync {
  #running = false;
  #requestId = null;
  // 关键修复:分别跟踪作品同步/关注同步的 requestId,用于过滤进度事件
  #worksRequestId = null;
  #followingsRequestId = null;
  #progressSeen = new Set();
  #total = 0;
  #errorCount = 0;
  #doneCount = 0;
  #progressText = null;
  #errorCountEl = null;

  isRunning() {
    return this.#running;
  }

  initProgress(t) {
    this.#progressSeen = new Set();
    this.#total = t;
    this.#errorCount = 0;
    this.#doneCount = 0;
  }

  dedupProgress(reqId, awemeId, index) {
    const key = `${reqId}|${awemeId}|${index}`;
    if (this.#progressSeen.has(key)) return false;
    this.#progressSeen.add(key);
    return true;
  }

  countProgress(index, status) {
    const done = ++this.#doneCount;
    if (status !== 'ok') this.#errorCount++;
    return { done, total: this.#total, errors: this.#errorCount };
  }

  async startSync(awemeIds) {
    if (this.#running) return null;
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return 'EMPTY';
    this.#running = true;

    // 关键修复:开始新任务前先通过 background 杀掉抖音标签页中可能残留的旧任务
    chrome.runtime.sendMessage({ type: 'CANCEL_ACTIVE_TASK' }).catch(() => { });

    try {
      const res = await services.bgMsg({ type: 'SYNC_WORKS', awemeIds });
      // 关键修复:await 后立即检查取消标志
      if (!this.#running) return 'CANCELLED';
      if (!res || res.error === 'NO_DOUYIN_TAB') {
        this.#running = false;
        return 'NO_DOUYIN_TAB';
      }
      if (!res || res.requestId === null || res.requestId === undefined) {
        this.#running = false;
        return { error: (res && res.error) || '未知错误' };
      }
      this.#requestId = res.requestId;
      this.#worksRequestId = res.requestId;
      return { requestId: res.requestId };
    } catch (err) {
      this.#running = false;
      return { error: err.message || String(err) };
    }
  }

  async vmSyncCurrentGroup() {
    if (this.#running) return null;
    if (state.domain !== 'works') return null;
    const awemeIds = [...new Set(state.works.map((w) => String(w.awemeId)).filter(Boolean))];
    if (awemeIds.length === 0) return 'EMPTY';
    return this.startSync(awemeIds);
  }

  async vmSyncFollowings() {
    if (this.#running) return null;
    if (state.domain !== 'followings') return null;
    this.#running = true;

    const secUid = await services.findSecUid();
    if (!secUid) {
      this.#running = false;
      return 'NO_SEC_UID';
    }

    // 关键修复:开始新任务前先通过 background 杀掉抖音标签页中可能残留的旧任务
    chrome.runtime.sendMessage({ type: 'CANCEL_ACTIVE_TASK' }).catch(() => { });

    try {
      const res = await services.bgMsg({ type: 'FETCH_FOLLOWING', secUid });
      // 关键修复:await 后立即检查取消标志,旧任务可能已被关闭按钮终结
      if (!this.#running) return 'CANCELLED';
      if (res.error === 'NO_DOUYIN_TAB') {
        this.#running = false;
        return 'NO_DOUYIN_TAB';
      }
      if (!res.ok) {
        this.#running = false;
        if (res.error && res.error.includes('NO_SIGNATURE')) return 'NO_SIGNATURE';
        throw new Error(res.error || 'FETCH_FAILED');
      }
      // 关键修复:保存 requestId 用于过滤后续进度事件
      this.#followingsRequestId = res.requestId || null;

      // 关键修复:再次检查取消(防止关闭按钮在 await 期间触发)
      if (!this.#running) return 'CANCELLED';

      const saveRes = await services.bgMsg({ type: 'SAVE_FOLLOWINGS', followings: res.followings || [] });
      // 关键修复:saveRes 后再次检查
      if (!this.#running) return 'CANCELLED';

      await services.loadDomainData();
      this.#running = false;
      this.#followingsRequestId = null;
      return saveRes;
    } catch (err) {
      this.#running = false;
      this.#followingsRequestId = null;
      const msg = err.message || String(err);
      if (msg.includes('NO_SIGNATURE')) return 'NO_SIGNATURE';
      return { error: msg };
    }
  }

  async moveFailed(failedIds) {
    const groupsRes = await services.bgMsg({ type: 'GET_GROUPS', domain: 'works' });
    const groups = groupsRes.groups || [];
    let trashGroup = groups.find((g) => g.name === config.TRASH_GROUP_NAME);
    if (!trashGroup) {
      const addRes = await services.bgMsg({ type: 'ADD_GROUP', domain: 'works', name: config.TRASH_GROUP_NAME });
      if (addRes.ok) trashGroup = addRes.group;
    }
    if (trashGroup) {
      await services.bgMsg({ type: 'MOVE_WORKS', awemeIds: failedIds, targetGroupId: trashGroup.id });
      await services.loadDomainData();
      store.notify('groups');
    }
    return trashGroup;
  }

  async moveLostFollowings(lostUids) {
    const groupsRes = await services.bgMsg({ type: 'GET_GROUPS', domain: 'followings' });
    const groups = groupsRes.groups || [];
    let trashGroup = groups.find((g) => g.name === config.TRASH_GROUP_NAME);
    if (!trashGroup) {
      const addRes = await services.bgMsg({ type: 'ADD_GROUP', domain: 'followings', name: config.TRASH_GROUP_NAME });
      if (addRes.ok) trashGroup = addRes.group;
    }
    if (trashGroup) {
      await services.moveFollowings(lostUids, trashGroup.id);
      await services.loadDomainData();
      store.notify('groups');
    }
    return trashGroup;
  }

  finish() {
    this.#running = false;
    this.#requestId = null;
    // 关键修复:同时清空按域跟踪的 requestId,关闭弹窗后旧进度事件不再被采纳
    this.#worksRequestId = null;
    this.#followingsRequestId = null;
  }

  getRequestId() {
    return this.#requestId;
  }

  onFollowingProgress(msg) {
    if (!this.isRunning() || state.domain !== 'followings') return;
    // 关键修复:#followingsRequestId 在 FETCH_FOLLOWING 响应返回后才设置,
    // 但进度事件在 fetch 过程中就已经到达。还没设置时接受所有事件,
    // 设置后再按 requestId 过滤以丢弃旧任务的残留事件
    if (this.#followingsRequestId !== null && msg.requestId !== this.#followingsRequestId) return;
    const { collected, total } = msg;
    const countEl = document.getElementById('syncProgCount');
    const fillEl = document.getElementById('syncProgFill');
    if (!countEl || !fillEl) return;
    if (total > 0) {
      const pct = Math.round((collected / total) * 100);
      countEl.textContent = `已获取 ${collected} / ${total} (${pct}%)`;
      fillEl.style.width = pct + '%';
    } else {
      countEl.textContent = `已获取 ${collected}…`;
      fillEl.style.width = '0%';
    }
  }

  openSyncDialog(total) {
    this.initProgress(total);

    const tmpl = document.getElementById('syncDialogBodyTemplate');
    const body = tmpl.content.cloneNode(true);
    body.querySelector('.sync-progress-text').textContent = `准备同步… 0 / ${total}`;
    body.querySelector('.sync-error-count').textContent = '0';

    dialog.showDialog('同步中…', body, [], () => this.closeSyncDialog());

    this.#progressText = dom.dialogBody.querySelector('.sync-progress-text');
    this.#errorCountEl = dom.dialogBody.querySelector('.sync-error-count');
    state.syncDialog = { requestId: null, total, errorCount: 0 };
  }

  closeSyncDialog() {
    dialog.closeDialog();
    state.syncDialog = null;
    this.finish();
  }

  onSyncProgress(msg) {
    const dlg = state.syncDialog;
    if (!dlg) return;
    if (msg.requestId !== this.getRequestId()) return;

    if (!this.dedupProgress(msg.requestId, msg.awemeId, msg.index)) return;

    const { done, total, errors } = this.countProgress(msg.index, msg.status);
    this.#progressText.textContent = `同步中… ${done} / ${total}`;
    this.#errorCountEl.textContent = errors;
    if (msg.status !== 'ok') dlg.errorCount++;
  }

  async onSyncDone(msg) {
    const dlg = state.syncDialog;

    if (dlg && msg && msg.requestId !== this.getRequestId()) {
      return;
    }

    this.finish();

    if (!msg || !msg.ok) {
      if (dlg) {
        dom.dialogTitle.textContent = '同步失败';
        if (this.#progressText) this.#progressText.textContent = `❌ ${(msg && msg.error) || '未知错误'}`;
      }
      return;
    }

    if (!dlg) return;

    dom.dialogTitle.textContent = '同步完成';

    await this.#refreshAfterSync();

    if (this.#progressText) this.#progressText.textContent = `✅ ${msg.refreshed || 0} / ⚠️ ${msg.failed || 0}`;

    dom.dialogFooter.innerHTML = '';
    const failedIds = msg.failedAwemeIds || [];
    if (failedIds.length > 0) {
      const laterBtn = document.createElement('button');
      laterBtn.className = 'dy-btn flex-inline-center dy-btn-ghost';
      laterBtn.textContent = '稍后删除';
      laterBtn.addEventListener('click', async () => {
        laterBtn.disabled = true;
        await this.moveFailed(failedIds);
        this.closeSyncDialog();
      });
      dom.dialogFooter.appendChild(laterBtn);
    }
  }

  async #refreshAfterSync() {
    const works = await services.loadWorks(state.currentGroupId);
    store.set('works', works);
    await groups.renderGroupTabs();
  }

  async syncAwemeIds(awemeIds) {
    if (this.isRunning()) return;
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return;

    this.openSyncDialog(awemeIds.length);
    const result = await this.startSync(awemeIds);

    if (result === 'NO_DOUYIN_TAB') {
      this.closeSyncDialog();
      dialog.showNoDouyinTabDialog();
      return;
    }
    if (result && result.error) {
      this.closeSyncDialog();
      const errTmpl = document.getElementById('syncErrorTemplate');
      const errBody = errTmpl.content.cloneNode(true);
      errBody.querySelector('p').textContent = result.error;
      dialog.showDialog('同步失败', errBody, [{ text: '好的', primary: true, callback: () => dialog.closeDialog() }]);
      return;
    }
    if (state.syncDialog && result && result.requestId) {
      state.syncDialog.requestId = result.requestId;
    }
  }

  async syncCurrentGroup() {
    if (this.isRunning()) return;
    if (state.domain !== 'works') return;
    const awemeIds = [...new Set(state.works.map((w) => String(w.awemeId)).filter(Boolean))];
    if (awemeIds.length === 0) return;
    await this.syncAwemeIds(awemeIds);
  }

  async syncFollowings() {
    if (this.isRunning()) return;
    if (state.domain !== 'followings') return;

    // 关键修复:注册 onClose,关闭按钮触发终止任务(等同作品域 closeSyncDialog)
    dialog.showDialog(
      '同步关注',
      `<div class="sync-progress">
        <div class="sync-progress-count" id="syncProgCount">0</div>
        <div class="progress-bar-wrap"><div class="progress-bar-fill" id="syncProgFill"></div></div>
      </div>`,
      [],
      () => {
        // 终止本地任务状态(远端抓取由通用 dialog close handler 发 CANCEL_ACTIVE_TASK 信号杀灭)
        this.finish();
      }
    );

    const result = await this.vmSyncFollowings();

    if (result === null) return;

    if (result === 'NO_SEC_UID') {
      dom.dialogTitle.textContent = '需要打开抖音用户页面';
      dom.dialogBody.innerHTML = '<p>请先在浏览器中打开一个抖音用户页面（可以是你的个人主页），然后重试。</p>';
      dialog.showOkDialog();
      return;
    }

    if (result === 'NO_DOUYIN_TAB') {
      dialog.showNoDouyinTabDialog();
      return;
    }

    if (result === 'NO_SIGNATURE') {
      dialog.showNoSignatureDialog(config.URLS.USER_SELF + config.URLS.FOLLOWING_TAB, '关注', '同步关注列表');
      return;
    }

    if (result === 'CANCELLED') return;

    if (result && result.error) {
      const msg = result.error;
      dom.dialogTitle.textContent = '同步失败';
      let hint = msg;
      if (msg.includes('NO_SEC_UID')) {
        hint = '无法获取用户 ID，请确认已打开抖音用户页面';
      } else if (msg.includes('TIMEOUT')) {
        hint = '获取超时，可能是网络问题或关注数量过大';
      }
      dom.dialogBody.innerHTML = `<p>${hint}</p>`;
      dialog.showOkDialog();
      return;
    }

    if (result && result.added !== undefined) {
      const fresh = await services.loadFollowings(state.currentGroupId);
      store.set('followings', fresh);
      store.notify('groups');
      dom.dialogTitle.textContent = '同步完成';
      const lostUids = result.lostUids || [];
      dom.dialogBody.innerHTML = `<p>✅ ${result.added} 新增, ${result.updated} 更新, ${result.lost} 消失</p>`;
      dom.dialogFooter.innerHTML = '';
      if (lostUids.length > 0) {
        const laterBtn = document.createElement('button');
        laterBtn.className = 'dy-btn flex-inline-center dy-btn-ghost';
        laterBtn.textContent = '稍后删除';
        laterBtn.addEventListener('click', async () => {
          laterBtn.disabled = true;
          await this.moveLostFollowings(lostUids);
          dialog.closeDialog();
        });
        dom.dialogFooter.appendChild(laterBtn);
      }
      dialog.showOkDialog();
    }
  }

  updateSyncBtnLabel() {
    const btn = dom.btnSync;
    if (!btn) return;
    btn.textContent = state.domain === 'followings' ? '同步关注' : '同步作品';
  }
}

const sync = new Sync();

// ---------- Favorites ----------
class Favorites {
  onFavProgress(msg) {
    if (!state.favoriteFetching) return;
    const { collected, unfollowedCount } = msg;
    const statsEl = dom.dialogBody?.querySelector('.fav-stats');
    if (statsEl) {
      statsEl.textContent = `已扫描 ${collected} 个点赞作品，发现 ${unfollowedCount} 个未关注作者作品`;
    }
  }

  onCollectionProgress(msg) {
    if (!state.collectionFetching) return;
    const { collected, unfollowedCount } = msg;
    const statsEl = dom.dialogBody?.querySelector('.fav-stats');
    if (statsEl) {
      statsEl.textContent = `已扫描 ${collected} 个收藏作品，发现 ${unfollowedCount} 个未关注作者作品`;
    }
  }

  async openScanDialog(cfg) {
    if (state[cfg.fetchingKey]) return;
    state[cfg.fetchingKey] = true;

    let fetchArgs = cfg.buildFetchArgs();
    if (cfg.needSecUid) {
      const secUid = await services.findSecUid();
      if (!secUid) {
        dialog.showDialog('需要打开抖音用户页面', `<p>请先在浏览器中打开一个抖音用户页面，然后重试。</p>`, [
          { text: '好的', primary: true, callback: () => dialog.closeDialog() },
        ]);
        state[cfg.fetchingKey] = false;
        return;
      }
      fetchArgs.secUid = secUid;
    }

    const tmpl = document.getElementById('favDialogTemplate');
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog(cfg.title, body, [], () => {
      // 重置状态标志(远端抓取由通用 dialog close handler 发 CANCEL_ACTIVE_TASK 信号杀灭)
      state[cfg.fetchingKey] = false;
      state[cfg.cancelingKey] = false;
      state[cfg.requestIdKey] = null;
    });

    try {
      const res = await services.bgMsg(fetchArgs);
      if (!state[cfg.fetchingKey]) return;
      state[cfg.requestIdKey] = res.requestId || null;
      if (!res.ok) throw new Error(res.error || 'FETCH_FAILED');

      state[cfg.stateKey] = res.works || [];

      const unfollowed = state[cfg.stateKey].filter(w => w.authorFollowed === false);
      this.#renderGrid('favGrid', state[cfg.stateKey], cfg.formatStats);
      dom.dialogTitle.textContent = `${cfg.title} (${unfollowed.length}/${state[cfg.stateKey].length})`;

      if (res.timedOut) {
        const timeoutHint = document.createElement('p');
        timeoutHint.className = 'dy-text-danger fav-timeout-hint';
        timeoutHint.textContent = '已超时退出，仅获取部分数据';
        dom.dialogBody.appendChild(timeoutHint);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'dy-btn flex-inline-center dy-btn-danger';
      cancelBtn.textContent = unfollowed.length > 0 ? `${cfg.cancelLabel} (${unfollowed.length})` : cfg.cancelLabel;
      cancelBtn.disabled = unfollowed.length === 0;
      cancelBtn.addEventListener('click', async () => {
        const targets = state[cfg.stateKey].filter(w => w.authorFollowed === false);
        if (targets.length === 0) return;
        state[cfg.cancelingKey] = true;
        cancelBtn.disabled = true;
        const ids = targets.map(w => w.awemeId);
        const cancelRes = await services.bgMsg({ type: cfg.cancelType, awemeIds: ids });
        if (!state[cfg.cancelingKey]) return;
        state[cfg.cancelingKey] = false;
        if (cancelRes && cancelRes.ok === false) {
          const errHint = cancelRes.error?.includes('AUTH_FAILED')
            ? '密钥已过期，请刷新抖音页面后重试'
            : '取消失败: ' + (cancelRes.error || '未知错误');
          dialog.showToast(errHint);
          cancelBtn.disabled = false;
          return;
        }
        state[cfg.stateKey] = state[cfg.stateKey].filter(w => ids.indexOf(w.awemeId) === -1);
        const remaining = state[cfg.stateKey].filter(w => w.authorFollowed === false);
        this.#renderGrid('favGrid', state[cfg.stateKey], cfg.formatStats);
        dom.dialogTitle.textContent = `${cfg.title} (${remaining.length}/${state[cfg.stateKey].length})`;
        cancelBtn.textContent = cfg.cancelLabel;
        cancelBtn.disabled = remaining.length === 0;
        dialog.showToast(`已取消 ${ids.length} 个${cfg.cancelLabel}`);
      });
      dom.dialogFooter.appendChild(cancelBtn);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('NO_SIGNATURE')) {
        dialog.showNoSignatureDialog(cfg.noSignatureUrl, cfg.noSignatureStep, cfg.noSignatureScan);
        state[cfg.fetchingKey] = false;
        return;
      }
      dialog.showFetchErrorDialog(msg);
    }

    state[cfg.fetchingKey] = false;
  }

  #renderGrid(gridId, works, formatStats) {
    const grid = dom.dialogBody.querySelector('#' + gridId);
    if (!grid) return;
    grid.innerHTML = '';

    const unfollowed = works.filter(w => w.authorFollowed === false);
    const statsEl = dom.dialogBody.querySelector('.fav-stats');
    if (statsEl) {
      statsEl.textContent = formatStats
        ? formatStats(works.length, unfollowed.length)
        : `${works.length} 件 · 未关注 ${unfollowed.length} 件`;
    }

    if (unfollowed.length === 0) {
      grid.innerHTML = '';
      return;
    }

    for (const w of unfollowed) {
      const item = document.getElementById('favWorkTemplate').content.cloneNode(true).firstElementChild;
      const thumb = item.querySelector('.fav-work-thumb');
      thumb.src = w.cover || '';
      thumb.alt = w.desc || '';

      item.addEventListener('click', () => {
        if (w.awemeId) window.open(`${config.URLS.BASE}/video/${w.awemeId}`, '_blank');
      });

      grid.appendChild(item);
    }
  }
}

const favorites = new Favorites();

// ---------- SecurityStatus ----------
class SecurityStatus {
  #open = false;

  openPanel() {
    if (this.#open) return;
    this.#open = true;

    const tmpl = document.getElementById('securityStatusTemplate');
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog('安全状态', body, [
      { text: '刷新状态', callback: () => this.#queryAndRender() },
      { text: '关闭', primary: true, callback: () => this.closePanel() },
    ], () => this.closePanel());

    const keyRow = document.getElementById('secKeyValue');
    if (keyRow) {
      keyRow.addEventListener('click', () => this.#toggleKeyExpand());
    }

    for (const id of ['secSigFollowing', 'secSigPost', 'secSigFavorite', 'secSigCollection']) {
      const row = document.getElementById(id);
      if (row) {
        row.addEventListener('click', () => this.#toggleSigExpand(id));
      }
    }

    this.#queryAndRender();
  }

  #toggleTruncated(el, hint) {
    if (!el) return;
    const expanded = el.classList.toggle('sec-expanded');
    el.classList.toggle('sec-truncate', !expanded);
    if (hint) hint.textContent = expanded ? '[收起]' : '[展开]';
  }

  #toggleKeyExpand() {
    const text = document.getElementById('secKeyValueText');
    const hint = document.querySelector('#secKeyValue .sec-expand-hint');
    this.#toggleTruncated(text, hint);
  }

  #toggleSigExpand(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    const text = row.querySelector('.sec-truncate, .sec-expanded');
    const hint = row.querySelector('.sec-expand-hint');
    if (!text || !hint || hint.classList.contains('hidden')) return;
    this.#toggleTruncated(text, hint);
  }

  closePanel() {
    this.#open = false;
    dialog.closeDialog();
  }

  async #queryAndRender() {
    state.preventDialogClose = true;
    try {
      const res = await services.bgMsg({ type: 'GET_SECURITY_STATUS' });
      if (!res.ok || !res.status) throw new Error(res.error || 'QUERY_FAILED');
      this.#render(res.status);
    } catch (e) {
      this.#renderError(e.message);
    } finally {
      state.preventDialogClose = false;
    }
  }

  #render(status) {
    this.#renderKey(status.key, status.keyUpdatedAt);
    this.#renderSig('following', status.signatures.following, 'secSigFollowing', 'secSigFollowingValue', 'secSigFollowingStatus', 'secSigFollowingHint',
      '请在抖音页面访问"关注"列表，等待列表加载后返回刷新状态');
    this.#renderSig('post', status.signatures.post, 'secSigPost', 'secSigPostValue', 'secSigPostStatus', 'secSigPostHint',
      '请在抖音页面访问任意作者主页，等待作品加载后返回刷新状态');
    this.#renderSig('favorite', status.signatures.favorite, 'secSigFavorite', 'secSigFavoriteValue', 'secSigFavoriteStatus', 'secSigFavoriteHint',
      '请在抖音页面访问"喜欢"列表，等待加载后返回刷新状态');
    this.#renderSig('collection', status.signatures.collection, 'secSigCollection', 'secSigCollectionValue', 'secSigCollectionStatus', 'secSigCollectionHint',
      '请在抖音页面访问"收藏"列表，等待加载后返回刷新状态');
    this.#renderHooks(status.hooks);
  }

  #renderKey(key, updatedAt) {
    const statusEl = document.getElementById('secKeyStatus');
    const valueEl = document.getElementById('secKeyValueText');
    const expandHint = document.querySelector('#secKeyValue .sec-expand-hint');
    const hintEl = document.getElementById('secKeyHint');

    if (key) {
      const timeStr = updatedAt ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      statusEl.textContent = timeStr ? `✅ 可用 · ${timeStr}` : '✅ 可用';
      statusEl.className = 'sec-value sec-ok';
      valueEl.textContent = key;
      valueEl.dataset.fullValue = key;
      valueEl.classList.add('sec-truncate');
      valueEl.classList.remove('sec-expanded');
      if (expandHint) {
        expandHint.classList.remove('hidden');
        expandHint.textContent = '[展开]';
      }
      hintEl.classList.add('hidden');
    } else {
      statusEl.textContent = '❌ 不可用';
      statusEl.className = 'sec-value sec-err';
      valueEl.textContent = '—';
      valueEl.dataset.fullValue = '';
      valueEl.classList.add('sec-truncate');
      valueEl.classList.remove('sec-expanded');
      if (expandHint) expandHint.classList.add('hidden');
      hintEl.classList.remove('hidden');
      hintEl.textContent = '请确保抖音页面已打开且您已登录 → 刷新抖音页面（按 F5） → 等待页面加载完成（约 3-5 秒） → 返回此处点击"刷新状态"';
    }
  }

  #renderSig(type, sig, rowId, valueId, statusId, hintId, guidance) {
    const valueEl = document.getElementById(valueId);
    const statusEl = document.getElementById(statusId);
    const expandHint = document.getElementById(rowId)?.querySelector('.sec-expand-hint');
    const hintEl = document.getElementById(hintId);
    const v = sig?.value || '';
    const t = sig?.updatedAt || 0;

    if (v) {
      const timeStr = t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      statusEl.textContent = timeStr ? `✅ 已捕获 · ${timeStr}` : '✅ 已捕获';
      statusEl.className = 'sec-value sec-ok';
      valueEl.textContent = v;
      valueEl.dataset.fullValue = v;
      valueEl.className = 'sec-value sec-truncate';
      valueEl.classList.remove('sec-expanded');
      if (expandHint) {
        expandHint.classList.remove('hidden');
        expandHint.textContent = '[展开]';
      }
      hintEl.classList.add('hidden');
    } else {
      statusEl.textContent = '❌ 未捕获';
      statusEl.className = 'sec-value sec-err';
      valueEl.textContent = '—';
      valueEl.dataset.fullValue = '';
      valueEl.className = 'sec-value sec-err';
      valueEl.classList.remove('sec-expanded');
      if (expandHint) expandHint.classList.add('hidden');
      hintEl.classList.remove('hidden');
      hintEl.textContent = guidance;
    }
  }

  #renderHooks(hooks) {
    const fetchEl = document.getElementById('secHookFetch');
    const xhrEl = document.getElementById('secHookXhr');

    fetchEl.textContent = hooks.fetch ? '✅ 运行中' : '❌ 未运行';
    fetchEl.className = 'sec-value ' + (hooks.fetch ? 'sec-ok' : 'sec-err');

    xhrEl.textContent = hooks.xhr ? '✅ 运行中' : '❌ 未运行';
    xhrEl.className = 'sec-value ' + (hooks.xhr ? 'sec-ok' : 'sec-err');
  }

  #renderError(msg) {
    const fetchEl = document.getElementById('secHookFetch');
    const xhrEl = document.getElementById('secHookXhr');
    if (fetchEl) { fetchEl.textContent = '❌ 查询失败'; fetchEl.className = 'sec-value sec-err'; }
    if (xhrEl) { xhrEl.textContent = '❌ 查询失败'; xhrEl.className = 'sec-value sec-err'; }
  }
}

const securityStatus = new SecurityStatus();

// ---------- WorksGrid ----------
class WorksGrid extends VirtualGrid {
  #worksMap = null;

  constructor() {
    super({
      container: dom.mainContainer,
      itemClass: 'work-card',
      skeletonClass: 'work-skeleton',
      itemKey: 'awemeId',
      emptyMsg: '还没有保存的作品',
      emptyHint: '浏览抖音时，作品会自动被捕获',
    });
  }

  renderCards() {
    this.#worksMap = new Map(state.works.map(w => [w.awemeId, w]));
    this.render(
      state.works,
      '还没有保存的作品',
      '浏览抖音时，作品会自动被捕获'
    );
  }

  createItem(work) {
    // 保留原有的 createItem 逻辑
    const card = document.getElementById('workCardTemplate').content.cloneNode(true).firstElementChild;
    card.dataset.awemeId = work.awemeId;

    const media = card.querySelector('.work-media');
    const badge = card.querySelector('.work-type-badge');
    const thumb = card.querySelector('.work-thumb');
    const video = card.querySelector('.work-video-player');
    const controls = card.querySelector('.work-video-controls');
    const checkbox = card.querySelector('.work-checkbox');
    const titleText = card.querySelector('.work-title-text');

    badge.classList.toggle('hidden', work.type === 'video');
    if (work.type === 'note') {
      video.style.display = 'none';
      controls.style.display = 'none';
    }

    batch.updateCheckboxDOM(checkbox, state.selectedIds.has(work.awemeId));
    checkbox.style.display = state.batchMode ? '' : 'none';

    if (work.type === 'video' && utils.getVideoUrl(work)) {
      const videoSrc = utils.getVideoUrl(work);
      const coverUrl = work.cover || '';
      thumb.src = utils.pickHttpsUrl(coverUrl);
      thumb.alt = work.desc || '';
      thumb.onerror = function () {
        if (!this.dataset.retry) {
          this.dataset.retry = '1';
          this.src = utils.pickHttpsUrl(coverUrl);
          return;
        }
        utils.setImagePlaceholder(this, '🎬');
      };

      const progress = controls.querySelector('.video-progress');
      const timeSpan = controls.querySelector('.video-time');
      const muteBtn = controls.querySelector('.video-mute-btn');
      const playBtn = controls.querySelector('.video-play-btn');
      let hoverTimer = null;

      media.addEventListener('mouseenter', () => {
        if (state.batchMode) return;
        if (!dom.dialogOverlay.classList.contains('hidden')) return;
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          video.classList.add('video-ready');
          controls.classList.add('video-ready');
          thumb.classList.add('video-hidden');
          delete video.dataset.retries;
          video.src = card.dataset.videoUrl || videoSrc;
          video.currentTime = 0;
          video.muted = true;
          muteBtn.innerHTML = config.icons.mute;
          video.load();
          const tryPlay = () => {
            video.play().catch(() => {
              timeSpan.textContent = '⚠ 无法播放';
            });
          };
          const onCanPlay = () => {
            tryPlay();
          };
          video.addEventListener('canplay', onCanPlay, { once: true });
          setTimeout(() => {
            video.removeEventListener('canplay', onCanPlay);
            tryPlay();
          }, config.VIDEO_FALLBACK_TIMEOUT);
        }, config.HOVER_PREVIEW_DELAY);
      });
      media.addEventListener('mouseleave', () => {
        if (state.batchMode) return;
        if (hoverTimer) clearTimeout(hoverTimer);
        clearTimeout(video._retryTimer);
        video.pause();
        video.src = '';
        video.load();
        video.classList.remove('video-ready');
        controls.classList.remove('video-ready');
        thumb.classList.remove('video-hidden');
      });
      video.addEventListener('timeupdate', () => {
        detail.updateVideoProgress(video, progress, timeSpan, '0.3');
      });
      video.addEventListener('loadedmetadata', () => {
        timeSpan.textContent = `0:00 / ${detail.formatTime(video.duration)}`;
      });
      video.onerror = () => {
        detail.handleVideoError(video, {
          onMax: () => { timeSpan.textContent = '⚠ 链接失效'; },
          onRetry: (retries, delay) => {
            timeSpan.textContent = delay > 0 ? `⏳ 重试(${retries + 1})…` : '⏳ 重试…';
          },
        });
      };
      progress.addEventListener('input', () => {
        if (video.duration) video.currentTime = (progress.value / 100) * video.duration;
      });
      muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        detail.toggleVideoMute(video, muteBtn);
      });
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        detail.toggleVideoPlay(video, playBtn);
      });
      video.addEventListener('play', () => {
        clearTimeout(video._retryTimer);
        playBtn.innerHTML = config.icons.pause;
      });
      video.addEventListener('pause', () => {
        playBtn.innerHTML = config.icons.play;
      });
    } else if (work.type === 'note') {
      const imgUrl = work.images?.[0] || work.cover || '';
      thumb.src = imgUrl;
      thumb.alt = work.desc || '';
      thumb.onerror = function () {
        if (!this.dataset.retry) {
          this.dataset.retry = '1';
          this.src = imgUrl;
          return;
        }
        utils.setImagePlaceholder(this, '📰');
      };
    }

    titleText.textContent = work.desc || '无文案';

    return card;
  }

  handleClick(event, work, el) {
    if (event.target.closest('.work-checkbox')) {
      event.stopPropagation();
      batch.toggleBatchSelect(work.awemeId, event.target.closest('.work-checkbox'));
      return;
    }
    if (event.target.closest('.work-action-btn[title="同步"]')) {
      event.stopPropagation();
      const btn = event.target.closest('.work-action-btn');
      this.#handleWorkSync(btn, work.awemeId);
      return;
    }
    if (event.target.closest('.work-action-btn[title="下载"]')) {
      event.stopPropagation();
      detail.downloadWork(work);
      return;
    }
    if (state.batchMode) {
      batch.toggleBatchSelect(work.awemeId, el.querySelector('.work-checkbox'));
      return;
    }
    detail.openDetail(work.awemeId);
  }

  async #handleWorkSync(btn, awemeId) {
    btn.disabled = true;
    btn.classList.add('work-syncing');
    try {
      const newWork = await services.refreshSingleWork(awemeId);
      if (newWork) {
        store.updateWork(awemeId, newWork);
      }
    } catch { }
    btn.classList.remove('work-syncing');
    btn.disabled = false;
  }

  restoreGridScroll() {
    const idx = detail.getDetailIndex();
    if (idx < 0 || idx >= state.works.length) return;
    requestAnimationFrame(() => {
      const grid = dom.mainGrid;
      if (!grid) return;
      const root = getComputedStyle(document.documentElement);
      const cardW = parseInt(root.getPropertyValue('--dy-card-size')) || config.CARD_SIZE_FALLBACK;
      const gap = config.CARD_GAP;
      const cols = Math.max(1, Math.floor((grid.clientWidth + gap) / (cardW + gap)));
      const row = Math.floor(idx / cols);
      const cardH = (cardW * 4) / 3 + config.CARD_HEIGHT_OFFSET;
      const target = row * (cardH + gap) - Math.min(window.innerHeight / 3, row * (cardH + gap));
      window.scrollTo({ top: Math.max(0, target) });
    });
  }

  updateCardDOM(awemeId) {
    const card = dom.mainContainer.querySelector(`[data-aweme-id="${awemeId}"]`);
    if (!card) return;
    const work = state.works.find(w => w.awemeId === awemeId);
    if (!work) return;
    if (card.classList.contains('work-skeleton')) {
      this.populateItem(card, work);
      return;
    }
    const videoUrl = utils.getVideoUrl(work);
    if (videoUrl) card.dataset.videoUrl = videoUrl;
    const thumb = card.querySelector('.work-thumb');
    if (thumb && work.cover) thumb.src = utils.pickHttpsUrl(work.cover);
    const title = card.querySelector('.work-title-text');
    if (title) title.textContent = work.desc || '无文案';
  }
}

const worksGrid = new WorksGrid();

// ---------- Detail ----------
class Detail {
  #index = -1;
  #cleanups = [];
  #loopMode = 'single';
  #detailListenersAttached = false;
  #noteWork = null;
  #noteImgIndex = 0;
  #noteAutoPlayTimer = null;
  #noteIsPlaying = false;
  #noteShowImage(idx) {
    this.#noteImgIndex = idx;
    const img = dom.detailImage;
    img.src = this.#noteWork.images[this.#noteImgIndex] || this.#noteWork.cover || '';
    dom.detailImgCounter.textContent = `${this.#noteImgIndex + 1} / ${this.#noteWork.images.length}`;
    dom.detailTime.textContent = `${this.#noteImgIndex + 1} / ${this.#noteWork.images.length}`;
  }
  #noteStartAutoPlay() {
    const AUTO_PLAY_INTERVAL = config.NOTE_AUTO_PLAY_INTERVAL;
    this.#noteStopAutoPlay();
    this.#noteAutoPlayTimer = setInterval(() => {
      if (this.#noteImgIndex < this.#noteWork.images.length - 1) {
        this.#noteShowImage(this.#noteImgIndex + 1);
      } else {
        const mode = this.nextOnEnd();
        if (mode === 'single') {
          this.#noteShowImage(0);
        } else if (mode === 'group') {
          this.renderDetail();
        } else {
          this.#noteStopAutoPlay();
          this.#noteIsPlaying = false;
          this.#noteUpdatePlayBtn();
        }
      }
    }, AUTO_PLAY_INTERVAL);
  }
  #noteStopAutoPlay() {
    if (this.#noteAutoPlayTimer) {
      clearInterval(this.#noteAutoPlayTimer);
      this.#noteAutoPlayTimer = null;
    }
  }
  #noteUpdatePlayBtn() {
    if (this.#noteIsPlaying) {
      dom.detailPlayBtn.innerHTML = config.icons.pause;
      dom.detailPlayBtn.title = '暂停';
    } else {
      dom.detailPlayBtn.innerHTML = config.icons.play;
      dom.detailPlayBtn.title = '自动播放';
    }
  }
  #toggleNoteAutoPlay() {
    const audio = dom.detailAudio;
    if (this.#noteIsPlaying) {
      this.#noteStopAutoPlay();
      audio?.pause();
      this.#noteIsPlaying = false;
    } else {
      this.#noteStartAutoPlay();
      audio?.play().catch(() => { });
      this.#noteIsPlaying = true;
    }
    this.#noteUpdatePlayBtn();
  }

  #toggleNoteMute() {
    const audio = dom.detailAudio;
    if (!audio) return;
    audio.muted = !audio.muted;
    dom.detailMuteBtn.innerHTML = audio.muted ? config.icons.mute : config.icons.unmute;
    dom.detailMuteBtn.title = audio.muted ? '取消静音' : '静音';
  }

  static MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
  };

  openDetailIndex(awemeId) {
    const idx = state.works.findIndex((w) => w.awemeId === awemeId);
    if (idx === -1) return null;
    this.#index = idx;
    return state.works[idx];
  }

  getCurrentWork() {
    return state.works[this.#index] || null;
  }

  closeDetailIndex() {
    this.runCleanups();
    this.#index = -1;
  }

  nextDetailIndex() {
    if (this.#index < state.works.length - 1) {
      this.#index++;
      return this.getCurrentWork();
    }
    return null;
  }

  prevDetailIndex() {
    if (this.#index > 0) {
      this.#index--;
      return this.getCurrentWork();
    }
    return null;
  }

  getDetailIndex() {
    return this.#index;
  }

  total() {
    return state.works.length;
  }

  addCleanup(fn) {
    this.#cleanups.push(fn);
  }

  runCleanups() {
    for (const fn of this.#cleanups.splice(0)) {
      try { fn(); } catch (e) { }
    }
  }

  cycleLoopMode() {
    if (this.#loopMode === 'single') {
      this.#loopMode = 'group';
    } else if (this.#loopMode === 'group') {
      this.#loopMode = 'off';
    } else {
      this.#loopMode = 'single';
    }
    return this.#loopMode;
  }

  nextOnEnd() {
    if (this.#loopMode === 'single') return 'single';
    if (this.#loopMode === 'group' && state.works.length > 1) {
      if (this.#index < state.works.length - 1) {
        this.#index++;
      } else {
        this.#index = 0;
      }
      return 'group';
    }
    return 'off';
  }

  async removeWork(awemeId) {
    await services.bgMsg({ type: 'DELETE_WORKS', awemeIds: [awemeId] });
    state.selectedIds.delete(awemeId);
    const idx = state.works.findIndex((w) => w.awemeId === awemeId);
    store.spliceWork(idx);
  }

  async syncWork(awemeId) {
    return services.refreshSingleWork(awemeId);
  }

  updateLoopBtn(isVideo) {
    if (this.#loopMode === 'single') {
      dom.detailLoopBtn.innerHTML = config.icons.loopSingle;
      dom.detailLoopBtn.title = isVideo ? '单作品循环' : '幻灯片循环';
    } else if (this.#loopMode === 'group') {
      dom.detailLoopBtn.innerHTML = config.icons.loopGroup;
      dom.detailLoopBtn.title = '分组循环';
    } else {
      dom.detailLoopBtn.innerHTML = config.icons.noLoop;
      dom.detailLoopBtn.title = '不循环';
    }
  }

  async openDetail(awemeId) {
    const work = this.openDetailIndex(awemeId);
    if (!work) return;
    dom.detailOverlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    this.renderDetail();
  }

  renderDetail() {
    this.runCleanups();
    const work = this.getCurrentWork();
    if (!work) return this.closeDetail();

    const isVideo = work.type === 'video' && utils.getVideoUrl(work);
    if (isVideo) {
      this.resetAudio();
    } else {
      this.resetMediaElements();
    }

    const bgUrl = work.cover || work.images?.[0] || '';
    if (bgUrl) {
      const absBg = utils.pickHttpsUrl(bgUrl);
      dom.detailOverlay.style.setProperty('--bg-url', `url(${absBg})`);
    }

    const typePath = work.type === 'note' ? 'note' : 'video';
    const fullLink = `${config.URLS.BASE}/${typePath}/${work.awemeId}`;
    const totalWorks = state.works.length;
    const isNote = work.type === 'note' && work.images?.length > 0;

    dom.detailPlayBtn.style.display = '';
    dom.detailMuteBtn.style.display = '';

    dom.detailVideoContainer.classList.toggle('hidden', !isVideo);
    dom.detailImageContainer.classList.toggle('hidden', !isNote && (isVideo || !work.cover));
    dom.detailProgressSlider.classList.toggle('hidden', !isVideo);

    if (isVideo) {
      dom.detailTime.textContent = '0:00 / 0:00';
    } else if (isNote) {
      dom.detailTime.textContent = `1 / ${work.images.length}`;
    } else {
      dom.detailTime.textContent = '';
    }

    if (work.authorHomeUrl) {
      dom.detailAuthor.textContent = `@${work.nickname || '未知作者'}`;
      dom.detailAuthor.title = work.authorHomeUrl;
      dom.detailAuthor.classList.remove('hidden');
    } else {
      dom.detailAuthor.classList.add('hidden');
    }

    dom.detailTitle.textContent = (work.desc || '无作品描述').slice(0, config.DETAIL_TITLE_MAX_LEN);
    dom.detailTitle.title = fullLink;

    this.updateLoopBtn(isVideo);

    if (totalWorks > 1) {
      dom.detailCounter.textContent = `${this.getDetailIndex() + 1} / ${totalWorks}`;
      dom.detailCounter.classList.remove('hidden');
    } else {
      dom.detailCounter.classList.add('hidden');
    }

    if (isVideo) {
      this.renderDetailVideo(work);
    } else if (isNote) {
      this.renderDetailNote(work);
    } else if (work.cover) {
      dom.detailImage.src = work.cover;
      dom.detailPlayBtn.style.display = 'none';
      dom.detailMuteBtn.style.display = 'none';
      dom.detailImgCounter.classList.add('hidden');
      dom.detailNavLeft.classList.add('hidden');
      dom.detailNavRight.classList.add('hidden');
    }
  }

  renderDetailVideo(work) {
    const video = dom.detailVideo;
    video.src = utils.getVideoUrl(work);

    dom.detailMuteBtn.innerHTML = video.muted ? config.icons.mute : config.icons.unmute;

    video.play().catch((err) => {
      if (err.name === 'NotAllowedError') {
        video.muted = true;
        dom.detailMuteBtn.innerHTML = config.icons.mute;
        video.play().catch(() => { });
      }
    });

    video.onerror = () => {
      this.handleVideoError(video, {
        onMax: () => {
          dom.detailPlayBtn.innerHTML = config.icons.play;
          dom.detailPlayBtn.title = '链接失效';
        },
        onRetry: (retries, delay) => {
          dom.detailPlayBtn.innerHTML = config.icons.play;
          dom.detailPlayBtn.title = delay > 0 ? `重试(${retries + 1})` : '重试';
        },
      });
    };
    this.addCleanup(() => clearTimeout(video._retryTimer));

    dom.detailPlayBtn.innerHTML = config.icons.pause;

    const slider = dom.detailProgressSlider;
    slider.value = 0;
    slider.style.background = 'linear-gradient(to right, #fff 0%, rgba(255,255,255,0.2) 0%)';
  }

  renderDetailNote(work) {
    this.#noteWork = work;
    this.#noteImgIndex = 0;
    this.#noteAutoPlayTimer = null;
    this.#noteIsPlaying = false;
    const img = dom.detailImage;
    const audio = dom.detailAudio;

    img.src = work.images[0] || work.cover || '';
    img.alt = work.desc || '';

    dom.detailImgCounter.textContent = `1 / ${work.images.length}`;
    dom.detailImgCounter.classList.toggle('hidden', work.images.length <= 1);

    if (work.music) {
      audio.src = utils.pickHttpsUrl(work.music);

      dom.detailMuteBtn.innerHTML = audio.muted ? config.icons.mute : config.icons.unmute;

      audio.play().catch((err) => {
        if (err.name === 'NotAllowedError') {
          audio.muted = true;
          dom.detailMuteBtn.innerHTML = config.icons.mute;
          audio.play().catch(() => { });
        }
      });
    } else {
      dom.detailMuteBtn.style.display = 'none';
    }

    this.#noteIsPlaying = true;
    this.#noteStartAutoPlay();
    this.#noteUpdatePlayBtn();

    dom.detailNavLeft.classList.toggle('hidden', work.images.length <= 1);
    dom.detailNavRight.classList.toggle('hidden', work.images.length <= 1);

    this.addCleanup(() => this.#noteStopAutoPlay());
  }

  initDetailEvents() {
    if (this.#detailListenersAttached) return;
    this.#detailListenersAttached = true;

    dom.detailOverlay.addEventListener(
      'wheel',
      (e) => {
        if (e.deltaY > 0) this.nextDetail();
        else this.prevDetail();
      },
      { passive: true }
    );

    document.addEventListener('keydown', (e) => {
      if (dom.detailOverlay.classList.contains('hidden')) return;
      const work = this.getCurrentWork();
      if (e.key === 'Escape') this.closeDetail();
      if (e.key === 'ArrowUp') this.prevDetail();
      if (e.key === 'ArrowDown') this.nextDetail();
      if (work?.type === 'note' && work.images?.length > 1) {
        if (e.key === 'ArrowLeft' && this.#noteImgIndex > 0) {
          e.preventDefault();
          this.#noteShowImage(this.#noteImgIndex - 1);
        }
        if (e.key === 'ArrowRight' && this.#noteImgIndex < work.images.length - 1) {
          e.preventDefault();
          this.#noteShowImage(this.#noteImgIndex + 1);
        }
      }
    });

    dom.detailClose.addEventListener('click', () => this.closeDetail());

    dom.detailAuthor.addEventListener('click', () => {
      const work = this.getCurrentWork();
      if (work?.authorHomeUrl) window.open(work.authorHomeUrl, '_blank');
    });

    dom.detailTitle.addEventListener('click', () => {
      const work = this.getCurrentWork();
      if (!work) return;
      const typePath = work.type === 'note' ? 'note' : 'video';
      window.open(`${config.URLS.BASE}/${typePath}/${work.awemeId}`, '_blank');
    });

    dom.detailRemoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      const removeBody = document.createElement('p');
      removeBody.className = 'confirm-delete-msg';
      removeBody.textContent = `确定要移除"${(work.desc || '无作品描述').slice(0, config.DETAIL_TITLE_MAX_LEN)}"？`;
      dialog.showDialog('移除作品', removeBody, [
        { text: '取消', ghost: true, callback: () => dialog.closeDialog() },
        {
          text: '移除',
          danger: true,
          callback: async () => {
            dialog.updateDialog('正在移除…', utils.SPINNER_HTML);
            state.preventDialogClose = true;
            try {
              await this.removeWork(work.awemeId);
              if (state.works.length === 0) {
                this.closeDetail();
              } else {
                if (this.getDetailIndex() >= state.works.length) this.#index = state.works.length - 1;
                this.renderDetail();
              }
              store.notify('groups');
              dom.dialogTitle.textContent = '移除完成';
              dom.dialogBody.innerHTML = '<p>已移除该作品</p>';
              dialog.showOkDialog();
            } finally {
              state.preventDialogClose = false;
            }
          },
        },
      ]);
    });

    dom.detailLoopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      this.cycleLoopMode();
      this.updateLoopBtn(work?.type === 'video' && utils.getVideoUrl(work));
    });

    dom.detailSyncBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      dom.detailSyncBtn.disabled = true;
      try {
        const newWork = await this.syncWork(work.awemeId);
        if (newWork) {
          store.updateWork(work.awemeId, newWork);
        }
      } catch { }
      dom.detailSyncBtn.disabled = false;
    });

    dom.detailDownloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (work) this.downloadWork(work);
    });

    dom.detailPlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      if (work.type === 'note' && work.images?.length > 0) {
        this.#toggleNoteAutoPlay();
      } else {
        this.toggleDetailVideoPlay();
      }
    });

    dom.detailMuteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      if (work.type === 'note' && work.music) {
        this.#toggleNoteMute();
      } else if (work.type === 'video') {
        this.toggleDetailVideoMute();
      }
    });

    dom.detailVideoWrap.addEventListener('click', () => this.toggleDetailVideoPlay());

    const video = dom.detailVideo;
    video.addEventListener('play', () => clearTimeout(video._retryTimer));
    video.addEventListener('timeupdate', () => {
      this.updateVideoProgress(video, dom.detailProgressSlider, dom.detailTime, '0.2');
    });
    video.addEventListener('ended', () => {
      const mode = this.nextOnEnd();
      if (mode === 'single') video.play();
      else if (mode === 'group') this.renderDetail();
    });

    dom.detailProgressSlider.addEventListener('input', () => {
      if (video.duration) video.currentTime = (dom.detailProgressSlider.value / 100) * video.duration;
    });

    dom.detailNavLeft.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.#noteImgIndex > 0) this.#noteShowImage(this.#noteImgIndex - 1);
    });

    dom.detailNavRight.addEventListener('click', (e) => {
      e.stopPropagation();
      const maxIndex = (this.#noteWork?.images.length || 1) - 1;
      if (this.#noteImgIndex < maxIndex) this.#noteShowImage(this.#noteImgIndex + 1);
    });

    const noteContainer = dom.detailImageContainer.querySelector('.detail-image-container');
    noteContainer.addEventListener('click', (e) => {
      if (e.target.closest('.detail-nav-btn')) return;
      this.#toggleNoteAutoPlay();
    });
  }

  nextDetail() {
    if (this.nextDetailIndex()) this.renderDetail();
  }

  prevDetail() {
    if (this.prevDetailIndex()) this.renderDetail();
  }

  closeDetail() {
    this.closeDetailIndex();
    this.resetMediaElements();
    dom.detailProgressSlider.classList.add('hidden');
    dom.detailVideoContainer.classList.add('hidden');
    dom.detailImageContainer.classList.add('hidden');
    dom.detailOverlay.style.removeProperty('--bg-url');
    dom.detailOverlay.classList.add('hidden');
    document.body.style.overflow = '';
    worksGrid.restoreGridScroll();
  }

  resetVideo() {
    dom.detailVideo.removeAttribute('src');
    dom.detailVideo.load();
  }

  resetAudio() {
    dom.detailAudio.pause();
    dom.detailAudio.removeAttribute('src');
    dom.detailAudio.load();
  }

  resetMediaElements() {
    this.resetVideo();
    this.resetAudio();
  }

  toggleVideoPlay(video, playBtn) {
    if (video.paused) {
      video.play().catch(() => { });
      playBtn.innerHTML = config.icons.pause;
    } else {
      video.pause();
      playBtn.innerHTML = config.icons.play;
    }
  }

  toggleVideoMute(video, muteBtn) {
    video.muted = !video.muted;
    muteBtn.innerHTML = video.muted ? config.icons.mute : config.icons.unmute;
  }

  updateVideoProgress(video, slider, timeSpan, opacity) {
    if (video.duration) {
      const pct = (video.currentTime / video.duration) * 100;
      slider.value = pct;
      slider.style.background = `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,${opacity}) ${pct}%)`;
      timeSpan.textContent = `${this.formatTime(video.currentTime)} / ${this.formatTime(video.duration)}`;
    }
  }

  handleVideoError(video, ui) {
    if (!video.src) return;
    const retries = parseInt(video.dataset.retries || '0');
    if (retries >= config.VIDEO_RETRY_MAX) {
      ui.onMax(retries);
      return;
    }
    video.dataset.retries = String(retries + 1);
    const delay = config.VIDEO_RETRY_DELAYS[retries] ?? config.VIDEO_RETRY_FALLBACK_DELAY;
    ui.onRetry(retries, delay);
    clearTimeout(video._retryTimer);
    video._retryTimer = setTimeout(() => {
      video.load();
      video.play().catch(() => { });
    }, delay);
  }

  toggleDetailVideoPlay() {
    this.toggleVideoPlay(dom.detailVideo, dom.detailPlayBtn);
    dom.detailPlayBtn.title = dom.detailVideo.paused ? '播放' : '暂停';
  }

  toggleDetailVideoMute() {
    this.toggleVideoMute(dom.detailVideo, dom.detailMuteBtn);
    dom.detailMuteBtn.title = dom.detailVideo.muted ? '取消静音' : '静音';
  }

  formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  getFilename(work, ext) {
    const nick = (work.nickname || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
    return `${nick}_${work.awemeId}.${ext}`;
  }

  async fetchBlob(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const ext = Detail.MIME_EXT[blob.type] || 'mp4';
    return { blob, ext };
  }

  triggerDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), config.BLOB_REVOKE_DELAY);
  }

  async downloadWork(work) {
    await this.#downloadWithRetry(work, 0);
  }

  async #downloadWithRetry(w, attempt) {
    try {
      if (w.type === 'video' && utils.getVideoUrl(w)) {
        const { blob, ext } = await this.fetchBlob(utils.getVideoUrl(w));
        this.triggerDownload(blob, this.getFilename(w, ext));
      } else if (w.type === 'note' && w.images?.length) {
        for (const [i, img] of w.images.entries()) {
          const absUrl = utils.pickHttpsUrl(img || '');
          const { blob, ext } = await this.fetchBlob(absUrl);
          this.triggerDownload(blob, this.getFilename(w, `${i + 1}.${ext}`));
        }
      }
    } catch (err) {
      console.error('[DY] download failed:', err);
      if (attempt >= config.DOWNLOAD_MAX_RETRY) {
        dialog.showToast('下载失败: ' + (err.message || '未知错误'));
        return;
      }
      await new Promise((r) => setTimeout(r, config.FETCH_RETRY_DELAY));
      await this.#downloadWithRetry(w, attempt + 1);
    }
  }
}

const detail = new Detail();

// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;
  switch (message.type) {
    case 'SYNC_PROGRESS':
      sync.onSyncProgress(message);
      break;
    case 'SYNC_DONE':
      sync.onSyncDone(message);
      break;
    case 'FOLLOWING_PROGRESS':
      sync.onFollowingProgress(message);
      break;
    case 'FAVORITES_PROGRESS':
      favorites.onFavProgress(message);
      break;
    case 'COLLECTION_PROGRESS':
      favorites.onCollectionProgress(message);
      break;
  }
});

// ---------- 顶层函数 ----------
function updateDomainSlider(domain) {
  const btn = document.querySelector(`.ds-btn[data-domain="${domain}"]`);
  if (!btn || !dom.dsSlider || !dom.domainSwitch) return;
  const parentRect = dom.domainSwitch.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  const left = btnRect.left - parentRect.left;
  const width = btnRect.width;
  dom.dsSlider.style.transform = `translateX(${left}px)`;
  dom.dsSlider.style.width = `${width}px`;
}

function updateGroupTabSlider(groupId) {
  if (!dom.groupTabSlider) return;
  const btn = dom.groupTabs.querySelector(`.group-tab[data-group-id="${groupId}"]`);
  if (!btn) {
    dom.groupTabSlider.style.width = '0';
    return;
  }
  const tabsRect = dom.groupTabs.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  const left = btnRect.left - tabsRect.left + dom.groupTabs.scrollLeft;
  const width = btnRect.width;
  dom.groupTabSlider.style.transform = `translateX(${left}px)`;
  dom.groupTabSlider.style.width = `${width}px`;
}

function switchDomain(domain) {
  if (domain === state.domain) return;

  dom.mainContainer.innerHTML = '';

  state.selectedIds.clear();
  store.set('batchMode', false);

  detail.closeDetail();
  if (dom.sidebar) {
    const isExpanded = !dom.sidebar.classList.contains('sidebar-zero');
    if (isExpanded) {
      sidebar.setSidebarWidth(0);
      sidebar.saveSidebarWidth(0);
    }
  }
  sidebar.clearSidebarActive();
  state.currentFollowingUid = null;
  state.currentFollowingSecUid = null;

  document.body.classList.remove('domain-works', 'domain-followings');
  document.body.classList.add('domain-' + domain);

  document.querySelectorAll('.ds-btn').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.domain === domain);
  });
  updateDomainSlider(domain);

  store.set('domain', domain);
  state.currentGroupId = 'all';
}

function renderErrorState(msg, detail) {
  dom.emptyState.classList.add('hidden');
  dom.mainContainer.classList.add('hidden');
  dom.errorState.querySelector('p').textContent = msg;
  const hint = dom.errorState.querySelector('.error-hint');
  if (hint) hint.textContent = detail || '请检查网络后重试';
  dom.errorState.classList.remove('hidden');
}

// ---------- DOM 事件绑定 ----------
document.querySelectorAll('.ds-btn').forEach(tab => {
  tab.addEventListener('click', () => switchDomain(tab.dataset.domain));
});

dom.btnBatch.addEventListener('click', () => batch.handleBatchToggle());
dom.batchSelectAll.addEventListener('click', () => batch.handleBatchSelectAll());
dom.batchDelete.addEventListener('click', () => batch.handleBatchDelete());
dom.batchMove.addEventListener('click', () => batch.handleBatchMove());

dom.btnMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.menuDropdown.classList.toggle('hidden');
});
document.addEventListener('click', () => {
  dom.menuDropdown.classList.add('hidden');
});
dom.menuDropdown.addEventListener('click', () => {
  dom.menuDropdown.classList.add('hidden');
});

dom.dialogClose.addEventListener('click', () => {
  if (state.preventDialogClose) return;
  if (state.activeDialog) {
    state.activeDialog();
    chrome.runtime.sendMessage({ type: 'CANCEL_ACTIVE_TASK' }).catch(() => { });
  }
  dialog.closeDialog();
});

dom.btnGroupManage.addEventListener('click', () => groups.showGroupManage());

dom.btnImport.addEventListener('click', () => {
  dom.fileInput.click();
});
dom.fileInput.addEventListener('change', (e) => importExport.handleImport(e));

dom.btnExport.addEventListener('click', () => importExport.handleExport());

dom.btnFavorites.addEventListener('click', () => favorites.openScanDialog({
  title: '扫描点赞',
  stateKey: 'favoriteWorks',
  fetchingKey: 'favoriteFetching',
  requestIdKey: 'favRequestId',
  cancelingKey: 'cancelingFavorites',
  cancelType: 'CANCEL_LIKE',
  formatStats: (total, unfollowed) => `已扫描 ${total} 个点赞作品，发现 ${unfollowed} 个未关注作者作品`,
  cancelLabel: '取消点赞',
  noSignatureUrl: config.URLS.USER_SELF + config.URLS.LIKE_TAB,
  noSignatureStep: '点赞',
  noSignatureScan: '扫描点赞列表',
  buildFetchArgs: () => ({ type: 'FETCH_FAVORITES', secUid: null }),
  needSecUid: true,
}));
dom.btnCollections.addEventListener('click', () => favorites.openScanDialog({
  title: '扫描收藏',
  stateKey: 'collectionWorks',
  fetchingKey: 'collectionFetching',
  requestIdKey: 'collectionRequestId',
  cancelingKey: 'cancelingCollections',
  cancelType: 'CANCEL_COLLECTION',
  formatStats: (total, unfollowed) => `${total} 件 · 未关注 ${unfollowed} 件`,
  cancelLabel: '取消收藏',
  noSignatureUrl: config.URLS.USER_SELF + config.URLS.COLLECTION_TAB,
  noSignatureStep: '收藏',
  noSignatureScan: '扫描收藏列表',
  buildFetchArgs: () => ({ type: 'FETCH_COLLECTION' }),
  needSecUid: false,
}));

dom.btnSecurityStatus?.addEventListener('click', () => securityStatus.openPanel());

dom.btnReset.addEventListener('click', async () => {
  const domain = state.domain;
  const domainName = domain === 'works' ? '作品' : '关注';

  const resetBody = document.createElement('p');
  resetBody.className = 'confirm-delete-msg';
  resetBody.textContent = `确定要清空当前${domainName}域的所有数据？此操作不可撤销！`;
  dialog.showDialog(`确认重置${domainName}`, resetBody, [
    { text: '取消', ghost: true, callback: () => dialog.closeDialog() },
    {
      text: `清空${domainName}数据`,
      danger: true,
      callback: async () => {
        dialog.updateDialog('正在重置…', `<p>正在清空数据…</p>${utils.SPINNER_HTML}`);
        state.preventDialogClose = true;
        try {
          await services.bgMsg({ type: 'RESET_DOMAIN', domain });
          state.selectedIds.clear();
          store.set('batchMode', false);
          if (domain === 'works') {
            store.set('works', []);
          } else {
            store.set('followings', []);
          }
          await groups.renderGroupTabs();
          dom.dialogTitle.textContent = '重置完成';
          dom.dialogBody.innerHTML = `<p>${domainName}数据已清空</p>`;
          dialog.showOkDialog();
        } finally {
          state.preventDialogClose = false;
        }
      },
    },
  ]);
});

dom.btnSync.addEventListener('click', async () => {
  if (sync.isRunning()) return;
  if (state.domain === 'followings') {
    await sync.syncFollowings();
  } else {
    await sync.syncCurrentGroup();
  }
});

// ---------- init IIFE ----------
(async function init() {
  document.body.classList.remove('batch-mode');
  dom.mainContainer.classList.add('hidden');
  dom.emptyState.classList.add('hidden');
  for (const name of ['pause', 'play', 'mute', 'unmute', 'loopSingle', 'loopGroup', 'noLoop', 'check']) {
    config.icons[name] = document.getElementById('icon-' + name).innerHTML;
  }

  sidebar.initSidebar();
  detail.initDetailEvents();
  dom.groupTabs.addEventListener('scroll', () => {
    groups.updateTabMask();
    updateGroupTabSlider(state.currentGroupId);
  }, { passive: true });
  window.addEventListener('resize', groups.updateTabMask, { passive: true });
  window.addEventListener('resize', () => {
    updateDomainSlider(state.domain);
    updateGroupTabSlider(state.currentGroupId);
  }, { passive: true });
  dom.btnRetry.addEventListener('click', async () => {
    document.getElementById('errorState').classList.add('hidden');
    try {
      const works = await services.loadWorks(state.currentGroupId);
      store.set('works', works);
    } catch (err) {
      console.error('[DY] load works failed:', err);
      renderErrorState('数据加载失败', err.message);
    }
  });

  store.on('domain', async () => {
    sync.updateSyncBtnLabel();
    await groups.renderGroupTabs();
    try {
      await services.loadDomainData();
    } catch (err) {
      console.error('[DY] load domain data failed:', err);
      renderErrorState('数据加载失败', err.message);
    }
  });

  store.on('works', () => {
    if (state.domain === 'works') worksGrid.renderCards();
  });
  store.on('followings', () => {
    if (state.domain === 'followings') followingsGrid.renderFollowingCards();
  });
  store.on('groups', () => groups.renderGroupTabs());
  store.on('currentGroupId', async () => {
    await groups.renderGroupTabs();
    try {
      await services.loadDomainData();
    } catch (err) {
      console.error('[DY] load domain data failed:', err);
      renderErrorState('数据加载失败', err.message);
    }
  });
  store.on('batchMode', (v) => document.body.classList.toggle('batch-mode', v));
  store.on('work-updated', (awemeId) => {
    worksGrid.updateCardDOM(awemeId);
    if (detail.getDetailIndex() !== -1 && detail.getCurrentWork()?.awemeId === awemeId) {
      detail.renderDetail();
    }
  });

  document.body.classList.add('domain-works');
  updateDomainSlider('works');
  sync.updateSyncBtnLabel();
  await groups.renderGroupTabs();
  try {
    await services.loadDomainData();
  } catch (err) {
    console.error('[DY] load domain data failed:', err);
    renderErrorState('数据加载失败', err.message);
  }
})();
