/**
 * MiniMax — Token Plan 的 5 小时 / 周窗口。
 *
 * 官方同时存在 `.cn` / `.com` / `.io` 与新旧两个路径，按顺序尝试；解析优先用
 * `*_remaining_percent`（现行接口 total 常为 0），否则用 total/used 反推。
 * @module dsh-balance-card/vendors/minimax
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading, remainingFromUsed } from '../parse.js'

/** 依次尝试的官方端点。 */
const ENDPOINTS = [
	'https://www.minimax.cn/v1/token_plan/remains',
	'https://www.minimaxi.com/v1/token_plan/remains',
	'https://www.minimax.io/v1/token_plan/remains',
]

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const key = credentials.key
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 MINIMAX_API_KEY。')
	let last
	for (const endpoint of ENDPOINTS) {
		try {
			const body = await requestJson(endpoint, {
				headers: { authorization: `Bearer ${key}` },
				timeoutMs,
				signal,
			})
			const reading = parse(body)
			if (reading !== null) return reading
			last = new VendorError('no_reading', 'MiniMax 接口返回了空额度。')
		} catch (error) {
			last = error
			if (error instanceof VendorError && ['unauthorized', 'rate_limited', 'network', 'timeout'].includes(error.code)) {
				break
			}
		}
	}
	throw last ?? new VendorError('no_reading')
}

/**
 * 解析 MiniMax 的多种历史形态。
 * @param body - 响应 JSON。
 * @returns 百分比读数或 null。
 */
function parse(body) {
	const rows = Array.isArray(body?.model_remains)
		? body.model_remains
		: Array.isArray(body?.data?.model_remains)
			? body.data.model_remains
			: []
	if (rows.length > 0) {
		const list = rows.filter((row) => row !== null && typeof row === 'object')
		const row =
			list.find((entry) => String(entry.model_name ?? '').toLowerCase() === 'general') ??
			list.find((entry) => /^minimax-m/iu.test(String(entry.model_name ?? ''))) ??
			list[0]
		const windows = []
		const fiveHour = intervalWindow(row, 'five-hour', '5 小时', 'current_interval')
		if (fiveHour !== null) windows.push(fiveHour)
		const weekly = intervalWindow(row, 'weekly', '周额度', 'current_weekly')
		if (weekly !== null) windows.push(weekly)
		if (windows.length === 0) return null
		return percentReading({ windows, primary: 'five-hour' })
	}

	const flat = body?.data !== null && typeof body?.data === 'object' && !Array.isArray(body?.data) ? body.data : body
	if (flat === null || typeof flat !== 'object') return null
	const windows = []
	const fiveHour = intervalWindow(flat, 'five-hour', '5 小时', 'current_interval')
	if (fiveHour !== null) windows.push(fiveHour)
	const weekly = intervalWindow(flat, 'weekly', '周额度', 'current_weekly')
	if (weekly !== null) windows.push(weekly)
	if (windows.length === 0) return null
	return percentReading({ windows, primary: 'five-hour' })
}

/**
 * 从一条记录里取一个窗口。
 * @param row - 记录。
 * @param id - 窗口 id。
 * @param label - 窗口名。
 * @param prefix - 字段前缀（`current_interval` / `current_weekly`）。
 * @returns 百分比窗口或 null。
 */
function intervalWindow(row, id, label, prefix) {
	if (row === null || typeof row !== 'object') return null
	const status = num(row[`${prefix}_status`])
	if (status === 3) return { id, label, percent: 100, resetsAt: '' }
	const explicit = num(row[`${prefix}_remaining_percent`])
	const total = num(row[`${prefix}_total_count`])
	const used = num(row[`${prefix}_usage_count`])
	const remain = num(row[`${prefix}_remain_count`])
	let percent
	if (explicit !== undefined) percent = Math.min(100, Math.max(0, explicit))
	else if (total !== undefined && total > 0) {
		if (remain !== undefined) percent = (remain / total) * 100
		else if (used !== undefined) percent = remainingFromUsed((used / total) * 100)
	}
	if (percent === undefined) return null
	const resetsAt = prefix === 'current_weekly' ? row.weekly_end_time : row.end_time
	return { id, label, percent, resetsAt }
}