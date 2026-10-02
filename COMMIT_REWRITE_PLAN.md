# Commit Message 改写方案

> 目标:全部 message 符合 Conventional Commits + 50/72 排版惯例,**只使用英文**,
> **正文长度统一收敛到 1–5 行(典型 2–4 行)**。
> 本文件同时是机读映射表:执行脚本按 `@@@ <短哈希>` 分隔符切分出每条新 message,
> `@@@ END` 为映射区终止符。改写完成后本文件与 `.git/rewrite-messages/` 均可删除。

## 一、适用规范(改写依据)

标题:`type(scope)!: description` — 祈使语气、小写开头、结尾无句号、≤72 字符。
正文:标题后空一行;解释 what/why;**总长 1–5 行**(典型 2–4 行);每行 ≤72 字符;
多事项用单行短横列表,单一主题用紧凑段落。超长细节不进 message,
留在 git diff 与 backup 分支(backup/pre-rewrite 保留原始长 message)。
Footer:再空一行;`BREAKING CHANGE:` / issue 引用。
英文化处理:`⌃⌄` → "up/down switcher",`9→11` → "9 to 11","全部" → "default group name"。
词汇统一:历史 message 一律改用 v2.0.3 定案词汇(旧 likes=点赞→favorites,旧 favorites=收藏→collections)。

## 二、范围与风险(先读)

| 事实 | 影响 |
|------|------|
| `origin/main` 与本地共享前 29 个提交(main = 628d494) | 改写共享历史后必须 **强推 main** |
| `release/v2.0.3` 仅本地(领先 5 个提交),无 tag | 这 5 条改写零风险 |
| 仓库无 tag | 无需 `--tag-name-filter` |
| 工作树干净 | 可直接执行 |

- **方案 B(推荐,全量 34 条)**:改写后 `git push --force origin main`。改写会变更所有 commit 哈希;凡有旧克隆的人需重新同步(`git fetch && git reset --hard origin/main`)。
- **方案 A(保守,仅本地 5 条)**:只改 `628d494..release/v2.0.3`,远端 main 不受影响,正常推送即可。执行命令见 §四末尾。但最严重的超长标题(65b27c0 等)都在共享段,方案 A 治不了。

> **决定:采用方案 B(全量 34 条,强推 main)。**

## 三、全量映射(34 条,旧→新)

格式:每块以 `@@@ <短哈希>` 开始,块体即新 message。哈希是**改写前**的原始哈希。
正文带宽:1–5 行,全部短横列表或紧凑段落,无超长枚举。
**每条 message 均已逐条对照该提交的实际 diff 核验(2026-10-03)。**

@@@ 0375fd0
chore: initial commit

Chrome extension to capture and manage Douyin works,
followings, favorites and collections.

@@@ 6ce6e24
feat: switch API calls to window.fetch and tune batch size

- rework options page layout and styles
- adjust scan batch size; add unlimitedStorage permission
- document fetch and cache behavior

@@@ d82efd2
feat: add independent mode for background sync and scan

Direct background request flow for works/followings sync and
collection scan/cancel, with its own crypto module and DNR
rules; favorites scan stays on the tab path.

@@@ b819e06
feat(options): add security and identity settings panel

Show security status, cookies, browser features and captured
signatures with copy buttons; secUid is captured from the
Douyin profile page or entered manually.

@@@ 306ab97
fix: sign independent works sync with a_bogus

Replace verifyfp/fp request parameters with a_bogus signing;
consolidate docs into CLAUDE.md and README.

@@@ 03ba6b3
feat: overlay runtime config from chrome.storage

User-tuned runtime parameters (per-chain scan/sync delays,
timeouts) persist under the runtimeConfig key and stack onto
CONFIG at service-worker startup; drop legacy x-bogus and
x-gnarly signing code from crypto.js.

@@@ 1ddcbaf
fix: retry scan requests after webid refresh on sign rejection

a_bogus can be rejected with web_id_sign_invalid during
favorites/collections scans; detect the 403, refresh the webid
chain and retry. Rename REDUNDANCY_AUDIT.md to DEAD_CODE_AUDIT.md.

@@@ cfd2768
docs: add dead-code audit

Add dead_code_audit.md with current findings; apply small
options-page cleanups found along the way.

@@@ 27a153c
fix: sign listcollection scan requests

Add webSign (x-secsdk-web-signature) for listcollection scans
plus the mssdk str-data exchange, so collection scans stop
failing with 403 Signature Not Found.

@@@ 2c5dd67
feat: calibrate following stats and polish media rendering

- following stats calibration
- align three-tier video URL extraction across layers
- switch media slots to div + background-image probes
- optimize grid and sidebar rendering

@@@ 33d144d
feat: add search, sort and filter to works/followings grids

- search, sort and filter with result counts
- keyboard access and focus management
- typed toasts
- detail player polish

@@@ efcfcb3
refactor(options): consolidate top-level functions into classes

- SearchBar: absorbs 16 search/filter functions + #debounceTimer
- AppShell: domain switch, error state, dialog close move in
- cross-class callers go through search.* / appShell singletons

@@@ 34008fb
fix(options): refresh grid on works/followings data events

Route store data events through search.refreshGridView; data
arriving while a filter is active also refreshes the filter-bar
summary instead of leaving stale counts.

@@@ 170df29
refactor(options): encapsulate searchState inside SearchBar

searchState becomes a #searchState private instance field; the
three SEARCH_*_LABELS consts become static class fields
accessed as SearchBar.SEARCH_*.

@@@ b90848a
refactor(options): move sidebar work template element into dom object

Centralize lookup with the other cached DOM handles.

@@@ 87a7b55
feat(options): replace sidebar grip with seam-width bar

Splitter is hidden and inert while the sidebar is collapsed.

@@@ 5e28604
docs: split technical reference into numbered volumes

Split docs into per-topic volumes 01-11; AGENTS.md becomes the
single source of truth and indexes them.

@@@ 7f98556
feat(options): add favorites/collections as first-class domains

Full domain lifecycle for both: scan, save-to-works and batch
cancel.

@@@ 25ebc11
feat(options): reset all filters on search bar close

Add author affiliation filter and result count display; unify
the default group name across domains.

@@@ 17c7279
refactor(background): rewrite background.js as classes

Also fixes:
- independent-mode following sync
- detail background/image stale carry-over
- card preview control polish

@@@ e1cbfa1
refactor(options): split options.js into ES modules

Module tree: core.js plus components, data, grids, sync and a
main.js composition root.

@@@ cc2a372
refactor(background): split background.js into ES modules

Module tree: core.js plus identity, data and tasks
subdirectories composed in main.js.

@@@ 5c7bae3
refactor(content): rewrite content.js and inject.js as classes

SignatureCapture, WorkExtractor, TaskController, ApiClient,
CancelHandler, SecurityStatus, FetchHook, ButtonInjector and
EventRouter.

@@@ e991bbd
feat: enable webSign by default for independent requests

- inject wrapper-signed fetches for page-context requests
- overhaul options keyboard access and accessibility
- persist search filters to URL hash

@@@ 65b27c0
feat(options): add icon action rail and vertical domain switch

- right-hand icon action rail; vertical domain switcher
- preserve grid anchor on layout change (card sizes 249/212)
- detail media fallback chain and batch download
- service worker reloads runtimeConfig on cold start

@@@ 0843aba
feat(options): re-align detail player with Douyin web

- full-width player with dual-form progress bar
- up/down work switcher capsule
- grid scroll anchor from measured DOM; CARD_GAP 9 to 11

Unify findSecUid so following sync stops hitting douyin
error 2096 (list not visible).

@@@ b8df149
refactor: dedupe long-task loops and API fetch wiring

Drop dead save routes and unused code/CSS across background,
content and options.

@@@ 705873f
feat: add author import for works and followings

- dual-mode paginated import loops
- batch download packs into a single zip
- four-domain backup dialog
- followings records lastUpdateAt
- dialogs refactor into a layered stack

@@@ 628d494
feat: collect STORE_CHANGED incrementally in the grid

- head-insert fresh upserts into the current view
- bulk broadcast carries a light id set for re-fetch
- virtual grid gains insertItems/removeItems duals
- debounced collection with visibility-gated flush
- author import loop extracted to author-works-import.js

@@@ 5935bda
fix(options): catch up viewport after full re-render

Schedule a viewport catch-up once rendering settles; otherwise
in-view skeletons stay gray when content height is unchanged
and no scroll event fires.

@@@ 88d49f2
perf(options): add staged view cache with dataVersion invalidation

- keyed filter premount/extend for closed views
- scroll anchor restored on filter switch

@@@ f199602
perf: offload hot paths in packing, persist, grid and capture

Offload zip packing, import/export, scan persist, grid
rendering and inject capture from the main path; add a detail
delete shortcut and drop the scripting permission.

@@@ 3179f48
refactor!: unify domain vocabulary across all layers

Rename domain keys, IndexedDB store names, message type
families, CustomEvent names and delay keys to the
one-word-per-concept scheme: dianzan=favorites,
shoucang=collections, works, followings.

BREAKING CHANGE: IndexedDB upgrades to v5 without a store
rename migration; export a backup before upgrading. Exports
carry schemaVersion: 2 and v1 backups are discriminated
accordingly.

@@@ 1c2fa68
chore: dead-code sweep, comment/doc freshness pass (audit follow-up)

- sweep dead code across options/background/content
- dedupe repeated logic into shared utils and class helpers
- correct stale comments; refresh docs 01-11 and README

@@@ END

## 四、执行步骤

```bash
cd /d/Code/Web/douyin-saver-extension

# 1. 备份(必须;同时保留原始长 message)
git branch backup/pre-rewrite

# 2. 把 §三 的映射切分为每提交一个 message 文件(短哈希解析为全哈希)
#    @@END 行是终止符:防止映射区之后的文档内容被追加进最后一条 message
mkdir -p .git/rewrite-messages
awk '/^@@@ END$/{ file=""; next }
     /^@@@ /  { file=".git/rewrite-messages/" $2 ".txt"; next }
     file     { print > file }' COMMIT_REWRITE_PLAN.md
# 去掉块间空行带进文件尾部的空行
for f in .git/rewrite-messages/*.txt; do
  printf '%s\n' "$(cat "$f")" > "$f"
done
for f in .git/rewrite-messages/*.txt; do
  short=$(basename "$f" .txt)
  full=$(git rev-parse "$short^{commit}")
  if [ "$short" != "$full" ]; then mv "$f" ".git/rewrite-messages/$full.txt"; fi
done

# 3. 改写(仅替换 message,树内容不动;显式列分支,避免改写
#    refs/remotes/origin/* 污染远端跟踪引用)
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter '
  f="/d/Code/Web/douyin-saver-extension/.git/rewrite-messages/$GIT_COMMIT.txt"
  if [ -f "$f" ]; then cat "$f"; else cat; fi
' -- refs/heads/main refs/heads/release/v2.0.3

# 4. 验证:diff 必须为空(证明代码未被改动),长度检查应无输出
git diff backup/pre-rewrite release/v2.0.3 --stat
git log --all --pretty=format:%s | awk 'length($0)>72'
git log --all --pretty=format:%B | awk 'length($0)>72'

# 5. 推送(方案 B:强推 main + 首推 release)
git push --force origin main
git push -u origin release/v2.0.3

# 6. 确认无误后清理(backup 建议保留数日)
git update-ref -d refs/original/refs/heads/main
git update-ref -d refs/original/refs/heads/release/v2.0.3
rm -rf .git/rewrite-messages
```

**方案 A(仅改本地 5 条,不碰远端 main)**:跳过步骤 3 中 `-- --all`,
改用 `-- 628d494..release/v2.0.3`,并只推送 release 分支:

```bash
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter '
  f=".git/rewrite-messages/$GIT_COMMIT.txt"
  if [ -f "$f" ]; then cat "$f"; else cat; fi
' -- 628d494..release/v2.0.3
git push -u origin release/v2.0.3
```

## 五、可选事项

1. 可选:给 v2.0.3 打 tag(原 message 把版本号写进了标题,已移除)。
   在步骤 3 之后执行:`git log --oneline | grep "calibrate following stats"`,
   对新哈希执行 `git tag v2.0.3 <新哈希>`。

## 六、后续书写模板(防止回潮)

新建 `.gitmessage.txt`(可提交进仓库)并启用:

```bash
git config commit.template .gitmessage.txt
```

```text
<type>(<scope>): <imperative summary, <= 50 chars, hard limit 72>
<BLANK>
<body: 1-5 lines (2-4 typical), why + what, wrap at 72 chars;
       single-line bullets for multiple items>
<BLANK>
<footer: Refs/Closes #123 | BREAKING CHANGE: ... | Co-authored-by: ...>

# type: feat fix docs style refactor perf test build ci chore revert
# subject: lowercase, no trailing period, "If applied, this commit will ..."
# body: short bullets over long prose; deep detail lives in the diff
# breaking change: add "!" after type and a BREAKING CHANGE: footer line
```
