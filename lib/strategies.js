/**
 * Provider strategies — vendored from dsh-model-balance.
 *
 * Upstream: `dsh-model-balance` v0.1.4, `src/host/strategies.ts`, MIT.
 * See LICENSE-dsh-model-balance in this package for the full notice.
 *
 * Six providers whose billing endpoints this package knows how to read. A
 * provider id is matched by canonical name, by alias, by a known endpoint host
 * in the configured base URL, or by an adapter prefix; the declarative
 * strategies in `providers.json` take part in the same lookup.
 *
 * Providers this cannot match are answered as `no-balance-api`, or as
 * `login-required` with a console URL when the vendor exposes billing only in
 * its web console.
 */
import { loadCustomProviders } from './parsers.js'

/**
 * DeepSeek's `/user/balance` document.
 * @param body - decoded response.
 * @returns one currency reading.
 */
function parseDeepSeek(body) {
	const infos = body?.balance_infos
	if (!Array.isArray(infos) || infos.length === 0) throw new Error('unexpected deepseek balance response')
	const entry = infos.find((info) => info?.currency === 'CNY') ?? infos[0]
	const balance = Number(entry?.total_balance)
	if (!Number.isFinite(balance)) throw new Error('deepseek balance is not numeric')
	return {
		queryable: true,
		kind: 'currency',
		currency: typeof entry.currency === 'string' ? entry.currency : 'CNY',
		balance,
		granted: Number(entry.granted_balance) || 0,
		toppedUp: Number(entry.topped_up_balance) || 0,
		available: body.is_available !== false,
	}
}

/**
 * StepFun's `/v1/accounts` document.
 * @param body - decoded response.
 * @returns one currency reading.
 */
function parseStepFun(body) {
	const balance = Number(body?.balance)
	if (!Number.isFinite(balance)) throw new Error('unexpected stepfun accounts response')
	return {
		queryable: true,
		kind: 'currency',
		currency: 'CNY',
		balance,
		cash: Number(body?.total_cash_balance) || 0,
		voucher: Number(body?.total_voucher_balance) || 0,
	}
}

/**
 * Kimi Coding's `/v1/usages` document: one weekly window, plus an hourly one when present.
 * @param body - decoded response.
 * @returns one quota reading with its windows.
 */
function parseKimiCoding(body) {
	const root = body ?? {}
	const usage = root.usage
	const limit = Number(usage?.limit)
	const used = Number(usage?.used)
	const remaining = Number(usage?.remaining)
	if (!Number.isFinite(limit) || !Number.isFinite(used) || !Number.isFinite(remaining)) {
		throw new Error('unexpected kimi usages response')
	}
	const dims = [
		{
			window: 'weekly',
			limit,
			used,
			remaining,
			...(typeof usage?.resetTime === 'string' ? { resetTime: usage.resetTime } : {}),
		},
	]
	const limits = root.limits
	if (Array.isArray(limits) && limits.length > 0) {
		const detail = limits[0]?.detail
		const hourLimit = Number(detail?.limit)
		const hourUsed = Number(detail?.used)
		const hourRemaining = Number(detail?.remaining)
		if (Number.isFinite(hourLimit) && Number.isFinite(hourUsed) && Number.isFinite(hourRemaining)) {
			dims.push({
				window: 'hourly',
				limit: hourLimit,
				used: hourUsed,
				remaining: hourRemaining,
				...(typeof detail?.resetTime === 'string' ? { resetTime: detail.resetTime } : {}),
			})
		}
	}
	return {
		queryable: true,
		kind: 'quota',
		unit: 'requests',
		limit,
		used,
		remaining,
		...(typeof usage?.resetTime === 'string' ? { resetTime: usage.resetTime } : {}),
		dims,
	}
}

/**
 * OpenRouter's `/api/v1/auth/key` document: a credit limit minus usage, in cents.
 * @param body - decoded response.
 * @returns one currency reading.
 */
function parseOpenRouter(body) {
	const data = body?.data
	if (!data) throw new Error('unexpected openrouter auth/key response')
	const limitCents = Number(data.limit)
	const usageCents = Number(data.usage)
	if (!Number.isFinite(limitCents)) throw new Error('openrouter limit is not numeric')
	return {
		queryable: true,
		kind: 'currency',
		currency: 'USD',
		balance: limitCents > 0 ? (limitCents - usageCents) / 100 : 0,
	}
}

/**
 * MiniMax's `/v1/token_plan/remains` document.
 * @param body - decoded response.
 * @returns one quota reading.
 */
function parseMiniMax(body) {
	const remaining = Number(body?.data ?? body?.remaining)
	const total = Number(body?.total ?? body?.limit)
	if (!Number.isFinite(remaining)) throw new Error('unexpected minimax remains response')
	return {
		queryable: true,
		kind: 'quota',
		unit: 'requests',
		limit: Number.isFinite(total) ? total : 0,
		used: Number.isFinite(total) ? total - remaining : 0,
		remaining,
	}
}

/**
 * xAI's credit-grants document.
 * @param body - decoded response.
 * @returns one currency reading.
 */
function parseXai(body) {
	const balance = Number(body?.balance ?? body?.total_granted)
	if (!Number.isFinite(balance)) throw new Error('unexpected xai credit response')
	return { queryable: true, kind: 'currency', currency: 'USD', balance }
}

/** The providers whose billing endpoints are known here. */
const STRATEGIES = {
	deepseek: {
		suffix: '/user/balance',
		defaultBaseURL: 'https://api.deepseek.com',
		defaultKeyEnv: 'DEEPSEEK_API_KEY',
		parse: parseDeepSeek,
		aliases: ['deepseek-official'],
	},
	stepfun: {
		suffix: '/accounts',
		defaultBaseURL: 'https://api.stepfun.com/v1',
		defaultKeyEnv: 'STEPFUN_API_KEY',
		parse: parseStepFun,
	},
	'kimi-coding': {
		suffix: '/v1/usages',
		defaultBaseURL: 'https://api.kimi.com/coding',
		defaultKeyEnv: 'KIMI_API_KEY',
		parse: parseKimiCoding,
	},
	openrouter: {
		suffix: '/api/v1/auth/key',
		defaultBaseURL: 'https://openrouter.ai',
		defaultKeyEnv: 'OPENROUTER_API_KEY',
		parse: parseOpenRouter,
	},
	minimax: {
		suffix: '/v1/token_plan/remains',
		defaultBaseURL: 'https://api.minimax.chat',
		defaultKeyEnv: 'MINIMAX_API_KEY',
		parse: parseMiniMax,
	},
	xai: {
		suffix: '/v1/dashboard/billing/credit_grants',
		defaultBaseURL: 'https://api.x.ai',
		defaultKeyEnv: 'XAI_API_KEY',
		parse: parseXai,
		aliases: ['grok'],
	},
}

/** Endpoint hosts that identify a provider when its id is unrecognized. */
const URL_MATCHERS = [
	[/api\.deepseek\.com/iu, 'deepseek'],
	[/api\.stepfun\.com/iu, 'stepfun'],
	[/platform\.stepfun\.com/iu, 'stepfun'],
	[/api\.kimi\.com/iu, 'kimi-coding'],
	[/openrouter\.ai/iu, 'openrouter'],
	[/api\.minimax\.chat/iu, 'minimax'],
	[/api\.x\.ai/iu, 'xai'],
]

/** Wrapper prefixes some deployments put in front of a provider id. */
const ADAPTER_PREFIXES = ['vision-toolkit-']

/** Providers that publish billing only in a web console. */
const LOGIN_REQUIRED_BY_ID = {
	'qwen-token-plan-cn': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
	'qwen-token-plan': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
	'qwen-coding-plan': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
	xiaomi: 'https://platform.xiaomimimo.com/console/balance',
}

/** Console URLs recognised from a configured base URL. */
const LOGIN_REQUIRED_URLS = [
	[
		/bailian\.console\.aliyun\.com|dashscope|aliyuncs\.com/iu,
		'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
	],
	[/xiaomimimo\.com/iu, 'https://platform.xiaomimimo.com/console/balance'],
]

/**
 * Merge the declarative strategies with the built-in ones.
 * @returns every strategy, the built-in parsers winning on a shared id.
 */
function getAllStrategies() {
	return { ...loadCustomProviders(), ...STRATEGIES }
}

/**
 * Index every strategy and alias by lower-case id.
 * @returns id (or alias) to canonical id.
 */
function buildKnownIds() {
	const map = new Map()
	for (const [canonical, strategy] of Object.entries(getAllStrategies())) {
		map.set(canonical.toLowerCase(), canonical)
		for (const alias of strategy.aliases ?? []) map.set(alias.toLowerCase(), canonical)
	}
	return map
}

/**
 * Resolve one provider id to an endpoint, a key name and a parser.
 * @param allStrategies - strategies to search.
 * @param allKnownIds - canonical-id index.
 * @param providerId - the id as requested.
 * @param configuredBaseURL - base URL from settings or config, when the user named one.
 * @param configuredKeyEnv - credential reference from settings or config, when named.
 * @returns the resolved strategy, or undefined.
 */
function resolveKnown(allStrategies, allKnownIds, providerId, configuredBaseURL, configuredKeyEnv) {
	const canonical = allKnownIds.get(providerId.toLowerCase())
	if (canonical === undefined) return undefined
	const strategy = allStrategies[canonical]
	if (strategy === undefined) return undefined
	return {
		url: `${stripSlash(configuredBaseURL ?? strategy.defaultBaseURL)}${strategy.suffix}`,
		keyEnv: configuredKeyEnv ?? strategy.defaultKeyEnv,
		canonical,
		parse: strategy.parse,
	}
}

/** @param url - endpoint base. @returns the base without trailing slashes. */
function stripSlash(url) {
	return url.replace(/\/+$/u, '')
}

/**
 * Match one provider id to its strategy.
 * @param providerId - the id as requested by the browser half.
 * @param configuredBaseURL - base URL override, when configured.
 * @param configuredKeyEnv - credential reference override, when configured.
 * @returns the strategy, or undefined when this provider has no known billing API.
 */
export function matchStrategy(providerId, configuredBaseURL, configuredKeyEnv) {
	const allStrategies = getAllStrategies()
	const allKnownIds = buildKnownIds()
	const exact = resolveKnown(allStrategies, allKnownIds, providerId, configuredBaseURL, configuredKeyEnv)
	if (exact !== undefined) return exact

	const lower = providerId.toLowerCase()
	for (const prefix of ADAPTER_PREFIXES) {
		if (!lower.startsWith(prefix)) continue
		const wrapped = resolveKnown(
			allStrategies,
			allKnownIds,
			providerId.slice(prefix.length),
			configuredBaseURL,
			configuredKeyEnv,
		)
		if (wrapped !== undefined) return wrapped
		break
	}

	if (configuredBaseURL !== undefined) {
		for (const [pattern, key] of URL_MATCHERS) {
			if (!pattern.test(configuredBaseURL)) continue
			const strategy = allStrategies[key]
			if (strategy === undefined) continue
			return {
				url: `${stripSlash(configuredBaseURL)}${strategy.suffix}`,
				keyEnv: configuredKeyEnv ?? strategy.defaultKeyEnv,
				canonical: key,
				parse: strategy.parse,
			}
		}
	}
	return undefined
}

/**
 * Find the console URL for providers that only publish billing on the web.
 * @param providerId - the id as requested.
 * @param configuredBaseURL - base URL override, when configured.
 * @returns the console URL, or undefined.
 */
export function matchLoginRequired(providerId, configuredBaseURL) {
	const byId = LOGIN_REQUIRED_BY_ID[providerId.toLowerCase()]
	if (byId !== undefined) return byId
	const lower = providerId.toLowerCase()
	for (const prefix of ADAPTER_PREFIXES) {
		if (!lower.startsWith(prefix)) continue
		const wrapped = LOGIN_REQUIRED_BY_ID[providerId.slice(prefix.length).toLowerCase()]
		if (wrapped !== undefined) return wrapped
		break
	}
	if (configuredBaseURL !== undefined) {
		for (const [pattern, url] of LOGIN_REQUIRED_URLS) {
			if (pattern.test(configuredBaseURL)) return url
		}
	}
	return undefined
}

export { STRATEGIES }
