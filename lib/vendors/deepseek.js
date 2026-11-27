/**
 * DeepSeek — `GET /user/balance`，Bearer API Key。
 * @module dsh-balance-card/vendors/deepseek
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
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 DEEPSEEK_API_KEY。')
	const body = await requestJson('https://api.deepseek.com/user/balance', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
	const entry = infos.find((info) => info?.currency === 'CNY') ?? infos[0]
	const remaining = num(entry?.total_balance)
	if (remaining === undefined) throw new VendorError('parse', 'DeepSeek 余额响应缺少 total_balance。')
	const unit = entry?.currency === 'USD' ? '$' : '¥'
	return currencyReading({
		unit,
		remaining,
		windows: [{ id: 'balance', label: '账户余额', remaining }],
		note: body?.is_available === false ? '账户当前不可用' : '',
	})
}