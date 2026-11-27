/**
 * dsh-balance-card 2.0 — 错误分类。
 *
 * 卡片只显示用户能行动的短句，展开面板显示状态码与建议。错误对象只带一个稳定
 * 的 code 与一条脱敏后的中文消息；原始响应、Cookie、Key、带查询串的 URL 都不
 * 进入消息（见 §8.6 / §8.7）。
 * @module dsh-balance-card/errors
 */

/** 错误码 → 用户文案。 */
export const ERROR_TEXT = {
	unconfigured: '未配置凭据',
	unauthorized: '认证失败（401）',
	expired: '登录已过期',
	forbidden: '无权访问（403）',
	rate_limited: '查询被限流（429）',
	network: '网络不可达',
	timeout: '请求超时',
	parse: '返回格式变化',
	unsupported: '暂不支持',
	no_reading: '接口返回空额度',
	blocked: '请求被安全策略拒绝',
	server: '服务端错误',
}

/** 错误码 → 修复建议。 */
export const ERROR_ADVICE = {
	unconfigured: '展开该厂商，粘贴并保存凭据。',
	unauthorized: '更换 API Key 或重新复制 Cookie。',
	expired: '重新登录控制台，复制完整 Cookie。',
	forbidden: '检查账号权限或套餐是否有效。',
	rate_limited: '稍后重试；插件会自动退避。',
	network: '检查代理与网络连接。',
	timeout: '稍后重试；接口可能较慢。',
	parse: '接口返回结构变化，保留上次读数并报告问题。',
	unsupported: '该厂商暂不支持。',
	no_reading: '检查套餐是否仍然有效。',
	blocked: '自定义接口只允许公网 HTTPS。',
	server: '厂商服务暂时不可用，稍后重试。',
}

/**
 * 一条带分类的读取失败。
 */
export class VendorError extends Error {
	/**
	 * @param code - `ERROR_TEXT` 的键。
	 * @param message - 脱敏后的补充说明，可为空。
	 * @param status - HTTP 状态码，若来自 HTTP。
	 */
	constructor(code, message = '', status) {
		super(message === '' ? ERROR_TEXT[code] ?? code : message)
		this.name = 'VendorError'
		this.code = code
		if (status !== undefined) this.status = status
	}
}

/**
 * 把任意抛出值归一成 `{ code, message, advice }`。
 * @param error - 抛出值。
 * @returns 脱敏后的错误描述。
 */
export function describeError(error) {
	if (error instanceof VendorError) {
		return {
			code: error.code,
			message: error.message,
			advice: ERROR_ADVICE[error.code] ?? '',
			...(error.status === undefined ? {} : { status: error.status }),
		}
	}
	if (error !== null && typeof error === 'object' && typeof error.code === 'string' && ERROR_TEXT[error.code]) {
		return {
			code: error.code,
			message: typeof error.message === 'string' ? error.message : ERROR_TEXT[error.code],
			advice: ERROR_ADVICE[error.code] ?? '',
		}
	}
	const name = error instanceof Error ? error.name : ''
	if (name === 'TimeoutError' || name === 'AbortError') {
		return { code: 'timeout', message: ERROR_TEXT.timeout, advice: ERROR_ADVICE.timeout }
	}
	return { code: 'network', message: '无法连接厂商接口。', advice: ERROR_ADVICE.network }
}

/**
 * 去除控制字符并截断，保证错误消息能安全放进 JSON/UI。
 * @param value - 原始文本。
 * @param max - 最大长度。
 * @returns 清洗后的文本。
 */
export function safeText(value, max = 240) {
	if (typeof value !== 'string') return ''
	// eslint-disable-next-line no-control-regex
	const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
	return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}