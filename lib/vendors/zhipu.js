/**
 * 智谱 GLM / Z.ai Coding Plan — Coding Plan Key。
 *
 * 2026-08 起额度查询在监控端点 `/api/monitor/usage/quota/limit`；国内 Key 对应
 * `bigmodel.cn`，国际 Key 对应 `z.ai`，两域 Key 不互通，按顺序尝试。返回的
 * `percentage` 是 0–100 的已用百分比，这里统一转成剩余。
 * @module dsh-balance-card/vendors/zhipu
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading, remainingFromUsed } from '../parse.js'

const ENDPOINTS = [
	'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
	'https://api.z.ai/api/monitor/usage/quota/limit',
]

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const key = credentials.key
	if (typeof key !== 'string' || key === '') throw new VendorError('unconfigured', '未配置 ZAI_API_KEY / BIGMODEL_API_KEY。')
	let last
	for (const endpoint of ENDPOINTS) {
		try {
			const body = await requestJson(endpoint, {
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				timeoutMs,
				signal,
			})
			const windows = parse(body)
			if (windows.length > 0) return percentReading({ windows, primary: windows[0].id })
			last = new VendorError('no_reading', '智谱监控端点没有返回 Token 窗口。')
		} catch (error) {
			last = error
			if (error instanceof VendorError && error.code === 'rate_limited') break
		}
	}
	throw last ?? new VendorError('no_reading')
}

/**
 * 解析 limits 数组。
 * @param body - 响应。
 * @returns 窗口数组（百分比为剩余）。
 */
function parse(body) {
	const limits = Array.isArray(body?.data?.limits) ? body.data.limits : Array.isArray(body?.limits) ? body.limits : []
	const windows = []
	for (const limit of limits) {
		if (limit === null || typeof limit !== 'object') continue
		if (limit.type !== 'TOKENS_LIMIT' && limit.type !== 'CREDIT_LIMIT') continue
		const total = num(limit.usage)
		const used = num(limit.currentValue)
		const remaining = num(limit.remaining)
		let usedPercent = num(limit.percentage)
		if (usedPercent === undefined && total !== undefined && total > 0) {
			usedPercent = used !== undefined ? (used / total) * 100 : remaining !== undefined ? ((total - remaining) / total) * 100 : undefined
		}
		if (usedPercent === undefined) continue
		const remainingPercent = remainingFromUsed(usedPercent)
		if (remainingPercent === undefined) continue
		const unit = num(limit.unit)
		const id = unit === 6 ? 'weekly' : unit === 3 ? 'five-hour' : windows.length === 0 ? 'five-hour' : 'weekly'
		windows.push({
			id,
			label: id === 'weekly' ? '周额度' : '5 小时',
			percent: remainingPercent,
			remaining: remainingPercent,
			total: 100,
			used: 100 - remainingPercent,
			resetsAt: limit.nextResetTime ?? '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	return windows
}