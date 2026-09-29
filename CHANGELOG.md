# Changelog

## 1.4.0

- **Rename: the package is now `@utmotc/dsh-balance-card`** (previously
  `@utmotc/dshbalance`). The GitHub repository is also renamed to
  `Utmotc/dsh-balance-card`. The internal dsh loader id (`balance-monitor`)
  is unchanged, so an existing install's loader row keeps working. User
  settings now live under `$DSH_HOME/dsh-balance-card/` instead of
  `dsh-plugin-balance/`.

## 1.3.1

- **Fix: clean subscription progress bar and percentage layout.**
  Removed the redundant middle "剩余 xx%" text on collapsed subscription cards,
  aligning progress percentages cleanly in the right column to match the credit bars'
  layout and avoid cluttered text.
- **Refinement: Antigravity shared-pool folding on collapsed sidebar card.**
  When Google Antigravity reports multiple `gemini-*` model windows, their quotas
  belong to the same shared pool and move together. The collapsed sidebar card now
  cleanly folds them into a single `gemini 系列` bar showing the tightest remaining
  share and earliest reset time, preventing repetitive entries from overflowing
  the card. The full list of individual models and lanes remains accessible in
  the detail panel.
- **Release: officially published to npm as `@utmotc/dshbalance`.**

## 1.3.0

- **Feature: full support for `dsh-plugin-subscriptions` monitoring.**
  When using models from **ChatGPT (Codex)**, **Claude**, **Grok (X Premium)**,
  **GitHub Copilot**, or **Google Antigravity**, the plugin now seamlessly renders
  their active subscription quotas, per-model allowance bars, reset countdowns,
  and account details directly in the sidebar card and detail panel.
- **Architecture: browser-side subscription delegation.**
  Subscription routes (`codex`, `claude`, `grok`, `copilot`, `antigravity`) are answered
  directly through `dsh-plugin-subscriptions`'s client RPC channel (`subscriptions-auth`),
  accurately reflecting web session quotas and OAuth-backed allowances without duplicating
  login states or fabricating host API requests.
- **Refinement: alias resolution and safe degradation.**
  The host route rejects bare API key queries for subscription-handled provider ids
  to avoid ambiguity (e.g. clearly distinguishing between an xAI API token and a Grok
  X Premium subscription). Refusals degrade cleanly to `未登录` / `读取失败` states
  when the subscription plugin is unauthenticated or not installed.

## 1.2.4

- **Fixed: settings overrides never took effect.** The host half read the
  settings service through `settings.get(namespace)`, which does not exist on
  dsh 0.1.7's settings service (`describe()` is the real face) — the call threw,
  the catch swallowed it, and a base URL or credential reference named in the
  settings UI was silently ignored. The section is now read from
  `describe()`'s `{ ns, value }` rows, per request.
- **Fixed: the DeepSeek key fallback read the wrong namespace.** `apiKeyEnv`
  lives in the `llm-deepseek-api-key` entry (`llm-deepseek`'s schema has no such
  field).
- **Fixed: `$DSH_HOME` was ignored for the user provider file.**
  `~/.dsh/model-balance-providers.json` is still the default, but a
  non-default `$DSH_HOME` is now honoured the way dsh itself resolves it
  (blank counts as unset), instead of always falling back to the literal home
  directory.
- **Fixed: the refresh button's icon never rendered.** The code reached for
  `IconRefreshOutline16`, a name dsh 0.1.7 renamed to
  `IconRefreshOutlineRegular`; the guarded fallback meant every panel showed
  the `↻` text mark. (No behaviour change beyond the icon.)
- **Hardened: no client dependency edges.** `dsh.client.inject` is now empty —
  the browser half needs only platform seed modules, so it no longer declares
  graph edges that could cascade another package's failure into this bundle.

## 1.2.3

- **Fixed: Qoder showed 「不限额」 instead of its credits.** The source's
  `unlimited` flag marks a *model* as free of charge (it spends no credit) — it is
  not a statement about the account's credit. Qoder sets it at the top level
  whenever one of its packages is an uncapped personal allowance, and the readout
  was treating that as "the whole account is limitless", which replaced real
  figures with 「不限额」 and forced the ring to a full circle.
  The flag is now ignored entirely: the card, the pill and the panel always show
  the summed figures (`🎫100`, `🎫100 / 100`, 剩余占比 100.0%), and the flag never
  appears in the UI. WorkBuddy was unaffected because it does not set it.
  Exhausted rows are dropped on their own merits (`remain > 0`) rather than by
  consulting the flag, so a spent grant still disappears from the card.

## 1.2.2

- **`显示描边` switch.** The sidebar card's hairline stroke can now be turned off
  from the settings tab. The switch adds a class that clears only the border
  *colour* (`border-color: transparent`) rather than dropping the border, so the
  card keeps its 1px box and toggling it cannot shift the contents by two pixels.
  The rail button has no stroke either way and is unaffected.

## 1.2.1

- **`都不显示` placement.** The `显示位置` setting gains a fourth value, `none`,
  so the readout can be hidden without disabling the plugin or losing its
  settings. It renders neither surface and, importantly, leaves no empty
  placeholder box behind: an unused container under the composer would still add
  that stack's flex gap. Placement checks are now allow-lists, so a value this
  build does not recognise hides the readout rather than falling through to
  showing it.
- **A light-gray stroke on the sidebar card**, using `--dsw-alias-border-l2` —
  the harness's own hairline border token, so it follows the light/dark theme
  instead of being a hard-coded grey.

## 1.2.0

A sidebar card, a settings tab, strict unit handling, and Qoder credit support.

### Added

- **Sidebar footer card.** The balance now also lives beside the Settings seat, with
  the same look as `dsh-qoder-connect`'s own quota card: a ring whose sweep is the
  remaining share, the vendor name, the headline figure, one progress bar with its
  percentage per package, and the last-updated time. In the 56px rail it collapses
  to a single icon cell carrying the ring.
- **Click opens the panel in place.** The card is itself the button and expands the
  same anchored detail panel the pill uses — nothing navigates, so the conversation
  stays mounted.
- **A `余额监测` settings tab** on the settings page, with no profile patch and no
  restart: placement (sidebar / composer / both), poll interval, warning threshold,
  unit style, updated-time and digit grouping. The document is this plugin's own
  file (`$DSH_HOME/dsh-balance-card/balance-settings.json`), so a write is a local
  atomic file write rather than a loader reconcile and fiber hot-reload.
- **Qoder credit support.** `qoder` and `qoder-global` are answered by re-reading
  `dsh-qoder-connect`'s own status routes, the same way WorkBuddy already was.
- **Explicit units on every reading.** The host names each reading's unit
  (`currency` / `requests` / `credits`) instead of leaving the browser to infer it.
- Percentages with progress bars, the vendor name, and the updated time are present
  on both surfaces.

### Fixed

- **Units can no longer be conflated.** Qoder's `credits.total` is the cycle's
  *consumption percentage*, the opposite of WorkBuddy's *remaining* `total`; taking
  one for the other would print a number that looks like credit and means its
  inverse. Each source now has its own normalizer, Qoder's remaining total is summed
  from its rows, and its own percentage is carried separately and labelled 本轮已用.
- **An unknown unit no longer borrows the yuan sign.** A currency reading with no
  code showed `¥`, and so did a request quota. Money now names its currency, a quota
  uses `#`, and an unidentified unit shows `¤` with 单位未知 — so 1,000 credits can
  never be read as ¥1,000.
- Exhausted *and* zero-size packages are dropped from the card, matching the owning
  plugins; previously a zero-size row printed a meaningless `0` block.
- Identically-named grants merge into one block, so a user holding several of the
  same package no longer reads the same name down the card.
- The sidebar card and the composer pill are alternatives: the seat that is not
  selected polls nothing, where two independent switches could have polled one
  provider twice.

### Changed

- The composer pill is now opt-in (the default placement is the sidebar card). Set
  `placement` to `composer` or `both` to keep it.
- Refusal wording is per-source: the panel names the plugin that owns the reading
  (`dsh-workbuddy-connect` / `dsh-qoder-connect`) rather than assuming WorkBuddy.

## 1.1.0

WorkBuddy credit support: switching to the `workbuddy` / `workbuddy-ai` model
group now shows the remaining credit that `dsh-workbuddy-connect` reports.

- The host half answers `provider=workbuddy` and `provider=workbuddy-ai` by
  reading that plugin's own loopback status route (`/plugins/dsh-workbuddy-connect/status`
  and `.../ai/status`) instead of an upstream billing endpoint, and normalizes it
  into a new `kind: "credits"` reading. Nothing about WorkBuddy is duplicated:
  the desktop sign-in that owns the number stays owned by that plugin.
- The browser half renders credits as credits — a 🎫 mark, `WorkBuddy积分 1261`,
  and a panel listing each package's `remain / size` (exhausted packages dropped
  exactly as the owning plugin's own card does) plus the cycle reset time.
- Every degradation is named rather than shown as a generic failure:
  `未安装` (the owning plugin is absent or disabled), `未登录` (the desktop app is
  signed out), `读取失败` (the status route could not be read, or the owning
  plugin reported a billing error). Each opens onto its own explanation.
- The reading goes through the same per-provider cache, refresh floor and
  coalescing as every other provider, so polling does not hammer the other
  plugin's route.
- The WorkBuddy status read is only ever addressed to a loopback origin, and the
  number is read from the plugin that owns the sign-in; no key or token is
  minted, copied, or sent anywhere by this package.

### Test fixes (pre-existing, unrelated to the feature)

- `test/host.test.mjs` and `test/client.test.cjs` carried three GBK-mojibake
  string literals (`拒绝`, `不是 JSON`, and one unreadable message) that aborted
  the suites before they ran; they are restored.
- `test/client.test.cjs` used `path` without requiring it, so it could not start.

## 1.0.0

First public release.

- One balance pill on the composer's statistics line, for the provider behind the model the current conversation uses; a new session falls back to the model catalog's default provider.
- Six providers read from their official billing endpoints: DeepSeek, StepFun, Kimi Coding, OpenRouter, MiniMax, xAI/Grok — plus any provider declared in `providers.json`.
- Click the pill for a detail panel in the shipped dialog's style (amount breakdown, or each quota window with its reset time).
- Host half serves `GET /api/dsh.balance?provider=<id>` on Connection's authenticated channel; keys never reach the browser.
- Boot-safe on both halves: `inject` is empty, dependencies are waited for on child fibers, and nothing from dsh is imported, so a renamed or missing service costs a readout rather than a startup.
