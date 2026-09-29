# dsh-balance-card

English | [简体中文](./README.md)

Provider **API balance, always visible in the dsh Web sidebar**: a card beside the Settings seat showing the balance of the provider behind the model **this conversation** is using — with a ring, a percentage and a progress bar per package, and the last-updated time.

```
╭──────────────────────────────────────╮
│ ◔ DeepSeek余额              ¥4.19  ⏱ │   ← the sidebar card
│   账户余额      ¥4.19 / ¥10.00   42% │
│   ████████░░░░░░░░░░░░░░░░░░░░░░░░░  │
╰──────────────────────────────────────╯
   ⚙ Settings
```

Switching models switches the card with it. Clicking the card opens the detail panel **in place** — nothing navigates away, so the conversation stays where it is.

```
¥ DeepSeek余额 4.19        ← read from the vendor's own billing endpoint
🎫 WorkBuddy积分 1,261      ← re-read from dsh-workbuddy-connect's remaining credit
🎫 Qoder积分 100            ← re-read from dsh-qoder-connect's remaining credit
```

- **Six providers, their official billing endpoints** — DeepSeek, StepFun, Kimi Coding, OpenRouter, MiniMax, xAI/Grok — plus any provider you declare in `providers.json`.
- **WorkBuddy and Qoder credit, without re-implementing them.** Selecting the `workbuddy` / `workbuddy-ai` or `qoder` / `qoder-global` model group shows the remaining credit that `dsh-workbuddy-connect` / `dsh-qoder-connect` already publishes on their own status routes.
- **Support for dsh-plugin-subscriptions.** Selecting **ChatGPT (Codex)**, **Claude**, **Grok (X Premium)**, **GitHub Copilot**, or **Google Antigravity** presents their active subscription quotas, per-model usage bars, and reset countdowns directly.
- **Units are never conflated.** Money says 元, `¥`, `$`; credits say 积分 and carry their own mark. A figure with no identifiable unit is shown as `单位未知` with the generic `¤` sign rather than being guessed as yuan — because printing 1,000 credits as `¥1,000` would misstate the balance.
- **A `余额监测` settings tab.** Placement (sidebar card / composer pill / both / none), poll interval, warning threshold, unit style, updated-time, and digit grouping — all written to this plugin's own file, with no loader reconcile and no restart.
- **Keys stay on the host.** The browser half only ever receives a number.
- **Behind the authentication fence.** Readings come from `GET /api/dsh.balance` and settings from `GET/POST /api/dsh.balance.settings`, both on Connection's authenticated channel.
- **Boot-safe by construction.** Nothing is required of dsh: if a service is renamed or missing, the plugin shows less — it never stops the app from starting.

> Note: the plugin's user-facing UI strings are Chinese; this document is the English reference.

## Install

Requires **dsh 0.1.7 or newer**, Node **22.19+** (or 24+) — the same requirement dsh itself has.

### Option 1: One-liner CLI install via npm (Recommended)

This plugin is published on the official npm registry. Install it directly from your terminal:

```bash
dsh plugin --profile web add @utmotc/dsh-balance-card
```

> If using the community `dsh1024` CLI wrapper:
> `dsh1024 plugin --profile web add @utmotc/dsh-balance-card`

### Option 2: Install via the Web GUI

In the dsh Web GUI, open the **plugin page** in the sidebar, paste one of these into the install field, and confirm:

- **npm package spec** (Recommended):
  ```
  @utmotc/dsh-balance-card
  ```
- **Or GitHub release archive**:
  ```
  https://github.com/Utmotc/dsh-balance-card/archive/refs/tags/v1.4.0.tar.gz
  ```

Installing automatically does three things:

1. `pnpm add`s the package into `$DSH_HOME/profiles/web`;
2. finds its `dsh.bundle.patch` and adds the package to `dsh.profile.bundles` — **activation is automatic**;
3. applies the bundle patch, which inserts the plugin's loader row.

Then switch it on or off from the same page. A package that declares `dsh.bundle` will appear under bundles properly.

Upgrades: Since it is on npm, subsequent updates can be done with one command:
```bash
dsh plugin --profile web add @utmotc/dsh-balance-card@latest
```

## Where the keys come from

Each provider is read with a credential reference, resolved on the host per request — nothing is cached in the browser and nothing is written to disk by this plugin.

| Provider | Credential reference | Settings namespace |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `llm-deepseek-api-key`, or `llm-pi-ai` |
| StepFun | `STEPFUN_API_KEY` | `llm-pi-ai` |
| Kimi Coding | `KIMI_API_KEY` | `llm-pi-ai` |
| OpenRouter | `OPENROUTER_API_KEY` | `llm-pi-ai` |
| MiniMax | `MINIMAX_API_KEY` | `llm-pi-ai` |
| xAI / Grok | `XAI_API_KEY` | `llm-pi-ai` |

If your settings name a different variable, or you route a provider through a gateway, the plugin follows it: base URL and key name are read from `llm-pi-ai.providers.<id>` (and `llm-deepseek-api-key.apiKeyEnv` for DeepSeek). Precedence is **settings → this plugin's `config` (DeepSeek only) → built-in defaults**.

## Coverage

| Provider | Endpoint | Reading |
|---|---|---|
| DeepSeek | `GET /user/balance` | amount ¥ |
| StepFun | `GET /v1/accounts` | amount ¥ |
| Kimi Coding | `GET /v1/usages` | quota (hourly + weekly) |
| OpenRouter | `GET /api/v1/auth/key` | amount $ |
| MiniMax | `GET /v1/token_plan/remains` | remaining quota |
| xAI / Grok | `GET /v1/dashboard/billing/credit_grants` | amount $ |
| WorkBuddy / WorkBuddy AI | `dsh-workbuddy-connect`'s own status route | credits |
| Qoder / Qoder Global | `dsh-qoder-connect`'s own status route | credits |
| ChatGPT (Codex) | `dsh-plugin-subscriptions` RPC channel | subscription quota (5-hour + 7-day) |
| Claude | `dsh-plugin-subscriptions` RPC channel | subscription quota (5-hour + 7-day) |
| Grok (X Premium) | `dsh-plugin-subscriptions` RPC channel | subscription quota (2-hour rolling) |
| GitHub Copilot | `dsh-plugin-subscriptions` RPC channel | subscription quota (monthly premium requests) |
| Google Antigravity | `dsh-plugin-subscriptions` RPC channel | subscription quota (per-model allowances) |

**Providers with no API-level billing** — OpenAI and Anthropic in API key mode (admin-key usage/cost reports only), Together AI (usage), and Qwen, Xiaomi MiMo, Baichuan, Mistral, Groq, Cohere (console only) — show «not supported», with the console link when there is one.

### Subscription sources: delegated to dsh-plugin-subscriptions

Quotas for `codex`, `claude`, `grok`, `copilot`, and `antigravity` originate from browser-authenticated sessions or OAuth tokens managed by `dsh-plugin-subscriptions`.
- **Direct browser RPC**: The client queries `subscriptions-auth` directly for real-time limits and reset windows without host-side upstream requests or handling login credentials.
- **Collision avoidance**: The host route explicitly rejects bare API key queries for these provider ids (e.g. keeping Grok X Premium subscription distinct from xAI API credit), cleanly degrading to `未登录` (signed out) or `读取失败` when unauthenticated or uninstalled.

### Credit sources: re-read, not re-implemented

The `workbuddy` / `workbuddy-ai` and `qoder` / `qoder-global` routes have **no upstream billing endpoint this package could call with an API key**: their remaining credit belongs to a desktop sign-in or a Personal Access Token, which those plugins own. They already publish the figures on their own loopback status routes, so this package reads them there:

| provider | read from |
|---|---|
| `workbuddy` | `/plugins/dsh-workbuddy-connect/status` |
| `workbuddy-ai` | `/plugins/dsh-workbuddy-connect/ai/status` |
| `qoder` | `/plugins/dsh-qoder-connect/status` |
| `qoder-global` | `/plugins/dsh-qoder-connect/global/status` |

The answers are normalized into a `kind: "credits"` reading and handed to the browser half. **Nothing about those plugins is duplicated here**: when one is absent, disabled, signed out, or reporting a billing error, the readout degrades and says which of those it was.

**The two sources do not agree on what `total` means, and that is load-bearing.** WorkBuddy's `credits.total` is the headline *remaining* figure. Qoder's `credits.total` is the cycle's *consumption percentage* — the opposite. Each therefore has its own normalizer: WorkBuddy's total is taken as authoritative, while Qoder's remaining total is summed from its rows and its own percentage is carried separately as `usedPercent`, which the panel labels 本轮已用. Reading one as the other would print a number that looks like credit and means its inverse.

**The `unlimited` flag is not a credit fact, and this readout ignores it.** Both plugins set it to mark a *model* as free of charge — it spends no credit — which says nothing about how many credits the account holds. Qoder in particular sets it at the top level whenever one of its packages is an uncapped personal allowance, while the rest of the document still carries real figures. Rendering it here would answer a question this plugin does not ask and, worse, replace live numbers with 「不限额」. So the readout always shows the summed figures, and the flag never appears in the UI.

The read goes through this package's **same** per-provider cache, refresh floor and request coalescing as every other provider, so polling never hammers the other plugins' routes. The read address is only ever a loopback origin (`127.0.0.1` / `localhost` / `[::1]`) — the web server's listening port when that service is available, otherwise the `Host` the browser used; a non-loopback `Host` is never fetched. This package **mints, copies, and sends no credential**.

The card lists each package's `remain / size` with its own bar, merging identically-named grants and dropping exhausted ones, exactly as the owning plugins' own cards do. The refusals are named rather than shown as a generic failure:

| Situation | Pill / card | Panel |
|---|---|---|
| owning plugin absent or disabled | `未安装` | no credit source to read |
| desktop app signed out (or no PAT saved) | `未登录` | sign in once, or save the PAT |
| status route could not be read | `读取失败` | confirm dsh web runs and can reach its own port |
| owning plugin reported a billing error | `读取失败` | the error it reported |

## Units

Money and credits are different things, and this plugin never lets one stand in for the other. Every figure is written through a unit descriptor derived from the reading's own declared kind:

| reading | mark | word | example |
|---|---|---|---|
| `currency` CNY / USD / EUR | `¥` / `$` / `€` | 元 / 美元 / 欧元 | `¥4.19` |
| `currency`, unknown code | the code itself | the code itself | `XYZ4.19` |
| `currency`, no code at all | `¤` | 单位未知 | `¤4.19 单位未知` |
| `credits` | `🎫` | 积分 | `🎫1,261 积分` |
| `quota` | `#` | 额度 / 次 | `#87 / 100` |
| nothing read yet | `¤` | — | `读取中…` |

The `单位写法` setting chooses how loudly the unit is stated (`符号` / `名称` / `只显示数字`), but it never removes the distinction: credits keep saying 积分 under every setting, and an unidentified unit is always spelled out because it has no honest symbol to lean on. The heading word itself is the unit in the pill and card — `DeepSeek余额` versus `WorkBuddy积分` — so the measure is named even when the digit grouping style is `只显示数字`.

## Adding your own provider

Three integration paths, from least to most work. Pick the first one that fits.

### Path 1 — declarative, no code (recommended)

The plugin reads a user file at `$DSH_HOME/model-balance-providers.json` (`~/.dsh/model-balance-providers.json` by default; `DSH_MODEL_BALANCE_CONFIG` names a different file). Entries there merge over the bundled list, so this is also how you override a bundled **endpoint** for a *new* id.

1. Find the vendor's billing endpoint — one authenticated `GET` that answers with the remaining amount (or a quota window), called with `Authorization: Bearer <API key>`.
2. Add one entry to the file:

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

3. Save the key through the credentials seam (`MY_VENDOR_API_KEY` as an env var or in the dsh credentials store), restart dsh (the provider list is cached per process), and select a model on that provider route.
4. Verify: the sidebar card shows the vendor's name and figure. If it shows 「读取失败」, open the detail panel — the exact HTTP status or parse error is printed there.

**The `response` contract** (the only interface this path has):

| Field | Meaning |
|---|---|
| `type` | `currency` (a money amount) or `quota` (a request window) |
| `currency` | ISO code for `currency` type; decides `¥` / `$` / `€` |
| `balance` | where the amount lives — see the three forms below |
| `limit` / `used` / `remaining` | for `quota` type, all three must resolve to numbers |
| `resetTime` | optional dotted path to an ISO timestamp |
| `available` | optional dotted path to a boolean for `currency` type |

A value is named in one of three ways:

- **dotted path** — `"data.balance"` (numeric segments index arrays);
- **array lookup** — `{ "path": "balance_infos", "find": { "field": "currency", "equals": "CNY" }, "value": "total_balance" }`;
- **expression** — `{ "expr": "(data.limit - data.usage) / 100" }` — evaluated with `new Function`, so the config file is **trusted code**: keep it writable only by you.

> The provider id (`my-vendor` above) must be the **route id** the harness uses for that provider — the same id the model selection names. Aliases may be declared as `"aliases": ["other-name"]`. Keys starting with `_` are comments.

### Path 2 — credit owned by another dsh plugin

For an allowance that lives in another plugin's sign-in (the way WorkBuddy and Qoder work), there is no upstream billing endpoint to call. The host half reads the owning plugin's own loopback status route instead. This path is code today: add an entry to `CREDIT_SOURCES` in `lib/index.js` (the route path and its answer shape), a normalizer in `CREDIT_NORMALIZERS` if the shape is new, and the matching display rows in `SOURCE_PLUGIN` / `UNQUERYABLE_PILL` / `UNQUERYABLE_NOTE` in `lib/client.js`. The status route must answer a loopback `Host`, must treat a missing `Origin` header as allowed (the reader is a server-side fetch), and should degrade to a named reason (`signed-out`, `credits-error`, …) rather than a bare failure.

### Path 3 — a built-in strategy

For a vendor every user should get by default, add a parser to `STRATEGIES` in `lib/strategies.js` (endpoint base, credential reference, answer parser), an entry to the bundled `providers.json` as documentation, and test fixtures to `test/host.test.mjs`. Built-in entries win over declarative ones on a shared id, so a built-in strategy is also how a vendor's parsing is fixed upstream of any user config. A vendor with **no API-level billing** goes into `LOGIN_REQUIRED_BY_ID` / `LOGIN_REQUIRED_URLS` instead — the readout then names the console and links to it.

### What every path shares

- **Keys never leave the host.** The browser half receives numbers only; a credential reference is resolved per request through the credentials seam.
- **The readout dispatches on the reading's kind** — `currency`, `quota`, `credits`, `unqueryable` — never on the provider's name, so a new source needs no browser-half special case.
- **Every reading states its unit**, so a new `quota` source is never printed as money.
- **Cache, refresh floor and request coalescing are shared**, so a chatty new source cannot hammer its vendor.

## Publishing this repository

The package is installable straight from GitHub; nothing needs to be built or published to npm.

1. Create the GitHub repository `Utmotc/dsh-balance-card` and push:

   ```bash
   git init && git add . && git commit -m "dsh-balance-card 1.4.0"
   git branch -M main
   git remote add origin https://github.com/Utmotc/dsh-balance-card.git
   git push -u origin main
   ```

2. Tag each release — pinned tags are the reproducible install form:

   ```bash
   git tag v1.2.4 && git push origin v1.2.4
   ```

3. Add the topic (repository settings → About ⚙ → Topics, or):

   ```bash
   gh repo edit Utmotc/dsh-balance-card --add-topic dsh-plugin --add-topic deepseek-harness
   ```

4. Users install from the plugin page with:

   ```
   https://github.com/Utmotc/dsh-balance-card/archive/refs/heads/main.tar.gz
   ```

Updating `package.json`'s `version` on every push keeps the plugin page's upgrade notice honest, since pnpm caches by spec string.

## Configuration

The row's `config` accepts (all optional — anything unusable falls back to its default):

| Key | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | credential reference for DeepSeek |
| `baseURL` | `$DEEPSEEK_BASE_URL`, then the official API | DeepSeek endpoint base |
| `timeoutMs` | `15000` | per-request timeout against the provider |
| `minIntervalMs` | `2000` | floor between two upstream reads of one provider |
| `okTtlMs` | `60000` | how long a good reading is served without asking again |
| `errorTtlMs` | `15000` | how long a failed reading is reused |
| `defaultProvider` | `deepseek` | answered when a request names no provider |

There is deliberately **no config schema export**: a schema would mean importing schemastery, and every value above already has a safe default — a typo costs a default, not an activation.

### User settings (`余额监测` tab)

Reachable from the settings page — no profile patch and no restart. The document lives in this plugin's own file (`$DSH_HOME/dsh-balance-card/balance-settings.json`, or the row's `settingsFile`), because a write through the loader row would reconcile the whole plugin tree and hot-reload the fiber (~1–1.5 s plus a client mirror storm) for every toggled switch.

| Field | Default | Values |
|---|---|---|
| `placement` | `sidebar` | `sidebar` (card beside Settings) · `composer` (the original pill under the input) · `both` · `none` (hide the readout; the plugin keeps its settings and routes) |
| `pollMs` | `60000` | 15000 – 3600000 |
| `warnPercent` | `20` | 0 – 100; below this the bar and percentage turn red |
| `showUpdatedAt` | `true` | show the last-updated stamp |
| `unitStyle` | `symbol` | `symbol` (¥100 / 🎫100) · `name` (100 元 / 100 积分) · `none` |
| `groupDigits` | `true` | thousands separators (`1,261`) |
| `cardBorder` | `true` | draw the sidebar card's hairline stroke |

A `null` value resets one field to its default. Validation is closed: an unknown field name, an out-of-range number or an unlisted enum is refused with HTTP 400 and nothing is written — and the file is re-validated on read, so a hand-edited bad value costs only that one setting.

## How it is built

Two halves in one package:

| Half | Role |
|---|---|
| host (`lib/index.js`) | provider strategies, credit-source readers, credential resolution, cache, settings file, two authenticated routes |
| browser (`lib/client.js`) | which provider to show, the sidebar card, the composer pill, the detail panel, the settings tab |

Readings come in four kinds, and the browser half dispatches on the kind rather than on the provider's name: `currency` (money), `quota` (request windows), `credits` (workbuddy / qoder), and `unqueryable` (with a reason to name). Adding a source means teaching the host half one endpoint, not the browser half a special case.

- The sidebar card registers into `sidebar.footer.action`, the slot the shell renders above the Settings seat; in the 56px rail it collapses to a single icon cell carrying the ring. It carries a themed hairline stroke (`--dsw-alias-border-l2`, which is the harness's own light-gray border and follows the theme), switchable from the settings tab; the switch clears only the border *colour*, so toggling it cannot resize the card by two pixels.
- Clicking the card opens the detail panel **anchored to it**, in the shipped dialog's own style — it does not navigate: no layout panel is selected and the conversation stays mounted.
- Placement is a setting, so the original composer pill (portaled into `[data-composer-stats]`, or its own row under the composer on the new-session surface) remains available on its own or alongside the card. A surface that is not selected does not poll at all, and `none` leaves no empty placeholder box behind — an unused container under the composer would still add that stack's flex gap.
- Percentages and progress bars are computed from the rows, never from a source's headline scalar, so the two credit sources' opposite `total` meanings cannot leak into a bar.
- Marks are drawn as **text** (`¥` / `$` / `€` / `🎫` / `#` / `¤`), not library icons: dsh 0.1.7 renamed the primitives icon exports (`IconRefreshOutline16` → `IconRefreshOutlineRegular`), and reaching for an old name silently yields nothing. The refresh button uses the current export name and still falls back to text if a future dsh renames it again.

### Compatibility notes

Verified against **dsh 0.1.7-rc.2**:

- Routes are registered through `connection.fetch.register` (the authenticated `/api` channel) — the same seam the shipped controllers use; both paths are this package's own, so a duplicate-path clash can only come from another copy of this plugin.
- The browser half requires only platform seed modules (`react`, `react-dom`, `@deepseek-ai/dsh-client-ui-primitives`) and declares an **empty** `dsh.client.inject`, so it adds no dependency edges into the client module graph — a missing or renamed client package cannot fail this bundle's arrival, and this bundle cannot cascade into another plugin's.
- The sidebar card and the composer pill are additive slot entries (`list` slots with fresh ids), so they coexist with `dsh-qoder-connect`'s footer card and the shipped statistics row. One global rule is shared on purpose: the foot container is forced to a column, which is idempotent with Qoder's identical rule and is what lets a full-width card sit beside the Settings seat.
- Credential references (`DEEPSEEK_API_KEY`, `KIMI_API_KEY`, …) are resolved through the credentials seam — env var or stored credential, never a file this plugin writes.

### Boot safety

The dsh web shell aborts the whole boot when any client entry fails to activate (`web boot: N entries did not activate`). A decorative plugin must therefore never hard-depend on anything renameable:

- the browser half exports `inject = []` and reaches even the slot registry through `ctx.inject`, which waits on a **child** fiber;
- the host half exports `inject = []` too, and registers its routes from a child fiber that waits for `credentials` and `connection`;
- `settings` is read with `ctx.get`, so a dsh that drops it costs a custom base URL, not a startup;
- the sidebar slot is reached through `ctx.inject`, so a dsh whose layout never declares `sidebar.footer.action` costs the card and nothing else;
- a credit source's owning plugin being absent is a `未安装` readout, never a failure.

It also imports **nothing from dsh** — only Node builtins and its own modules — so it resolves under a strict package layout as well as a hoisted one.

## Development

No build step: `lib/client.js` is the shipped browser bundle, and `lib/index.js` is plain ESM.

```bash
node test/host.test.mjs       # route contract, provider resolution, credit sources, settings, cache
node test/client.test.cjs     # boot safety, units, pill, sidebar card, settings tab, panels
node test/live-workbuddy.mjs  # end-to-end against a RUNNING dsh web (reads real credit routes)
```

The first two load the real files and stub the dsh context, so they run with no dsh process, no network and no keys. The third is optional and needs a live server: pass its port as the first argument (default 3080). It is read-only for the credit routes and writes settings only to a temporary file.

## Credits

The provider strategies in `lib/strategies.js`, the declarative parser in `lib/parsers.js` and `providers.json` are adapted from **[dsh-model-balance](https://www.npmjs.com/package/dsh-model-balance)** v0.1.4 (`src/host/strategies.ts`, `src/host/custom-providers.ts`), MIT licensed, copyright its contributors — see `LICENSE-dsh-model-balance`. Changes: merged into this package's module layout, the bundled `providers.json` path made relative to `lib/`, the log prefix renamed, and the export surface reduced to `matchStrategy` / `matchLoginRequired` / `loadCustomProviders`.

## License

MIT — see `LICENSE`.
