# 独立模式「扫描收藏」全链路实录

> 从零讲清独立模式扫描收藏的完整思路：请求要凑齐哪些要素、线格式长什么样、
> 三层签名各自管什么、403 攻坚的每一步是怎么想的、以及复发时怎么再抓。
> 侧重**方法论**——下次遇到同类防线时照此复用。
> 速查类内容：算法定案见本文第十节与 [INDEPENDENT_MODE.md](./INDEPENDENT_MODE.md)；
> 所有实验脚本保留在 `tmp/`，文中文件名均可直接检索。

---

## 一、背景与目标

扩展有双模式：**标签页模式**（消息转发进抖音页面，借页面自身的 XHR 发请求）和
**独立模式**（Service Worker 直接 `fetch()`，不需要开着抖音标签页）。

扫描收藏（`FETCH_COLLECTION`）在独立模式下的链路：

```text
options.js 触发
  → chrome.runtime.sendMessage FETCH_COLLECTION
  → background.js handleIndependentFetchCollection()   // SW 内 while 循环翻页
    → independentRequest(API.COLLECTION, buildBaseParams(), {method:"POST", webSign:true, ...})
      → fetch()                                          // 凭据/特征全部自备
    → COLLECTION_PROGRESS 逐页回报 options
```

页面不用开，代价是页面里 secsdk 自动帮你做的事（注入 msToken、算 a_bogus、
附加各种风控头）全部要自己复刻。这份文档就是这个"全部"的清单，加上缺了
其中一样时的排查实录。

## 二、一个独立模式请求需要凑齐的要素

`buildBaseParams()`（background.js）+ `independentRequest()` 组装出的完整要素表：

| 要素 | 来源 | 缺失/过期的后果 |
|---|---|---|
| 登录态 Cookie | `savedCookie` 缓存 + 实时 `chrome.cookies` | 未登录 / 数据为空 |
| `webid` | 实时 Cookie → `savedWebId` 缓存 → WEBID API 兑换 | 设备身份不认 |
| `uifid` / `odin_tt` | **必须取当前登录会话的实时 Cookie**（缓存滞后会 sign invalid） | 签名与会话不一致 |
| 浏览器特征 | `browserFeatures` 缓存（cpu/屏幕/UA 族等） | 特征指纹矛盾 |
| `msToken` | 五级来源（见下） | 严格端点直接 403 |
| `a_bogus` | 自移植 ABogus 类对 `qs+method` 签名 | 参数被认定篡改 |
| Referer | DNR rule 3 注入 | 缺头被拦 |
| 时钟偏移 | `getClockSkew()` 校正本地钟差 | 时间戳类签名全歪 |
| **webSign 签名** | 本次攻坚新增（仅 listcollection） | `Signature Not Found` |

msToken 五级来源（详见 INDEPENDENT_MODE.md）：`savedMsToken` 缓存 → douyin.com
Cookie jar → **mssdk 兑换**（POST 静态载荷到 `mssdk.bytedance.com/web/common`，
从 Set-Cookie 读回真 token）→ `savedCookie` 正则提取 → 随机兜底（服务端不认）。

> mssdk 兑换来的真 token 字符集不含 `-` `/` `_` `=`；
> 若刷新后拿到的 token 带这些字符，说明走的是兜底而非兑换——这是快速判别手段。

## 三、端点解剖：listcollection 的正确线格式

端点 `POST /aweme/v1/web/aweme/listcollection/`，最终可用的形态分三段：

**query 段** —— 全部是"环境参数"，不含业务分页参数：
`device_platform / aid / channel / version_code … browser_* / os_* /
downlink / effective_type / round_trip_time / webid / uifid / odin_tt /
msToken / a_bogus / timestamp / x-secsdk-web-signature`

**body 段** —— urlencoded 的业务分页参数，仅两个：
```text
count=20&cursor=<N>
```

**header 段** —— 除常规头外必带三件套：
```text
uifid: <同 query>
x-secsdk-web-signature: <32位md5>
x-secsdk-web-expire: <秒级时间戳，同 query 的 timestamp>
Content-Type: application/x-www-form-urlencoded
Referer: https://www.douyin.com/user/self?showTab=favorite_collection
```

三个反直觉要点（都是踩过坑的）：

1. **`count`/`cursor` 必须在 body，不放 query；空 body 的 POST 固定被 Argus 以
   `Signature Not Found` 拒绝**。此形态与参考项目 TikTokDownloader 一致
   （其 `src/interface/collection.py` 同样 `generate_params()` 只出环境参数、
   `generate_data()` 出 count/cursor 进 body）。
2. **不传 `sec_user_id`**。收藏数据归属于谁由 Cookie 决定，query 里带它反而
   是旧实现的错误形态（页面真实请求里没有这个参数）。
3. 分页推进用响应里的 `has_more` + `cursor/max_cursor`，与其它扫描端点相同。

## 四、故障现象与第一轮排查：先排除凭据层

最初的症状：独立模式扫描收藏固定弹窗——

> 抖音返回 403 拒绝了该请求。若已刷新 Cookie/webid/msToken/浏览器特征仍失败……

排查顺序应当**从最便宜的假设开始**：先怀疑凭据过期。验证手段是观察刷新链路
是否真的生效：

- 用户实测 `savedMsToken` 刷新前后值不同（`E8h4udKc…` → `Wc1ZSqgc…`）→ 刷新链路活着；
- 新 token 字符集不含 `-/_/=` → 走的是 mssdk 兑换、拿到的是真 token 而非随机兜底；
- 连续三次抓包，三次 msToken 各不相同，403 却纹丝不动。

**结论：凭据层无嫌疑。** 这里有一条重要的排障经验：

> 「换了凭据也不好转」的 403，说明服务端校验的不是你是谁，而是你的请求
> 长得对不对。此时应立刻转向**请求形态差异分析**，不要在凭据上继续打转。

## 五、定位缺失面：diff 成功请求与失败请求

让浏览器页面自己发一次 listcollection（打开收藏页即可），与扩展发出的失败
请求逐项对比：

| 差异点 | 页面成功请求 | 扩展失败请求 |
|---|---|---|
| 分页参数位置 | body（urlencoded） | query，body 为空（content-length: 0） |
| `sec_user_id` | 不存在 | query 里带着 |
| `uifid` 头 | 有 | 无 |
| `x-secsdk-web-signature` | header + query 各一份 | 无 |
| `x-secsdk-web-expire` 头 | 有 | 无 |
| `timestamp`（query） | 有 | 无 |

缺失清单拿到手，问题收敛为一个单一疑问：**`x-secsdk-web-signature`
是怎么算出来的**。同时线格式差异（body 化、去 sec_user_id）一并记录待修。

## 六、找到生成者（who）

两步定位，都依赖一个事实：**签名相关字符串无法被混淆掉**。

### 6.1 字面量全局搜索

DevTools Sources 全局搜 `x-secsdk-web-signature` / `webSign`：全站几十个 bundle
只有 secsdk 的打包 chunk（`runtime_bundler` 族）命中。业务代码不碰这个头，
生成者必然在 secsdk 内部。下载对应 chunk 存档（`tmp/secsdk_runtime_bundler_34.js`）
供离线分析。

### 6.2 hook XMLHttpRequest 抓调用栈

secsdk 包装了 `XMLHttpRequest.prototype.open`，任何 XHR 的 `new Error().stack`
都会经过它的包装层。用 Playwright 注入 init script（`tmp/pw_xhr_stack.js`）：
包一层 `open`，凡 URL 含 `listcollection` 就记录栈与"URL 是否已带签名"。

栈中出现 `executeXHRRequestOpen` 帧（bundle 第 17 行附近，minified 单行）：
它在放行真正的 `open()` 前按策略开关分支，其中 `"webSign"` 字符串分支负责取签名
并附加；分支内部经 `window.use("webSignUrl")` 拿签名器模块，导出入口形如
`byted_acrawler.frontierSign(url)`。在此下断点确认每次 XHR 都命中。

## 七、还原公式（what）

### 7a 黑盒爆破先行（未中，但失败本身有价值）

`tmp/crack_sig.mjs`：4 组页面真实样本 × 参数删减组合（raw/去sig/去ts/去uifid/
仅业务参数）× 拼接形态（裸串/path+?/?前缀）× 编码（原始/decode）× ts 参与方式
（不参与/前置/后置/`&timestamp=`），数百组合全部 MD5 对比目标 sig，无一命中。

> 教学点：黑盒爆破的适用边界是**输入里不能有未知常量**。本例明文中夹着一段盐，
> 纯枚举永远打不中。爆破失败本身就是信息——说明存在未知材料，必须转动态分析。

### 7b 动态分析（成功）

两条腿并行：

- **VM 复现**：node 起 sandbox 加载 secsdk chunk（`vm_sign_test.mjs` +
  `sdk_glue.js` 补 DOM 桩），直接调 `frontierSign` 观察输入输出行为；
- **hook 加密原语**（决定性一步）：在页面上下文包一层 `CryptoJS.MD5` 打印入参，
  立刻拿到待签明文原文，与该请求自己的 URL 逐段比对，公式与盐同时出土。

> 教学点：6.2 和 7b 是固定搭档。栈告诉你去哪下钩子；钩住加密原语打印明文，
> 是对抗混淆性价比最高的手段——算法可以被混淆，但它总要调用干净的加密库。

### 出土的公式

```text
ts  = floor(now/1000)                    // 秒级
qs' = qs + "&a_bogus=" + ab + "&timestamp=" + ts
sig = md5( uifid + "_" + ts + "_" + 盐 + "_" + qs' )
最终 query = qs' + "&x-secsdk-web-signature=" + sig
```

盐 `A96D855A08C0A9707F8BEF0D9A527E4E`：secsdk 动态策略常量，实测跨会话稳定。

## 八、绑定域实验：摸清服务端校验语义

公式对了还不算完——服务端到底验哪些东西？以一份已知 200 的完整样本为基准
（R13，页面形态重放，落在边缘域名 `www-hj.douyin.com` 上也照常通过，说明
主机不是变量），逐项篡改后重放（`tmp/test_sig_binding.mjs`）：

| 变体 | 改动 | 结果 | 结论 |
|---|---|---|---|
| V0 | 原样重放 | **200** | 短时效内重放可行 |
| V1 | timestamp=ts+1，sig 不动 | Sign Invalid | ts 参与签名 |
| V2 | 删 query 里的 sig 参数 | Signature Not Found | query 也必须有 sig |
| V3 | 删业务参数 `probe_test=1` | Sign Invalid | 任意 query 参数都参与 |
| V4 | 追加垃圾参数 | Sign Invalid | 增改皆触发 |
| V5 | uifid 尾字符换 X | Validate Error | uifid 不在待签串，但服务端另验归属 |
| V7 | timestamp=当前时间，sig 不动 | Sign Invalid | sig 与 ts 强绑定 |

三种错误文案精确对应三层校验，是后续一切调试的路标：

| 服务端返回 | 含义 | 排查方向 |
|---|---|---|
| `Signature Not Found` | 没带签名（缺 header/query/body 形态不对） | 对比缺失面 |
| `Sign Invalid` | 带了但算错（待签串不一致/盐不对/ts 不匹配） | 逐字节比对明文 |
| `Validate Error` | 签名自洽，但 uifid 与会话归属不符 | 检查 uifid 来源会话 |

> 回看第四节：扩展旧形态（空 body + 无签名）报的正是第一种错——
> 其实响应体早就把答案写在脸上了，只是当时没有把它当规格书读。

## 九、移植与验证

### 9.1 实现

- `background/crypto.js` 新增纯 JS `md5Hex()`（SW 里不能引 node crypto）；
  用页面 hook 抓到的 `(明文, 摘要)` 对照对（`tmp/md5_pair.json` +
  `md5_check.mjs`）逐字节验证移植正确性；
- `CONFIG.WEB_SIGN_SALT` 入配置（注释写明盐变更风险）;
- `independentRequest` 增加 `options.webSign` 分支：
  - 待签串必须是**最终发送的完整 query 去掉 sig 自身**，键顺序一致——
    与 a_bogus 同款约束（服务端剥参后对整串哈希），任何"规范化"都会翻车；
  - ts 与 a_bogus 共用 `getClockSkew()`，本地钟差两层签名一起校正；
  - `params.uifid` 缺失时跳过签名走旧路径（宁可 403 不可崩）；
- `handleIndependentFetchCollection` 同时改线格式：count/cursor 进 body、
  去掉 sec_user_id、开 `webSign: true`。

### 9.2 验证

完整复刻扩展构造路径做端到端预演：`tmp/test_ext_e2e.mjs`（cursor=0）、
`tmp/test_ext_e2e_p2.mjs`（cursor=20）均 **HTTP 200**，aweme_list 与翻页游标正常。

### 9.3 参考项目的边界

TikTokDownloader 全项目 grep 不到任何 secsdk/webSign 实现——它调同一端点、
同样只挂 a_bogus。它贡献的是**线格式**（body 化分页参数）与无标签页架构思想
（msToken 兑换、ABogus）；Argus webSign 这层它没有答案，只能自己逆。
若日后想实证它今天是否也被拦，跑通其 Collection 模块即可（需配 Python 环境+cookie）。

## 十、算法定案速查卡

```text
ts  = floor((Date.now() + clockSkew) / 1000)
qs' = <环境参数qs含msToken/uifid/odin_tt> + "&a_bogus=" + ab + "&timestamp=" + ts
sig = md5_hex( uifid + "_" + ts + "_" + SALT + "_" + qs' )
query = qs' + "&x-secsdk-web-signature=" + sig        # POST body: count=&cursor=

headers += { uifid, x-secsdk-web-signature: sig, x-secsdk-web-expire: ts }
SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"              # CONFIG.WEB_SIGN_SALT
```

启用范围：当前仅 listcollection（GET 点赞 favorite 在页面上也观察到 webSign
痕迹但未强制实测，若被拦平移同款分支即可）。代码位置：
`background/background.js` 的 `independentRequest`（webSign 分支）与
`handleIndependentFetchCollection`（开关），`background/crypto.js` 的 `md5Hex`。

## 十一、复发处置指南：盐轮换了怎么办

症状识别：此前能用的版本突然固定 `Signature Not Found`，且线格式无误——
大概率抖音换了 secsdk 策略版本、盐变了。处置约几分钟：

1. 打开抖音收藏页，让页面自己发一次 `listcollection`，抓下完整请求；
2. 取出新样本的 `uifid / timestamp / x-secsdk-web-signature` 及其完整 query；
3. **反解盐**：公式已知，明文只剩盐一段未知。构造
   `candidate = uifid_ts_???_qs'`，对 `???` 枚举候选段（或用新旧样本联立消元）
   即可锁定新盐——黑盒法此时重新可用；
4. 更新 `CONFIG.WEB_SIGN_SALT`，`chrome://extensions` 重载，重放验证。

## 十二、可复用的方法论清单

- 凭据刷新无效的 403 → 先 diff 请求形态，别死磕 Cookie；
- 响应错误文案就是规格书：Not Found=没带 / Invalid=算错 / Validate=归属不符；
- 签名 header/参数名字面量全局搜 → 一发命中生成者所在 bundle；
- hook `XMLHttpRequest.open` 抓栈定位分支（who）；
- hook `CryptoJS.MD5` 等加密原语抓明文还原公式（what）——对抗混淆的王牌；
- 黑盒爆破仅当输入无未知常量时可用；失败即提示"有盐"；公式已知后黑盒法反转可用；
- 绑定域实验（基于已知 200 样本逐项篡改重放）摸清服务端校验语义；
- 移植先用 `(明文,摘要)` 对照对验证实现，再做服务端端到端（含翻页）；
- 参考项目能抄的是架构与线格式，新防线（如本次 webSign）通常要自己逆；
- 每步落盘成 tmp 脚本：既是证据链，也是复发时的工具箱。

## 附录：实验编号与证据文件索引（tmp/）

实验编号体系：**R 系列**=端点行为探索（参数集/形态矩阵），**U 系列**=VM 调
frontierSign 的 URL 形态变体，**V 系列**=绑定域篡改重放。

| 文件 | 内容 |
|---|---|
| `pw_init_capture.js` | 页面 fetch/XHR 双 hook，捕获 API URL 与调用栈 |
| `pw_xhr_stack.js` | 专抓 listcollection 的 XHR open 调用栈（第六节） |
| `pw_inject_cookies.js` | Playwright 会话注入登录态 |
| `captured_lc_urls.json` | 页面真实带签名请求 URL 样本集 |
| `secsdk_runtime_bundler_34.js` / `sdk_glue.js` | secsdk chunk 存档与 node 加载桩 |
| `vm_sign_test.mjs` / `vm_sign_call.mjs` | node VM 调 `frontierSign`（U 系列） |
| `crack_sig.mjs` | 黑盒爆破矩阵（第七节 7a，未中→转动态） |
| `test_lc_r45.mjs` | R4–R6：参考项目参数集/真实 uifid/Edge 环境参数对照 |
| `test_lc_get.mjs` | R9–R11：GET 形态、POST+伪 ticket-guard 头探测 |
| `test_sig_binding.mjs` | V0–V7 绑定域重放（第八节表格出处，基准=R13） |
| `test_websign_replay.mjs` | 页面现签重放（时效敏感） |
| `md5_pair.json` / `md5_check.mjs` | hook 抓到的 (明文,摘要) 对照对与 md5Hex 验证 |
| `test_ext_e2e.mjs` / `test_ext_e2e_p2.mjs` | 扩展构造路径端到端预演（cursor 0/20，均 200） |
| `test_lc_matrix.mjs` / `test_lc_replay.mjs` / `test_lc_e2e.mjs` | R 系列其余形态矩阵与重放 |
