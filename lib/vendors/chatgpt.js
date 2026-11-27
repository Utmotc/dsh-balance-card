/**
 * ChatGPT / Codex — `backend-api/wham/usage`，Bearer token（可选账号头）。
 * @module dsh-balance-card/vendors/chatgpt
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading } from '../parse.js'

/**
 * @param context - `{ credentials, settings, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, settings, timeoutMs, signal }) {
	const token = credentials.token
	if (typeof token !== 'string' || token === '') throw new VendorError('unconfigured', '未配置 OPENAI_CODEX_API_KEY。')
	const accountId = typeof settings?.advanced?.accountId === 'string' ? settings.advanced.accountId : ''
	const body = await requestJson('https://chatgpt.com/backend-api/wham/usage', {
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'user-agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64)',
			...(accountId === '' ? {} : { 'chatgpt-account-id': accountId }),
		},
		timeoutMs,
		signal,
	})
	const windows = parse(body)
	if (windows.length === 0) throw new VendorError('parse', 'Codex usage 没有返回可解析的窗口。')
	return percentReading({ windows, primary: 'five-hour', note: 'Codex 用量，接口非公开。' })
}

/**
 * 解析 `rate_limit` 的主/次窗口。
 * @param body - 响应。
 * @returns 窗口数组。
 */
function parse(body) {
	const group = body?.rate_limit ?? body?.rateLimit
	const rows = [
		{ raw: group?.primary_window ?? group?.primaryWindow, id: 'five-hour', label: '5 小时' },
		{ raw: group?.secondary_window ?? group?.secondaryWindow, id: 'weekly', label: '周额度' },
	]
	const windows = []
	for (const row of rows) {
		if (row.raw === null || typeof row.raw !== 'object') continue
		const used = num(row.raw.used_percent) ?? num(row.raw.usedPercent)
		if (used === undefined) continue
		const percent = Math.min(100, Math.max(0, 100 - used))
		const resetsAt =
			row.raw.reset_at ??
			row.raw.resetAt ??
			(num(row.raw.reset_after_seconds ?? row.raw.resetAfterSeconds) === undefined
				? ''
				: Date.now() + num(row.raw.reset_after_seconds ?? row.raw.resetAfterSeconds) * 1000)
		windows.push({
			id: row.id,
			label: row.label,
			percent,
			remaining: percent,
			total: 100,
			used: 100 - percent,
			resetsAt,
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	return windows
}