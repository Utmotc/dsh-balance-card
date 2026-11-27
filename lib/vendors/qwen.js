/**
 * 千问 Qwen — 阿里云百炼没有稳定的额度接口。
 *
 * 设计上先保留「端点覆盖」入口：在厂商高级设置里填 `endpoint` + `jsonPath`，本
 * 适配器按自定义规则读取；没有端点时明确返回 `unsupported`，不猜、不伪造。
 * @module dsh-balance-card/vendors/qwen
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { currencyReading, num } from '../parse.js'
import { pathValue } from './custom.js'

/**
 * @param context - `{ credentials, settings, timeoutMs, signal }`。
 * @returns 读数。
 */
export async function query({ credentials, settings, timeoutMs, signal }) {
	const advanced = settings?.advanced ?? {}
	const endpoint = typeof advanced.endpoint === 'string' ? advanced.endpoint : ''
	if (endpoint === '') {
		throw new VendorError('unsupported', '千问控制台暂无稳定额度接口；可在高级设置填写端点覆盖。')
	}
	const headers = {}
	if (typeof credentials.cookie === 'string' && credentials.cookie !== '') headers.cookie = credentials.cookie
	if (typeof credentials.key === 'string' && credentials.key !== '') headers.authorization = `Bearer ${credentials.key}`
	const body = await requestJson(endpoint, {
		headers,
		timeoutMs,
		signal,
		allowPrivate: advanced.allowPrivate === true,
	})
	const path = typeof advanced.jsonPath === 'string' && advanced.jsonPath !== '' ? advanced.jsonPath : ''
	const raw = path === '' ? body : pathValue(body, path)
	const value = num(raw)
	if (value === undefined) throw new VendorError('parse', '千问端点没有返回数字。')
	const unit = typeof advanced.unit === 'string' && advanced.unit !== '' ? advanced.unit : '¥'
	return currencyReading({
		unit,
		remaining: value,
		windows: [{ id: 'balance', label: '余额', remaining: value }],
		note: '端点覆盖读取',
	})
}