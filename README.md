# dsh-plugin-balance

[English](./README.en.md) | 简体中文

把各厂商的 **API 余额，常驻在 dsh Web 侧边栏**：一张贴在设置按钮上方的卡片，显示**当前会话**所用模型背后那个厂商的余额——带环形进度、百分比、每个套餐各自的进度条，以及最后更新时间。

<img width="300" height="126" alt="image" src="https://github.com/user-attachments/assets/30b0f402-e1f5-41fc-97c7-a1388d4245ce" />
<img width="298" height="109" alt="image" src="https://github.com/user-attachments/assets/d7382730-31ce-435c-b5de-c84e4242c95c" />
<img width="306" height="83" alt="image" src="https://github.com/user-attachments/assets/7b32d4ca-6f5b-4abd-b209-e28af22f6997" />



切换模型，卡片跟着切换。点击卡片**原地**展开详情面板——不发生任何页面跳转，会话保持在原处。

<img width="345" height="655" alt="image" src="https://github.com/user-attachments/assets/cefc05cb-8eb3-4404-8059-f0875dea8ca4" />

- **六家厂商，各自的官方账单接口**——DeepSeek、StepFun、Kimi Coding、OpenRouter、MiniMax、xAI/Grok——外加你在 `providers.json` 里声明的任意厂商。
- **WorkBuddy 与 Qoder 的积分，不重复实现。** 选中 `workbuddy` / `workbuddy-ai` 或 `qoder` / `qoder-global` 模型组时，显示的是 `dsh-workbuddy-connect` / `dsh-qoder-connect` 已经发布在自己状态路由上的剩余积分。
- **兼容 dsh-plugin-subscriptions 订阅额度。** 选中 **ChatGPT (Codex)**、**Claude**、**Grok (X Premium)**、**GitHub Copilot** 或 **Google Antigravity** 时，直接呈现其订阅配额、重置时间与模型额度。
- **单位绝不混用。** 钱说 元 / `¥` / `$`；积分说 积分，带自己的标记。无法辨认单位的数字显示为 `单位未知` 加通用符号 `¤`，而不是猜成元——把 1,000 积分印成 `¥1,000` 是在谎报余额。
- **一个 `余额监测` 设置页。** 显示位置（侧边栏卡片 / 输入框胶囊 / 两处 / 都不显示）、轮询间隔、告警阈值、单位写法、更新时间、千位分隔——全部写入本插件自己的文件，不触发 loader 重建、不需要重启。
- **密钥只留在宿主。** 浏览器半边只收到数字。
- **在鉴权栅栏之内。** 读数来自 `GET /api/dsh.balance`，设置来自 `GET/POST /api/dsh.balance.settings`，都走 Connection 的鉴权通道。
- **构造上即启动安全。** 不向 dsh 索要任何东西：某个服务被改名或缺失时，插件只是少显示一点——绝不阻止应用启动。

## 安装

需要 **dsh 0.1.7 或更新**，Node **22.19+**（或 24+）——与 dsh 本体的要求一致。

在 dsh Web 界面打开侧边栏的**插件页**，把下面任意一条粘贴进安装框并确认：

```
https://github.com/Utmotc/dsh-plugin-balance/archive/refs/heads/main.tar.gz
```

这是当前 `main`。要可复现的安装，用 tag：

```
https://github.com/Utmotc/dsh-plugin-balance/archive/refs/tags/v1.3.0.tar.gz
```

仓库地址（`https://github.com/Utmotc/dsh-plugin-balance`）也可以，但 pnpm 会把它按 **git** 依赖解析，机器上需要有 `git`；`archive/.../main.tar.gz` 形式是纯 HTTPS 下载。

安装会自动做三件事：

1. 把包 `pnpm add` 进 `$DSH_HOME/profiles/web`；
2. 找到它的 `dsh.bundle.patch`，把包加进 `dsh.profile.bundles`——**自动激活**；
3. 应用 bundle 补丁，插入插件的 loader 行。

然后在同一页面打开或关闭它。一个声明了 `dsh.bundle` 的包才会进 bundles——这是插件必须做对的一件事，本插件做对了。

升级：pnpm 按依赖串缓存，所以推送新版本后，在插件页卸载再重装（或装一个新 tag）。每次发布都固定一个 tag，可以彻底绕开这个问题。

更喜欢终端的话，等价的手动操作：

```bash
# 转发到 profile 内的 pnpm；profile 不存在时同样会创建
dsh plugin --profile web add https://github.com/Utmotc/dsh-plugin-balance/archive/refs/heads/main.tar.gz
```

这只安装**依赖**。激活是单独一步——CLI 不会动 `dsh.profile.bundles`（实测 manifest 原样返回）。两种方式任选收尾：

- 打开插件页：包已列为 bundle，开关是**关**的——打开它；或
- 自己把 `"dsh-plugin-balance"` 加进 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`。

插件页自己的安装框一步做完两件事，所以它是推荐路径。

## 密钥从哪来

每个厂商都通过一个凭据引用读取，宿主按请求解析——浏览器不缓存任何东西，本插件也不往磁盘写任何密钥。

| 厂商 | 凭据引用 | 设置命名空间 |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `llm-deepseek-api-key`，或 `llm-pi-ai` |
| StepFun | `STEPFUN_API_KEY` | `llm-pi-ai` |
| Kimi Coding | `KIMI_API_KEY` | `llm-pi-ai` |
| OpenRouter | `OPENROUTER_API_KEY` | `llm-pi-ai` |
| MiniMax | `MINIMAX_API_KEY` | `llm-pi-ai` |
| xAI / Grok | `XAI_API_KEY` | `llm-pi-ai` |

如果你的设置里用的是别的变量名，或者某个厂商走了网关，插件会跟随：base URL 和密钥名读自 `llm-pi-ai.providers.<id>`（DeepSeek 读 `llm-deepseek-api-key.apiKeyEnv`）。优先级是 **设置 → 本插件 `config`（仅 DeepSeek）→ 内置默认**。

## 覆盖范围

| 厂商 | 接口 | 读数 |
|---|---|---|
| DeepSeek | `GET /user/balance` | 金额 ¥ |
| StepFun | `GET /v1/accounts` | 金额 ¥ |
| Kimi Coding | `GET /v1/usages` | 额度（小时 + 每周窗口） |
| OpenRouter | `GET /api/v1/auth/key` | 金额 $ |
| MiniMax | `GET /v1/token_plan/remains` | 剩余额度 |
| xAI / Grok | `GET /v1/dashboard/billing/credit_grants` | 金额 $ |
| WorkBuddy / WorkBuddy AI | `dsh-workbuddy-connect` 自己的状态路由 | 积分 |
| Qoder / Qoder Global | `dsh-qoder-connect` 自己的状态路由 | 积分 |
| ChatGPT (Codex) | `dsh-plugin-subscriptions` RPC 通道 | 订阅额度（5 小时 / 7 天） |
| Claude | `dsh-plugin-subscriptions` RPC 通道 | 订阅额度（5 小时 / 7 天） |
| Grok (X Premium) | `dsh-plugin-subscriptions` RPC 通道 | 订阅额度（2 小时窗口） |
| GitHub Copilot | `dsh-plugin-subscriptions` RPC 通道 | 订阅额度（高级请求每月） |
| Google Antigravity | `dsh-plugin-subscriptions` RPC 通道 | 订阅额度（各模型独立配额） |

**没有 API 级账单的厂商**——OpenAI 与 Anthropic 的纯 API Key 模式（只有管理员密钥的用量/成本报表）、Together AI（用量），以及 Qwen、小米 MiMo、百川、Mistral、Groq、Cohere（只在控制台）——显示「暂不支持」，有控制台链接的会给出链接。

### 订阅来源：与 dsh-plugin-subscriptions 联动

`codex`、`claude`、`grok`、`copilot`、`antigravity` 的额度来自用户的 Web 登录会话或 OAuth 授权，由 `dsh-plugin-subscriptions` 提供。
- **浏览器端直接接入**：通过该插件自带的 `subscriptions-auth` RPC 通道在前端直接获取实时配额与重置时间，无需宿主端发起上游接口调用，也不触碰账号凭证。
- **智能避让与防歧义**：宿主端将这些 route id 的纯 API Key 查询安全拦截（避免误将 Grok X Premium 订阅与 xAI API Key 额度混淆），当用户未安装该插件或未登录时，优雅降级为 `未登录` 或 `读取失败` 状态。

### 积分来源：复读，而不是重新实现

`workbuddy` / `workbuddy-ai` 与 `qoder` / `qoder-global` **没有本包能用 API Key 去调的上游账单接口**：它们的剩余积分属于桌面端登录或个人访问令牌（PAT），归那两个插件所有。那两个插件已经在自己的环回状态路由上发布了数字，所以本包直接去读：

| provider | 读取自 |
|---|---|
| `workbuddy` | `/plugins/dsh-workbuddy-connect/status` |
| `workbuddy-ai` | `/plugins/dsh-workbuddy-connect/ai/status` |
| `qoder` | `/plugins/dsh-qoder-connect/status` |
| `qoder-global` | `/plugins/dsh-qoder-connect/global/status` |

应答被归一化成 `kind: "credits"` 读数交给浏览器半边。**这里不复制那两个插件的任何逻辑**：当某个插件缺失、被禁用、未登录或上报了账单错误时，读数会降级并说明是哪一种。

**两个来源对 `total` 的定义相反，这一点是承重的。** WorkBuddy 的 `credits.total` 是标题位的**剩余**数；Qoder 的 `credits.total` 是本轮的**消耗百分比**——正好相反。所以各自有各自的归一化器：WorkBuddy 的 total 直接采信，Qoder 的剩余总量从行记录求和、它自己的百分比单独存为 `usedPercent`（面板标为 本轮已用）。把一个当成另一个，就会印出一个看起来是积分、含义却相反的数字。

**`unlimited` 标志不是积分事实，本读数忽略它。** 两个插件都用它标记某个*模型*免费——不消耗积分——这与账户里有多少积分无关。Qoder 尤其会在其某个套餐是无限量个人额度时把标志放在顶层，而文档其余部分仍携带真实数字。在这里渲染它会回答一个本插件没有问的问题，更糟的是会用「不限额」顶掉真实数字。所以读数永远显示求和结果，这个标志从不出现在界面上。

读取走的是与所有其他厂商**同一套**按厂商缓存、刷新下限与请求合并，所以轮询不会砸穿那两个插件的路由。读取地址只可能是环回来源（`127.0.0.1` / `localhost` / `[::1]`）——web server 服务可用时用它的监听端口，否则用浏览器带来的 `Host`；非环回的 `Host` 永远不会被请求。本包**不铸造、不复制、不发送任何凭据**。

卡片把每个套餐的 `remain / size` 连同各自的进度条列出，同名赠礼合并、耗尽的剔除，与两个插件自己的卡片一致。拒绝被逐个命名，而不是一个笼统的失败：

| 情形 | 胶囊 / 卡片 | 面板 |
|---|---|---|
| 拥有积分的插件缺失或被禁用 | `未安装` | 没有可读的积分来源 |
| 桌面端未登录（或没存 PAT） | `未登录` | 登录一次，或保存 PAT |
| 状态路由读不到 | `读取失败` | 确认 dsh web 在运行且能访问自己的端口 |
| 拥有方插件上报了账单错误 | `读取失败` | 显示它上报的错误 |

## 单位

钱和积分是两回事，本插件绝不让一个冒充另一个。每个数字都经过一个由读数自身声明类型推导出的单位描述符：

| 读数 | 标记 | 单位词 | 示例 |
|---|---|---|---|
| `currency` CNY / USD / EUR | `¥` / `$` / `€` | 元 / 美元 / 欧元 | `¥4.19` |
| `currency`，未知币种代码 | 代码本身 | 代码本身 | `XYZ4.19` |
| `currency`，没有代码 | `¤` | 单位未知 | `¤4.19 单位未知` |
| `credits` | `🎫` | 积分 | `🎫1,261 积分` |
| `quota` | `#` | 额度 / 次 | `#87 / 100` |
| 尚无读数 | `¤` | — | `读取中…` |

`单位写法` 设置选择单位说得多响（`符号` / `名称` / `只显示数字`），但任何设置都不取消这个区分：积分在任何设置下都带 积分 字样，无法辨认的单位总是被明说，因为它没有诚实的符号可以借。标题词本身就是单位——胶囊与卡片上 `DeepSeek余额` 对 `WorkBuddy积分`——所以即使数字样式选了 `只显示数字`，量纲也仍然被命名。

## 接入你自己的厂商

三条接入路径，工作量从小到大。选第一条够用的。

### 路径一——纯声明，零代码（推荐）

插件读取用户文件 `$DSH_HOME/model-balance-providers.json`
（默认 `~/.dsh/model-balance-providers.json`；`DSH_MODEL_BALANCE_CONFIG`
可指向别的文件）。那里的条目合并到内置列表之上，所以它也是为一个**新**
id 覆盖内置 endpoint 的方法。

1. 找到该厂商的账单接口——一个带鉴权的 `GET`，用
   `Authorization: Bearer <API key>` 调用，应答里带剩余金额（或额度窗口）。
2. 往文件里加一个条目：

   ```json
   {
     "providers": {
       "my-vendor": {
         "name": "My Vendor",
         "baseURL": "https://api.example.com",
         "endpoint": "/v1/balance",
         "keyEnv": "MY_VENDOR_API_KEY",
         "response": { "type": "currency", "currency": "CNY", "balance": "data.balance" }
       }
     }
   }
   ```

3. 把密钥存进凭据接缝（`MY_VENDOR_API_KEY` 环境变量或 dsh 凭据库），
   重启 dsh（厂商列表按进程缓存），再选中该厂商路由上的一个模型。
4. 验证：侧边栏卡片显示该厂商的名字和数字。如果显示「读取失败」，
   打开详情面板——确切的 HTTP 状态或解析错误会印在那里。

**`response` 契约**（这条路径的全部接口）：

| 字段 | 含义 |
|---|---|
| `type` | `currency`（金额）或 `quota`（额度窗口） |
| `currency` | `currency` 类型的 ISO 代码；决定 `¥` / `$` / `€` |
| `balance` | 金额在哪——见下方三种写法 |
| `limit` / `used` / `remaining` | `quota` 类型的三个字段，都必须解析出数字 |
| `resetTime` | 可选，指向 ISO 时间戳的点路径 |
| `available` | 可选，`currency` 类型指向布尔值的点路径 |

值有三种写法：

- **点路径** —— `"data.balance"`（数字段索引数组）；
- **数组查找** —— `{ "path": "balance_infos", "find": { "field": "currency", "equals": "CNY" }, "value": "total_balance" }`；
- **表达式** —— `{ "expr": "(data.limit - data.usage) / 100" }` —— 用
  `new Function` 求值，所以配置文件是**受信代码**：保证只有你自己可写。

> 厂商 id（上面的 `my-vendor`）必须是 harness 给这个厂商用的**路由 id**——
> 与模型选择里出现的 id 相同。别名用 `"aliases": ["other-name"]` 声明。
> 以 `_` 开头的键是注释。

### 路径二——积分归另一个 dsh 插件所有

如果额度存在于另一个插件的登录态里（WorkBuddy 和 Qoder 就是如此），
就没有可调的上游账单接口。宿主半边改读拥有方插件自己的环回状态路由。
这条路径目前需要写代码：在 `lib/index.js` 的 `CREDIT_SOURCES` 加一个条目
（路由路径与应答形状），形状是新的话在 `CREDIT_NORMALIZERS` 加一个归一化器，
再在 `lib/client.js` 的 `SOURCE_PLUGIN` / `UNQUERYABLE_PILL` /
`UNQUERYABLE_NOTE` 加对应的展示行。状态路由必须接受环回 `Host`，必须把
缺失的 `Origin` 头视为允许（读取方是服务端 fetch），并且应当降级成有名有姓
的原因（`signed-out`、`credits-error`、……）而不是裸失败。

### 路径三——内置策略

想让每个用户开箱即得的厂商，往 `lib/strategies.js` 的 `STRATEGIES` 加一个
解析器（接口基址、凭据引用、应答解析），往内置 `providers.json` 加一条
作为文档，再往 `test/host.test.mjs` 加测试夹具。同一 id 上内置条目胜过
声明式条目，所以内置策略也是把某家厂商的解析修到任何用户配置之上游的
办法。**没有 API 级账单**的厂商则进 `LOGIN_REQUIRED_BY_ID` /
`LOGIN_REQUIRED_URLS`——读数会点名控制台并给出链接。

### 三条路径共享的东西

- **密钥不出宿主。** 浏览器半边只收数字；凭据引用按请求经凭据接缝解析。
- **读数按类型分发**——`currency`、`quota`、`credits`、`unqueryable`——
  从不按厂商名分发，所以新来源不需要浏览器半边的任何特例。
- **每个读数都声明单位**，新的 `quota` 来源永远不会被印成钱。
- **缓存、刷新下限与请求合并是共享的**，话痨的新来源砸不穿它的厂商。

## 发布这个仓库

这个包可以直接从 GitHub 安装；不需要构建，也不需要发布到 npm。

1. 创建 GitHub 仓库 `Utmotc/dsh-plugin-balance` 并推送：

   ```bash
   git init && git add . && git commit -m "dsh-plugin-balance 1.2.4"
   git branch -M main
   git remote add origin https://github.com/Utmotc/dsh-plugin-balance.git
   git push -u origin main
   ```

2. 给每个发布打 tag——固定 tag 是可复现安装的形式：

   ```bash
   git tag v1.2.4 && git push origin v1.2.4
   ```

3. 加 topic（仓库设置 → About ⚙ → Topics，或用命令行）：

   ```bash
   gh repo edit Utmotc/dsh-plugin-balance --add-topic dsh-plugin --add-topic deepseek-harness
   ```

4. 用户在插件页用这个地址安装：

   ```
   https://github.com/Utmotc/dsh-plugin-balance/archive/refs/heads/main.tar.gz
   ```

每次推送都更新 `package.json` 的 `version`，插件页的升级提示才会如实工作——
pnpm 按依赖串缓存。

## 配置

loader 行的 `config` 接受（全部可选——任何不可用的值回落到默认）：

| 键 | 默认 | 含义 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek 的凭据引用 |
| `baseURL` | `$DEEPSEEK_BASE_URL`，再退到官方 API | DeepSeek 接口基址 |
| `timeoutMs` | `15000` | 对厂商的单请求超时 |
| `minIntervalMs` | `2000` | 同一厂商两次上游读取的最短间隔 |
| `okTtlMs` | `60000` | 好读数被直接复用的时长 |
| `errorTtlMs` | `15000` | 失败读数被复用的时长 |
| `defaultProvider` | `deepseek` | 请求未指名厂商时的应答对象 |

刻意**不导出 config schema**：schema 意味着要 import schemastery，而上面每个
值都已有安全默认——写错字只损失一个默认值，不损失激活。

### 用户设置（`余额监测` 页）

从设置页进入——不需要 profile 补丁，不需要重启。文档存在本插件自己的文件里
（`$DSH_HOME/dsh-plugin-balance/balance-settings.json`，或该行的
`settingsFile`），因为走 loader 行写设置会重建整个插件树并热重载 fiber
（约 1–1.5 秒，外加一次客户端镜像风暴），每拨一个开关都要付一次这个代价。

| 字段 | 默认 | 取值 |
|---|---|---|
| `placement` | `sidebar` | `sidebar`（设置旁卡片）· `composer`（输入框下胶囊）· `both` · `none`（隐藏读数；插件保留设置与接口） |
| `pollMs` | `60000` | 15000 – 3600000 |
| `warnPercent` | `20` | 0 – 100；低于此值进度条与百分比转告警色 |
| `showUpdatedAt` | `true` | 显示最后更新时间 |
| `unitStyle` | `symbol` | `symbol`（¥100 / 🎫100）· `name`（100 元 / 100 积分）· `none` |
| `groupDigits` | `true` | 千位分隔（`1,261`） |
| `cardBorder` | `true` | 画侧边栏卡片的细描边 |

`null` 把一个字段重置为默认。校验是封闭的：未知的字段名、越界的数字、未列出的枚举一律 HTTP 400 拒绝，什么都不写——而且文件在读取时会再校验一遍，手改出的坏值只损失那一个设置。

## 它是怎么造出来的

一个包，两半：

| 半边 | 职责 |
|---|---|
| 宿主（`lib/index.js`） | 厂商策略、积分来源读取、凭据解析、缓存、设置文件、两条鉴权路由 |
| 浏览器（`lib/client.js`） | 该显示哪个厂商、侧边栏卡片、输入框胶囊、详情面板、设置页 |

读数有四种，浏览器半边按类型分发而不是按厂商名分发：`currency`（钱）、
`quota`（额度窗口）、`credits`（workbuddy / qoder）、`unqueryable`（附带原因）。
接入一个来源意味着教宿主半边认识一个接口，而不是给浏览器半边加特例。

- 侧边栏卡片注册进 `sidebar.footer.action`——外壳渲染在设置按钮上方的那条槽；在 56px 窄栏里收缩成一个带环的单图标格。它带一圈随主题的细描边（`--dsw-alias-border-l2`，即 harness 自己的浅灰描边色，跟随主题），可在设置页关闭；开关只清掉描边*颜色*，所以切换它不会让卡片挪动两像素。
- 点击卡片在**卡片旁**展开详情面板，样式对齐自带对话框——它不导航：不选中任何布局面板，会话保持挂载。
- 显示位置是一个设置，所以原有的输入框胶囊（portal 进 `[data-composer-stats]`，新会话面上退回输入框下自己的行）仍可单独或与卡片同用。未选中的面完全不轮询，`none` 不留任何空占位盒——输入框下闲置的容器仍会贡献那层 flex gap。
- 百分比与进度条从行记录计算，从不采信来源的标题标量，所以两个积分来源相反的 `total` 语义漏不进进度条。
- 标记画成**文本**（`¥` / `$` / `€` / `🎫` / `#` / `¤`），不用图标库：dsh 0.1.7 把 primitives 的图标导出改了名（`IconRefreshOutline16` → `IconRefreshOutlineRegular`），伸手去拿旧名只会静默落空。刷新按钮用的是现名，并且未来 dsh 再改名时仍会退回文本。

### 兼容性说明

已对照 **dsh 0.1.7-rc.2** 验证：

- 路由通过 `connection.fetch.register` 注册（带鉴权的 `/api` 通道）——与官方控制器同一条缝；两条路径都是本包独有的，所以重复路径冲突只可能来自本插件的另一份拷贝。
- 浏览器半边只 require 平台种子模块（`react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`），并声明**空**的 `dsh.client.inject`，所以它不往客户端模块图里加任何依赖边——某个客户端包缺失或改名不会拖垮本 bundle 的到达，本 bundle 也不会把自己级联进别的插件。
- 侧边栏卡片与输入框胶囊都是增量槽位条目（全新 id 的 `list` 槽），与 `dsh-qoder-connect` 的底部卡片、自带的统计行共存。有一条全局规则是有意共享的：把脚部容器强制成纵向，这与 Qoder 的同一条规则幂等，也正是整宽卡片能贴着设置按钮放下的原因。
- 凭据引用（`DEEPSEEK_API_KEY`、`KIMI_API_KEY`、……）经凭据接缝解析——环境变量或已存凭据，本插件从不写任何密钥文件。

### 启动安全

任何客户端条目激活失败都会让 dsh web 整体放弃启动（`web boot: N entries did not activate`）。所以一个装饰性插件绝不能硬依赖任何会被改名的的东西：

- 浏览器半边导出 `inject = []`，连槽位注册表都经 `ctx.inject` 到达，它等在**子** fiber 上；
- 宿主半边也导出 `inject = []`，路由注册在一个等待 `credentials` 与 `connection` 的子 fiber 里完成；
- `settings` 用 `ctx.get` 读取，dsh 砍掉它只损失自定义 base URL，不损失启动；
- 侧边栏槽位经 `ctx.inject` 到达，dsh 的布局若从不声明 `sidebar.footer.action`，只损失卡片；
- 积分来源的拥有方插件缺失是一次 `未安装` 读数，不是失败。

它还 **不 import 任何 dsh 的东西**——只有 Node 内置模块和自己的文件——所以在严格包布局与提升布局下都能解析。

## 开发

没有构建步骤：`lib/client.js` 就是随包发布的浏览器 bundle，`lib/index.js` 是普通 ESM。

```bash
node test/host.test.mjs       # 路由契约、厂商解析、积分来源、设置、缓存
node test/client.test.cjs     # 启动安全、单位、胶囊、侧边栏卡片、设置页、面板
node test/live-workbuddy.mjs  # 对着运行中的 dsh web 端到端（读真实积分路由）
```

前两个加载真实文件、stub 掉 dsh 上下文，不需要 dsh 进程、网络和密钥即可运行。第三个是可选的，需要一台活的服务器：把端口作为第一个参数传入（默认 3080）。它对积分路由是只读的，设置也只写到临时文件。

## 致谢

`lib/strategies.js` 的厂商策略、`lib/parsers.js` 的声明式解析器和 `providers.json`
改编自 **[dsh-model-balance](https://www.npmjs.com/package/dsh-model-balance)**
v0.1.4（`src/host/strategies.ts`、`src/host/custom-providers.ts`），MIT 许可，
版权归其贡献者——见 `LICENSE-dsh-model-balance`。改动：并入本包的模块布局、
内置 `providers.json` 的路径改为相对 `lib/`、日志前缀改名、导出面收缩为
`matchStrategy` / `matchLoginRequired` / `loadCustomProviders`。

## 许可

MIT —— 见 `LICENSE`。
