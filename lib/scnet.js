/**
 * SCNet（超算互联网）模型服务余额 —— 控制台契约。
 *
 * SCNet 没有 API-Key 鉴权的额度接口：Token Plan 的 Credits 与按量计费的现金
 * 余额都只在登录态的控制台业务接口里。两处数据源因此共用一份控制台 Cookie：
 *
 *   GET  /acx/charge/account/currentuser/tokenplan/list   Token Plan 订阅行
 *   POST /acx/charge/account/llmapi/balance               现金 / 赠送余额
 *
 * 控制台的响应信封是 `{ code: "0", msg: "success", data: … }`；未登录时是
 * `{ code: "401", msg: "用户未登录!", … }`，HTTP 也常常是 401。两条接口的字段
 * 名在控制台版本间变过（前端自己就按 7–9 个候选名取值），所以这里按候选链读取，
 * 只有整行都取不到数字时才放弃，绝不把缺失字段折成 0。
 *
 * 所有请求都只读、都发往固定的 `www.scnet.cn`，并且拒绝跟随重定向：登录过期时
 * 控制台会 302 到登录页，跟随会把 Cookie 重放到重定向指向的任意主机。
 *
 * Credits 与金额是两种单位：Token Plan 计 Credits，现金余额计人民币。调用方
 * （lib/index.js）把现金余额作为 `cash` 附在额度读数上，客户端据此分开措辞。
 */

/** 控制台来源；所有业务接口都挂在它的 `/acx` 前缀下。 */
export const SCNET_ORIGIN = 'https://www.scnet.cn'
/** 用户登录并复制 Cookie 的控制台页面。 */
export const SCNET_CONSOLE_URL = `${SCNET_ORIGIN}/ui/console/index.html#/llm/token-plan`
/** Token Plan 订阅列表（会话门）。 */
export const SCNET_TOKEN_PLAN_URL = `${SCNET_ORIGIN}/acx/charge/account/currentuser/tokenplan/list`
/** 模型服务现金 / 赠送余额（会话门，POST 一个空 JSON 对象）。 */
export const SCNET_BALANCE_URL = `${SCNET_ORIGIN}/acx/charge/account/llmapi/balance`
/** 凭据未配置时的说明：推理 API Key 不能代替控制台 Cookie。 */
export const SCNET_CREDENTIAL_MISSING =
	'凭据 SCNET_COOKIE 未配置，无法读取超算互联网余额（需要控制台 Cookie，推理 API Key 不能代替）。'
/** 登录失效时的说明。 */
export const SCNET_LOGIN_EXPIRED =
	'SCNet 控制台登录已失效，请重新登录 www.scnet.cn 后复制新的 Cookie，保存为 SCNET_COOKIE。'

/**
 * 控制台请求头：与前端 XHR 一致。
 *
 * `version` 与 `Referer` 只是让请求看起来像控制台自己的调用；它们不能代替
 * Cookie（实测不带 Cookie 仍然 401），所以这里不假装它们是鉴权。
 */
const CONSOLE_HEADERS = {
	accept: 'application/json',
	'x-requested-with': 'XMLHttpRequest',
	referer: `${SCNET_ORIGIN}/ui/console/`,
	version: '2.9.2',
}

/** Token Plan 总额的字段候选，按控制台前端自己的取值顺序排列。 */
const TOTAL_KEYS = [
	'totalAmount',
	'All',
	'all',
	'totalCredits',
	'monthlyCredits',
	'planCredits',
	'creditQuota',
	'quota',
	'limit',
	'total',
]
/** 已用 Credits 的字段候选。 */
const USED_KEYS = ['usedAmount', 'used', 'usedCredits', 'consumeCredits', 'consumedCredits', 'consume', 'usage']
/** 剩余 Credits 的字段候选；缺失时由 总额 - 已用 兜底。 */
const REMAIN_KEYS = ['remainingCredits', 'remainCredits', 'leftCredits', 'remaining', 'remain']
/** 套餐名候选。 */
const NAME_KEYS = ['name', 'resourceName', 'packageName', 'resourceId']
/** 生效时间候选。 */
const START_KEYS = ['minValidTime', 'startTime', 'validTime']
/** 到期时间候选；到期即套餐 Key 失效。 */
const END_KEYS = ['maxExpireTime', 'expireTime', 'endTime', 'validEndTime']
/** 重置时间候选；缺失时按官方口径取「到期时间的下一秒」。 */
const RESET_KEYS = ['resetTime', 'resetAt', 'nextResetTime', 'monthResetTime']
/** 现金余额候选。 */
const BALANCE_KEYS = ['balance', 'availableBalance', 'accountBalance', 'totalBalance', 'cashBalance']
/** 赠送余额候选。 */
const GIFT_KEYS = ['giftBalance', 'grantBalance', 'grantedBalance', 'presentBalance', 'couponBalance']
/** 现金（充值）余额候选。 */
const CASH_KEYS = ['cashBalance', 'rechargeBalance', 'topupBalance', 'rechargeAmount']

/** 登录态失效错误，供探测接口区分「换 Cookie」与「网络不通」。 */
export class ScnetAuthError extends Error {}

/**
 * 把一个粘贴来的 Cookie 头规范成请求里发送的形式。
 *
 * 与千帆同一个理由：裸 API Key、换行注入、超长内容都在这里拒绝，让误粘贴得到
 * 一句说明，而不是一个用户读不懂的 302。
 * @param value - 粘贴的凭据。
 * @returns 可发送的 Cookie 头，或 null（不是 Cookie）。
 */
export function normalizeScnetCookie(value) {
	if (typeof value !== 'string' || /[\r\n\x00-\x1f\x7f]/u.test(value) || value.length > 16384) return null
	const cookie = value.trim().replace(/^cookie:\s*/iu, '')
	const parts = cookie.split(';').filter((part) => part.trim())
	return parts.length > 0 &&
		parts.some((part) => /=\s*\S/u.test(part)) &&
		parts.every((part) => /^\s*[^=\s;]+=[^;]*$/u.test(part))
		? cookie
		: null
}

/**
 * 读一个数字，字符串小数（控制台的 `"15839.336"`）也算。
 * @param value - 任意字段值。
 * @returns 有限数字，或 undefined。
 */
function numeric(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

/**
 * 按候选链取第一个可读数字。
 * @param source - 一行记录。
 * @param keys - 字段候选。
 * @returns 数字，或 undefined。
 */
function pickNumber(source, keys) {
	if (source === null || typeof source !== 'object') return undefined
	for (const key of keys) {
		const value = numeric(source[key])
		if (value !== undefined) return value
	}
	return undefined
}

/**
 * 按候选链取第一个非空字符串。
 * @param source - 一行记录。
 * @param keys - 字段候选。
 * @returns 字符串，或 undefined。
 */
function pickText(source, keys) {
	if (source === null || typeof source !== 'object') return undefined
	for (const key of keys) {
		const value = source[key]
		if (typeof value === 'string' && value.trim() !== '') return value.trim()
	}
	return undefined
}

/**
 * 把控制台的时间读成 Date。
 *
 * 控制台的 `2026-11-18 23:59:59` 是北京时间、不带时区，所以这种裸墙上时间固定
 * 按 +08:00 解释，而不是宿主机时区。数字按秒 / 毫秒两种精度兼容。
 * @param value - 时间字段。
 * @returns Date，或 null。
 */
function timeOf(value) {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		const milliseconds = value < 1e12 ? value * 1000 : value
		const date = new Date(milliseconds)
		return Number.isFinite(date.getTime()) ? date : null
	}
	if (typeof value !== 'string' || value.trim() === '') return null
	const text = value.trim()
	const date = new Date(
		/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/u.test(text) ? `${text.replace(' ', 'T')}+08:00` : text,
	)
	return Number.isFinite(date.getTime()) ? date : null
}

/**
 * 列表信封解包：裸数组、`data`、`data.data`、`records`、`list`、`date` 都认。
 * @param body - 解码后的响应。
 * @returns 行数组；不是列表时为空数组。
 */
function rowsOf(body) {
	if (Array.isArray(body)) return body
	const data = body?.data ?? body?.result ?? body?.date
	if (Array.isArray(data)) return data
	if (data !== null && typeof data === 'object') {
		for (const key of ['data', 'records', 'list', 'rows', 'items']) {
			if (Array.isArray(data[key])) return data[key]
		}
	}
	return []
}

/**
 * 信封是否报错（`code` 不是成功码）。
 * @param body - 解码后的响应。
 * @returns 是否失败。
 */
function envelopeFailed(body) {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
	const code = body.code
	return code !== undefined && code !== null && String(code) !== '0'
}

/**
 * 控制台是否在 HTTP 200 的信封里说「未登录」。
 * @param body - 解码后的响应。
 * @returns 是否登录失效。
 */
export function isScnetLoginFailure(body) {
	if (body === null || typeof body !== 'object') return false
	if ([401, 403, '401', '403'].includes(body.code)) return true
	const message = body.msg ?? body.message
	return typeof message === 'string' && /未登录|登录已失效|重新登录|not\s*log|login\s*required/iu.test(message)
}

/**
 * 把一行订阅读成状态与本包的额度读数。
 * @param row - Token Plan 订阅行。
 * @param now - 判断过期的时钟，测试可注入。
 * @returns `{ reading, active }`，或 null（这行没有可用数字）。
 */
function planOfRow(row, now) {
	if (row === null || typeof row !== 'object') return null
	let total = pickNumber(row, TOTAL_KEYS)
	let used = pickNumber(row, USED_KEYS)
	let remaining = pickNumber(row, REMAIN_KEYS)
	// 三个数字至少要知其二，才够算出一个有意义的读数；只有总额的行是套餐目录，
	// 不是用户的用量。
	if (total === undefined) {
		if (used === undefined || remaining === undefined) return null
		total = used + remaining
	}
	if (remaining === undefined) {
		if (used === undefined) return null
		remaining = Math.max(0, total - used)
	}
	if (used === undefined) used = Math.max(0, total - remaining)
	if (!(total > 0)) return null
	remaining = Math.max(0, remaining)
	used = Math.max(0, used)
	const endAt = timeOf(row.maxExpireTime ?? row.expireTime ?? row.endTime ?? row.validEndTime)
	const startAt = timeOf(row.minValidTime ?? row.startTime ?? row.validTime)
	const resetAt =
		timeOf(row.resetTime ?? row.resetAt ?? row.nextResetTime ?? row.monthResetTime) ??
		(endAt === null ? null : new Date(endAt.getTime() + 1000))
	const status = typeof row.status === 'string' ? row.status.toLowerCase() : ''
	const expired = endAt !== null && endAt.getTime() <= now
	const reading = {
		queryable: true,
		kind: 'quota',
		unit: 'credits',
		planLabel: pickText(row, NAME_KEYS) ?? 'SCNet Token Plan',
		limit: total,
		used,
		remaining,
		dims: [
			{
				window: 'monthly',
				limit: total,
				used,
				remaining,
				...(resetAt === null ? {} : { resetTime: resetAt.toISOString() }),
			},
		],
		...(endAt === null ? {} : { expiresAt: endAt.toISOString() }),
		...(startAt === null ? {} : { startsAt: startAt.toISOString() }),
	}
	// `enable` 是控制台的生效态；`totalDays` 用尽的行属于订阅历史，不作为当前读数。
	const active = !expired && status !== 'disable' && (row.totalDays === undefined || numeric(row.totalDays) !== 0)
	return { reading, active }
}

/**
 * 解析 Token Plan 列表，挑出当前生效的一行。
 *
 * 生效行优先；同组里取到期最晚的一行（控制台自己的排序口径）。全部过期或没有
 * 数字时返回 null —— 调用方会退回只读现金余额，而不是编造一个 0。
 * @param body - 解码后的控制台响应。
 * @param now - 判断过期的时钟，测试可注入。
 * @returns 额度读数，或 null。
 */
export function parseScnetTokenPlan(body, now = Date.now()) {
	const candidates = rowsOf(body)
		.map((row) => planOfRow(row, now))
		.filter((entry) => entry !== null)
	if (candidates.length === 0) return null
	const active = candidates.filter((entry) => entry.active)
	const pool = active.length > 0 ? active : []
	if (pool.length === 0) return null
	const endOf = (entry) => {
		const at = entry.reading.expiresAt === undefined ? NaN : Date.parse(entry.reading.expiresAt)
		return Number.isFinite(at) ? at : 0
	}
	pool.sort((left, right) => endOf(right) - endOf(left))
	return pool[0].reading
}

/**
 * 从余额信封里取业务对象。
 *
 * 控制台的余额既可能直接放在 `data` 下，也可能再包一层（`data.data` /
 * `data.result` / `data.balanceInfo`）。这里只向下走有数字的那一层，走到没有
 * 数字可读为止，避免把信封外壳当成余额对象。
 * @param body - 解码后的响应。
 * @returns 余额对象，或 undefined。
 */
function balanceObject(body) {
	let data = body?.data ?? body?.result
	if (Array.isArray(data)) data = data.find((entry) => entry !== null && typeof entry === 'object')
	const hasMoney = (value) =>
		value !== null &&
		typeof value === 'object' &&
		[...BALANCE_KEYS, ...GIFT_KEYS, ...CASH_KEYS].some((key) => numeric(value[key]) !== undefined)
	for (let depth = 0; depth < 3; depth += 1) {
		if (data === null || typeof data !== 'object' || Array.isArray(data)) break
		if (hasMoney(data)) return data
		const wrapped = data.data ?? data.result ?? data.balanceInfo ?? data.account
		if (wrapped === null || typeof wrapped !== 'object' || Array.isArray(wrapped)) break
		data = wrapped
	}
	if (hasMoney(body)) return body
	return undefined
}

/**
 * 解析现金 / 赠送余额。
 *
 * 控制台的余额接口在不同页面下返回过不同字段名，所以按候选链取；`balance` 缺
 * 失但现金与赠送都在时，总额是两者之和。金额保留两位小数，负数（欠费）原样保留。
 * @param body - 解码后的控制台响应。
 * @returns `{ currency, balance, … }`，或 null。
 */
export function parseScnetBalance(body) {
	const money = (value) => Math.round(value * 100) / 100
	// Some console responses put the number itself in `data`.
	const direct = typeof body?.data === 'number' ? body.data : typeof body?.result === 'number' ? body.result : undefined
	if (direct !== undefined) return { currency: 'CNY', balance: money(direct) }
	const source = balanceObject(body)
	if (source === undefined) return null
	let balance = pickNumber(source, BALANCE_KEYS)
	const gift = pickNumber(source, GIFT_KEYS)
	const cash = pickNumber(source, CASH_KEYS)
	if (balance === undefined && cash !== undefined && gift !== undefined) balance = cash + gift
	if (balance === undefined && cash !== undefined) balance = cash
	if (balance === undefined) return null
	return {
		currency: 'CNY',
		balance: money(balance),
		...(cash === undefined ? {} : { toppedUp: money(cash) }),
		...(gift === undefined ? {} : { granted: money(gift) }),
	}
}

/**
 * 发一次只读控制台请求并解码。
 *
 * 重定向一律拒绝（见文件头）；401/403 与信封里的「未登录」都抛
 * {@link ScnetAuthError}，让调用方把它翻译成「换 Cookie」而不是「接口坏了」。
 * @param url - 固定控制台地址。
 * @param init - fetch 选项（方法、body）。
 * @param cookie - 控制台 Cookie 头。
 * @param timeoutMs - 单次超时。
 * @returns 解码后的 JSON。
 */
async function consoleJson(url, init, cookie, timeoutMs) {
	let response
	try {
		response = await fetch(url, {
			...init,
			headers: { ...CONSOLE_HEADERS, cookie, ...(init.headers ?? {}) },
			redirect: 'manual',
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		throw new Error(`${url} 请求失败：${error instanceof Error ? error.message : String(error)}`)
	}
	if (response.status >= 300 && response.status < 400) {
		try {
			await response.body?.cancel?.()
		} catch {
			// 已经消费过的 body 不值得盖过真正的原因。
		}
		throw new ScnetAuthError(SCNET_LOGIN_EXPIRED)
	}
	if (response.status === 401 || response.status === 403) {
		throw new ScnetAuthError(SCNET_LOGIN_EXPIRED)
	}
	if (!response.ok) throw new Error(`${url} 返回 HTTP ${String(response.status)}。`)
	let body
	try {
		body = await response.json()
	} catch {
		throw new Error(`${url} 返回的不是 JSON。`)
	}
	if (isScnetLoginFailure(body)) throw new ScnetAuthError(SCNET_LOGIN_EXPIRED)
	if (envelopeFailed(body)) throw new Error(`${url} 返回 code ${String(body.code)}：${String(body.msg ?? '')}`)
	return body
}

/**
 * 读一次完整的 SCNet 余额：Token Plan Credits + 现金余额。
 *
 * 返回一个本包的读数对象：有订阅时是 `kind: "quota"`（Credits），并把现金余额
 * 附在 `cash` 上；没有订阅、只有现金时是 `kind: "currency"`。两条接口各自的非
 * 鉴权失败不会让整个读数消失：另一条能读就照常返回，失败原因放在 `cashError` /
 * `planError` 里，由详情面板说明。
 * @param cookie - 控制台 Cookie 头。
 * @param timeoutMs - 单次请求超时。
 * @returns 读数；两条都读不到时抛错。
 */
export async function readScnetConsole(cookie, timeoutMs = 15000) {
	let plan = null
	let planError
	try {
		plan = parseScnetTokenPlan(
			await consoleJson(SCNET_TOKEN_PLAN_URL, { method: 'GET' }, cookie, timeoutMs),
		)
	} catch (error) {
		if (error instanceof ScnetAuthError) throw error
		planError = error instanceof Error ? error.message : String(error)
	}

	let cash = null
	let cashError
	try {
		cash = parseScnetBalance(
			await consoleJson(
				SCNET_BALANCE_URL,
				{ method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
				cookie,
				timeoutMs,
			),
		)
	} catch (error) {
		if (error instanceof ScnetAuthError) throw error
		cashError = error instanceof Error ? error.message : String(error)
	}

	if (plan !== null) {
		return {
			...plan,
			...(cash === null ? {} : { cash }),
			...(cashError === undefined ? {} : { cashError }),
			endpoint: SCNET_TOKEN_PLAN_URL,
		}
	}
	if (cash !== null) {
		return {
			queryable: true,
			kind: 'currency',
			...cash,
			// 没有订阅不是错误：控制台对未订阅账号就是空列表，详情面板据此说明。
			...(planError === undefined ? { planMissing: true } : { planError }),
			endpoint: SCNET_BALANCE_URL,
		}
	}
	throw new Error(
		`SCNet 余额读取失败：${[planError, cashError].filter((text) => text !== undefined).join('；') || '两条控制台接口都没有返回可用数字。'}`,
	)
}

/**
 * 只读探测一个 Cookie：给设置页的「测试连通」用。
 *
 * 成功时返回读数摘要（余额、Credits、到期），失败时只返回类别与说明：控制台
 * 的信封里可能回显会话信息，Cookie 本身则永远不出现在结果里。
 * @param cookie - 控制台 Cookie 头。
 * @param timeoutMs - 单次请求超时。
 * @returns 探测结果。
 */
export async function probeScnetCookie(cookie, timeoutMs = 15000) {
	try {
		const reading = await readScnetConsole(cookie, timeoutMs)
		return { reachable: true, reading }
	} catch (error) {
		return {
			reachable: false,
			reason: error instanceof ScnetAuthError ? 'cookie-expired' : 'unreachable',
			message: error instanceof Error ? error.message : String(error),
		}
	}
}
