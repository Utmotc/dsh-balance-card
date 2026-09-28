/**
 * dsh-plugin-balance — browser half.
 *
 * One always-mounted seat in `shell.overlay` (the frame-wide layer) that:
 *   1. learns which provider the conversation is currently using, from the
 *      session's own model directory — the same shared state the composer's
 *      model seat writes — falling back to the model catalog's default when no
 *      conversation is open yet,
 *   2. reads that provider's balance from this package's own host route
 *      (`GET /api/dsh.balance?provider=<id>`, behind Connection's auth fence),
 *      and from the standalone `dsh-model-balance` data plane only when the host
 *      half is older than this bundle — the version skew a client hot-reload
 *      creates before the next restart,
 *   3. portals its single pill into the shipped statistics row when that row
 *      exists, so the balance shares that centered line, and
 *   4. falls back to its own row under the composer card when no statistics row
 *      is rendered — the blank/new-session surface.
 *
 * ## Boot safety (why the inject list is empty)
 *
 * A client entry whose fiber never becomes active makes the web shell abort the
 * whole boot (`web boot: N entries did not activate`), so a decorative plugin
 * must never hard-depend on anything that can be renamed or removed. This
 * bundle therefore requires no service at all: it reaches even the slot registry
 * through `ctx.inject` inside `apply`, which starts a child fiber instead of
 * holding its own entry back. A missing capability degrades a readout; it never
 * blocks activation.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { createPortal } = require("react-dom");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** This plugin's own host route: every provider, behind Connection's auth fence. */
		const ROUTE_PATH = "/api/dsh.balance";
		/** Authenticated host route carrying this plugin's settings document. */
		const SETTINGS_ROUTE = "/api/dsh.balance.settings";
		/** The standalone data plane, kept only for host/client version skew. */
		const SKEW_PATH = "/model-balance/query";
		/** Session-scoped slot whose injection face names the mounted conversation. */
		const SESSION_SLOT = "conversation.input.right";
		/** Slot this plugin renders its pill through. */
		const OVERLAY_SLOT = "shell.overlay";
		/** The sidebar's bottom action area, where the footer card lives. */
		const SIDEBAR_SLOT = "sidebar.footer.action";
		/** The settings page's navigable sections; one entry becomes one tab. */
		const SETTINGS_SECTION_SLOT = "settings.section";
		/** Settings-tab copy, registered as one locale namespace. */
		const SETTINGS_NS = "settings.dsh-plugin-balance";
		/** Display names for routes the model catalog does not name. */
		const PROVIDER_ALIASES = {
			"deepseek-account": "DeepSeek",
			"deepseek-official": "DeepSeek",
			deepseek: "DeepSeek",
		};
		/** Steady-state poll gap; the panel's refresh action and a tab return read sooner. */
		const POLL_MS = 30000;
		/** Shipped dialog geometry, copied from the statistics pills. */
		const PANEL_GAP = 8;
		const PANEL_MARGIN = 12;
		const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };
		/** Style-tag identity, so plugin teardown can inventory and drop this sheet. */
		const STYLE_ID = "dsh-plugin-balance/BalancePill.css";
		/**
		 * The pill's icon slot draws a currency mark instead of a library icon.
		 *
		 * 0.1.7 dropped the icon exports from the primitives package (its module list
		 * is DOM primitives only), so `IconApiOutline14` is gone; a text mark both
		 * survives that and carries the currency the number no longer repeats.
		 */
		/**
		 * The mark drawn while no reading has arrived yet.
		 *
		 * `¤` is the generic currency sign, not `¥`: at this point the plugin does
		 * not yet know whether the number will be money or a credit count, and a
		 * yuan sign would assert a unit it has not read.
		 */
		const DEFAULT_GLYPH = "¤";
		/** Pill wording for each reason a provider answered `queryable: false`. */
		const UNQUERYABLE_PILL = {
			"login-required": "需登录",
			"source-missing": "未安装",
			"signed-out": "未登录",
			"source-unreachable": "读取失败",
			"credits-error": "读取失败",
			"no-credits": "无数据",
		};
		/** Panel wording for the same reasons, including the generic fallback. */
		const UNQUERYABLE_REASON = {
			"login-required": "需登录网页查看",
			"source-missing": "未安装对应的连接插件",
			"signed-out": "对应的桌面 App / 账号未登录",
			"source-unreachable": "读不到本机状态接口",
			"credits-error": "额度接口返回失败",
			"no-credits": "状态里没有额度字段",
		};
		/**
		 * The panel's closing note for the reasons that need one.
		 *
		 * The generic fallback covers vendors with no API-level balance endpoint;
		 * a credit source's failures are not that, so each names its own cause and
		 * fix. `{source}` is filled with the plugin that owns the reading.
		 */
		const UNQUERYABLE_NOTE = {
			"source-missing": "未安装 {source} 插件（或它已被禁用），没有可读取的额度来源。",
			"signed-out": "在对应的桌面 App 里登录一次（或保存该产品的 PAT），读数会自动跟随当前账号。",
			"source-unreachable":
				"本机状态接口不可达。请确认 dsh web 正在运行，且它能访问自己的监听端口。",
			"credits-error": "{source} 的额度接口返回了失败，详情见上方。",
			"no-credits": "{source} 的状态文档里没有额度字段，可能是插件版本不支持。",
		};
		/**
		 * The plugin that owns a locally-read provider's allowance.
		 *
		 * Only used to word a degradation; the host half decides what is actually
		 * read, so this table never affects a number.
		 */
		const SOURCE_PLUGIN = {
			workbuddy: "dsh-workbuddy-connect",
			"workbuddy-ai": "dsh-workbuddy-connect",
			qoder: "dsh-qoder-connect",
			"qoder-global": "dsh-qoder-connect",
		};
		/** Panel placement and dismissal come from the same primitives the stats pills use. */
		const useAnchoredPosition =
			typeof primitives.useAnchoredPosition === "function"
				? primitives.useAnchoredPosition
				: useFallbackPosition;
		const useDismissOnOutsidePointer =
			typeof primitives.useDismissOnOutsidePointer === "function"
				? primitives.useDismissOnOutsidePointer
				: useFallbackDismiss;

		/**
		 * A minimal snapshot store, so seats can hand values to each other without
		 * depending on where the client store package lives in this DSH version.
		 * @param {*} initial - initial value.
		 * @returns a `{ getSnapshot, subscribe, set }` store.
		 */
		function createSlot(initial) {
			const listeners = new Set();
			let value = initial;
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (next) => {
					if (Object.is(next, value)) return;
					value = next;
					for (const listener of [...listeners]) listener();
				},
			};
		}

		/**
		 * The plugin's settings, read once from the host and shared by every seat.
		 *
		 * A minimal observable store rather than a React context: the settings tab,
		 * the sidebar card and the composer pill are three separate slot
		 * registrations with no common ancestor to hang a provider on, and
		 * `useSyncExternalStore` reads this directly.
		 */
		function createSettingsStore() {
			/** Defaults mirrored from the host, used until (or unless) it answers. */
			const FALLBACK = {
				placement: "sidebar",
				pollMs: 60000,
				warnPercent: 20,
				showUpdatedAt: true,
				unitStyle: "symbol",
				groupDigits: true,
				cardBorder: true,
			};
			const listeners = new Set();
			let snapshot = { status: "loading", value: FALLBACK, defaults: FALLBACK };
			const publish = (next) => {
				// getSnapshot must return the same reference between changes, or
				// useSyncExternalStore re-renders forever (React error #185).
				snapshot = next;
				for (const listener of [...listeners]) listener();
			};
			const adopt = (body) => {
				if (body?.ok !== true || body.value === null || typeof body.value !== "object") return false;
				publish({
					status: "ready",
					value: { ...FALLBACK, ...body.value },
					defaults: { ...FALLBACK, ...(body.defaults ?? {}) },
				});
				return true;
			};
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				/** Read the host document. Repeated calls are harmless. */
				load: async () => {
					try {
						const response = await fetch(SETTINGS_ROUTE, {
							headers: { accept: "application/json" },
							cache: "no-store",
						});
						adopt(await response.json().catch(() => null));
					} catch {
						// A host half that is older than this bundle has no settings route.
						// The defaults above are already in place, so the readout still works.
						publish({ status: "unavailable", value: snapshot.value, defaults: snapshot.defaults });
					}
				},
				/**
				 * Write one field, adopting the host's answer.
				 * @param {object} patch - field → value.
				 * @returns whether the host accepted the write.
				 */
				patch: async (patch) => {
					try {
						const response = await fetch(SETTINGS_ROUTE, {
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json" },
							body: JSON.stringify(patch),
						});
						const body = await response.json().catch(() => null);
						if (!response.ok || body?.ok !== true) return false;
						return adopt(body);
					} catch {
						return false;
					}
				},
			};
		}

		/**
		 * Fallback placement used only when the primitives export is unavailable:
		 * pin the panel above the anchor, left-aligned to it.
		 * @param {object} options - open, anchorRef, panelRef, side, gap, margin.
		 * @returns the style or undefined while measuring.
		 */
		function useFallbackPosition(options) {
			const [pos, setPos] = React.useState(undefined);
			React.useEffect(() => {
				if (!options.open) {
					setPos(undefined);
					return;
				}
				const rect = options.anchorRef.current?.getBoundingClientRect();
				if (rect === undefined) return;
				setPos({
					position: "fixed",
					left: Math.max(options.margin, rect.left),
					top: rect.top - options.gap,
					transform: "translateY(-100%)",
				});
			}, [options.open]);
			return pos;
		}

		/**
		 * Fallback outside-pointer dismissal used only when the primitives export is unavailable.
		 * @param {object} rootRef - anchor element ref.
		 * @param {boolean} open - whether the panel is open.
		 * @param {Function} setOpen - open-state setter.
		 * @param {object} panelRef - panel element ref.
		 */
		function useFallbackDismiss(rootRef, open, setOpen, panelRef) {
			React.useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current?.contains(target) === true) return;
					if (panelRef.current?.contains(target) === true) return;
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
				};
			}, [open, setOpen]);
		}

		/** Pill, row and panel styling; the declarations mirror the shipped statistics strip. */
		const CSS = [
			// The fallback row reproduces the shipped strip's own root box exactly.
			".dshBal_row{max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;margin:0 auto;display:flex;flex-wrap:wrap}",
			".dshBal_anchor{min-width:0;display:inline-flex}",
			".dshBal_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}",
			".dshBal_pill svg{flex:none;width:14px;height:14px}",
			".dshBal_pill:hover,.dshBal_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dshBal_label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
			// The currency mark stands in for the shipped pills' 14px svg icon.
			".dshBal_glyph{flex:none;min-width:14px;font-size:13px;font-weight:600;line-height:14px;text-align:center;font-variant-numeric:tabular-nums}",
			".dshBal_pulse{animation:dshBal_fade 1.1s ease-in-out infinite}",
			".dshBal_stale{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}",
			".dshBal_bad{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-tertiary))}",
			".dshBal_muted{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}",
			"@keyframes dshBal_fade{0%,100%{opacity:1}50%{opacity:.4}}",
			// The panel mirrors the shipped stat dialog. Its surface token is a
			// translucent menu fill (`#f8f9fa94`), which the shipped dialog pairs with
			// a backdrop blur; this plugin additionally composites onto an opaque
			// surface so the panel can never read as see-through on its own.
			".dshBal_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,var(--dsw-static-neutral-bluish-00,#fff)));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}",
			".dshBal_title{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
			".dshBal_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
			".dshBal_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}",
			".dshBal_titleLabel svg{flex:none;width:14px;height:14px}",
			".dshBal_titleActions{flex:none;align-items:center;gap:4px;display:inline-flex}",
			".dshBal_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
			".dshBal_details dt,.dshBal_details dd{min-width:0;margin:0}",
			".dshBal_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
			".dshBal_route{overflow-wrap:anywhere}",
			".dshBal_note{color:var(--dsw-alias-label-tertiary);margin-top:10px}",
			".dshBal_failure{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));margin-bottom:8px}",
			".dshBal_action{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;font:inherit;padding:0;text-decoration:underline;text-underline-offset:2px}",
			".dshBal_action:hover{color:var(--dsw-alias-label-primary)}",
			".dshBal_icon{flex:none;width:20px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;padding:0;place-items:center;display:grid}",
			".dshBal_icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dshBal_icon svg{width:14px;height:14px}",
			// ── Sidebar footer card ────────────────────────────────────────────────
			// Same look as dsh-qoder-connect's footer card (a bar-and-percentage block
			// beside the Settings seat), under this plugin's own prefix: both plugins
			// inject GLOBAL CSS into one document, so the class sets must not collide.
			//
			// The shell's foot container is a flex ROW whose occupants each declare a
			// full-width line, so as a row it overflows the column. Forcing it to a
			// column is load-bearing; the rule is anchored to `_footArea` because
			// `footerActions` is also used by the ask-user-question dialog, and an
			// unanchored rule would stack that dialog's buttons too. It is idempotent
			// when the Qoder card ships the same rule.
			"[class*='_footArea'] [class*='_footerActions']{flex-direction:column}",
			".dshBal_card{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}",
			".dshBal_card:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}",
			".dshBal_card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			// The stroke switch. The colour is set to `transparent` rather than the
			// `border` shorthand being dropped, so the card keeps its 1px box and
			// turning the switch off cannot resize it by two pixels. This selector is
			// one class heavier than `.dshBal_card`, so it wins on specificity and
			// order cannot decide it.
			".dshBal_card.dshBal_noBorder{border-color:transparent}",
			".dshBal_card.dshBal_noBorder:hover{border-color:transparent}",
			".dshBal_cardTop{align-items:center;gap:8px;min-width:0;display:flex}",
			".dshBal_cardName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}",
			".dshBal_cardTotal{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dshBal_cardSpacer{flex:1}",
			".dshBal_updated{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap}",
			// One block per package group: its own figures on a head line, then the
			// FULL-WIDTH bar under it, so the numbers are never squeezed by the bar.
			".dshBal_row2{flex-direction:column;gap:4px;min-width:0;display:flex}",
			".dshBal_rowHead{align-items:baseline;gap:8px;min-width:0;display:flex}",
			".dshBal_rowLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dshBal_rowAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dshBal_rowPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			// The card's markup stays PHRASING content (it renders inside the shell's
			// own button), so these bars are spans: display:block is load-bearing on
			// both, or an inline box ignores width/height and the fill collapses.
			".dshBal_bar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}",
			".dshBal_fill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}",
			".dshBal_fillWarn{background:var(--dsw-alias-state-error-primary)}",
			// The 56px rail: one icon cell on the shell's own rail geometry.
			".dshBal_railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}",
			".dshBal_railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".dshBal_railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".dshBal_ring{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}",
			".dshBal_ringWarn{color:var(--dsw-alias-state-error-primary)}",
			".dshBal_cardNotice{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dshBal_cardNoticeBad{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-tertiary))}",
			"@media (prefers-reduced-motion:reduce){.dshBal_fill{transition:none}}",
			// ── Settings tab ───────────────────────────────────────────────────────
			".dshBal_setting{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:flex-start;gap:16px;padding:10px 0;display:flex}",
			".dshBal_setting:last-child{border-bottom:none}",
			".dshBal_settingText{flex-direction:column;gap:2px;min-width:0;display:flex}",
			".dshBal_settingLabel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dshBal_settingHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshBal_settingControl{flex:none;align-items:center;gap:6px;display:inline-flex}",
			".dshBal_input{box-sizing:border-box;width:72px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;font:inherit;font-size:13px;line-height:20px}",
			".dshBal_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".dshBal_select{box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;font:inherit;font-size:13px;line-height:20px}",
			".dshBal_switch{box-sizing:border-box;width:34px;height:20px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;flex:none;align-items:center;padding:2px;transition:background .15s ease;display:inline-flex}",
			".dshBal_switchOn{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
			".dshBal_knob{width:14px;height:14px;background:var(--dsw-alias-bg-base,#fff);border-radius:50%;transition:transform .15s ease}",
			".dshBal_switchOn .dshBal_knob{transform:translateX(14px)}",
			".dshBal_settingsNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshBal_settingsError{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px}",
			".dshBal_preview{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px;margin-top:10px;flex-direction:column;gap:8px;display:flex;max-width:320px}",
		].join("");
		if (
			typeof document !== "undefined" &&
			document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-balance";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Localized window names for provider quota dimensions. */
		const WINDOW_LABEL = { hourly: "5 小时", daily: "每日", weekly: "7 天", monthly: "每月" };

		/**
		 * Describe the unit one reading's figures are denominated in.
		 *
		 * This is the one place units are decided, and it decides them from the
		 * reading's own declared kind — never from the provider's name or from the
		 * magnitude of the number. That distinction is the whole point: money and
		 * credits are not interchangeable, and printing 1000 credits as `¥1000`
		 * would misstate the user's balance by whatever the conversion happens to
		 * be. A reading this function cannot classify is reported as unknown
		 * (`kind: "none"`) rather than defaulted to currency.
		 * @param {object|null} value - normalized reading, or null while loading.
		 * @returns `{ kind, symbol, name, suffix }` for that reading.
		 */
		function unitOf(value) {
			if (value !== null && value.kind === "credits") {
				return { kind: "credits", symbol: "🎫", name: "积分", suffix: "积分" };
			}
			if (value !== null && value.kind === "quota") {
				// A request count is not money. `#` is the conventional count mark;
				// anything currency-shaped here would misstate the figure.
				return { kind: "quota", symbol: "#", name: "额度", suffix: "次" };
			}
			const currency = value !== null && value.kind === "currency" ? value.currency : "";
			if (currency === "CNY") return { kind: "currency", symbol: "¥", name: "元", suffix: "元" };
			if (currency === "USD") return { kind: "currency", symbol: "$", name: "美元", suffix: "美元" };
			if (currency === "EUR") return { kind: "currency", symbol: "€", name: "欧元", suffix: "欧元" };
			if (typeof currency === "string" && currency !== "") {
				// A currency this plugin has no sign for still names itself, so the
				// code is the honest mark rather than a borrowed ¥.
				return { kind: "currency", symbol: currency, name: currency, suffix: currency };
			}
			// A currency reading with no code is still money, but its unit is
			// unknown, so it must not borrow a symbol it cannot justify. `¤` is the
			// standard generic currency sign, which says exactly that.
			return { kind: "none", symbol: "¤", name: "单位未知", suffix: "" };
		}

		/**
		 * Write one figure with its unit, per the user's unit setting.
		 *
		 * The three styles differ only in how loudly the unit is stated; none of
		 * them ever drops the distinction between money and credits, because the
		 * `name`/`symbol` come from `unitOf` and not from the layout.
		 * @param {object} unit - a `unitOf` descriptor.
		 * @param {number|string|null} amount - the figure.
		 * @param {string} style - `symbol`, `name`, or `none`.
		 * @param {boolean} group - whether to group thousands.
		 * @returns display text.
		 */
		function figure(unit, amount, style, group) {
			if (amount === null || amount === undefined || amount === "") return "—";
			const text =
				typeof amount === "number" && group
					? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount)
					: String(amount);
			if (style === "none") return text;
			if (style === "name") return unit.name === "" ? text : text + " " + unit.name;
			// `symbol` is the default: a mark in front, falling back to the name when
			// this reading has no symbol (an unknown currency, a quota count).
			if (unit.symbol !== "") return unit.symbol + text;
			return unit.name === "" ? text : text + " " + unit.name;
		}

		/**
		 * Whether a credits reading carries any countable figure at all.
		 *
		 * The `unlimited` flag alone does NOT make a reading uncountable, and
		 * treating it that way was a bug: Qoder sets that flag at the top level
		 * because ONE of its packages is an uncapped personal allowance, while the
		 * rest of the document still carries real numbers (e.g. 赠送额度 100/100).
		 * Replacing those numbers with 「不限额」 hid live figures the user needed.
		 * So a reading is uncountable only when it has neither a positive row size
		 * nor a positive declared size — i.e. there genuinely is no denominator to
		 * measure against.
		 * @param {object} value - normalized credits reading.
		 * @returns whether any figure can be measured.
		 */
		function creditsCountable(value) {
			const accounts = value.accounts ?? [];
			if (accounts.some((account) => account.size > 0)) return true;
			return typeof value.totalSize === "number" && value.totalSize > 0;
		}

		/**
		 * The remaining share of one credits reading, as a 0..100 percentage.
		 *
		 * Summing the rows rather than trusting a headline percentage keeps this
		 * correct for both source shapes, whose `total` fields mean opposite things.
		 * @param {object} value - normalized credits reading.
		 * @returns the percentage, or null when no row carries a size.
		 */
		function creditsPercent(value) {
			if (!creditsCountable(value)) return null;
			const accounts = value.accounts ?? [];
			const remain = accounts.reduce((sum, account) => sum + account.remain, 0);
			const size = accounts.reduce((sum, account) => sum + account.size, 0);
			if (size > 0) return Math.max(0, Math.min(100, (remain / size) * 100));
			const declared = typeof value.totalSize === "number" ? value.totalSize : 0;
			if (declared > 0 && typeof value.total === "number") {
				return Math.max(0, Math.min(100, (value.total / declared) * 100));
			}
			return null;
		}

		/**
		 * Group one credits reading's rows into the blocks the card draws.
		 *
		 * Rows sharing a label are merged — the owning plugins report one row per
		 * package grant, so a user with several identical grants would otherwise see
		 * the same name repeated down the card — and rows with nothing left are
		 * dropped.
		 *
		 * The source's per-row `unlimited` flag is deliberately ignored: it marks a
		 * package as not drawn from credit (a free model), so it is not a credit
		 * figure and cannot decide what this readout shows.
		 * @param {object} value - normalized credits reading.
		 * @returns `{ label, remain, size, percent, endTime }` blocks.
		 */
		function creditsGroups(value) {
			const merged = new Map();
			for (const account of value.accounts ?? []) {
				const key = account.label;
				const current = merged.get(key);
				if (current === undefined) {
					merged.set(key, {
						label: key,
						remain: account.remain,
						size: account.size,
						endTime: account.endTime,
					});
					continue;
				}
				current.remain += account.remain;
				current.size += account.size;
				if (current.endTime === undefined) current.endTime = account.endTime;
			}
			const groups = [];
			for (const group of merged.values()) {
				// Rows with nothing left are dropped, matching what the owning plugins
				// do on their own cards: a spent grant would otherwise print a
				// meaningless `0` row and push the live ones off the card.
				if (!(group.remain > 0)) continue;
				groups.push({
					...group,
					percent:
						group.size > 0 ? Math.max(0, Math.min(100, (group.remain / group.size) * 100)) : null,
				});
			}
			return groups;
		}

		/**
		 * The smallest remaining share across a quota's windows.
		 * @param {object} value - normalized quota reading.
		 * @returns a 0..1 ratio, or null when no window carries a limit.
		 */
		function quotaRatio(value) {
			const dims = value.dims.length > 0 ? value.dims : [value];
			const ratios = [];
			for (const dim of dims) {
				if (typeof dim.limit === "number" && dim.limit > 0 && typeof dim.remaining === "number") {
					ratios.push(dim.remaining / dim.limit);
				}
			}
			if (ratios.length === 0) return null;
			return Math.max(0, Math.min(1, Math.min(...ratios)));
		}

		/**
		 * Format one ISO reset timestamp.
		 * @param {string|undefined} resetTime - ISO 8601 timestamp.
		 * @returns display text.
		 */
		function resetText(resetTime) {
			if (typeof resetTime !== "string" || resetTime === "") return null;
			const at = new Date(resetTime);
			return Number.isNaN(at.getTime()) ? resetTime : at.toLocaleString();
		}

		/**
		 * Explain one `queryable: false` reading in the panel's own words.
		 * @param {object} value - normalized unqueryable reading.
		 * @returns display text.
		 */
		function unqueryableReason(value) {
			return UNQUERYABLE_REASON[value.reason] ?? "该厂商无余额接口";
		}

		/**
		 * Explain one `queryable: false` reading's cause and fix in the panel.
		 * @param {object} value - normalized unqueryable reading.
		 * @param {string} providerId - the provider route being shown.
		 * @returns display text.
		 */
		function unqueryableNote(value, providerId) {
			const template = UNQUERYABLE_NOTE[value.reason];
			if (template === undefined) return "该厂商没有 API 级余额接口，只能在其控制台查看。";
			return template.replace("{source}", SOURCE_PLUGIN[providerId] ?? "对应");
		}

		/**
		 * Fetch one JSON document, never throwing on a non-JSON body.
		 * @param {string} url - same-origin URL.
		 * @param {AbortSignal} signal - caller cancellation.
		 * @returns status and decoded body (null when not JSON).
		 */
		async function readJson(url, signal) {
			const response = await fetch(url, {
				signal,
				headers: { accept: "application/json" },
				cache: "no-store",
			});
			const body = await response.json().catch(() => null);
			return { status: response.status, ok: response.ok, body };
		}

		/**
		 * Normalize one host answer. This package's route and the standalone data
		 * plane speak the same value shape, so one reader covers both.
		 * @param {object} value - the route's `value`.
		 * @returns a normalized reading.
		 */
		function fromAnswer(value) {
			if (value?.queryable === false) {
				return { kind: "unqueryable", reason: value.reason, detail: value.detail, loginUrl: value.loginUrl };
			}
			if (value?.kind === "credits") {
				const rows = Array.isArray(value.accounts) ? value.accounts : [];
				return {
					kind: "credits",
					// The unit is taken from the answer when the host names one, and
					// otherwise from the reading's own kind — never inferred from the
					// provider, because a credit figure is not money in any currency.
					unit: typeof value.unit === "string" && value.unit !== "" ? value.unit : "credits",
					sourceName: typeof value.sourceName === "string" ? value.sourceName : undefined,
					total: typeof value.total === "number" ? value.total : null,
					totalSize: typeof value.totalSize === "number" ? value.totalSize : null,
					usedPercent: typeof value.usedPercent === "number" ? value.usedPercent : undefined,
					accounts: rows.flatMap((row) => {
						if (row === null || typeof row !== "object") return [];
						if (typeof row.remain !== "number") return [];
						return [
							{
								label: typeof row.label === "string" && row.label !== "" ? row.label : "(unnamed)",
								remain: row.remain,
								size: typeof row.size === "number" ? row.size : 0,
								unlimited: row.unlimited === true,
								endTime: typeof row.endTime === "string" ? row.endTime : undefined,
							},
						];
					}),
					unlimited: value.unlimited === true,
					resetTime: typeof value.resetTime === "string" ? value.resetTime : undefined,
					source: value.endpoint ?? value.provider,
					fetchedAt: Date.now(),
				};
			}
			if (value?.kind === "quota") {
				const dims =
					Array.isArray(value.dims) && value.dims.length > 0
						? value.dims
						: [
								{
									window: "",
									limit: value.limit,
									used: value.used,
									remaining: value.remaining,
									resetTime: value.resetTime,
								},
							];
				return {
					kind: "quota",
					dims,
					source: value.endpoint ?? value.provider,
					fetchedAt: Date.now(),
				};
			}
			return {
				kind: "currency",
				currency: value?.currency ?? "",
				balance: typeof value?.balance === "number" ? value.balance : null,
				granted: typeof value?.granted === "number" ? value.granted : null,
				toppedUp: typeof value?.toppedUp === "number" ? value.toppedUp : null,
				available: value?.available !== false,
				source: value?.endpoint ?? value?.provider,
				fetchedAt: Date.now(),
			};
		}

		/**
		 * Re-render when a snapshot store changes, while reading the value during
		 * render so a switched store never shows the previous store's value.
		 * @param {object|undefined} store - a snapshot store, or nothing.
		 * @returns the same store, for chaining.
		 */
		function useStoreTick(store) {
			const [, force] = React.useState(0);
			React.useEffect(() => {
				if (store === undefined || store === null) return;
				const unsubscribe = store.subscribe(() => {
					force((current) => current + 1);
				});
				return () => {
					if (typeof unsubscribe === "function") unsubscribe();
				};
			}, [store]);
			return store;
		}

		/**
		 * Whether one placement draws the sidebar card.
		 *
		 * Written as an allow-list rather than a comparison against the surfaces it
		 * is NOT: a value this build does not know (`none`, or one written by a
		 * newer host) must hide the readout, never fall through and show it.
		 * @param {string|undefined} placement - the settings value.
		 * @returns whether the card is wanted.
		 */
		function showsSidebarCard(placement) {
			return placement === "sidebar" || placement === "both";
		}

		/**
		 * Whether one placement draws the composer pill.
		 * @param {string|undefined} placement - the settings value.
		 * @returns whether the pill is wanted.
		 */
		function showsComposerPill(placement) {
			return placement === "composer" || placement === "both";
		}

		/**
		 * Resolve the node the pill is rendered into: the shipped statistics row
		 * while it exists, otherwise a row of our own kept last under the composer.
		 * @param {boolean} enabled - false to resolve nothing and leave no DOM behind.
		 * @returns the placement host plus whether it is our own box, or null while
		 * neither surface is mounted.
		 */
		function usePlacementHost(enabled) {
			const [host, setHost] = React.useState(null);

			React.useEffect(() => {
				// A disabled host must not even create its fallback box: an empty
				// container under the composer still adds that stack's flex gap, so
				// "hidden" would otherwise leave a visible blank line behind.
				if (enabled !== true) {
					setHost(null);
					return undefined;
				}
				let current = null;
				let currentOwned = false;
				let own = null;
				let queued = false;

				/** Our own row container, kept as the composer stack's last child. */
				const ensureOwn = () => {
					const seat = document.querySelector("[data-composer-seat]");
					if (seat === null) return null;
					const stack = seat.firstElementChild ?? seat;
					if (own === null || !own.isConnected) {
						own = document.createElement("div");
						own.dataset.dshBalanceHost = "";
					}
					if (own.parentNode !== stack || stack.lastElementChild !== own) stack.appendChild(own);
					return own;
				};

				const sync = () => {
					queued = false;
					const stats = document.querySelector("[data-composer-stats]");
					const next = stats ?? ensureOwn();
					// An unused fallback box would still add the stack's flex gap.
					if (stats !== null && own !== null) {
						own.remove();
						own = null;
					}
					const owned = stats === null;
					if (next !== current || owned !== currentOwned) {
						current = next;
						currentOwned = owned;
						setHost(next === null ? null : { node: next, owned });
					}
				};

				const schedule = () => {
					if (queued) return;
					queued = true;
					const raf = globalThis.requestAnimationFrame;
					if (typeof raf === "function") raf(() => { sync(); });
					else sync();
				};

				sync();
				const observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
				return () => {
					observer.disconnect();
					if (own !== null) own.remove();
				};
			}, [enabled]);

			return host;
		}

		/**
		 * Display name for one provider route.
		 * @param {string} provider - provider route id.
		 * @param {ReadonlyArray<object>} groups - catalog provider groups.
		 * @returns the display name, falling back to the route id itself.
		 */
		function labelOf(provider, groups) {
			const group = groups.find((candidate) => candidate?.id === provider);
			const named = group?.name;
			if (typeof named === "string" && named.trim() !== "") return named.trim();
			return PROVIDER_ALIASES[provider] ?? provider;
		}

		/**
		 * The provider route behind the model currently selected in the conversation.
		 *
		 * A mounted conversation answers through its own model directory — the same
		 * shared state the composer's model seat writes. With no conversation, the
		 * answer is the model catalog's default, which is what a fresh agent starts
		 * on, so the new-session surface stays populated.
		 * @param {object|undefined} models - the optional `modelDirectories` service.
		 * @param {string|undefined} sessionId - the mounted conversation, when any.
		 * @returns the provider route and its display name, or undefined.
		 */
		function useCurrentProvider(models, sessionId) {
			const [retry, setRetry] = React.useState(0);
			const catalogStore = models?.catalog?.store;
			useStoreTick(catalogStore);

			// `directoryFor` caches per session, so this is stable across renders.
			let directory;
			if (models !== undefined && sessionId !== undefined && sessionId !== null) {
				try {
					directory = models.directoryFor(sessionId);
				} catch (error) {
					directory = undefined;
				}
			}

			const directoryStore = directory?.store;
			useStoreTick(directoryStore);
			React.useEffect(() => {
				if (directory === undefined) return;
				const started = directory.load();
				if (started !== undefined && typeof started.catch === "function") started.catch(() => {});
			}, [directory]);

			// A conversation whose scope is not live yet resolves no directory; retry
			// shortly instead of pinning the catalog default for the whole session.
			React.useEffect(() => {
				if (models === undefined) return;
				if (sessionId === undefined || sessionId === null || directory !== undefined) return;
				const timer = setTimeout(() => {
					setRetry((current) => current + 1);
				}, 1000);
				return () => {
					clearTimeout(timer);
				};
			}, [models, sessionId, directory, retry]);

			const state = directoryStore?.getSnapshot();
			const selected = state?.current;
			if (typeof selected?.provider === "string" && selected.provider !== "") {
				const groups = Array.isArray(state.groups) ? state.groups : [];
				return { provider: selected.provider, label: labelOf(selected.provider, groups) };
			}

			const catalog = catalogStore?.getSnapshot();
			const fallback = catalog?.value?.default;
			if (typeof fallback?.provider === "string" && fallback.provider !== "") {
				const groups = Array.isArray(catalog.value.groups) ? catalog.value.groups : [];
				return { provider: fallback.provider, label: labelOf(fallback.provider, groups) };
			}
			return undefined;
		}

		/**
		 * Keep one provider's reading fresh.
		 * @param {object} entry - the provider route and its display name.
		 * @param {number} pollMs - the user's poll interval.
		 * @returns the reading plus a manual refresh action.
		 */
		function useReading(entry, pollMs) {
			const [value, setValue] = React.useState(null);
			const [failure, setFailure] = React.useState(null);
			const [busy, setBusy] = React.useState(true);
			const [nonce, setNonce] = React.useState(0);
			/** Set only by the manual refresh action, so polling keeps the host cache. */
			const forceRef = React.useRef(false);

			React.useEffect(() => {
				const controller = new AbortController();
				let live = true;
				const force = forceRef.current;
				forceRef.current = false;
				setBusy(true);
				(async () => {
					try {
						const suffix =
							"?provider=" + encodeURIComponent(entry.id) + (force ? "&refresh=1" : "");
						// This package's own host route answers for every provider it
						// knows, and echoes the requested id so a stale host half —
						// one that predates the provider parameter — cannot be mistaken
						// for an answer about a different vendor.
						const own = await readJson(ROUTE_PATH + suffix, controller.signal);
						if (own.ok && own.body?.ok === true && own.body.value?.provider === entry.id) {
							if (live) {
								setValue(fromAnswer(own.body.value));
								setFailure(null);
							}
							return;
						}
						// Host half older than this bundle (a client hot-reload before the
						// next restart): the standalone data plane still answers.
						const skew = await readJson(SKEW_PATH + suffix, controller.signal);
						if (skew.ok && skew.body?.ok === true) {
							if (live) {
								setValue(fromAnswer(skew.body.value));
								setFailure(null);
							}
							return;
						}
						throw new Error(
							own.body?.error?.message ??
								skew.body?.error?.message ??
								"HTTP " + String(own.ok ? skew.status : own.status),
						);
					} catch (reason) {
						if (!live || controller.signal.aborted) return;
						setFailure(reason instanceof Error ? reason.message : String(reason));
					} finally {
						if (live) setBusy(false);
					}
				})();
				return () => {
					live = false;
					controller.abort();
				};
			}, [entry.id, nonce]);

			React.useEffect(() => {
				const gap = typeof pollMs === "number" && pollMs >= 15000 ? pollMs : POLL_MS;
				const timer = setInterval(() => {
					setNonce((current) => current + 1);
				}, gap);
				const wake = () => {
					if (document.visibilityState === "visible") setNonce((current) => current + 1);
				};
				window.addEventListener("focus", wake);
				document.addEventListener("visibilitychange", wake);
				return () => {
					clearInterval(timer);
					window.removeEventListener("focus", wake);
					document.removeEventListener("visibilitychange", wake);
				};
			}, [pollMs]);

			return {
				value,
				failure,
				busy,
				refresh: () => {
					forceRef.current = true;
					setNonce((current) => current + 1);
				},
			};
		}

		/**
		 * Compact readout for one reading, used by the composer pill and as the
		 * sidebar card's accessible name.
		 *
		 * Every branch writes the figure through the reading's own unit, so a
		 * credit count is never spelled as money (or the reverse).
		 * @param {object} value - normalized reading, or null while loading.
		 * @param {string} label - the provider's display name.
		 * @param {string|null} failure - latest failure, when the last read failed.
		 * @param {object} settings - the user's settings document.
		 * @returns the pill text.
		 */
		function readoutText(value, label, failure, settings) {
			const requested = settings?.unitStyle ?? "symbol";
			const group = settings?.groupDigits !== false;
			if (value === null) return label + "余额 " + (failure === null ? "读取中…" : "读取失败");
			if (value.kind === "unqueryable") return label + (UNQUERYABLE_PILL[value.reason] ?? "暂不支持");
			const unit = unitOf(value);
			if (value.kind === "credits") {
				// The word 积分 IS this reading's unit statement, and the glyph in the
				// icon slot carries the mark, so neither needs repeating inside the
				// figure. Every run of this branch therefore names credits as credits.
				//
				// The figure is the real summed remainder. The source's `unlimited`
				// flag is deliberately NOT rendered: for these plugins it describes a
				// model being free of charge (so it spends no credit), which says
				// nothing about how many credits the account holds — the only question
				// this readout answers. Showing it here would replace a live figure
				// with a statement about a model.
				const amount = figure(unit, value.total, "none", group);
				return label + "积分 " + amount + (failure === null ? "" : " · 离线");
			}
			if (value.kind === "quota") {
				const ratio = quotaRatio(value);
				const body = ratio === null ? "额度未知" : "剩余 " + String(Math.round(ratio * 100)) + "%";
				return label + body + (failure === null ? "" : " · 离线");
			}
			// Currency: the glyph already stands in for the symbol, so only the
			// word-based style adds anything to the text beside it. An unidentified
			// unit is the exception — it has no honest symbol to lean on, so it is
			// spelled out regardless of the chosen style.
			const moneyStyle = unit.kind === "none" ? "name" : requested === "name" ? "name" : "none";
			return (
				label +
				"余额 " +
				figure(unit, value.balance, moneyStyle, group) +
				(value.available === false ? " · 不可用" : "") +
				(failure === null ? "" : " · 离线")
			);
		}

		/**
		 * The mark shown in the pill's icon slot.
		 *
		 * A credit reading gets its own mark, because the yuan sign would be a claim
		 * about units the number does not make. An unidentified unit gets the
		 * generic currency sign rather than the yuan sign, for the same reason.
		 * @param {object} value - normalized reading, or null while loading.
		 * @returns one symbol.
		 */
		function currencyGlyph(value) {
			if (value === null) return DEFAULT_GLYPH;
			return unitOf(value).symbol;
		}

		/**
		 * Label/value pairs for the detail panel.
		 * @param {object} entry - the provider route and its display name.
		 * @param {object} value - normalized reading, or null while loading.
		 * @param {object} settings - the user's settings document.
		 * @returns detail rows.
		 */
		function detailRows(entry, value, settings) {
			const style = settings?.unitStyle ?? "symbol";
			const group = settings?.groupDigits !== false;
			if (value === null) return [["状态", "读取中…"]];
			if (value.kind === "unqueryable") {
				return [
					["状态", unqueryableReason(value)],
					...(typeof value.detail === "string" && value.detail !== "" ? [["详情", value.detail]] : []),
					["厂商", entry.label],
				];
			}
			const unit = unitOf(value);
			if (value.kind === "credits") {
				const percent = creditsPercent(value);
				const rows = [
					[
						unit.name === "积分" ? "剩余积分" : "剩余额度",
						figure(unit, value.total, style, group),
					],
				];
				if (percent !== null) rows.push(["剩余占比", percent.toFixed(1) + "%"]);
				// The source's own percentage means CONSUMPTION, the opposite of what a
				// reader assumes a bare percentage beside "remaining" to mean, so it is
				// labelled explicitly rather than shown as another remaining figure.
				if (typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent)) {
					rows.push(["本轮已用", value.usedPercent.toFixed(2) + "%"]);
				}
				const reset = resetText(value.resetTime);
				if (reset !== null) rows.push(["重置时间", reset]);
				// Merged per package, with exhausted grants dropped, so a user holding
				// several identical grants does not read the same name down the panel.
				for (const account of value.accounts) {
					if (!(account.remain > 0)) continue;
					const counts =
						account.size > 0
							? figure(unit, account.remain, style, group) +
								" / " +
								figure(unit, account.size, "none", group)
							: figure(unit, account.remain, style, group);
					rows.push([account.label, counts]);
				}
				rows.push(["厂商", entry.label]);
				if (value.fetchedAt !== undefined) {
					rows.push(["更新时间", new Date(value.fetchedAt).toLocaleTimeString()]);
				}
				return rows;
			}
			if (value.kind === "quota") {
				const rows = [];
				for (const dim of value.dims) {
					const label = WINDOW_LABEL[dim.window] ?? (dim.window === "" ? "配额" : dim.window);
					const counts =
						typeof dim.remaining === "number" && typeof dim.limit === "number"
							? figure({ kind: "quota", symbol: "", name: "次" }, dim.remaining, "none", group) +
								" / " +
								figure({ kind: "quota", symbol: "", name: "次" }, dim.limit, "none", group)
							: "—";
					rows.push([label, counts]);
					const reset = resetText(dim.resetTime);
					if (reset !== null) rows.push([label + "重置", reset]);
				}
				rows.push(["厂商", entry.label]);
				if (value.fetchedAt !== undefined) {
					rows.push(["更新时间", new Date(value.fetchedAt).toLocaleTimeString()]);
				}
				return rows;
			}
			const rows = [["总余额", figure(unit, value.balance, style, group)]];
			if (value.toppedUp !== null && value.toppedUp !== undefined) {
				rows.push(["充值余额", figure(unit, value.toppedUp, style, group)]);
			}
			if (value.granted !== null && value.granted !== undefined) {
				rows.push(["赠送余额", figure(unit, value.granted, style, group)]);
			}
			rows.push(["账户状态", value.available === false ? "不可用" : "可用"]);
			rows.push(["厂商", entry.label]);
			if (value.source !== undefined) rows.push(["数据源", value.source, "dshBal_route"]);
			if (value.fetchedAt !== undefined) {
				rows.push(["更新时间", new Date(value.fetchedAt).toLocaleTimeString()]);
			}
			return rows;
		}

		/**
		 * The single pill plus its anchored detail panel. The pill owns its own dialog
		 * seat: only one provider is ever shown, so no exclusivity is needed.
		 * @param {object} props - the provider route, its display name, and settings.
		 * @returns the seat element tree.
		 */
		function ProviderSeat({ entry, settings }) {
			const [open, setOpen] = React.useState(false);
			const reading = useReading(entry, settings?.pollMs);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const pos = useAnchoredPosition({
				open,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: PANEL_GAP,
				margin: PANEL_MARGIN,
			});
			useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			React.useEffect(() => {
				if (!open) return;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const readout = readoutText(reading.value, entry.label, reading.failure, settings);
			const glyph = currencyGlyph(reading.value);
			const unqueryable = reading.value?.kind === "unqueryable";
			const unit = unitOf(reading.value);
			// The panel names the reading's own measure rather than reusing the
			// currency wording, so a credit panel never reads as a money panel.
			const heading = reading.value?.kind === "credits" ? "积分" : "余额";
			const tone =
				reading.failure !== null
					? reading.value === null
						? " dshBal_bad"
						: " dshBal_stale"
					: unqueryable
						? " dshBal_muted"
						: "";
			const pulse = reading.value === null && reading.busy ? " dshBal_pulse" : "";
			const rows = detailRows(entry, reading.value, settings);
			const loginUrl = reading.value?.loginUrl;

			return React.createElement(
				"span",
				{ className: "dshBal_anchor", ref: rootRef, "data-composer-balance": entry.id },
				React.createElement(
					"button",
					{
						type: "button",
						className: "dshBal_pill" + tone,
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						"aria-label": readout,
						onClick: () => {
							setOpen(!open);
						},
					},
					React.createElement(
						"span",
						{ className: "dshBal_glyph", "aria-hidden": true },
						glyph,
					),
					React.createElement("span", { className: "dshBal_label" + pulse }, readout),
				),
				open
					? createPortal(
							React.createElement(
								"div",
								{
									ref: panelRef,
									className: "dshBal_panel",
									role: "dialog",
									"aria-label": entry.label + heading,
									style: pos ?? MEASURE_STYLE,
								},
								React.createElement(
									"div",
									{ className: "dshBal_title" },
									React.createElement(
										"span",
										{ className: "dshBal_titleLabel" },
										React.createElement(
											"span",
											{ className: "dshBal_glyph", "aria-hidden": true },
											glyph,
										),
										entry.label + heading,
									),
									React.createElement(
										"span",
										{ className: "dshBal_titleActions" },
										loginUrl === undefined
											? null
											: React.createElement(
													"button",
													{
														type: "button",
														className: "dshBal_action",
														onClick: () => {
															window.open(loginUrl, "_blank", "noopener,noreferrer");
														},
													},
													"打开控制台",
												),
										React.createElement(
											"button",
											{
												type: "button",
												className: "dshBal_icon",
												"aria-label": "刷新余额",
												title: "刷新余额",
												onClick: () => {
													reading.refresh();
												},
											},
											typeof primitives.IconRefreshOutlineRegular === "function"
												? React.createElement(primitives.IconRefreshOutlineRegular, {})
												: "↻",
										),
									),
								),
								React.createElement("div", { className: "dshBal_titleRule", "aria-hidden": true }),
								reading.failure === null
									? null
									: React.createElement("div", { className: "dshBal_failure" }, reading.failure),
								React.createElement(
									"dl",
									{ className: "dshBal_details" },
									rows.flatMap(([label, text, extra], index) => [
										React.createElement("dt", { key: "t" + String(index) }, label),
										React.createElement(
											"dd",
											{ key: "d" + String(index), className: extra },
											text,
										),
									]),
								),
								unqueryable && loginUrl === undefined
									? React.createElement(
											"div",
											{ className: "dshBal_note" },
											unqueryableNote(reading.value, entry.id),
										)
									: null,
							),
							document.body,
						)
					: null,
			);
		}

		/**
		 * Publishes the mounted conversation's identity and renders nothing: the pill
		 * itself lives in the frame-wide overlay, so this seat exists only to learn
		 * which session the composer belongs to.
		 * @param {object} props - the session id from the slot's injection face, and the slot.
		 * @returns null.
		 */
		function SessionSensor({ sessionId, slot }) {
			React.useEffect(() => {
				slot.set(sessionId);
				return () => {
					// Only the seat that still owns the slot may clear it, so an older
					// conversation unmounting cannot blank a newer one.
					if (Object.is(slot.getSnapshot(), sessionId)) slot.set(undefined);
				};
			}, [sessionId, slot]);
			return null;
		}

		/** The always-mounted seat that places the one pill for the selected model. */
		function BalanceMonitor({ optional, session, settingsStore }) {
			const settings = useSettings(settingsStore);
			// The composer pill is one of the placements the settings tab offers; it
			// is skipped entirely (no read, no portal, no placeholder DOM) unless the
			// setting asks for it, so the two surfaces never double-poll one provider.
			const wanted = showsComposerPill(settings.placement);
			const host = usePlacementHost(wanted);
			const services = useStoreTick(optional)?.getSnapshot();
			useStoreTick(session);
			const current = useCurrentProvider(services?.models, session.getSnapshot());

			if (!wanted) return null;
			if (host === null || current === undefined) return null;
			const entry = { id: current.provider, label: current.label };
			// Keyed by provider, so switching the model remounts onto a fresh reading
			// instead of showing the previous account's number for a moment.
			const seat = React.createElement(ProviderSeat, { key: entry.id, entry, settings });
			// Inside the shipped statistics row the pill must be a direct flex item,
			// so only our own fallback host gets the row box around it.
			return createPortal(
				host.owned ? React.createElement("div", { className: "dshBal_row" }, seat) : seat,
				host.node,
			);
		}

		/**
		 * Read the settings store during render, re-rendering on every change.
		 *
		 * `useSyncExternalStore` wants the same reference between changes, which the
		 * store guarantees; the returned value is always a complete document because
		 * the store seeds itself with the defaults.
		 * @param {object} store - the settings store.
		 * @returns the settings document.
		 */
		function useSettings(store) {
			const subscribe = React.useCallback(
				(onChange) => (store === undefined ? () => {} : store.subscribe(onChange)),
				[store],
			);
			const snapshot = React.useSyncExternalStore(
				subscribe,
				() => (store === undefined ? undefined : store.getSnapshot()),
				() => (store === undefined ? undefined : store.getSnapshot()),
			);
			return snapshot?.value ?? {};
		}

		/**
		 * The quota ring — a faint track plus an arc whose sweep is the remaining
		 * share, drawn from 12 o'clock. Circumference 2πr = 45.55 at r = 7.25.
		 * @param {object} props - percent, warn, size.
		 * @returns the ring element.
		 */
		function Ring({ percent, warn, size }) {
			const clamped = Math.min(100, Math.max(0, percent));
			const circumference = 45.55;
			const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1e3) / 1e3;
			return React.createElement(
				"span",
				{ className: "dshBal_ring" + (warn ? " dshBal_ringWarn" : ""), "aria-hidden": true },
				React.createElement(
					"svg",
					{ viewBox: "0 0 20 20", width: size, height: size, focusable: "false" },
					React.createElement("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.5",
						opacity: "0.4",
					}),
					React.createElement("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2.5",
						strokeLinecap: "round",
						strokeDasharray: String(circumference),
						strokeDashoffset: String(dashoffset),
						transform: "rotate(-90 10 10)",
					}),
				),
			);
		}

		/**
		 * One block of the card: a package group's figures on a head line, then its
		 * full-width bar. Stacking them keeps the numbers from being squeezed by the
		 * bar into an ellipsis.
		 * @param {object} props - group, unit, settings.
		 * @returns the block element.
		 */
		function GroupRow({ group, unit, settings }) {
			const style = settings?.unitStyle ?? "symbol";
			const groupDigits = settings?.groupDigits !== false;
			const warnPercent = typeof settings?.warnPercent === "number" ? settings.warnPercent : 20;
			const warn = group.percent !== null && group.percent < warnPercent;
			// A row is always its figures: a package with a real size shows
			// `remain / size`, and one whose size the upstream never reported shows
			// the remainder alone rather than inventing a denominator.
			const detail =
				group.percent === null || group.size <= 0
					? figure(unit, group.remain, style, groupDigits)
					: figure(unit, group.remain, style, groupDigits) +
						" / " +
						figure(unit, group.size, "none", groupDigits);
			return React.createElement(
				"span",
				{ className: "dshBal_row2" },
				React.createElement(
					"span",
					{ className: "dshBal_rowHead" },
					React.createElement(
						"span",
						{
							className: "dshBal_rowLabel",
							title:
								group.endTime === undefined ? group.label : group.label + " · 到期 " + group.endTime,
						},
						group.label,
					),
					React.createElement("span", { className: "dshBal_rowAmount" }, detail),
					React.createElement(
						"span",
						{ className: "dshBal_rowPct" },
						group.percent === null ? "" : String(Math.round(group.percent)) + "%",
					),
				),
				React.createElement(
					"span",
					{ className: "dshBal_bar" },
					React.createElement("span", {
						className: "dshBal_fill" + (warn ? " dshBal_fillWarn" : ""),
						style: {
							width: String(Math.max(2, group.percent === null ? 0 : group.percent)) + "%",
						},
					}),
				),
			);
		}

		/**
		 * The sidebar footer card: the whole balance, always visible beside Settings.
		 *
		 * The card is itself the button — the shell supplies no chrome — and click
		 * opens the anchored detail panel rather than navigating anywhere, so the
		 * conversation stays mounted underneath.
		 * @param {object} props - the current provider entry, its reading, and settings.
		 * @returns the card element.
		 */
		function SidebarBalanceCard({ entry, settings, wide }) {
			const [open, setOpen] = React.useState(false);
			const reading = useReading(entry, settings?.pollMs);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const pos = useAnchoredPosition({
				open,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: PANEL_GAP,
				margin: PANEL_MARGIN,
			});
			useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			React.useEffect(() => {
				if (!open) return;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const value = reading.value;
			const unit = unitOf(value);
			const unqueryable = value?.kind === "unqueryable";
			const warnPercent = typeof settings?.warnPercent === "number" ? settings.warnPercent : 20;
			const groups = value?.kind === "credits" ? creditsGroups(value) : [];
			const percent = value?.kind === "credits" ? creditsPercent(value) : null;
			const quotaRatioValue = value?.kind === "quota" ? quotaRatio(value) : null;
			const overall =
				percent !== null ? percent : quotaRatioValue === null ? null : quotaRatioValue * 100;
			const failed = reading.failure !== null;
			// The ring follows the summed share. The source's `unlimited` flag is not
			// consulted: it marks a model as free of charge, not the account as
			// uncapped, so letting it force a full ring would misreport the credits.
			const ringPercent = failed || value === null ? 0 : overall ?? 0;
			const ringWarn = failed || (overall !== null && overall < warnPercent);
			const readoutKind = value?.kind === "credits" ? "积分" : "余额";
			// The card's accessible name states the unit itself: unlike the pill it
			// has no icon slot the symbol alone can live in, and "1,289" without a
			// unit is exactly the ambiguity between credits and money this plugin
			// exists to avoid. Money names its currency; a credit count is already
			// named by its heading word.
			const headline =
				value === null || unqueryable
					? ""
					: " " +
						figure(
							unit,
							value.kind === "credits" ? value.total : value.balance,
							unit.kind === "currency" ? "name" : "none",
							settings?.groupDigits !== false,
						);
			const title =
				entry.label +
				readoutKind +
				headline +
				(reading.failure === null ? "" : " · 离线") +
				(unqueryable ? (UNQUERYABLE_PILL[value.reason] ?? "暂不支持") : "");

			/** One notice line for a card with no bars to draw. */
			const notice = () => {
				if (failed && value === null) return { text: "读取失败", bad: true };
				if (unqueryable) return { text: UNQUERYABLE_PILL[value.reason] ?? "暂不支持", bad: false };
				if (value === null) return { text: "读取中…", bad: false };
				return null;
			};
			const fallbackNotice = notice();

			if (!wide) {
				// The 56px rail: one icon cell carrying the ring, like its siblings.
				return React.createElement(
					"button",
					{
						type: "button",
						className: "dshBal_railButton",
						"aria-label": title,
						title,
						onClick: () => {
							setOpen(!open);
						},
					},
					React.createElement(Ring, { percent: ringPercent, warn: ringWarn, size: 18 }),
					open ? detailPanel() : null,
				);
			}

			return React.createElement(
				"button",
				{
					type: "button",
					className: "dshBal_card" + (settings?.cardBorder === false ? " dshBal_noBorder" : ""),
					"aria-label": title,
					title,
					ref: rootRef,
					onClick: () => {
						setOpen(!open);
					},
				},
				React.createElement(
					"span",
					{ className: "dshBal_cardTop" },
					React.createElement(Ring, { percent: ringPercent, warn: ringWarn, size: 16 }),
					React.createElement(
						"span",
						{ className: "dshBal_cardName" },
						entry.label + readoutKind,
					),
					// The headline figure, always present and always unit-correct, so
					// even a card with no rows to draw still states the number.
					value !== null && !unqueryable && value.kind !== "quota"
						? React.createElement(
								"span",
								{ className: "dshBal_cardTotal" },
								figure(
									unit,
									value.kind === "credits" ? value.total : value.balance,
									settings?.unitStyle,
									settings?.groupDigits !== false,
								),
							)
						: React.createElement("span", { className: "dshBal_cardSpacer" }),
					settings?.showUpdatedAt !== false && value?.fetchedAt !== undefined
						? React.createElement(
								"span",
								{ className: "dshBal_updated" },
								"更新于 " + new Date(value.fetchedAt).toLocaleTimeString(),
							)
						: null,
				),
				value?.kind === "credits" && groups.length > 0
					? groups.map((group, index) =>
							React.createElement(GroupRow, {
								key: entry.id + "-" + String(index) + "-" + group.label,
								group,
								unit,
								settings,
							}),
						)
					: value?.kind === "quota"
						? (value.dims ?? []).map((dim, index) => {
								const ratio =
									typeof dim.remaining === "number" && typeof dim.limit === "number" && dim.limit > 0
										? Math.max(0, Math.min(100, (dim.remaining / dim.limit) * 100))
										: null;
								return React.createElement(GroupRow, {
									key: entry.id + "-dim-" + String(index),
									group: {
										label: WINDOW_LABEL[dim.window] ?? (dim.window === "" ? "配额" : dim.window),
										remain: dim.remaining,
										size: dim.limit,
										percent: ratio,
										endTime: dim.resetTime,
									},
									unit,
									settings,
								});
							})
						: fallbackNotice === null
							? null
							: React.createElement(
									"span",
									{
										className:
											"dshBal_cardNotice" + (fallbackNotice.bad ? " dshBal_cardNoticeBad" : ""),
									},
									fallbackNotice.text,
								),
				open ? detailPanel() : null,
			);

			/** The anchored detail panel, shared by the wide card and the rail button. */
			function detailPanel() {
				const rows = detailRows(entry, value, settings);
				const loginUrl = value?.loginUrl;
				return createPortal(
					React.createElement(
						"div",
						{
							ref: panelRef,
							className: "dshBal_panel",
							role: "dialog",
							"aria-label": entry.label + (value?.kind === "credits" ? "积分" : "余额"),
							style: pos ?? MEASURE_STYLE,
							onClick: (event) => {
								// The card is a button; a click inside the panel must not
								// toggle it shut.
								event.stopPropagation();
							},
						},
						React.createElement(
							"div",
							{ className: "dshBal_title" },
							React.createElement(
								"span",
								{ className: "dshBal_titleLabel" },
								React.createElement(
									"span",
									{ className: "dshBal_glyph", "aria-hidden": true },
									currencyGlyph(value),
								),
								entry.label + (value?.kind === "credits" ? "积分" : "余额"),
							),
							React.createElement(
								"span",
								{ className: "dshBal_titleActions" },
								loginUrl === undefined
									? null
									: React.createElement(
											"button",
											{
												type: "button",
												className: "dshBal_action",
												onClick: () => {
													window.open(loginUrl, "_blank", "noopener,noreferrer");
												},
											},
											"打开控制台",
										),
								React.createElement(
									"button",
									{
										type: "button",
										className: "dshBal_icon",
										"aria-label": "刷新余额",
										title: "刷新余额",
										onClick: () => {
											reading.refresh();
										},
									},
									typeof primitives.IconRefreshOutlineRegular === "function"
										? React.createElement(primitives.IconRefreshOutlineRegular, {})
										: "↻",
								),
							),
						),
						React.createElement("div", { className: "dshBal_titleRule", "aria-hidden": true }),
						reading.failure === null
							? null
							: React.createElement("div", { className: "dshBal_failure" }, reading.failure),
						React.createElement(
							"dl",
							{ className: "dshBal_details" },
							rows.flatMap(([rowLabel, text, extra], index) => [
								React.createElement("dt", { key: "t" + String(index) }, rowLabel),
								React.createElement("dd", { key: "d" + String(index), className: extra }, text),
							]),
						),
						unqueryable && loginUrl === undefined
							? React.createElement(
									"div",
									{ className: "dshBal_note" },
									unqueryableNote(value, entry.id),
								)
							: null,
					),
					document.body,
				);
			}
		}

		/**
		 * The always-mounted seat that puts the balance beside the Settings control.
		 *
		 * Renders nothing unless the settings name the sidebar placement, and
		 * nothing while no provider resolves, so an unconfigured install adds no
		 * chrome to the sidebar at all.
		 * @param {object} props - model services, the mounted session, the settings store.
		 * @returns the card, or null.
		 */
		function SidebarBalanceSeat({ optional, session, settingsStore, wide }) {
			const services = useStoreTick(optional)?.getSnapshot();
			useStoreTick(session);
			const settings = useSettings(settingsStore);
			const current = useCurrentProvider(services?.models, session.getSnapshot());
			if (!showsSidebarCard(settings.placement)) return null;
			if (current === undefined) return null;
			const entry = { id: current.provider, label: current.label };
			return React.createElement(SidebarBalanceCard, {
				key: entry.id,
				entry,
				settings,
				wide: wide !== false,
			});
		}

		/** One labelled row of the settings tab, with its control on the right. */
		function SettingRow({ label, hint, control }) {
			return React.createElement(
				"div",
				{ className: "dshBal_setting" },
				React.createElement(
					"div",
					{ className: "dshBal_settingText" },
					React.createElement("span", { className: "dshBal_settingLabel" }, label),
					hint === undefined ? null : React.createElement("span", { className: "dshBal_settingHint" }, hint),
				),
				React.createElement("span", { className: "dshBal_settingControl" }, control),
			);
		}

		/** A switch the settings tab uses for its boolean options. */
		function Switch({ checked, onToggle, label }) {
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dshBal_switch" + (checked ? " dshBal_switchOn" : ""),
					role: "switch",
					"aria-checked": checked,
					"aria-label": label,
					onClick: () => {
						onToggle(!checked);
					},
				},
				React.createElement("span", { className: "dshBal_knob" }),
			);
		}

		/**
		 * The `余额监测` settings tab.
		 *
		 * Every control writes straight through to the host's settings document;
		 * a refused or failed write is reported in place rather than silently
		 * reverting, so the user is never left guessing whether it took.
		 * @param {object} props - the settings store.
		 * @returns the tab element.
		 */
		function BalanceSettingsSection({ settingsStore }) {
			const [failure, setFailure] = React.useState(null);
			const subscribe = React.useCallback(
				(onChange) => (settingsStore === undefined ? () => {} : settingsStore.subscribe(onChange)),
				[settingsStore],
			);
			const snapshot = React.useSyncExternalStore(
				subscribe,
				() => settingsStore?.getSnapshot(),
				() => settingsStore?.getSnapshot(),
			);
			const value = snapshot?.value ?? {};
			const write = (patch) => {
				if (settingsStore === undefined) {
					setFailure("宿主半边不可用，设置无法保存。");
					return;
				}
				setFailure(null);
				const started = settingsStore.patch(patch);
				if (started !== undefined && typeof started.then === "function") {
					started.then((accepted) => {
						if (accepted !== true) setFailure("设置未能保存，请重试。");
					});
				}
			};
			const select = (field, options) =>
				React.createElement(
					"select",
					{
						className: "dshBal_select",
						value: value[field],
						"aria-label": field,
						onChange: (event) => {
							write({ [field]: event.target.value });
						},
					},
					options.map((option) =>
						React.createElement("option", { key: option.value, value: option.value }, option.label),
					),
				);

			return React.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 4 } },
				React.createElement(
					"p",
					{ className: "dshBal_settingsNote" },
					"余额监测在本机读取各厂商的剩余额度；密钥始终只留在宿主进程。",
				),
				React.createElement(SettingRow, {
					label: "显示位置",
					hint: "侧边栏卡片常驻可见；输入框下方胶囊是原样式；也可两处都显示，或都不显示（插件仍保留设置与接口）。",
					control: select("placement", [
						{ value: "sidebar", label: "侧边栏卡片" },
						{ value: "composer", label: "输入框下方胶囊" },
						{ value: "both", label: "两处都显示" },
						{ value: "none", label: "都不显示" },
					]),
				}),
				React.createElement(SettingRow, {
					label: "刷新间隔",
					hint: "轮询间隔，越长对厂商计费接口越友好（15 秒 ~ 60 分钟）。",
					control: React.createElement(
						"span",
						{ className: "dshBal_settingControl" },
						React.createElement("input", {
							type: "number",
							className: "dshBal_input",
							min: 1,
							max: 60,
							step: 1,
							"aria-label": "刷新间隔（分钟）",
							value: Math.max(1, Math.round((value.pollMs ?? 60000) / 60000)),
							onChange: (event) => {
								const minutes = Number.parseInt(event.target.value, 10);
								if (!Number.isFinite(minutes) || minutes <= 0) return;
								write({ pollMs: Math.min(3600000, Math.max(15000, minutes * 60000)) });
							},
						}),
						React.createElement("span", { className: "dshBal_settingHint" }, "分钟"),
					),
				}),
				React.createElement(SettingRow, {
					label: "警告阈值",
					hint: "剩余占比低于该值时，进度条与百分比转为告警色。",
					control: React.createElement(
						"span",
						{ className: "dshBal_settingControl" },
						React.createElement("input", {
							type: "number",
							className: "dshBal_input",
							min: 0,
							max: 100,
							step: 1,
							"aria-label": "警告阈值（%）",
							value: value.warnPercent ?? 20,
							onChange: (event) => {
								const percentValue = Number.parseInt(event.target.value, 10);
								if (!Number.isFinite(percentValue)) return;
								write({ warnPercent: Math.min(100, Math.max(0, percentValue)) });
							},
						}),
						React.createElement("span", { className: "dshBal_settingHint" }, "%"),
					),
				}),
				React.createElement(SettingRow, {
					label: "单位写法",
					hint: "无论选哪种，元与积分都不会混用：积分永远带自己的单位，不会被写成金额。",
					control: select("unitStyle", [
						{ value: "symbol", label: "符号（¥100 / 🎫100）" },
						{ value: "name", label: "名称（100 元 / 100 积分）" },
						{ value: "none", label: "只显示数字" },
					]),
				}),
				React.createElement(SettingRow, {
					label: "显示更新时间",
					hint: "在卡片右上角显示上次读取成功的时间。",
					control: React.createElement(Switch, {
						label: "显示更新时间",
						checked: value.showUpdatedAt !== false,
						onToggle: (next) => {
							write({ showUpdatedAt: next });
						},
					}),
				}),
				React.createElement(SettingRow, {
					label: "显示描边",
					hint: "给侧边栏卡片画一圈细描边，与设置项等其它控件区分开。",
					control: React.createElement(Switch, {
						label: "显示描边",
						checked: value.cardBorder !== false,
						onToggle: (next) => {
							write({ cardBorder: next });
						},
					}),
				}),
				React.createElement(SettingRow, {
					label: "千位分隔",
					hint: "较大的数值按千位分组显示（1,261）。",
					control: React.createElement(Switch, {
						label: "千位分隔",
						checked: value.groupDigits !== false,
						onToggle: (next) => {
							write({ groupDigits: next });
						},
					}),
				}),
				failure === null
					? null
					: React.createElement("p", { className: "dshBal_settingsError" }, failure),
				React.createElement(
					"p",
					{ className: "dshBal_settingsNote" },
					"适配的积分来源：dsh-workbuddy-connect（WorkBuddy / WorkBuddy AI）与 dsh-qoder-connect（Qoder 国内版 / 国际版）。" +
						"其余厂商走各自官方账单接口。",
				),
			);
		}

		/**
		 * No required service at all.
		 *
		 * A client entry whose fiber never becomes active aborts the whole web boot,
		 * so this bundle deliberately requires nothing: even the slot registry it
		 * registers into is reached through `ctx.inject` inside `apply`. A service
		 * that is renamed, moved, or absent can therefore only cost this plugin its
		 * own features — never the page.
		 */
		const inject = [];

		/**
		 * Register the sidebar card, the composer pill, the conversation sensor, and
		 * the settings tab.
		 *
		 * `ctx.inject` starts a child fiber that waits for a service without ever
		 * holding this entry back, so a missing dependency costs one lookup and
		 * nothing else.
		 * @param ctx - owning client plugin context.
		 */
		function apply(ctx) {
			const optional = createSlot(undefined);
			const session = createSlot(undefined);
			const settingsStore = createSettingsStore();
			settingsStore.load();

			ctx.inject(["modelDirectories"], (scope) => {
				optional.set({ models: scope.modelDirectories });
			});

			ctx.inject(["slots"], (scope) => {
				scope.slots.inject(SESSION_SLOT, () =>
					scope.slots.register(
						{
							name: SESSION_SLOT,
							id: "balance-monitor-session",
							order: 100,
							inject: (sessionId) => ({ sessionId }),
						},
						(props) =>
							React.createElement(SessionSensor, { sessionId: props.sessionId, slot: session }),
					),
				);

				scope.slots.inject(OVERLAY_SLOT, () =>
					scope.slots.register(
						{ name: OVERLAY_SLOT, id: "balance-monitor", order: 50, label: "余额" },
						() => React.createElement(BalanceMonitor, { optional, session, settingsStore }),
					),
				);

				// The sidebar slot is declared by the layout package; a dsh that does
				// not declare it simply never fires this callback, which costs the card
				// and nothing else.
				scope.slots.inject(SIDEBAR_SLOT, () =>
					scope.slots.register(
						{
							name: SIDEBAR_SLOT,
							id: "balance-sidebar-card",
							order: 40,
							label: "余额监测",
							inject: () => ({ optional, session, settingsStore }),
						},
						(props) =>
							React.createElement(SidebarBalanceSeat, {
								optional: props.optional,
								session: props.session,
								settingsStore: props.settingsStore,
								wide: props.wide,
							}),
					),
				);

				// One navigable section on the settings page, which is what makes the
				// options reachable without a profile patch or a restart.
				scope.slots.inject(SETTINGS_SECTION_SLOT, () =>
					scope.slots.register(
						{
							name: SETTINGS_SECTION_SLOT,
							id: "balance-monitor",
							order: 60,
							label: () => "余额监测",
							inject: () => ({ settingsStore }),
						},
						(props) =>
							React.createElement(BalanceSettingsSection, { settingsStore: props.settingsStore }),
					),
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.BalanceMonitor = BalanceMonitor;
		exports.SidebarBalanceCard = SidebarBalanceCard;
		exports.BalanceSettingsSection = BalanceSettingsSection;
		exports.ProviderSeat = ProviderSeat;
		exports.SessionSensor = SessionSensor;
		exports.unitOf = unitOf;
		exports.figure = figure;
		exports.creditsPercent = creditsPercent;
		return module.exports;
	},
});
