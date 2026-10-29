# magpie-sensenova

**中文** | [English](./README.en.md)

[Magpie](https://usemagpie.ai) 的 **SenseNova（商量 / 日日新，商汤）** 供应商插件：
通过 OpenAI 兼容接口接入 Token Plan 的模型，并把控制台里的**积分额度**上报成 Magpie 原生的额度窗口。

> **这是日日新 Token Plan（开发者 API，`platform.sensenova.cn`），不是商汤小浣熊。** 商汤有两套面向
> 不同人群的服务：本插件接的是给开发者的 Token Plan API；面向普通用户的聊天应用叫**商汤小浣熊**
> （`xiaohuanxiong.com`），那是另一个服务、另一套账号与积分，由社区的
> [`@magpie-community/opencode-raccoon-auth`](https://github.com/magpie-community/plugins) 接入。两边的
> 余额、签到和模型清单互不相通。

```
$ magpie quota
sensenova  通用积分池 · 5 小时窗口   0% used ↻ 2h  ·  Flash-Lite积分池 · 5 小时窗口  22.8% used ↻ 2h
```

（窗口标签来自平台自己的池名，由插件翻译——见 [`locale`](#locale)。上面是默认的中文输出。）

### 账号行显示什么

Magpie 命名一个账号，依次取 `accountId` → `metadata.email` → `email`，都没有才退回按凭据打标签——也就是你可能见过的 `API key …HohJ`。

所以这个标签**在登录那一刻定死**：账号栏填了就显示填的内容（手机号或邮箱），留空则保持 Magpie 的 API Key 回退。

让 `api` 类型的方法设置它，是实测出来的，其中两种看似合理的做法都行不通，值得记录：

- **提示的 `key` 才是决定因素。** 本插件把账号那一问的 key 命名为 `email`，答案就会落进 `metadata.email`——Magpie 读的那个字段。端到端验证过：账号栏填 `139…7777` 登录，账号行就显示 `139…7777`。
- **`authorize` 返回的 `accountId` 被忽略**（对 `api` 类型）。文档只对 oauth 结果写了它，带着它登录的 api 账号标签仍是 `API key`。
- **`authorize` 返回的 `metadata` 被丢弃。** Magpie 用提示收集到的答案覆盖它，塞进去的 `email` 活不下来。
- **`usage.user` 也不改名账号行。** 钩子返回的 `user` 存进额度缓存（`quotas.json` → `quota.user`），而行和 `magpie quota` 渲染的仍是登录期的标签；缓存键照旧是 `sensenova/api key …hohj`。

老登录把账号存在 `metadata.username` 下，所以 `consoleAuthOf` 仍认这个拼写（和 `account`）作为回退。

**在这套行为存在之前登录的账号不需要重新登录。** Magpie 自己会把旧的 `metadata.username` 迁移成 `metadata.email`：本机的旧条目经历过「只有 `username`」→「两者并存」→「只剩 `email`」的过程，之后账号行就会渲染账号名。实际观察到一台真机从 `sensenova · Free Plan · API key …HohJ` 变成 `sensenova · Free Plan · Rina49`，期间没有重新登录。

---

## ⚠️ 安全须知——请先读这一节

**本插件是本机第三方客户端，与商汤无隶属关系。** 下面每一条都注明证据来自三类之一：

- **实测**——对真实接口或本机的测量，附命令或现象；
- **控制台代码**——SenseNova 控制台前端代码的原文引用；
- **本插件代码**——本仓库源码的实际行为，附文件与函数。

前两类描述外部世界，可能随平台改版失效；第三类描述这个包，跟着版本走。**如果标注「本插件代码」的内容和你的观察不符，请以代码为准并提 issue。**

### 1. 存了什么、存在哪

两套凭据，作用域完全不同：

| 凭据 | 存到哪 | 字段 | 能做什么 |
| --- | --- | --- | --- |
| API Key | `~/.config/magpie/plugin-auth.json` | `key`（`type: "api"`） | 调 Token Plan 的模型 |
| 账号 + 密码（填了才存） | 同一文件的 `metadata` | `metadata.username` / `metadata.password` | **整个账号** |
| 控制台 OAuth 令牌 | 同一文件的 `metadata`，或 `~/.sensenova-quota.json` | `access` / `refresh` / `cookie` / `iamBase` | 读额度、续期令牌 |
| 会话 cookie（填了才存） | 同上 | `metadata.cookie` | 免密码换控制台令牌 |

**账号密码不只能读额度。** 它能登录 SenseNova 控制台、创建和删除 API Key、做这个账号下的一切。把它交给插件，等于把整个账号交给 Magpie 的凭据文件——这是本插件要求的最重的一项授权。**留空完全可用**（见第 5 条）。

`metadata` 里的账号密码有两个来源，都经你同意：插件登录框里填的，或你之前用 `snquota login --save-password` 存进 `~/.sensenova-quota.json` 的（那份文件存在时插件会读它）。**插件不会从浏览器、系统钥匙串或其它供应商的登录记录里抓取凭据**，也不写 SenseNova 服务端的任何凭据设置。

**有一处本地写入需要说明：** 控制台令牌存在 `~/.sensenova-quota.json` 里**该账号自己的条目**下（`accounts.<账号名>`；没填账号时用 API Key 指纹顶替）。额度是账号级的，一份令牌只属于一个控制台账号——共享一条记录就只能表示「最后登录的那个账号」，这正是以前几行账号显示同一份额度的原因。

文件的顶层记录是 `snquota` CLI 的单账号记录：它**会被读取**，且只在这个账号读的就是它时才会被刷新，所以单账号场景下 CLI 那份不会过期。（`credentialsFile` 选项只改变这些发生在哪，关不掉。）

### 2. 密码是明文存储的

**内容没有加密**，是纯 JSON。这一点与平台无关。

至于「谁能读到」，别指望文件权限兜底。Linux/macOS 上 Magpie 按 600 创建（只有你可读），但 Windows 上这个保护落不了地——本机实测，`plugin-auth.json` 和 `~/.sensenova-quota.json` 的有效模式都是 `666`，`ls -l` 打印的 `-rw-r--r--` 是 Git Bash 的假象。真实 ACL 是这样：

```
<你的账户>              FullControl
<某个本地用户组>        Modify        ← 不止你能读
NT AUTHORITY\SYSTEM     FullControl
BUILTIN\Administrators  FullControl
```

也就是说，任何以你的身份、或属于那个组的进程都能读到密码。**密码的安全边界是「这台机器上所有本地进程」，不是「只有你」。**

所以实际建议是：这两个路径别放进云同步目录、备份任务和 dotfiles 仓库。密码一旦跟着备份走了，走的是明文。

### 3. 密码是明文传输的，和浏览器不一样

**控制台代码**是这样（`U` 加密，`h.bK` 是登录请求）：

```js
// 能取到 JWKS 时，先用服务器公钥把密码加密再提交
if (s) { let t = await U(s, e.password); t && (r = t, a = !0) }
await h.bK({ username: e.username, password: r, challenge: t, is_encrypt: a })
```

浏览器发 `is_encrypt: true` + RSA-OAEP（JWE，`alg: RSA-OAEP, enc: A256GCM`）密文。**本插件发明文（`is_encrypt: false`）**——这一段是**实测**：服务端接受，不强制加密。

两者最终在服务端都是明文（它本来就要拿明文校验）。差别在**链路暴露面**：HTTPS 仍保护传输，但任何能看到 TLS 明文的东西——企业代理、抓包工具、带请求体的日志——都能看到密码。如果你在这种环境里，别填密码。

### 4. 密码几乎不会被用到

续期顺序是 `refresh_token` → 会话 cookie → 账号密码，**第一步成功即停**。只要 refresh token 活着，密码一次都不会发出去。它只是 refresh token 死掉之后的兜底。

### 5. 不想存密码就留空

登录时的账号和密码两栏都可以留空。三种用法，代价各不相同：

| 做法 | 凭据落在哪 | 适合谁 |
| --- | --- | --- |
| **只填 API Key** | 只有 `key` | 只要模型调用，不在乎额度显示 |
| **账号密码都留空** | 插件读 `~/.sensenova-quota.json`（`snquota` CLI 写的，通常有 refresh token） | 想显示额度，但不愿把账号密码交给 Magpie |
| **填账号** | 明文进 `plugin-auth.json` | 没有别的令牌来源，接受第 1、7 条的风险 |

留空且那份配置也不存在时，额度会报错提示登录——**模型调用两种情况下都不受影响。**

### 6. 它和哪些主机通信，没有遥测

默认部署（`platform.sensenova.cn`）下是三个：

| 主机 | 用途 | 发送什么 |
| --- | --- | --- |
| `token.sensenova.cn` | 模型请求、模型清单 | API Key |
| `platform.sensenova.cn` | 读额度；图标 URL 也在这个域 | 控制台令牌 |
| `iam.sensecoreapi.cn` | 续期控制台令牌 | 账号密码（仅第 4 条的兜底场景） |

源码里还有第四个：`iam.sensecoreapi.tech`。它是**另一个部署**（`nova.sensecore.tech`）的 IAM 基址，只在账号属于该部署时才会用到（`iam_base` 可覆盖）。你在 `platform.sensenova.cn` 上就永远不会碰到它。

除此之外不向任何地方发送数据——没有遥测、没有上报、没有第三方 SDK。**不读其它供应商的凭据**（技术上能读同一个 `plugin-auth.json`，见第 7 条；重点是代码没这么做，不是环境做不到），不改 Magpie 之外的配置，也不创建或删除 API Key（控制台令牌有这个权限，但插件只调那一个只读接口）。

额度读取默认缓存 60 秒（`quotaTtlMs`），被轮询的 `usage` 钩子不会把接口打爆。

### 7. Magpie——以及其它插件——能看到什么

Magpie 官方文档的 FAQ 里有这么一条：

> **插件能看到用户的哪些内容？** 它发出的请求里的一切：对话、工具及其结果。只把它发到用户要求的地方，也不要记进日志。

这条对本插件同样成立，必须讲清楚：**本插件是供应商插件，处在请求路径上。** 它注册 provider 并包装 `fetch`，在请求发出前把 `authorization` 头换成当前 API Key：

```js
async fetch(input, init) {
  const headers = new Headers(init?.headers ?? source?.headers);
  headers.set("authorization", `Bearer ${current}`);
  return fetch(new Request(source, { ...init, headers }));   // body 原样透传
}
```

所以从能力上讲，它**处在能看到你全部对话、工具调用及其结果的位置上。**

代码的实际行为：**只读请求头、只改写 `authorization` 这一个字段**，不读请求体（`body` 由 `{...init}` 透传），不把内容写到任何地方，不缓存提示词或响应，也不向第 6 条列出的主机之外发送任何数据。**但这是代码的自我约束，不是平台给的隔离**——你只能靠读代码确认，Magpie 不能替你保证。

关于 Magpie 的插件机制，有三个事实决定这份约束值多少：

- **插件没有沙箱。** 插件是跑在 Magpie 进程里的普通代码，能用 `fs` 读文件。Magpie 文档建议「在沙箱里运行 magpie」、用独立的 HOME，正是为此。
- **插件没有审核。** 从 GitHub topic 装进来的插件，Magpie 会明确标注「没有人审阅过」。本插件同样是未审核的第三方代码。
- **所有插件的凭据在同一个文件里。** `plugin-auth.json` 是一个文件装着所有供应商、所有插件的登录信息，不是每插件一份。既然插件没有沙箱又有 `fs`，**你装的任何其它插件都能读到本插件存在里面的账号密码。** 这是决定「要不要填密码」时最该考虑的一点——机器上有来路不明的插件就留空（见第 5 条）。

Magpie 自己读 `plugin-auth.json`（管理登录）、`plugins.json`（插件与选项）和 `plugin-providers.json`（上次列出的供应商与模型）。而且**插件详情页显示的是 npm 上的 README**——所以这份 README 就是本插件唯一的披露面，这里每一条都写成可核对的。

### 8. 风险声明：额度接口是控制台内部接口，不是公开 API

额度数字来自控制台主机上的一个接口，**控制台自己的前端**用它画积分面板。它没有文档，随时可能变更或消失。确切路径刻意不写在这里；需要看的话在 `quota.mjs` 里。

走这条路是因为平台**根本不提供 API Key 可访问的额度接口**——**实测**：公开 LLM 主机上的十几个候选路径（`/v1/llm/usage`、`/v1/llm/quota`、`/v1/llm/balance`、`/v1/dashboard/billing/subscription` 等）全部 404。

**风险不止「可能失效」。** 如实列出：

| 风险 | 说明 |
| --- | --- |
| **可能违反服务条款** | 该接口是控制台前端自用的，不是对外承诺的 API。脚本代访问是否被允许由平台解释，**请自行确认**。本插件不改变也不规避任何条款。 |
| **可能随时失效** | 未公开接口没有兼容性承诺。改版、加签名、加风控都可能让它变成 404 或 403，届时额度显示报错（模型调用不受影响）。 |
| **可能触发风控** | 自动登录加定时读额度，从服务端看是非典型客户端行为。插件已经把额度读取缓存 60 秒、把密码降为最后手段来压低痕迹，但**不能保证不被判定为异常**。 |
| **扩大凭据暴露面** | 调这个接口需要持有控制台令牌（以及可选的账号密码）。这部分风险见第 1~7 条。 |

四条里只有第一条需要你判断——技术问题插件都能处理，合规问题不能。**在意的话就别用额度功能**：只填 API Key，插件退化成纯模型供应商，不碰控制台接口，第 2~4 条风险随之消失。

### 9. 它不做的事

- 不申请、不轮换、不撤销你的 API Key。
- 不改你的 SenseNova 账号设置。
- 不读、不记录、不转发你的模型请求内容——只改写 `authorization` 一个头，body 原样透传给 `token.sensenova.cn`（代码见第 7 条）。
- 不缓存提示词或响应。
- 不写 SenseNova 服务端的任何凭据设置。
- 对 `~/.sensenova-quota.json` 只写自己的按账号条目（`accounts.<账号>`），以及——当它读的就是顶层记录时——CLI 的单账号顶层记录，别的都不碰。

---

## 两件事，一个包

平台把这两样放在完全不同的地方，所以插件同时做两件事：

| | 位置 | 鉴权 |
| --- | --- | --- |
| **模型调用** | `https://token.sensenova.cn/v1`（OpenAI 兼容） | API Key |
| **积分额度** | 控制台主机上的一个内部接口 | 控制台 OAuth 令牌 |

**没有任何 API Key 可访问的额度接口。** 十几个候选路径逐个探过、全部 404；额度只存在于控制台自己的接口后面，需要 Ory Bearer 令牌。所以这两套凭据**真的彼此独立**，插件在登录时一起收集。

---

## 额度上报到哪

Magpie 的插件系统**不允许插件添加面板或页面**，也没有任何东西能喂进用量概览分析页——那由 Magpie 自己的请求计量驱动。

插件唯一的额度通道是 `auth.usage`。它返回的内容出现在三处：

- 供应商的**账号行**
- `magpie quota`
- 网关的 `GET /v1/magpie/quotas`

好消息是 Magpie 的额度模型和 SenseNova 的数据几乎一一对应，信息不丢：

| SenseNova | Magpie |
| --- | --- |
| 通用池 5 小时窗口（`window_5h`） | 一条 `windows[]`，`span: 18000` |
| 通用池本周（`window_7d`） | 一条 `windows[]`，`span: 604800` |
| 池覆盖哪些模型（`model_ids`） | `models[]`（语义是「恰好这些 id」） |
| 套餐名（`plan.name`，实际是 `Free Plan`） | `plan` |
| 活动积分余额（`grant_balance`） | `balance` |
| 窗口重置时间（`reset_at`） | `resetsAt`（秒级 Unix 时间戳） |

模型归属用服务器自己的 `model_ids`，不按名字猜——专属池的 `model_ids` 是 `["sensenova-6.7-flash-lite","sensenova-6.8-flash-lite"]`，比任何关键词匹配都准（只在 `model_ids` 缺失时才退回匹配 `flash-lite`）。套餐名同理，取接口的 `plan.name`。

### ⚠️ `amount` 是必须的，文档里没写

除了 `used`（已用百分比）和 `limit`（配额），每个窗口还必须带 **`amount`（已用数量）**。

这是踩过坑才知道的：只给 `used` 和 `limit`，百分比是对的，但界面上的数字读成 `0 / 600000`——和真实余额完全对不上。Magpie 按「已用 / 配额」渲染卡片，还提供「已用 | 剩余」切换，两边都从 `amount` 算；缺了它，数量只能按 0 处理。

这个字段**不在插件文档的窗口字段列表里**（文档只列了 `name`/`used`/`resetsAt`/`resetSecs`/`span`/`display`/`model`/`models`/`notModels`/`aside`）。它是从两个社区插件里对出来的——`@magpie-community/opencode-workbuddy-auth` 和 `opencode-zcode-auth` 都设了它，后者的注释写明了用途：

> the count is told carries it as **amount of limit**, so magpie's card says …

所以本插件的每个窗口都带 `used`（百分比）、`amount`（已用数量）、`limit`、`unit`、`display`、`span`、`resetsAt`，专属池再加 `models`。`display` 用 Magpie 自己的紧凑格式（`compact()`：整数给整数，否则两位小数）生成，和 `amount`/`limit` 并排渲染时格式一致。

对账很简单：`limit - amount` 必须等于控制台显示的本周剩余。**实测**四个窗口全部精确相等。

---

## 安装

```bash
magpie plugin add <本仓库路径>
magpie plugin login sensenova
```

登录问三件事：

1. **SenseNova API Key**（必填）——控制台 → API-Key 管理。没有它这个供应商发不出任何请求。
2. **账号**（选填）——用来读控制台积分额度。
3. **密码**（选填）——同上。

第 2、3 问是插件自己声明的（`prompts`）。**第 1 问是 Magpie 的**：`api` 类型的方法，凭据由宿主询问并保存，所以本插件不再自己声明 `key` 提示。更早的版本声明了，同一个密钥会被问两遍——重复已去掉，登录就是这三问。方法上的 `placeholder` 是 Magpie 显示自己那问时用的。

后两栏留空没问题：插件会退回读 `~/.sensenova-quota.json`，由 `snquota` CLI 写在本机。

### Windows 上提示读不出来怎么办

Magpie 的提示读取器要一个真正的 Windows 控制台。从不提供控制台的 shell 启动——Git Bash / mintty 是最常见的情况——第一个提示就死：

```
magpie: read /dev/stdin: The handle is invalid.
```

这是 Magpie 自己的宿主代码在读它的标准输入（`/dev/stdin` 是 Go 对它的叫法），不是本插件：所有用文本提示的包行为都一样。两个绕法。

**改在命令行上回答。** 管道输入可用，答案按提示顺序读取——key、账号、密码。最后一行很关键：只有三行的话，读取器在最后一个提示前就用完了，报 EOF。

```bash
printf '%s\n%s\n%s\n.\n' "$SENSENOVA_API_KEY" "$ACCOUNT" "$PASSWORD" | magpie plugin login sensenova
```

**或者用 Magpie 应用自己的登录界面**，它完全不经过 CLI 读取器。

### 关于那两项控制台凭据

额度接口要控制台令牌，而令牌约 2.4 小时过期。插件实现了三条续期路径，按可靠性排序：

1. `refresh_token`（标准续期）
2. 浏览器会话 cookie（重放授权码 + PKCE 流程）
3. 账号密码（完整自动登录：`login_challenge` → challenge 校验 → 提交 → 跟随跳转链 → 换令牌）

已经在用 `snquota` CLI 的话，最省事的安排是让插件读那份配置，两边共用一套凭据：

```bash
snquota login --username <你的账号> --password <你的密码> --save-password
```

**密码是明文存在 `plugin-auth.json` 里的**（存储与权限细节见上面第 2 条）。不能接受就别填密码——用 cookie，或让插件读 `snquota` 的配置。

---

## 配置

`plugins.json` 里这一项的 `options`：

```json
{
  "spec": "…/magpie-sensenova",
  "options": {
    "baseURL": "https://token.sensenova.cn/v1",
    "quotaTtlMs": 60000,
    "scopeModel": "flash-lite",
    "locale": "auto",
    "credentialsFile": "~/.sensenova-quota.json"
  }
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://token.sensenova.cn/v1` | Token Plan 地址 |
| `quotaTtlMs` | `60000` | 额度读数缓存多久。`usage` 会被轮询，缓存防止接口被打爆 |
| `scopeModel` | `flash-lite` | 专属池用哪个关键词限定模型 |
| `locale` | `auto` | `zh`、`en`，或 `auto` 跟随机器。见下 |
| `credentialsFile` | `~/.sensenova-quota.json` | 控制台凭据的位置 |

### `locale`

Magpie 不向插件暴露 locale，也不给插件设置 UI，所以本插件渲染的一切——额度窗口标签、单位、错误信息、登录提示——的语言在这里设。改了之后 Magpie 下次加载生效：

```bash
magpie plugin options sensenova '{"locale":"en"}'
```

`auto`（默认）通过 `Intl` 读系统 locale，Windows 上反映设置的就是它；`Intl` 说不出什么时才看 `LANG`，所以 Git Bash 的 `LANG=C.UTF-8` 不会把中文机器翻成英文。认不出的值回退英文。

翻译用词取自控制台的[英文站](https://platform.sensenova.cn/en/console)，不是自创：两个池叫 **General Pool** 和 **Flash-Lite Dedicated Pool**，单位是 **credits**。翻译必须发生在这里，因为**额度接口不做本地化**——真实账号实测，`Accept-Language: zh-CN` 和 `en-US` 返回的都是 `["通用积分池","Flash-Lite积分池"]`，所以英文站的翻译是它自己前端做的。

登录提示是唯一不能随便切换的：答案在登录时存一次，之后改 `locale` 不会重译你已经回答过的问题。

---

## 额度和 API Key：额度是账户级的

**积分额度不按 API Key 拆分。同账户所有 Key 共用一个池。**

三条证据：

1. 控制台自己的横幅写着「**同账户所有 Key 共享**」。
2. 额度接口的响应**完全没有 Key 维度**——顶层只有 `{plan, pools}`，每个池带 `id`/`name`/`model_ids`/`window_5h`/`window_7d`/`grant_balance`/`pool_type`，任何地方都没有 key 标识。插件拿到的就是账户级的数字。
3. 按 Key 拆分在另一处：控制台的**使用明细**页。那个接口支持按 `apiKey` 筛选，每条调用记录带自己的 Key，可导出 CSV / Excel。

所以是两个不同的层：

| | 维度 | 是什么 |
| --- | --- | --- |
| **积分池（本插件显示的）** | 账户级 | 同账户所有 Key 共享；Key 是入口，不是独立的账本 |
| **使用明细** | 逐条调用 | 每条带 Key，可按 Key 筛选导出 |

### 多于一个账号

额度是账户级的，所以每个 SenseNova 账号需要自己的控制台令牌。它们存在凭据文件里该账号自己的槽位，键是登录时填的账号名（没填就用 API Key 指纹），两个账号各读各的数字。

自报姓名的账号绝不借用 CLI 的单账号令牌：槽位是它的名字，顶层记录里的令牌写着它签发给谁，对不上就是别人的。这防住的是以前那个故障——每行都读共享的那份令牌，最后登录的账号赢，`ensureToken` 又在那个未过期令牌上短路，从不以别人的身份登录。

每加一个账号都用填了账号栏的登录，它们就分开了。

### 对 Magpie 的实际影响

供应商卡标题写的是 "API key …HohJ"，但它显示的额度是**账户级**的。所以：

- 把**同一个 SenseNova 账户的两个 Key** 都加进 Magpie，两行显示**完全相同的数字**。
- Magpie 的「一个用完换下一个」在这种情况下失效——它以为每个 Key 各有 600,000 额度，实际共用一个池。**加 Key 不会多额度。**
- 想要更多额度意味着**另一个 SenseNova 账户**。

---

## 图标

用平台自己的图标：`assets/sensenova.png` 是 `https://platform.sensenova.cn/favicon.ico` 的原始字节。那个地址名叫 `.ico`、响应头也是 `image/x-icon`，但载荷其实是 65×65 的 PNG，所以 data URI 按字节声明成 `image/png`，而不是按头。

图标**内置而非引用 URL**，这样离线也能认出供应商，也不依赖平台一直供着这个文件。`package.json` 的 `magpie.icon` 仍指向那个地址，供发布到 npm 后的发现卡用。

---

## 模型

内置快照里的四个 id 不是编的——它们是平台自己用量报表吐出来的（`credit-usage-trend` 的 `series[].model_id`）：

- `sensenova-6.8-flash-lite`（多模态）
- `deepseek-flash`
- `glm-5.2`
- `kimi-k3`

登录后 `provider.models` 用 API Key 从 `GET /v1/models` 拉实时清单。这个接口比它 OpenAI 形状的外表暗示的丰富：每个模型返回 **`context_length`**、**`max_output_length`**、`input_modalities`、`output_modalities` 和 **`supported_features`** 列表（`tools`、`json_mode`、`reasoning`）。所以这里的模型卡是从平台读出来的，不是猜的——`models.mjs` 里的快照照着那份响应写，下表就是它对当前阵容的回答：

| 模型 | 上下文 | 最大输出 | 输入 | 特性 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | 1,048,576 | **393,216** | 文本 | tools, json_mode, reasoning |
| `deepseek-v4.1-flash` | 1,048,576 | **393,216** | 文本 | tools, json_mode, reasoning |
| `deepseek-v4-flash` | 1,048,576 | **384,000** | 文本 | tools, json_mode, reasoning |
| `glm-5.2` | 1,048,576 | 131,072 | 文本 | tools, json_mode, reasoning |
| `kimi-k3` | 1,048,576 | 65,536 | 文本 | tools, json_mode, reasoning |
| `sensenova-6.8-flash-lite` | 262,144 | 65,536 | 文本、图像 | tools, json_mode, reasoning |

这张表进过三次修正，每次都是问接口而不是信数字：

- 快照曾给全部四个模型写 131,072 上下文 / 32,768 输出。真实上限是 262,144 或 1,048,576 上下文、65,536 输出——`glm-5.2` 例外，输出 131,072。
- `normalizeModel` 曾只找 `max_completion_tokens` / `max_output_tokens`，从不读平台实际用的名字 **`max_output_length`**。于是即使实时清单在手，每个模型的输出上限也出来是 32,768。
- **目录里的 `max_output_length` 不是硬上限。** 用一个不可能的 `max_tokens` 去问，接口会用自己合法的区间回答——`field MaxTokens invalid, should be in [1, 393216]`。那个区间才是真实上限，而它和目录在 DeepSeek 模型上不一致：`deepseek-flash` 接受 **384K**，目录却写 **64K**，卡片少报了六倍。`models.mjs` 的 `MEASURED_OUTPUT_LIMITS` 存着这样读出来的上限，表里没有的模型退回目录值。两个 DeepSeek 数字差 3,216，因为接口对一个报 384×1024、另一个报 384×1000。

`kimi-k3` 是唯一仍取目录值的一行，因为探测它一直回 `429 inference exceeds tpm/rpm limit` 而不是区间。它的 65,536 当目录的说法对待，不是测量。

**有一个模型刻意不列出。** `/v1/models` 还提供 `sensenova-u1.5-lite`，但它的 `output_modalities` 是 `["image"]`——画信息图的——而 `chat/completions` 对它回 `404 model is not found`。本插件只服务对话，所以按「会写文本」过滤清单；在 选择器里提供它只会产生一个用户解释不了的错误。

**推理强度。** Magpie 用 `variants` 表示可选档位——从档位名（`low`/`high`/`xhigh`/`max`…）到该档 provider 选项的映射；其它供应商在 `plugin-providers.json` 的条目里有。SenseNova 不声明：`/v1/models` 的 `supported_sampling_parameters` 只列了 `temperature` 和 `stop`，特性也就是 `tools` / `json_mode` / `reasoning`。所以本插件报 `reasoning: true`（模型确实会思考）、**`variants: {}`——没有档位选择器**，因为没东西可选。平台将来暴露了，就往 `variants` 里放。

有实时清单就用实时清单；否则插件回落并打上 Magpie 的回落标记。Magpie 还会合并它自己 models.dev 里的 `sensenova` 条目，`deepseek-v4-pro` 出现时就是从那来的。

---

## 已知边界

- **额度只出现在三个地方**——账号行、`magpie quota`、`/v1/magpie/quotas`——塞不进用量概览。这是 Magpie 的设计，不是本插件没做到。
- 控制台令牌过期且三条续期路径全失败（refresh token 被撤销、cookie 过期、密码错）时，账号行显示一条 `error`，提示重新登录。
- 额度接口是控制台内部接口而非公开 API，改版可能破坏它。
- 平台在发布之后新加的模型，会带着本插件的默认上限，直到实时 `/v1/models` 拉取替换它们——只有那个接口知道新模型的数字。
- 没有推理档位选择器：平台把 `reasoning` 作为一个是/否特性暴露，仅此而已，所以 `variants` 为空——见[模型](#模型)。
- **Free Plan 上，除 `sensenova-6.8-flash-lite` 以外的模型，大多数请求都会 429。** 商汤给 Free Plan 在那个模型之外的所有模型都配了小得多的用量额度，单独记在自己的积分池里——就是额度报告里的「Flash-Lite 池」。这是吞吐额度不是积分用尽：`deepseek-flash` 回 `429 inference exceeds tpm/rpm limit` 的时候，通用池才读了不到 2%。
- **插件不重试这些，是有意的。** 响应原样交回 Magpie。重试几乎没用：额度按分钟级的窗口跑，`429` **不带 `Retry-After`**，等多久回来都是同一个答案——这里放个重试循环只会把请求吊住然后照样失败。Magpie 之后怎么处理（停摆 provider、换下一个）是它自己的决定。
- 很大的 `max_tokens` 可能还没尝试就被拒，是同一个按分钟计量：只在账号除了问题本身没有别的流量时，要 65,536 个 token 也回 `429`。[模型](#模型)里的上限说的是接口**接受**什么，不是套餐此刻**服务**什么。
- **`magpie provider rest-cap` 对本 provider 无效，而且这是 magpie 的 bug——不是你漏了什么设置。** 给插件 provider 写 `restCap` / `quotaRest` 会被接受、也确实写进 `~/.config/magpie/providers.json`，但读取时被忽略，所以被限流的账号仍按 magpie 默认停摆：10 分钟、限流时 30 分钟，额度等 15 分钟。在 magpie 0.1.2049 上对照实测——普通自定义 provider 同样的值 6/6 往返成功，本 provider 2/6（issue #2）。插件也设不了：值在插件代码运行之前就被 magpie 的 provider 合并丢掉。修复必须落在 magpie。

---

## 作为插件分发

把仓库推上 GitHub 本身不会让它出现在 Magpie 里。按官方文档，插件通过三条路被发现，走一条就够：

**1. GitHub topic（最省事）**

给仓库打 `magpie-plugin` 这个 topic，它就会出现在 插件 → 发现 → **非官方插件** 下，按 star 排序、标注无人审核。要求：

- `package.json` 必须在**仓库根目录**（本仓库满足）。
- 包若同时发布到 npm 且 `repository` 指向本仓库，安装走 npm；否则装仓库当前代码，所以**加载的文件必须已提交**（本仓库是纯源码无构建产物，满足）。
- fork、归档仓库、`magpie-community` 自己的仓库被排除。
- GitHub 最多每十分钟轮询一次，新 topic 几分钟内出现。

**2. npm**

插件浏览器搜 npm 用 `<关键词> opencode`，匹配包名或 keywords 里**同时**含 `opencode` 和 auth / plugin / provider 之一的包。本仓库的 keywords 已含 `opencode`、`opencode-plugin`、`opencode-auth`，符合条件。普通插件**不要求 scope**；`@magpie-community/` 只用于捐进官方社区仓库的包。

**3. 推荐列表（`registry.json`）**

这条路不对独立包开放。对着线上文件核过：全部 21 个条目都是 `@magpie-community/*`，且每一条都带 `"community": true`，无一例外。所以被列进去意味着**成为社区包**，而不是开一个加外部包的 PR。

走这条路，在 `magpie-community/plugins` 的 `packages/<name>` 下贡献，供应商包命名 `@magpie-community/opencode-sensenova-auth`，加的条目和其它条目一个形状：

```json
{
  "package": "@magpie-community/opencode-sensenova-auth",
  "name": "SenseNova",
  "icon": "sensenova",
  "providers": ["sensenova"],
  "community": true,
  "summary": {
    "en": "SenseNova Token Plan models, with the console's credit quota reported as native quota windows.",
    "zh": "接入商量/日日新 Token Plan 模型，并把控制台积分额度上报成原生额度窗口。"
  }
}
```

注意这里的 `icon` 是短名（条目用 `opencode`、`zcode`、`qoder`…），不是 `magpie.icon` 那种 URL。随之而来的两个好处：推版本到 `main` 即发布，且包会**在每个 Magpie 里自动更新**，用户不用重装。本仓库**零依赖**，挪过去不需要改代码——但那意味着包在别人的仓库里开发，所以这里默认不做。

这个列表最多每六小时拉一次，Magpie 内置一份快照兜底。`MAGPIE_PLUGIN_MARKET=<url>` 换成别的列表（`off` 表示只用内置的）。

`package.json` 的 `repository` / `homepage` / `bugs` 指向 `aqiu817/magpie-sensenova`，仓库带着 `magpie-plugin` topic，所以走路由 1 今天就能被发现。路由 2 和 3 是可选的，未做。

---

## 开发

```bash
node --test test/*.test.mjs
```

66 个测试覆盖：池到窗口的映射（含 `used` 百分比、`amount`、`limit`、`span`、`resetsAt`、专属池的模型限定、活动余额）；`limit - amount` 还原控制台余额；用量未知的窗口被跳过而不是报成零；字段缺失时的降级；JWT 过期；refresh token 续期；没有凭据时的报错；`fetch` 钩子对 `(url, init)` 和 `Request` 两种输入都保住 body 和头；内部 `__` 前缀的键绝不进凭据文件；模型规范化的两种信封；locale 判定（显式、系统、环境变量、POSIX `C`）；两张字符串表保持同步；通用池不经过专属池的命名规则；`accountNameOf` 从令牌读名字、拿不到就不编；账号提问声明在 `email` 键下、`consoleAuthOf` 仍认旧的 `username`/`account` 拼写；以及两种语言下 `usage` 钩子的端到端。
