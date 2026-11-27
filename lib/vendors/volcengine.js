/**
 * 火山方舟 Coding Plan — 管控面 OpenAPI + AK/SK 的 HMAC-SHA256 签名。
 *
 * 只发 `GetCodingPlanUsage`（只读），不碰任何推理/对话端点。签名实现照官方
 * Node 示例：只对 host / x-content-sha256 / x-date 三个头加签。
 * @module dsh-balance-card/vendors/volcengine
 */
import { createHash, createHmac } from 'node:crypto'
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading } from '../parse.js'

const HOST = 'open.volcengineapi.com'
const REGION = 'cn-beijing'
const SERVICE = 'ark'
const VERSION = '2024-01-01'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const accessKeyId = credentials.accessKeyId
	const secretAccessKey = credentials.secretAccessKey
	if (typeof accessKeyId !== 'string' || accessKeyId === '' || typeof secretAccessKey !== 'string' || secretAccessKey === '') {
		throw new VendorError('unconfigured', '未配置 VOLC_ACCESSKEY / VOLC_SECRETKEY。')
	}
	const query = { Action: 'GetCodingPlanUsage', Version: VERSION }
	const url = `https://${HOST}/?${new URLSearchParams(query).toString()}`
	const signed = sign({ accessKeyId, secretAccessKey, method: 'GET', query })
	const body = await requestJson(url, {
		headers: {
			host: HOST,
			'x-date': signed['X-Date'],
			'x-content-sha256': signed['X-Content-Sha256'],
			authorization: signed.Authorization,
			accept: 'application/json',
		},
		timeoutMs,
		signal,
	})
	const windows = parse(body)
	if (windows.length === 0) throw new VendorError('parse', '火山方舟没有返回可解析的额度窗口。')
	return percentReading({ windows, primary: windows[0].id })
}

/**
 * 生成签名头。
 * @param input - `{ accessKeyId, secretAccessKey, method, query, datetime }`。
 * @returns 签名头。
 */
export function sign(input) {
	const xDate = input.datetime ?? new Date().toISOString().replace(/[:-]|\.\d{3}/gu, '')
	const date = xDate.slice(0, 8)
	const bodyHash = hashHex('')
	const signedHeaders = 'host;x-content-sha256;x-date'
	const canonicalHeaders = `host:${HOST}\nx-content-sha256:${bodyHash}\nx-date:${xDate}`
	const queryString = Object.keys(input.query)
		.sort()
		.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(input.query[key]))}`)
		.join('&')
	const canonicalRequest = [input.method.toUpperCase(), '/', queryString, `${canonicalHeaders}\n`, signedHeaders, bodyHash].join('\n')
	const scope = [date, REGION, SERVICE, 'request'].join('/')
	const stringToSign = ['HMAC-SHA256', xDate, scope, hashHex(canonicalRequest)].join('\n')
	const kDate = hmac(input.secretAccessKey, date)
	const kRegion = hmac(kDate, REGION)
	const kService = hmac(kRegion, SERVICE)
	const kSigning = hmac(kService, 'request')
	const signature = hmac(kSigning, stringToSign).toString('hex')
	return {
		'X-Date': xDate,
		'X-Content-Sha256': bodyHash,
		Authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	}
}

/** @param key - HMAC 键。 @param data - 数据。 @returns 摘要。 */
function hmac(key, data) {
	return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** @param data - 数据。 @returns sha256 十六进制。 */
function hashHex(data) {
	return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * 解析 `Result.QuotaUsage` / `Result.UsageDetails`。
 * @param body - 响应。
 * @returns 窗口数组。
 */
function parse(body) {
	const result =
		body?.Result ??
		body?.result ??
		body?.data?.Result ??
		body?.data?.result ??
		body?.data ??
		{}
	const quotaList = Array.isArray(result?.QuotaUsage)
		? result.QuotaUsage
		: Array.isArray(result?.UsageDetails)
			? result.UsageDetails
			: Array.isArray(result?.quotaUsage)
				? result.quotaUsage
				: []
	const windows = []
	for (const row of quotaList) {
		if (row === null || typeof row !== 'object') continue
		const name = String(row.Level ?? row.level ?? row.QuotaType ?? row.quotaType ?? row.Name ?? row.name ?? '').toLowerCase()
		let id
		let label
		if (name.includes('session') || name.includes('5h') || name.includes('five')) {
			id = 'five-hour'
			label = '5 小时'
		} else if (name.includes('week') || name.includes('7d')) {
			id = 'weekly'
			label = '周额度'
		} else if (name.includes('month') || name.includes('30d')) {
			id = 'monthly'
			label = '月度'
		} else {
			continue
		}
		const total = num(row.Cap ?? row.Total ?? row.total)
		const used = num(row.Used ?? row.used)
		const remaining = num(row.Remaining ?? row.remaining)
		let percent = num(row.Percent ?? row.percent)
		if (percent !== undefined) percent = 100 - percent
		else if (total !== undefined && total > 0) {
			percent = remaining !== undefined ? (remaining / total) * 100 : used !== undefined ? ((total - used) / total) * 100 : undefined
		}
		if (percent === undefined) continue
		windows.push({
			id,
			label,
			percent: Math.min(100, Math.max(0, percent)),
			remaining: Math.min(100, Math.max(0, percent)),
			total: 100,
			used: 100 - Math.min(100, Math.max(0, percent)),
			resetsAt: row.ResetTimestamp ?? row.ResetTime ?? row.resetTime ?? '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	return windows
}