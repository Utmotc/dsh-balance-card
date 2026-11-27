/**
 * dsh-balance-card 2.0 — 读数归一化。
 *
 * 所有适配器最后都产出同一个形状：
 *
 * ```js
 * {
 *   kind: 'currency' | 'quota' | 'credits' | 'tokens',
 *   unit: '¥' | '$' | '积分' | 'Tokens' | '次',
 *   remaining: 9642,          // 主读数
 *   total: 10000 | null,
 *   used: 358 | null,
 *   percent: 96.42 | null,    // 剩余百分比（不是已用）
 *   windows: [{ id, label, remaining, total, used, percent, resetsAt, expiresAt, unlimited, note }],
 *   primary: 'monthly',
 *   note: ''
 * }
 * ```
 *
 * 百分比只在这里计算一次：卡片、面板、设置页共用同一份数字，绝不各自重算。
 * @module dsh-balance-card/parse
 */

/**
 * 数字归一化：接受数字或数字字符串；拒绝 null、布尔、空串、NaN、Infinity。
 * @param value - 候选值。
 * @returns 有限数字或 undefined。
 */
export function num(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (trimmed === '') return undefined
		const parsed = Number(trimmed)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

/**
 * 保留两位小数（金额与积分统一走这里）。
 * @param value - 有限数字。
 * @returns 两位小数。
 */
export function round2(value) {
	// 1.005 × 100 在二进制浮点里是 100.49999999999999；toPrecision(12) 先把它
	// 收敛回十进制语义，再四舍五入，避免财务数字出现「差一分」。
	return Math.round(Number((value * 100).toPrecision(12))) / 100
}

/**
 * 剩余百分比，0–100，保留两位。
 * @param remaining - 剩余量。
 * @param total - 总量；非正数时返回 undefined。
 * @returns 剩余百分比或 undefined。
 */
export function remainingPercent(remaining, total) {
	const left = num(remaining)
	const all = num(total)
	if (left === undefined || all === undefined || all <= 0) return undefined
	return round2(Math.min(100, Math.max(0, (left / all) * 100)))
}

/**
 * 已用百分比（部分厂商只给已用），转成剩余百分比。
 * @param usedPercent - 0–100 的已用百分比。
 * @returns 剩余百分比或 undefined。
 */
export function remainingFromUsed(usedPercent) {
	const used = num(usedPercent)
	return used === undefined ? undefined : round2(Math.min(100, Math.max(0, 100 - used)))
}

/**
 * 把秒 / 毫秒 / ISO 字符串统一成 ISO 字符串。
 * @param value - 时间值。
 * @returns ISO 字符串，无法解析时为空串。
 */
export function isoOf(value) {
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Date.parse(value)
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
		const numeric = Number(value)
		if (Number.isFinite(numeric) && numeric > 0) {
			return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString()
		}
		return ''
	}
	const numeric = num(value)
	if (numeric === undefined || numeric <= 0) return ''
	return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString()
}

/**
 * 组装一个窗口。
 *
 * 窗口的 `percent` 仍然是剩余百分比；调用方若拿到的是「已用」，先转换再传入。
 * @param input - `{ id, label, remaining, total, used, percent, resetsAt, expiresAt, unlimited, note }`。
 * @returns 规范化窗口。
 */
export function makeWindow(input) {
	const remaining = num(input.remaining)
	const total = num(input.total)
	const used = num(input.used)
	const percent =
		num(input.percent) !== undefined && num(input.percent) >= 0
			? round2(Math.min(100, Math.max(0, num(input.percent))))
			: remainingPercent(remaining, total)
	return {
		id: typeof input.id === 'string' && input.id !== '' ? input.id : 'window',
		label: typeof input.label === 'string' && input.label !== '' ? input.label : '',
		remaining: remaining === undefined ? null : round2(remaining),
		total: total === undefined ? null : round2(total),
		used: used === undefined ? null : round2(used),
		percent: percent === undefined ? null : percent,
		resetsAt: isoOf(input.resetsAt),
		expiresAt: isoOf(input.expiresAt),
		unlimited: input.unlimited === true,
		// 窗口自己的单位（仅 SCNet 这类「Credits + 现金」混合读数需要；其余留空，
		// 客户端回退到整份读数的单位）。
		unit: typeof input.unit === 'string' ? input.unit : '',
		note: typeof input.note === 'string' ? input.note : '',
	}
}

/**
 * 组装最终读数。
 *
 * `windows` 的第一项默认是主窗口；也可以显式给 `primary`。主读数为 0 是合法值，
 * 只有 undefined 才表示「没有读数」——适配器必须抛 `no_reading` 而不是补 0。
 * @param input - 归一化字段。
 * @returns 浏览器可消费的读数。
 */
export function makeReading(input) {
	const windows = Array.isArray(input.windows)
		? input.windows.filter((win) => win !== null && typeof win === 'object').map(makeWindow)
		: []
	const primaryId = typeof input.primary === 'string' && input.primary !== '' ? input.primary : windows[0]?.id ?? ''
	const primaryWindow = windows.find((win) => win.id === primaryId) ?? windows[0]
	const remaining = num(input.remaining) ?? primaryWindow?.remaining ?? undefined
	if (remaining === undefined || remaining === null) {
		throw new Error('reading has no remaining value')
	}
	const total = num(input.total) ?? primaryWindow?.total ?? undefined
	const used = num(input.used) ?? primaryWindow?.used ?? undefined
	const percent =
		num(input.percent) ??
		primaryWindow?.percent ??
		remainingPercent(remaining, total)
	return {
		kind: input.kind,
		unit: typeof input.unit === 'string' ? input.unit : '',
		remaining: round2(remaining),
		total: total === undefined ? null : round2(total),
		used: used === undefined ? null : round2(used),
		percent: percent === undefined || percent === null ? null : round2(percent),
		windows,
		primary: primaryWindow?.id ?? '',
		note: typeof input.note === 'string' ? input.note : '',
	}
}

/**
 * 金额型读数。
 * @param input - `{ unit, remaining, total, used, windows, note, primary }`。
 * @returns 读数。
 */
export function currencyReading(input) {
	return makeReading({ ...input, kind: 'currency' })
}

/**
 * 额度型读数。
 * @param input - `{ kind, unit, remaining, total, used, windows, note, primary }`。
 * @returns 读数。
 */
export function quotaReading(input) {
	return makeReading({
		...input,
		kind: input.kind === 'credits' || input.kind === 'tokens' ? input.kind : 'quota',
	})
}

/**
 * 把「已用 / 总量」翻译成剩余窗口。
 * @param input - `{ id, label, used, total, resetsAt, note }`。
 * @returns 窗口。
 */
export function usedWindow(input) {
	const total = num(input.total)
	const used = num(input.used)
	const remaining = total !== undefined && used !== undefined ? total - used : undefined
	return makeWindow({
		id: input.id,
		label: input.label,
		remaining,
		total,
		used,
		percent: input.percent,
		resetsAt: input.resetsAt,
		expiresAt: input.expiresAt,
		unlimited: input.unlimited,
		note: input.note,
	})
}

/**
 * 只有百分比的读数（Claude / Codex / 智谱 / Antigravity 等订阅接口）。
 *
 * 这些接口不返回绝对量，所以统一把 100 当作总量、百分比当作剩余：卡片显示
 * 「42.5%」，进度条与环仍然有可画的数值，且绝不伪造一个「剩余 4250 次」。
 * @param input - `{ windows, primary, note, kind }`。
 * @returns 读数。
 */
export function percentReading(input) {
	const windows = (Array.isArray(input.windows) ? input.windows : []).map((win) => {
		const percent = num(win.percent) ?? num(win.remainingPercent)
		const remaining = num(win.remaining) ?? percent
		const total = num(win.total) ?? (percent === undefined ? undefined : 100)
		const used = num(win.used) ?? (percent === undefined ? undefined : round2(100 - percent))
		return {
			id: win.id,
			label: win.label,
			remaining,
			total,
			used,
			percent,
			resetsAt: win.resetsAt,
			expiresAt: win.expiresAt,
			unlimited: win.unlimited,
			note: win.note,
		}
	})
	return makeReading({
		kind: input.kind === 'credits' || input.kind === 'tokens' ? input.kind : 'quota',
		unit: '%',
		windows,
		primary: input.primary,
		note: input.note,
	})
}

/**
 * 把「剩余百分比」窗口补成 0–100 读数（部分订阅接口只给百分比）。
 * @param input - `{ id, label, remainingPercent, resetsAt }`。
 * @returns 窗口（remaining 缺失，percent 有值）。
 */
export function percentWindow(input) {
	return makeWindow({
		id: input.id,
		label: input.label,
		remaining: input.remaining,
		total: input.total,
		used: input.used,
		percent: input.percent ?? input.remainingPercent,
		resetsAt: input.resetsAt,
		expiresAt: input.expiresAt,
	})
}