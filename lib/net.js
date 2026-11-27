/**
 * dsh-balance-card 2.0 — 受控 HTTP。
 *
 * 所有厂商请求都从这里发出，集中做四件事：
 * 1. 只发固定官方 origin（重定向一律 `error`，避免 302 把 Cookie 带到别的域）；
 * 2. 15 秒超时、1 MB 响应上限；
 * 3. 状态码 → 错误码的统一分类；
 * 4. 不记录请求头、Cookie、查询串。
 * @module dsh-balance-card/net
 */
import { VendorError, describeError, safeText } from './errors.js'

/** 默认超时。 */
export const DEFAULT_TIMEOUT_MS = 15_000
/** 响应体上限（字节）。 */
export const MAX_BODY_BYTES = 1_048_576

/**
 * 发送一次只读请求并解析 JSON。
 *
 * @param url - 完整的 HTTPS URL。
 * @param options - `{ method, headers, body, timeoutMs, allowPrivate, signal }`。
 * @returns 解析后的 JSON。
 * @throws VendorError - 分类后的失败。
 */
export async function requestJson(url, options = {}) {
	let parsed
	try {
		parsed = new URL(url)
	} catch {
		throw new VendorError('blocked', '接口地址不是合法 URL。')
	}
	if (parsed.protocol !== 'https:') {
		throw new VendorError('blocked', '自定义接口只允许 HTTPS。')
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new VendorError('blocked', '接口地址不允许内嵌账号密码。')
	}
	if (!options.allowPrivate && isPrivateHost(parsed.hostname)) {
		throw new VendorError('blocked', '接口地址指向私有网段；如确需使用请在高级设置中开启。')
	}

	const timeoutMs =
		typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
			? Math.min(60_000, Math.max(3_000, options.timeoutMs))
			: DEFAULT_TIMEOUT_MS
	const signal =
		options.signal === undefined ? AbortSignal.timeout(timeoutMs) : options.signal
	let response
	try {
		response = await fetch(parsed, {
			method: options.method === 'POST' ? 'POST' : 'GET',
			headers: {
				accept: 'application/json',
				'user-agent': 'dsh-balance-card/2.0 (DeepSeek Harness plugin)',
				...(options.headers ?? {}),
			},
			...(options.body === undefined ? {} : { body: options.body }),
			// 不跟随重定向：控制台登录过期会 302 到登录页，跟随就会把 Cookie 发给
			// 重定向目标。手动模式下我们只把 3xx 归类为「登录已过期」。
			redirect: 'manual',
			signal,
		})
	} catch (error) {
		if (error instanceof VendorError) throw error
		const name = error instanceof Error ? error.name : ''
		if (name === 'TimeoutError' || name === 'AbortError') throw new VendorError('timeout')
		throw new VendorError('network', `无法连接 ${parsed.host}。`)
	}

	if (response.status >= 300 && response.status < 400) {
		await discard(response)
		throw new VendorError('expired', '请求被重定向到登录页（Cookie 可能已过期）。', response.status)
	}
	if (response.status === 401) {
		await discard(response)
		throw new VendorError('unauthorized', '凭据被拒绝（401）。', 401)
	}
	if (response.status === 403) {
		await discard(response)
		throw new VendorError('forbidden', '账号无权读取该额度（403）。', 403)
	}
	if (response.status === 429) {
		await discard(response)
		throw new VendorError('rate_limited', '查询被限流（429）。', 429)
	}
	if (response.status >= 500) {
		await discard(response)
		throw new VendorError('server', `厂商接口返回 ${response.status}。`, response.status)
	}
	if (!response.ok) {
		await discard(response)
		// 401/403 已经在上方归为认证问题；其余 4xx 更像端点搬家或参数变化。
		// 这样多端点厂商（MiniMax / 智谱 / Kimi）还能继续尝试下一个官方地址。
		throw new VendorError('parse', `请求失败（HTTP ${response.status}），端点可能已变化。`, response.status)
	}

	const declared = Number(response.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		await discard(response)
		throw new VendorError('parse', '响应体超过 1 MB 上限。')
	}
	let textBody
	try {
		textBody = await response.text()
	} catch (error) {
		const name = error instanceof Error ? error.name : ''
		throw new VendorError(name === 'TimeoutError' ? 'timeout' : 'network', '读取响应体失败。')
	}
	if (textBody.length > MAX_BODY_BYTES) throw new VendorError('parse', '响应体超过 1 MB 上限。')
	try {
		return JSON.parse(textBody)
	} catch {
		// 控制台过期登录页通常是 HTML；这既不是网络错误，也不是可用的 JSON。
		if (/^\s*</u.test(textBody)) throw new VendorError('expired', '返回的是登录页而不是额度数据。')
		throw new VendorError('parse', '响应不是合法 JSON。')
	}
}

/**
 * 取消一个不再需要的响应体，避免连接悬挂。
 * @param response - fetch 响应。
 */
async function discard(response) {
	try {
		await response.body?.cancel?.()
	} catch {
		// 取消失败不影响结果。
	}
}

/**
 * 判断主机名是否属于内网/环回/链路本地。
 * @param hostname - URL 的 hostname。
 * @returns 是否私有。
 */
export function isPrivateHost(hostname) {
	const host = hostname.toLowerCase()
	if (host === 'localhost' || host.endsWith('.localhost')) return true
	if (host === '::1' || host === '[::1]') return true
	if (/^127\./u.test(host)) return true
	if (/^10\./u.test(host)) return true
	if (/^192\.168\./u.test(host)) return true
	if (/^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return true
	if (/^169\.254\./u.test(host)) return true
	if (host === '0.0.0.0') return true
	return false
}

/**
 * 把错误包成适配器可以直接返回的形状（保留 code 与建议）。
 * @param error - 抛出值。
 * @returns `describeError()` 的结果。
 */
export function failureOf(error) {
	return describeError(error)
}

/** 供适配器统一引用的安全文本。 */
export { safeText }