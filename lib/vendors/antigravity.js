/**
 * Google Antigravity — 本机登录态的 access token。
 *
 * 请求 `v1internal:retrieveUserQuotaSummary`，把每个 bucket 的
 * `remainingFraction`（0–1）转成剩余百分比；没有 token 时明确「未配置」，
 * 不读取、不复制任何登录文件。
 * @module dsh-balance-card/vendors/antigravity
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading } from '../parse.js'

const ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const token = credentials.token
	if (typeof token !== 'string' || token === '') {
		throw new VendorError('unconfigured', '未配置 ANTIGRAVITY_TOKEN（本机登录态需手动粘贴）。')
	}
	const body = await requestJson(ENDPOINT, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'user-agent': 'antigravity/2.24.0 (windows; amd64)',
		},
		body: '{}',
		timeoutMs,
		signal,
	})
	const windows = parse(body)
	if (windows.length === 0) throw new VendorError('parse', 'Antigravity 没有返回可解析的配额组。')
	return percentReading({ windows, primary: windows[0].id, note: 'Antigravity 各模型独立额度。' })
}

/**
 * 解析 groups / models。
 * @param body - 响应。
 * @returns 窗口数组。
 */
function parse(body) {
	const groups = Array.isArray(body?.groups) ? body.groups : []
	const windows = []
	for (const [index, group] of groups.entries()) {
		if (group === null || typeof group !== 'object') continue
		const title = String(group.displayName ?? group.name ?? group.groupId ?? `group-${index}`)
		const buckets = Array.isArray(group.buckets) ? group.buckets : []
		for (const [bucketIndex, bucket] of buckets.entries()) {
			if (bucket === null || typeof bucket !== 'object') continue
			const fraction = fractionOf(bucket.remainingFraction ?? bucket.remaining_fraction)
			if (fraction === undefined) continue
			const percent = Math.min(100, Math.max(0, (1 - fraction) * 100))
			const id = `${slug(title)}-${bucketIndex}`
			windows.push({
				id,
				label: title,
				percent,
				remaining: percent,
				total: 100,
				used: 100 - percent,
				resetsAt: bucket.resetTime ?? bucket.reset_time ?? '',
				expiresAt: '',
				unlimited: false,
				note: '',
			})
		}
	}
	if (windows.length === 0 && body?.models !== null && typeof body?.models === 'object') {
		for (const [modelId, info] of Object.entries(body.models)) {
			if (!/gemini/iu.test(modelId)) continue
			const fraction = fractionOf(info?.quotaInfo?.remainingFraction ?? info?.quota_info?.remaining_fraction)
			if (fraction === undefined) continue
			const percent = Math.min(100, Math.max(0, (1 - fraction) * 100))
			windows.push({
				id: `gemini-${slug(modelId)}`,
				label: typeof info.displayName === 'string' ? info.displayName : modelId,
				percent,
				remaining: percent,
				total: 100,
				used: 100 - percent,
				resetsAt: info?.quotaInfo?.resetTime ?? '',
				expiresAt: '',
				unlimited: false,
				note: '',
			})
		}
	}
	return windows
}

/**
 * `remainingFraction` 可能是 0–1 数字或 `"72%"`；>1 的普通数字不猜方向。
 * @param value - 原始值。
 * @returns 0–1 份额或 undefined。
 */
function fractionOf(value) {
	if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (trimmed.endsWith('%')) {
			const parsed = num(trimmed.slice(0, -1))
			return parsed === undefined ? undefined : Math.min(1, Math.max(0, parsed / 100))
		}
	}
	return undefined
}

/** @param value - 文本。 @returns 小写 slug。 */
function slug(value) {
	return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'window'
}