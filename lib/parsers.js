/**
 * Declarative provider parsers — vendored from dsh-model-balance.
 *
 * Upstream: `dsh-model-balance` v0.1.4, `src/host/custom-providers.ts`, MIT.
 * See LICENSE-dsh-model-balance in this package for the full notice.
 *
 * A provider entry in `providers.json` (or in the user's own file) says how to
 * reach a billing endpoint and how to read its answer, without any code:
 *
 *   { "baseURL": ..., "endpoint": ..., "keyEnv": ...,
 *     "response": { "type": "currency" | "quota", ... } }
 *
 * Three ways to name a value in the response: a dotted path, an array lookup
 * (`find` + `value`), or an expression.
 *
 * ⚠ `response.*.expr` is evaluated with `new Function`, exactly as upstream does.
 * The config file is therefore trusted code; keep it writable only by you.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Set this to point at your own provider file instead of ~/.dsh/… */
const CONFIG_ENV = 'DSH_MODEL_BALANCE_CONFIG'
/** User file name under $HOME/.dsh, kept from upstream so old files keep working. */
const USER_CONFIG_FILE = 'model-balance-providers.json'

/** Diagnostic prefix; the package name, not the upstream plugin name. */
const TAG = '[dsh-balance-card]'

/**
 * Read a dotted path out of a decoded JSON document.
 * @param obj - decoded document.
 * @param path - dotted path, numeric segments index arrays.
 * @returns the value at the path, or undefined.
 */
function getByPath(obj, path) {
	const keys = path.split('.')
	let current = obj
	for (const key of keys) {
		if (current === null || current === undefined || typeof current !== 'object') return undefined
		if (Array.isArray(current) && /^\d+$/u.test(key)) current = current[Number(key)]
		else current = current[key]
	}
	return current
}

/**
 * Evaluate the configured expression against a response document.
 * @param body - decoded provider response.
 * @param expr - expression written in terms of the response's own paths.
 * @returns the value, or undefined when the expression cannot be evaluated.
 */
function evaluateExpr(body, expr) {
	const resolved = expr.replace(/([a-zA-Z_][\w.]*)/gu, (match) => {
		if (['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(match)) return match
		const value = getByPath(body, match)
		if (value === undefined || value === null) return 'NaN'
		if (typeof value === 'string') return JSON.stringify(value)
		return String(value)
	})
	try {
		/* eslint-disable-next-line no-new-func -- upstream contract: config carries expressions */
		return new Function(`"use strict"; return (${resolved})`)()
	} catch {
		return undefined
	}
}

/**
 * Resolve one configured value descriptor against a response document.
 * @param body - decoded provider response.
 * @param config - dotted path, `{path,find,value}`, or `{expr}`.
 * @returns the resolved value, or undefined.
 */
function resolvePath(body, config) {
	if (typeof config === 'string') return getByPath(body, config)
	if (config !== null && typeof config === 'object') {
		if ('expr' in config) return evaluateExpr(body, config.expr)
		if ('find' in config) {
			const list = getByPath(body, config.path)
			if (!Array.isArray(list)) return undefined
			const item = list.find(
				(entry) => entry !== null && typeof entry === 'object' && entry[config.find.field] === config.find.equals,
			)
			return item === undefined ? undefined : item[config.value]
		}
		if ('path' in config) return getByPath(body, config.path)
	}
	return undefined
}

/**
 * Build the parser for a `type: "currency"` response.
 * @param config - the provider's `response` block.
 * @returns a parser producing one currency reading.
 */
function buildCurrencyParser(config) {
	return (body) => {
		const balance = Number(resolvePath(body, config.balance))
		if (!Number.isFinite(balance)) throw new Error('balance is not numeric')
		const available = config.available === undefined ? undefined : Boolean(getByPath(body, config.available))
		return {
			queryable: true,
			kind: 'currency',
			currency: config.currency ?? 'CNY',
			balance,
			...(available === undefined ? {} : { available }),
		}
	}
}

/**
 * Build the parser for a `type: "quota"` response.
 * @param config - the provider's `response` block.
 * @returns a parser producing one quota reading.
 */
function buildQuotaParser(config) {
	return (body) => {
		const limit = Number(resolvePath(body, config.limit))
		const used = Number(resolvePath(body, config.used))
		const remaining = Number(resolvePath(body, config.remaining))
		if (!Number.isFinite(limit) || !Number.isFinite(used) || !Number.isFinite(remaining)) {
			throw new Error('quota values are not numeric')
		}
		const resetTime = config.resetTime === undefined ? undefined : getByPath(body, config.resetTime)
		return {
			queryable: true,
			kind: 'quota',
			unit: 'requests',
			limit,
			used,
			remaining,
			...(typeof resetTime === 'string' ? { resetTime } : {}),
		}
	}
}

/**
 * Pick the parser named by one provider's `response.type`.
 * @param response - the provider's `response` block.
 * @returns the parser for that type.
 */
function buildParser(response) {
	return response.type === 'currency' ? buildCurrencyParser(response) : buildQuotaParser(response)
}

/**
 * Locate the provider list shipped inside this package.
 * @returns absolute path of the bundled `providers.json`.
 */
function getBundledConfigPath() {
	try {
		const currentDir =
			typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
		return join(currentDir, '..', 'providers.json')
	} catch {
		return join(process.cwd(), 'providers.json')
	}
}

/**
 * Locate the user's own provider list.
 * @returns absolute path, from the environment when it names one.
 *
 * The dsh home is resolved the way dsh itself resolves it (`dsh-home-paths`):
 * `$DSH_HOME` when set to a non-blank value, otherwise `~/.dsh`. The blank
 * value is treated as unset, exactly as upstream does.
 */
function getUserConfigPath() {
	const envPath = process.env[CONFIG_ENV]
	if (envPath !== undefined && envPath !== '') return envPath
	const home = process.env.DSH_HOME
	return home !== undefined && home.trim() !== ''
		? join(home, USER_CONFIG_FILE)
		: join(homedir(), '.dsh', USER_CONFIG_FILE)
}

/** Parsed strategies, cached for the process because the files rarely change. */
let cachedStrategies = null

/**
 * Turn one config file into strategies.
 * @param configPath - absolute path of a provider file.
 * @returns strategies keyed by provider id; empty when the file is absent or unusable.
 */
function parseConfigFile(configPath) {
	if (!existsSync(configPath)) return {}
	try {
		const file = JSON.parse(readFileSync(configPath, 'utf-8'))
		if (!file.providers || typeof file.providers !== 'object') return {}
		const result = {}
		for (const [id, config] of Object.entries(file.providers)) {
			if (id.startsWith('_')) continue
			if (!config.baseURL || !config.endpoint || !config.keyEnv || !config.response) {
				console.warn(`${TAG} skipping invalid provider "${id}": missing required fields`)
				continue
			}
			result[id] = {
				suffix: config.endpoint,
				defaultBaseURL: config.baseURL,
				defaultKeyEnv: config.keyEnv,
				parse: buildParser(config.response),
				...(config.aliases ? { aliases: config.aliases } : {}),
			}
		}
		return result
	} catch (error) {
		console.error(`${TAG} failed to load provider config from ${configPath}:`, error)
		return {}
	}
}

/**
 * Read the bundled list plus the user's overrides.
 * @returns every declarative strategy, the user's entries winning.
 */
export function loadCustomProviders() {
	if (cachedStrategies !== null) return cachedStrategies
	const bundled = parseConfigFile(getBundledConfigPath())
	const user = parseConfigFile(getUserConfigPath())
	cachedStrategies = { ...bundled, ...user }
	return cachedStrategies
}

/**
 * Drop the parse cache, so an edited config file is picked up.
 * @returns nothing.
 */
export function resetCustomProviders() {
	cachedStrategies = null
}

export { getByPath, resolvePath, buildParser, getUserConfigPath, getBundledConfigPath }
