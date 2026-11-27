/**
 * 小米 MiMo Token Plan — 控制台 Cookie。
 *
 * 三个只读端点（实测契约来自社区适配）：`tokenPlan/usage`（套餐积分用量）、
 * `tokenPlan/detail`（周期截止 = 重置时间）、`balance`（现金/赠送余额）。
 * 用量失败时退回余额；两者都失败才报错。
 * @module dsh-balance-card/vendors/mimo
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { currencyReading, num, percentReading, quotaReading, round2 } from '../parse.js'

const BASE = 'https://platform.xiaomimimo.com/api/v1'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 额度或金额读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const cookie = credentials.cookie
	if (typeof cookie !== 'string' || cookie === '') {
		throw new VendorError('unconfigured', '未配置 MIMO_COOKIE（需要 userId 与 serviceToken）。')
	}
	const headers = { cookie, accept: 'application/json' }
	let usage
	try {
		usage = await requestJson(`${BASE}/tokenPlan/usage`, { headers, timeoutMs, signal })
	} catch (error) {
		if (error instanceof VendorError && ['unauthorized', 'forbidden'].includes(error.code)) {
			throw new VendorError('expired', 'MiMo 控制台登录已过期，请重新复制 Cookie。')
		}
		return await balanceReading(headers, timeoutMs, signal, error)
	}
	const windows = parseUsage(usage)
	if (windows.length === 0) return await balanceReading(headers, timeoutMs, signal, new VendorError('no_reading'))

	// 周期截止时间来自 detail；失败不影响用量展示。
	let resetsAt = ''
	try {
		const detail = await requestJson(`${BASE}/tokenPlan/detail`, { headers, timeoutMs, signal })
		const raw = detail?.data?.currentPeriodEnd
		if (typeof raw === 'string' && raw.trim() !== '') {
			const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/u.test(raw.trim()) ? `${raw.trim().replace(' ', 'T')}+08:00` : raw
			const parsed = Date.parse(iso)
			if (Number.isFinite(parsed)) resetsAt = new Date(parsed).toISOString()
		}
	} catch {
		resetsAt = ''
	}
	if (resetsAt !== '') for (const window of windows) if (window.resetsAt === '') window.resetsAt = resetsAt
	return quotaReading({
		kind: 'tokens',
		unit: 'Tokens',
		windows,
		primary: windows[0]?.id,
		note: 'MiMo Token Plan',
	})
}

/**
 * 余额兜底读数。
 * @param headers - 请求头。
 * @param timeoutMs - 超时。
 * @param signal - 中止信号。
 * @param prior - 之前失败的原因。
 * @returns 金额读数。
 */
async function balanceReading(headers, timeoutMs, signal, prior) {
	let body
	try {
		body = await requestJson(`${BASE}/balance`, { headers, timeoutMs, signal })
	} catch {
		throw prior
	}
	const data = body?.data !== null && typeof body?.data === 'object' ? body.data : body
	const balance = num(data?.balance) ?? num(data?.cashBalance)
	if (balance === undefined) throw prior
	const currency = String(data?.currency ?? 'CNY').toUpperCase()
	return currencyReading({
		unit: currency === 'USD' ? '$' : '¥',
		remaining: balance,
		windows: [{ id: 'balance', label: '账户余额', remaining: balance }],
		note: '未读到 Token Plan 用量，显示账户余额',
	})
}

/**
 * 解析 usage 的 items。
 * @param body - 响应。
 * @returns 窗口数组。
 */
function parseUsage(body) {
	const root = body?.data !== null && typeof body?.data === 'object' ? body.data : body
	const items = Array.isArray(root?.monthUsage?.items)
		? root.monthUsage.items
		: Array.isArray(root?.usage?.items)
			? root.usage.items
			: Array.isArray(root?.items)
				? root.items
				: []
	const windows = []
	for (const [index, row] of items.entries()) {
		if (row === null || typeof row !== 'object') continue
		const name = typeof row.name === 'string' ? row.name : `window-${index}`
		const label = name === 'month_total_token' || name === 'plan_total_token'
			? '套餐积分'
			: name === 'compensation_total_token'
				? '补偿积分'
				: name
		const total = num(row.limit) ?? num(row.total)
		const used = num(row.used)
		let percent
		if (total !== undefined && total > 0 && used !== undefined) percent = 100 - (used / total) * 100
		else {
			const fraction = num(row.percent)
			if (fraction !== undefined) percent = 100 - fraction * 100
		}
		if (percent === undefined) continue
		windows.push({
			id: label,
			label,
			remaining: total !== undefined && used !== undefined ? round2(total - used) : round2(percent),
			total: total === undefined ? 100 : round2(total),
			used: used === undefined ? round2(100 - percent) : round2(used),
			percent: Math.min(100, Math.max(0, round2(percent))),
			resetsAt: row.reset_at ?? row.resetAt ?? '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	return windows
}