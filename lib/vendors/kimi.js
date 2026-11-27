/**
 * Kimi / Moonshot。
 *
 * 先按订阅 Key 读 `api.kimi.com/coding/v1/usages`（5 小时 + 周窗口）；该接口对普通
 * API Key 返回 401/404，届时退回 `api.moonshot.cn/v1/users/me/balance` 读账户余额。
 * 两个接口都失败时保留更具体的那次失败原因。
 * @module dsh-balance-card/vendors/kimi
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { currencyReading, num, quotaReading, usedWindow } from '../parse.js'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 额度或金额读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const key = credentials.key
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 KIMI_API_KEY。')
	try {
		return await queryCodingPlan(key, timeoutMs, signal)
	} catch (error) {
		const fallbackable = ['unauthorized', 'forbidden', 'parse', 'no_reading', 'expired']
		if (!(error instanceof VendorError) || !fallbackable.includes(error.code)) throw error
		return await queryBalance(key, timeoutMs, signal)
	}
}

/**
 * 订阅配额。
 * @param key - API Key。
 * @param timeoutMs - 超时。
 * @param signal - 中止信号。
 * @returns 额度读数。
 */
async function queryCodingPlan(key, timeoutMs, signal) {
	const body = await requestJson('https://api.kimi.com/coding/v1/usages', {
		headers: { authorization: `Bearer ${key}`, 'user-agent': 'KimiCLI/1.6' },
		timeoutMs,
		signal,
	})
	const usage = body?.usage
	const limit = num(usage?.limit)
	const used = num(usage?.used)
	const remaining = num(usage?.remaining)
	if (limit === undefined || remaining === undefined) {
		throw new VendorError('parse', 'Kimi 订阅响应缺少 usage.remaining。')
	}
	const windows = [
		usedWindow({ id: 'weekly', label: '周额度', used, total: limit, resetsAt: usage?.resetTime }),
	]
	const detail = Array.isArray(body?.limits) ? body.limits[0]?.detail : undefined
	const hourLimit = num(detail?.limit)
	const hourRemaining = num(detail?.remaining)
	if (hourLimit !== undefined && hourRemaining !== undefined) {
		windows.push(
			usedWindow({
				id: 'hourly',
				label: '小时额度',
				total: hourLimit,
				used: num(detail?.used),
				resetsAt: detail?.resetTime,
			}),
		)
	}
	return quotaReading({
		kind: 'quota',
		unit: '次',
		windows,
		primary: 'weekly',
		note: 'Kimi Code 订阅额度',
	})
}

/**
 * PAYG 账户余额。
 * @param key - API Key。
 * @param timeoutMs - 超时。
 * @param signal - 中止信号。
 * @returns 金额读数。
 */
async function queryBalance(key, timeoutMs, signal) {
	const body = await requestJson('https://api.moonshot.cn/v1/users/me/balance', {
		headers: { authorization: `Bearer ${key}` },
		timeoutMs,
		signal,
	})
	const data = body?.data !== null && typeof body?.data === 'object' ? body.data : body
	const remaining = num(data?.available_balance) ?? num(data?.balance)
	if (remaining === undefined) throw new VendorError('parse', 'Moonshot 余额响应缺少 available_balance。')
	return currencyReading({
		unit: '¥',
		remaining,
		windows: [{ id: 'balance', label: '账户余额', remaining }],
	})
}