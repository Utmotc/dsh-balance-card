/**
 * 百度千帆 Token Plan — 控制台只读接口 + 控制台 Cookie。
 *
 * 解析仍复用 `lib/baidu-token-plan.js`（1.x 的实测契约），这里只把它返回的内部
 * 形状翻译成 2.0 的统一读数。
 * @module dsh-balance-card/vendors/baidu-qianfan
 */
import { BAIDU_TOKEN_PLAN_URL, isBaiduLoginFailure, parseBaiduTokenPlan } from '../baidu-token-plan.js'
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { quotaReading, round2 } from '../parse.js'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 积分 / Tokens 额度读数。
 */
export async function query({ credentials, timeoutMs, signal }) {
	const cookie = credentials.cookie
	if (typeof cookie !== 'string' || cookie === '') {
		throw new VendorError('unconfigured', '未配置 BAIDU_QIANFAN_COOKIE（需要控制台 Cookie）。')
	}
	const body = await requestJson(BAIDU_TOKEN_PLAN_URL, {
		headers: { cookie, 'x-requested-with': 'XMLHttpRequest' },
		timeoutMs,
		signal,
	})
	if (isBaiduLoginFailure(body)) throw new VendorError('expired', '百度智能云控制台登录已过期。')
	const plan = parseBaiduTokenPlan(body)
	if (plan === null) throw new VendorError('no_reading', '控制台没有返回可用的 Token Plan。')
	const unit = plan.unit === 'credits' ? '积分' : 'Tokens'
	const window = {
		id: 'monthly',
		label: plan.planLabel,
		remaining: round2(plan.remaining),
		total: round2(plan.limit),
		used: round2(plan.used),
		resetsAt: '',
		expiresAt: plan.expiresAt ?? '',
	}
	return quotaReading({
		kind: plan.unit === 'credits' ? 'credits' : 'tokens',
		unit,
		windows: [window],
		primary: 'monthly',
		note: plan.expiresAt === undefined ? '' : '套餐到期时间见展开面板',
	})
}

/**
 * 测试连接：返回归一化样例，不返回 Cookie。
 * @param cookie - 控制台 Cookie。
 * @param timeoutMs - 超时。
 * @returns `{ reachable, reading?, message? }`。
 */
export async function probe(cookie, timeoutMs) {
	try {
		const reading = await query({ credentials: { cookie }, timeoutMs })
		return { reachable: true, reading }
	} catch (error) {
		return { reachable: false, message: error instanceof Error ? error.message : String(error) }
	}
}