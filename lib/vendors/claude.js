/**
 * Claude Pro / Max — Anthropic OAuth usage。
 *
 * `utilization` 是 0–100 的已用百分比；只保留主窗口（five_hour / seven_day），
 * 子模型窗口不展示，避免「7 天 3%」和「7 天 Sonnet 1%」同时出现。
 * @module dsh-balance-card/vendors/claude
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading } from '../parse.js'

const WINDOWS = [
	{ key: 'five_hour', id: 'five-hour', label: '5 小时' },
	{ key: 'seven_day', id: 'seven-day', label: '7 天' },
]

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const token = credentials.token
	if (typeof token !== 'string' || token === '') throw new VendorError('unconfigured', '未配置 ANTHROPIC_OAUTH_TOKEN。')
	const body = await requestJson('https://api.anthropic.com/api/oauth/usage', {
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'anthropic-beta': 'oauth-2025-04-20',
		},
		timeoutMs,
		signal,
	})
	const windows = []
	for (const entry of WINDOWS) {
		const window = body?.[entry.key]
		if (window === null || typeof window !== 'object') continue
		const used = num(window.utilization)
		if (used === undefined) continue
		const percent = Math.min(100, Math.max(0, 100 - used))
		windows.push({
			id: entry.id,
			label: entry.label,
			percent,
			remaining: percent,
			total: 100,
			used: 100 - percent,
			resetsAt: window.resets_at ?? '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	if (windows.length === 0) throw new VendorError('parse', 'Claude usage 没有返回可解析的窗口。')
	return percentReading({ windows, primary: 'five-hour', note: 'Claude Code OAuth 用量，接口非公开。' })
}