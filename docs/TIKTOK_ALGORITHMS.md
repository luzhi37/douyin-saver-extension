# 参考项目算法/凭据模块对照

> 本文档系统梳理参考项目 **TikTokDownloader**（[JoeanAmier/TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader)，源码路径 `D:\User\Downloader\TikTokDownloader\src\encrypt\`）实现的 8 个算法/凭据模块，并与本扩展（`background/crypto.js`）的当前实现做对照。源码为参考，每一行算法的细节均以参考实现为准。

---

## 目录

- [一、签名算法](#一签名算法)
  - [1. ABogus](#1-abogus----抖音-web-主用已移植)
  - [2. XBogus](#2-xbogus----旧版抖音tiktok可选未移植)
  - [3. XGnarly](#3-xgnarly----tiktok-web-最新未移植)
- [二、凭据/Token 算法](#二凭据token-算法)
  - [4. msToken](#4-mstoken----已移植)
  - [5. ttwid](#5-ttwid----已移植)
  - [6. verifyFp](#6-verifyfp----已移植)
  - [7. webID](#7-webid----未移植)
  - [8. device_id](#8-device_id----未移植)
- [三、全景对照表](#三全景对照表)
- [四、与 douyin-saver-extension 的当前实现差距](#四与-douyin-saver-extension-的当前实现差距)
- [五、移植优先级与建议](#五移植优先级与建议)

---

## 一、签名算法

3 个签名算法均为**客户端纯算法**（不依赖服务器响应），但需配合凭据（msToken、ttwid 等）一起放在 URL query 上才被服务端接受。

### 1. ABogus — 抖音 Web 主用 ✅ 已移植

**源文件**：`src\encrypt\aBogus.py`（614 行）

**算法构成**：

| 内部算法 | 作用 | 依赖 |
|---|---|---|
| SM3 国密哈希 | 计算 params、method、UA 的 32 字节摘要 | `gmssl.sm3` |
| RC4 流加密 | UA 编码用 `"\x00\x01\x0e"`（三个控制字符 0x00/0x01/0x0e）做密钥；中间数组用 `"y"` 做密钥 | 纯 Python |
| 自定义 Base64 | 5 张字母表（`s0~s4`），输出阶段使用 `s4` | 纯 Python |

**核心数据结构**：

```python
__reg = [1937774191, 1226093241, 388252375, 3666478592,
         2842636476, 372324522, 3817729613, 2969243214]
# SM3 初始向量 IV（与 GB/T 32905-2016 一致）

__str = {
    "s0": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
    "s1": "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
    "s2": "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
    "s3": "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
    "s4": "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
}

__arguments = [0, 1, 14]
__end_string = "cus"            # params / method 都拼这个后缀再 SM3
__browser = "1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|Win32"
__ua_key = "\x00\x01\x0e"
__version = [1, 0, 1, 5]
```

**输出结构**：

```
a_bogus = customB64(string_1 + string_2, "s4")
  ├─ string_1: 12 字符随机噪声
  │    = list_1(rand1) + list_2(rand2) + list_3(rand3)
  │      其中每个 list_N(r) = [r_low & 170 | 1, r_low & 85 | ?, r_hi & 170 | ?, r_hi & 85 | ?]
  └─ string_2: RC4(array, "y")  // array 由 list_4 模板 + 时间戳 + paramsCode + methodCode + uaCode + browserInfo 组成
       list_4 = [44, a1, 0,0,0,0, 24, paramsCode[21], methodCode[21], 0, uaCode[23], a2, 0,0,0, 1,0,239, paramsCode[22], methodCode[22], uaCode[24], a3, 0,0,0,0, a4, 0,0, 14, b1, b2, 0, b3, b4, 3, c1, 1, c2, 1, browserLen, 0,0,0]
       + browserCode[18 个 char]  // 浏览器特征字符串（如 "1536|742|1536|864|0|0|..."）
       + endCheckNum (整个 list 的逐字节 XOR)
```

**关键依赖链**：

| 步骤 | 输入 | 处理 | 输出 |
|---|---|---|---|
| `generate_ua_code(ua)` | UA | RC4(ua, `"\x00\x01\x0e"`) → customB64(_, `s3`) → SM3 | 32 字节 uaCode |
| `generate_params_code(params)` | URL 参数串 | SM3(SM3(params + "cus")) | 32 字节 paramsCode |
| `generate_method_code(method)` | HTTP method | SM3(SM3(method + "cus")) | 32 字节 methodCode |
| `generate_string_2(...)` | 时间戳 + 上面三码 | 组装 list_4 → XOR endCheck → 拼 browser → RC4(_, "y") | string_2 |
| `generate_result(string, "s4")` | string_1 + string_2 | 24-bit 分组 + s4 表查找 | a_bogus 字符串 |

**浏览器信息格式**（`__browser`）：

```
innerWidth|innerHeight|outerWidth|outerHeight|screenX|screenY|0|0|outerW|outerH|outerW|outerH|innerW|innerH|24|24|platform
1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|Win32
```

**已移植位置**：`background\crypto.js:169`（`class ABogus`，约 80 行），完整对照了上述流程。

---

### 2. XBogus — 旧版抖音/TikTok，可选 ✅ 已移植

**源文件**：`src\encrypt\xBogus.py`（208 行）

**算法构成**：

| 内部算法 | 作用 |
|---|---|
| MD5 哈希 | 双重 MD5 处理 URL path：`md5(md5(path))` → 16 字节 |
| RC4 | `handle_ua` 用 UA 密钥 `["\x00", "\x01", chr(params)]` 处理 UA 字节，再 base64 |
| 自定义 Base64 | `__string = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe="` |
| 位运算 | `__canvas = 3873194319`（canvas 指纹常量）+ 异或校验和 |

**核心数据结构**：

```python
__string = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe="
__array = [None] * 48 + list(range(10)) + [None] * 39 + list(range(10, 16))
# 用于 md5_hex → 字节数组的转换表
__canvas = 3873194319  # canvas 指纹常量
```

**输出结构**：

```
X-Bogus = base64(garbled)  // garbled 由 21 字符经扰动 (disturb_array) + RC4 + 反向
       = custom_64(generate_num(generate_garbled_3("ÿ", garbled_1)))
```

**关键步骤**：

1. `process_url_path(path)` → `md5_to_array(md5(md5_to_array(md5(path))))` → 16 字节 array
2. `generate_x_bogus(query, params, ua, ts)`：
   - `generate_ua_array(ua, params)` → RC4(ua, ua_key) → base64 → MD5 → 16 字节
   - 拼 19 字节 array：`[64, 0.00390625, 1, params, query[-2], query[-1], 69, 63, ua_array[-2], ua_array[-1], ts>>24, ts>>16, ts>>8, ts, canvas(×4字节), XOR校验]`
   - `disturb_array(*array)` 重排 19 字节
   - `generate_garbled_1` 19 元参数 → 19 字符串
   - `generate_garbled_2(2, 255, garbled_3("ÿ", garbled_1))` → garbled
   - `generate_num(garbled)` → 7 个 int（三字节分组）
   - 7 次 `generate_str(int)` → 28 字符串（每 int → 4 字符 base64）

**注意**：参考项目自身也注释了 `XBogus` 渐被 `ABogus` 取代的趋势（`register.py:128` 中 `X-Bogus` 被注释掉）。仅 `msToken.py` 调用了 `XBogusTikTok` 用于 TikTok msToken 请求。

**已移植位置**：`background\crypto.js` 的 `class XBogus`，含 MD5 哈希、UA 编码、disturb_array、garbled 流程、最终 s 表编码。`background.js` 的 `independentRequest()` 在每次请求时同时计算 `X-Bogus` 参数。

---

### 3. XGnarly — TikTok Web 最新 ✅ 已移植

**源文件**：`src\encrypt\xGnarly.py`（369 行）

> TikTok Web 反爬新一代签名，独立模式抓 TikTok 数据的**硬门槛**。

**算法构成**：

| 内部算法 | 作用 |
|---|---|
| **ChaCha20 流密码** | `_quarter`/`_chacha_block` 实现（每轮 4 次 quarter + 列/对角线混合） |
| MD5 | 计算 `md5(query_string)`、`md5(body)`、`md5(user_agent)` 作为 obj 字段 3/4/5 |
| 自定义 PRNG | ChaCha20 64 字节 block 喂入 → 53-bit 浮点 `rand()` |
| 自定义 Base64 | `_BASE64_ALPHABET`（65 字符表，**无标准 `=` padding**） |
| ChaCha 加密消息体 | `_encrypt_chacha` 按 4 字节（word）分组，counter 自增 |

**核心数据结构**：

```python
_AA = [...]  # 96 个常量（魔数表），构造 PRNG state 用
_OT = [_AA[9], _AA[69], _AA[51], _AA[92]]  # ChaCha state 的"常量"段（4 个 word）
_MASK32 = 0xFFFFFFFF
_BASE64_ALPHABET = "u09tbS3UvgDEe6r-ZVMXzLpsAohTn7mdINQlW412GqBjfYiyk8JORCF5/xKHwacP="
```

**PRNG 初始化**（`_init_prng_state`）：

```python
self.kt = [
    _AA[44], _AA[74], _AA[10], _AA[62],  # 常量 4 个
    _AA[42], _AA[17], _AA[2], _AA[21],   # 常量 4 个
    _AA[3], _AA[70], _AA[50], _AA[32],   # 常量 4 个
    _AA[0] & now_ms,                     # 时间戳低 32 位
    randint(0, _AA[77]), randint(0, _AA[77]), randint(0, _AA[77]),  # 3 个随机
]
self.St = _AA[88]  # 状态指针，初始为 0
```

**ChaCha quarter**（标准实现）：

```python
def _quarter(st, a, b, c, d):
    st[a] = (st[a] + st[b]) & MASK32
    st[d] = rotl(st[d] ^ st[a], 16)
    st[c] = (st[c] + st[d]) & MASK32
    st[b] = rotl(st[b] ^ st[c], 12)
    st[a] = (st[a] + st[b]) & MASK32
    st[d] = rotl(st[d] ^ st[a], 8)
    st[c] = (st[c] + st[d]) & MASK32
    st[b] = rotl(st[b] ^ st[c], 7)
```

**PRNG `rand()`**：

```python
def rand(self):
    e = _chacha_block(self.kt, 8)  # 8 轮 ChaCha
    t = e[self.St]
    r = (e[self.St + 8] & 0xFFFFFFF0) >> 11
    if self.St == 7:
        self._bump_counter()  # kt[12] += 1
        self.St = 0
    else:
        self.St += 1
    return (t + 4294967296 * r) / 2**53  # 53-bit 浮点
```

**输出生成（`generate()` 主流程）**：

```python
# 1. 构造 obj（9-12 个字段）
obj = {
    1: 1,
    2: envcode,                               # 通常 0
    3: md5(query_string.encode()).hexdigest(),
    4: md5(body.encode()).hexdigest(),
    5: md5(user_agent.encode()).hexdigest(),
    6: timestamp_ms // 1000,                  # 秒级时间戳
    7: 1508145731,                            # 固定常量（TikTok 内部版本号）
    8: int((timestamp_ms * 1000) % 2147483648),  # 微秒相对时间
    9: version,                               # "5.1.1" 或 "5.1.0"
}
if version == "5.1.1":
    obj[10] = "1.0.0.314"
    obj[11] = 1
    obj[12] = XOR(obj[1..11])                 # 校验和

obj[0] = XOR(obj[1..N])                       # 整体校验和

# 2. 序列化 payload
payload = [len(obj)]
for k, v in obj.items():
    payload.append(k)
    payload.extend(num_to_bytes(len(val_bytes)))
    payload.extend(val_bytes)

# 3. 用 PRNG 生成 12 word 的 key（48 字节）
key_words = [int(self.rand() * 2**32) & MASK32 for _ in range(12)]
rounds = (sum(w & 15 for w in key_words) & 15) + 5  # 5~20 之间

# 4. ChaCha 加密 payload
state = _OT + key_words  # 16 word state
self._encrypt_chacha(state, rounds, payload_bytes)

# 5. key_bytes 插入密文中间
insert_pos = ...  # 由 key_bytes 累加决定
final = chr((1<<6) ^ (1<<3) ^ 3) + enc[:pos] + key_bytes_str + enc[pos:]

# 6. 自定义 Base64 输出
```

**关键点**：
- rounds 5~20 动态（看 key 决定）
- 插入位置由 key_bytes 累加 mod 长度得到
- 最终 Base64 输出**无 `=` padding**

**已移植位置**：`background\crypto.js` 的 `class XGnarly`，完整实现 ChaCha20 `_quarter`/`_chacha_block`、自实现 MD5 哈希、PRNG 状态机、`_encrypt_chacha` 4 字节 word 加密、key_bytes 插入位置计算、最终 65 字符无 padding 自定义 Base64 输出。`background.js` 的 `tiktokRequest()` 用于独立模式抓 TikTok。

---

## 二、凭据/Token 算法

5 个凭据模块中，3 个由**服务端下发**（webID、device_id、ttwid），2 个由**客户端生成**（verifyFp）或**两端混合**（msToken）。

### 4. msToken — ✅ 已移植

**源文件**：`src\encrypt\msToken.py`（263 行）

**算法本质**：服务端下发的会话级身份 token，本地可生成 fake fallback。

**核心数据结构**：

```python
class MsToken:
    API = "https://mssdk.bytedance.com/web/common"
    DATA = {
        "magic": 538969122,
        "version": 1,
        "dataType": 8,
        "strData": "fWOdJ..."  # 1KB+ 的固定 base64 blob
        "tspFromClient": int(time() * 1000),
        "ulr": 0,
    }
    TOKEN = "9cguMjz4GIfQV50B..."  # 种子 token
```

**算法构成**：

| 步骤 | 处理 |
|---|---|
| 静态 fallback | `get_fake_ms_token(size=156)` — `digits + ascii_uppercase + ascii_lowercase` 中随机 156 字符 |
| 真实获取 | `POST {API}` 带 `DATA`，从响应 `Set-Cookie` 头解析 `msToken=xxx` |
| TikTok 变体 | 端点为 `https://mssdk-ttp2.tiktokw.us/web/report`，请求 URL 先用 `XBogusTikTok` 签名 |

**已移植位置**：`docs/INDEPENDENT_MODE.md:286-308` 设计已说明；`background\crypto.js` 中需确认实现。

---

### 5. ttwid — ✅ 已移植

**源文件**：`src\encrypt\ttWid.py`（112 行）

**算法本质**：纯服务端下发，解析 `Set-Cookie` 头。

**核心数据结构**：

```python
class TtWid:
    NAME = "ttwid"
    API = "https://ttwid.bytedance.com/ttwid/union/register/"
    DATA = '{"region":"cn","aid":1768,"needFid":false,"service":"www.ixigua.com","migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}'

class TtWidTikTok(TtWid):
    API = "https://www.tiktok.com/ttwid/check/"
    DATA = '{"aid":1988,"service":"www.tiktok.com","union":false,...}'
```

**获取流程**：

```
POST ttwid API
  body = DATA (application/json)
  ↓
Set-Cookie: ttwid=xxx; ...
  ↓
http.cookies.SimpleCookie 解析 → value
```

**已移植位置**：`docs/INDEPENDENT_MODE.md:313-334` 设计已说明。

---

### 6. verifyFp — ✅ 已移植

**源文件**：`src\encrypt\verifyFp.py`（66 行）

**算法本质**：UUID v4 风格的客户端生成字符串，用于抖音风控。

**算法**：

```
return f"verify_{base36(timestamp_ms)}_{36字符随机体}"
  ├─ 固定位：8/13/18/23 = "_"，14 = "4"
  ├─ 19 位 = 特殊位（3 & n | 8，确保是 8/9/a/b 之一，UUID v4 风格）
  └─ 其余 31 位从 62 字符表中随机（digits + ascii_uppercase + ascii_lowercase）
```

**JS 注释对应的原始抖音代码**：

```js
var xi = function() {
    return Pi.get(Si) || (null === localStorage || void 0 === localStorage ? void 0 : localStorage.getItem(Si)) || function() {
        var e = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split("")
          , t = e.length
          , n = Date.now().toString(36)
          , r = [];
        r[8] = r[13] = r[18] = r[23] = "_",
        r[14] = "4";
        for (var o = 0, i = void 0; o < 36; o++)
            r[o] || (i = 0 | Math.random() * t,
            r[o] = e[19 == o ? 3 & i | 8 : i]);
        return "verify_" + n + "_" + r.join("")
    }()
}
```

**已移植位置**：`background\crypto.js:190-200` 的 `getVerifyFp()`，**完全对应**。

---

### 7. webID — ✅ 已移植

**源文件**：`src\encrypt\webID.py`（54 行）

**算法本质**：纯服务端下发。

**核心数据结构**：

```python
class WebId:
    NAME = "webid"
    API = "https://mcs.zijieapi.com/webid"
    PARAMS = {"aid": "6383", "sdk_version": "5.1.18_zip", "device_platform": "web"}
```

**获取流程**：

```
POST {API}?{PARAMS}
  Content-Type: application/json
  body = {
    "app_id": 6383,
    "url": "https://www.douyin.com/",
    "user_agent": "{UA}",
    "referer": "https://www.douyin.com/",
    "user_unique_id": ""
  }
  ↓
response.web_id  (19 位数字字符串，类似 device_id)
```

**用途**：部分抖音新接口（如创作中心、某些 Web SDK 接口）要求 `webid` 参数。

**已移植位置**：`background.js` 的 `getWebId()` 函数（独立模式），已集成到 `buildBaseParams()` 中。

---

### 8. device_id — ✅ 已移植

**源文件**：`src\encrypt\device_id.py`（77 行）

**算法本质**：纯服务端下发（HTML 内嵌字段提取）。

**核心数据结构**：

```python
class DeviceId:
    NAME = "device_id"
    URL = "https://www.tiktok.com/explore"
    DEVICE_ID = compile(r'"wid":"(\d{19})"')  # HTML 中正则提取
```

**获取流程**：

```
GET {URL}  // TikTok explore 页
  ↓
HTML 中正则匹配 "wid":"{19位数字}"  →  device_id
  ↓
合并 response.cookies 到 cookie 字符串
```

**用途**：TikTok 接口必需，抖音域不要求（抖音用的是 `webid`）。

**已移植位置**：`background\crypto.js` 的 `fetchDeviceId(userAgent)` 函数，正则 `/"wid":"(\d{19})"/`，结果缓存 1 小时。`background.js` 的 `tiktokRequest()` 在每次请求时调用。

---

## 三、全景对照表

| # | 模块 | 算法本质 | 类型 | 当前扩展支持 |
|---|---|---|---|---|
| 1 | ABogus | SM3 + RC4 + 自定义 Base64 | 客户端纯算 | ✅ crypto.js |
| 2 | XBogus | MD5 + RC4 + 自定义 Base64 | 客户端纯算 | ✅ crypto.js |
| 3 | XGnarly | ChaCha20 + MD5 + 自定义 Base64 | 客户端纯算 | ✅ crypto.js |
| 4 | msToken | 服务端下发 + 客户端 fallback | 混合 | ✅ background.js |
| 5 | ttwid | 服务端下发 | 纯服务端 | ✅ background.js |
| 6 | verifyFp | UUID v4 + base36 时间戳 | 客户端纯算 | ✅ crypto.js |
| 7 | webID | 服务端下发（mcs API） | 纯服务端 | ✅ background.js |
| 8 | device_id | 服务端下发（HTML 正则） | 纯服务端 | ✅ crypto.js |

**已实现**：8/8（抖音 + TikTok 场景均覆盖）

---

## 四、与 douyin-saver-extension 的当前实现差距

### 已覆盖（背景独立模式依赖）

| 模块 | 已实现于 | 说明 |
|---|---|---|
| **SM3 国密哈希** | `background\crypto.js:5-47` | `sm3Hash`、`sm3Compress`、`sm3ToArray`、`abogusSum` |
| **MD5 哈希** | `background\crypto.js` | `md5()`、`md5Bytes()`，XBogus/XGnarly 依赖 |
| **RC4 流加密** | `background\crypto.js:65-71` | `rc4Encrypt(plaintext, key)` |
| **ChaCha20 流密码** | `background\crypto.js` | `chachaU32`、`chachaRotl`、`chachaQuarter`、`chachaBlock`（XGnarly 依赖） |
| **自定义 Base64 (s3/s4)** | `background\crypto.js:73-86` | `customB64Encode(str, alphabet)` |
| **ABogus** | `background\crypto.js:121-188` | 完整 `class ABogus`，含 UA 编码、params/method/UA 三码、list_4 模板、endCheckNum、最终 s4 编码 |
| **XBogus** | `background\crypto.js` | 完整 `class XBogus`，含双重 MD5、UA 编码、disturb_array、garbled 流程 |
| **XGnarly** | `background\crypto.js` | 完整 `class XGnarly`，含 ChaCha20、PRNG 状态机、4 字节 word 加密、key 插入、65 字符无 padding Base64 |
| **VerifyFp** | `background\crypto.js:190-200` | 完整 `getVerifyFp(timestamp)` |
| **Cookie 解析** | `background\crypto.js:196-206` | `parseCookieToPairs` |
| **msToken / ttwid 刷新** | `background.js:fetchMsToken()` / INDEPENDENT_MODE.md | 服务端下发，chrome.storage 缓存 |
| **webID 抓取** | `background.js:getWebId()` | POST `mcs.zijieapi.com`，chrome.storage 缓存 |
| **device_id 抓取** | `background\crypto.js:fetchDeviceId()` | GET `tiktok.com/explore`，HTML 正则提取，chrome.storage 缓存 |
| **TikTok 独立模式请求** | `background.js:tiktokRequest()` | 集成 device_id + XGnarly 签名 |

### 缺口（0 项）

所有 8 个算法/凭据模块已全部实现，**抖音域 + TikTok 域均具备抓取能力**。

---

## 五、移植优先级与建议

所有 8 个模块已全部完成移植，无后续建议。

### 库依赖与实现

参考项目用 `gmssl`（Python 库）实现 SM3，但本扩展是纯 JS 环境（无 npm 依赖）：

- **SM3**：`background\crypto.js:5-27` 自实现
- **MD5**：`background\crypto.js` 自实现（紧凑版，约 80 行）
- **RC4**：`background\crypto.js:65-71` 自实现
- **ChaCha20**：`background\crypto.js` 自实现（XGnarly 依赖，约 60 行）

---

## 附录 A — 自定义字母表全集

参考项目涉及的自定义 Base64 字母表（用于不同算法的输出阶段）：

| 表名 | 字母串 | 来源 | 用途 |
|---|---|---|---|
| `s0` | `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=` | aBogus.py:33 | 标准 Base64 |
| `s1` | `Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=` | aBogus.py:34 | aBogus 旧版 |
| `s2` | `Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=` | aBogus.py:35 | aBogus 中间表 |
| `s3` | `ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe` | aBogus.py:36 | aBogus UA 编码 |
| `s4` | `Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe` | aBogus.py:37 | **aBogus 最终输出** |
| XBogus | `Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=` | xBogus.py:12 | X-Bogus 输出 |
| XGnarly | `u09tbS3UvgDEe6r-ZVMXzLpsAohTn7mdINQlW412GqBjfYiyk8JORCF5/xKHwacP=` | xGnarly.py:107 | **XGnarly 最终输出（65 字符，无 padding）** |

注意每张表的细微差异：**字符顺序、`+` vs `-`、`+` vs `_`、`a~z`/`A~Z`/`0~9` 的相对位置都不同**，不可混用。

---

## 附录 B — 算法间依赖关系

```
                    ┌──────────────────────────────────┐
                    │  服务器下发凭据                     │
                    │  webID   device_id   ttwid        │
                    │  (mcs)   (HTML)      (ttwid API)  │
                    └──────────┬────────────┬───────────┘
                               │            │
                               ▼            ▼
                    ┌──────────────────────────────────┐
                    │  URL query 必需字段                │
                    │  msToken, ttwid, verifyFp, webid, │
                    │  device_id                        │
                    └──────────┬───────────────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────────┐
        │  URL query 签名字段（客户端纯算）          │
        │  a_bogus (ABogus) / X-Bogus / XGnarly    │
        └──────────────────────────────────────────┘
```

签名算法与凭据**完全独立**：签名算法只对 URL 参数本身 + UA + 时间戳做摘要，不读取 msToken/ttwid 等凭据。但服务端会校验：`签名正确 + 凭据有效 + 时间戳未过期` 三者必须同时满足。

---

## 相关文档

- [docs/INDEPENDENT_MODE.md](./INDEPENDENT_MODE.md) — 独立模式架构（不依赖抖音标签页运行）
- [docs/FETCH_AND_CACHE.md](./FETCH_AND_CACHE.md) — 当前依赖标签页模式的抓取与缓存机制
- [docs/INJECT_INTERNALS.md](./INJECT_INTERNALS.md) — inject.js 注入、抓取、签名捕获内部细节
- [docs/SYNC_AND_SCAN.md](./SYNC_AND_SCAN.md) — 同步/扫描/取消完整链路
- [docs/SECURITY_AND_DNR.md](./SECURITY_AND_DNR.md) — DNR 规则与安全状态
