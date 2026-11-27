/**
 * dsh-balance-card 2.0 — 浏览器半边。
 *
 * 一个侧边栏卡片席位 + 一个设置页 section：
 * - 卡片跟随当前会话模型背后的厂商，读宿主 `/api/dsh-balance-card/v2/snapshot`；
 * - 点击原地展开明细面板，不再做输入框胶囊；
 * - 设置页三段：01 卡片样式 / 02 厂商监控 / 03 其他工具。
 *
 * 视觉是四套并行的「安静工具」：方格（默认）/ 圆环 / 线条 / 渐变。四套共享同一份
 * `cardModel()`，只换布局、表面、排印与进度语法；切换风格不重新请求、不改数字。
 *
 * ## 启动安全
 *
 * 与 1.x 相同：`inject` 为空。slot 注册表、模型目录都通过 `ctx.inject` 的子 fiber
 * 获取，任何一个服务缺席只会让本插件少一块 UI，不会让 web boot 失败。
 */
// 注册 id 必须等于 package.json 的 name；loader 只认这个 id。
window.__ModuleLoader__.load({
	id: "@utmotc/dsh-balance-card",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { createPortal } = require("react-dom");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** v2 路由。 */
		const SNAPSHOT_ROUTE = "/api/dsh-balance-card/v2/snapshot";
		const PROVIDERS_ROUTE = "/api/dsh-balance-card/v2/providers";
		const SETTINGS_ROUTE = "/api/dsh-balance-card/v2/settings";
		const REFRESH_ROUTE = "/api/dsh-balance-card/v2/refresh";
		const CREDENTIAL_ROUTE = "/api/dsh-balance-card/v2/credentials";
		const CREDENTIAL_TEST_ROUTE = "/api/dsh-balance-card/v2/credentials/test";
		const CREDENTIAL_CLEAR_ROUTE = "/api/dsh-balance-card/v2/credentials/clear";
		const TOOLS_ROUTE = "/api/dsh-balance-card/v2/tools";
		const THROTTLE_STATUS_ROUTE = "/api/dsh-balance-card/v2/throttle/status";
		const THROTTLE_RESET_ROUTE = "/api/dsh-balance-card/v2/throttle/reset";
		const EXPORT_ROUTE = "/api/dsh-balance-card/v2/export";
		const IMPORT_ROUTE = "/api/dsh-balance-card/v2/import";
		const DIAGNOSTICS_ROUTE = "/api/dsh-balance-card/v2/diagnostics";

		/** Slot 名称。 */
		const SESSION_SLOT = "conversation.input.right";
		const SIDEBAR_SLOT = "sidebar.footer.action";
		const SETTINGS_SECTION_SLOT = "settings.section";

		/** 设置页 section id（也是深链接用的 id）。 */
		const SECTION_ID = "balance-monitor";

		/** 样式 id。 */
		const STYLE_IDS = ["grid", "ring", "line", "gradient"];
		/** 风格显示名。 */
		const STYLE_NAMES = { grid: "方格", ring: "圆环", line: "线条", gradient: "渐变" };
		/** 迁移后的旧名说明。 */
		const STYLE_HINTS = {
			grid: "纸面 + 三格 + 十段条（默认）",
			ring: "极光底 + 58px 圆环",
			line: "等宽刻度 + 终端感",
			gradient: "磨砂柔光 + 4px 光线",
		};

		/** 厂商状态中文。 */
		const STATUS_TEXT = {
			ok: "正常",
			stale: "缓存",
			error: "失败",
			unconfigured: "未配置",
			disabled: "未监控",
			unsupported: "暂不支持",
			loading: "读取中",
			idle: "读取中",
		};

		/** 错误短句（卡片上只显示这一行）。 */
		const ERROR_SHORT = {
			unconfigured: "未配置凭据",
			unauthorized: "认证失败",
			expired: "登录已过期",
			forbidden: "无权访问",
			rate_limited: "查询被限流",
			network: "网络不可达",
			timeout: "请求超时",
			parse: "返回格式变化",
			unsupported: "暂不支持",
			no_reading: "没有额度数据",
			blocked: "接口被安全策略拒绝",
			server: "厂商服务异常",
		};

		/** 面板里的修复动作。 */
		const ERROR_ACTION = {
			unconfigured: "去配置",
			unauthorized: "更换凭据",
			expired: "重新登录",
			forbidden: "检查套餐",
			rate_limited: "稍后重试",
			network: "稍后重试",
			timeout: "稍后重试",
			parse: "查看诊断",
			no_reading: "查看诊断",
			server: "稍后重试",
		};

		/** 城市/本地时间格式。 */
		const MINUTE = 60_000;

		/** 状态点色调。 */
		function toneOf(model) {
			if (model.state === "ok") {
				if (model.percent !== null && model.percent <= 10) return "critical";
				if (model.percent !== null && model.percent < model.warnPercent) return "low";
				return "good";
			}
			if (model.state === "stale") return "muted";
			if (model.state === "loading") return "muted";
			if (model.state === "error") return "critical";
			return "muted";
		}

		/** 状态文字。 */
		function statusTextOf(model) {
			if (model.state === "loading") return "读取中";
			if (model.state === "error") return ERROR_SHORT[model.error?.code] ?? "失败";
			if (model.state === "stale") return "缓存";
			if (model.state === "unconfigured") return "未配置";
			if (model.state === "disabled") return "未监控";
			if (model.state === "unmapped") return "未监控";
			if (model.state === "unsupported") return "暂不支持";
			if (model.state === "empty") return "未开启";
			if (model.state === "ok") {
				const tone = toneOf(model);
				if (tone === "critical") return "临界";
				if (tone === "low") return "偏低";
				return "正常";
			}
			return "";
		}

		/**
		 * 一个最小可订阅 store（与 1.x 相同，避免依赖客户端 store 包的位置）。
		 * @param initial - 初始值。
		 * @returns `{ getSnapshot, subscribe, set }`。
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

		/** 空 store：让 useStore 在服务尚未注入时也保持固定的 hook 顺序。 */
		const EMPTY_STORE = {
			subscribe: () => () => {},
			getSnapshot: () => undefined,
		};

		/**
		 * 把外部 store 包成绑定过 `this` 的稳定对象。
		 *
		 * DSH 的 ObservableSnapshot 可能把 subscribe/getSnapshot 实现成方法；直接传
		 * `store.subscribe` 会丢 `this`。WeakMap 保证同一 store 的包装引用稳定，
		 * useSyncExternalStore 不会每次渲染都重订阅。
		 */
		const BOUND_STORES = new WeakMap();
		function boundStore(store) {
			if (store === undefined || store === null) return EMPTY_STORE;
			if (typeof store.subscribe !== "function" || typeof store.getSnapshot !== "function") return EMPTY_STORE;
			const existing = BOUND_STORES.get(store);
			if (existing !== undefined) return existing;
			const bound = {
				subscribe: (listener) => store.subscribe(listener),
				getSnapshot: () => store.getSnapshot(),
			};
			BOUND_STORES.set(store, bound);
			return bound;
		}

		/** React 18+ 的 external store 读取；旧版回退到直接读快照。 */
		function useStore(store) {
			const target = boundStore(store);
			if (typeof React.useSyncExternalStore === "function") {
				return React.useSyncExternalStore(target.subscribe, target.getSnapshot, target.getSnapshot);
			}
			return target.getSnapshot();
		}

		/** 读 JSON；失败返回 `{ ok:false, body:null }`。 */
		async function readJson(url, init) {
			try {
				const response = await fetch(url, {
					headers: { accept: "application/json", ...(init?.headers ?? {}) },
					cache: "no-store",
					...init,
				});
				const body = await response.json().catch(() => null);
				return { ok: response.ok, status: response.status, body };
			} catch (error) {
				return { ok: false, status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
			}
		}

		/** 发 JSON POST。 */
		async function postJson(url, value) {
			return readJson(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(value ?? {}),
			});
		}

		/**
		 * 深度合并设置补丁（只处理 vendors / tools / card 三类）。
		 * @param base - 当前设置。
		 * @param patch - 补丁。
		 * @returns 合并后的设置。
		 */
		function mergeSettings(base, patch) {
			const next = { ...base, ...patch };
			next.card = { ...(base.card ?? {}), ...(patch.card ?? {}) };
			next.vendors = { ...(base.vendors ?? {}) };
			for (const [id, part] of Object.entries(patch.vendors ?? {})) {
				next.vendors[id] = { ...(next.vendors[id] ?? {}), ...part };
			}
			const tools = { ...(base.tools ?? {}) };
			for (const [id, part] of Object.entries(patch.tools ?? {})) {
				const prior = tools[id] !== null && typeof tools[id] === 'object' ? tools[id] : {};
				tools[id] = { ...prior, ...part };
				if (part?.manual !== null && typeof part?.manual === 'object') {
					tools[id].manual = { ...(prior.manual ?? {}), ...part.manual };
				}
			}
			next.tools = tools;
			return next;
		}

		/**
		 * 钱包 store：一份快照 + 设置补丁 + 轮询。
		 *
		 * 卡片与设置页共享同一个实例；页面隐藏时停止轮询，回到前台立即补一次。
		 * @returns 钱包 store。
		 */
		function createWalletStore() {
			let snapshot = { status: "loading", data: null, error: null, settingsError: "", pending: 0 };
			const listeners = new Set();
			const publish = (next) => {
				snapshot = next;
				for (const listener of [...listeners]) listener();
			};
			let timer = null;
			let lastLoad = 0;
			let loading = false;
			let subscribers = 0;
			let wakeHandler = null;

			const schedule = () => {
				if (timer !== null) clearTimeout(timer);
				if (subscribers === 0 || document.visibilityState === "hidden") {
					timer = null;
					return;
				}
				const poll = snapshot.data?.settings?.card?.pollMs;
				const gap = typeof poll === "number" && poll >= 15_000 ? poll : 600_000;
				timer = setTimeout(() => {
					void load();
				}, gap);
			};

			const load = async () => {
				if (loading) return;
				loading = true;
				try {
					const answer = await readJson(SNAPSHOT_ROUTE);
					if (answer.ok && answer.body?.ok === true) {
						lastLoad = Date.now();
						publish({ ...snapshot, status: "ready", data: answer.body.value, error: null });
					} else if (snapshot.data === null) {
						publish({
							...snapshot,
							status: "unavailable",
							error: answer.body?.error?.message ?? "无法读取余额快照。",
						});
					}
				} catch (error) {
					if (snapshot.data === null) {
						publish({ ...snapshot, status: "unavailable", error: error instanceof Error ? error.message : String(error) });
					}
				} finally {
					loading = false;
					schedule();
				}
			};

			/**
			 * 把设置里的厂商开关同步到快照行，避免开关要等下一次刷新才变。
			 * @param data - 当前快照。
			 * @param settings - 最新设置。
			 * @returns 同步后的快照。
			 */
			const syncVendorRows = (data, settings) => {
				if (data === null || data === undefined) return data;
				const vendors = (data.vendors ?? []).map((vendor) => ({
					...vendor,
					enabled: settings?.vendors?.[vendor.id]?.enabled === true,
					settings: settings?.vendors?.[vendor.id] ?? vendor.settings,
				}));
				return { ...data, vendors };
			};

			/**
			 * 应用设置补丁：先乐观更新，失败回滚并给出提示。
			 * @param partial - 补丁。
			 * @param options - `{ silent? }`。
			 * @returns 是否成功。
			 */
			const patch = async (partial, options = {}) => {
				const before = snapshot.data?.settings;
				if (before === undefined) return false;
				const optimistic = mergeSettings(before, partial);
				if (options.silent !== true) {
					publish({
						...snapshot,
						pending: snapshot.pending + 1,
						data: syncVendorRows({ ...snapshot.data, settings: optimistic }, optimistic),
					});
				}
				const answer = await postJson(SETTINGS_ROUTE, partial);
				if (answer.ok && answer.body?.ok === true) {
					const nextSettings = answer.body.value.settings;
					publish({
						...snapshot,
						pending: Math.max(0, snapshot.pending - 1),
						settingsError: "",
						data: syncVendorRows({ ...snapshot.data, settings: nextSettings }, nextSettings),
					});
					schedule();
					// 开关变了：宿主已作废该厂商缓存，主动补一次快照，让读数与状态跟上。
					if (partial.vendors !== undefined) void load();
					return true;
				}
				const message = answer.body?.error?.message ?? "设置保存失败。";
				publish({
					...snapshot,
					pending: Math.max(0, snapshot.pending - 1),
					settingsError: message,
					data: syncVendorRows({ ...snapshot.data, settings: before }, before),
				});
				return false;
			};

			/**
			 * 手动刷新：单家或全部。
			 * @param vendorId - 厂商 id；空串表示全部。
			 * @returns 响应体。
			 */
			const refresh = async (vendorId) => {
				publish({ ...snapshot, busyVendor: vendorId ?? "" });
				const answer = await postJson(REFRESH_ROUTE, vendorId ? { vendorId } : {});
				publish({ ...snapshot, busyVendor: "" });
				if (answer.ok && answer.body?.ok === true) {
					await load();
					return answer.body.value;
				}
				await load();
				return null;
			};

			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					subscribers += 1;
					if (subscribers === 1) {
						void load();
						const wake = () => {
							if (document.visibilityState === "visible") {
								if (lastLoad === 0 || Date.now() - lastLoad > (snapshot.data?.settings?.card?.pollMs ?? 600_000)) void load();
								schedule();
							} else if (timer !== null) {
								clearTimeout(timer);
								timer = null;
							}
						};
						wakeHandler = wake;
						document.addEventListener("visibilitychange", wake);
					}
					return () => {
						listeners.delete(listener);
						subscribers = Math.max(0, subscribers - 1);
						if (subscribers === 0) {
							if (timer !== null) clearTimeout(timer);
							timer = null;
							if (wakeHandler !== null) document.removeEventListener("visibilitychange", wakeHandler);
							wakeHandler = null;
						}
					};
				},
				load,
				patch,
				refresh,
			};
		}

		/**
		 * 从模型目录读取当前 provider（部分 DSH 版本提供该服务）。
		 * @param models - `modelDirectories` 服务（可选）。
		 * @param sessionId - 当前会话 id。
		 * @returns `{ provider }` 或 undefined。
		 */
		function useProviderFromCatalog(models, sessionId) {
			const [retry, setRetry] = React.useState(0);
			const catalogStore = models?.catalog?.store;
			useStore(catalogStore);
			let directory;
			if (models !== undefined && sessionId !== undefined && sessionId !== null) {
				try {
					directory = models.directoryFor(sessionId);
				} catch {
					directory = undefined;
				}
			}
			const directoryStore = directory?.store;
			useStore(directoryStore);
			React.useEffect(() => {
				if (directory === undefined) return;
				const started = directory.load();
				if (started !== undefined && typeof started.catch === "function") started.catch(() => {});
			}, [directory]);
			React.useEffect(() => {
				if (models === undefined) return;
				if (sessionId === undefined || sessionId === null || directory !== undefined) return;
				const timer = setTimeout(() => setRetry((current) => current + 1), 1000);
				return () => clearTimeout(timer);
			}, [models, sessionId, directory, retry]);

			const state = directoryStore?.getSnapshot();
			const selected = state?.current;
			if (typeof selected?.provider === "string" && selected.provider !== "") return { provider: selected.provider };
			const catalog = catalogStore?.getSnapshot();
			const fallback = catalog?.value?.default;
			if (typeof fallback?.provider === "string" && fallback.provider !== "") return { provider: fallback.provider };
			return undefined;
		}

		/**
		 * 每个 Session binding 只取一次 modelSelection 投影，保证 store 引用稳定。
		 */
		const SELECTION_PROJECTIONS = new WeakMap();
		function selectionProjectionOf(binding) {
			if (binding === undefined || binding === null) return undefined;
			if (SELECTION_PROJECTIONS.has(binding)) return SELECTION_PROJECTIONS.get(binding) ?? undefined;
			let projection;
			try {
				projection = binding.session?.projections?.faceOf?.("modelSelection");
			} catch {
				projection = undefined;
			}
			SELECTION_PROJECTIONS.set(binding, projection ?? null);
			return projection;
		}

		/**
		 * 从会话事件里找最近一次真实请求的 provider。
		 *
		 * 这是本 DSH 版本唯一稳定的来源：`request/context` 与 `assistant/message.source`
		 * 都带 `provider`，且会话 UI 会持续订阅事件窗口。模型目录服务缺席时不再显示
		 * 「当前厂商未监控」。
		 * @param sessions - 客户端 `sessions` 服务（可选）。
		 * @param sessionId - 当前会话 id。
		 * @returns `{ provider }` 或 undefined。
		 */
		function useProviderFromSession(sessions, sessionId) {
			const [retry, setRetry] = React.useState(0);
			let binding;
			if (sessions !== undefined && sessionId !== undefined && sessionId !== null) {
				try {
					binding = sessions.binding(sessionId);
				} catch {
					binding = undefined;
				}
			}
			const source = binding?.eventSource;
			const window = useStore(source);
			// 首选会话的 modelSelection 投影：它就是输入框模型选择器的当前值，
			// 不必等到下一条消息才更新。
			const projection = selectionProjectionOf(binding);
			const projected = useStore(projection);
			React.useEffect(() => {
				if (sessions === undefined || sessionId === undefined || sessionId === null) return;
				if (binding !== undefined) return;
				const timer = setTimeout(() => setRetry((current) => current + 1), 800);
				return () => clearTimeout(timer);
			}, [sessions, sessionId, binding, retry]);
			const selected = projected?.next ?? projected?.current ?? projected;
			if (typeof selected?.provider === "string" && selected.provider !== "") {
				return { provider: selected.provider };
			}

			const entries = Array.isArray(window?.entries) ? window.entries : [];
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				const event = entry?.event !== undefined ? entry.event : entry;
				const type = event?.type;
				let provider = "";
				if (type === "request/context") provider = event?.data?.provider ?? "";
				else if (type === "request/header") provider = event?.data?.header?.config?.provider ?? "";
				else if (type === "assistant/message") provider = event?.data?.message?.source?.provider ?? "";
				if (typeof provider === "string" && provider !== "") return { provider };
			}
			return undefined;
		}

		/**
		 * 当前会话的 provider route。
		 *
		 * 优先级：会话事件（最近一次真实请求）→ 模型目录（旧版 DSH）→ 宿主快照里的
		 * 最近请求兜底。都不猜。
		 * @param services - `{ models?, sessions? }`。
		 * @param sessionId - 当前会话 id。
		 * @returns `{ provider }` 或 undefined。
		 */
		function useCurrentProvider(services, sessionId) {
			const fromSession = useProviderFromSession(services?.sessions, sessionId);
			const fromCatalog = useProviderFromCatalog(services?.models, sessionId);
			return fromSession ?? fromCatalog;
		}

		/**
		 * 把 route 映射成厂商 id（宿主下发的 routeMap）。
		 * @param data - 快照。
		 * @param route - provider route。
		 * @returns 厂商 id 或空串。
		 */
		function vendorIdOf(data, route) {
			if (typeof route !== "string" || route === "") return "";
			const key = route.toLowerCase();
			const map = data?.meta?.routeMap ?? {};
			const exact = map[key];
			if (typeof exact === "string" && exact !== "") return exact;
			// 用户自定义 provider 路由（baiduqianfanlyq / baiduqianfan-utmotc …）：
			// 宿主下发的同一张前缀表，后缀只接受账号式字符。
			const prefixes = Array.isArray(data?.meta?.routePrefixes) ? data.meta.routePrefixes : [];
			for (const entry of prefixes) {
				if (!Array.isArray(entry) || entry.length < 2) continue;
				const lead = entry[0];
				const id = entry[1];
				if (typeof lead !== "string" || lead === "" || !key.startsWith(lead) || key.length === lead.length) continue;
				if (/^[a-z0-9_-]+$/u.test(key.slice(lead.length))) return id;
			}
			return "";
		}

		/** 数字格式化。 */
		function grouped(value) {
			const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
			return Math.round(number).toLocaleString("zh-CN");
		}

		/** 两位小数 + 千位分隔。 */
		function money(value) {
			const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
			return number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		}

		/** 百分比字符串。 */
		function percentText(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return value.toFixed(2) + "%";
		}

		/**
		 * 把读数拆成卡片需要的三段：前缀 / 主数字 / 单位。
		 * @param reading - 归一化读数。
		 * @param settings - 设置。
		 * @returns `{ prefix, main, suffix, percent, compactMain }`。
		 */
		function figureOf(reading, settings) {
			if (reading === null || reading === undefined) {
				return { prefix: "", main: "—", suffix: "", percent: null };
			}
			const currency = settings?.card?.currencyStyle ?? "symbol";
			const group = settings?.card?.groupDigits !== false;
			const unit = typeof reading.unit === "string" ? reading.unit : "";
			const value = reading.remaining;
			if (unit === "%") {
				return { prefix: "", main: percentText(value).replace("%", ""), suffix: "%", percent: value };
			}
			if (kindIsMoney(reading) && (unit === "¥" || unit === "$")) {
				const digits = group ? money(value) : value.toFixed(2);
				return {
					prefix: currency === "plain" ? "" : unit,
					main: digits,
					suffix: currency === "plain" ? unit : "",
					percent: reading.percent,
				};
			}
			const main = group && Math.abs(value) >= 1000 ? grouped(value) : String(Math.round(value * 100) / 100);
			return { prefix: "", main, suffix: unit, percent: reading.percent };
		}

		/** 读数是不是金额型。 */
		function kindIsMoney(reading) {
			return reading?.kind === "currency";
		}

		/** 相对时间。 */
		function relativeTime(at) {
			if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "—";
			const gap = Date.now() - at;
			if (gap < 45_000) return "刚刚";
			if (gap < 3_600_000) return Math.max(1, Math.round(gap / MINUTE)) + " 分钟前";
			if (gap < 86_400_000) return Math.round(gap / 3_600_000) + " 小时前";
			return Math.round(gap / 86_400_000) + " 天前";
		}

		/** 绝对日期。 */
		function dateText(value) {
			if (typeof value !== "string" || value === "") return "—";
			const at = Date.parse(value);
			if (!Number.isFinite(at)) return "—";
			return new Date(at).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
		}

		/** 从读数和设置算出卡片显示的模型。 */
		function cardModel(data, route, settings) {
			if (data === null) {
				return { state: "loading", vendor: null, reading: null, percent: null, warnPercent: 20, error: null };
			}
			const vendorId = vendorIdOf(data, route);
			if (vendorId === "") {
				return { state: "unmapped", vendor: null, reading: null, percent: null, warnPercent: 20, error: null };
			}
			const vendor =
				(data.vendors ?? []).find((entry) => entry.id === vendorId) ??
				(data.unsupported ?? []).find((entry) => entry.id === vendorId) ??
				null;
			const record = data.readings?.[vendorId] ?? null;
			if (vendor === null) {
				return { state: "unmapped", vendor: null, reading: null, percent: null, warnPercent: 20, error: null };
			}
			const vendorSettings = settings?.vendors?.[vendorId] ?? { enabled: false };
			const alert = settings?.tools?.lowBalanceAlert;
			// 阈值只有一个来源：厂商覆盖 → 低余额告警 → 迁移前的 card.warnPercent。
			// 告警工具关闭时不染色（临界 10% 仍然保留）。
			const warnPercent =
				alert?.enabled === false
					? 0
					: vendorSettings.warnPercent ?? alert?.warnPercent ?? settings?.card?.warnPercent ?? 20;
			if (vendor.status === "unsupported") {
				return { state: "unsupported", vendor, reading: null, percent: null, warnPercent, error: null };
			}
			if (vendorSettings.enabled !== true) {
				return { state: "disabled", vendor, reading: record?.reading ?? null, percent: record?.reading?.percent ?? null, warnPercent, error: null };
			}
			if (record === null || record.status === "idle" || record.status === "loading") {
				return { state: "loading", vendor, reading: null, percent: null, warnPercent, error: null };
			}
			if (record.status === "unconfigured") {
				return { state: "unconfigured", vendor, reading: null, percent: null, warnPercent, error: record.error };
			}
			if (record.status === "error") {
				return { state: "error", vendor, reading: null, percent: null, warnPercent, error: record.error };
			}
			if (record.status === "stale") {
				return { state: "stale", vendor, reading: record.reading, percent: record.reading?.percent ?? null, warnPercent, error: record.error, fetchedAt: record.fetchedAt };
			}
			return { state: "ok", vendor, reading: record.reading, percent: record.reading?.percent ?? null, warnPercent, error: null, fetchedAt: record.fetchedAt };
		}

		/** 副标题：套餐/窗口。 */
		function subtitleOf(model) {
			const vendor = model.vendor;
			if (vendor === null) return "";
			const reading = model.reading;
			if (reading?.windows?.length > 1) return reading.windows.length + " 个窗口";
			const window = reading?.windows?.[0];
			if (window?.label) return window.label;
			if (reading?.note) return reading.note;
			return vendor.display?.unit ?? "";
		}

		/* =====================================================================
		 * CSS
		 * ===================================================================== */
		const STYLE_ID = "dsh-balance-card/BalanceCardV2.css";
		const CSS = [
			/* ---- 基础 token ---- */
			".dbc-root{--dbc-paper:#FFFFFF;--dbc-paper2:#F7F8FA;--dbc-card:#FFFFFF;--dbc-cell:#F5F6F8;--dbc-ink:#0F1115;--dbc-ink2:#61666B;--dbc-ink3:#8A9096;--dbc-ink4:#B4B9BF;--dbc-line:rgba(15,17,21,.07);--dbc-line2:rgba(15,17,21,.12);--dbc-accent:#0F1115;--dbc-success:#22C55E;--dbc-amber:#F59E0B;--dbc-vermilion:#EC1313;--dbc-radius:20px;--dbc-shadow:0 1px 2px rgba(15,17,21,.05),0 8px 20px -18px rgba(15,17,21,.25);font:inherit;color:var(--dbc-ink);text-align:left;width:100%;min-width:0;box-sizing:border-box}",
			".dbc-root[data-dark=true]{--dbc-paper:#151517;--dbc-paper2:#232324;--dbc-card:#232324;--dbc-cell:#2C2C2E;--dbc-ink:#F9FAFB;--dbc-ink2:#CFD3D6;--dbc-ink3:#9BA1A6;--dbc-ink4:#6B7076;--dbc-line:rgba(255,255,255,.08);--dbc-line2:rgba(255,255,255,.14);--dbc-accent:#F9FAFB;--dbc-success:#4ED17E;--dbc-amber:#FBBF24;--dbc-vermilion:#F25A5A;--dbc-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 12px 26px -22px rgba(0,0,0,.85)}",
			".dbc-root *{box-sizing:border-box}",
			".dbc-mono{font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-variant-numeric:tabular-nums}",
			".dbc-serif{font-family:Georgia,'Songti SC','SimSun',serif}",
			/* ---- 卡片外壳 ---- */
			".dbc-card{position:relative;display:flex;flex-direction:column;width:100%;min-width:0;margin:0 0 4px;padding:12px 13px 11px;border:1px solid transparent;border-radius:var(--dbc-radius);background:var(--dbc-card);color:var(--dbc-ink);font:inherit;text-align:left;cursor:pointer;appearance:none;-webkit-appearance:none;transition:transform 160ms ease,box-shadow 160ms ease,border-color 160ms ease,background 160ms ease}",
			".dbc-card:hover{transform:translateY(-1px)}",
			".dbc-card:focus-visible{outline:2px solid var(--dbc-accent);outline-offset:2px}",
			".dbc-card:active{transform:none}",
			".dbc-head{display:flex;align-items:center;gap:8px;min-width:0}",
			".dbc-badge{flex:none;width:18px;height:18px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;letter-spacing:0;color:var(--dbc-accent);background:color-mix(in srgb,var(--dbc-accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--dbc-accent) 26%,transparent)}",
			".dbc-nameWrap{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}",
			".dbc-name{font-size:12.5px;line-height:16px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dbc-sub{font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-size:7.5px;line-height:10px;letter-spacing:.045em;text-transform:uppercase;color:var(--dbc-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dbc-status{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:9px;line-height:12px;color:var(--dbc-ink3);white-space:nowrap}",
			".dbc-dot{width:5px;height:5px;border-radius:50%;background:var(--dbc-ink4);display:inline-block}",
			".dbc-tone-good .dbc-dot,.dbc-dot.dbc-tone-good{background:var(--dbc-accent)}",
			".dbc-tone-low .dbc-dot,.dbc-dot.dbc-tone-low{background:var(--dbc-amber)}",
			".dbc-tone-critical .dbc-dot,.dbc-dot.dbc-tone-critical{background:var(--dbc-vermilion)}",
			".dbc-tone-muted .dbc-dot,.dbc-dot.dbc-tone-muted{background:var(--dbc-ink4)}",
			".dbc-amount{display:flex;align-items:baseline;gap:4px;min-width:0;font-variant-numeric:tabular-nums;letter-spacing:-.045em}",
			".dbc-prefix{font-size:.55em;font-weight:600;color:var(--dbc-ink2);letter-spacing:0}",
			".dbc-suffix{font-size:.42em;font-weight:600;color:var(--dbc-ink3);letter-spacing:0;margin-left:2px}",
			".dbc-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;font-size:9.5px;line-height:13px;color:var(--dbc-ink3);min-width:0}",
			".dbc-foot span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dbc-foot .dbc-right{flex:none;color:var(--dbc-ink4);font-variant-numeric:tabular-nums}",
			/* ---- 方格（纸面 + 三格 + 十段条） ---- */
			".dbc-style-grid{background:#FCFCF8;border-color:#E4E5DB;border-radius:20px;box-shadow:0 1px 0 rgba(255,255,255,.8) inset,0 1px 1px rgba(30,40,30,.04),0 22px 40px -32px rgba(30,40,30,.45);padding:12px 13px 10px 17px}",
			".dbc-style-grid::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--dbc-accent);opacity:.9}",
			".dbc-style-grid.dbc-tone-low::before{background:var(--dbc-amber)}",
			".dbc-style-grid.dbc-tone-critical::before{background:var(--dbc-vermilion)}",
			".dbc-root[data-dark=true] .dbc-style-grid{background:radial-gradient(120% 130% at 100% 0%,rgba(77,62,142,.34),transparent 58%),linear-gradient(150deg,#161A2A 0%,#12151F 100%);border-color:#2C2E3C}",
			".dbc-grid-cells{display:grid;grid-template-columns:1fr 1fr 1.12fr;gap:6px;margin-top:9px}",
			".dbc-cell{min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:4px;padding:8px 9px 7px;border:1px solid #E4E5DB;border-radius:10px;background:rgba(255,255,255,.72);box-shadow:0 1px 0 rgba(255,255,255,.75) inset}",
			".dbc-root[data-dark=true] .dbc-cell{background:rgba(255,255,255,.055);border-color:rgba(255,255,255,.09);box-shadow:none}",
			".dbc-cell-label{font-family:var(--dbc-mono-font,'Cascadia Mono','Consolas',monospace);font-size:7px;line-height:10px;letter-spacing:.04em;color:var(--dbc-ink4);white-space:nowrap}",
			".dbc-cell-value{font-size:20px;line-height:23px;font-weight:650;letter-spacing:-.045em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:baseline;gap:3px}",
			".dbc-cell-pct{font-size:16px;line-height:19px;font-weight:650;letter-spacing:-.035em}",
			".dbc-cell:nth-child(3){background:var(--dbc-accent-soft,rgba(47,107,93,.08));border-color:var(--dbc-accent-line,rgba(47,107,93,.18))}",
			".dbc-root[data-dark=true] .dbc-cell:nth-child(3){background:linear-gradient(145deg,rgba(82,65,162,.42),rgba(255,255,255,.035));border-color:rgba(145,120,255,.22)}",
			".dbc-grid-bar{display:flex;gap:2px;height:6px;margin-top:9px}",
			".dbc-grid-bar i{display:block;flex:1 1 0;min-width:0;height:100%;border-radius:2px;background:rgba(30,40,30,.09)}",
			".dbc-root[data-dark=true] .dbc-grid-bar i{background:#2C2E3C}",
			".dbc-grid-bar i.on{background:linear-gradient(90deg,color-mix(in srgb,var(--dbc-accent) 72%,#50695f),var(--dbc-accent))}",
			".dbc-grid-bar i.part{background:linear-gradient(90deg,var(--dbc-accent) var(--fill,0%),rgba(30,40,30,.09) var(--fill,0%))}",
			".dbc-grid-bar i.on.dbc-low,.dbc-grid-bar i.part.dbc-low{background:linear-gradient(90deg,color-mix(in srgb,var(--dbc-amber) 70%,#C28A3F),var(--dbc-amber))}",
			".dbc-grid-bar i.on.dbc-critical,.dbc-grid-bar i.part.dbc-critical{background:linear-gradient(90deg,color-mix(in srgb,var(--dbc-vermilion) 70%,#8A3226),var(--dbc-vermilion))}",
			".dbc-root[data-dark=true] .dbc-grid-bar i.on{background:linear-gradient(90deg,#7796FF,#A17BFF)}",
			".dbc-root[data-dark=true] .dbc-grid-bar i.part{background:linear-gradient(90deg,#A17BFF var(--fill,0%),#2C2E3C var(--fill,0%))}",
			".dbc-style-grid.compact{padding:11px 12px 9px 16px}",
			".dbc-style-grid.compact .dbc-grid-cells{gap:5px;margin-top:8px}",
			".dbc-style-grid.compact .dbc-cell{padding:7px 7px 6px}",
			".dbc-style-grid.compact .dbc-cell-value{font-size:15px;line-height:19px}",
			".dbc-style-grid.compact .dbc-cell-pct{font-size:13.5px;line-height:17px}",
			".dbc-style-grid.compact .dbc-cell-label{font-size:6.5px}",
			".dbc-style-grid.compact .dbc-grid-bar{height:5px}",
			/* ---- 圆环（极光 + 58px 环） ---- */
			".dbc-style-ring{--dbc-ring-ink:#1B2440;--dbc-ring-ink2:#4F5A78;--dbc-ring-sub:#7B86A1;--dbc-ring-line:rgba(91,116,170,.18);color:var(--dbc-ring-ink);background:linear-gradient(135deg,#FBFDFF 0%,#EDF3FF 46%,#F7F3FF 100%);border-color:rgba(125,155,220,.32);border-radius:20px;box-shadow:0 1px 0 rgba(255,255,255,.9) inset,0 18px 38px -28px rgba(57,79,145,.42);padding:14px 15px 12px;overflow:hidden}",
			".dbc-style-ring::before,.dbc-style-ring::after{content:'';position:absolute;pointer-events:none}",
			".dbc-style-ring::before{width:84%;height:210%;left:-34%;top:-92%;border-radius:46% 54% 58% 42%/58% 44% 56% 42%;background:linear-gradient(120deg,rgba(162,190,255,.42),rgba(162,190,255,.10) 58%,transparent 100%);transform:rotate(-9deg)}",
			".dbc-style-ring::after{width:68%;height:180%;right:-28%;bottom:-78%;border-radius:55% 45% 42% 58%/46% 56% 44% 54%;background:linear-gradient(200deg,rgba(196,180,255,.28),rgba(196,180,255,.06) 56%,transparent 100%);transform:rotate(12deg)}",
			".dbc-root[data-dark=true] .dbc-style-ring{--dbc-ring-ink:#F1F3FF;--dbc-ring-ink2:#C3C8E6;--dbc-ring-sub:#929AC0;--dbc-ring-line:rgba(145,165,235,.2);background:linear-gradient(135deg,#171C38 0%,#1C1D46 48%,#241E45 100%);border-color:rgba(125,150,225,.24);box-shadow:0 1px 0 rgba(255,255,255,.07) inset,0 24px 44px -30px rgba(0,0,0,.9)}",
			".dbc-style-ring>*{position:relative;z-index:1}",
			".dbc-style-ring .dbc-name,.dbc-style-ring .dbc-amount{color:var(--dbc-ring-ink)}",
			".dbc-style-ring .dbc-sub,.dbc-style-ring .dbc-status,.dbc-style-ring .dbc-foot{color:var(--dbc-ring-sub)}",
			".dbc-style-ring .dbc-badge{background:rgba(255,255,255,.62);border:0;color:#3F5C8E;box-shadow:0 1px 0 rgba(255,255,255,.8) inset,0 0 0 1px rgba(120,150,210,.18)}",
			".dbc-root[data-dark=true] .dbc-style-ring .dbc-badge{background:rgba(255,255,255,.10);color:#C9D6FF}",
			".dbc-style-ring .dbc-ring-body{display:flex;align-items:center;gap:0;margin-top:10px;min-width:0}",
			".dbc-style-ring .dbc-ring-main{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}",
			".dbc-style-ring .dbc-ring-amount{font-size:31px;line-height:34px;font-weight:680;letter-spacing:-.05em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dbc-ring-ink)}",
			".dbc-style-ring .dbc-ring-mid{flex:none;display:flex;flex-direction:column;gap:6px;margin:0 14px;padding-left:14px;border-left:1px solid var(--dbc-ring-line)}",
			".dbc-style-ring .dbc-stat{display:flex;flex-direction:column;gap:0;min-width:0}",
			".dbc-style-ring .dbc-ring-mid .dbc-k{font-family:var(--dbc-mono-font,'Cascadia Mono','Consolas',monospace);font-size:7px;line-height:10px;letter-spacing:.04em;color:var(--dbc-ring-sub)}",
			".dbc-style-ring .dbc-ring-mid .dbc-v{font-size:11px;line-height:15px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dbc-ring-ink2);white-space:nowrap}",
			".dbc-style-ring .dbc-ring-wrap{position:relative;flex:none;width:58px;height:58px;display:grid;place-items:center}",
			".dbc-style-ring .dbc-ring-pct{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11.5px;line-height:14px;font-weight:650;letter-spacing:-.03em;color:var(--dbc-ring-ink);font-variant-numeric:tabular-nums}",
			".dbc-style-ring .dbc-ring-pct span{font-size:6.5px;line-height:9px;letter-spacing:.02em;color:var(--dbc-ring-sub);font-weight:500}",
			".dbc-style-ring.compact{padding:12px 13px 10px}",
			".dbc-style-ring.compact .dbc-ring-amount{font-size:29px}",
			".dbc-style-ring.compact .dbc-ring-mid{display:none}",
			/* ---- 线条（等宽 + 刻度） ---- */
			".dbc-style-line{background:#F7F7F3;border-color:#D9D9D1;border-radius:7px;box-shadow:none;padding:11px 12px 9px}",
			".dbc-root[data-dark=true] .dbc-style-line{background:#1A1B16;border-color:#34352C}",
			".dbc-line-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:var(--dbc-mono-font,'Cascadia Mono','Consolas',monospace);font-size:9.5px;line-height:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--dbc-ink2)}",
			".dbc-line-head .dbc-live{color:var(--dbc-ink3);display:inline-flex;align-items:center;gap:4px;font-size:7.5px;letter-spacing:.08em}",
			".dbc-line-head .dbc-live::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--dbc-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dbc-accent) 14%,transparent)}",
			".dbc-line-amount{font-family:var(--dbc-mono-font,'Cascadia Mono','Consolas',monospace);font-size:25px;line-height:28px;font-weight:500;letter-spacing:-.055em;margin-top:8px;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:5px;color:var(--dbc-ink)}",
			".dbc-line-amount .dbc-suffix{font-family:var(--dbc-mono-font,'Cascadia Mono','Consolas',monospace);font-size:8px;letter-spacing:.02em;color:var(--dbc-ink3)}",
			".dbc-ticks{position:relative;height:7px;margin-top:9px;border-radius:1px;background:repeating-linear-gradient(90deg,#D9D9D1 0 1px,transparent 1px 4px);overflow:hidden}",
			".dbc-root[data-dark=true] .dbc-ticks{background:repeating-linear-gradient(90deg,#34352C 0 1px,transparent 1px 4px)}",
			".dbc-ticks i{display:block;height:100%;border-radius:1px;background:repeating-linear-gradient(90deg,#3A3A32 0 1px,transparent 1px 4px)}",
			".dbc-root[data-dark=true] .dbc-ticks i{background:repeating-linear-gradient(90deg,#A9A99C 0 1px,transparent 1px 4px)}",
			".dbc-ticks i.dbc-low{background:repeating-linear-gradient(90deg,var(--dbc-amber) 0 1px,transparent 1px 4px)}",
			".dbc-ticks i.dbc-critical{background:repeating-linear-gradient(90deg,var(--dbc-vermilion) 0 1px,transparent 1px 4px)}",
			".dbc-line-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;padding-top:6px;border-top:1px solid #DEDED6;font-family:var(--dbc-mono-font,'Cascadia Mono','Consolas',monospace);font-size:7.5px;line-height:10px;letter-spacing:.04em;color:var(--dbc-ink4);text-transform:uppercase}",
			".dbc-root[data-dark=true] .dbc-line-foot{border-top-color:#34352C}",
			/* ---- 渐变（磨砂 + 柔光线） ---- */
			".dbc-style-gradient{padding:12px 13px 11px;border-color:rgba(255,255,255,.82);border-radius:18px;background:linear-gradient(145deg,rgba(253,255,252,.88),rgba(235,245,240,.66)),radial-gradient(120% 80% at 0% 0%,rgba(202,231,220,.35),transparent 62%);box-shadow:0 1px 0 rgba(255,255,255,.98) inset,0 1px 1px rgba(30,40,35,.04),0 22px 44px -30px rgba(30,40,35,.5);backdrop-filter:blur(18px) saturate(1.08);-webkit-backdrop-filter:blur(18px) saturate(1.08)}",
			".dbc-style-gradient::before{content:'';position:absolute;inset:0;border-radius:inherit;background:radial-gradient(110% 70% at 8% 0%,rgba(255,255,255,.8),transparent 58%),linear-gradient(180deg,rgba(255,255,255,.18),transparent 40%);pointer-events:none}",
			".dbc-root[data-dark=true] .dbc-style-gradient{background:linear-gradient(145deg,rgba(46,45,40,.92),rgba(35,35,31,.9)),radial-gradient(120% 80% at 0% 0%,rgba(255,255,255,.06),transparent 62%);border-color:rgba(255,255,255,.14);box-shadow:0 1px 0 rgba(255,255,255,.08) inset,0 24px 44px -32px rgba(0,0,0,.9)}",
			".dbc-style-gradient>*{position:relative;z-index:1}",
			".dbc-style-gradient .dbc-badge{border-color:rgba(255,255,255,.8);background:rgba(255,255,255,.45);color:#2F6B5D;border-radius:7px;box-shadow:0 1px 0 rgba(255,255,255,.8) inset}",
			".dbc-root[data-dark=true] .dbc-style-gradient .dbc-badge{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#8CC7B6}",
			".dbc-style-gradient .dbc-gradient-amount{font-size:28px;line-height:32px;font-weight:650;letter-spacing:-.045em;margin-top:8px;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dbc-ink)}",
			".dbc-style-gradient .dbc-foot{font-family:var(--dbc-sans-font,system-ui,sans-serif);font-size:8px;letter-spacing:.01em;margin-top:9px;color:var(--dbc-ink4)}",
			".dbc-glow{height:4px;border-radius:4px;background:rgba(30,50,42,.09);margin-top:9px;overflow:hidden}",
			".dbc-root[data-dark=true] .dbc-glow{background:rgba(255,255,255,.1)}",
			".dbc-glow i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--dbc-accent),color-mix(in srgb,var(--dbc-accent) 45%,#FFFFFF));box-shadow:0 0 9px color-mix(in srgb,var(--dbc-accent) 35%,transparent)}",
			".dbc-glow i.dbc-low{background:linear-gradient(90deg,#B9863E,var(--dbc-amber));box-shadow:0 0 9px rgba(224,164,92,.25)}",
			".dbc-glow i.dbc-critical{background:linear-gradient(90deg,#8A3226,var(--dbc-vermilion));box-shadow:0 0 9px rgba(240,141,126,.25)}",
			/* ---- 空/错误态 ---- */
			".dbc-empty{display:flex;flex-direction:column;gap:3px;margin-top:12px;min-height:44px;justify-content:center}",
			".dbc-empty-dash{font-size:30px;line-height:32px;font-weight:600;color:var(--dbc-ink3);letter-spacing:-.02em}",
			".dbc-empty-text{font-size:11.5px;line-height:16px;color:var(--dbc-ink2)}",
			".dbc-empty-hint{font-size:9.5px;line-height:13px;color:var(--dbc-ink4)}",
			".dbc-skeleton{height:14px;border-radius:4px;background:color-mix(in srgb,var(--dbc-ink) 8%,transparent);margin-top:12px;animation:dbcPulse 1.4s ease-in-out infinite}",
			"@keyframes dbcPulse{0%,100%{opacity:.55}50%{opacity:1}}",
			/* ---- 窄栏 ---- */
			".dbc-rail{display:flex;align-items:center;justify-content:center;width:40px;height:40px;margin:0 auto 6px;border-radius:11px;border:1px solid var(--dbc-line);background:var(--dbc-card);cursor:pointer;position:relative;padding:0}",
			".dbc-rail:focus-visible{outline:2px solid var(--dbc-accent);outline-offset:2px}",
			".dbc-rail-badge{font-size:11px;font-weight:700;color:var(--dbc-accent)}",
			".dbc-rail-ring{position:absolute;inset:0}",
			/* ---- 面板 ---- */
			".dbc-panel{position:fixed;z-index:2147483000;width:min(386px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:var(--dbc-card);color:var(--dbc-ink);border:1px solid var(--dbc-line2);border-radius:16px;box-shadow:0 24px 60px -24px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.08);padding:14px 15px 12px;animation:dbcPanel 120ms ease}",
			"@keyframes dbcPanel{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}",
			".dbc-panel-head{display:flex;align-items:center;gap:9px}",
			".dbc-panel-close{margin-left:auto;width:24px;height:24px;border:0;background:transparent;color:var(--dbc-ink3);cursor:pointer;border-radius:6px;font-size:16px;line-height:1}",
			".dbc-panel-close:hover{background:color-mix(in srgb,var(--dbc-ink) 6%,transparent);color:var(--dbc-ink)}",
			".dbc-panel-hero{display:flex;align-items:baseline;gap:8px;margin-top:12px}",
			".dbc-panel-amount{font-family:Georgia,'Songti SC','SimSun',serif;font-size:34px;line-height:38px;font-weight:400;letter-spacing:-.02em;font-variant-numeric:tabular-nums}",
			".dbc-panel-pct{margin-left:auto;font-size:13px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--dbc-ink2)}",
			".dbc-panel-rows{margin-top:11px;border-top:1px solid var(--dbc-line)}",
			".dbc-panel-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--dbc-line);font-size:10.5px;line-height:14px}",
			".dbc-panel-row .dbc-k{color:var(--dbc-ink3);white-space:nowrap}",
			".dbc-panel-row .dbc-v{color:var(--dbc-ink);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}",
			".dbc-window{margin-top:11px;padding-top:9px;border-top:1px solid var(--dbc-line)}",
			".dbc-window-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;line-height:14px}",
			".dbc-window-title b{font-weight:600}",
			".dbc-window-bar{height:3px;border-radius:3px;background:color-mix(in srgb,var(--dbc-ink) 10%,transparent);margin-top:5px;overflow:hidden}",
			".dbc-window-bar i{display:block;height:100%;border-radius:3px;background:var(--dbc-accent)}",
			".dbc-window-bar i.dbc-low{background:var(--dbc-amber)}",
			".dbc-window-bar i.dbc-critical{background:var(--dbc-vermilion)}",
			".dbc-window-meta{display:flex;justify-content:space-between;gap:8px;margin-top:4px;font-size:9.5px;line-height:13px;color:var(--dbc-ink3);font-variant-numeric:tabular-nums}",
			".dbc-panel-alert{margin-top:9px;padding:7px 9px;border-radius:8px;background:color-mix(in srgb,var(--dbc-amber) 10%,transparent);border:1px solid color-mix(in srgb,var(--dbc-amber) 26%,transparent);color:var(--dbc-amber);font-size:10px;line-height:14px}",
			".dbc-panel-error{margin-top:10px;padding:9px 10px;border-radius:9px;background:color-mix(in srgb,var(--dbc-vermilion) 7%,transparent);border:1px solid color-mix(in srgb,var(--dbc-vermilion) 22%,transparent)}",
			".dbc-panel-error b{display:block;font-size:11px;line-height:15px;color:var(--dbc-vermilion)}",
			".dbc-panel-error p{margin:3px 0 0;font-size:9.5px;line-height:14px;color:var(--dbc-ink2)}",
			".dbc-panel-actions{display:flex;align-items:center;gap:10px;margin-top:12px}",
			".dbc-btn{border:1px solid var(--dbc-line2);background:transparent;color:var(--dbc-ink);border-radius:8px;padding:6px 11px;font:inherit;font-size:10.5px;line-height:14px;cursor:pointer;transition:background 160ms ease,border-color 160ms ease}",
			".dbc-btn:hover{background:color-mix(in srgb,var(--dbc-ink) 5%,transparent)}",
			".dbc-btn:focus-visible{outline:2px solid var(--dbc-accent);outline-offset:1px}",
			".dbc-btn-primary{background:var(--dbc-ink);border-color:var(--dbc-ink);color:var(--dbc-card);font-weight:600}",
			".dbc-btn-primary:hover{background:color-mix(in srgb,var(--dbc-ink) 88%,transparent)}",
			".dbc-btn[disabled]{opacity:.5;cursor:default}",
			".dbc-link{border:0;background:transparent;color:var(--dbc-ink3);font:inherit;font-size:10px;cursor:pointer;padding:2px;text-decoration:underline;text-underline-offset:2px}",
			".dbc-link:hover{color:var(--dbc-ink)}",
			".dbc-spacer{flex:1}",
			/* ---- 设置页 ---- */
			".dbc-settings{max-width:1080px;width:100%;color:var(--dbc-ink);font:inherit;padding-bottom:24px}",
			".dbc-settings-head{display:flex;flex-direction:column;gap:4px;margin-bottom:14px}",
			".dbc-kicker{font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-size:9px;line-height:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dbc-ink3)}",
			".dbc-settings-title{font-family:inherit;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.01em;margin:0;display:flex;align-items:baseline;gap:10px}",
			".dbc-saved{margin-left:auto;font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-size:9px;line-height:12px;letter-spacing:.06em;color:var(--dbc-accent);display:inline-flex;align-items:center;gap:4px}",
			".dbc-saved::before{content:'✓';font-size:10px}",
			".dbc-saved.dbc-busy{color:var(--dbc-ink3)}",
			".dbc-saved.dbc-error{color:var(--dbc-vermilion)}",
			".dbc-settings-hint{margin:0;font-size:11.5px;line-height:17px;color:var(--dbc-ink3);max-width:70ch}",
			".dbc-tabs{display:flex;align-items:center;gap:22px;border-bottom:1px solid var(--dbc-line);margin:14px 0 18px;position:sticky;top:0;background:transparent;z-index:5;padding-top:2px}",
			".dbc-tab{border:0;background:transparent;color:var(--dbc-ink3);font:inherit;font-size:12.5px;line-height:17px;padding:7px 1px 9px;cursor:pointer;display:inline-flex;align-items:baseline;gap:6px;border-bottom:2px solid transparent;margin-bottom:-1px}",
			".dbc-tab .dbc-num{font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-size:8.5px;letter-spacing:.06em;color:var(--dbc-ink4)}",
			".dbc-tab[data-active=true]{color:var(--dbc-ink);border-bottom-color:var(--dbc-ink)}",
			".dbc-tab[data-active=true] .dbc-num{color:var(--dbc-ink3)}",
			".dbc-tab:focus-visible{outline:2px solid var(--dbc-accent);outline-offset:2px}",
			".dbc-page{display:grid;grid-template-columns:292px minmax(0,1fr);gap:26px;align-items:start}",
			".dbc-page-single{display:flex;flex-direction:column;gap:14px}",
			".dbc-group{background:var(--dbc-card);border:1px solid var(--dbc-line);border-radius:12px;padding:4px 14px;margin-bottom:14px}",
			".dbc-group-title{font-size:11.5px;line-height:16px;font-weight:600;letter-spacing:.01em;margin:10px 0 2px}",
			".dbc-group-hint{font-size:10px;line-height:14px;color:var(--dbc-ink3);margin:0 0 8px}",
			".dbc-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--dbc-line)}",
			".dbc-group>.dbc-row:first-of-type{border-top:0}",
			".dbc-row-text{min-width:0;display:flex;flex-direction:column;gap:2px}",
			".dbc-row-label{font-size:11.5px;line-height:16px;color:var(--dbc-ink)}",
			".dbc-row-hint{font-size:9.5px;line-height:13px;color:var(--dbc-ink4)}",
			".dbc-row-control{flex:none;display:flex;align-items:center;gap:8px}",
			".dbc-row-wide .dbc-row-control{flex:1 0 100%;justify-content:flex-start}",
			".dbc-row-wide{flex-wrap:wrap}",
			".dbc-seg{display:inline-flex;border:1px solid var(--dbc-line2);border-radius:8px;padding:2px;gap:2px;background:color-mix(in srgb,var(--dbc-ink) 2%,transparent)}",
			".dbc-seg button{border:0;background:transparent;color:var(--dbc-ink3);font:inherit;font-size:10.5px;line-height:14px;padding:4px 9px;border-radius:6px;cursor:pointer}",
			".dbc-seg button[data-active=true]{background:var(--dbc-card);color:var(--dbc-ink);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:600}",
			".dbc-seg button:focus-visible{outline:2px solid var(--dbc-accent);outline-offset:0}",
			".dbc-switch{position:relative;width:32px;height:18px;border-radius:999px;border:1px solid var(--dbc-line2);background:color-mix(in srgb,var(--dbc-ink) 8%,transparent);cursor:pointer;padding:0;transition:background 160ms ease,border-color 160ms ease}",
			".dbc-switch .dbc-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dbc-card);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform 160ms ease}",
			".dbc-switch[aria-checked=true]{background:var(--dbc-accent);border-color:var(--dbc-accent)}",
			".dbc-switch[aria-checked=true] .dbc-knob{transform:translateX(14px)}",
			".dbc-switch:focus-visible{outline:2px solid var(--dbc-accent);outline-offset:2px}",
			".dbc-switch[disabled]{opacity:.45;cursor:default}",
			/* 预览列 */
			".dbc-preview-col{position:sticky;top:12px;display:flex;flex-direction:column;gap:10px}",
			".dbc-preview-frame{width:264px;max-width:100%;padding:14px 12px;border-radius:14px;background:var(--dbc-paper2);border:1px solid var(--dbc-line);display:flex;flex-direction:column;gap:10px}",
			".dbc-preview-caption{font-size:9px;line-height:13px;color:var(--dbc-ink4);text-align:center}",
			".dbc-style-picker{display:grid;grid-template-columns:1fr 1fr;gap:7px}",
			".dbc-style-option{border:1px solid var(--dbc-line);border-radius:10px;background:var(--dbc-card);padding:8px 9px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:2px;font:inherit}",
			".dbc-style-option[data-active=true]{border-color:var(--dbc-ink);box-shadow:0 0 0 1px var(--dbc-ink) inset}",
			".dbc-style-option b{font-size:11px;line-height:15px;font-weight:650;color:var(--dbc-ink)}",
			".dbc-style-option span{font-size:9px;line-height:12px;color:var(--dbc-ink4)}",
			".dbc-style-option:focus-visible{outline:2px solid var(--dbc-accent);outline-offset:1px}",
			/* 厂商页 */
			".dbc-summary{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 14px;background:var(--dbc-card);border:1px solid var(--dbc-line);border-radius:12px;margin-bottom:12px}",
			".dbc-stat{display:flex;flex-direction:column;gap:1px}",
			".dbc-stat b{font-size:18px;line-height:22px;font-weight:650;font-variant-numeric:tabular-nums}",
			".dbc-stat span{font-size:9px;line-height:12px;color:var(--dbc-ink4)}",
			".dbc-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}",
			".dbc-search{flex:1;min-width:180px;display:flex;align-items:center;gap:7px;border:1px solid var(--dbc-line2);border-radius:9px;padding:6px 9px;background:var(--dbc-card)}",
			".dbc-search input{border:0;background:transparent;outline:none;font:inherit;font-size:11.5px;color:var(--dbc-ink);width:100%}",
			".dbc-search input::placeholder{color:var(--dbc-ink4)}",
			".dbc-search svg{flex:none;color:var(--dbc-ink4)}",
			".dbc-group-head{display:flex;align-items:center;gap:8px;margin:16px 0 6px;font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-size:8.5px;line-height:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dbc-ink3)}",
			".dbc-group-head::after{content:'';flex:1;height:1px;background:var(--dbc-line)}",
			".dbc-vendor-list{border:1px solid var(--dbc-line);border-radius:12px;background:var(--dbc-card);overflow:hidden}",
			".dbc-vendor{border-top:1px solid var(--dbc-line)}",
			".dbc-vendor:first-child{border-top:0}",
			".dbc-vendor-row{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}",
			".dbc-vendor-row:hover{background:color-mix(in srgb,var(--dbc-ink) 2.5%,transparent)}",
			".dbc-vendor-main{min-width:0;flex:1;display:flex;align-items:center;gap:9px}",
			".dbc-vendor-badge{flex:none;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--dbc-accent);background:color-mix(in srgb,var(--dbc-accent) 11%,transparent);border:1px solid color-mix(in srgb,var(--dbc-accent) 22%,transparent)}",
			".dbc-vendor-text{min-width:0;display:flex;flex-direction:column;gap:1px}",
			".dbc-vendor-name{font-size:12px;line-height:16px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0}",
			".dbc-chip{flex:none;font-size:8px;line-height:11px;padding:1px 5px;border-radius:999px;border:1px solid var(--dbc-line2);color:var(--dbc-ink3);white-space:nowrap}",
			".dbc-chip.dbc-ok{color:var(--dbc-accent);border-color:color-mix(in srgb,var(--dbc-accent) 35%,transparent);background:color-mix(in srgb,var(--dbc-accent) 8%,transparent)}",
			".dbc-chip.dbc-bad{color:var(--dbc-vermilion);border-color:color-mix(in srgb,var(--dbc-vermilion) 32%,transparent);background:color-mix(in srgb,var(--dbc-vermilion) 7%,transparent)}",
			".dbc-chip.dbc-warn{color:var(--dbc-amber);border-color:color-mix(in srgb,var(--dbc-amber) 32%,transparent);background:color-mix(in srgb,var(--dbc-amber) 7%,transparent)}",
			".dbc-vendor-sub{font-size:9px;line-height:12px;color:var(--dbc-ink4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dbc-vendor-read{flex:none;text-align:right;display:flex;flex-direction:column;gap:1px;min-width:70px}",
			".dbc-vendor-read b{font-size:11.5px;line-height:15px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dbc-vendor-read span{font-size:9px;line-height:12px;color:var(--dbc-ink4);font-variant-numeric:tabular-nums}",
			".dbc-chev{flex:none;transition:transform 160ms ease;color:var(--dbc-ink4);width:14px;height:14px;display:flex;align-items:center;justify-content:center}",
			".dbc-chev[data-open=true]{transform:rotate(90deg)}",
			".dbc-vendor-body{padding:2px 12px 14px 47px;display:flex;flex-direction:column;gap:10px}",
			".dbc-cred{margin:0 0 2px;padding:9px 10px;border:1px solid var(--dbc-line);border-radius:9px;background:color-mix(in srgb,var(--dbc-ink) 2%,transparent);display:flex;flex-direction:column;gap:6px}",
			".dbc-cred-head{display:flex;align-items:center;gap:8px;font-size:10.5px;line-height:14px;min-width:0;flex-wrap:nowrap}",
			".dbc-cred-head b{font-weight:600;flex:none;white-space:nowrap}",
			".dbc-cred-head .dbc-mask{margin-left:auto;flex:0 1 auto;min-width:0;max-width:58%;font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-size:9px;letter-spacing:.03em;color:var(--dbc-ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}",
			".dbc-cred textarea,.dbc-cred input{width:100%;border:1px solid var(--dbc-line2);border-radius:7px;background:var(--dbc-card);color:var(--dbc-ink);font:inherit;font-size:10.5px;line-height:15px;padding:6px 8px;resize:vertical;outline:none}",
			".dbc-cred textarea:focus,.dbc-cred input:focus{border-color:var(--dbc-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dbc-accent) 18%,transparent)}",
			".dbc-cred-hint{font-size:9px;line-height:13px;color:var(--dbc-ink4)}",
			".dbc-cred-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
			".dbc-cred-result{font-size:9.5px;line-height:13px}",
			".dbc-cred-result.dbc-good{color:var(--dbc-accent)}",
			".dbc-cred-result.dbc-bad{color:var(--dbc-vermilion)}",
			".dbc-mini-btn{border:1px solid var(--dbc-line2);background:var(--dbc-card);color:var(--dbc-ink2);border-radius:7px;padding:4px 9px;font:inherit;font-size:9.5px;line-height:13px;cursor:pointer}",
			".dbc-mini-btn:hover{border-color:var(--dbc-ink3);color:var(--dbc-ink)}",
			".dbc-mini-btn.dbc-danger{color:var(--dbc-vermilion);border-color:color-mix(in srgb,var(--dbc-vermilion) 30%,transparent)}",
			".dbc-mini-btn[disabled]{opacity:.45;cursor:default}",
			".dbc-subhead{font-family:'Cascadia Mono','Consolas','SFMono-Regular',ui-monospace,monospace;font-size:8px;line-height:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dbc-ink4);margin-top:2px}",
			".dbc-inline-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}",
			".dbc-field{display:flex;flex-direction:column;gap:3px;font-size:9px;line-height:12px;color:var(--dbc-ink3)}",
			".dbc-field input,.dbc-field select{border:1px solid var(--dbc-line2);border-radius:7px;background:var(--dbc-card);color:var(--dbc-ink);font:inherit;font-size:10.5px;padding:4px 7px;outline:none}",
			".dbc-lastread{font-size:9px;line-height:13px;color:var(--dbc-ink4);font-variant-numeric:tabular-nums}",
			".dbc-empty-note{padding:8px 0;font-size:10px;line-height:14px;color:var(--dbc-ink4)}",
			".dbc-tools-footer{display:flex;align-items:center;gap:18px;margin-top:16px}",
			/* 工具页 */
			".dbc-tool{border:1px solid var(--dbc-line);border-radius:12px;background:var(--dbc-card);margin-bottom:12px;overflow:hidden}",
			".dbc-tool-row{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer}",
			".dbc-tool-row:hover{background:color-mix(in srgb,var(--dbc-ink) 2.5%,transparent)}",
			".dbc-tool-icon{flex:none;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dbc-accent) 10%,transparent);color:var(--dbc-accent)}",
			".dbc-tool-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
			".dbc-tool-name{font-size:12px;line-height:16px;font-weight:600;display:flex;align-items:center;gap:6px}",
			".dbc-tool-desc{font-size:9.5px;line-height:13px;color:var(--dbc-ink4)}",
			".dbc-tool-body{padding:2px 14px 14px 52px;display:flex;flex-direction:column;gap:10px}",
			".dbc-throttle-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}",
			".dbc-metric{padding:7px 9px;border-radius:8px;background:color-mix(in srgb,var(--dbc-ink) 3%,transparent);display:flex;flex-direction:column;gap:1px}",
			".dbc-metric span{font-size:8px;line-height:11px;letter-spacing:.05em;color:var(--dbc-ink4);text-transform:uppercase}",
			".dbc-metric b{font-size:13px;line-height:17px;font-weight:650;font-variant-numeric:tabular-nums}",
			".dbc-routes{border:1px solid var(--dbc-line);border-radius:8px;overflow:hidden}",
			".dbc-route-row{display:grid;grid-template-columns:1.2fr .7fr .7fr .6fr .8fr;gap:8px;padding:5px 8px;font-size:9px;line-height:13px;border-top:1px solid var(--dbc-line);font-variant-numeric:tabular-nums}",
			".dbc-route-row:first-child{border-top:0;background:color-mix(in srgb,var(--dbc-ink) 3%,transparent);color:var(--dbc-ink4)}",
			".dbc-slider{width:100%;accent-color:var(--dbc-accent)}",
			".dbc-empty-slot{border:1px dashed var(--dbc-line2);border-radius:12px;padding:14px;font-size:10px;line-height:14px;color:var(--dbc-ink4);text-align:center}",
			/* 暗色设置页 */
			".dbc-root[data-dark=true] .dbc-group,.dbc-root[data-dark=true] .dbc-vendor-list,.dbc-root[data-dark=true] .dbc-tool,.dbc-root[data-dark=true] .dbc-summary{background:var(--dbc-card);border-color:var(--dbc-line)}",
			".dbc-root[data-dark=true] .dbc-preview-frame{background:var(--dbc-paper2)}",
			/* ---- DSH 中立配色（以应用设置页为基准） ---- */
			".dbc-style-grid{background:var(--dbc-card);border-color:var(--dbc-line2);box-shadow:var(--dbc-shadow)}",
			".dbc-root[data-dark=true] .dbc-style-grid{background:var(--dbc-card);border-color:var(--dbc-line2);box-shadow:none}",
			".dbc-cell{background:var(--dbc-cell);border-color:var(--dbc-line);box-shadow:none}",
			".dbc-root[data-dark=true] .dbc-cell{background:var(--dbc-cell);border-color:var(--dbc-line)}",
			".dbc-cell:nth-child(3){background:var(--dbc-cell);border-color:var(--dbc-line)}",
			".dbc-root[data-dark=true] .dbc-cell:nth-child(3){background:var(--dbc-cell);border-color:var(--dbc-line2)}",
			".dbc-grid-bar i{background:color-mix(in srgb,var(--dbc-ink) 8%,transparent)}",
			".dbc-root[data-dark=true] .dbc-grid-bar i{background:color-mix(in srgb,var(--dbc-ink) 10%,transparent)}",
			".dbc-grid-bar i.on{background:var(--dbc-accent)}",
			".dbc-grid-bar i.part{background:linear-gradient(90deg,var(--dbc-accent) var(--fill,0%),color-mix(in srgb,var(--dbc-ink) 8%,transparent) var(--fill,0%))}",
			".dbc-root[data-dark=true] .dbc-grid-bar i.on{background:var(--dbc-accent)}",
			".dbc-root[data-dark=true] .dbc-grid-bar i.part{background:linear-gradient(90deg,var(--dbc-accent) var(--fill,0%),color-mix(in srgb,var(--dbc-ink) 10%,transparent) var(--fill,0%))}",
			".dbc-grid-bar i.on.dbc-low,.dbc-grid-bar i.part.dbc-low{background:var(--dbc-amber)}",
			".dbc-grid-bar i.on.dbc-critical,.dbc-grid-bar i.part.dbc-critical{background:var(--dbc-vermilion)}",
			".dbc-style-ring{--dbc-ring-ink:var(--dbc-ink);--dbc-ring-ink2:var(--dbc-ink2);--dbc-ring-sub:var(--dbc-ink3);--dbc-ring-line:var(--dbc-line2);background:var(--dbc-card);border-color:var(--dbc-line2);box-shadow:var(--dbc-shadow)}",
			".dbc-style-ring::before{background:linear-gradient(120deg,color-mix(in srgb,var(--dbc-accent) 7%,transparent),transparent 68%)}",
			".dbc-style-ring::after{background:linear-gradient(200deg,color-mix(in srgb,var(--dbc-accent) 5%,transparent),transparent 70%)}",
			".dbc-root[data-dark=true] .dbc-style-ring{background:var(--dbc-card);border-color:var(--dbc-line2);box-shadow:none}",
			".dbc-root[data-dark=true] .dbc-style-ring::before{background:linear-gradient(120deg,color-mix(in srgb,var(--dbc-accent) 8%,transparent),transparent 68%)}",
			".dbc-root[data-dark=true] .dbc-style-ring::after{background:linear-gradient(200deg,color-mix(in srgb,var(--dbc-accent) 5%,transparent),transparent 70%)}",
			".dbc-style-ring .dbc-badge{background:var(--dbc-cell);border:1px solid var(--dbc-line2);color:var(--dbc-ink);box-shadow:none}",
			".dbc-root[data-dark=true] .dbc-style-ring .dbc-badge{background:var(--dbc-cell);color:var(--dbc-ink)}",
			".dbc-style-line{background:var(--dbc-paper2);border-color:var(--dbc-line2);box-shadow:none}",
			".dbc-root[data-dark=true] .dbc-style-line{background:var(--dbc-paper);border-color:var(--dbc-line2)}",
			".dbc-ticks{background:repeating-linear-gradient(90deg,var(--dbc-line2) 0 1px,transparent 1px 4px)}",
			".dbc-ticks i{background:repeating-linear-gradient(90deg,var(--dbc-accent) 0 1px,transparent 1px 4px)}",
			".dbc-root[data-dark=true] .dbc-ticks{background:repeating-linear-gradient(90deg,var(--dbc-line2) 0 1px,transparent 1px 4px)}",
			".dbc-root[data-dark=true] .dbc-ticks i{background:repeating-linear-gradient(90deg,var(--dbc-accent) 0 1px,transparent 1px 4px)}",
			".dbc-line-foot{border-top-color:var(--dbc-line)}",
			".dbc-root[data-dark=true] .dbc-line-foot{border-top-color:var(--dbc-line)}",
			".dbc-style-gradient{background:linear-gradient(145deg,var(--dbc-card),color-mix(in srgb,var(--dbc-accent) 4%,var(--dbc-card)));border-color:var(--dbc-line2);box-shadow:var(--dbc-shadow)}",
			".dbc-style-gradient::before{background:linear-gradient(180deg,color-mix(in srgb,var(--dbc-accent) 5%,transparent),transparent 45%)}",
			".dbc-root[data-dark=true] .dbc-style-gradient{background:linear-gradient(145deg,var(--dbc-card),color-mix(in srgb,var(--dbc-accent) 5%,var(--dbc-card)));border-color:var(--dbc-line2);box-shadow:none}",
			".dbc-style-gradient .dbc-badge{background:var(--dbc-cell);border-color:var(--dbc-line2);color:var(--dbc-ink);box-shadow:none}",
			".dbc-root[data-dark=true] .dbc-style-gradient .dbc-badge{background:var(--dbc-cell);border-color:var(--dbc-line2);color:var(--dbc-ink)}",
			".dbc-glow{background:color-mix(in srgb,var(--dbc-ink) 8%,transparent)}",
			".dbc-root[data-dark=true] .dbc-glow{background:color-mix(in srgb,var(--dbc-ink) 10%,transparent)}",
			".dbc-glow i{background:linear-gradient(90deg,color-mix(in srgb,var(--dbc-accent) 70%,transparent),var(--dbc-accent));box-shadow:none}",
			".dbc-tone-good .dbc-dot,.dbc-dot.dbc-tone-good{background:var(--dbc-success)}",
			".dbc-preview-frame{background:var(--dbc-paper2);border-color:var(--dbc-line);width:100%;padding:6px}",
			".dbc-tabs{background:transparent}",
			".dbc-settings-title{font-size:22px}",
			".dbc-page{grid-template-columns:minmax(190px,208px) minmax(0,1fr);gap:16px}",
			".dbc-row{flex-wrap:wrap;gap:6px 16px;align-items:flex-start}",
			".dbc-row-text{flex:1 1 240px;min-width:180px}",
			".dbc-row-control{flex:none;margin-left:auto;max-width:100%;flex-wrap:wrap;justify-content:flex-end}",
			".dbc-row-wide .dbc-row-control{flex:1 0 100%;margin-left:0;justify-content:flex-start}",
			".dbc-switch[aria-checked=true]{background:var(--dbc-accent);border-color:var(--dbc-accent)}",
			".dbc-switch .dbc-knob{background:var(--dbc-card)}",
			".dbc-saved{color:var(--dbc-ink3)}",
			/* 密度：只压缩上下留白，不隐藏信息 */
			".dbc-card[data-density=compact]{padding-top:9px;padding-bottom:8px}",
			".dbc-card[data-density=compact] .dbc-head{gap:6px}",
			".dbc-card[data-density=compact] .dbc-grid-cells{margin-top:7px;gap:5px}",
			".dbc-card[data-density=compact] .dbc-cell{padding:6px 7px 5px}",
			".dbc-card[data-density=compact] .dbc-foot{margin-top:7px}",
			".dbc-card[data-density=compact] .dbc-ring-body{margin-top:7px}",
			".dbc-card[data-density=compact] .dbc-line-amount{margin-top:5px}",
			".dbc-card[data-density=compact] .dbc-ticks{margin-top:6px}",
			".dbc-card[data-density=compact] .dbc-glow{margin-top:7px}",
			".dbc-card[data-density=compact] .dbc-gradient-amount{margin-top:5px}",
			".dbc-panel[data-density=compact] .dbc-panel-row{padding:4px 0}",
			".dbc-panel[data-density=compact] .dbc-window{margin-top:8px;padding-top:7px}",
			/* 金额型：没有可画的百分比时隐藏进度，用放大的金额补足空间 */
			".dbc-grid-money{display:flex;flex-direction:column;gap:2px;margin-top:8px;padding:2px 2px 0;min-width:0}",
			".dbc-grid-money-value{display:flex;align-items:baseline;gap:4px;font-size:28px;line-height:32px;font-weight:650;letter-spacing:-.045em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".dbc-card.compact .dbc-grid-money-value{font-size:24px;line-height:28px}",
			".dbc-ring-money .dbc-ring-amount{font-size:34px;line-height:38px}",
			".dbc-card.compact .dbc-ring-money .dbc-ring-amount{font-size:30px;line-height:34px}",
			".dbc-line-amount.dbc-money-amount{font-size:30px;line-height:34px}",
			".dbc-style-gradient .dbc-money-amount{font-size:32px;line-height:36px}",
			".dbc-saved::before{color:var(--dbc-ink3)}",
			".dbc-chip.dbc-ok{color:var(--dbc-ink);border-color:var(--dbc-line2);background:var(--dbc-cell)}",
			/* 响应式 */
			"@media (max-width:860px){.dbc-page{grid-template-columns:1fr}.dbc-preview-col{position:static}.dbc-preview-frame{width:100%}.dbc-vendor-body{padding-left:12px}.dbc-tool-body{padding-left:14px}}",
			"@media (prefers-reduced-motion:reduce){.dbc-card,.dbc-card *,.dbc-panel,.dbc-switch .dbc-knob,.dbc-chev,.dbc-glow i{transition:none!important;animation:none!important}.dbc-card:hover{transform:none}}",
		].join("");

		/** 注入一次样式；重复调用无害。 */
		function injectStyle() {
			if (document.querySelector(`style[data-dsh-balance-card="${STYLE_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.dshBalanceCard = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 宿主是否为暗色（system 主题跟随它）。 */
		function useHostDark() {
			const read = () =>
				document.body?.dataset?.dsDarkTheme !== undefined ||
				document.documentElement?.dataset?.dsDarkTheme !== undefined ||
				window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;
			const [dark, setDark] = React.useState(read);
			React.useEffect(() => {
				const update = () => setDark(read());
				const observer = new MutationObserver(update);
				if (document.body !== null) observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
				const media = window.matchMedia?.("(prefers-color-scheme: dark)");
				media?.addEventListener?.("change", update);
				return () => {
					observer.disconnect();
					media?.removeEventListener?.("change", update);
				};
			}, []);
			return dark;
		}

		/** 根据宿主是否为暗色决定主题；插件的主题固定跟随软件。 */
		function useDark() {
			return useHostDark();
		}

		/**
		 * ResizeObserver：卡片宽度 < 320 时进入紧凑形态。
		 * @param ref - 卡片元素 ref。
		 * @returns 是否紧凑。
		 */
		function useCompact(ref) {
			const [compact, setCompact] = React.useState(false);
			React.useEffect(() => {
				const node = ref.current;
				if (node === null) return;
				const measure = () => {
					const width = node.getBoundingClientRect().width;
					if (width > 0) setCompact(width < 320);
				};
				measure();
				if (typeof ResizeObserver !== "function") return;
				const observer = new ResizeObserver(measure);
				observer.observe(node);
				return () => observer.disconnect();
			}, [ref]);
			return compact;
		}

		/* =====================================================================
		 * 卡片
		 * ===================================================================== */

		/** 主机未响应前的设置兜底（与 host settings.js 对齐）。 */
		const FALLBACK_SETTINGS = {
			version: 2,
			theme: "system",
			visualStyle: "grid",
			accent: "jade",
			density: "comfortable",
			card: {
				showPercent: true,
				showBar: true,
				showUpdatedAt: true,
				showSubtitle: true,
				showStatusText: false,
				groupDigits: true,
				currencyStyle: "symbol",
				pollMs: 600000,
				warnPercent: 20,
				clickAction: "panel",
				visible: true,
			},
			vendors: {},
			tools: {
				qianfanThrottle: {
					enabled: false,
					mode: "dynamic",
					preset: "mid",
					safety: 0.7,
					maxConcurrent: 2,
					cooldownCapMs: 600000,
					queueTimeoutMs: 180000,
					probe: true,
					probePace: "normal",
					manual: {
						low: { rpm: 2, tpm: 8000, concurrency: 1 },
						mid: { rpm: 6, tpm: 30000, concurrency: 2 },
						high: { rpm: 15, tpm: 80000, concurrency: 3 },
					},
				},
				lowBalanceAlert: { enabled: true, warnPercent: 20, criticalPercent: 10, notify: false, quietHours: null },
				dailyReport: { enabled: false, time: "09:00", format: "digest" },
			},
		};

		/** 设置页上次停留的标签（同一页面加载内记忆）。 */
		let lastSettingsPage = "style";
		/** 设置 shell 的 slot 注册表，用于打开本插件的 section。 */
		let settingsShellSlots;
		/** 跨席位跳转意图：卡片/面板要求设置页切到某页、展开某家厂商。 */
		const settingsIntent = createSlot({ page: "style", vendor: "", seq: 0 });

		/**
		 * 打开本插件的设置 section。
		 * @param page - `style` / `vendors` / `tools`。
		 * @param vendorId - 要展开的厂商（可选）。
		 * @returns 是否成功跳转。
		 */
		function openWalletSettings(page, vendorId) {
			const nextPage = page ?? lastSettingsPage;
			lastSettingsPage = nextPage;
			settingsIntent.set({ page: nextPage, vendor: vendorId ?? "", seq: settingsIntent.getSnapshot().seq + 1 });
			try {
				const entries = settingsShellSlots?.entries?.("sidebar.settings");
				const seat = Array.isArray(entries) ? entries[0] : undefined;
				const store = seat?.store?.create?.();
				const openSection = store?.actions?.openSection;
				if (typeof openSection === "function") {
					openSection(SECTION_ID);
					return true;
				}
			} catch {
				// 旧 shell 没有这个 seat：卡片仍能展开面板，只是跳不过去。
			}
			return false;
		}

		/**
		 * 通用状态点 + 文字。
		 * @param props - `{ model, showText }`。
		 * @returns 元素。
		 */
		function StatusLine({ model, showText }) {
			const tone = toneOf(model);
			const text = statusTextOf(model);
			if (showText !== true && model.state === "ok" && tone === "good") {
				return React.createElement("span", { className: "dbc-status dbc-tone-good" }, React.createElement("i", { className: "dbc-dot" }));
			}
			return React.createElement(
				"span",
				{ className: "dbc-status dbc-tone-" + tone },
				React.createElement("i", { className: "dbc-dot" }),
				text === "" ? null : React.createElement("span", null, text),
			);
		}

		/**
		 * 卡片顶部：字母章 + 厂商 + 副标题 + 状态。
		 * @param props - `{ model, settings }`。
		 * @returns 元素。
		 */
		function CardHead({ model, settings }) {
			const vendor = model.vendor;
			const badge = vendor?.short ?? "¤";
			const name = vendor?.label ?? (model.state === "unmapped" ? "当前厂商" : "余额");
			const sub = settings?.card?.showSubtitle === false ? "" : subtitleOf(model);
			return React.createElement(
				"div",
				{ className: "dbc-head" },
				React.createElement("span", { className: "dbc-badge", "aria-hidden": "true" }, badge),
				React.createElement(
					"span",
					{ className: "dbc-nameWrap" },
					React.createElement("span", { className: "dbc-name" }, name),
					sub === "" ? null : React.createElement("span", { className: "dbc-sub" }, sub),
				),
				React.createElement(StatusLine, {
					model,
					showText: settings?.card?.showStatusText === true || model.state !== "ok",
				}),
			);
		}

		/** 进度色调 class。 */
		function progressTone(model) {
			const tone = toneOf(model);
			if (tone === "critical") return "dbc-critical";
			if (tone === "low") return "dbc-low";
			return "";
		}

		/** 百分比（0–100）截断。 */
		function clampPercent(value) {
			return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
		}

		/**
		 * 十段比例条。
		 * @param props - `{ percent, tone }`。
		 * @returns 元素。
		 */
		function GridBar({ percent, tone }) {
			const value = clampPercent(percent);
			const filled = Math.floor(value / 10);
			const remainder = Math.round((value - filled * 10) * 10) / 10;
			const cells = [];
			for (let index = 0; index < 10; index += 1) {
				if (index < filled) {
					cells.push(React.createElement("i", { key: index, className: "on " + tone }));
				} else if (index === filled && remainder > 0) {
					cells.push(
						React.createElement("i", {
							key: index,
							className: "part " + tone,
							style: { "--fill": remainder * 10 + "%" },
						}),
					);
				} else {
					cells.push(React.createElement("i", { key: index }));
				}
			}
			return React.createElement("div", { className: "dbc-grid-bar", "aria-hidden": "true" }, cells);
		}

		/**
		 * 方格：纸面 + 三格 + 十段条。
		 * @param props - `{ model, settings, compact }`。
		 * @returns 元素。
		 */
		function GridBody({ model, settings, compact, moneyOnly }) {
			const reading = model.reading;
			const figures = figureOf(reading, settings);
			if (moneyOnly) {
				return React.createElement(
					React.Fragment,
					null,
					React.createElement(
						"div",
						{ className: "dbc-grid-money" },
						React.createElement("span", { className: "dbc-cell-label" }, reading?.note || "账户余额"),
						React.createElement(
							"span",
							{ className: "dbc-grid-money-value", title: figures.prefix + figures.main + figures.suffix },
							figures.prefix === "" ? null : React.createElement("span", { className: "dbc-prefix" }, figures.prefix),
							figures.main,
							figures.suffix === "" ? null : React.createElement("span", { className: "dbc-suffix" }, figures.suffix),
						),
					),
					React.createElement(FootLine, { model, settings }),
				);
			}
			const used = figureOf(
				reading === null ? null : { ...reading, remaining: reading.used, unit: reading.unit },
				settings,
			);
			const showPercent = settings?.card?.showPercent !== false;
			const showBar = settings?.card?.showBar !== false;
			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"div",
					{ className: "dbc-grid-cells" },
					React.createElement(
						"div",
						{ className: "dbc-cell" },
						React.createElement("span", { className: "dbc-cell-label" }, "剩余"),
						React.createElement(
							"span",
							{ className: "dbc-cell-value dbc-amount", title: figures.prefix + figures.main + figures.suffix },
							figures.prefix === "" || compact ? null : React.createElement("span", { className: "dbc-prefix" }, figures.prefix),
							figures.main,
							figures.suffix === "" || compact || figures.prefix !== "" ? null : React.createElement("span", { className: "dbc-suffix" }, figures.suffix),
						),
					),
					React.createElement(
						"div",
						{ className: "dbc-cell" },
						React.createElement("span", { className: "dbc-cell-label" }, "已用"),
						React.createElement(
							"span",
							{ className: "dbc-cell-value", title: used.main + used.suffix },
							reading?.used === null || reading?.used === undefined ? "—" : used.main,
						),
					),
					React.createElement(
						"div",
						{ className: "dbc-cell" },
						React.createElement("span", { className: "dbc-cell-label" }, "余额比例"),
						React.createElement(
							"span",
							{ className: "dbc-cell-value dbc-cell-pct" },
							showPercent ? percentText(figures.percent) : "—",
						),
					),
				),
				showBar ? React.createElement(GridBar, { percent: model.percent, tone: progressTone(model) }) : null,
				React.createElement(FootLine, { model, settings }),
			);
		}

		/**
		 * 58px 圆环。
		 * @param props - `{ percent, tone }`。
		 * @returns 元素。
		 */
		function Ring({ percent, tone }) {
			const value = clampPercent(percent);
			const radius = 24;
			const circumference = 2 * Math.PI * radius;
			const dash = (value / 100) * circumference;
			const stroke = tone === "critical" ? "var(--dbc-vermilion)" : tone === "low" ? "var(--dbc-amber)" : "var(--dbc-accent)";
			return React.createElement(
				"span",
				{ className: "dbc-ring-wrap", "aria-hidden": "true" },
				React.createElement(
					"svg",
					{ width: 58, height: 58, viewBox: "0 0 58 58" },
					React.createElement("circle", { cx: 29, cy: 29, r: radius, fill: "none", stroke: "var(--dbc-line2)", strokeWidth: 4 }),
					React.createElement("circle", {
						cx: 29,
						cy: 29,
						r: radius,
						fill: "none",
						stroke,
						strokeWidth: 4,
						strokeLinecap: "round",
						strokeDasharray: dash + " " + circumference,
						transform: "rotate(-90 29 29)",
					}),
				),
				React.createElement("span", { className: "dbc-ring-pct" },
					value.toFixed(1) + "%",
					React.createElement("span", null, "剩余"),
				),
			);
		}

		/**
		 * 圆环：左金额 + 中已用/总量 + 右环。
		 * @param props - `{ model, settings, compact }`。
		 * @returns 元素。
		 */
		function RingBody({ model, settings, compact, moneyOnly }) {
			const reading = model.reading;
			const figures = figureOf(reading, settings);
			const unit = reading?.unit ?? "";
			const used = reading?.used;
			const total = reading?.total;
			const usedText = used === null || used === undefined ? "—" : unit === "%" ? used.toFixed(1) + "%" : grouped(used);
			const totalText = total === null || total === undefined ? "—" : unit === "%" ? total.toFixed(0) + "%" : grouped(total);
			if (moneyOnly) {
				return React.createElement(
					React.Fragment,
					null,
					React.createElement(
						"div",
						{ className: "dbc-ring-body dbc-ring-money" },
						React.createElement(
							"div",
							{ className: "dbc-ring-main" },
							React.createElement(
								"span",
								{ className: "dbc-ring-amount", title: figures.prefix + figures.main + figures.suffix },
								figures.prefix === "" ? null : React.createElement("span", { className: "dbc-prefix" }, figures.prefix),
								figures.main,
								figures.suffix === "" ? null : React.createElement("span", { className: "dbc-suffix" }, figures.suffix),
							),
						),
					),
					React.createElement(FootLine, { model, settings }),
				);
			}
			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"div",
					{ className: "dbc-ring-body" },
					React.createElement(
						"div",
						{ className: "dbc-ring-main" },
						React.createElement(
							"span",
							{ className: "dbc-ring-amount", title: figures.prefix + figures.main + figures.suffix },
							figures.prefix === "" ? null : React.createElement("span", { className: "dbc-prefix" }, figures.prefix),
							figures.main,
							figures.suffix === "" ? null : React.createElement("span", { className: "dbc-suffix" }, figures.suffix),
						),
					),
					compact
						? null
						: React.createElement(
								"div",
								{ className: "dbc-ring-mid" },
								React.createElement(
									"div",
									{ className: "dbc-stat" },
									React.createElement("span", { className: "dbc-k" }, "已用"),
									React.createElement("span", { className: "dbc-v" }, usedText),
								),
								React.createElement(
									"div",
									{ className: "dbc-stat" },
									React.createElement("span", { className: "dbc-k" }, "总量"),
									React.createElement("span", { className: "dbc-v" }, totalText),
								),
							),
					React.createElement(Ring, { percent: model.percent, tone: toneOf(model) }),
				),
				React.createElement(FootLine, {
					model,
					settings,
					extra: compact && usedText !== "—" ? "已用 " + usedText : "",
				}),
			);
		}

		/**
		 * 等宽刻度。
		 * @param props - `{ percent, tone, count }`。
		 * @returns 元素。
		 */
		function Ticks({ percent, tone }) {
			return React.createElement(
				"div",
				{ className: "dbc-ticks", "aria-hidden": "true" },
				React.createElement("i", { className: tone, style: { width: clampPercent(percent) + "%" } }),
			);
		}

		/**
		 * 线条：终端刻度。
		 * @param props - `{ model, settings }`。
		 * @returns 元素。
		 */
		function LineBody({ model, settings, moneyOnly }) {
			const reading = model.reading;
			const figures = figureOf(reading, settings);
			const exp = reading?.windows?.find((window) => window.expiresAt)?.expiresAt ?? "";
			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"div",
					{ className: "dbc-line-head" },
					React.createElement("span", null, (model.vendor?.id ?? "balance").toUpperCase()),
					React.createElement(
						"span",
						{ className: model.state === "ok" ? "dbc-live" : "" },
						model.state === "ok" ? "LIVE" : statusTextOf(model).toUpperCase(),
					),
				),
				React.createElement(
					"div",
					{ className: "dbc-line-amount" + (moneyOnly ? " dbc-money-amount" : ""), title: figures.prefix + figures.main + figures.suffix },
					figures.prefix === "" ? null : React.createElement("span", { className: "dbc-prefix" }, figures.prefix),
					figures.main,
					React.createElement("span", { className: "dbc-suffix" }, figures.suffix || ""),
				),
				moneyOnly || settings?.card?.showBar === false ? null : React.createElement(Ticks, { percent: model.percent, tone: progressTone(model) }),
				React.createElement(
					"div",
					{ className: "dbc-line-foot" },
					React.createElement("span", null, "UPDATED " + relativeTime(model.fetchedAt)),
					React.createElement("span", null, exp === "" ? "EXP —" : "EXP " + dateText(exp)),
				),
			);
		}

		/**
		 * 渐变：磨砂 + 4px 柔光线。
		 * @param props - `{ model, settings }`。
		 * @returns 元素。
		 */
		function GradientBody({ model, settings, moneyOnly }) {
			const reading = model.reading;
			const figures = figureOf(reading, settings);
			const tone = progressTone(model);
			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"div",
					{ className: "dbc-gradient-amount" + (moneyOnly ? " dbc-money-amount" : ""), title: figures.prefix + figures.main + figures.suffix },
					figures.prefix === "" ? null : React.createElement("span", { className: "dbc-prefix" }, figures.prefix),
					figures.main,
					figures.suffix === "" ? null : React.createElement("span", { className: "dbc-suffix" }, figures.suffix),
				),
				moneyOnly || settings?.card?.showBar === false
					? null
					: React.createElement(
							"div",
							{ className: "dbc-glow", "aria-hidden": "true" },
							React.createElement("i", { className: tone, style: { width: clampPercent(model.percent) + "%" } }),
						),
				React.createElement(FootLine, { model, settings }),
			);
		}

		/**
		 * 卡片底部：状态短语 + 更新时间。
		 * @param props - `{ model, settings, extra }`。
		 * @returns 元素。
		 */
		function FootLine({ model, settings, extra }) {
			const left =
				extra !== undefined && extra !== ""
					? extra
					: model.percent === null || model.percent === undefined
						? model.reading?.note || "账户余额"
						: settings?.card?.showPercent === false
							? statusTextOf(model)
							: percentText(model.percent);
			const right = settings?.card?.showUpdatedAt === false ? "" : relativeTime(model.fetchedAt);
			return React.createElement(
				"div",
				{ className: "dbc-foot" },
				React.createElement("span", null, left),
				right === "" ? null : React.createElement("span", { className: "dbc-right dbc-mono" }, right),
			);
		}

		/**
		 * 空态 / 错误态主体。
		 * @param props - `{ model }`。
		 * @returns 元素。
		 */
		function EmptyBody({ model }) {
			if (model.state === "loading") {
				return React.createElement(
					"div",
					{ className: "dbc-empty" },
					React.createElement("div", { className: "dbc-skeleton", style: { width: "54%" } }),
					React.createElement("div", { className: "dbc-skeleton", style: { width: "34%", marginTop: 6 } }),
				);
			}
			const message =
				model.state === "unmapped"
					? "当前厂商未监控"
					: model.state === "disabled"
						? "未开启监控"
						: model.state === "unconfigured"
							? "未配置凭据"
							: model.state === "unsupported"
								? "暂不支持"
								: model.state === "empty"
									? "未开启监控"
									: ERROR_SHORT[model.error?.code] ?? "读取失败";
			const hint =
				model.state === "error" || model.state === "stale"
					? model.error?.message ?? ""
					: model.state === "unmapped"
						? "点击选择要监控的厂商"
						: model.state === "disabled"
							? "点击开启"
							: model.state === "unconfigured"
								? "点击粘贴凭据"
								: model.state === "unsupported"
									? model.vendor?.note ?? "该厂商需要登录态插件"
									: "";
			return React.createElement(
				"div",
				{ className: "dbc-empty" },
				React.createElement("span", { className: "dbc-empty-dash" }, "—"),
				React.createElement("span", { className: "dbc-empty-text" }, message),
				hint === "" ? null : React.createElement("span", { className: "dbc-empty-hint" }, hint),
			);
		}

		/**
		 * 四种风格共用的卡片。
		 * @param props - `{ model, settings, dark, compact, onOpen, cardRef, preview }`。
		 * @returns 元素。
		 */
		function BalanceCard({ model, settings, dark, compact, onOpen, cardRef, preview }) {
			const style = STYLE_IDS.includes(settings?.visualStyle) ? settings.visualStyle : "grid";
			const tone = toneOf(model);
			// 金额型且没有预算/基准时，百分比与进度都没有意义：隐藏进度，放大金额。
			const moneyOnly = model.reading?.kind === "currency" && (model.percent === null || model.percent === undefined);
			const body =
				model.state === "ok" || model.state === "stale"
					? style === "ring"
						? React.createElement(RingBody, { model, settings, compact, moneyOnly })
						: style === "line"
							? React.createElement(LineBody, { model, settings, moneyOnly })
							: style === "gradient"
								? React.createElement(GradientBody, { model, settings, moneyOnly })
								: React.createElement(GridBody, { model, settings, compact, moneyOnly })
					: React.createElement(EmptyBody, { model });
			const styleClass = style === "grid" ? "dbc-grid" : "dbc-" + style;
			const click = preview === true ? undefined : onOpen;
			return React.createElement(
				"button",
				{
					type: "button",
					ref: cardRef,
					className: ["dbc-card", "dbc-style-" + style, styleClass, "dbc-tone-" + tone, compact ? "compact" : ""].join(" "),
					"data-dark": dark === true ? "true" : "false",
					"data-density": settings?.density === "compact" ? "compact" : "comfortable",
					style: accentStyle(settings, dark, model.vendor?.id),
					"aria-label": cardAriaLabel(model, settings),
					onClick: click,
				},
				React.createElement(CardHead, { model, settings }),
				body,
			);
		}

		/**
		 * 卡片的无障碍名称。
		 * @param model - 卡片模型。
		 * @param settings - 设置。
		 * @returns 一句话描述。
		 */
		function cardAriaLabel(model, settings) {
			const vendor = model.vendor?.label ?? "当前厂商";
			if (model.state !== "ok" && model.state !== "stale") return vendor + "，" + statusTextOf(model);
			const figures = figureOf(model.reading, settings);
			const percent = model.percent === null ? "" : "，剩余 " + percentText(model.percent);
			return vendor + "，余额 " + figures.prefix + figures.main + figures.suffix + percent + "，" + statusTextOf(model) + "，" + relativeTime(model.fetchedAt);
		}

		/**
		 * 56px 窄栏的 36×36 图标格。
		 * @param props - `{ model, settings, dark, onOpen }`。
		 * @returns 元素。
		 */
		function RailCard({ model, settings, dark, onOpen }) {
			const tone = toneOf(model);
			const style = STYLE_IDS.includes(settings?.visualStyle) ? settings.visualStyle : "grid";
			const badge = model.vendor?.short ?? "¤";
			const label = cardAriaLabel(model, settings);
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dbc-rail dbc-tone-" + tone,
					"data-dark": dark === true ? "true" : "false",
					"aria-label": label,
					title: label,
					onClick: onOpen,
				},
				React.createElement("span", { className: "dbc-rail-badge" }, badge),
				React.createElement(
					"svg",
					{ className: "dbc-rail-ring", width: 40, height: 40, viewBox: "0 0 40 40", "aria-hidden": "true" },
					React.createElement("circle", { cx: 20, cy: 20, r: 17, fill: "none", stroke: "var(--dbc-line2)", strokeWidth: 2 }),
					React.createElement("circle", {
						cx: 20,
						cy: 20,
						r: 17,
						fill: "none",
						stroke: tone === "critical" ? "var(--dbc-vermilion)" : tone === "low" ? "var(--dbc-amber)" : "var(--dbc-accent)",
						strokeWidth: 2,
						strokeLinecap: "round",
						strokeDasharray: (clampPercent(model.percent) / 100) * 2 * Math.PI * 17 + " " + 2 * Math.PI * 17,
						transform: "rotate(-90 20 20)",
					}),
				),
			);
		}

		/**
		 * 侧边栏席位：卡片 + 展开面板。
		 * @param props - `{ optional, session, wallet, wide }`。
		 * @returns 元素。
		 */
		function SidebarBalanceSeat({ optional, session, wallet, wide }) {
			const services = useStore(optional);
			const sessionId = useStore(session);
			const state = useStore(wallet);
			const data = state.data;
			const settings = data?.settings ?? FALLBACK_SETTINGS;
			const dark = useDark(settings.theme);
			// 没有选中模型 / 新会话：用 DSH 默认模型；有最近请求记录时才用它兜底。
			const fallbackProvider =
				(typeof data?.meta?.defaultProvider === "string" && data.meta.defaultProvider !== ""
					? data.meta.defaultProvider
					: typeof data?.meta?.currentProvider === "string" && data.meta.currentProvider !== ""
						? data.meta.currentProvider
						: "");
			const current =
				useCurrentProvider(services, sessionId) ?? (fallbackProvider === "" ? undefined : { provider: fallbackProvider });
			const cardRef = React.useRef(null);
			const [open, setOpen] = React.useState(false);
			const compact = useCompact(cardRef);
			const model = cardModel(data, current?.provider, settings);

			if (settings.card.visible === false) return null;

			const onOpen = () => {
				if (settings.card.clickAction === "settings" && openWalletSettings("style")) return;
				setOpen((value) => !value);
			};

			return React.createElement(
				"div",
				{ className: "dbc-root", "data-dark": dark === true ? "true" : "false", style: accentStyle(settings, dark) },
				wide === false
					? React.createElement(RailCard, { model, settings, dark, onOpen })
					: React.createElement(BalanceCard, { model, settings, dark, onOpen, cardRef, compact }),
				open
					? React.createElement(DetailPanel, {
							model,
							data,
							settings,
							dark,
							anchorRef: cardRef,
							onClose: () => setOpen(false),
							onRefresh: () => wallet.refresh(model.vendor?.id ?? ""),
							onSettings: () => {
								setOpen(false);
								openWalletSettings("vendors", model.vendor?.id ?? "");
							},
							onEnable: model.vendor === null ? undefined : () => wallet.patch({ vendors: { [model.vendor.id]: { enabled: true } } }),
						})
					: null,
			);
		}

		/* =====================================================================
		 * 展开面板
		 * ===================================================================== */

		/**
		 * 计算面板位置：优先向上，空间不足向下；左右夹在 12px 边距内。
		 * @param anchorRef - 卡片 ref。
		 * @param open - 是否展开。
		 * @returns `{ top, left }`。
		 */
		function usePanelPosition(anchorRef, open) {
			const [position, setPosition] = React.useState({ left: 12, top: undefined, bottom: undefined, maxHeight: 360 });
			React.useEffect(() => {
				if (!open) return;
				const measure = () => {
					const node = anchorRef.current;
					if (node === null) return;
					const rect = node.getBoundingClientRect();
					const width = Math.min(386, window.innerWidth - 24);
					const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
					// 面板底边永远距卡片顶边 10px，而不是按一个假定的高度往上顶。
					// 卡片高矮（尤其「未开启监控」的空态卡）不会再把面板推得过远。
					if (rect.top > 240) {
						setPosition({
							left,
							top: undefined,
							bottom: Math.max(12, window.innerHeight - rect.top + 10),
							maxHeight: Math.max(160, rect.top - 22),
						});
					} else {
						setPosition({
							left,
							top: Math.min(window.innerHeight - 120, rect.bottom + 10),
							bottom: undefined,
							maxHeight: Math.max(160, window.innerHeight - rect.bottom - 22),
						});
					}
				};
				measure();
				window.addEventListener("resize", measure);
				window.addEventListener("scroll", measure, true);
				return () => {
					window.removeEventListener("resize", measure);
					window.removeEventListener("scroll", measure, true);
				};
			}, [anchorRef, open]);
			return position;
		}

		/**
		 * 重置倒计时文案。
		 * @param iso - ISO 时间。
		 * @returns e.g. `2 小时 14 分`。
		 */
		function resetText(iso) {
			if (typeof iso !== "string" || iso === "") return "";
			const at = Date.parse(iso);
			if (!Number.isFinite(at)) return "";
			const gap = Math.max(0, at - Date.now());
			if (gap < MINUTE) return "不到 1 分钟";
			const total = Math.round(gap / MINUTE);
			if (total < 60) return total + " 分钟";
			const hours = Math.floor(total / 60);
			const minutes = total % 60;
			if (hours < 24) return hours + " 小时" + (minutes === 0 ? "" : " " + minutes + " 分");
			return Math.floor(hours / 24) + " 天" + (hours % 24 === 0 ? "" : " " + (hours % 24) + " 小时");
		}

		/**
		 * 面板里的一个窗口。
		 * @param props - `{ window, settings, warnPercent }`。
		 * @returns 元素。
		 */
		function WindowRow({ window, settings, warnPercent, mainUnit }) {
			const percent = typeof window.percent === "number" ? window.percent : null;
			const tone = percent === null ? "" : percent <= 10 ? "dbc-critical" : percent < warnPercent ? "dbc-low" : "";
			const unit = window.unit || mainUnit || "";
			const show = (value) => {
				if (value === null || value === undefined) return "—";
				if (unit === "%") return percentText(value);
				if (unit === "¥" || unit === "$") return unit + money(value);
				return grouped(value) + (unit === "" ? "" : " " + unit);
			};
			const remaining = show(window.remaining);
			const total = show(window.total);
			const showBar = settings?.card?.showBar !== false && percent !== null;
			return React.createElement(
				"div",
				{ className: "dbc-window" },
				React.createElement(
					"div",
					{ className: "dbc-window-title" },
					React.createElement("b", null, window.label || "额度窗口"),
					React.createElement("span", null, percent === null ? "—" : percentText(percent)),
				),
				showBar
					? React.createElement(
							"div",
							{ className: "dbc-window-bar" },
							React.createElement("i", { className: tone, style: { width: clampPercent(percent ?? 0) + "%" } }),
						)
					: null,
				React.createElement(
					"div",
					{ className: "dbc-window-meta" },
					React.createElement("span", null, "剩余 " + remaining + " / " + total),
					React.createElement(
						"span",
						null,
						window.resetsAt !== "" ? "重置 " + resetText(window.resetsAt) : window.expiresAt !== "" ? "到期 " + dateText(window.expiresAt) : "",
					),
				),
			);
		}

		/**
		 * 明细面板。
		 * @param props - `{ model, data, settings, dark, anchorRef, onClose, onRefresh, onSettings, onEnable }`。
		 * @returns portal 元素。
		 */
		function DetailPanel({ model, data, settings, dark, anchorRef, onClose, onRefresh, onSettings, onEnable }) {
			const position = usePanelPosition(anchorRef, true);
			const panelRef = React.useRef(null);
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState("");

			React.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				};
				const onPointer = (event) => {
					const panel = panelRef.current;
					const anchor = anchorRef.current;
					if (panel === null) return;
					if (panel.contains(event.target)) return;
					if (anchor !== null && anchor.contains(event.target)) return;
					onClose();
				};
				document.addEventListener("keydown", onKey, true);
				document.addEventListener("pointerdown", onPointer, true);
				const focusTimer = setTimeout(() => panelRef.current?.focus?.(), 0);
				return () => {
					document.removeEventListener("keydown", onKey, true);
					document.removeEventListener("pointerdown", onPointer, true);
					clearTimeout(focusTimer);
				};
			}, [anchorRef, onClose]);

			const vendor = model.vendor;
			const reading = model.reading;
			const figures = figureOf(reading, settings);
			const windows = reading?.windows ?? [];
			const warnPercent = model.warnPercent ?? 20;
			const low = windows.filter((window) => typeof window.percent === "number" && window.percent < warnPercent);
			const expires = windows.find((window) => window.expiresAt !== "")?.expiresAt ?? "";
			const credentialLabel =
				vendor === null
					? ""
					: vendor.credential.type === "cookie"
						? "控制台 Cookie"
						: vendor.credential.type === "oauth"
							? "OAuth Token"
							: vendor.credential.type === "aksk"
								? "AK / SK"
								: vendor.credential.type === "custom"
									? "自定义接口"
									: "API Key";

			const refresh = async () => {
				setBusy(true);
				setNote("");
				const outcome = await onRefresh();
				setBusy(false);
				if (outcome === null) setNote("刷新失败，请稍后重试。");
				else if (outcome?.throttled === true) setNote("刚刚刷新过，5 秒内不重复请求。");
			};

			let body;
			if (model.state === "unmapped" || vendor === null) {
				body = React.createElement(
					"div",
					{ className: "dbc-panel-error" },
					React.createElement("b", null, "当前厂商未监控"),
					React.createElement("p", null, "这张卡片只显示已开启监控的厂商；到「厂商监控」页选择要读哪一家。"),
				);
			} else if (model.state === "disabled") {
				body = React.createElement(
					"div",
					{ className: "dbc-panel-error" },
					React.createElement("b", null, "未开启监控"),
					React.createElement("p", null, "开启后本插件才会向 " + vendor.label + " 发只读请求。"),
				);
			} else if (model.state === "unconfigured") {
				body = React.createElement(
					"div",
					{ className: "dbc-panel-error" },
					React.createElement("b", null, "未配置凭据"),
					React.createElement("p", null, vendor.credential.hint || "展开该厂商，粘贴并保存凭据。"),
				);
			} else if (model.state === "error") {
				body = React.createElement(
					"div",
					{ className: "dbc-panel-error" },
					React.createElement("b", null, ERROR_SHORT[model.error?.code] ?? "读取失败"),
					React.createElement("p", null, model.error?.message ?? "厂商接口没有返回可用读数。"),
					React.createElement("p", null, model.error?.advice ?? ERROR_ACTION[model.error?.code] ?? ""),
				);
			} else if (model.state === "loading") {
				body = React.createElement("div", { className: "dbc-skeleton", style: { width: "60%", height: 22, marginTop: 14 } });
			} else {
				body = React.createElement(
					React.Fragment,
					null,
					React.createElement(
						"div",
						{ className: "dbc-panel-hero" },
						React.createElement(
							"span",
							{ className: "dbc-panel-amount" },
							figures.prefix === "" ? null : React.createElement("span", { className: "dbc-prefix" }, figures.prefix),
							figures.main,
							figures.suffix === "" ? null : React.createElement("span", { className: "dbc-suffix", style: { marginLeft: 4 } }, figures.suffix),
						),
						model.percent === null ? null : React.createElement("span", { className: "dbc-panel-pct" }, percentText(model.percent)),
					),
					low.length > 0
						? React.createElement("div", { className: "dbc-panel-alert" }, low.length + " 个窗口低于 " + warnPercent + "% 告警线")
						: null,
					React.createElement(
						"div",
						{ className: "dbc-panel-rows" },
						React.createElement(
							"div",
							{ className: "dbc-panel-row" },
							React.createElement("span", { className: "dbc-k" }, "当前窗口"),
							React.createElement("span", { className: "dbc-v" }, windows[0]?.label || "—"),
						),
						React.createElement(
							"div",
							{ className: "dbc-panel-row" },
							React.createElement("span", { className: "dbc-k" }, "套餐到期"),
							React.createElement("span", { className: "dbc-v" }, expires === "" ? "—" : dateText(expires)),
						),
						React.createElement(
							"div",
							{ className: "dbc-panel-row" },
							React.createElement("span", { className: "dbc-k" }, "数据来源"),
							React.createElement("span", { className: "dbc-v" }, credentialLabel),
						),
						React.createElement(
							"div",
							{ className: "dbc-panel-row" },
							React.createElement("span", { className: "dbc-k" }, "最近更新"),
							React.createElement("span", { className: "dbc-v" }, relativeTime(model.fetchedAt) + (model.state === "stale" ? " · 缓存" : "")),
						),
					),
					windows.length === 0
						? null
						: React.createElement(
								"div",
								null,
								React.createElement("div", { className: "dbc-subhead", style: { marginTop: 10 } }, "窗口"),
								windows.map((window, index) =>
									React.createElement(WindowRow, {
										key: window.id + "-" + index,
										window,
										settings,
										warnPercent,
										mainUnit: reading?.unit ?? "",
									}),
								),
							),
					reading?.note
						? React.createElement("p", { style: { margin: "8px 0 0", fontSize: 9.5, color: "var(--dbc-ink4)", lineHeight: "13px" } }, reading.note)
						: null,
				);
			}

			const actions = [];
			if (model.state === "ok" || model.state === "stale" || model.state === "error") {
				actions.push(
					React.createElement(
						"button",
						{ key: "refresh", type: "button", className: "dbc-btn dbc-btn-primary", disabled: busy, onClick: refresh },
						busy ? "刷新中…" : "刷新",
					),
				);
			}
			if (model.state === "disabled" && vendor !== null) {
				actions.push(
					React.createElement(
						"button",
						{
							key: "enable",
							type: "button",
							className: "dbc-btn dbc-btn-primary",
							onClick: async () => {
								await onEnable?.();
								onClose();
							},
						},
						"开启监控",
					),
				);
			}
			if (vendor?.credential?.consoleUrl) {
				actions.push(
					React.createElement(
						"a",
						{
							key: "console",
							className: "dbc-link",
							href: vendor.credential.consoleUrl,
							target: "_blank",
							rel: "noreferrer noopener",
							onClick: (event) => event.stopPropagation(),
						},
						"打开控制台",
					),
				);
			}
			actions.push(React.createElement("span", { key: "spacer", className: "dbc-spacer" }));
			actions.push(
				React.createElement("button", { key: "settings", type: "button", className: "dbc-link", onClick: onSettings }, "设置"),
			);

			return createPortal(
				React.createElement(
					"div",
					{
						ref: panelRef,
						className: "dbc-root dbc-panel",
						"data-dark": dark === true ? "true" : "false",
						"data-density": settings?.density === "compact" ? "compact" : "comfortable",
						role: "dialog",
						"aria-label": (vendor?.label ?? "余额") + " 明细",
						tabIndex: -1,
						style: {
							left: position.left,
							top: position.top === undefined ? "auto" : position.top,
							bottom: position.bottom === undefined ? "auto" : position.bottom,
							maxHeight: position.maxHeight,
							...(accentStyle(settings, dark, vendor?.id) ?? {}),
						},
					},
					React.createElement(
						"div",
						{ className: "dbc-panel-head" },
						React.createElement("span", { className: "dbc-badge", "aria-hidden": "true" }, vendor?.short ?? "¤"),
						React.createElement(
							"span",
							{ className: "dbc-nameWrap" },
							React.createElement("span", { className: "dbc-name" }, vendor?.label ?? "当前厂商"),
							React.createElement("span", { className: "dbc-sub" }, vendor?.display?.unit ?? "余额"),
						),
						React.createElement("button", { type: "button", className: "dbc-panel-close", "aria-label": "关闭", onClick: onClose }, "×"),
					),
					body,
					note === "" ? null : React.createElement("div", { className: "dbc-panel-alert" }, note),
					React.createElement("div", { className: "dbc-panel-actions" }, actions),
				),
				document.body,
			);
		}

		/* =====================================================================
		 * 设置页
		 * ===================================================================== */

		/** 强调色（浅色 / 暗色两套）。 */
		const ACCENTS = {
			jade: { light: "#0F1115", dark: "#F9FAFB", label: "品牌" },
			ink: { light: "#4B5563", dark: "#9CA3AF", label: "深灰" },
			amber: { light: "#B45309", dark: "#FBBF24", label: "琥珀" },
		};

		/** 厂商品牌色的近似值（只用于「跟随厂商」强调色）。 */
		const VENDOR_TONES = {
			"baidu-qianfan": "#2B6CB0",
			scnet: "#1D6B5B",
			mimo: "#C2410C",
			zhipu: "#3B5BDB",
			volcengine: "#2563EB",
			qwen: "#7C3AED",
			claude: "#B45309",
			chatgpt: "#0F766E",
			antigravity: "#4338CA",
			deepseek: "#4D6BFE",
			stepfun: "#0E7490",
			kimi: "#6D28D9",
			openrouter: "#4B5563",
			minimax: "#BE123C",
			xai: "#111827",
			siliconflow: "#0F766E",
			custom: "#57534E",
			opendesign: "#1D4ED8",
			factory: "#334155",
			commandcode: "#7C2D12",
			clinepass: "#065F46",
		};

		/**
		 * 强调色的内联变量。
		 * @param settings - 设置。
		 * @param dark - 是否暗色。
		 * @param vendorId - 厂商（仅 accent=vendor 时使用）。
		 * @returns style 对象。
		 */
		function accentStyle(settings, dark, vendorId) {
			const accent = settings?.accent ?? "jade";
			if (accent === "vendor") {
				const tone = VENDOR_TONES[vendorId] ?? ACCENTS.jade.light;
				return { "--dbc-accent": dark ? lighten(tone) : tone };
			}
			const entry = ACCENTS[accent];
			if (entry === undefined) return undefined;
			return { "--dbc-accent": dark ? entry.dark : entry.light };
		}

		/**
		 * 把品牌色提亮到暗色背景可读（粗略的亮度混合）。
		 * @param hex - `#rrggbb`。
		 * @returns 提亮后的颜色。
		 */
		function lighten(hex) {
			const value = hex.replace("#", "");
			if (value.length !== 6) return hex;
			const mix = (channel) => Math.round(Number.parseInt(channel, 16) * 0.55 + 255 * 0.45);
			const r = mix(value.slice(0, 2));
			const g = mix(value.slice(2, 4));
			const b = mix(value.slice(4, 6));
			return "#" + [r, g, b].map((part) => Math.min(255, part).toString(16).padStart(2, "0")).join("");
		}

		/**
		 * 设置页的一行。
		 * @param props - `{ label, hint, control, wide }`。
		 * @returns 元素。
		 */
		function Row({ label, hint, control, wide }) {
			return React.createElement(
				"div",
				{ className: "dbc-row" + (wide === true ? " dbc-row-wide" : "") },
				React.createElement(
					"div",
					{ className: "dbc-row-text" },
					React.createElement("span", { className: "dbc-row-label" }, label),
					hint === undefined || hint === "" ? null : React.createElement("span", { className: "dbc-row-hint" }, hint),
				),
				React.createElement("div", { className: "dbc-row-control" }, control),
			);
		}

		/**
		 * 设置分组。
		 * @param props - `{ title, hint, children }`。
		 * @returns 元素。
		 */
		function Group({ title, hint, children }) {
			return React.createElement(
				"div",
				{ className: "dbc-group" },
				React.createElement("div", { className: "dbc-group-title" }, title),
				hint === undefined ? null : React.createElement("p", { className: "dbc-group-hint" }, hint),
				children,
			);
		}

		/**
		 * 开关。
		 * @param props - `{ checked, onChange, label, disabled }`。
		 * @returns 元素。
		 */
		function Switch({ checked, onChange, label, disabled }) {
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dbc-switch",
					role: "switch",
					"aria-checked": checked === true,
					"aria-label": label,
					disabled: disabled === true,
					onClick: (event) => {
						event?.stopPropagation?.();
						if (disabled !== true) onChange(!checked);
					},
				},
				React.createElement("span", { className: "dbc-knob" }),
			);
		}

		/**
		 * 分段选择。
		 * @param props - `{ value, options, onChange, label }`。
		 * @returns 元素。
		 */
		function Seg({ value, options, onChange, label }) {
			return React.createElement(
				"span",
				{ className: "dbc-seg", role: "group", "aria-label": label },
				options.map((option) =>
					React.createElement(
						"button",
						{
							key: option.value,
							type: "button",
							"data-active": value === option.value,
							"aria-pressed": value === option.value,
							onClick: () => onChange(option.value),
						},
						option.label,
					),
				),
			);
		}

		/** 秒/毫秒文案。 */
		function waitText(ms) {
			const total = Math.max(0, Math.round((typeof ms === "number" && Number.isFinite(ms) ? ms : 0) / 1000));
			if (total < 60) return total + " 秒";
			const minutes = Math.floor(total / 60);
			const seconds = total % 60;
			if (minutes < 60) return minutes + " 分 " + String(seconds).padStart(2, "0") + " 秒";
			const hours = Math.floor(minutes / 60);
			return hours + " 小时 " + (minutes % 60) + " 分";
		}

		/**
		 * 设置页外壳。
		 * @param props - `{ wallet }`。
		 * @returns 元素。
		 */
		function WalletSettingsSection({ wallet }) {
			const state = useStore(wallet);
			const data = state.data;
			const settings = data?.settings ?? FALLBACK_SETTINGS;
			const dark = useDark(settings.theme);
			const [page, setPage] = React.useState(lastSettingsPage);
			const [focusVendor, setFocusVendor] = React.useState("");
			const intent = useStore(settingsIntent);
			React.useEffect(() => {
				if (intent.seq === 0) return;
				setPage(intent.page);
				setFocusVendor(intent.vendor);
			}, [intent.seq, intent.page, intent.vendor]);

			const choose = (next) => {
				lastSettingsPage = next;
				setPage(next);
			};
			const pageName = page === "vendors" ? "厂商监控" : page === "tools" ? "其他工具" : "卡片样式";
			const kicker = page === "vendors" ? "我的钱包 / 数据源" : page === "tools" ? "我的钱包 / 保护与统计" : "我的钱包 / 外观";
			const hint =
				page === "vendors"
					? "开关只控制本插件是否读取；凭据在行内展开配置。"
					: page === "tools"
						? "限流、告警与日报都在本机完成，不额外请求厂商，也不改任何其他插件。"
						: "三个页面沿用应用设置页的纸面、发丝线与文字颜色；所有修改即时生效。";
			const saveText = state.settingsError !== "" ? "保存失败" : state.pending > 0 ? "保存中…" : "已保存";
			const saveClass = state.settingsError !== "" ? "dbc-saved dbc-error" : state.pending > 0 ? "dbc-saved dbc-busy" : "dbc-saved";

			const tab = (id, label) =>
				React.createElement(
					"button",
					{
						type: "button",
						role: "tab",
						className: "dbc-tab",
						"data-active": page === id,
						"aria-selected": page === id,
						onClick: () => choose(id),
					},
					label,
				);

			return React.createElement(
				"div",
				{ className: "dbc-root dbc-settings", "data-dark": dark === true ? "true" : "false", style: accentStyle(settings, dark) },
				React.createElement(
					"div",
					{ className: "dbc-settings-head" },
					React.createElement("span", { className: "dbc-kicker" }, kicker),
					React.createElement(
						"h2",
						{ className: "dbc-settings-title" },
						pageName,
						React.createElement("span", { className: saveClass, role: "status" }, saveText),
					),
					hint === "" ? null : React.createElement("p", { className: "dbc-settings-hint" }, hint),
					state.settingsError === "" ? null : React.createElement("p", { className: "dbc-settings-hint", style: { color: "var(--dbc-vermilion)" } }, state.settingsError),
				),
				React.createElement(
					"div",
					{ className: "dbc-tabs", role: "tablist", "aria-label": "我的钱包" },
					tab("style", "卡片样式"),
					tab("vendors", "厂商监控"),
					tab("tools", "其他工具"),
				),
				page === "vendors"
					? React.createElement(VendorsPage, {
							data,
							wallet,
							dark,
							settings,
							focusVendor,
							onFocusHandled: () => setFocusVendor(""),
							onGoTools: () => choose("tools"),
						})
					: page === "tools"
						? React.createElement(ToolsPage, { data, wallet, dark, settings })
						: React.createElement(StylePage, { data, wallet, dark, settings }),
			);
		}

		/**
		 * 页面 01：卡片样式。
		 * @param props - `{ data, wallet, dark, settings }`。
		 * @returns 元素。
		 */
		function StylePage({ data, wallet, dark, settings }) {
			const [previewState, setPreviewState] = React.useState("normal");
			const set = (key, value) => wallet.patch({ [key]: value });
			const setCard = (key, value) => wallet.patch({ card: { [key]: value } });

			// 预览优先用「当前已开启、且有读数」的厂商，否则用一张合成卡。
			const live = (data?.vendors ?? []).find(
				(vendor) => vendor.enabled && data?.readings?.[vendor.id]?.reading !== null && data?.readings?.[vendor.id]?.reading !== undefined,
			);
			const liveReading = live === undefined ? null : data.readings[live.id].reading;
			const previewVendor = live ?? { id: "baidu-qianfan", label: "百度千帆", short: "千", display: { unit: "积分" }, credential: { consoleUrl: "" } };
			const synthetic = {
				kind: "credits",
				unit: "积分",
				remaining: 9642,
				total: 10000,
				used: 358,
				percent: 96.42,
				windows: [
					{ id: "monthly", label: "月度 · Token Plan", remaining: 9642, total: 10000, used: 358, percent: 96.42, resetsAt: "", expiresAt: "", unlimited: false, note: "" },
				],
				primary: "monthly",
				note: "",
			};
			const reading = previewState === "normal" ? (liveReading ?? synthetic) : previewState === "low" ? { ...synthetic, remaining: 1200, used: 8800, percent: 12 } : null;
			const model =
				previewState === "fail"
					? { state: "error", vendor: previewVendor, reading: null, percent: null, warnPercent: 20, error: { code: "expired", message: "控制台登录已过期，请重新复制 Cookie。", advice: "重新登录控制台，复制完整 Cookie。" } }
					: { state: "ok", vendor: previewVendor, reading, percent: reading?.percent ?? null, warnPercent: 20, error: null, fetchedAt: Date.now() - 180000 };

			const styleOptions = STYLE_IDS.map((id) =>
				React.createElement(
					"button",
					{
						key: id,
						type: "button",
						className: "dbc-style-option",
						"data-active": settings.visualStyle === id,
						onClick: () => set("visualStyle", id),
					},
					React.createElement("b", null, STYLE_NAMES[id]),
					React.createElement("span", null, STYLE_HINTS[id]),
				),
			);

			return React.createElement(
				"div",
				{ className: "dbc-page" },
				React.createElement(
					"div",
					{ className: "dbc-preview-col" },
					React.createElement(
						"div",
						{ className: "dbc-preview-frame" },
						React.createElement(BalanceCard, { model, settings, dark, compact: true, preview: true }),
						React.createElement(
							"div",
							{ className: "dbc-preview-caption" },
							"264px 侧边栏 · 整卡可点，在原位展开明细",
						),
					),
					React.createElement(
						"div",
						{ style: { display: "flex", justifyContent: "center" } },
						React.createElement(Seg, {
							value: previewState,
							label: "预览状态",
							options: [
								{ value: "normal", label: "正常" },
								{ value: "low", label: "偏低" },
								{ value: "fail", label: "失败" },
							],
							onChange: setPreviewState,
						}),
					),
				),
				React.createElement(
					"div",
					null,
					React.createElement(
						Group,
						{ title: "外观", hint: "只改外观，不重新请求厂商数据。" },
						React.createElement(Row, {
							label: "视觉样式",
							hint: "默认方格；切换后预览立即更新。",
							wide: true,
							control: React.createElement("div", { className: "dbc-style-picker", style: { width: "100%" } }, styleOptions),
						}),
						React.createElement(Row, {
							label: "强调色",
							control: React.createElement(Seg, {
								value: settings.accent,
								label: "强调色",
								options: [
									{ value: "jade", label: "品牌" },
									{ value: "ink", label: "深灰" },
									{ value: "amber", label: "琥珀" },
									{ value: "vendor", label: "跟随厂商" },
								],
								onChange: (value) => set("accent", value),
							}),
						}),
						React.createElement(Row, {
							label: "密度",
							control: React.createElement(Seg, {
								value: settings.density,
								label: "密度",
								options: [
									{ value: "comfortable", label: "舒朗" },
									{ value: "compact", label: "紧凑" },
								],
								onChange: (value) => set("density", value),
							}),
						}),
					),
					React.createElement(
						Group,
						{ title: "显示内容", hint: "关闭只隐藏对应元素，不改变读数。" },
						React.createElement(Row, {
							label: "百分比",
							control: React.createElement(Switch, { checked: settings.card.showPercent, label: "显示百分比", onChange: (value) => setCard("showPercent", value) }),
						}),
						React.createElement(Row, {
							label: "进度线 / 比例条",
							control: React.createElement(Switch, { checked: settings.card.showBar, label: "显示进度", onChange: (value) => setCard("showBar", value) }),
						}),
						React.createElement(Row, {
							label: "更新时间",
							control: React.createElement(Switch, { checked: settings.card.showUpdatedAt, label: "显示更新时间", onChange: (value) => setCard("showUpdatedAt", value) }),
						}),
						React.createElement(Row, {
							label: "厂商副标题",
							control: React.createElement(Switch, { checked: settings.card.showSubtitle, label: "显示副标题", onChange: (value) => setCard("showSubtitle", value) }),
						}),
						React.createElement(Row, {
							label: "状态文字",
							hint: "默认只用状态点；失败时仍会显示原因。",
							control: React.createElement(Switch, { checked: settings.card.showStatusText, label: "显示状态文字", onChange: (value) => setCard("showStatusText", value) }),
						}),
					),
					React.createElement(
						Group,
						{ title: "数值与刷新", hint: "金额保留两位小数；积分 / Tokens 取整。" },
						React.createElement(Row, {
							label: "千位分隔",
							control: React.createElement(Switch, { checked: settings.card.groupDigits, label: "千位分隔", onChange: (value) => setCard("groupDigits", value) }),
						}),
						React.createElement(Row, {
							label: "货币写法",
							control: React.createElement(Seg, {
								value: settings.card.currencyStyle,
								label: "货币写法",
								options: [
									{ value: "symbol", label: "符号" },
									{ value: "plain", label: "纯数字" },
								],
								onChange: (value) => setCard("currencyStyle", value),
							}),
						}),
						React.createElement(Row, {
							label: "刷新间隔",
							hint: "失败时按 1.6 倍退避，最长 30 分钟。",
							wide: true,
							control: React.createElement(Seg, {
								value: settings.card.pollMs,
								label: "刷新间隔",
								options: [
									{ value: 60000, label: "1 分钟" },
									{ value: 300000, label: "5 分钟" },
									{ value: 600000, label: "10 分钟" },
									{ value: 1800000, label: "30 分钟" },
								],
								onChange: (value) => setCard("pollMs", value),
							}),
						}),
					),
					React.createElement(
						Group,
						{ title: "交互", hint: "动效跟随系统；开启「减少动效」后只保留透明度变化。" },
						React.createElement(Row, {
							label: "点击卡片",
							control: React.createElement(Seg, {
								value: settings.card.clickAction,
								label: "点击卡片",
								options: [
									{ value: "panel", label: "展开明细" },
									{ value: "settings", label: "打开设置" },
								],
								onChange: (value) => setCard("clickAction", value),
							}),
						}),
						React.createElement(Row, {
							label: "在侧边栏显示卡片",
							control: React.createElement(Switch, { checked: settings.card.visible, label: "显示卡片", onChange: (value) => setCard("visible", value) }),
						}),
					),
				),
			);
		}

		/**
		 * 页面 02：厂商监控。
		 * @param props - `{ data, wallet, dark, settings, focusVendor, onFocusHandled, onGoTools }`。
		 * @returns 元素。
		 */
		function VendorsPage({ data, wallet, settings, focusVendor, onFocusHandled, onGoTools }) {
			const [query, setQuery] = React.useState("");
			const [filter, setFilter] = React.useState("all");
			const [expanded, setExpanded] = React.useState(focusVendor !== "" ? focusVendor : "");
			const [refreshing, setRefreshing] = React.useState(false);
			const [showMore, setShowMore] = React.useState(false);
			const searchRef = React.useRef(null);

			React.useEffect(() => {
				if (focusVendor === "") return;
				setExpanded(focusVendor);
				onFocusHandled();
			}, [focusVendor, onFocusHandled]);

			React.useEffect(() => {
				const onKey = (event) => {
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
						event.preventDefault();
						searchRef.current?.focus?.();
					}
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, []);

			const rows = [...(data?.vendors ?? []), ...(data?.unsupported ?? [])];
			const readings = data?.readings ?? {};
			// 开关状态以设置文档为准：乐观补丁先改它，快照行滞后也不会让开关回弹。
			const enabledOf = (row) => settings.vendors?.[row.id]?.enabled === true;
			const statusOfRow = (row) => {
				if (row.status === "unsupported") return "unsupported";
				if (!enabledOf(row)) return "off";
				if (row.configured !== true) return "unconfigured";
				const record = readings[row.id];
				if (record === undefined || record.status === "idle" || record.status === "loading") return "loading";
				if (record.status === "error") return "error";
				if (record.status === "stale") return "stale";
				return "ok";
			};
			const enabledCount = rows.filter((row) => enabledOf(row) && row.status !== "unsupported").length;
			const okCount = rows.filter((row) => statusOfRow(row) === "ok").length;
			const errorCount = rows.filter((row) => ["error", "stale"].includes(statusOfRow(row))).length;
			const unsupportedCount = rows.filter((row) => row.status === "unsupported").length;

			const matches = (row) => {
				const lower = query.trim().toLowerCase();
				if (lower !== "" && !(row.label + " " + row.id + " " + row.credential.type).toLowerCase().includes(lower)) return false;
				const status = statusOfRow(row);
				if (filter === "enabled") return enabledOf(row) && row.status !== "unsupported";
				if (filter === "error") return status === "error" || status === "stale" || status === "unconfigured";
				return true;
			};

			const groupOrder = ["console", "api", "custom", "more"];
			const groupLabels = {
				console: "控制台与订阅",
				api: "官方 API",
				custom: "自定义",
				more: "更多厂商",
			};

			const refreshAll = async () => {
				setRefreshing(true);
				await wallet.refresh("");
				setRefreshing(false);
			};

			return React.createElement(
				"div",
				{ className: "dbc-page-single" },
				React.createElement(
					"div",
					{ className: "dbc-summary" },
					React.createElement("div", { className: "dbc-stat" }, React.createElement("b", null, enabledCount + "/" + (rows.length - unsupportedCount)), React.createElement("span", null, "已开启")),
					React.createElement("div", { className: "dbc-stat" }, React.createElement("b", null, okCount), React.createElement("span", null, "正常")),
					React.createElement("div", { className: "dbc-stat" }, React.createElement("b", { style: { color: errorCount > 0 ? "var(--dbc-vermilion)" : undefined } }, errorCount), React.createElement("span", null, "异常")),
					React.createElement("div", { className: "dbc-stat" }, React.createElement("b", null, unsupportedCount), React.createElement("span", null, "暂不支持")),
					React.createElement("span", { className: "dbc-spacer" }),
					React.createElement("button", { type: "button", className: "dbc-btn", disabled: refreshing, onClick: refreshAll }, refreshing ? "刷新中…" : "全部刷新"),
				),
				React.createElement(
					"div",
					{ className: "dbc-toolbar" },
					React.createElement(
						"label",
						{ className: "dbc-search" },
						React.createElement(
							"svg",
							{ width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
							React.createElement("circle", { cx: 7, cy: 7, r: 5, stroke: "currentColor", strokeWidth: 1.3 }),
							React.createElement("path", { d: "M11 11l3 3", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
						),
						React.createElement("input", {
							ref: searchRef,
							type: "search",
							value: query,
							placeholder: "搜索厂商、凭据类型… (Ctrl/Cmd + K)",
							"aria-label": "搜索厂商",
							onChange: (event) => setQuery(event.target.value),
						}),
					),
					React.createElement(Seg, {
						value: filter,
						label: "过滤厂商",
						options: [
							{ value: "all", label: "全部" },
							{ value: "enabled", label: "已开启" },
							{ value: "error", label: "异常" },
						],
						onChange: setFilter,
					}),
				),
				groupOrder.map((group) => {
					const list = rows.filter((row) => row.group === group && matches(row));
					if (list.length === 0) return null;
					const moreOpen = showMore || query.trim() !== "" || filter !== "all";
					const folded = group === "more" && !moreOpen;
					return React.createElement(
						"div",
						{ key: group },
						React.createElement(
							"div",
							{ className: "dbc-group-head" },
							groupLabels[group] ?? group,
							group === "more"
								? React.createElement(
										"button",
										{
											type: "button",
											className: "dbc-link",
											onClick: () => setShowMore((value) => !value),
										},
										folded ? "展开" : "收起",
									)
								: null,
						),
						folded
							? null
							: React.createElement(
									"div",
									{ className: "dbc-vendor-list" },
									list.map((row) =>
										React.createElement(VendorRow, {
											key: row.id,
											row,
											record: readings[row.id],
											wallet,
											settings,
											expanded: expanded === row.id,
											onToggle: () => setExpanded(expanded === row.id ? "" : row.id),
											onGoTools,
										}),
									),
								),
					);
				}),
				React.createElement(
					"div",
					{ className: "dbc-tools-footer" },
					React.createElement(SettingsTools, { wallet }),
				),
				React.createElement(
					"p",
					{ style: { fontSize: 9.5, lineHeight: "14px", color: "var(--dbc-ink4)", marginTop: 12 } },
					"新增厂商只需一个 adapter；浏览器拿不到密钥，测试连接也只返回归一化读数。",
				),
			);
		}

		/**
		 * 一行厂商。
		 * @param props - `{ row, record, wallet, settings, expanded, onToggle, onGoTools }`。
		 * @returns 元素。
		 */
		function VendorRow({ row, record, wallet, settings, expanded, onToggle, onGoTools }) {
			const unsupported = row.status === "unsupported";
			const vendorSettings = settings.vendors?.[row.id] ?? { enabled: false };
			const enabled = vendorSettings.enabled === true;
			const reading = record?.reading ?? null;
			const status =
				unsupported
					? "暂不支持"
					: !enabled
						? "已关闭"
						: row.configured !== true
							? "待配置"
							: record?.status === "error"
								? "失败"
								: record?.status === "stale"
									? "缓存"
									: record?.status === "loading" || record?.status === "idle"
										? "读取中"
										: "正常";
			const chipClass = unsupported ? "" : status === "正常" ? "dbc-ok" : status === "失败" ? "dbc-bad" : status === "缓存" || status === "读取中" ? "dbc-warn" : "";
			const figures = reading === null ? null : figureOf(reading, settings);
			const unit = row.display?.unit ?? "";
			const subtitle = unsupported
				? row.note ?? "需要登录态插件"
				: row.credential.type === "cookie"
					? "控制台 Cookie"
					: row.credential.type === "oauth"
						? "OAuth Token"
						: row.credential.type === "aksk"
							? "AK / SK 签名"
							: row.credential.type === "custom"
								? "自定义 HTTPS"
								: row.credential.type === "none"
									? "无需凭据"
									: "API Key";

			return React.createElement(
				"div",
				{ className: "dbc-vendor" },
				React.createElement(
					"div",
					{ className: "dbc-vendor-row", onClick: unsupported ? undefined : onToggle, role: unsupported ? undefined : "button", tabIndex: unsupported ? undefined : 0, onKeyDown: (event) => { if (!unsupported && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onToggle(); } } },
					React.createElement(
						"div",
						{ className: "dbc-vendor-main" },
						React.createElement("span", { className: "dbc-vendor-badge", "aria-hidden": "true" }, row.short),
						React.createElement(
							"span",
							{ className: "dbc-vendor-text" },
							React.createElement(
								"span",
								{ className: "dbc-vendor-name" },
								row.label,
								row.status === "experimental" ? React.createElement("span", { className: "dbc-chip dbc-warn" }, "实验性") : null,
								React.createElement("span", { className: "dbc-chip " + chipClass }, status),
							),
							React.createElement("span", { className: "dbc-vendor-sub" }, subtitle + (row.display?.kind === "currency" ? " · 金额" : " · 额度")),
						),
					),
					React.createElement(
						"div",
						{ className: "dbc-vendor-read" },
						figures === null
							? React.createElement("b", { style: { color: "var(--dbc-ink3)", fontWeight: 500 } }, "—")
							: React.createElement("b", null, figures.prefix + figures.main + (figures.suffix === "" ? "" : figures.suffix)),
						figures === null
							? null
							: React.createElement("span", null, figures.percent === null ? unit : percentText(figures.percent)),
					),
					React.createElement(Switch, {
						checked: enabled && !unsupported,
						disabled: unsupported,
						label: "监控 " + row.label,
						onChange: (value) => wallet.patch({ vendors: { [row.id]: { enabled: value } } }),
					}),
					unsupported
						? React.createElement("span", { style: { width: 14 } })
						: React.createElement("span", { className: "dbc-chev", "data-open": expanded === true, "aria-hidden": "true" },
								React.createElement("svg", { width: 10, height: 10, viewBox: "0 0 10 10" }, React.createElement("path", { d: "M3 1.5L6.5 5 3 8.5", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })),
							),
				),
				unsupported || expanded !== true
					? null
					: React.createElement(VendorBody, { row, record, wallet, settings, vendorSettings, onGoTools }),
			);
		}

		/**
		 * 厂商展开面板。
		 * @param props - `{ row, record, wallet, settings, vendorSettings, onGoTools }`。
		 * @returns 元素。
		 */
		function VendorBody({ row, record, wallet, settings, vendorSettings, onGoTools }) {
			const setVendor = (patch) => wallet.patch({ vendors: { [row.id]: patch } });
			const advanced = vendorSettings.advanced ?? {};
			const setAdvanced = (key, value) => setVendor({ advanced: { ...advanced, [key]: value } });
			const windows = record?.reading?.windows ?? [];
			const budgetVisible = row.display?.kind === "currency";
			const isCustom = row.id === "custom" || row.id === "qwen";

			return React.createElement(
				"div",
				{ className: "dbc-vendor-body" },
				(row.credential.fields ?? []).map((field) =>
					React.createElement(CredentialEditor, {
						key: field.field,
						vendor: row,
						field,
						status: (row.credentialFields ?? []).find((entry) => entry.field === field.field),
						wallet,
					}),
				),
				React.createElement("div", { className: "dbc-subhead" }, "监控"),
				React.createElement(
					"div",
					{ className: "dbc-inline-fields" },
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"刷新间隔",
						React.createElement(
							"select",
							{
								value: vendorSettings.pollMs === null ? "global" : String(vendorSettings.pollMs),
								onChange: (event) => setVendor({ pollMs: event.target.value === "global" ? null : Number(event.target.value) }),
							},
							React.createElement("option", { value: "global" }, "跟随全局"),
							React.createElement("option", { value: "60000" }, "1 分钟"),
							React.createElement("option", { value: "300000" }, "5 分钟"),
							React.createElement("option", { value: "600000" }, "10 分钟"),
							React.createElement("option", { value: "1800000" }, "30 分钟"),
						),
					),
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"告警阈值（%）",
						React.createElement("input", {
							type: "number",
							min: 0,
							max: 100,
							value: vendorSettings.warnPercent === null ? "" : vendorSettings.warnPercent,
							placeholder: String(settings.card.warnPercent),
							onChange: (event) => {
								const raw = event.target.value;
								setVendor({ warnPercent: raw === "" ? null : Math.min(100, Math.max(0, Number(raw))) });
							},
						}),
					),
					windows.length > 0
						? React.createElement(
								"label",
								{ className: "dbc-field" },
								"主窗口",
								React.createElement(
									"select",
									{ value: vendorSettings.window, onChange: (event) => setVendor({ window: event.target.value }) },
									React.createElement("option", { value: "auto" }, "自动（最低百分比）"),
									windows.map((window) => React.createElement("option", { key: window.id, value: window.id }, window.label || window.id)),
								),
							)
						: null,
					budgetVisible
						? React.createElement(
								"label",
								{ className: "dbc-field" },
								"余额基准 / 预算",
								React.createElement("input", {
									type: "number",
									min: 0,
									step: "0.01",
									value: vendorSettings.budget === null ? "" : vendorSettings.budget,
									placeholder: "不设置就不显示百分比",
									onChange: (event) => setVendor({ budget: event.target.value === "" ? null : Number(event.target.value) }),
								}),
							)
						: null,
				),
				React.createElement(
					"details",
					null,
					React.createElement("summary", { style: { cursor: "pointer", fontSize: 10, color: "var(--dbc-ink3)" } }, "高级（端点 / 单位 / 超时）"),
					React.createElement(
						"div",
						{ className: "dbc-inline-fields", style: { marginTop: 8 } },
						React.createElement(
							"label",
							{ className: "dbc-field", style: { gridColumn: "1 / -1" } },
							"端点覆盖（HTTPS）",
							React.createElement("input", {
								type: "url",
								value: advanced.endpoint ?? "",
								placeholder: isCustom ? "https://example.com/balance" : "留空使用官方端点",
								onChange: (event) => setAdvanced("endpoint", event.target.value),
							}),
						),
						isCustom
							? React.createElement(
									"label",
									{ className: "dbc-field" },
									"JSON 路径",
									React.createElement("input", { value: advanced.jsonPath ?? "", placeholder: "data.balance", onChange: (event) => setAdvanced("jsonPath", event.target.value) }),
								)
							: null,
						isCustom
							? React.createElement(
									"label",
									{ className: "dbc-field" },
									"算式（可选）",
									React.createElement("input", { value: advanced.expression ?? "", placeholder: "value / 100", onChange: (event) => setAdvanced("expression", event.target.value) }),
								)
							: null,
						isCustom
							? React.createElement(
									"label",
									{ className: "dbc-field" },
									"单位",
									React.createElement("input", { value: advanced.unit ?? "", placeholder: "¥ / $ / 积分 / Tokens", onChange: (event) => setAdvanced("unit", event.target.value) }),
								)
							: null,
						row.id === "opendesign"
							? React.createElement(
									"label",
									{ className: "dbc-field" },
									"Workspace ID",
									React.createElement("input", { value: advanced.workspaceId ?? "", onChange: (event) => setAdvanced("workspaceId", event.target.value) }),
								)
							: null,
						row.id === "factory"
							? React.createElement(
									"label",
									{ className: "dbc-field" },
									"Organization ID",
									React.createElement("input", { value: advanced.orgId ?? "", onChange: (event) => setAdvanced("orgId", event.target.value) }),
								)
							: null,
						row.id === "chatgpt"
							? React.createElement(
									"label",
									{ className: "dbc-field" },
									"ChatGPT Account ID",
									React.createElement("input", { value: advanced.accountId ?? "", onChange: (event) => setAdvanced("accountId", event.target.value) }),
								)
							: null,
						React.createElement(
							"label",
							{ className: "dbc-field", style: { flexDirection: "row", alignItems: "center", gap: 7, gridColumn: "1 / -1" } },
							React.createElement(Switch, { checked: advanced.allowPrivate === true, label: "允许私有网段", onChange: (value) => setAdvanced("allowPrivate", value) }),
							"允许私有网段（仅自定义接口，默认拒绝）",
						),
					),
				),
				React.createElement(
					"div",
					{ className: "dbc-lastread" },
					"最近读取：" +
						(record?.fetchedAt ? relativeTime(record.fetchedAt) : "尚未读取") +
						(record?.error ? " · " + (record.error.code ?? "") + " " + (record.error.message ?? "") : ""),
				),
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 10 } },
					React.createElement("button", { type: "button", className: "dbc-link", onClick: onGoTools }, "限流保护 → 其他工具"),
					React.createElement("span", { className: "dbc-spacer" }),
					React.createElement("button", {
						type: "button",
						className: "dbc-mini-btn",
						onClick: async () => {
							await wallet.refresh(row.id);
						},
					}, "刷新这一家"),
				),
			);
		}

		/**
		 * 凭据编辑器。
		 * @param props - `{ vendor, field, status, wallet }`。
		 * @returns 元素。
		 */
		function CredentialEditor({ vendor, field, status, wallet }) {
			const configured = status?.configured === true;
			const [editing, setEditing] = React.useState(!configured);
			const [value, setValue] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [result, setResult] = React.useState(null);
			const [confirmClear, setConfirmClear] = React.useState(false);

			const runTest = async (withValue) => {
				setBusy(true);
				setResult(null);
				const answer = await postJson(CREDENTIAL_TEST_ROUTE, {
					vendorId: vendor.id,
					field: field.field,
					...(withValue === true ? { value } : {}),
				});
				setBusy(false);
				if (answer.ok && answer.body?.ok === true) {
					const outcome = answer.body.value;
					if (outcome.reachable === true) {
						const reading = outcome.reading;
						const figures = figureOf(reading, FALLBACK_SETTINGS);
						setResult({ good: true, text: "连接正常 · " + (figures.prefix + figures.main + figures.suffix) + (figures.percent === null ? "" : " · " + percentText(figures.percent)) });
					} else {
						setResult({ good: false, text: (outcome.error?.message ?? outcome.message ?? "连接失败") });
					}
				} else {
					setResult({ good: false, text: answer.body?.error?.message ?? "测试请求失败。" });
				}
			};

			const save = async () => {
				if (value.trim() === "") return;
				setBusy(true);
				const saved = await postJson(CREDENTIAL_ROUTE, { vendorId: vendor.id, field: field.field, value });
				if (!saved.ok || saved.body?.ok !== true) {
					setBusy(false);
					setResult({ good: false, text: saved.body?.error?.message ?? "保存失败。" });
					return;
				}
				await runTest(false);
				setEditing(false);
				setValue("");
				await wallet.load();
			};

			const clear = async () => {
				setBusy(true);
				await postJson(CREDENTIAL_CLEAR_ROUTE, { vendorId: vendor.id, field: field.field });
				setBusy(false);
				setConfirmClear(false);
				setEditing(true);
				setResult(null);
				await wallet.load();
			};

			const mask = status?.preview ?? "";
			const external = status?.external === true;
			const maskText = configured
				? "•••• " + mask + (external ? " · DSH" : status?.source ? " · " + status.source : "")
				: "未配置";
			return React.createElement(
				"div",
				{ className: "dbc-cred" },
				React.createElement(
					"div",
					{ className: "dbc-cred-head" },
					React.createElement("b", null, field.label),
					React.createElement("span", { className: "dbc-mask", title: maskText }, maskText),
				),
				editing
					? React.createElement(
							React.Fragment,
							null,
							field.multiline
								? React.createElement("textarea", {
										rows: 3,
										value,
										placeholder: "粘贴完整 Cookie（可含 Cookie: 前缀）",
										"aria-label": field.label,
										onChange: (event) => setValue(event.target.value),
									})
								: React.createElement("input", {
										type: "password",
										value,
										placeholder: "粘贴 " + field.label,
										"aria-label": field.label,
										onChange: (event) => setValue(event.target.value),
									}),
							React.createElement(
								"div",
								{ className: "dbc-cred-actions" },
								React.createElement("button", { type: "button", className: "dbc-mini-btn", disabled: busy || value.trim() === "", onClick: save }, busy ? "测试中…" : "保存并测试"),
								React.createElement("button", { type: "button", className: "dbc-mini-btn", disabled: busy || value.trim() === "", onClick: () => runTest(true) }, "仅测试"),
								configured
									? React.createElement("button", { type: "button", className: "dbc-mini-btn", disabled: busy, onClick: () => { setEditing(false); setValue(""); setResult(null); } }, "取消")
									: null,
							),
						)
					: React.createElement(
							"div",
							{ className: "dbc-cred-actions" },
							React.createElement("button", { type: "button", className: "dbc-mini-btn", disabled: busy, onClick: () => { setEditing(true); setResult(null); } }, "更换"),
							React.createElement("button", { type: "button", className: "dbc-mini-btn", disabled: busy, onClick: () => runTest(false) }, busy ? "测试中…" : "测试连接"),
							external
								? null
								: confirmClear
									? React.createElement("button", { type: "button", className: "dbc-mini-btn dbc-danger", disabled: busy, onClick: clear }, "确认清除")
									: React.createElement("button", { type: "button", className: "dbc-mini-btn dbc-danger", disabled: busy, onClick: () => setConfirmClear(true) }, "清除"),
						),
					result === null
						? null
						: React.createElement("div", { className: "dbc-cred-result " + (result.good ? "dbc-good" : "dbc-bad") }, result.text),
					React.createElement("div", { className: "dbc-cred-hint" }, vendor.credential.hint),
					external
						? React.createElement(
								"div",
								{ className: "dbc-cred-hint" },
								"当前复用 DSH 已配置的密钥；在这里保存会写入本插件引用并优先使用。",
							)
						: null,
				);
		}

		/**
		 * 厂商页底部设置工具。
		 * @param props - `{ wallet }`。
		 * @returns 元素。
		 */
		function SettingsTools({ wallet }) {
			const [note, setNote] = React.useState("");
			const fileRef = React.useRef(null);

			const exportSettings = async () => {
				const answer = await readJson(EXPORT_ROUTE);
				if (!answer.ok || answer.body?.ok !== true) {
					setNote("导出失败。");
					return;
				}
				const blob = new Blob([JSON.stringify(answer.body.value, null, 2)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = "dsh-balance-card-settings.json";
				link.click();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				setNote("已导出（不含密钥）。");
			};

			const importSettings = async (file) => {
				if (file === undefined) return;
				try {
					const text = await file.text();
					const parsed = JSON.parse(text);
					const answer = await postJson(IMPORT_ROUTE, parsed);
					setNote(answer.ok && answer.body?.ok === true ? "已导入设置。" : answer.body?.error?.message ?? "导入失败。");
					await wallet.load();
				} catch {
					setNote("文件不是合法 JSON。");
				}
			};

			const diagnostics = async () => {
				const answer = await readJson(DIAGNOSTICS_ROUTE);
				if (!answer.ok || answer.body?.ok !== true) {
					setNote("诊断读取失败。");
					return;
				}
				const text = JSON.stringify(answer.body.value, null, 2);
				try {
					await navigator.clipboard.writeText(text);
					setNote("诊断信息已复制（已脱敏）。");
				} catch {
					setNote("复制失败；诊断已写入控制台。");
					console.log(text);
				}
			};

			return React.createElement(
				React.Fragment,
				null,
				React.createElement("button", { type: "button", className: "dbc-link", onClick: exportSettings }, "导出配置"),
				React.createElement("button", { type: "button", className: "dbc-link", onClick: () => fileRef.current?.click?.() }, "导入配置"),
				React.createElement("button", { type: "button", className: "dbc-link", onClick: diagnostics }, "复制诊断"),
				React.createElement("input", {
					ref: fileRef,
					type: "file",
					accept: "application/json",
					style: { display: "none" },
					onChange: (event) => {
						void importSettings(event.target.files?.[0]);
						event.target.value = "";
					},
				}),
				note === "" ? null : React.createElement("span", { style: { fontSize: 9.5, color: "var(--dbc-ink4)" } }, note),
			);
		}

		/* =====================================================================
		 * 页面 03：其他工具
		 * ===================================================================== */

		/** 限流徽标文案。 */
		const THROTTLE_BADGE = {
			normal: { label: "正常", tone: "dbc-ok" },
			cooldown: { label: "冷却中", tone: "dbc-warn" },
			safe: { label: "安全模式", tone: "dbc-bad" },
			off: { label: "已关闭", tone: "" },
		};

		/** 业务路由状态（只展示与读数有关的列）。 */
		function routeLabel(route) {
			const model = typeof route.model === "string" && route.model !== "" ? route.model : "*";
			const provider = typeof route.provider === "string" ? route.provider : "";
			return provider + " / " + model;
		}

		/**
		 * 工具卡外壳。
		 * @param props - `{ icon, name, desc, badge, checked, onToggle, open, onOpen, children }`。
		 * @returns 元素。
		 */
		function ToolCard({ icon, name, desc, badge, checked, onToggle, open, onOpen, children }) {
			return React.createElement(
				"div",
				{ className: "dbc-tool" },
				React.createElement(
					"div",
					{ className: "dbc-tool-row", onClick: onOpen, role: "button", tabIndex: 0, onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } } },
					React.createElement("span", { className: "dbc-tool-icon", "aria-hidden": "true" }, icon),
					React.createElement(
						"span",
						{ className: "dbc-tool-text" },
						React.createElement(
							"span",
							{ className: "dbc-tool-name" },
							name,
							badge === undefined || badge === "" ? null : React.createElement("span", { className: "dbc-chip " + (badge.tone ?? "") }, badge.label),
						),
						React.createElement("span", { className: "dbc-tool-desc" }, desc),
					),
					React.createElement(Switch, {
						checked: checked,
						label: name,
						onChange: (value) => {
							if (onToggle !== undefined) onToggle(value);
						},
					}),
					React.createElement("span", { className: "dbc-chev", "data-open": open === true, "aria-hidden": "true" },
						React.createElement("svg", { width: 10, height: 10, viewBox: "0 0 10 10" }, React.createElement("path", { d: "M3 1.5L6.5 5 3 8.5", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })),
					),
				),
				open === true ? React.createElement("div", { className: "dbc-tool-body" }, children) : null,
			);
		}

		/**
		 * 千帆限流工具。
		 * @param props - `{ data, wallet, settings }`。
		 * @returns 元素。
		 */
		function ThrottleTool({ data, wallet, settings }) {
			const [open, setOpen] = React.useState(false);
			const [status, setStatus] = React.useState(data?.tools?.qianfanThrottle?.status ?? null);
			const [confirmReset, setConfirmReset] = React.useState(false);
			const tool = settings.tools.qianfanThrottle;
			const mode = tool.enabled !== true ? "off" : tool.mode === "manual" ? "manual" : "dynamic";
			const setTool = (patch) => wallet.patch({ tools: { qianfanThrottle: patch } });

			React.useEffect(() => {
				let live = true;
				const tick = async () => {
					const answer = await readJson(THROTTLE_STATUS_ROUTE);
					if (live && answer.ok && answer.body?.ok === true) setStatus(answer.body.value);
				};
				void tick();
				const timer = setInterval(() => void tick(), 5000);
				return () => {
					live = false;
					clearInterval(timer);
				};
			}, []);

			const badge = THROTTLE_BADGE[status?.badge ?? "off"] ?? THROTTLE_BADGE.off;
			const active = status?.active ?? null;
			const routes = Array.isArray(status?.routes) ? status.routes.slice(0, 8) : [];
			const presetKey = tool.preset === "unlimited" ? null : tool.preset;
			const manual = tool.manual?.[presetKey] ?? tool.manual?.mid;

			const reset = async () => {
				const answer = await postJson(THROTTLE_RESET_ROUTE, {});
				if (answer.ok && answer.body?.ok === true) setStatus(answer.body.value);
				setConfirmReset(false);
			};

			return React.createElement(
				ToolCard,
				{
					icon: React.createElement("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none" }, React.createElement("path", { d: "M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M12 12l-2-2M12 4l-2 2M4 12l2-2", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" })),
					name: "百度千帆限流",
					desc: active === null ? "尚未观测到千帆请求" : "学习上限 " + active.learned.rpm + " RPM · " + active.learned.tpm + " TPM",
					badge,
					checked: tool.enabled === true,
					onToggle: (value) => setTool({ enabled: value, ...(value ? { mode: tool.mode === "manual" ? "manual" : "dynamic" } : {}) }),
					open,
					onOpen: () => setOpen((value) => !value),
				},
				React.createElement(
					"div",
					{ className: "dbc-throttle-grid" },
					React.createElement("div", { className: "dbc-metric" }, React.createElement("span", null, "学习 RPM"), React.createElement("b", null, active === null ? "—" : String(active.learned.rpm))),
					React.createElement("div", { className: "dbc-metric" }, React.createElement("span", null, "学习 TPM"), React.createElement("b", null, active === null ? "—" : grouped(active.learned.tpm))),
					React.createElement("div", { className: "dbc-metric" }, React.createElement("span", null, "并发"), React.createElement("b", null, status?.maxConcurrent ?? tool.maxConcurrent)),
					React.createElement("div", { className: "dbc-metric" }, React.createElement("span", null, "当前冷却"), React.createElement("b", null, status?.cooldownRemainingMs > 0 ? waitText(status.cooldownRemainingMs) : "无")),
					React.createElement("div", { className: "dbc-metric" }, React.createElement("span", null, "队列"), React.createElement("b", null, status?.queued ?? 0)),
				),
				React.createElement(
					"div",
					{ className: "dbc-inline-fields" },
					React.createElement(
						"label",
						{ className: "dbc-field", style: { gridColumn: "1 / -1" } },
						"模式",
						React.createElement(Seg, {
							value: mode,
							label: "限流模式",
							options: [
								{ value: "off", label: "关闭" },
								{ value: "manual", label: "固定" },
								{ value: "dynamic", label: "动态" },
							],
							onChange: (value) => {
								if (value === "off") setTool({ enabled: false });
								else setTool({ enabled: true, mode: value });
							},
						}),
					),
					mode === "manual"
						? React.createElement(
								"label",
								{ className: "dbc-field", style: { gridColumn: "1 / -1" } },
								"预设",
								React.createElement(Seg, {
									value: tool.preset,
									label: "限流预设",
									options: [
										{ value: "low", label: "稳健" },
										{ value: "mid", label: "均衡" },
										{ value: "high", label: "激进" },
										{ value: "unlimited", label: "无限制" },
									],
									onChange: (value) => setTool({ preset: value }),
								}),
							)
						: null,
					mode === "manual" && presetKey !== null
						? React.createElement(
								React.Fragment,
								null,
								React.createElement(
									"label",
									{ className: "dbc-field" },
									"RPM",
									React.createElement("input", {
										type: "number",
										min: 1,
										max: 600,
										value: manual?.rpm ?? "",
										onChange: (event) => setTool({ manual: { ...tool.manual, [presetKey]: { ...manual, rpm: Number(event.target.value) } } }),
									}),
								),
								React.createElement(
									"label",
									{ className: "dbc-field" },
									"TPM",
									React.createElement("input", {
										type: "number",
										min: 1000,
										max: 10000000,
										value: manual?.tpm ?? "",
										onChange: (event) => setTool({ manual: { ...tool.manual, [presetKey]: { ...manual, tpm: Number(event.target.value) } } }),
									}),
								),
								React.createElement(
									"label",
									{ className: "dbc-field" },
									"并发",
									React.createElement("input", {
										type: "number",
										min: 1,
										max: 64,
										value: manual?.concurrency ?? "",
										onChange: (event) => setTool({ manual: { ...tool.manual, [presetKey]: { ...manual, concurrency: Number(event.target.value) } } }),
									}),
								),
							)
						: null,
					mode !== "off"
						? React.createElement(
								"label",
								{ className: "dbc-field", style: { gridColumn: "1 / -1" } },
								"安全系数 " + Math.round(tool.safety * 100) + "%",
								React.createElement("input", {
									className: "dbc-slider",
									type: "range",
									min: 50,
									max: 95,
									step: 1,
									value: Math.round(tool.safety * 100),
									onChange: (event) => setTool({ safety: Number(event.target.value) / 100 }),
								}),
							)
						: null,
					mode === "dynamic"
						? React.createElement(
								"label",
								{ className: "dbc-field", style: { gridColumn: "1 / -1" } },
								"向上试探节奏",
								React.createElement(Seg, {
									value: tool.probePace,
									label: "试探节奏",
									options: [
										{ value: "frequent", label: "频繁" },
										{ value: "normal", label: "正常" },
										{ value: "conservative", label: "保守" },
										{ value: "rare", label: "几乎不" },
									],
									onChange: (value) => setTool({ probePace: value }),
								}),
							)
						: null,
					mode === "dynamic"
						? React.createElement(
								"div",
								{ className: "dbc-cred-hint", style: { gridColumn: "1 / -1" } },
								"频繁 30 分钟 · 正常 2 小时 · 保守 6 小时 · 几乎不 24 小时；451 失败后退避 10/20/40/60 分钟。",
							)
						: null,
				),
				mode === "dynamic"
					? React.createElement(Row, {
							label: "自动向上试探",
							hint: "连续无 429 且读数稳定后，小步提高上限。",
							control: React.createElement(Switch, { checked: tool.probe, label: "自动试探", onChange: (value) => setTool({ probe: value }) }),
						})
					: null,
				React.createElement(
					"details",
					null,
					React.createElement("summary", { style: { cursor: "pointer", fontSize: 10, color: "var(--dbc-ink3)" } }, "路由明细"),
					routes.length === 0
						? React.createElement("div", { className: "dbc-empty-note" }, "还没有观测到千帆路由。")
						: React.createElement(
								"div",
								{ className: "dbc-routes", style: { marginTop: 8 } },
								React.createElement(
									"div",
									{ className: "dbc-route-row" },
									React.createElement("span", null, "路由"),
									React.createElement("span", null, "学习 RPM"),
									React.createElement("span", null, "上限 RPM"),
									React.createElement("span", null, "并发"),
									React.createElement("span", null, "状态"),
								),
								routes.map((route) =>
									React.createElement(
										"div",
										{ key: route.provider + "/" + route.model, className: "dbc-route-row" },
										React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, routeLabel(route)),
										React.createElement("span", null, String(route.learned.rpm)),
										React.createElement("span", null, String(route.ceiling.rpm)),
										React.createElement("span", null, String(route.targets.concurrency)),
										React.createElement("span", null, (THROTTLE_BADGE[route.badge] ?? THROTTLE_BADGE.normal).label),
									),
								),
							),
				),
				status?.lastFailure
					? React.createElement("div", { className: "dbc-cred-hint" }, "最近一次失败：" + (status.lastFailure.code ?? "未知") + " · " + (status.lastFailure.message ?? ""))
					: null,
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 10 } },
					confirmReset
						? React.createElement("button", { type: "button", className: "dbc-mini-btn dbc-danger", onClick: reset }, "确认重置学习值")
						: React.createElement("button", { type: "button", className: "dbc-mini-btn", onClick: () => setConfirmReset(true) }, "重置学习值"),
					React.createElement("span", { style: { fontSize: 9.5, color: "var(--dbc-ink4)" } }, "重置只清空本机学习状态，不改变设置。"),
				),
			);
		}

		/**
		 * 低余额告警工具。
		 * @param props - `{ settings, wallet }`。
		 * @returns 元素。
		 */
		function AlertTool({ settings, wallet }) {
			const [open, setOpen] = React.useState(false);
			const alert = settings.tools.lowBalanceAlert;
			const setAlert = (patch) => wallet.patch({ tools: { lowBalanceAlert: patch } });
			const quiet = alert.quietHours;
			return React.createElement(
				ToolCard,
				{
					icon: React.createElement("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none" }, React.createElement("path", { d: "M8 2a4 4 0 00-4 4v3l-1.2 2h10.4L12 9V6a4 4 0 00-4-4zM6.5 13a1.5 1.5 0 003 0", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round" })),
					name: "低余额告警",
					desc: "低于 " + alert.warnPercent + "% 转琥珀，低于 " + alert.criticalPercent + "% 转朱砂",
					badge: alert.enabled ? { label: "已开启", tone: "dbc-ok" } : { label: "已关闭", tone: "" },
					checked: alert.enabled,
					onToggle: (value) => setAlert({ enabled: value }),
					open,
					onOpen: () => setOpen((value) => !value),
				},
				React.createElement(
					"div",
					{ className: "dbc-inline-fields" },
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"告警阈值（%）",
						React.createElement("input", {
							type: "number",
							min: 0,
							max: 100,
							value: alert.warnPercent,
							onChange: (event) => setAlert({ warnPercent: Number(event.target.value) }),
						}),
					),
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"临界阈值（%）",
						React.createElement("input", {
							type: "number",
							min: 0,
							max: 100,
							value: alert.criticalPercent,
							onChange: (event) => setAlert({ criticalPercent: Number(event.target.value) }),
						}),
					),
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"安静时段开始",
						React.createElement("input", {
							type: "time",
							value: quiet?.start ?? "22:00",
							onChange: (event) => setAlert({ quietHours: { start: event.target.value, end: quiet?.end ?? "08:00" } }),
						}),
					),
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"安静时段结束",
						React.createElement("input", {
							type: "time",
							value: quiet?.end ?? "08:00",
							onChange: (event) => setAlert({ quietHours: { start: quiet?.start ?? "22:00", end: event.target.value } }),
						}),
					),
				),
				React.createElement(Row, {
					label: "系统通知",
					hint: "当前宿主未暴露通知服务，自动降级为卡片变色。",
					control: React.createElement(Switch, { checked: alert.notify, label: "系统通知", onChange: (value) => setAlert({ notify: value }) }),
				}),
				React.createElement("div", { className: "dbc-cred-hint" }, "每厂商可在「厂商监控」的展开面板里覆盖阈值。"),
			);
		}

		/**
		 * 用量日报工具。
		 * @param props - `{ data, settings, wallet }`。
		 * @returns 元素。
		 */
		function ReportTool({ data, settings, wallet }) {
			const [open, setOpen] = React.useState(false);
			const report = settings.tools.dailyReport;
			const days = data?.tools?.dailyReport?.days ?? [];
			const digest = data?.tools?.dailyReport?.digest ?? null;
			const setReport = (patch) => wallet.patch({ tools: { dailyReport: patch } });
			const vendorLabel = (id) => (data?.vendors ?? []).find((row) => row.id === id)?.label ?? id;
			return React.createElement(
				ToolCard,
				{
					icon: React.createElement("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none" }, React.createElement("path", { d: "M3 2h10v12H3zM5 11l2-3 2 2 2-4", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round" })),
					name: "用量日报",
					desc: report.enabled ? "每天 " + report.time + " 汇总昨日消耗" : "本地快照差分，不额外请求厂商",
					badge: report.enabled ? { label: "已开启", tone: "dbc-ok" } : { label: "已关闭", tone: "" },
					checked: report.enabled,
					onToggle: (value) => setReport({ enabled: value }),
					open,
					onOpen: () => setOpen((value) => !value),
				},
				React.createElement(
					"div",
					{ className: "dbc-inline-fields" },
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"汇总时间",
						React.createElement("input", { type: "time", value: report.time, onChange: (event) => setReport({ time: event.target.value }) }),
					),
					React.createElement(
						"label",
						{ className: "dbc-field" },
						"形式",
						React.createElement(Seg, {
							value: report.format,
							label: "日报形式",
							options: [
								{ value: "digest", label: "摘要" },
								{ value: "detail", label: "明细" },
							],
							onChange: (value) => setReport({ format: value }),
						}),
					),
				),
				digest === null
					? null
					: React.createElement(
							"div",
							{ className: "dbc-cred-result dbc-good" },
							"昨日汇总（" +
								digest.date +
								"）：" +
								digest.vendors
									.slice(0, 4)
									.map((row) => vendorLabel(row.id) + " " + (row.consumed ?? 0) + (row.unit ?? ""))
									.join(" · "),
						),
				days.length === 0
					? React.createElement("div", { className: "dbc-empty-note" }, "还没有本地快照；卡片读取一次后开始记录。")
					: React.createElement(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 6 } },
							days.map((day) =>
								React.createElement(
									"div",
									{ key: day.date, style: { display: "flex", alignItems: "baseline", gap: 10, fontSize: 10 } },
									React.createElement("span", { className: "dbc-mono", style: { color: "var(--dbc-ink4)", width: 78 } }, day.date),
									React.createElement(
										"span",
										{ style: { flex: 1, color: "var(--dbc-ink2)" } },
										day.vendors.length === 0
											? "无记录"
											: day.vendors.map((row) => vendorLabel(row.id) + " " + (row.consumed ?? 0) + (row.unit ?? "")).join(" · "),
									),
								),
							),
						),
				React.createElement("div", { className: "dbc-cred-hint" }, "首版不做 CSV 导出；日报只保留最近 14 天。"),
			);
		}

		/**
		 * 页面 03 外壳。
		 * @param props - `{ data, wallet, dark, settings }`。
		 * @returns 元素。
		 */
		function ToolsPage({ data, wallet, settings }) {
			return React.createElement(
				"div",
				{ className: "dbc-page-single" },
				React.createElement(ThrottleTool, { data, wallet, settings }),
				React.createElement(AlertTool, { settings, wallet }),
				React.createElement(ReportTool, { data, settings, wallet }),
				React.createElement(
					"div",
					{ className: "dbc-empty-slot" },
					"自定义工具槽位 · 后续工具内置注册，不执行外部代码",
				),
			);
		}

		/* =====================================================================
		 * 注册
		 * ===================================================================== */

		/**
		 * 会话感知：把当前会话 id 放进 slot，供卡片读取模型目录。
		 * @param props - `{ sessionId, slot }`。
		 * @returns null。
		 */
		function SessionSensor({ sessionId, slot }) {
			React.useEffect(() => {
				slot.set(sessionId ?? null);
				return () => slot.set(null);
			}, [sessionId, slot]);
			return null;
		}

		/** 没有硬依赖：全部服务都在 apply 内通过 ctx.inject 获取。 */
		const inject = [];

		/**
		 * 注册侧边栏卡片、会话感知与设置 section。
		 * @param ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			injectStyle();
			const optional = createSlot(undefined);
			const session = createSlot(undefined);
			const wallet = createWalletStore();

			ctx.inject(["modelDirectories"], (scope) => {
				optional.set({ ...(optional.getSnapshot() ?? {}), models: scope.modelDirectories });
			});

			ctx.inject(["sessions"], (scope) => {
				optional.set({ ...(optional.getSnapshot() ?? {}), sessions: scope.sessions });
			});

			ctx.inject(["slots"], (scope) => {
				settingsShellSlots = scope.slots;
				scope.slots.inject(SESSION_SLOT, () =>
					scope.slots.register(
						{
							name: SESSION_SLOT,
							id: "balance-session",
							order: 100,
							inject: (sessionId) => ({ sessionId }),
						},
						(props) => React.createElement(SessionSensor, { sessionId: props.sessionId, slot: session }),
					),
				);

				// 只保留左下角卡片：输入框胶囊已从 2.0 删除。
				scope.slots.inject(SIDEBAR_SLOT, () =>
					scope.slots.register(
						{
							name: SIDEBAR_SLOT,
							id: "balance-sidebar-card",
							order: 40,
							label: "余额监测",
							inject: () => ({ optional, session, wallet }),
						},
						(props) =>
							React.createElement(SidebarBalanceSeat, {
								optional: props.optional,
								session: props.session,
								wallet: props.wallet,
								wide: props.wide,
							}),
					),
				);

				scope.slots.inject(SETTINGS_SECTION_SLOT, () =>
					scope.slots.register(
						{
							name: SETTINGS_SECTION_SLOT,
							id: SECTION_ID,
							order: 60,
							label: () => "我的钱包",
							inject: () => ({ wallet }),
						},
						(props) => React.createElement(WalletSettingsSection, { wallet: props.wallet }),
					),
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.BalanceCard = BalanceCard;
		exports.SidebarBalanceSeat = SidebarBalanceSeat;
		exports.SessionSensor = SessionSensor;
		exports.WalletSettingsSection = WalletSettingsSection;
		exports.StylePage = StylePage;
		exports.VendorsPage = VendorsPage;
		exports.ToolsPage = ToolsPage;
		exports.DetailPanel = DetailPanel;
		exports.createWalletStore = createWalletStore;
		exports.cardModel = cardModel;
		exports.figureOf = figureOf;
		exports.percentText = percentText;
		exports.relativeTime = relativeTime;
		exports.accentStyle = accentStyle;
		exports.mergeSettings = mergeSettings;
		exports.vendorIdOf = vendorIdOf;
		exports.FALLBACK_SETTINGS = FALLBACK_SETTINGS;
		exports.STYLE_IDS = STYLE_IDS;
		exports.CSS = CSS;

		return module.exports;
	},
});