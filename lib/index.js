/**
 * dsh-plugin-balance — host half.
 *
 * Registers one authenticated exact Fetch route on Connection's shared API
 * channel:
 *
 *   GET /api/dsh.balance?provider=<id>[&refresh=1]
 *
 * It answers the browser half's only question — what does this provider have
 * left? — for every provider whose billing endpoint this package knows:
 * DeepSeek, StepFun, Kimi Coding, OpenRouter, MiniMax and xAI, plus anything
 * declared in `providers.json` (see lib/parsers.js).
 *
 * ## WorkBuddy is answered by the plugin that owns it
 *
 * The `workbuddy` and `workbuddy-ai` routes are not billed by an upstream
 * endpoint this package could call with an API key: their remaining credit
 * belongs to the WorkBuddy desktop sign-in, which `dsh-workbuddy-connect` owns.
 * That plugin already publishes the number on its own loopback status route, so
 * this half reads it from there (see `queryWorkBuddy`) rather than inventing an
 * endpoint, and normalizes it into this package's own reading shape. Nothing
 * about WorkBuddy is duplicated: when that plugin is absent, unreachable, or
 * signed out, the reading degrades and says which of those it was.
 *
 * The provider strategies are vendored from the MIT-licensed dsh-model-balance
 * (see LICENSE-dsh-model-balance); the transport is this package's own, so the
 * answer sits behind Connection's authentication fence rather than on an
 * unauthenticated webServer route. API keys are resolved per request from the
 * credentials seam and never reach the browser.
 *
 * 密钥始终只存在于宿主进程；浏览器半边只拿到"读数"。
 *
 * ## Portability (why this half imports nothing from dsh)
 *
 * A third-party plugin lands in a profile whose package manager may use a strict
 * layout, where an undeclared import of a dsh package fails to resolve. So this
 * half imports **only node builtins and its own modules**: every dsh capability
 * arrives through the context (`credentials`, `connection`, `settings`), which is
 * what the other published dsh plugins do too.
 *
 * ## Boot safety (why inject is empty)
 *
 * `inject` is read as a hard requirement, so a dsh that renamed `credentials` or
 * `connection` would leave this row pending. Nothing is required here: the route
 * is registered from a child fiber started by `ctx.inject`, which waits for
 * those services without holding this row's own activation back.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { matchLoginRequired, matchStrategy } from './strategies.js'

/** Authenticated exact route the browser half reads. */
const ROUTE_PATH = '/api/dsh.balance'
/** Provider answered when a request names none. */
const DEFAULT_PROVIDER = 'deepseek'
/** Credential reference resolved per request for the DeepSeek route. */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** Official DeepSeek endpoint; a gateway can be named instead. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** Per-request timeout against the provider. */
const DEFAULT_TIMEOUT_MS = 15000
/** Shortest gap between two upstream reads of one provider. */
const DEFAULT_MIN_INTERVAL_MS = 2000
/** How long a successful reading is served without asking the provider again. */
const DEFAULT_OK_TTL_MS = 60000
/** How long a failed reading is reused before asking the provider again. */
const DEFAULT_ERROR_TTL_MS = 15000
/**
 * Provider routes whose remaining allowance is published by another plugin.
 *
 * Each entry names the plugin-owned, read-only, loopback-only status route to
 * re-read and the unit that route's figures are denominated in. The `shape`
 * picks the normalizer, because the two plugins do NOT agree on what `total`
 * means — see `normalizeWorkBuddyCredits` / `normalizeQoderCredits`.
 */
const CREDIT_SOURCES = {
	workbuddy: {
		path: '/plugins/dsh-workbuddy-connect/status',
		shape: 'workbuddy',
		unit: 'credits',
		sourceName: 'WorkBuddy',
	},
	'workbuddy-ai': {
		path: '/plugins/dsh-workbuddy-connect/ai/status',
		shape: 'workbuddy',
		unit: 'credits',
		sourceName: 'WorkBuddy AI',
	},
	qoder: {
		path: '/plugins/dsh-qoder-connect/status',
		shape: 'qoder',
		unit: 'credits',
		sourceName: 'Qoder',
	},
	'qoder-global': {
		path: '/plugins/dsh-qoder-connect/global/status',
		shape: 'qoder',
		unit: 'credits',
		sourceName: 'Qoder Global',
	},
}
/**
 * Hostnames a local status read may be addressed to.
 *
 * The balance route deliberately reuses the origin the browser already used, so
 * a reverse-proxied deployment keeps working; the loopback check is what stops a
 * foreign `Host` header from turning this reader into a request forger.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Authenticated route the browser half reads and writes its settings through. */
const SETTINGS_PATH = '/api/dsh.balance.settings'
/** Settings file name, under the plugin's own directory in the profile. */
const SETTINGS_FILE = 'balance-settings.json'
/**
 * Every user-facing setting, with the value used when the file (or one field in
 * it) is absent. Kept as one table so validation, reading and writing cannot
 * drift apart: a field is only ever accepted if it appears here.
 */
const SETTINGS_DEFAULTS = {
	/**
	 * Where the readout is drawn, or `none` to draw it nowhere.
	 *
	 * One control rather than one flag per surface: two independent switches can
	 * express "both off" and "both on" as if they were the same kind of choice,
	 * and the sidebar card and the composer pill are alternatives a reader picks
	 * between. `none` is the "hide it without disabling the plugin" case — the
	 * plugin keeps its settings and its routes, and simply renders nothing.
	 */
	placement: 'sidebar',
	/** Poll interval, in milliseconds. */
	pollMs: 60000,
	/** Below this remaining share the bar and percentage turn red. */
	warnPercent: 20,
	/** Whether the card's top row carries the last-updated time. */
	showUpdatedAt: true,
	/** How the unit is written beside a figure: `symbol`, `name`, or `none`. */
	unitStyle: 'symbol',
	/** Whether figures are grouped with thousands separators. */
	groupDigits: true,
	/** Whether the sidebar card draws its hairline stroke. */
	cardBorder: true,
}
/** Accepted values for the enumerated settings. */
const SETTINGS_ENUMS = {
	placement: ['sidebar', 'composer', 'both', 'none'],
	unitStyle: ['symbol', 'name', 'none'],
}
/** Lower/upper bounds for the numeric settings, inclusive. */
const SETTINGS_BOUNDS = {
	pollMs: [15000, 3600000],
	warnPercent: [0, 100],
}
/**
 * Field order used when seeding the settings file, so the on-disk document has
 * a stable, readable layout rather than whatever order the first patch used.
 */
const SETTINGS_ORDER = ['placement', 'pollMs', 'warnPercent', 'showUpdatedAt', 'unitStyle', 'groupDigits', 'cardBorder']

export const name = 'balance-monitor'

/** Nothing is required; see "Boot safety" above. */
export const inject = []

/**
 * Read one row configuration into the numbers this half uses.
 *
 * There is deliberately no schema export: a schema would mean importing
 * schemastery, and every value below already has a safe default. A typo
 * therefore costs a default rather than a failed activation.
 * @param raw - the row's `config`, as the loader passed it.
 * @returns resolved settings.
 */
function resolveConfig(raw) {
	const config = raw === null || typeof raw !== 'object' ? {} : raw
	const number = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
	const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
	return {
		apiKeyEnv: text(config.apiKeyEnv, DEFAULT_API_KEY_ENV),
		baseURL: text(config.baseURL, ''),
		timeoutMs: number(config.timeoutMs, DEFAULT_TIMEOUT_MS),
		minIntervalMs: number(config.minIntervalMs, DEFAULT_MIN_INTERVAL_MS),
		okTtlMs: number(config.okTtlMs, DEFAULT_OK_TTL_MS),
		errorTtlMs: number(config.errorTtlMs, DEFAULT_ERROR_TTL_MS),
		defaultProvider: text(config.defaultProvider, DEFAULT_PROVIDER),
		settingsFile: typeof config.settingsFile === 'string' ? config.settingsFile : '',
	}
}

/**
 * Describe a thrown value without leaking anything but its message.
 * @param error - rejection or thrown value.
 * @returns a short human-readable reason.
 */
function reasonOf(error) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * The hostname inside one `Host`/authority value, port and IPv6 brackets aside.
 * @param authority - a `host[:port]` value, possibly `[::1]:3080`.
 * @returns the lower-cased hostname.
 */
function hostnameOfAuthority(authority) {
	const value = authority.trim().toLowerCase()
	if (value.startsWith('[')) {
		const end = value.indexOf(']')
		return end === -1 ? value : value.slice(0, end + 1)
	}
	const colon = value.lastIndexOf(':')
	if (colon === -1 || value.slice(0, colon).includes(':')) return value
	return /^\d+$/u.test(value.slice(colon + 1)) ? value.slice(0, colon) : value
}

/**
 * The loopback origins from which this process's own web routes can be read.
 *
 * The WorkBuddy status route only answers a loopback `Host`, and this process is
 * the one serving it, so the authority is assembled from two facts the host
 * already holds: the web server's listening port (correct even when the browser
 * reached this route through a proxy, or on a port the OS assigned), and the
 * `Host` header the browser used (correct when the web server service itself is
 * unavailable). An origin that is not loopback is never produced, so this
 * cannot be turned into a request forgery against a foreign host.
 * @param request - the authenticated `/api` request being answered.
 * @param webServer - the optional web server service, for its listening port.
 * @returns the candidate origins, most trustworthy first; possibly empty.
 */
function loopbackOrigins(request, webServer) {
	const origins = []
	const port = webServer?.port
	if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
		origins.push(`http://127.0.0.1:${String(port)}`)
	}
	let header
	try {
		header = request?.headers?.get?.('host')
	} catch {
		header = undefined
	}
	if (typeof header === 'string' && header.trim() !== '') {
		const authority = header.trim().toLowerCase()
		if (LOOPBACK_HOSTS.has(hostnameOfAuthority(authority))) origins.push(`http://${authority}`)
	}
	return origins
}

/**
 * Read one package row into this package's common account shape.
 *
 * A row without a numeric `remain` is dropped rather than folded in as a zero:
 * a fabricated zero is a wrong number, where a missing row is just missing.
 * @param raw - one source row.
 * @returns the normalized account, or undefined when it carries no figure.
 */
function normalizeAccount(raw) {
	if (raw === null || typeof raw !== 'object') return undefined
	const remain = typeof raw.remain === 'number' && Number.isFinite(raw.remain) ? raw.remain : undefined
	if (remain === undefined) return undefined
	const size = typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size > 0 ? raw.size : 0
	return {
		label: typeof raw.packageName === 'string' && raw.packageName !== '' ? raw.packageName : '(unnamed)',
		remain,
		size,
		...(typeof raw.packageEndTime === 'string' && raw.packageEndTime !== ''
			? { endTime: raw.packageEndTime }
			: {}),
		...(raw.unlimited === true ? { unlimited: true } : {}),
	}
}

/**
 * Normalize the credit document `dsh-workbuddy-connect` publishes.
 *
 * Its `credits.total` is the headline **remaining** figure, so it is taken as
 * authoritative; the rows only supply the per-package breakdown.
 * @param credits - the status document's `credits`, as received.
 * @returns the common reading fields.
 */
function normalizeWorkBuddyCredits(credits) {
	const source = credits !== null && typeof credits === 'object' ? credits : {}
	const rows = Array.isArray(source.accounts) ? source.accounts : []
	const accounts = rows.map(normalizeAccount).filter((account) => account !== undefined)
	const sum = accounts.reduce((total, account) => total + account.remain, 0)
	const size = accounts.reduce((total, account) => total + account.size, 0)
	return {
		total: typeof source.total === 'number' && Number.isFinite(source.total) ? source.total : sum,
		totalSize: size,
		accounts,
		...(source.unlimited === true ? { unlimited: true } : {}),
		...(typeof source.cycleResetTime === 'string' && source.cycleResetTime !== ''
			? { resetTime: source.cycleResetTime }
			: {}),
	}
}

/**
 * Normalize the credit document `dsh-qoder-connect` publishes.
 *
 * Its `credits.total` is **not** a remaining figure: it is the cycle's
 * consumption percentage (`totalUsagePercentage`). Reading it as a remainder
 * would print a number that looks like credit and means the opposite, so the
 * remaining total is summed from the rows and the source's own figure is kept
 * separately as `usedPercent`.
 * @param credits - the status document's `credits`, as received.
 * @returns the common reading fields.
 */
function normalizeQoderCredits(credits) {
	const source = credits !== null && typeof credits === 'object' ? credits : {}
	const rows = Array.isArray(source.accounts) ? source.accounts : []
	const accounts = rows.map(normalizeAccount).filter((account) => account !== undefined)
	const remain = accounts.reduce((total, account) => total + account.remain, 0)
	const summed = accounts.reduce((total, account) => total + account.size, 0)
	const totalSize =
		typeof source.totalSize === 'number' && Number.isFinite(source.totalSize) && source.totalSize > 0
			? source.totalSize
			: summed
	return {
		total: remain,
		totalSize,
		accounts,
		...(typeof source.total === 'number' && Number.isFinite(source.total) ? { usedPercent: source.total } : {}),
		...(source.unlimited === true ? { unlimited: true } : {}),
		...(typeof source.cycleResetTime === 'string' && source.cycleResetTime !== ''
			? { resetTime: source.cycleResetTime }
			: {}),
	}
}

/** Normalizers by source shape. */
const CREDIT_NORMALIZERS = {
	workbuddy: normalizeWorkBuddyCredits,
	qoder: normalizeQoderCredits,
}

/**
 * Read one provider's allowance from the plugin that owns it.
 *
 * Every outcome is expressed in this package's own vocabulary: a route that is
 * not mounted, a signed-out account, and a billing failure the owning plugin
 * already reported are all `queryable: false` with a reason the browser half can
 * name, rather than a thrown error that would read as a bug here.
 * @param providerId - provider route id being answered.
 * @param source - the `CREDIT_SOURCES` entry naming the route and shape.
 * @param origins - candidate loopback origins to read it from.
 * @param timeoutMs - per-read timeout.
 * @returns the browser-facing value.
 */
async function queryCreditSource(providerId, source, origins, timeoutMs) {
	if (origins.length === 0) {
		return { queryable: false, reason: 'source-unreachable', provider: providerId }
	}
	const normalize = CREDIT_NORMALIZERS[source.shape] ?? normalizeWorkBuddyCredits
	let lastError
	for (const origin of origins) {
		const endpoint = `${origin}${source.path}`
		let response
		try {
			response = await fetch(endpoint, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (error) {
			lastError = new Error(`${endpoint} 请求失败：${reasonOf(error)}`)
			continue
		}
		// The status route 404s while its owning plugin is not mounted, and 403s a
		// request that did not arrive over loopback; neither is a billing failure.
		if (response.status === 404) {
			return { queryable: false, reason: 'source-missing', provider: providerId }
		}
		if (response.status === 403) {
			lastError = new Error(`${endpoint} 拒绝了本机读取（HTTP 403）。`)
			continue
		}
		if (!response.ok) {
			lastError = new Error(`${endpoint} 返回 HTTP ${String(response.status)}。`)
			continue
		}
		let document
		try {
			document = await response.json()
		} catch {
			lastError = new Error(`${endpoint} 返回的不是 JSON。`)
			continue
		}
		if (document === null || typeof document !== 'object') {
			lastError = new Error(`${endpoint} 返回了无法识别的结构。`)
			continue
		}
		if (document.status === 'signed-out') {
			return {
				queryable: false,
				reason: 'signed-out',
				provider: providerId,
				...(typeof document.reason === 'string' && document.reason !== '' ? { detail: document.reason } : {}),
			}
		}
		if (document.status === 'error') {
			throw new Error(
				typeof document.message === 'string' && document.message !== ''
					? `${source.sourceName} 状态读取失败：${document.message}`
					: `${source.sourceName} 状态读取失败。`,
			)
		}
		if (document.credits !== undefined && document.credits !== null) {
			return {
				queryable: true,
				kind: 'credits',
				unit: source.unit,
				sourceName: source.sourceName,
				...normalize(document.credits),
				provider: providerId,
				endpoint,
			}
		}
		if (typeof document.creditsError === 'string' && document.creditsError !== '') {
			return { queryable: false, reason: 'credits-error', provider: providerId, detail: document.creditsError }
		}
		return { queryable: false, reason: 'no-credits', provider: providerId }
	}
	throw lastError ?? new Error(`无法读取 ${source.sourceName} 额度。`)
}

/**
 * Apply one patch to the settings document, rejecting unknown or invalid fields.
 *
 * Validation is deliberately closed: a field name that is not in
 * `SETTINGS_DEFAULTS` is refused instead of stored, so the file cannot accumulate
 * keys no reader knows about.
 * @param current - the settings as they stand.
 * @param patch - the requested changes; `null` resets a field to its default.
 * @returns the next settings, or an error message.
 */
function applySettingsPatch(current, patch) {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'invalid patch' }
	const next = { ...current }
	for (const [field, value] of Object.entries(patch)) {
		if (!Object.hasOwn(SETTINGS_DEFAULTS, field)) return { error: `unknown field: ${field}` }
		if (value === null) {
			next[field] = SETTINGS_DEFAULTS[field]
			continue
		}
		if (SETTINGS_ENUMS[field] !== undefined) {
			if (!SETTINGS_ENUMS[field].includes(value)) return { error: `invalid ${field}` }
			next[field] = value
			continue
		}
		if (typeof SETTINGS_DEFAULTS[field] === 'boolean') {
			if (typeof value !== 'boolean') return { error: `invalid ${field}` }
			next[field] = value
			continue
		}
		if (typeof SETTINGS_DEFAULTS[field] === 'number') {
			const [low, high] = SETTINGS_BOUNDS[field] ?? [-Number.MAX_VALUE, Number.MAX_VALUE]
			if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
				return { error: `invalid ${field}` }
			}
			next[field] = value
			continue
		}
		return { error: `invalid ${field}` }
	}
	return { next }
}

/**
 * Read the settings file into a full document.
 *
 * A missing, unreadable, or partly invalid file yields defaults field by field,
 * so one bad value cannot cost the user every other setting.
 * @param filePath - absolute path of the settings file.
 * @returns the merged settings.
 */
function readSettingsFile(filePath) {
	let stored = {}
	try {
		if (existsSync(filePath)) {
			const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
		}
	} catch {
		stored = {}
	}
	const merged = { ...SETTINGS_DEFAULTS }
	for (const [field, fallback] of Object.entries(SETTINGS_DEFAULTS)) {
		const value = stored[field]
		if (value === undefined) continue
		// Re-validate on read: a hand-edited file must not smuggle in a value the
		// POST route would have refused.
		const outcome = applySettingsPatch({ ...SETTINGS_DEFAULTS }, { [field]: value })
		if (outcome.next !== undefined) merged[field] = outcome.next[field]
		else merged[field] = fallback
	}
	return merged
}

/**
 * Write the settings document atomically (temp file plus rename).
 * @param filePath - absolute path of the settings file.
 * @param values - the document to store.
 * @returns nothing; a write failure is reported to the caller by the throw.
 */
function writeSettingsFile(filePath, values) {
	mkdirSync(dirname(filePath), { recursive: true })
	const ordered = {}
	for (const field of SETTINGS_ORDER) ordered[field] = values[field]
	const temporary = `${filePath}.tmp`
	writeFileSync(temporary, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
	renameSync(temporary, filePath)
}

/**
 * Resolve this plugin's own settings directory.
 *
 * Only node builtins are used, per this half's portability rule: the harness
 * home comes from `$DSH_HOME` and falls back to `~/.dsh`, which is where dsh
 * itself keeps its state.
 * @param config - resolved package configuration.
 * @returns the absolute settings file path.
 */
function settingsFilePath(config) {
	if (typeof config.settingsFile === 'string' && config.settingsFile !== '') return config.settingsFile
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'dsh-plugin-balance', SETTINGS_FILE)
}

/**
 * Build one failure answer in the shape the browser half reads.
 * @param code - stable machine-readable code.
 * @param message - display-ready explanation.
 * @returns the failure body.
 */
function failure(code, message) {
	return { ok: false, error: { code, message } }
}

/**
 * Start the balance route without making this row wait for anything.
 *
 * `credentials` and `connection` are both read through a child fiber, so the
 * row activates immediately on every dsh and only ever loses a capability.
 * @param ctx - owning plugin context.
 * @param config - the row's `config`, as the loader passed it.
 */
export function apply(ctx, config) {
	const settings = resolveConfig(config)
	ctx.inject(['credentials', 'connection'], (scope) => {
		register(scope, scope.credentials, settings)
	})
}

/**
 * Register the authenticated route and its per-provider cache.
 * @param ctx - the child context that carries both services.
 * @param credentials - the credentials seam, resolving keys per request.
 * @param config - resolved settings.
 */
function register(ctx, credentials, config) {
	const timeoutMs = config.timeoutMs
	const minIntervalMs = config.minIntervalMs
	const okTtlMs = config.okTtlMs
	const errorTtlMs = config.errorTtlMs
	const defaultProvider = config.defaultProvider

	/**
	 * Read one settings section without making this row depend on the service.
	 *
	 * The settings service (dsh 0.1.7) exposes `describe()`, which lists every
	 * configurable entry as `{ ns, value }` rows — there is no `get(namespace)`.
	 * The result is cached for the tick, because one provider answer reads the
	 * section twice (strategy match, then the DeepSeek re-match).
	 * @param namespace - settings namespace, e.g. `llm-pi-ai` (the profile entry id).
	 * @returns the section object, or undefined when it is absent or unreadable.
	 */
	let described = null
	const sectionOf = (namespace) => {
		try {
			const settings = ctx.get('settings')
			if (settings === undefined || typeof settings.describe !== 'function') return undefined
			if (described === null) described = settings.describe()
			const row = described.find((entry) => entry !== null && entry.ns === namespace)
			const value = row?.value
			return value !== null && typeof value === 'object' ? value : undefined
		} catch {
			return undefined
		}
	}

	/**
	 * Read the provider's own settings: the settings UI is where a deployment
	 * names a base URL or a renamed key variable.
	 * @param providerId - provider route id.
	 * @returns the configured base URL and credential reference, when named.
	 */
	const providerSettings = (providerId) => {
		const profile = sectionOf('llm-pi-ai')?.providers?.[providerId]
		let baseURL =
			typeof profile?.baseURL === 'string' && profile.baseURL !== '' ? profile.baseURL : undefined
		let keyEnv =
			typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined
		if (keyEnv === undefined) {
			const deepseek = sectionOf('llm-deepseek-api-key')
			if (typeof deepseek?.apiKeyEnv === 'string' && deepseek.apiKeyEnv !== '') keyEnv = deepseek.apiKeyEnv
		}
		return { baseURL, keyEnv }
	}

	/** DeepSeek endpoint base: the package config, then `$DEEPSEEK_BASE_URL`, then the official API. */
	const deepseekBaseURL = () => {
		if (typeof config.baseURL === 'string' && config.baseURL !== '') return config.baseURL
		const named = process.env.DEEPSEEK_BASE_URL
		return named !== undefined && named !== '' ? named : DEFAULT_BASE_URL
	}

	/** DeepSeek credential reference from the package config. */
	const deepseekKeyEnv = () => config.apiKeyEnv ?? DEFAULT_API_KEY_ENV

	/**
	 * Resolve one provider id to an endpoint, a credential reference and a parser.
	 * @param providerId - provider route id as requested.
	 * @returns the strategy, or undefined when this provider has no known billing API.
	 */
	const strategyFor = (providerId) => {
		const profile = providerSettings(providerId)
		const base = matchStrategy(providerId, profile.baseURL, profile.keyEnv)
		if (base === undefined || base.canonical !== 'deepseek') return base
		// The package config and $DEEPSEEK_BASE_URL stay the knobs for DeepSeek.
		return (
			matchStrategy(
				providerId,
				profile.baseURL ?? deepseekBaseURL(),
				profile.keyEnv ?? deepseekKeyEnv(),
			) ?? base
		)
	}

	/**
	 * Ask one provider's billing endpoint and normalize its answer.
	 * @param providerId - provider route id as requested.
	 * @param origins - loopback origins, for the locally-served credit routes.
	 * @returns the browser-facing value; refusals come back as `queryable: false`.
	 */
	const queryProvider = async (providerId, origins) => {
		const source = CREDIT_SOURCES[providerId.toLowerCase()]
		if (source !== undefined) {
			// The allowance belongs to another plugin's sign-in; this package reads
			// the answer that plugin publishes rather than re-implementing billing.
			return queryCreditSource(providerId, source, origins, timeoutMs)
		}
		const strategy = strategyFor(providerId)
		if (strategy === undefined) {
			const loginUrl = matchLoginRequired(providerId, providerSettings(providerId).baseURL)
			if (loginUrl !== undefined) {
				return { queryable: false, reason: 'login-required', provider: providerId, loginUrl }
			}
			return { queryable: false, reason: 'no-balance-api', provider: providerId }
		}

		const hit = await credentials.resolve(strategy.keyEnv)
		const apiKey = hit === undefined || typeof hit.value !== 'string' ? '' : hit.value.trim()
		if (apiKey === '') throw new Error(`凭据 ${strategy.keyEnv} 未配置，无法读取余额。`)

		let response
		try {
			response = await fetch(strategy.url, {
				headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (error) {
			throw new Error(`${strategy.url} 请求失败：${reasonOf(error)}`)
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error(`${strategy.url} 拒绝了当前 API Key（HTTP ${String(response.status)}）。`)
		}
		if (!response.ok) {
			throw new Error(`${strategy.url} 返回 HTTP ${String(response.status)}。`)
		}
		let payload
		try {
			payload = await response.json()
		} catch {
			throw new Error('余额接口返回的不是 JSON。')
		}
		let value
		try {
			value = strategy.parse(payload)
		} catch (error) {
			throw new Error(`余额接口返回了无法识别的结构：${reasonOf(error)}`)
		}
		// Every reading carries its unit explicitly, so the browser half never has
		// to infer one — inferring is how credits get printed as currency.
		return {
			...value,
			unit: value.unit ?? (value.kind === 'quota' ? 'requests' : 'currency'),
			provider: providerId,
			endpoint: strategy.url,
		}
	}

	/** Last answer per provider, plus its read time. */
	const cache = new Map()
	/** The upstream read already in flight per provider, so tabs and polls coalesce. */
	const inflight = new Map()

	/**
	 * Answer one provider from the cache, from a read already in flight, or upstream.
	 * @param providerId - provider route id as requested.
	 * @param refresh - true to bypass the freshness window (still bounded by the floor).
	 * @param origins - loopback origins, for the locally-served WorkBuddy routes.
	 * @returns the route body.
	 */
	const answerProvider = async (providerId, refresh, origins) => {
		const cached = cache.get(providerId)
		if (cached !== undefined) {
			const age = Date.now() - cached.at
			// A plain read reuses anything still inside its window; a refresh read
			// ignores that window but never reads upstream twice inside the floor.
			const serve = refresh ? age < minIntervalMs : age < (cached.ok ? okTtlMs : errorTtlMs)
			if (serve) return cached.body
		}

		const pendingInFlight = inflight.get(providerId)
		if (pendingInFlight !== undefined) return pendingInFlight

		const pending = (async () => {
			try {
				return { ok: true, value: await queryProvider(providerId, origins) }
			} catch (error) {
				return failure('provider-query-failed', reasonOf(error))
			}
		})()
		inflight.set(providerId, pending)
		pending
			.then((body) => {
				cache.set(providerId, { at: Date.now(), ok: body.ok === true, body })
			})
			.finally(() => {
				inflight.delete(providerId)
			})
		return pending
	}

	ctx.connection.fetch.register({
		path: ROUTE_PATH,
		methods: ['GET'],
		requestBody: 'buffered',
		fetch: async (request) => {
			const url = new URL(request.url)
			const named = url.searchParams.get('provider')
			const providerId = named === null || named === '' ? defaultProvider : named
			const refresh = url.searchParams.get('refresh') === '1'
			// The describe() snapshot is per request, so a settings edit is picked up
			// on the next poll without this row subscribing to anything.
			described = null
			// Resolved per request, so a credit reader follows a web server that
			// started — or was reconfigured — after this row activated.
			const origins = loopbackOrigins(request, ctx.get('webServer'))
			const body = await answerProvider(providerId, refresh, origins)
			return Response.json(body, { headers: { 'cache-control': 'no-store' } })
		},
	})

	/**
	 * Register the settings route the browser half's settings tab reads and writes.
	 *
	 * The document is this package's own file, not the profile's loader row: a
	 * settings write through the loader would reconcile the whole plugin tree and
	 * hot-reload this fiber (well over a second, plus a client mirror storm) for
	 * every toggled switch. A local atomic file write has none of that, which is
	 * what makes the settings tab feel immediate.
	 */
	const settingsFile = settingsFilePath(config)
	ctx.connection.fetch.register({
		path: SETTINGS_PATH,
		methods: ['GET', 'POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			if (request.method === 'GET') {
				return Response.json(
					{ ok: true, value: readSettingsFile(settingsFile), defaults: SETTINGS_DEFAULTS },
					{ headers: { 'cache-control': 'no-store' } },
				)
			}
			let patch
			try {
				patch = await request.json()
			} catch {
				return Response.json(failure('invalid-json', '请求体不是 JSON。'), { status: 400 })
			}
			const outcome = applySettingsPatch(readSettingsFile(settingsFile), patch)
			if (outcome.error !== undefined) {
				return Response.json(failure('invalid-patch', outcome.error), { status: 400 })
			}
			try {
				writeSettingsFile(settingsFile, outcome.next)
			} catch (error) {
				return Response.json(failure('write-failed', reasonOf(error)), { status: 500 })
			}
			return Response.json(
				{ ok: true, value: outcome.next, defaults: SETTINGS_DEFAULTS },
				{ headers: { 'cache-control': 'no-store' } },
			)
		},
	})
}
