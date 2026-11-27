/**
 * SiliconFlow — `GET /v1/user/info`，Bearer API Key。
 * @module dsh-balance-card/vendors/siliconflow
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
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 SILICONFLOW_API_KEY。')
	const body = await requestJson('https://api.siliconflow.cn/v1/user/info', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const data = body?.data !== null && typeof body?.data === 'object' ? body.data : body
	const remaining = num(data?.balance) ?? num(data?.totalBalance) ?? num(data?.amount)
	if (remaining === undefined) throw new VendorError('parse', 'SiliconFlow 用户信息缺少 balance。')
	return currencyReading({
		unit: '¥',
		remaining,
		windows: [{ id: 'balance', label: '账户余额', remaining }],
	})
}