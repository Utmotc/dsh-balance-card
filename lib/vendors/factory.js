/**
 * Factory (Droid) — `GET api.factory.ai/api/billing/limits`。
 * @module dsh-balance-card/vendors/factory
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading } from '../parse.js'

/**
 * @param context - `{ credentials, settings, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, settings, timeoutMs, signal }) {
	const key = credentials.key
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 FACTORY_API_KEY。')
	const orgId = typeof settings?.advanced?.orgId === 'string' ? settings.advanced.orgId : ''
	const body = await requestJson('https://api.factory.ai/api/billing/limits', {
		headers: {
			authorization: `Bearer ${key}`,
			'x-client-version': '0.231.0',
			'x-factory-client': 'cli',
			...(orgId === '' ? {} : { 'x-factory-org-id': orgId }),
		},
		timeoutMs,
		signal,
	})
	const windows = parse(body)
	if (windows.length === 0) throw new VendorError('no_reading', 'Factory 没有返回有效的额度窗口。')
	return percentReading({ windows, primary: windows[0].id })
}

/**
 * 解析 `limits.standard` / `limits.core`。
 * @param body - 响应。
 * @returns 窗口数组。
 */
function parse(body) {
	const windows = []
	const pools = body?.limits !== null && typeof body?.limits === 'object' ? body.limits : {}
	for (const [poolName, pool] of Object.entries(pools)) {
		if (pool === null || typeof pool !== 'object') continue
		for (const name of ['fiveHour', 'weekly', 'monthly']) {
			const row = pool[name]
			if (row === null || typeof row !== 'object') continue
			const used = num(row.usedPercent)
			if (used === undefined) continue
			const percent = Math.min(100, Math.max(0, 100 - used))
			windows.push({
				id: poolName === 'standard' ? name : `${poolName}-${name}`,
				label: `${poolName === 'standard' ? '标准' : 'Core'} · ${name === 'fiveHour' ? '5 小时' : name === 'weekly' ? '周额度' : '月度'}`,
				percent,
				remaining: percent,
				total: 100,
				used: 100 - percent,
				resetsAt: row.windowEnd ?? (num(row.secondsRemaining) === undefined ? '' : Date.now() + num(row.secondsRemaining) * 1000),
				expiresAt: '',
				unlimited: false,
				note: '',
			})
		}
	}
	return windows
}