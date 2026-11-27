/**
 * 百度千帆限流阀门 — 宿主接线。
 *
 * 这里把 `lib/throttle.js` 的纯算法接到真实运行时上：一个 `llm/stream`
 * 中间件做闸门与观测、一个先进先出的排队器、一个定时 tick（恢复增长 / 每日衰减 /
 * 状态落盘），以及状态面板与重置入口。
 *
 * ## 为什么闸门挂在 `llm/stream` 而不是 `agent/request`
 *
 * 三个候选接线点，探针结论如下（dsh 0.2.2-rc.5 源码核对 + 实际行为验证）：
 *
 * | 接线点 | 参数 | 能否 await 延迟 | 能否看到 messages/tools | 能否看到用量/失败码 |
 * | --- | --- | --- | --- | --- |
 * | `agent/request` | `{turn, step, signal}` → 返回 call config | 能（外层 await） | **不能**（只有 provider/model/采样参数，消息在此之后才由会话拼出） | 不能 |
 * | `llm-pi-ai/request-headers` | `(request, headers)`，同步 | **不能**（同步 waterfall，await 会被忽略） | 能（request 里就有） | 否 |
 * | `llm/stream` | `GenerateOptions`（provider/model/messages/tools/maxTokens/signal…） | 能（返回 asyncIterable，可在首次 next 前 await） | 能 | 能（`usage` / `finish.failure`） |
 *
 * `agent/request` 缺的恰好是限流最需要的两样东西：一次请求有多大（messages/tools）
 * 和这次的结果（429 还是成功）。而 `llm/stream` 是唯一同时给出「完整请求」与
 * 「完整流事件」的位置，且它的返回值是 async iterable —— 只要在第一次 `next()`
 * 之前等待，HTTP 请求就真的还没发出去。因此这里的选择不是偏好，而是能力决定的。
 *
 * 代价是闸门运行时 `AssistantStreamAttempt` 已经 `start()`（界面上会先显示
 * 「正在生成」再开始等），这是排队语义本身，不是错误。
 *
 * @module dsh-balance-card/throttle-host
 */
import {
	MAX_QUEUE_DEPTH,
	MAX_QUEUE_WAIT_MS,
	PROBE_PACE_DEFAULT,
	PROBE_PACE_IDS,
	WINDOW_MS,
	applyAdmission,
	applyCompletion,
	applyDailyUpkeep,
	applyGrowth,
	applyLimitSignal,
	applyRateLimit,
	classifyFailure,
	createRouteState,
	failureGuidance,
	needTokens,
	planAdmission,
	pruneWindow,
	priorFor,
	resetLearning,
	resolveTargets,
	statusOf,
} from './throttle.js'
import { loadThrottleState, writeThrottleState } from './throttle-state.js'

/** 设置快照的最长新鲜期：文件很小，但没必要为每个 chunk 读一次磁盘。 */
const SETTINGS_TTL_MS = 2_000
/** 排队器重新评估的最大间隔：并发名额靠释放唤醒，这里只是兜底与冷却计时。 */
const POLL_MS = 400
/** 状态 tick 间隔：恢复增长 / 每日衰减 / 落盘都在这里做。 */
const TICK_MS = 5_000

/** 这个阀门治理的路由：provider 名里出现 qianfan / baidu 即可（大小写无关）。 */
const QIANFAN_PROVIDER = /(?:qianfan|baidu)/iu

/**
 * 是否属于本阀门要治理的路由。
 *
 * 只看路由 id，不看 baseURL：`llm/stream` 收到的 `GenerateOptions` 里没有端点，
 * 而 DSH 自带的千帆路由 id 就是配置键（本 profile 里是 `baiduqianfan`）。
 * @param provider - 路由 id。
 * @returns 是否治理。
 */
export function isQianfanProvider(provider) {
	return typeof provider === 'string' && QIANFAN_PROVIDER.test(provider)
}

/**
 * 把一份设置文档收敛成阀门要用的字段，缺失/越界一律回默认值。
 * @param document - `balance-settings.json` 合并后的文档。
 * @returns 阀门设置。
 */
export function throttleSettings(document) {
	const source = document !== null && typeof document === 'object' ? document : {}
	const tool =
		source.tools !== null && typeof source.tools === 'object' &&
		source.tools.qianfanThrottle !== null && typeof source.tools.qianfanThrottle === 'object'
			? source.tools.qianfanThrottle
			: undefined
	// 2.0 把限流字段搬进 `tools.qianfanThrottle`；1.x 的顶层字段继续可读，
	// 这样迁移中途（或测试直接喂旧文档）不会突然退回默认值。
	const pick = (key, legacy) => (tool !== undefined && tool[key] !== undefined ? tool[key] : source[legacy])
	const number = (value, fallback, low, high) =>
		typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback
	const presetValue = pick('preset', 'throttlePreset')
	const preset =
		presetValue === 'low' || presetValue === 'mid' || presetValue === 'high' || presetValue === 'unlimited'
			? presetValue
			: 'mid'
	const manualValue = pick('manual', 'throttleManual')
	const manual = manualValue !== null && typeof manualValue === 'object' ? manualValue : undefined
	const probePaceValue = pick('probePace', 'throttleProbePace')
	return {
		enabled: pick('enabled', 'throttleEnabled') === true,
		mode: pick('mode', 'throttleMode') === 'manual' ? 'manual' : 'dynamic',
		// 缺字段（旧设置文件）时默认开启：用户要的是「平台变快时能跟上去」。
		probe: pick('probe', 'throttleProbe') !== false,
		// 试探节奏：缺字段/旧文件/未知值一律回「正常」。
		probePace: PROBE_PACE_IDS.includes(probePaceValue) ? probePaceValue : PROBE_PACE_DEFAULT,
		preset,
		manual,
		safety: number(pick('safety', 'throttleSafety'), 0.7, 0.5, 0.95),
		maxConcurrent: Math.round(number(pick('maxConcurrent', 'throttleMaxConcurrent'), 2, 1, 5)),
		cooldownCapMs: number(pick('cooldownCapMs', 'throttleCooldownCapMs'), 600_000, 60_000, 3_600_000),
		queueTimeoutMs: number(pick('queueTimeoutMs', 'throttleQueueTimeoutMs'), MAX_QUEUE_WAIT_MS, 10_000, MAX_QUEUE_WAIT_MS),
	}
}

/**
 * 排队被拒绝的原因，附中文说明，供上层 agent 与用户直接读懂。
 */
export class ThrottleError extends Error {
	/**
	 * @param code - `THROTTLE_QUEUE_FULL` / `THROTTLE_QUEUE_TIMEOUT` / `ABORTED`。
	 * @param message - 中文说明。
	 */
	constructor(code, message) {
		super(message)
		this.name = 'ThrottleError'
		this.code = code
	}
}

/**
 * 建一个限流控制器。
 *
 * @param options - `{ readSettings, stateFile, now?, sleep?, warn? }`：
 *   `readSettings` 返回合并后的设置文档；`stateFile` 是 `throttle-state.json`
 *   的绝对路径；其余三个只为测试注入。
 * @returns 控制器。
 */
export function createThrottleHost(options) {
	const readSettings = options.readSettings
	const stateFile = options.stateFile
	const now = options.now ?? (() => Date.now())
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
	const warn = options.warn ?? (() => {})

	/** 每条路由的学习状态，键是 `provider/model`。 */
	let states = new Map()
	/** 每个路由一个 FIFO 排队器；只有运行时存在，不落盘。 */
	const queues = new Map()
	/** 监听器与定时器的 disposer。 */
	const disposers = []
	/** 设置快照。 */
	let snapshot = throttleSettings({})
	let snapshotAt = 0
	/** 上一次活跃的档位，用于「档位变化 = 官方明确值」的重设。 */
	let lastPreset = snapshot.preset
	/** 上一次活跃的模式；切到手动或切回来时作废进行中的试探。 */
	let lastMode = snapshot.mode
	/** 是否有未落盘的状态变化。 */
	let dirty = false
	/** 最近一次失败分类结果，面板上直接显示。 */
	let lastFailure = null
	let tickTimer = null

	/** @param provider - 路由 id。 @param model - 模型 id。 @returns 状态键。 */
	const keyOf = (provider, model) => `${provider}/${model}`

	/**
	 * 读取设置快照（带 TTL），并在档位变化时重设学习状态。
	 * @returns 阀门设置。
	 */
	const settings = () => {
		const at = now()
		if (at - snapshotAt < SETTINGS_TTL_MS) return snapshot
		let document
		try {
			document = readSettings()
		} catch (error) {
			warn(`throttle: 读取设置失败：${error instanceof Error ? error.message : String(error)}`)
			document = {}
		}
		snapshot = throttleSettings(document)
		snapshotAt = at
		if (snapshot.mode !== lastMode) {
			// 手动档位不参与试探：切模式时作废进行中的试探，避免切回动态时
			// 用一个已经过时的 startedAt/successes 立刻确认。
			for (const [key, state] of states) {
				if (state.probe === null) continue
				states.set(key, {
					...state,
					probe: null,
					lastProbeAt: 0,
					probeBackoffMs: 0,
					probeFailures: 0,
				})
				dirty = true
			}
			lastMode = snapshot.mode
		}
		if (snapshot.preset !== lastPreset) {
			// 档位就是用户（或套餐）给出的明确上限：用它覆盖学习值并暂停增长 24 小时，
			// 等价于「响应头优先」—— 有明确值时不靠 429 反推。
			const limits = snapshot.preset === 'unlimited' ? undefined : snapshot.manual?.[snapshot.preset]
			if (limits !== undefined) {
				for (const [key, state] of states) {
					states.set(key, applyLimitSignal(state, limits, at))
				}
				dirty = true
			}
			lastPreset = snapshot.preset
		}
		return snapshot
	}

	/**
	 * 取（或建）一条路由状态。
	 * @param provider - 路由 id。
	 * @param model - 模型 id。
	 * @returns 路由状态。
	 */
	const stateFor = (provider, model) => {
		const key = keyOf(provider, model)
		const existing = states.get(key)
		if (existing !== undefined) return existing
		const settingsNow = settings()
		const created = createRouteState({
			provider,
			model,
			prior: priorFor(settingsNow.preset, settingsNow.manual),
			safety: settingsNow.safety,
			now: now(),
		})
		// 账户级冷却要覆盖「从没见过的模型」：新路由继承同 provider 的冷却与 429 计数，
		// 否则刚刚触限后换一个模型就能绕过冷却，等于没有冷却。
		for (const sibling of states.values()) {
			if (sibling.provider !== provider) continue
			created.cooldownUntil = sibling.cooldownUntil
			created.cooldownMs = sibling.cooldownMs
			created.consecutive429 = sibling.consecutive429
			created.cleanSince = sibling.cleanSince
			created.daily429 = sibling.daily429
			created.recent429 = sibling.recent429
			created.safeMode = sibling.safeMode
			created.scheduleThrottled = sibling.scheduleThrottled
			break
		}
		states.set(key, created)
		return created
	}

	/**
	 * 写回一条路由状态。
	 * @param key - 状态键。
	 * @param next - 新状态。
	 * @returns 新状态。
	 */
	const commit = (key, next) => {
		states.set(key, next)
		dirty = true
		return next
	}

	/** 把状态落盘（失败只告警，限流不能因为磁盘问题停摆）。 */
	const persist = () => {
		if (!dirty) return
		const ok = writeThrottleState(stateFile, [...states.values()], now())
		if (ok) dirty = false
	}

	/** 读回历史状态。 */
	const restore = () => {
		const settingsNow = settings()
		try {
			const loaded = loadThrottleState(stateFile, {
				preset: settingsNow.preset,
				manual: settingsNow.manual,
				safety: settingsNow.safety,
				now: now(),
			})
			states = new Map(loaded.map((state) => [keyOf(state.provider, state.model), state]))
		} catch (error) {
			warn(`throttle: 读取学习状态失败，按先验重新开始：${error instanceof Error ? error.message : String(error)}`)
			states = new Map()
		}
	}

	/**
	 * 把一次 429 广播到该 provider 的每一条路由。
	 *
	 * 平台的调度是账户级的：同一个账户下换一个模型并不会让限流消失，所以冷却必须
	 * 覆盖整个 provider，而不只是刚失败的那条路由。
	 * @param provider - 路由 id。
	 * @param at - 当前毫秒时间。
	 * @param capMs - 冷却上限。
	 */
	const penalizeProvider = (provider, at, capMs) => {
		for (const [key, state] of states) {
			if (state.provider !== provider) continue
			commit(key, applyRateLimit(pruneWindow(state, at), at, { cooldownCapMs: capMs }))
		}
	}

	/* ── 排队器 ──────────────────────────────────────────────────────────── */

	/** @param key - 状态键。 @returns 该路由的排队器（按需创建）。 */
	const queueFor = (key) => {
		let queue = queues.get(key)
		if (queue === undefined) {
			queue = { items: [], pumping: false }
			queues.set(key, queue)
		}
		return queue
	}

	/**
	 * 取一个排队条目（立刻可放行时同样走这里，只是不等待）。
	 * @param key - 状态键。
	 * @param need - 入账 token。
	 * @param signal - 取消信号（可选）。
	 * @returns 放行后的凭据，或抛 `ThrottleError`。
	 */
	const acquire = (key, need, signal) =>
		new Promise((resolve, reject) => {
			const queue = queueFor(key)
			const at = now()
			const item = {
				need,
				enqueuedAt: at,
				resolve,
				reject,
				signal,
				cancelled: false,
				onAbort: undefined,
			}
			if (queue.items.length >= MAX_QUEUE_DEPTH) {
				reject(
					new ThrottleError(
						'THROTTLE_QUEUE_FULL',
						`千帆限流队列已满（${String(MAX_QUEUE_DEPTH)} 个请求在等），本次请求未排队。请稍后重试，或把大任务拆小。`,
					),
				)
				return
			}
			if (signal !== undefined && typeof signal.addEventListener === 'function') {
				if (signal.aborted === true) {
					reject(new ThrottleError('ABORTED', '请求在排队前被取消。'))
					return
				}
				item.onAbort = () => {
					item.cancelled = true
				}
				signal.addEventListener('abort', item.onAbort, { once: true })
			}
			queue.items.push(item)
			void pump(key)
		})

	/**
	 * 串行推进一条路由的队列：队头不满足准入就等，满足就放行，直到队列空。
	 * @param key - 状态键。
	 */
	const pump = async (key) => {
		const queue = queueFor(key)
		if (queue.pumping) return
		queue.pumping = true
		try {
			while (queue.items.length > 0) {
				const head = queue.items[0]
				if (head.cancelled === true || head.signal?.aborted === true) {
					queue.items.shift()
					head.signal?.removeEventListener?.('abort', head.onAbort)
					head.reject(new ThrottleError('ABORTED', '请求在排队时被取消。'))
					continue
				}
				const settingsNow = settings()
				const at = now()
				const state = pruneWindow(stateFor(...splitKey(key)), at)
				const targets = resolveTargets(settingsNow, state, at)
				const plan = planAdmission(state, at, head.need, targets)
				if (plan.admitted === true) {
					queue.items.shift()
					head.signal?.removeEventListener?.('abort', head.onAbort)
					const applied = applyAdmission(state, at, head.need)
					let next = applied.state
					if (plan.oversize === true) next = { ...next, oversizeCount: next.oversizeCount + 1 }
					commit(key, next)
					head.resolve(applied.ticket)
					continue
				}
				const waited = at - head.enqueuedAt
				if (waited >= settingsNow.queueTimeoutMs) {
					queue.items.shift()
					head.signal?.removeEventListener?.('abort', head.onAbort)
					commit(key, { ...state, timeoutCount: state.timeoutCount + 1, updatedAt: at })
					head.reject(
						new ThrottleError(
							'THROTTLE_QUEUE_TIMEOUT',
							`已排队 ${String(Math.round(waited / 1000))} 秒仍未放行（${reasonLabel(plan.reason)}），建议把大任务拆小后重试。`,
						),
					)
					continue
				}
				const wait = Math.min(plan.waitMs > 0 ? plan.waitMs : POLL_MS, POLL_MS, settingsNow.queueTimeoutMs - waited)
				await sleep(Math.max(20, wait))
			}
		} finally {
			queue.pumping = false
			if (queue.items.length > 0) void pump(key)
		}
	}

	/* ── 闸门 ────────────────────────────────────────────────────────────── */

	/**
	 * 准入一次模型请求。
	 * @param input - `{ provider, model, request, signal }`。
	 * @returns 凭据，或 `null`（不需要治理）。
	 */
	const admit = async (input) => {
		const settingsNow = settings()
		if (settingsNow.enabled !== true) return null
		if (!isQianfanProvider(input.provider)) return null
		const key = keyOf(input.provider, input.model)
		const state = stateFor(input.provider, input.model)
		// 先记「请求来过」：这是「发挥速率」分母。排队/拒绝的请求也是真实需求，
		// 不能被“只记放行”抹掉，否则限流越紧、面板反而越像 100%。
		const at = now()
		const pruned = pruneWindow(state, at)
		commit(key, {
			...pruned,
			arrivals: [...(Array.isArray(pruned.arrivals) ? pruned.arrivals : []), at],
		})
		const need = needTokens(input.request, pruned)
		const ticket = await acquire(key, need, input.signal)
		return { ...ticket, key, provider: input.provider }
	}

	/**
	 * 结清一次请求：记录真实用量、分类失败、唤醒队列。
	 * @param ticket - `admit` 发出的凭据。
	 * @param outcome - `{ usage, failure, ok }`。
	 */
	const release = (ticket, outcome) => {
		const at = now()
		const key = ticket.key
		const settingsNow = settings()
		let next = pruneWindow(stateFor(...splitKey(key)), at)
		if (outcome.failure !== undefined) {
			const classified = classifyFailure(outcome.failure)
			lastFailure = { ...classified, guidance: failureGuidance(classified.kind), at }
			if (classified.kind === 'rate-limit') {
				penalizeProvider(ticket.provider, at, settingsNow.cooldownCapMs)
				// 惩罚已按 provider 广播，这里重读一次以保留本路由的最终状态。
				next = states.get(key) ?? next
			}
		}
		next = applyCompletion(next, ticket, {
			usage: outcome.usage,
			ok: outcome.ok === true,
			now: at,
		})
		if (next.inFlight === 0 && settingsNow.enabled === true) {
			next = applyGrowth(next, at, {
				mode: settingsNow.mode,
				probe: settingsNow.probe,
				probePace: settingsNow.probePace,
			})
		}
		commit(key, next)
		// 释放了一个并发名额：立刻让队头重新评估，而不是等轮询。
		if (queues.has(key)) void pump(key)
	}

	/** 定时维护：每日衰减、恢复增长、落盘。 */
	const tick = () => {
		const at = now()
		const settingsNow = settings()
		if (settingsNow.enabled === true) {
			for (const [key, state] of states) {
				const pruned = pruneWindow(state, at)
				let next = applyDailyUpkeep(pruned, at)
				next = applyGrowth(next, at, {
					mode: settingsNow.mode,
					probe: settingsNow.probe,
					probePace: settingsNow.probePace,
				})
				if (next !== pruned) {
					states.set(key, next)
					dirty = true
				} else if (pruned !== state) {
					// 窗口滑出只是瞬时事实，不落盘：否则空闲时也会每 5 秒写一次文件。
					states.set(key, pruned)
				}
			}
		}
		persist()
	}

	/**
	 * 面板用的状态快照。
	 * @param extra - 由宿主补上的字段（例如 `retryHint`）。
	 * @returns 只读状态。
	 */
	const status = (extra = {}) => {
		const at = now()
		const settingsNow = settings()
		const routes = [...states.values()]
			.map((state) => statusOf(pruneWindow(state, at), settingsNow, at))
			.sort((left, right) => right.updatedAt - left.updatedAt)
		const active = routes[0] ?? null
		let queued = 0
		for (const queue of queues.values()) queued += queue.items.length
		return {
			enabled: settingsNow.enabled,
			mode: settingsNow.mode,
			probeEnabled: settingsNow.probe,
			probePace: settingsNow.probePace,
			preset: settingsNow.preset,
			safety: settingsNow.safety,
			maxConcurrent: settingsNow.maxConcurrent,
			cooldownCapMs: settingsNow.cooldownCapMs,
			queueTimeoutMs: settingsNow.queueTimeoutMs,
			queueDepth: MAX_QUEUE_DEPTH,
			queued,
			windowMs: WINDOW_MS,
			badge: settingsNow.enabled !== true ? 'off' : (active?.badge ?? 'normal'),
			active,
			routes,
			lastFailure,
			...extra,
		}
	}

	/**
	 * 重置全部学习状态（用户唯一能清掉一次误判的入口）。
	 * @param extra - 由宿主补上的字段（例如 `retryHint`）。
	 * @returns 重置后的状态快照。
	 */
	const reset = (extra = {}) => {
		const at = now()
		const settingsNow = settings()
		for (const [key, state] of states) {
			states.set(key, resetLearning({ ...state, safety: settingsNow.safety }, at))
		}
		lastFailure = null
		dirty = true
		persist()
		return status(extra)
	}

	/* ── 接线 ────────────────────────────────────────────────────────────── */

	/**
	 * 把一次请求包成「先排队、再放行、全程透传」的 async iterable。
	 *
	 * 只读 `GenerateOptions`：不复制、不改写、不冻结，任何 chunk 原样 `yield` ——
	 * 唯一的例外是 {@link normalizeFinishFailure}：把被渠道/适配器误标成「额度」的
	 * 限流错误改成 `RATE_LIMIT`，好让 DSH 自己的重试策略发挥它本来该有的作用。
	 * @param request - `GenerateOptions`。
	 * @param next - waterfall 的续接回调。
	 * @returns async iterable。
	 */
	const gate = (request, next) => {
		const provider = request.provider
		const model = request.model
		const signal = request.signal
		return (async function* gated() {
			let ticket
			try {
				ticket = await admit({ provider, model, request, signal })
			} catch (error) {
				if (error instanceof ThrottleError) {
					if (error.code === 'ABORTED') {
						yield {
							type: 'finish',
							reason: { kind: 'aborted', failure: { code: 'ABORTED', message: error.message } },
						}
						return
					}
					// 队列拒绝/超时：给出明确错误，让上层 agent 自己决定，不静默丢弃。
					yield {
						type: 'finish',
						reason: { kind: 'error', failure: { code: error.code, message: error.message } },
					}
					return
				}
				throw error
			}
			if (ticket === null) {
				yield* asAsyncIterable(next(request))
				return
			}
			if (signal?.aborted === true) {
				release(ticket, { usage: undefined, failure: undefined, ok: false })
				yield {
					type: 'finish',
					reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '请求在放行后被取消。' } },
				}
				return
			}
			const iterator = asAsyncIterable(next(request))[Symbol.asyncIterator]()
			let usage
			let failure
			let ok = false
			try {
				while (true) {
					const step = await iterator.next()
					if (step.done === true) break
					let chunk = step.value
					if (chunk !== null && typeof chunk === 'object') {
						if (chunk.type === 'usage') usage = chunk.usage
						if (chunk.type === 'finish') {
							const reason = chunk.reason
							if (reason?.kind === 'error') {
								const normalized = normalizeFinishFailure(reason.failure)
								failure = normalized.failure
								if (normalized.failure !== reason.failure) {
									chunk = { ...chunk, reason: { ...reason, failure: normalized.failure } }
								}
							}
							ok = reason?.kind === 'stop' || reason?.kind === 'tool-calls' || reason?.kind === 'max-tokens'
						}
					}
					yield chunk
				}
			} finally {
				try {
					await iterator.return?.()
				} catch {
					// 迭代器关闭失败不改变已经发生的用量与失败事实。
				}
				release(ticket, { usage, failure, ok })
			}
		})()
	}

	/**
	 * 注册 `llm/stream` 闸门与维护定时器。
	 * @param ctx - 插件上下文（任何能注册监听器的 fiber 都可以）。
	 */
	const attach = (ctx) => {
		restore()
		const listener = (request, next) => {
			if (settings().enabled !== true) return next(request)
			if (!isQianfanProvider(request?.provider)) return next(request)
			return gate(request, next)
		}
		if (typeof ctx.on === 'function') {
			disposers.push(ctx.on('llm/stream', listener))
		} else {
			// A context without an event bus (a stub host, or a future dsh that moved
			// the listener API) still gets the status/reset routes: the valve's
			// controls must not disappear just because its gate could not attach.
			warn('throttle: 当前上下文不能注册 llm/stream 监听器，阀门只提供状态与重置接口。')
		}
		const timer = setInterval(() => {
			try {
				tick()
			} catch (error) {
				warn(`throttle: 定时维护失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}, TICK_MS)
		if (typeof timer.unref === 'function') timer.unref()
		tickTimer = timer
		disposers.push(() => clearInterval(timer))
	}

	/** 释放监听器与定时器。 */
	const dispose = () => {
		persist()
		if (tickTimer !== null) clearInterval(tickTimer)
		tickTimer = null
		for (const disposeOne of disposers.splice(0)) {
			try {
				disposeOne()
			} catch {
				// 一个已经失效的 disposer 不值得让卸载失败。
			}
		}
	}

	return { attach, admit, release, status, reset, dispose, tick, isQianfanProvider }
}

/**
 * 把任意「async iterable 或 Promise<async iterable>」收敛成 async iterable。
 *
 * waterfall 的 `next()` 通常同步返回，但也可能是 Promise（另一层中间件包成了
 * async 函数），两种都要能消费。
 * @param value - 待消费的值。
 * @returns async iterable。
 */
function asAsyncIterable(value) {
	if (value !== null && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function') return value
	return (async function* unwrap() {
		const resolved = await value
		if (resolved !== null && typeof resolved === 'object' && typeof resolved[Symbol.asyncIterator] === 'function') {
			yield* resolved
			return
		}
		if (resolved !== null && typeof resolved === 'object' && typeof resolved[Symbol.iterator] === 'function') {
			yield* resolved
		}
	})()
}

/** @param key - `provider/model`。 @returns `[provider, model]`。 */
function splitKey(key) {
	const at = key.indexOf('/')
	if (at === -1) return [key, '']
	return [key.slice(0, at), key.slice(at + 1)]
}

/**
 * 把「其实是限流、却被标成额度」的失败改成 DSH 认识的可重试码。
 *
 * 百度千帆 Token Plan 真实返回的是 HTTP 429：
 * `{"code":"token_plan_person_rate_limit_exceeded","type":"quota_exceeded"}`。
 * 适配器按 `type`/正文归类时会给出 `QUOTA`，而 `QUOTA` 不在 `dsh-llm-retry` 的默认
 * `retryableCodes` 里 —— 于是一次普通的限流直接终结整轮对话，这既不符合平台的语义
 * （限流就是"稍后再试"），也不符合用户的预期。
 *
 * 因此这里只做一件事：**经由本阀门治理的千帆路由**上，把被判定为限流的失败码改写为
 * `RATE_LIMIT`（缺 `status` 时补 429），让 DSH 自己的重试策略带着退避去重试；
 * `message` / `status` / `providerRetryAfterMs` 一律原样保留。真正的额度耗尽
 * （`insufficient quota` 之类）不在此列，仍然不可重试 —— 那条路重试也没有意义。
 * @param failure - stream 终止 chunk 里的 `LlmFailure`。
 * @returns `{ failure }`：要么原对象，要么一个改了码的副本。
 */
function normalizeFinishFailure(failure) {
	if (failure === null || typeof failure !== 'object') return { failure }
	if (failure.code === 'RATE_LIMIT') return { failure }
	if (classifyFailure(failure).kind !== 'rate-limit') return { failure }
	return {
		failure: {
			...failure,
			code: 'RATE_LIMIT',
			...(Number.isInteger(failure.status) ? {} : { status: 429 }),
		},
	}
}

/** @param reason - 准入等待的原因。 @returns 中文短语。 */
function reasonLabel(reason) {
	if (reason === 'rpm') return '每分钟请求数已满'
	if (reason === 'tpm') return '每分钟 token 已满'
	if (reason === 'concurrency') return '并发已满'
	if (reason === 'cooldown') return '平台 429 冷却中'
	return '上游闸门未放行'
}