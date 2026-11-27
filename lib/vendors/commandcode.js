/**
 * CommandCode — `billing/credits` 的窗口限额与月度 Credits。
 * @module dsh-balance-card/vendors/commandcode
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { currencyReading, num, percentReading } from '../parse.js'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 百分比读数或 Credits 余额。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const key = credentials.key
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 COMMANDCODE_API_KEY。')
	const body = await requestJson('https://api.commandcode.ai/alpha/billing/credits', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const windows = parseWindows(body)
	if (windows.length > 0) return percentReading({ windows, primary: windows[0].id })
	const credits = num(body?.credits?.monthlyCredits)
	if (credits !== undefined) {
		return currencyReading({
			unit: '$',
			remaining: credits,
			windows: [{ id: 'monthly', label: '月度 Credits', remaining: credits }],
		})
	}
	throw new VendorError('no_reading', 'CommandCode 没有返回有效的额度窗口。')
}

/**
 * 解析 windowLimits。
 * @param body - 响应。
 * @returns 窗口数组。
 */
function parseWindows(body) {
	const limits = body?.windowLimits
	if (limits === null || typeof limits !== 'object') return []
	const windows = []
	for (const [name, row] of Object.entries(limits)) {
		if (row === null || typeof row !== 'object') continue
		const used = num(row.used)
		const cap = num(row.cap)
		if (used === undefined || cap === undefined || cap <= 0) continue
		const percent = Math.min(100, Math.max(0, 100 - (used / cap) * 100))
		windows.push({
			id: name,
			label: name === 'fiveHour' ? '5 小时' : name === 'weekly' ? '周额度' : '月度',
			percent,
			remaining: percent,
			total: 100,
			used: 100 - percent,
			resetsAt: row.resetAt ?? '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	return windows
}