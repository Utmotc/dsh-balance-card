/**
 * Cline Pass — `api/v1/users/me/plan/usage-limits`。
 * @module dsh-balance-card/vendors/clinepass
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading } from '../parse.js'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const key = credentials.key
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 CLINE_PASS_API_KEY。')
	const body = await requestJson('https://api.cline.bot/api/v1/users/me/plan/usage-limits', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const limits = Array.isArray(body?.data?.limits) ? body.data.limits : []
	const windows = []
	for (const row of limits) {
		if (row === null || typeof row !== 'object') continue
		const type = String(row.type ?? '')
		const id = type === 'five_hour' ? 'five-hour' : type === 'weekly' ? 'weekly' : type === 'monthly' ? 'monthly' : ''
		if (id === '') continue
		const used = num(row.percentUsed)
		if (used === undefined) continue
		const percent = Math.min(100, Math.max(0, 100 - used))
		windows.push({
			id,
			label: id === 'five-hour' ? '5 小时' : id === 'weekly' ? '周额度' : '月度',
			percent,
			remaining: percent,
			total: 100,
			used: 100 - percent,
			resetsAt: row.resetsAt ?? '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	if (windows.length === 0) throw new VendorError('no_reading', 'Cline Pass 没有返回有效的额度窗口。')
	return percentReading({ windows, primary: windows[0].id })
}