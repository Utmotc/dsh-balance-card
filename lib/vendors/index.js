/**
 * 厂商适配器注册表。
 *
 * 每家一个纯读取函数（`query({ credentials, settings, timeoutMs, signal })`），
 * 返回 `parse.js` 的统一读数或抛 `VendorError`。新增一家厂商只需要在这里加一个
 * import + 一行映射，UI 与缓存都不需要改。
 * @module dsh-balance-card/vendors
 */
import { VendorError, describeError } from '../errors.js'
import * as antigravity from './antigravity.js'
import * as baiduQianfan from './baidu-qianfan.js'
import * as chatgpt from './chatgpt.js'
import * as claude from './claude.js'
import * as clinepass from './clinepass.js'
import * as commandcode from './commandcode.js'
import * as custom from './custom.js'
import * as deepseek from './deepseek.js'
import * as factory from './factory.js'
import * as kimi from './kimi.js'
import * as mimo from './mimo.js'
import * as minimax from './minimax.js'
import * as opendesign from './opendesign.js'
import * as openrouter from './openrouter.js'
import * as qwen from './qwen.js'
import * as scnet from './scnet.js'
import * as siliconflow from './siliconflow.js'
import * as stepfun from './stepfun.js'
import * as volcengine from './volcengine.js'
import * as xai from './xai.js'
import * as zhipu from './zhipu.js'

/** adapter id → 模块。 */
export const ADAPTERS = {
	antigravity,
	'baidu-qianfan': baiduQianfan,
	chatgpt,
	claude,
	clinepass,
	commandcode,
	custom,
	deepseek,
	factory,
	kimi,
	mimo,
	minimax,
	opendesign,
	openrouter,
	qwen,
	scnet,
	siliconflow,
	stepfun,
	volcengine,
	xai,
	zhipu,
}

/**
 * 读一家厂商。
 * @param vendor - 注册表条目。
 * @param context - `{ credentials, settings, timeoutMs, signal }`。
 * @returns 归一化读数。
 */
export async function queryVendor(vendor, context) {
	const adapter = vendor?.adapter === null || vendor?.adapter === undefined ? undefined : ADAPTERS[vendor.adapter]
	if (adapter === undefined || typeof adapter.query !== 'function') {
		throw new VendorError('unsupported', `${vendor?.label ?? '该厂商'}暂不支持。`)
	}
	return adapter.query(context)
}

/**
 * 用「未保存的输入值」测试一家厂商：把输入覆盖到凭据包上，发一次只读查询。
 * @param vendor - 注册表条目。
 * @param context - 已解析的凭据包 + 设置。
 * @param overrides - `{ field: value }`，来自设置页输入框。
 * @returns `{ reachable, reading?, error? }`。
 */
export async function probeVendor(vendor, context, overrides = {}) {
	const adapter = vendor?.adapter === null || vendor?.adapter === undefined ? undefined : ADAPTERS[vendor.adapter]
	if (adapter === undefined) {
		return { reachable: false, error: { code: 'unsupported', message: '该厂商暂不支持。' } }
	}
	const credentials = { ...context.credentials, ...overrides }
	try {
		const reading = await adapter.query({ ...context, credentials })
		return { reachable: true, reading }
	} catch (error) {
		return { reachable: false, error: describeError(error) }
	}
}