/**
 * 百度千帆请求限流阀门 — 纯算法。
 *
 * 这里没有 `ctx`、没有计时器、没有网络：每个函数都接收显式的 `now`（毫秒）
 * 和状态，返回新状态或一次准入决策。因此整个控制器可以在 Node 里直接单测，
 * 也不需要 DSH 进程。
 *
 * 状态机 = 60 秒滑动窗口（RPM/TPM 双闸门）+ 并发信号量 + AIMD 学习器。
 *
 * ## 绝不做的四件事（改动前请先读）
 *
 * 这个阀门只改变「请求什么时候发出」，不改变「请求说什么」：
 *
 * 1. 不改 `messages`，不截断、不摘要上下文 —— 那是上下文管理/质量问题，不是
 *    限流问题；在这里动一个字都会让模型看到和历史不一致的对话。
 * 2. 不换小模型，不在 429 之后降级 —— 用户选了哪个模型，就必须由那个模型回答。
 * 3. 不改 `temperature` / `max_tokens` 等生成参数 —— 那会直接改变回答质量。
 * 4. 不在流中途重试，不丢弃并行 `tool_calls` —— 重试由 dsh-llm-retry 在 agent
 *    失败步边界负责，本阀门只在上游排队。
 *
 * 准入失败只做两件事：等待（排队）或抛出带中文说明的明确错误。
 *
 * @module dsh-balance-card/throttle
 */

/** 滑动窗口长度：RPM 与 TPM 都以 60 秒计。 */
export const WINDOW_MS = 60_000
/** 队列深度上限：超过即立刻拒绝，不无限堆进程内等待者。 */
export const MAX_QUEUE_DEPTH = 32
/** 单次排队的最长等待；超时返回明确错误而不是静默丢弃。 */
export const MAX_QUEUE_WAIT_MS = 180_000
/** 每次等待附加的随机抖动上限，避免多个排队者在同一毫秒一起冲出。 */
export const JITTER_MS = 200
/** 冷却基数；按 `base * 2^(n-1)` 指数增长。 */
export const COOLDOWN_BASE_MS = 15_000
/** 冷却上限，同时也是设置项 `throttleCooldownCapMs` 的默认值。 */
export const COOLDOWN_CAP_MS = 600_000
/**
 * 同一次"风暴"的时间窗口。
 *
 * DSH 的 `dsh-llm-retry` 会把一次 429 重试若干次，每次重试都会再次撞上 429。
 * 如果把这些重试当成"连续触限"，一次抖动就会把 `learned` 连打三折并直接把账号送进
 * 日安全模式。所以冷却结束后的 {@link STORM_GAP_MS} 内再次触限算**同一次风暴**：
 * 只加长冷却（15→30→60…），不再折半、也不进安全模式计数。
 */
export const STORM_GAP_MS = 20_000
/** 连续 429（按"风暴"计，而不是按重试次数计）达到该次数进入「日安全模式」。 */
export const SAFE_MODE_CONSECUTIVE_429 = 3
/** 单日 429 风暴达到该次数进入「日安全模式」。 */
export const SAFE_MODE_DAILY_429 = 5
/** 两次「学习上限」增长之间的最短间隔（+10%/5 分钟）。 */
export const GROWTH_GAP_MS = 300_000
/** 增长前要求的连续无 429 时长。 */
export const GROWTH_CLEAN_MS = 600_000
/** 冷却结束后、允许重新评估之前必须静默的时长。 */
export const COOLDOWN_QUIET_MS = 60_000
/** 冷却后的第一级恢复系数：先回到 `learned * 0.6`。 */
export const RECOVERY_FACTOR = 0.6
/** 第一级恢复要保持多久（期间无 429 才回到 `learned * safety`）。 */
export const RECOVERY_HOLD_MS = 120_000
/**
 * 向上试探：平台限流是动态的，只在「已经回到历史安全值、并且连续一段时间没有
 * 429」时才偶尔把速率提高一小步，用一次真实请求去问平台「还能不能更快」。
 *
 * 试探与普通增长的区别：
 * - 试探期间 `learned` 不动，只临时把目标提高 `PROBE_STEP_SHARE`；确认成功后
 *   `learned/ceiling` 才一起上移。
 * - 试探失败只回退到上一次确认过的安全值，**不折半** —— 否则每探一次边界，
 *   用户的正常速度就会掉一半，反而更慢。真正的基线 429 才走惩罚路径。
 * - 失败后按指数退避（10/20/40/60 分钟）再试，避免在同一根边界上反复撞 429。
 * - 每次试探只 +10%；试探之间的时间由 {@link PROBE_PACE} 的四档决定。这个步长
 *   决定最终能跑到的位置：一次试探失败时，平台真实上限落在「上次目标」和
 *   「本次目标」之间，所以稳态至少能保住约 91% 的满速，而不是固定停在安全系数上。
 */
export const PROBE_STEP_SHARE = 0.1
export const PROBE_STEP_RPM = 0.2
export const PROBE_STEP_TPM = 200
/**
 * 向上试探的节奏档位。
 *
 * 试探是唯一会主动去碰平台边界的动作，也是最可能被风控/限流放大的动作。
 * 因此它不能按「5 分钟」这种开发期节奏跑，而要让用户按风险偏好选择：
 *
 * - `frequent`（频繁）：30 分钟无 429 就允许下一次试探；两次至少间隔 30 分钟。
 * - `normal`（正常，默认）：2 小时无 429 才允许；两次至少间隔 2 小时。
 * - `conservative`（保守）：6 小时无 429 才允许；两次至少间隔 6 小时。
 * - `rare`（几乎不）：24 小时无 429 才允许；两次至少间隔 24 小时。
 *
 * 这里的「无 429」指的是 `cleanSince` 连续计时；任何一次基线 429 都会把它清零。
 * 试探失败后的指数退避（10/20/40/60 分钟）仍叠加在所选间隔之上。
 */
export const PROBE_PACE_IDS = Object.freeze(['frequent', 'normal', 'conservative', 'rare'])
export const PROBE_PACE_DEFAULT = 'normal'
export const PROBE_PACE = Object.freeze({
	frequent: Object.freeze({ cleanMs: 30 * 60_000, gapMs: 30 * 60_000 }),
	normal: Object.freeze({ cleanMs: 2 * 60 * 60_000, gapMs: 2 * 60 * 60_000 }),
	conservative: Object.freeze({ cleanMs: 6 * 60 * 60_000, gapMs: 6 * 60 * 60_000 }),
	rare: Object.freeze({ cleanMs: 24 * 60 * 60_000, gapMs: 24 * 60 * 60_000 }),
})
/**
 * 把设置里的节奏名收敛成窗口；未知值一律回默认档。
 * @param value - 设置里的 `throttleProbePace`。
 * @returns `{ cleanMs, gapMs }`。
 */
export function probePaceOf(value) {
	return Object.hasOwn(PROBE_PACE, value) ? PROBE_PACE[value] : PROBE_PACE[PROBE_PACE_DEFAULT]
}
/**
 * 旧的常量保留为「正常」档的别名：外部代码若仍引用它们，行为与默认档一致。
 * @deprecated 使用 {@link PROBE_PACE} / {@link probePaceOf}。
 */
export const PROBE_GAP_MS = PROBE_PACE[PROBE_PACE_DEFAULT].gapMs
/** @deprecated 使用 {@link PROBE_PACE} / {@link probePaceOf}。 */
export const PROBE_CLEAN_MS = PROBE_PACE[PROBE_PACE_DEFAULT].cleanMs
/** 试探至少稳定这么久、且收到至少一次成功，才算确认。 */
export const PROBE_CONFIRM_MS = 180_000
export const PROBE_CONFIRM_REQUESTS = 1
/** 试探前要求最近有过流量，避免「十分钟前只成功过一次」就开探。 */
export const PROBE_IDLE_MS = 120_000
/** 试探失败的退避基数与上限。 */
export const PROBE_BACKOFF_BASE_MS = 600_000
export const PROBE_BACKOFF_MAX_MS = 3_600_000
/** 试探的绝对上限，防止平台长时间不返回 429 时无限增长。 */
export const PROBE_MAX_RPM = 120
export const PROBE_MAX_TPM = 1_000_000
/** TPM 目标的下限：再小就没有一次请求能进得去。 */
export const TPM_FLOOR = 2_000
/** RPM 目标的下限。 */
export const RPM_FLOOR = 1
/** 未知平台上限时的起始先验：3 RPM / 20,000 TPM。 */
export const PRIOR_UNKNOWN = Object.freeze({ rpm: 3, tpm: 20_000 })
/** 估算校准系数的夹紧区间（EWMA，初值 1.0）。 */
export const EST_RATIO_MIN = 0.5
export const EST_RATIO_MAX = 2.0
/** 单请求超过「目标 TPM 的一半」时视为超大请求，直接放行（否则永远排不进）。 */
export const OVERSIZE_SHARE = 0.5
/**
 * 学习上限每次增长的比例与下限。
 *
 * 冷却后从 50% 回到 100% 需要约 7 步 × 5 分钟 ≈ 35 分钟；旧的 5% 要一个多小时，
 * 对「尽量满速」来说太慢。上限仍由 ceiling 夹住，且增长前要求 10 分钟无 429。
 */
export const GROWTH_SHARE = 0.1
export const GROWTH_RPM_STEP = 0.2
export const GROWTH_TPM_STEP = 200
/** 命中 429 时的惩罚系数。 */
export const PENALTY_FACTOR = 0.5
/** 学习下限：RPM 不低于 1，TPM 不低于 4,000（见 §4.4 的 `max(4000, …)`）。 */
export const LEARNED_TPM_FLOOR = 4_000
/** 每台机器最多持久化的路由条数。 */
export const MAX_ROUTES = 16
/** 「平台调度型」识别门槛：learned.rpm 已经到 2 还 429。 */
export const SCHEDULE_THROTTLE_RPM = 2
/** 档位表：用户可以展开「高级」改数字，但四档本身是预置。 */
export const PRESETS = Object.freeze({
	low: Object.freeze({ rpm: 2, tpm: 8_000, concurrency: 1 }),
	mid: Object.freeze({ rpm: 6, tpm: 30_000, concurrency: 2 }),
	high: Object.freeze({ rpm: 15, tpm: 80_000, concurrency: 3 }),
})
/** 四个档位 id；`unlimited` 是直通档。 */
export const PRESET_IDS = Object.freeze(['low', 'mid', 'high', 'unlimited'])
/** 档位数字的可编辑范围，主机校验与界面控件共用。 */
export const PRESET_BOUNDS = Object.freeze({
	rpm: [1, 600],
	tpm: [1_000, 10_000_000],
	concurrency: [1, 8],
})

/** 主机与浏览器半边共用的档位默认表（「高级」编辑后的值存在设置里）。 */
export function defaultManualPresets() {
	return {
		low: { ...PRESETS.low },
		mid: { ...PRESETS.mid },
		high: { ...PRESETS.high },
	}
}

/** @param value - 任意值。 @returns 有限正数，否则 undefined。 */
function finite(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** @param value - 任意值。 @returns 有限非负数，否则 undefined（用量里的 0 是合法值）。 */
function nonNegative(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** @param value - 任意值。 @returns 夹紧到 [0,1] 的数，否则 undefined。 */
function clampRatio(value) {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined
}

/**
 * 把未知路由的上限先验算成 `{rpm, tpm}`。
 *
 * 用户手里有套餐档位时按档位给；`unlimited` 档位不是额度声明，因此退回未知先验。
 * @param preset - 已存的档位 id。
 * @param manual - 设置里的档位数字表。
 * @returns 起始先验。
 */
export function priorFor(preset, manual) {
	if (preset === 'low' || preset === 'mid' || preset === 'high') {
		const entry = manual?.[preset] ?? PRESETS[preset]
		return { rpm: Math.max(RPM_FLOOR, entry.rpm), tpm: Math.max(TPM_FLOOR, entry.tpm) }
	}
	return { ...PRIOR_UNKNOWN }
}

/**
 * 建一条路由状态。`learned` 从先验出发，`ceiling` 记住历史上界。
 * @param options - provider / model / prior / 已有状态（从磁盘读回时覆盖）。
 * @returns 新的路由状态。
 */
export function createRouteState(options) {
	const prior = {
		rpm: Math.max(RPM_FLOOR, finite(options.prior?.rpm) ?? PRIOR_UNKNOWN.rpm),
		tpm: Math.max(TPM_FLOOR, finite(options.prior?.tpm) ?? PRIOR_UNKNOWN.tpm),
	}
	const learned = {
		rpm: Math.max(RPM_FLOOR, finite(options.learned?.rpm) ?? prior.rpm),
		tpm: Math.max(LEARNED_TPM_FLOOR, finite(options.learned?.tpm) ?? prior.tpm),
	}
	const ceiling = {
		rpm: Math.max(learned.rpm, finite(options.ceiling?.rpm) ?? learned.rpm),
		tpm: Math.max(learned.tpm, finite(options.ceiling?.tpm) ?? learned.tpm),
	}
	return {
		provider: options.provider,
		model: options.model,
		prior,
		learned,
		ceiling,
		safety: clampRatio(options.safety) ?? 0.7,
		/** 60 秒窗口内的放行记录；`seq` 用于回填真实用量。 */
		window: [],
		/** 60 秒内进入闸门的请求时间戳，用于计算「发挥了请求量的百分之多少」。 */
		arrivals: [],
		/** 下一个窗口记录的序号，单调递增。 */
		seq: 0,
		/** 在飞请求数（运行时事实，不持久化等价值，读回时归零）。 */
		inFlight: 0,
		cooldownUntil: 0,
		/** 上一次触限计算出的冷却时长，用于面板显示与恢复闸门。 */
		cooldownMs: 0,
		/**
		 * 正在进行的向上试探：`{ rpm, tpm, startedAt, successes }`；`rpm/tpm`
		 * 是「学习基数」上的试探值，最终目标仍会乘安全系数。没有试探时为 null。
		 */
		probe: null,
		/** 上次试探开始的时间；0 表示从未试探。 */
		lastProbeAt: 0,
		/** 上次试探确认成功的时间。 */
		probeConfirmedAt: 0,
		/** 试探失败后的退避，指数增长；确认成功后清零。 */
		probeBackoffMs: 0,
		/** 连续试探失败次数（确认成功后清零）。 */
		probeFailures: 0,
		consecutive429: 0,
		/** 当前风暴里撞了几次 429；DSH 对同一次请求的重试靠它只加长冷却。 */
		stormHits: 0,
		/** 连续无 429 的起始时间；0 表示还没出现过一次成功。 */
		cleanSince: 0,
		lastGrowAt: 0,
		daily429: { day: '', count: 0 },
		/** 最近一小时的触限时间戳，仅保留 60 分钟内的。 */
		recent429: [],
		safeMode: false,
		scheduleThrottled: false,
		/** 估算校准系数（EWMA，初值 1.0），夹在 0.5–2.0。 */
		estRatio: 1,
		/** 最近 20 次输出的 token 数，用于未知 `max_tokens` 时的预留估计。 */
		outputSamples: [],
		/** 因超大请求被放行的次数、排队超时次数，面板各记一笔。 */
		oversizeCount: 0,
		timeoutCount: 0,
		/** 上一次被上游接受的时间，用于面板排序与持久化裁剪。 */
		updatedAt: finite(options.now) ?? 0,
	}
}

/** @param now - 当前毫秒时间。 @returns `YYYY-MM-DD`（本地时区）。 */
export function dayOf(now) {
	const at = new Date(now)
	const month = String(at.getMonth() + 1).padStart(2, '0')
	const day = String(at.getDate()).padStart(2, '0')
	return `${String(at.getFullYear())}-${month}-${day}`
}

/**
 * 丢掉滑出窗口的记录。
 * @param state - 路由状态。
 * @param now - 当前毫秒时间。
 * @returns 新的状态（窗口没变化时返回原状态）。
 */
export function pruneWindow(state, now) {
	const cutoff = now - WINDOW_MS
	const window = state.window.filter((entry) => entry.at > cutoff)
	const arrivals = Array.isArray(state.arrivals) ? state.arrivals.filter((at) => at > cutoff) : []
	const recent429 = state.recent429.filter((at) => at > now - 3_600_000)
	if (
		window.length === state.window.length &&
		arrivals.length === (Array.isArray(state.arrivals) ? state.arrivals.length : 0) &&
		recent429.length === state.recent429.length
	) {
		return state
	}
	return { ...state, window, arrivals, recent429 }
}

/**
 * 窗口内的已用速率。
 * @param state - 路由状态（应当先 `pruneWindow`）。
 * @returns `{ requests, tokens }`。
 */
export function windowUsage(state) {
	let tokens = 0
	for (const entry of state.window) tokens += entry.tokens
	return { requests: state.window.length, tokens }
}

/**
 * 当前生效的速率系数。
 *
 * 冷却刚结束时先停在 `RECOVERY_FACTOR`（0.6），`RECOVERY_HOLD_MS` 内没有再次
 * 触限才回到用户设定的安全系数 —— 避免冷却一结束就立刻二次触限。第一级恢复的
 * 截止时间由 `cooldownUntil` 派生，不额外存字段：任何一次新的 429 都会重写
 * `cooldownUntil`，恢复阶梯因此自动重新计时。
 * @param state - 路由状态。
 * @param now - 当前毫秒时间。
 * @returns 生效系数。
 */
export function effectiveFactor(state, now) {
	if (state.cooldownUntil > 0 && now < state.cooldownUntil + RECOVERY_HOLD_MS) {
		return Math.min(RECOVERY_FACTOR, state.safety)
	}
	return state.safety
}

/**
 * 把「设置 + 学习状态」解析成这一次要守的实际闸门。
 *
 * `unlimited` 档位只守冷却：不排队、不降速，但账户级冷却期内仍然暂停。
 * @param settings - 阀门设置（`throttleMode` / `throttleSafety` 等）。
 * @param state - 该路由的学习状态。
 * @param now - 当前毫秒时间。
 * @returns `{ unlimited, rpm, tpm, concurrency, factor }`，`unlimited` 时数值为 0。
 */
export function resolveTargets(settings, state, now) {
	if (settings.mode === 'manual' && settings.preset === 'unlimited') {
		return { unlimited: true, rpm: 0, tpm: 0, concurrency: Number.POSITIVE_INFINITY, factor: 0 }
	}
	if (settings.mode === 'manual') {
		const preset = PRESETS[settings.preset] ?? PRESETS.mid
		const tuned = settings.manual?.[settings.preset] ?? preset
		return {
			unlimited: false,
			rpm: Math.max(RPM_FLOOR, tuned.rpm),
			tpm: Math.max(TPM_FLOOR, tuned.tpm),
			concurrency: Math.max(1, tuned.concurrency),
			factor: 1,
		}
	}
	const factor = effectiveFactor(state, now)
	// 试探期间只临时抬高「基数」，最终仍乘安全系数；确认成功后 learned 才跟上。
	const basis = state.probe ?? state.learned
	return {
		unlimited: false,
		rpm: Math.max(RPM_FLOOR, Math.floor(basis.rpm * factor)),
		tpm: Math.max(TPM_FLOOR, Math.floor(basis.tpm * factor)),
		concurrency: Math.max(1, settings.maxConcurrent),
		factor,
	}
}

/**
 * 计算「现在能不能放行」以及「不能的话还要等多久」。
 *
 * 这是函数式版本：不改状态，只回答一次决策。判断顺序是冷却 → 并发 → RPM →
 * TPM，其中 RPM/TPM 用同一个滑动窗口。
 *
 * 超大请求（`need > tpm * 0.5`）只绕过 TPM 一项：它仍然要排队等冷却、并发和
 * RPM。完全绕过三闸门会让「上下文本来就大」的正常 Agent 流量彻底不受治理，
 * 而 RPM/并发总会自然腾出名额，绕开它们并不会造成死等。
 * @param state - 已 prune 的路由状态。
 * @param now - 当前毫秒时间。
 * @param need - 本次请求要入账的 token 数。
 * @param targets - `resolveTargets` 的结果。
 * @returns `{ admitted, waitMs, reason, oversize }`；`waitMs` 为 0 且 `reason`
 *   为 `concurrency` 时表示「等一个在飞请求结束」，由调用方在释放时重算。
 */
export function planAdmission(state, now, need, targets) {
	if (state.cooldownUntil > now) {
		return { admitted: false, waitMs: state.cooldownUntil - now, reason: 'cooldown', oversize: false }
	}
	if (targets.unlimited) return { admitted: true, waitMs: 0, reason: null, oversize: false }
	// 目标 TPM 的一半都放不下时，TPM 闸门永远无法满足，只对这一项放行并计数。
	const oversize = need > targets.tpm * OVERSIZE_SHARE
	if (state.inFlight >= targets.concurrency) {
		return { admitted: false, waitMs: 0, reason: 'concurrency', oversize }
	}
	const usage = windowUsage(state)
	let waitMs = 0
	let reason = null
	// RPM 闸门：要让窗口内请求数降到 rpm-1，需要等到第 (超出) 条记录滑出。
	if (usage.requests >= targets.rpm) {
		const excess = usage.requests - targets.rpm + 1
		const entry = state.window[excess - 1]
		waitMs = Math.max(waitMs, entry === undefined ? 0 : entry.at + WINDOW_MS - now)
		reason = 'rpm'
	}
	// TPM 闸门：让窗口内 token 降到能容下这一次为止，按最老的记录顺序滑出。
	if (!oversize && usage.tokens + need > targets.tpm) {
		const needed = usage.tokens + need - targets.tpm
		let freed = 0
		let waited = 0
		for (const entry of state.window) {
			freed += entry.tokens
			waited = entry.at + WINDOW_MS - now
			if (freed >= needed) break
		}
		// 整个窗口都滑出才够时，`waited` 就是最后一条的过期时间（≤60 秒）。
		waitMs = Math.max(waitMs, waited)
		reason = 'tpm'
	}
	if (reason === null) return { admitted: true, waitMs: 0, reason: null, oversize }
	return { admitted: false, waitMs: Math.max(1, waitMs), reason, oversize }
}

/**
 * 记一条放行：入窗口、在飞 +1。
 * @param state - 已 prune 的路由状态。
 * @param now - 当前毫秒时间。
 * @param need - 本次入账的 token 估算（之后可用真实用量修正）。
 * @returns `{ state, ticket }`。
 */
export function applyAdmission(state, now, need) {
	const seq = state.seq + 1
	const entry = { at: now, tokens: Math.max(0, Math.round(need)), seq }
	return {
		state: {
			...state,
			seq,
			window: [...state.window, entry],
			inFlight: state.inFlight + 1,
			updatedAt: now,
		},
		ticket: { seq, at: now, estTokens: entry.tokens, provider: state.provider },
	}
}

/**
 * 完成一次放行：在飞 -1，并用真实用量修正窗口里那一条（不重复计费）。
 * @param state - 路由状态。
 * @param ticket - `applyAdmission` 发出的凭据。
 * @param outcome - `{ usage, ok, now }`：真实 `TokenUsage`、是否成功、完成时间。
 * @returns 新的状态。
 */
export function applyCompletion(state, ticket, outcome) {
	const now = outcome.now
	const actual = usageTokens(outcome.usage)
	const next = { ...state, inFlight: Math.max(0, state.inFlight - 1), updatedAt: now }
	// 真实用量回填：只有估算的那一条还在窗口里才修正；已经滑出的记录不补记。
	if (actual !== null) {
		let corrected = false
		const window = next.window.map((entry) => {
			if (entry.seq !== ticket.seq) return entry
			corrected = true
			return { ...entry, tokens: actual }
		})
		if (corrected) next.window = window
		next.estRatio = calibrate(next.estRatio, ticket.estTokens, actual)
		const output = outputTokens(outcome.usage)
		if (output !== null) {
			next.outputSamples = [...next.outputSamples, output].slice(-20)
		}
	}
	if (outcome.ok === true && next.probe !== null) {
		// 试探期间的每次成功都是「这次试探能跑」的证据；确认交给 applyGrowth，
		// 那里还要求试探持续到 PROBE_CONFIRM_MS。
		next.probe = { ...next.probe, successes: next.probe.successes + 1 }
	}
	if (outcome.ok === true) {
		// 一次成功就结束这次风暴：下一次 429 重新开始计数（冷却从 15 秒再来），
		// 恢复闸门也在这里重新计时。
		next.stormHits = 0
		if (next.consecutive429 > 0) {
			next.consecutive429 = 0
			next.cleanSince = now
		} else if (next.cleanSince === 0) {
			next.cleanSince = now
		}
	}
	return next
}

/**
 * 一次校准：`estRatio = estRatio*0.8 + (actual/est)*0.2`，夹在 0.5–2.0。
 * @param ratio - 当前系数。
 * @param estimated - 当次估算值。
 * @param actual - 当次真实总量。
 * @returns 新的系数。
 */
export function calibrate(ratio, estimated, actual) {
	if (!(estimated > 0) || !(actual > 0)) return ratio
	const observed = actual / estimated
	const next = ratio * 0.8 + observed * 0.2
	return Math.min(EST_RATIO_MAX, Math.max(EST_RATIO_MIN, next))
}

/** @param usage - `TokenUsage`。 @returns 计费总量（含缓存与输出），或 null。 */
export function usageTokens(usage) {
	if (usage === null || typeof usage !== 'object') return null
	const input = nonNegative(usage.inputTokens)
	const output = nonNegative(usage.outputTokens)
	if (input === undefined && output === undefined) return null
	return (
		(input ?? 0) +
		(nonNegative(usage.cacheReadTokens) ?? 0) +
		(nonNegative(usage.cacheWriteTokens) ?? 0) +
		(output ?? 0)
	)
}

/** @param usage - `TokenUsage`。 @returns 输出 token 数，或 null。 */
export function outputTokens(usage) {
	if (usage === null || typeof usage !== 'object') return null
	return nonNegative(usage.outputTokens) ?? null
}

/**
 * 把一次 429 的惩罚写进状态（AIMD，打重、恢复慢）。
 *
 * 冷却按 `15 * 2^(n-1)` 秒指数增长并夹在上限内。**一次风暴只罚一次**：冷却结束后的
 * {@link STORM_GAP_MS} 内再次触限算同一次风暴（DSH 对同一次请求的重试就落在这个窗口
 * 里），只把冷却从 15 秒继续拉长到 30 / 60 / 120…；`learned` 只在风暴开始时折半，
 * 安全模式也只按风暴次数计，避免一次抖动把账号钉死在最低速。
 *
 * **试探失败不等于基线失败**：如果这次 429 发生在向上试探期间，只回退到上一次
 * 确认过的安全值并指数退避，不折半、不计连续/单日 429 —— 试探本来就是去碰边界的，
 * 碰回来不该让正常速度腰斩。
 *
 * 基线 429 时，除折半 `learned` 外还把 `ceiling` 下调 10%：平台额度真的变小时，
 * 恢复目标也会随之收敛，不会一次次爬回已经被证明不安全的旧上限。
 *
 * `learned.rpm` 已到 2 还触限时不再折半，只加长冷却并标记 `scheduleThrottled`
 * （平台的账户级调度，不是本机速率问题）。
 * @param state - 路由状态。
 * @param now - 当前毫秒时间。
 * @param options - `{ cooldownCapMs }`。
 * @returns 新的状态。
 */
export function applyRateLimit(state, now, options) {
	const day = dayOf(now)
	const cap = Math.max(COOLDOWN_BASE_MS, finite(options?.cooldownCapMs) ?? COOLDOWN_CAP_MS)
	// 同一个风暴 = 上次冷却还没结束（或刚结束不久）就又撞上。
	const sameStorm = state.cooldownUntil > 0 && now <= state.cooldownUntil + STORM_GAP_MS
	const wasProbing = state.probe !== null
	const stormHits = sameStorm ? state.stormHits + 1 : 1
	const recent429 = [...state.recent429, now]
	const cooldownMs = Math.min(cap, COOLDOWN_BASE_MS * 2 ** (stormHits - 1))
	const base = {
		...state,
		stormHits,
		recent429,
		cleanSince: 0,
		cooldownMs,
		cooldownUntil: now + cooldownMs,
		updatedAt: now,
	}
	// 同一风暴里的后续重试只延冷却，不再折半、不再计安全模式。
	if (sameStorm) return base
	if (wasProbing) {
		const failures = state.probeFailures + 1
		const backoff = Math.min(
			PROBE_BACKOFF_MAX_MS,
			Math.max(PROBE_BACKOFF_BASE_MS, (state.probeBackoffMs > 0 ? state.probeBackoffMs : 0) * 2 || PROBE_BACKOFF_BASE_MS),
		)
		return {
			...base,
			// 回退到试探前的确认值；learned / ceiling / 429 计数都不动。
			probe: null,
			probeFailures: failures,
			probeBackoffMs: backoff,
		}
	}
	const consecutive429 = state.consecutive429 + 1
	const daily429 =
		state.daily429.day === day
			? { day, count: state.daily429.count + 1 }
			: { day, count: 1 }
	const next = {
		...base,
		consecutive429,
		daily429,
		probe: null,
		// 基线失败说明平台上限可能变了：恢复后重新允许试探，不要继承旧退避。
		probeBackoffMs: 0,
	}
	// 平台调度型：learned.rpm 已经到底了，再折半只会把 RPM 目标永远钉在 1，
	// 于是只加长冷却并打标记；但安全模式仍然照常判定 —— 「已到底」不是「不报凶」。
	const atBottom = state.learned.rpm <= SCHEDULE_THROTTLE_RPM
	if (atBottom) {
		next.scheduleThrottled = true
	} else {
		next.learned = {
			rpm: Math.max(RPM_FLOOR, state.learned.rpm * PENALTY_FACTOR),
			tpm: Math.max(LEARNED_TPM_FLOOR, state.learned.tpm * PENALTY_FACTOR),
		}
	}
	if (consecutive429 >= SAFE_MODE_CONSECUTIVE_429 || daily429.count >= SAFE_MODE_DAILY_429) {
		next.safeMode = true
		if (!atBottom) {
			next.learned = {
				rpm: Math.max(RPM_FLOOR, next.learned.rpm * PENALTY_FACTOR),
				tpm: Math.max(LEARNED_TPM_FLOOR, next.learned.tpm * PENALTY_FACTOR),
			}
		}
	}
	// 平台额度可能真的变小了：把恢复目标也按 10% 收敛，但不低于当前 learned，
	// 否则增长闸门会把 learned 封顶到比自己还低（等于悄悄降速）。
	next.ceiling = {
		rpm: Math.max(next.learned.rpm, state.ceiling.rpm * 0.9),
		tpm: Math.max(next.learned.tpm, state.ceiling.tpm * 0.9),
	}
	return next
}

/**
 * 冷却结束后的第一级恢复（0.6 倍）由 `cooldownUntil` 派生，见 `effectiveFactor`。
 * 这里不再保留独立状态。
 */

/**
 * 尝试一次「加法增长」或「向上试探」。
 *
 * 1. 如果正在试探：稳定够久且至少成功一次，就把试探值确认为新的 `learned`，
 *    同时把 `ceiling` 上移。确认不看 `lastGrowAt`，否则试探会多等一轮。
 * 2. 普通恢复：每次 +10%（RPM 至少 +0.2、TPM 至少 +200），只回到历史 `ceiling`。
 *    这条路径只回到已知安全值，风险低，因此仍按 10 分钟 / 5 分钟走，不受试探节奏拖慢。
 * 3. 已经回到 `ceiling` 且全程无 429 时，才按 {@link PROBE_STEP_SHARE} 试探
 *    更高一档；试探的「连续无 429」与「两次间隔」由 {@link PROBE_PACE} 决定。
 *    失败后由退避控制下一次试探，绝不会连续猛撞。
 *
 * 从「刚安装、还没发生过 429」的状态也允许增长：旧的 `cooldownUntil === 0`
 * 门槛会让动态模式永远停在先验值，平台提速后也学不到。
 * @param state - 路由状态。
 * @param now - 当前毫秒时间。
 * @param options - `{ mode, probe, probePace }`；`probe` 为 false 时只恢复不试探，
 *   `probePace` 取 `frequent` / `normal` / `conservative` / `rare`，未知值回 `normal`。
 * @returns 新的状态（未满足条件时原样返回）。
 */
export function applyGrowth(state, now, options = {}) {
	if (options?.mode === 'manual') return state
	// 试探确认：先于所有「增长间隔」判断，避免确认被 5 分钟窗口拖住。
	if (state.probe !== null) {
		if (options?.probe !== true) {
			// 用户关掉了「向上试探」：立即回到已确认值，不把这次试探算作成功。
			return { ...state, probe: null, probeBackoffMs: 0, probeFailures: 0, updatedAt: now }
		}
		const probe = state.probe
		if (now - probe.startedAt < PROBE_CONFIRM_MS) return state
		if (probe.successes < PROBE_CONFIRM_REQUESTS) return state
		return {
			...state,
			learned: { rpm: probe.rpm, tpm: probe.tpm },
			ceiling: {
				rpm: Math.max(state.ceiling.rpm, probe.rpm),
				tpm: Math.max(state.ceiling.tpm, probe.tpm),
			},
			probe: null,
			lastProbeAt: probe.startedAt,
			probeConfirmedAt: now,
			probeBackoffMs: 0,
			probeFailures: 0,
			lastGrowAt: now,
			updatedAt: now,
		}
	}
	if (state.safeMode) return state
	if (state.consecutive429 !== 0) return state
	if (state.cooldownUntil > 0 && now <= state.cooldownUntil + COOLDOWN_QUIET_MS) return state
	// 安全恢复：只回到已知 ceiling，按原有 10 分钟 / 5 分钟节奏，不被试探档拖慢。
	if (state.cleanSince === 0 || now <= state.cleanSince + GROWTH_CLEAN_MS) return state
	if (state.lastGrowAt !== 0 && now <= state.lastGrowAt + GROWTH_GAP_MS) return state
	const needsRecovery = state.learned.rpm < state.ceiling.rpm || state.learned.tpm < state.ceiling.tpm
	if (needsRecovery) {
		const rpmStep = Math.max(GROWTH_RPM_STEP, state.learned.rpm * GROWTH_SHARE)
		const tpmStep = Math.max(GROWTH_TPM_STEP, state.learned.tpm * GROWTH_SHARE)
		const learned = {
			rpm: Math.min(state.ceiling.rpm, state.learned.rpm + rpmStep),
			tpm: Math.min(state.ceiling.tpm, state.learned.tpm + tpmStep),
		}
		if (learned.rpm === state.learned.rpm && learned.tpm === state.learned.tpm) return state
		return { ...state, learned, lastGrowAt: now, updatedAt: now }
	}
	if (options?.probe !== true) return state
	// 试探比安全恢复更保守：连续无 429 的时长与两次试探的间隔都由节奏档决定。
	const pace = probePaceOf(options?.probePace)
	if (state.cleanSince === 0 || now <= state.cleanSince + pace.cleanMs) return state
	// 没有近期流量就不试探：那是在没有证据的情况下提高速率。
	if (state.updatedAt === 0 || now - state.updatedAt > PROBE_IDLE_MS) return state
	const afterLastGrowth = state.lastGrowAt === 0 ? 0 : state.lastGrowAt + GROWTH_GAP_MS
	const nextProbeAt = Math.max(state.lastProbeAt + pace.gapMs, afterLastGrowth) + state.probeBackoffMs
	if (now < nextProbeAt) return state
	const probeRpm = Math.min(
		PROBE_MAX_RPM,
		Math.max(state.learned.rpm + PROBE_STEP_RPM, state.learned.rpm * (1 + PROBE_STEP_SHARE)),
	)
	const probeTpm = Math.min(
		PROBE_MAX_TPM,
		Math.max(state.learned.tpm + PROBE_STEP_TPM, state.learned.tpm * (1 + PROBE_STEP_SHARE)),
	)
	if (probeRpm <= state.learned.rpm && probeTpm <= state.learned.tpm) return state
	return {
		...state,
		probe: { rpm: probeRpm, tpm: probeTpm, startedAt: now, successes: 0 },
		lastProbeAt: now,
		lastGrowAt: now,
		updatedAt: now,
	}
}

/**
 * 每日维护：滚动 `daily429` 的日期，并把 `ceiling` 乘 0.95。
 *
 * 平台额度会变，上界不能永久钉死在历史低值；但衰减只影响 `ceiling`，不直接提速。
 * @param state - 路由状态。
 * @param now - 当前毫秒时间。
 * @returns 新的状态。
 */
export function applyDailyUpkeep(state, now) {
	const day = dayOf(now)
	if (state.daily429.day === day) return state
	// 第一次运行（还没有任何日期）只记日期、不衰减：否则插件装好后的第一个 tick
	// 就白掉 5% 上界，且 `ceiling` 会低于 `learned` —— 增长闸门随后会把学到的速率
	// 「封顶」到比它自己还低的值，等于悄悄降速。
	const previous = state.daily429.day
	const ceiling =
		previous === ''
			? { rpm: state.ceiling.rpm, tpm: state.ceiling.tpm }
			: {
					rpm: Math.max(state.learned.rpm, state.ceiling.rpm * 0.95),
					tpm: Math.max(state.learned.tpm, state.ceiling.tpm * 0.95),
				}
	return {
		...state,
		daily429: { day, count: 0 },
		ceiling,
		// 新的一天不自动退出安全模式：退出只有一个入口 —— 用户点「重置学习状态」。
	}
}

/**
 * 用「官方明确值」重设学习状态。
 *
 * 本插件的接入点（`llm/stream`）只能看到 chunk，看不到渠道响应头，因此无法直接
 * 读取 `X-Ratelimit-*`。取而代之：用户切换档位时，档位数字就是官方/套餐明确值，
 * 用它覆盖 `learned` 与 `ceiling`，并把增长暂停 24 小时 —— 与「响应头优先」同义：
 * 有明确值时不靠 429 反推。
 * @param state - 路由状态。
 * @param limits - `{ rpm, tpm }`，明确上限。
 * @param now - 当前毫秒时间。
 * @returns 新的状态。
 */
export function applyLimitSignal(state, limits, now) {
	const rpm = finite(limits?.rpm)
	const tpm = finite(limits?.tpm)
	if (rpm === undefined || tpm === undefined) return state
	return {
		...state,
		learned: { rpm, tpm },
		ceiling: { rpm, tpm },
		// 用户给了明确档位：正在进行的试探作废，24 小时内不再自动增长/试探。
		probe: null,
		lastGrowAt: now + 24 * 3_600_000 - GROWTH_GAP_MS,
		probeBackoffMs: 0,
		probeFailures: 0,
		updatedAt: now,
	}
}

/**
 * 重置学习状态，回到先验（用户唯一能清掉一次误判的入口）。
 * @param state - 路由状态。
 * @param now - 当前毫秒时间。
 * @returns 新的状态。
 */
export function resetLearning(state, now) {
	const prior = state.prior
	return {
		...createRouteState({ provider: state.provider, model: state.model, prior, now }),
		safety: state.safety,
		estRatio: 1,
	}
}

/**
 * 渠道把「请求太快」说成了「额度超了」时的措辞特征。
 *
 * 百度千帆 Token Plan 个人版的真实限流响应是
 * `{"code":"token_plan_person_rate_limit_exceeded","message":"Token Plan Person
 * request rate limit exceeded","type":"quota_exceeded"}` —— HTTP 429，但字段里带着
 * `quota_exceeded`。适配器按「额度」分类就会丢掉 429 这个事实：本阀门便不会冷却，
 * `dsh-llm-retry` 也不会重试（`QUOTA` 不可重试），表现为「对话直接中断」。
 * 所以只要措辞点名了「请求速率」，就按 429 处理；真正的额度耗尽没有这些词。
 */
const RATE_LIMIT_WORDING =
	/rate[\s_-]*limit|too[\s_-]+many[\s_-]+requests|请求(?:过于|太)?频繁|频率(?:过快|过高)|限流/iu

/**
 * 把失败分类成这个阀门关心的四种语义。
 *
 * `rate-limit` 走退避、`quota` 不重试直接失败、`auth` 提示去设置页填 Cookie、
 * 其余原样透传。判定顺序：HTTP 429 与 `RATE_LIMIT` 最硬；其次是「措辞点名的速率
 * 限制」（见 {@link RATE_LIMIT_WORDING}）；最后才是额度/认证。
 * @param failure - `LlmFailure`（`code` / `status` / `message`）。
 * @returns `{ kind, code, status?, message }`。
 */
export function classifyFailure(failure) {
	if (failure === null || typeof failure !== 'object') {
		return { kind: 'other', code: 'UNKNOWN', message: '模型请求失败' }
	}
	const code = typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'UNKNOWN'
	const status = Number.isInteger(failure.status) ? failure.status : undefined
	const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : '模型请求失败'
	const detail = { code, message, ...(status === undefined ? {} : { status }) }
	if (code === 'RATE_LIMIT' || status === 429) return { kind: 'rate-limit', ...detail }
	// A provider that labels its rate limit as a quota keeps `QUOTA` in `code`; the
	// wording is then the only trustworthy evidence, and it is specific enough.
	if (RATE_LIMIT_WORDING.test(message)) return { kind: 'rate-limit', ...detail }
	if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return { kind: 'quota', ...detail }
	if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'ACCOUNT_SIGN_IN_REQUIRED' || code === 'ACCOUNT_TOKEN_INVALID' || code === 'MISSING_CREDENTIAL') {
		return { kind: 'auth', ...detail }
	}
	return { kind: 'other', ...detail }
}

/**
 * 中文补充说明：分类出 `quota` / `auth` 时面板与错误里都带一句可执行的下一步。
 * @param kind - `classifyFailure` 的 `kind`。
 * @returns 说明，其余情况为空串。
 */
export function failureGuidance(kind) {
	if (kind === 'quota') return '套餐额度已耗尽，请到百度智能云控制台续订后再试；本插件不会重试。'
	if (kind === 'auth') {
		return '百度千帆的控制台 Cookie 已失效或未填写，请到「设置 → 卡片功能 → 其他功能 → 百度千帆」保存后重试。'
	}
	if (kind === 'rate-limit') return '平台返回 429（Token Plan 个人版请求速率超限），已进入账户级冷却，冷却结束后自动恢复。'
	return ''
}

/**
 * 一个 UTF-16 码元是否属于 CJK。
 *
 * 展开成一次分支链而不是遍历区间数组：这段代码对上下文里的每个字符都要跑一遍，
 * `for…of` + 数组解构每字符分配一个迭代器，实测比裸比较慢一个数量级。命中率最高
 * 的汉字与假名区间排在最前，绝大多数输入在前两个比较里就返回。
 * @param code - `charCodeAt` 的结果。
 * @returns 是否按 1 token 计。
 */
function isCjk(code) {
	return (
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x3000 && code <= 0x303f) ||
		(code >= 0x3040 && code <= 0x30ff) ||
		(code >= 0xac00 && code <= 0xd7af) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0xff00 && code <= 0xffef) ||
		(code >= 0x2e80 && code <= 0x2eff) ||
		(code >= 0x1100 && code <= 0x11ff) ||
		(code >= 0x3100 && code <= 0x31bf) ||
		(code >= 0xa960 && code <= 0xa97f) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f)
	)
}

/**
 * 估一段文本的 token 数：CJK 1 字 1 token，其余 4 字符 1 token。
 *
 * 固定字符密度（char/4）会把中文严重低估 —— 一个汉字大约就是 1 个 token ——
 * 而千帆的 Agent 流量几乎全是中文上下文，所以这里按字符集分开计。
 *
 * 用逐个码元扫描而不是正则：这段代码在每次准入前都要跑一遍完整上下文（几万
 * 字符），`String#matchAll` 会为每个命中分配对象，实测比手写区间判断慢一个
 * 数量级，而闸门的开销预算只有 1 毫秒。
 * @param text - 任意文本。
 * @returns token 估算。
 */
export function estimateTextTokens(text) {
	if (typeof text !== 'string' || text === '') return 0
	// 先按「全部是 4 字符 1 token」起算，再把每个 CJK 码元补 0.75。
	let tokens = text.length / 4
	for (let at = 0; at < text.length; at += 1) {
		if (isCjk(text.charCodeAt(at))) tokens += 0.75
	}
	return tokens
}

/** 每条消息的角色/结构开销。 */
const MESSAGE_OVERHEAD = 4
/** 每个内容块的结构开销。 */
const BLOCK_OVERHEAD = 4

/** @param block - 一个内容块。 @returns 该块的结构性 token 估算。 */
function estimateStructuralBlock(block) {
	try {
		return BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(block))
	} catch {
		// 不可序列化的块（理论上不会出现）只计结构开销，不抛错打断请求。
		return BLOCK_OVERHEAD
	}
}

/** @param blocks - 内容块数组。 @returns token 估算。 */
function estimateContent(blocks) {
	if (!Array.isArray(blocks)) return 0
	let tokens = 0
	for (const block of blocks) {
		if (block === null || typeof block !== 'object') {
			tokens += BLOCK_OVERHEAD
			continue
		}
		switch (block.type) {
			case 'text':
			case 'reasoning':
				tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD
				break
			case 'tool-call':
				tokens +=
					estimateTextTokens(block.name) + estimateTextTokens(block.arguments) + BLOCK_OVERHEAD
				break
			default:
				tokens += estimateStructuralBlock(block)
		}
	}
	return tokens
}

/**
 * 估一次模型请求的输入 token。
 *
 * 逐条消息（含角色开销）加工具 schema；与 `@deepseek-ai/dsh-token-meter` 的固定
 * 密度启发式同构，只是把 CJK 从 char/4 换成 char/1。
 * @param request - `GenerateOptions`（只读）。
 * @returns 输入 token 估算。
 */
export function estimateRequestTokens(request) {
	let tokens = 0
	const messages = Array.isArray(request?.messages) ? request.messages : []
	for (const message of messages) {
		tokens += MESSAGE_OVERHEAD
		if (message === null || typeof message !== 'object') continue
		tokens += estimateContent(message.content)
	}
	if (typeof request?.system === 'string' && request.system !== '') {
		tokens += estimateTextTokens(request.system) + MESSAGE_OVERHEAD
	}
	const tools = request?.tools
	if (Array.isArray(tools) && tools.length > 0) {
		tokens += estimateTextTokens(JSON.stringify(tools)) + BLOCK_OVERHEAD
	}
	return Math.max(0, Math.round(tokens))
}

/**
 * 输出部分的预留 token。
 *
 * `max_tokens` 已知就用它；否则用该路由最近 20 次输出的 P95；再兜底 1024。
 * @param request - `GenerateOptions`（只读）。
 * @param state - 路由状态（取输出样本）。
 * @returns 预留 token 数。
 */
export function reserveOutputTokens(request, state) {
	if (typeof request?.maxTokens === 'number' && Number.isFinite(request.maxTokens) && request.maxTokens > 0) {
		return Math.round(request.maxTokens)
	}
	const samples = Array.isArray(state?.outputSamples) ? state.outputSamples : []
	if (samples.length >= 5) {
		const sorted = [...samples].sort((left, right) => left - right)
		const at = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
		return Math.max(1, Math.round(sorted[at]))
	}
	return 1024
}

/**
 * 一次准入要入账的 token 总量：`(输入 + 输出预留) * estRatio`。
 * @param request - `GenerateOptions`（只读）。
 * @param state - 路由状态。
 * @returns 入账 token 数。
 */
export function needTokens(request, state) {
	const estimate = estimateRequestTokens(request) + reserveOutputTokens(request, state)
	const ratio = Number.isFinite(state?.estRatio) ? state.estRatio : 1
	return Math.max(1, Math.round(estimate * ratio))
}

/**
 * 面板用的只读快照（O(1)，无网络）。
 * @param state - 已 prune 的路由状态。
 * @param settings - 阀门设置。
 * @param now - 当前毫秒时间。
 * @returns 状态面板要的全部字段。
 */
export function statusOf(state, settings, now) {
	const targets = resolveTargets(settings, state, now)
	const usage = windowUsage(state)
	const recent429 = state.recent429.filter((at) => at > now - 3_600_000).length
	const badge = !settings.enabled
		? 'off'
		: state.cooldownUntil > now
			? 'cooldown'
			: state.safeMode
				? 'safe'
				: 'normal'
	const cooldownRemainingMs = Math.max(0, state.cooldownUntil - now)
	// 最近 60 秒进入闸门的请求数 vs 实际放行数：这就是「不限流时本来能跑多少」的
	// 实践代理值（全部放行 = 100%）。等待中的请求只计入 arrivals，不虚增放行数。
	const demandCount = Array.isArray(state.arrivals) ? state.arrivals.length : 0
	const demandPercent =
		demandCount > 0 ? Math.min(100, Math.max(0, Math.round((usage.requests / demandCount) * 100))) : null
	// 动态模式的安全区间：正常上限是 learned*safety；冷却刚结束时先回到 0.6 倍。
	// 手动档位是固定值，区间退化为一个点；无限制档没有安全区间。
	const recoveryFactor = Math.min(RECOVERY_FACTOR, state.safety)
	const safeRange = targets.unlimited
		? { unlimited: true, rpm: { min: 0, max: 0 }, tpm: { min: 0, max: 0 } }
		: settings.mode === 'manual'
			? {
					unlimited: false,
					rpm: { min: targets.rpm, max: targets.rpm },
					tpm: { min: targets.tpm, max: targets.tpm },
				}
			: {
					unlimited: false,
					rpm: {
						min: Math.max(RPM_FLOOR, Math.floor(state.learned.rpm * recoveryFactor)),
						max: Math.max(RPM_FLOOR, Math.floor(state.learned.rpm * state.safety)),
					},
					tpm: {
						min: Math.max(TPM_FLOOR, Math.floor(state.learned.tpm * recoveryFactor)),
						max: Math.max(TPM_FLOOR, Math.floor(state.learned.tpm * state.safety)),
					},
				}
	return {
		provider: state.provider,
		model: state.model,
		badge,
		scheduleThrottled: state.scheduleThrottled,
		targets: {
			unlimited: targets.unlimited,
			rpm: targets.rpm,
			tpm: targets.tpm,
			concurrency: targets.concurrency,
			factor: targets.factor,
		},
		learned: { rpm: round1(state.learned.rpm), tpm: Math.round(state.learned.tpm) },
		prior: { rpm: round1(state.prior.rpm), tpm: Math.round(state.prior.tpm) },
		ceiling: { rpm: round1(state.ceiling.rpm), tpm: Math.round(state.ceiling.tpm) },
		used: {
			requests: usage.requests,
			tokens: Math.round(usage.tokens),
			inFlight: state.inFlight,
		},
		/** 最近 60 秒的请求量 / 放行量 / 发挥百分比（没有请求时为 null）。 */
		demand: {
			requests: demandCount,
			admitted: usage.requests,
			percent: demandPercent,
		},
		/** 动态模式的安全区间（恢复下限 – 正常上限）。 */
		safeRange,
		probe:
			state.probe === null
				? null
				: {
						rpm: round1(state.probe.rpm),
						tpm: Math.round(state.probe.tpm),
						startedAt: state.probe.startedAt,
						successes: state.probe.successes,
						confirmsAt: state.probe.startedAt + PROBE_CONFIRM_MS,
					},
		probeBackoffMs: state.probeBackoffMs,
		probeFailures: state.probeFailures,
		lastProbeAt: state.lastProbeAt,
		probeConfirmedAt: state.probeConfirmedAt,
		cooldownRemainingMs,
		cooldownMs: state.cooldownMs,
		consecutive429: state.consecutive429,
		daily429: state.daily429.count,
		hourly429: recent429,
		safeMode: state.safeMode,
		recovering: state.cooldownUntil > 0 && now < state.cooldownUntil + RECOVERY_HOLD_MS && now >= state.cooldownUntil,
		estRatio: round2(state.estRatio),
		oversizeCount: state.oversizeCount,
		timeoutCount: state.timeoutCount,
		updatedAt: state.updatedAt,
	}
}

/** @param value - 数。 @returns 保留一位小数。 */
function round1(value) {
	return Math.round(value * 10) / 10
}

/** @param value - 数。 @returns 保留两位小数。 */
function round2(value) {
	return Math.round(value * 100) / 100
}

/**
 * 把一条路由压缩成可持久化的 JSON（不含运行时字段）。
 * @param state - 路由状态。
 * @returns 纯数据。
 */
export function serializeRoute(state) {
	return {
		provider: state.provider,
		model: state.model,
		prior: { rpm: state.prior.rpm, tpm: state.prior.tpm },
		learned: { rpm: state.learned.rpm, tpm: state.learned.tpm },
		ceiling: { rpm: state.ceiling.rpm, tpm: state.ceiling.tpm },
		safety: state.safety,
		seq: state.seq,
		cooldownUntil: state.cooldownUntil,
		cooldownMs: state.cooldownMs,
		consecutive429: state.consecutive429,
		cleanSince: state.cleanSince,
		lastGrowAt: state.lastGrowAt,
		lastProbeAt: state.lastProbeAt,
		probeConfirmedAt: state.probeConfirmedAt,
		probeBackoffMs: state.probeBackoffMs,
		probeFailures: state.probeFailures,
		daily429: { day: state.daily429.day, count: state.daily429.count },
		recent429: state.recent429.slice(-200),
		safeMode: state.safeMode,
		scheduleThrottled: state.scheduleThrottled,
		estRatio: state.estRatio,
		outputSamples: state.outputSamples.slice(-20),
		oversizeCount: state.oversizeCount,
		timeoutCount: state.timeoutCount,
		updatedAt: state.updatedAt,
	}
}

/**
 * 从磁盘读回一条路由。缺字段按先验补齐，绝不让一次损坏的状态文件挡住限流。
 * @param raw - 文件里的一个条目。
 * @param options - `{ preset, manual, safety, now }`。
 * @returns 路由状态，或 undefined（条目不可用）。
 */
export function restoreRoute(raw, options) {
	if (raw === null || typeof raw !== 'object') return undefined
	if (typeof raw.provider !== 'string' || raw.provider === '') return undefined
	if (typeof raw.model !== 'string' || raw.model === '') return undefined
	const state = createRouteState({
		provider: raw.provider,
		model: raw.model,
		prior: priorFor(options?.preset, options?.manual),
		learned: raw.learned,
		ceiling: raw.ceiling,
		safety: options?.safety,
		now: options?.now,
	})
	state.prior = {
		rpm: Math.max(RPM_FLOOR, finite(raw.prior?.rpm) ?? state.prior.rpm),
		tpm: Math.max(TPM_FLOOR, finite(raw.prior?.tpm) ?? state.prior.tpm),
	}
	state.seq = Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0
	state.cooldownUntil = Number.isFinite(raw.cooldownUntil) ? raw.cooldownUntil : 0
	state.cooldownMs = Number.isFinite(raw.cooldownMs) ? raw.cooldownMs : 0
	state.consecutive429 = Number.isSafeInteger(raw.consecutive429) && raw.consecutive429 >= 0 ? raw.consecutive429 : 0
	state.cleanSince = Number.isFinite(raw.cleanSince) ? raw.cleanSince : 0
	state.lastGrowAt = Number.isFinite(raw.lastGrowAt) ? raw.lastGrowAt : 0
	// 进行中的试探不持久化：重启后没有在途请求，把旧试探当成一次未完成尝试即可。
	state.probe = null
	state.lastProbeAt = Number.isFinite(raw.lastProbeAt) ? raw.lastProbeAt : 0
	state.probeConfirmedAt = Number.isFinite(raw.probeConfirmedAt) ? raw.probeConfirmedAt : 0
	state.probeBackoffMs = Number.isFinite(raw.probeBackoffMs) ? Math.max(0, raw.probeBackoffMs) : 0
	state.probeFailures = Number.isSafeInteger(raw.probeFailures) && raw.probeFailures >= 0 ? raw.probeFailures : 0
	state.daily429 = {
		day: typeof raw.daily429?.day === 'string' ? raw.daily429.day : '',
		count: Number.isSafeInteger(raw.daily429?.count) && raw.daily429.count >= 0 ? raw.daily429.count : 0,
	}
	state.recent429 = Array.isArray(raw.recent429) ? raw.recent429.filter((at) => Number.isFinite(at)) : []
	state.safeMode = raw.safeMode === true
	state.scheduleThrottled = raw.scheduleThrottled === true
	state.estRatio = clampRatio(raw.estRatio) ?? 1
	state.outputSamples = Array.isArray(raw.outputSamples)
		? raw.outputSamples.filter((value) => Number.isFinite(value) && value >= 0).slice(-20)
		: []
	state.oversizeCount = Number.isSafeInteger(raw.oversizeCount) ? Math.max(0, raw.oversizeCount) : 0
	state.timeoutCount = Number.isSafeInteger(raw.timeoutCount) ? Math.max(0, raw.timeoutCount) : 0
	state.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
	// 外部数据的边界处再修一次不变式：`ceiling` 是「历史最高未触限速率」，永远不会低于
	// 当前学到值。手改过的文件、早期版本的衰减都可能在文件里留下 ceiling < learned，
	// 而增长闸门随后会把 learned「封顶」到比它自己还低 —— 那等于悄悄降速。
	state.ceiling = {
		rpm: Math.max(state.learned.rpm, state.ceiling.rpm),
		tpm: Math.max(state.learned.tpm, state.ceiling.tpm),
	}
	return state
}

/**
 * 状态路由里「路由太多」时只保留最近活跃的若干条。
 * @param states - 全部路由状态。
 * @param limit - 保留条数。
 * @returns 按 `updatedAt` 倒序的保留集合。
 */
export function activeRoutes(states, limit = MAX_ROUTES) {
	return [...states].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
}