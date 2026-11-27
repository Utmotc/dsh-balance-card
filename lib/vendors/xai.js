/**
 * xAI — `GET /v1/dashboard/billing/credit_grants`，Bearer API Key。
 * @module dsh-balance-card/vendors/xai
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
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 XAI_API_KEY。')
	const body = await requestJson('https://api.x.ai/v1/dashboard/billing/credit_grants', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const remaining =
		num(body?.total_available) ??
		(num(body?.total_granted) !== undefined && num(body?.total_used) !== undefined
			? num(body.total_granted) - num(body.total_used)
			: undefined) ??
		num(body?.balance)
	if (remaining === undefined) throw new VendorError('parse', 'xAI 额度响应缺少可用余额。')
	return currencyReading({
		unit: '$',
		remaining,
		windows: [{ id: 'balance', label: 'Credit Grants', remaining }],
		note: 'API 额度，与 X Premium 订阅无关。',
	})
}