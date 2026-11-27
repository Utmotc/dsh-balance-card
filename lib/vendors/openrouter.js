/**
 * OpenRouter — 先读 `/api/v1/auth/key`（Key 的额度与用量），无上限时读
 * `/api/v1/credits`（账户总充值/用量）。
 * @module dsh-balance-card/vendors/openrouter
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { currencyReading, num } from '../parse.js'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 金额型读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const key = credentials.key
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 OPENROUTER_API_KEY。')
	const auth = await requestJson('https://openrouter.ai/api/v1/auth/key', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const data = auth?.data !== null && typeof auth?.data === 'object' ? auth.data : auth
	const limitCents = num(data?.limit)
	const usageCents = num(data?.usage) ?? 0
	if (limitCents !== undefined && limitCents > 0) {
		const total = Math.round(limitCents) / 100
		const used = Math.round(usageCents) / 100
		return currencyReading({
			unit: '$',
			remaining: total - used,
			total,
			used,
			windows: [{ id: 'credits', label: 'Key 额度', remaining: total - used, total, used }],
		})
	}

	const credits = await requestJson('https://openrouter.ai/api/v1/credits', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const root = credits?.data !== null && typeof credits?.data === 'object' ? credits.data : credits
	const total = num(root?.total_credits)
	const used = num(root?.total_usage)
	if (total === undefined) throw new VendorError('parse', 'OpenRouter credits 响应缺少 total_credits。')
	return currencyReading({
		unit: '$',
		remaining: total - (used ?? 0),
		total,
		used: used ?? 0,
		windows: [{ id: 'credits', label: '账户 Credits', remaining: total - (used ?? 0), total, used: used ?? 0 }],
	})
}