/**
 * StepFun — `GET /v1/accounts`，Bearer API Key。
 * @module dsh-balance-card/vendors/stepfun
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
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 STEPFUN_API_KEY。')
	const body = await requestJson('https://api.stepfun.com/v1/accounts', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const remaining = num(body?.balance)
	if (remaining === undefined) throw new VendorError('parse', 'StepFun 账户响应缺少 balance。')
	return currencyReading({
		unit: '¥',
		remaining,
		windows: [
			{
				id: 'balance',
				label: '账户余额',
				remaining,
				...(num(body?.total_cash_balance) === undefined ? {} : { note: '含现金与代金券' }),
			},
		],
	})
}