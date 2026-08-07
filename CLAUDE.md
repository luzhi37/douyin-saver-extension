# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Manifest V3 extension for managing Douyin (抖音) user data — works (videos/notes), followings, likes, and collections. **Pure vanilla JS. No npm, no build tools, no package.json.** Load as an unpacked extension in Chrome.

## Commands

```powershell
# Syntax check all JS files
node --check background/background.js background/crypto.js content/content.js content/inject.js options/options.js
```

## 4-Layer Architecture

```
inject.js (main world)         — Fetch/XHR hook, button injection, API data capture
    ↓ CustomEvent
content.js (isolated world)    — Bridge; requestResponse() pattern via CustomEvent dispatch+listen
    ↓ chrome.runtime.sendMessage
background.js (Service Worker)  — Message router, IndexedDB ops, pagination loops, independent mode
    ↓ chrome.runtime.sendMessage
options.js (options page UI)    — 11 classes, responsive store, virtual grid, detail player
```

**inject.js** runs in the page's main world via `web_accessible_resources`. It hooks `window.fetch` and `XMLHttpRequest` to capture Douyin API responses and signature parameters (`a_bogus`, `msToken`, etc.) without needing to compute them directly.

**content.js** runs in an isolated world. It injects the main-world script, bridges messages via `requestResponse()` (listens for a `resultEvent` before dispatching a `requestEvent` to avoid race conditions), and maintains an LRU cache of captured works.

**background.js** is the ES module service worker. It routes all `chrome.runtime.sendMessage` types via a switch statement, handles pagination loops for all scan/sync operations, and provides both "tab mode" (forwards requests to a Douyin tab via `sendToTab`) and "independent mode" (direct HTTP POST with ABogus signing).

**options.js** is a large (~5000 line) single-file UI. All variables live at the module top (config, dom, state, store, utils, services). Classes defined top-to-bottom and immediately instantiated.

## Dual Storage Domains

```
works           → IndexedDB store "works"       (key: awemeId)
works_groups    → IndexedDB store "works_groups" (key: group id)
followings      → IndexedDB store "followings"   (key: uid)
followings_groups → IndexedDB store "followings_groups"
```

All IndexedDB access goes through `background/storage.js` which provides a thin promise-based wrapper with batch operations, index lookups, and group management.

## Two Operating Modes

- **Tab mode**: background forwards API requests to a douyin.com tab via `chrome.tabs.sendMessage` → content.js → inject.js. inject.js makes requests using the page's `window.fetch` (which has valid cookies and signature params captured from real page activity). Uses `sendToTab()` / `sendToTabAsync()` with requestId tracking and configurable timeout.
- **Independent mode**: background directly calls `fetch()` with a_bogus signing computed by the ABogus class in `crypto.js`. Requires cached cookie + msToken + browser features + webId. Used when no Douyin tab is open.

## Message Protocol

All messages are dispatched via `chrome.runtime.sendMessage`. The manifest version 3 service worker means `sendResponse` is required for async handlers — `background.js` uses `asyncHandler()` which catches errors and returns `true` to keep the channel open.

**Key message types** by category:
- Data: `SAVE_WORKS`, `GET_WORKS`, `DELETE_WORKS`, `MOVE_WORKS`, `SYNC_WORKS`, `GET_WORK`, `SAVE_FOLLOWINGS`, `GET_FOLLOWINGS`, `DELETE_FOLLOWINGS`, `MOVE_FOLLOWINGS`
- Groups: `GET_GROUPS`, `ADD_GROUP`, `RENAME_GROUP`, `DELETE_GROUP`, `REORDER_GROUPS`
- Scan: `FETCH_FOLLOWING`, `FETCH_FAVORITES`, `FETCH_COLLECTION`
- Cancel: `CANCEL_LIKE`, `CANCEL_COLLECTION`, `CANCEL_ACTIVE_TASK`
- Tools: `IMPORT_DATA`, `EXPORT_DATA`, `RESET_DOMAIN`, `GET_STATS`, `GET_SECURITY_STATUS`
- Config: `SET_MODE`, `CAPTURE_BROWSER_FEATURES`, `GET_COOKIE_INFO`, `GET_BROWSER_FEATURES`, `GET_CACHE_TIMES`
- Refresh: `REFRESH_MSTOKEN`, `REFRESH_WEBID`, `REFRESH_BROWSER_FEATURES`, `REFRESH_COOKIE`

## Signing & Anti-Bot Landscape

- **a_bogus**: The primary signature parameter for Douyin web API. Computed by the `ABogus` class in `crypto.js` using SM3 hash, RC4 encryption, and a custom base64 encoding. Requires user-agent, platform, browser features, and server clock skew.
- **msToken**: Random token fetched from browser cookies (douyin.com or bytedance.com), saved to `chrome.storage.local`, with random fallback generation.
- **webId**: Device identifier fetched from `mcs.zijieapi.com/webid`.
- **browserFeatures**: Captured from inject.js via `DY_CAPTURE_BROWSER_FEATURES` event, stored in `chrome.storage.local`, used to build API parameters.
- **securityKey**: Extracted from localStorage `security-sdk/s_sdk_cert_key` on the Douyin page, sent as `bd-ticket-guard-ree-public-key` header for cancel operations.
- **DNR rules** (declarativeNetRequest): Set up dynamically to inject/modify headers (Referer, Origin) for douyinvod.com, douyinpic.com, and API endpoints — critical for media access and independent mode cancel operations.
- **Cancellation**: Tab mode uses XHR (because Douyin's a_bogus is tied to the XHR prototype chain). Independent mode uses `fetch()` with DNR rules injecting the Referer.

## Code Layout Convention

All JS files follow a strict top-to-bottom order: **config/const → 模块级变量 → 函数定义 → 类定义+实例化(成对) → 事件绑定 → 启动逻辑**.

```
config/const definitions        ┐ at the top of file
module-level variables          ┘ let/const grouped
function definitions (grouped)   separated by `// ---------- label ----------`
class definition + instantiation  each class followed by `const x = new Class()`
event listeners / message routing  after all function definitions
startup logic                     IIFE / DOMContentLoaded at the very bottom
```

**Critical rules:**
- `config` / `CONFIG` must be at the very top, never mid-file or bottom
- Class definition and its instantiation are a **single pair** — never define all classes first then instantiate them all later
- Execution statements (function calls, event bindings) must never appear before declarations
- Use `// ---------- label ----------` section dividers for each logical block

## Key Design Rules

- **All fetch hooks in inject.js use `window.fetch` with `_dyInternal: true`** to avoid re-capture (not `origFetch`), because Douyin may override `window.fetch` to inject signature params.
- **The `requestResponse` pattern in content.js** always adds the event listener BEFORE dispatching the event — eliminating the `setTimeout(0)` workaround.
- **Pagination loops** in background.js (FETCH_FOLLOWING, FETCH_FAVORITES, FETCH_COLLECTION, SYNC_WORKS, CANCEL_LIKE, CANCEL_COLLECTION) share a common pattern: `crypto.randomUUID()` as requestId, `onMessage` listener for `CANCEL_ACTIVE_TASK`, random delays between pages, progress messages via `chrome.runtime.sendMessage`.
- **BATCH_SIZE=40** pause in SYNC: every 40 items, the sync loop pauses for 10-20 seconds with keepalive writes to prevent service worker timeout.
- **FATAL_ERRORS** in background CONFIG: errors like `NO_DOUYIN_TAB`, `RATE_LIMITED`, `CANCELLED` cause the entire batch to terminate early.
- **options.js class fields use `#` for private methods** and arrow functions only for addEventListener/removeEventListener symmetric pairs.
- **All css class manipulation for checkbox state** must use `Batch.updateCheckboxDOM` — setting innerHTML alone isn't enough because the checkbox icon relies on the `checked` CSS class.

## Options UI Classes (defined in options.js)

| Class            | Responsibility                                                                                      |
|------------------|-----------------------------------------------------------------------------------------------------|
| `VirtualGrid`    | Base class: virtual scrolling, IntersectionObserver, chunked rendering, event delegation, item fill |
| `Dialog`         | Modal dialog management with body rendering and footer buttons                                      |
| `FollowingsGrid` | Following card grid rendering                                                                       |
| `Groups`         | Group tab bar + rename/delete/reorder                                                               |
| `Batch`          | Batch selection, select-all, move, delete                                                           |
| `ImportExport`   | JSON import/export with group reconciliation                                                        |
| `Sidebar`        | Author works paginated sidebar                                                                      |
| `Sync`           | Sync state machine for works and followings                                                         |
| `Favorites`      | Like/collection scan and cancel operations                                                          |
| `WorksGrid`      | Work card grid with video thumbnails and overlays                                                   |
| `Detail`         | Video/note detail player with navigation, download, loop                                            |

## Cached Credentials (chrome.storage.local keys)

| Key               | Source               | Purpose                                         |
|-------------------|----------------------|-------------------------------------------------|
| `savedCookie`     | Chrome cookies API   | Raw cookie string for independent mode requests |
| `savedMsToken`    | Cookie jar or random | Anti-bot token                                  |
| `savedWebId`      | zijieapi.com         | Device identifier                               |
| `browserFeatures` | inject.js            | UA, screen, CPU, GPU, security key              |
| `independentMode` | options.js toggle    | If true, background makes direct HTTP requests  |

## Test Files

Tests in `tests/` were self-contained Node.js .mjs scripts that directly imported crypto.js modules and exercised specific Douyin API endpoints. **Removed 2026-08-04** along with the unused TikTok signing code (X-Bogus / X-Gnarly / device_id / verify_fp) they were the only consumers of.
