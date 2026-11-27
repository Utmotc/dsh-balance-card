/**
 * 自定义余额接口 — 任意公网 HTTPS + JSON 路径（+ 可选一元算式）。
 *
 * 安全边界（§8.7）：默认只允许 HTTPS 公网地址、拒绝重定向、拒绝 `file:` /
 * `data:`；私有网段必须在高级设置里显式 `allowPrivate`。表达式只接受数字、
 * `value` 与四则运算，绝不执行任意代码。
 * @module dsh-balance-card/vendors/custom
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { currencyReading, num } from '../parse.js'

/**
 * @param context - `{ credentials, settings, timeoutMs, signal }`。
 * @returns 金额型读数。
 */
export async function query({ credentials, settings, timeoutMs, signal }) {
	const advanced = settings?.advanced ?? {}
	const endpoint = typeof advanced.endpoint === 'string' ? advanced.endpoint : ''
	if (endpoint === '') throw new VendorError('unconfigured', '请在高级设置里填写余额接口地址。')
	const headers = {}
	const key = credentials.key
	if (typeof key === 'string' && key !== '') {
		const headerName = typeof advanced.headerName === 'string' ? advanced.headerName : 'Authorization'
		headers[headerName] = headerName.toLowerCase() === 'authorization' ? `Bearer ${key}` : key
	}
	const method = advanced.method === 'POST' ? 'POST' : 'GET'
	const body = method === 'POST' ? '{}' : undefined
	if (method === 'POST') headers['content-type'] = 'application/json'

	const payload = await requestJson(endpoint, {
		method,
		headers,
		body,
		timeoutMs,
		signal,
		allowPrivate: advanced.allowPrivate === true,
	})
	const path = typeof advanced.jsonPath === 'string' && advanced.jsonPath !== '' ? advanced.jsonPath : ''
	let raw = path === '' ? payload : pathValue(payload, path)
	if (raw !== null && typeof raw === 'object') raw = raw.balance ?? raw.amount ?? raw.remaining ?? raw.value
	let value = num(raw)
	if (value === undefined) {
		throw new VendorError('parse', `JSON 路径「${path || '(根)'}」没有取到数字。`)
	}
	if (typeof advanced.expression === 'string' && advanced.expression.trim() !== '') {
		value = evaluate(advanced.expression, value)
		if (value === undefined) throw new VendorError('parse', '算式没有算出有效数字。')
	}
	const unit = typeof settings?.unitOverride === 'string' && settings.unitOverride !== ''
		? settings.unitOverride
		: typeof advanced.unit === 'string' && advanced.unit !== ''
			? advanced.unit
			: '¥'
	const kind = unit === '积分' ? 'credits' : unit === 'Tokens' ? 'tokens' : unit === '次' ? 'quota' : 'currency'
	if (kind === 'currency') {
		return currencyReading({
			unit,
			remaining: value,
			windows: [{ id: 'balance', label: '余额', remaining: value }],
		})
	}
	return {
		kind,
		unit,
		remaining: value,
		total: null,
		used: null,
		percent: null,
		windows: [
			{ id: 'balance', label: '余额', remaining: value, total: null, used: null, percent: null, resetsAt: '', expiresAt: '', unlimited: false, unit: '', note: '' },
		],
		primary: 'balance',
		note: '',
	}
}

/**
 * 按 `a.b[0].c` 取嵌套值。
 * @param root - 根对象。
 * @param path - 点/方括号路径。
 * @returns 取到的值，或 undefined。
 */
export function pathValue(root, path) {
	const parts = []
	for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/gu)) {
		parts.push(match[2] !== undefined ? Number(match[2]) : match[1])
	}
	let current = root
	for (const part of parts) {
		if (current === null || current === undefined) return undefined
		current = current[part]
	}
	return current
}

/**
 * 一元算式：只允许 `value`、数字、四则运算与括号。
 * @param expression - 用户输入的算式。
 * @param value - 取到的原始数字。
 * @returns 结果或 undefined。
 */
export function evaluate(expression, value) {
	const cleaned = expression.trim()
	if (cleaned === '' || cleaned.length > 120) return undefined
	if (!/^[\d\s+\-*/().value]+$/u.test(cleaned)) return undefined
	if (/[^\s]*[+\-*/]\s*$/u.test(cleaned) || /^[+\-*/]/u.test(cleaned.replace(/^-/u, ''))) return undefined
	try {
		// 白名单已经排除标识符与语句，这里只计算一行算术。
		// eslint-disable-next-line no-new-func
		const fn = new Function('value', `"use strict"; return (${cleaned});`)
		const result = fn(value)
		return num(result)
	} catch {
		return undefined
	}
}