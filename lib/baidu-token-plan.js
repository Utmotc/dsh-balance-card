/**
 * 百度千帆 Token Plan 个人版额度 — worked out from the vendor's console.
 *
 * Ported from `dsh-cost-meter` (`lib/baidu-token-plan.js` and
 * `docs/baidu-token-plan.md`), which established the contract against the
 * official personal-plan documentation and the console's public frontend:
 *
 *   GET /api/qianfan/charge/tokenPlanPersonal/resource
 *   success: true, the plan itself in `result.items`
 *
 * Two meters exist on that endpoint: `billingMode: "credit"` reads
 * `usedCredits` / `totalCredits`, and `"token"` reads `usedTokens` /
 * `totalTokens`. `expiresAt` is when the subscription ends — deliberately NOT a
 * monthly reset time — and `resourceStatus: "Released"` marks a dead plan.
 *
 * The credential is the console's own Cookie header, not the inference API key:
 * the key this profile uses to call Qianfan models cannot read billing at all.
 * The request is read-only; the cookie is only ever sent to this fixed official
 * endpoint, and redirects are refused so a stale login cannot bounce the cookie
 * somewhere else.
 */

/** Official console endpoint; fixed, never derived from a configured gateway. */
export const BAIDU_TOKEN_PLAN_URL =
	'https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource'

/** Console page a user signs in at to obtain a fresh Cookie. */
export const BAIDU_TOKEN_PLAN_CONSOLE_URL = 'https://console.bce.baidu.com/qianfan/resource/token-plan'

/**
 * Normalize a pasted Cookie header into the form this query sends.
 *
 * Rejects a value that is not a plausible `name=value; name=value` header
 * (a bare API key, a newline injection, an oversized blob), so a mis-pasted
 * credential fails with an explanation instead of a 302 the user cannot read.
 * @param value - the pasted credential.
 * @returns the header value, or null when it is not a Cookie.
 */
export function normalizeBaiduCookie(value) {
	if (typeof value !== 'string' || /[\r\n\x00-\x1f\x7f]/u.test(value) || value.length > 16384) return null
	const cookie = value.trim().replace(/^cookie:\s*/iu, '')
	const parts = cookie.split(';').filter((part) => part.trim())
	return parts.length > 0 &&
		parts.some((part) => /=\s*\S/u.test(part)) &&
		parts.every((part) => /^\s*[^=\s;]+=[^;]*$/u.test(part))
		? cookie
		: null
}

/** @param value - a console figure. @returns a finite non-negative number, or null. */
function number(value) {
	return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
		Number.isFinite(Number(value)) &&
		Number(value) >= 0
		? Number(value)
		: null
}

/**
 * Parse a console expiry timestamp into a Date.
 *
 * BCE console wall-clock timestamps carry no zone and are China Standard Time,
 * independent of the host's timezone, so a bare local time is pinned to +08:00.
 * @param value - the console's `expiresAt`.
 * @returns the Date, or null when absent/unparseable.
 */
function expiryOf(value) {
	if (typeof value !== 'string' || value.trim() === '') return null
	const date = new Date(
		/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/u.test(value)
			? `${value.replace(' ', 'T')}+08:00`
			: value,
	)
	return Number.isFinite(date.getTime()) ? date : null
}

/**
 * Read the console document into this package's quota shape.
 *
 * Skips released and expired plans, then reports the first active one still
 * carrying a usable meter. A plan whose figures are missing does not degrade to
 * zero — an absent total cannot be a percentage of anything, so it is skipped
 * as unusable.
 * @param data - decoded console response.
 * @param now - clock used to judge expiry, injectable for tests.
 * @returns the quota reading, or null when no usable active plan exists.
 */
export function parseBaiduTokenPlan(data, now = Date.now()) {
	if (data?.success !== true || !Array.isArray(data.result?.items)) return null
	for (const item of data.result.items) {
		if (item === null || typeof item !== 'object') continue
		if (item.resourceStatus === 'Released') continue
		const expiry = expiryOf(item.expiresAt)
		if (expiry !== null && expiry.getTime() <= now) continue
		if (!['credit', 'token', undefined].includes(item.billingMode)) continue
		const credit = item.billingMode === 'credit'
		const used = number(credit ? item.usedCredits : item.usedTokens)
		const total = number(credit ? item.totalCredits : item.totalTokens)
		if (used === null || total === null || total <= 0) continue
		const remaining = Math.max(0, total - used)
		const dim = { window: 'monthly', limit: total, used, remaining }
		// The plan's own name when the console states one (`planName` / `specName` /
		// `productName`), otherwise the surface this endpoint IS: Token Plan Personal.
		const named = [item.planName, item.specName, item.productName].find(
			(value) => typeof value === 'string' && value.trim() !== '',
		)
		return {
			queryable: true,
			kind: 'quota',
			// The unit id is decided by the console meter, never by the vendor's name:
			// credit plans count 积分 and token plans count tokens.
			unit: credit ? 'credits' : 'tokens',
			planLabel: named === undefined ? 'Token Plan · 个人版' : named.trim(),
			limit: total,
			used,
			remaining,
			dims: [dim],
			// Subscription expiry is not the monthly quota reset time; the client
			// words it as 套餐到期 instead of 重置时间.
			...(expiry === null ? {} : { expiresAt: expiry.toISOString() }),
		}
	}
	return null
}

/**
 * Whether a 200-status console document actually says the login is gone.
 *
 * The console answers an unauthenticated XHR either with a JSON envelope whose
 * `message.redirect` is set, or with an explicit 401/403 code inside a `success:
 * false` body; both mean "copy a fresh Cookie", not "this plan has no quota".
 * @param data - decoded console response.
 * @returns whether it is an authentication failure rather than a plan result.
 */
export function isBaiduLoginFailure(data) {
	if (data === null || typeof data !== 'object') return false
	if ([401, 403, '401', '403'].includes(data.code)) return true
	return data.message !== null && typeof data.message === 'object' && data.message.redirect === true
}