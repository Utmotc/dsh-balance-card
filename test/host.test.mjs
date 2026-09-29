/**
 * Host-half self-check for dsh-balance-card.
 *
 * Loads the real plugin module, hands it a fake context, and drives the
 * authenticated route handler directly. No DSH process, no network, no keys.
 *
 * Run: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const ORIGIN = 'http://127.0.0.1:3080'

/** A per-run settings file, so the suite never touches the real one. */
const SETTINGS_DIR = mkdtempSync(join(tmpdir(), 'dsh-balance-test-'))
const SETTINGS_FILE = join(SETTINGS_DIR, 'balance-settings.json')
process.on('exit', () => {
	try {
		rmSync(SETTINGS_DIR, { recursive: true, force: true })
	} catch {
		// A leftover temp directory is not worth failing a test run over.
	}
})

/** One valid answer per provider, in each vendor's real shape. */
const BODIES = {
	deepseek: {
		is_available: true,
		balance_infos: [
			{ currency: 'CNY', total_balance: '7.67', granted_balance: '0.00', topped_up_balance: '7.67' },
		],
	},
	stepfun: { balance: 12.5, total_cash_balance: 10, total_voucher_balance: 2.5 },
	'kimi-coding': { usage: { limit: 100, used: 20, remaining: 80, resetTime: '2026-10-01T00:00:00Z' } },
	openrouter: { data: { limit: 1000, usage: 400 } },
	minimax: { data: 30, total: 50 },
	xai: { total_granted: 5 },
}
BODIES.grok = BODIES.xai

/** Upstream calls recorded by the active stub. */
let calls = []
/** What the active stub answers. */
let responder = () => jsonResponse(BODIES.deepseek)

/** @param body - decoded document. @returns a JSON response. */
function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

globalThis.fetch = async (url, init) => {
	calls.push({ url: String(url), init })
	return responder(String(url), init)
}

/** The loopback status document dsh-workbuddy-connect publishes. */
const WORKBUDDY_DOCUMENT = {
	status: 'signed-in',
	credits: {
		total: 1289,
		accounts: [
			{ packageName: 'CodeBuddy 个人体验版', remain: 364, size: 500 },
			{ packageName: 'CodeBuddy 个人版国内运营裂变包', remain: 0, size: 1000 },
			{ packageName: 'CodeBuddy 个人版国内运营裂变包', remain: 925, size: 1000 },
		],
	},
}
/** A signed-out document: signed in state is a precondition for any credit. */
const WORKBUDDY_SIGNED_OUT = { status: 'signed-out', reason: 'no-credential' }
/** A document whose billing read failed, which the owning plugin reports inline. */
const WORKBUDDY_CREDITS_ERROR = { status: 'signed-in', creditsError: 'billing 500' }

/** The loopback status document dsh-qoder-connect publishes. */
const QODER_DOCUMENT = {
	status: 'signed-in',
	credits: {
		// NOTE: Qoder's `total` is the cycle's CONSUMPTION percentage, not a
		// remaining figure — the opposite of WorkBuddy's `total`. This fixture
		// deliberately uses a value that would be absurd as a remainder, so a
		// normalizer that mistook one for the other fails loudly here.
		total: 99.5,
		totalSize: 200,
		accounts: [
			{ packageName: '个人额度', remain: 0, size: 0, packageEndTime: '9999-12-31T00:00:00.000Z' },
			{ packageName: '赠送额度', remain: 100, size: 100, packageEndTime: '9999-12-31T00:00:00.000Z' },
		],
		unlimited: true,
		cycleResetTime: '9999-12-31T00:00:00.000Z',
	},
}

/** The workbuddy/qoder status routes, answered the way their plugins do. */
const workbuddyRoute = (url, document) =>
	url.includes('/plugins/dsh-workbuddy-connect/') ? jsonResponse(document) : undefined

/** The qoder status routes. */
const qoderRoute = (url, document) =>
	url.includes('/plugins/dsh-qoder-connect/') ? jsonResponse(document) : undefined


const plugin = await import(PLUGIN)

/**
 * Mount the plugin on a fake context and return its route.
 * @param options - per-scenario stubs: `config`, `sections`, `credential`,
 *   `respond`, `webServer`, `withoutServices`.
 * @returns what the run registered, resolved and waited for.
 */
function mount(options = {}) {
	calls = []
	responder = options.respond ?? (() => jsonResponse(BODIES.deepseek))
	const sections = options.sections ?? {}
	const registered = []
	const resolved = []
	const waits = []
	const credentials = {
		resolve: async (ref) => {
			resolved.push(ref)
			return 'credential' in options ? options.credential : { value: 'sk-test-key' }
		},
	}
	const connection = {
		fetch: {
			register: (route) => {
				registered.push(route)
				return () => {}
			},
		},
	}
	// The web server is optional and read with `ctx.get`, exactly like `settings`.
	const webServer = 'webServer' in options ? options.webServer : { port: 3080 }
	// The real settings service (dsh 0.1.7) exposes `describe()` — a list of
	// `{ ns, value }` rows — and no `get(namespace)`. The stub mirrors that face.
	const settings =
		options.settings === null
			? undefined
			: {
					describe: () =>
						Object.entries(sections).map(([ns, value]) => ({ ns, value })),
				}
	const get = (name) => {
		if (name === 'settings') return settings
		if (name === 'webServer') return webServer
		return undefined
	}
	const ctx = {
		get,
		// cordis starts a child fiber and calls back once every named service is
		// present; both are present here, so the callback runs synchronously.
		inject: (deps, callback) => {
			waits.push(deps)
			if (options.withoutServices === true) return
			callback({ credentials, connection, get })
		},
	}
	plugin.apply(ctx, { ...(options.config ?? {}), settingsFile: options.settingsFile ?? SETTINGS_FILE })
	return { registered, resolved, waits }
}

/**
 * Mount and require both routes out of it.
 * @param options - the same stubs `mount` takes.
 * @returns the balance route, the settings route, and the resolved credential refs.
 */
function mountRoute(options = {}) {
	const mounted = mount(options)
	assert.equal(mounted.registered.length, 2, 'exactly two routes are registered')
	const route = mounted.registered.find((entry) => entry.path === '/api/dsh.balance')
	const settings = mounted.registered.find((entry) => entry.path === '/api/dsh.balance.settings')
	assert.ok(route !== undefined, 'the balance route is registered')
	assert.ok(settings !== undefined, 'the settings route is registered')
	assert.deepEqual(route.methods, ['GET'])
	assert.deepEqual(settings.methods, ['GET', 'POST'])
	return { route, settings, resolved: mounted.resolved }
}

/**
 * Drive one request through the mounted route.
 * @param route - the registered route.
 * @param query - query string without the leading `?`.
 * @param headers - extra request headers, e.g. the browser's `Host`.
 * @returns the response and its decoded body.
 */
async function ask(route, query = '', headers = {}) {
	const response = await route.fetch(
		new Request(`${ORIGIN}/api/dsh.balance${query === '' ? '' : `?${query}`}`, { headers }),
	)
	return { response, body: await response.json() }
}

console.log('exports:', Object.keys(plugin).join(', '))
assert.equal(plugin.name, 'balance-monitor')
assert.deepEqual(plugin.inject, [], 'nothing may be required: a rename must not strand this row')

// A: BOOT SAFETY. The row activates even when neither service ever arrives.
{
	const mounted = mount({ withoutServices: true })
	assert.deepEqual(mounted.waits, [['credentials', 'connection']], 'both services are waited for, none required')
	assert.equal(mounted.registered.length, 0, 'nothing registers without them')
	assert.equal(calls.length, 0)
	console.log('A ok: activates with no required service; a missing connection costs only the route')
}

// A partial or misspelled config still resolves to the documented defaults.
{
	const mounted = mountRoute({ config: { timeoutMs: 'not a number', minIntervalMs: 0, unknownKey: 1 } })
	const { body } = await ask(mounted.route, 'provider=deepseek')
	assert.equal(body.value.balance, 7.67, 'a typo must not stop the route')
	console.log('A2 ok: an unusable config value falls back to its default')
}

// A row with no config at all 鈥?exactly what a bare install produces, because the
// published bundle patch ships every key commented out.
{
	const bare = mountRoute({ config: null })
	const { body } = await ask(bare.route, 'provider=deepseek')
	assert.equal(body.value.balance, 7.67, 'no config means defaults, not a failure')
	const undefinedConfig = mountRoute({ config: undefined })
	assert.ok(undefinedConfig.route)
	console.log('A3 ok: a bare install (config: null) still answers')
}

// A: a DeepSeek route answers with the reading, its provider echo and its endpoint.
{
	const { route } = mountRoute()
	const { response, body } = await ask(route, 'provider=deepseek-official')
	console.log('A:', JSON.stringify(body))
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('cache-control'), 'no-store')
	assert.equal(body.ok, true)
	assert.equal(body.value.provider, 'deepseek-official', 'the requested id is echoed back')
	assert.equal(body.value.queryable, true)
	assert.equal(body.value.kind, 'currency')
	assert.equal(body.value.currency, 'CNY')
	assert.equal(body.value.balance, 7.67)
	assert.equal(body.value.toppedUp, 7.67)
	assert.equal(body.value.endpoint, 'https://api.deepseek.com/user/balance')
	assert.equal(calls.length, 1)
	assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-key')
	assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
}

// B: no provider names the default one.
{
	const { route } = mountRoute()
	const { body } = await ask(route, '')
	assert.equal(body.value.provider, 'deepseek')
	assert.equal(body.value.balance, 7.67)
}

// C: a vendor without a billing API, and one that needs its web console.
{
	const { route } = mountRoute()
	const openai = await ask(route, 'provider=openai')
	assert.deepEqual(openai.body.value, { queryable: false, reason: 'no-balance-api', provider: 'openai' })
	const xiaomi = await ask(route, 'provider=xiaomi')
	assert.equal(xiaomi.body.ok, true)
	assert.equal(xiaomi.body.value.reason, 'login-required')
	assert.match(xiaomi.body.value.loginUrl, /xiaomimimo\.com/u)
	console.log('C:', JSON.stringify(xiaomi.body.value))
}

// D: every documented provider resolves to its own endpoint and parses its own shape.
// grok is no longer among them: it is a subscription route answered in the
// browser (see T), so only the bare xAI key keeps its own endpoint here.
{
	const expected = {
		deepseek: ['https://api.deepseek.com/user/balance', 'currency'],
		stepfun: ['https://api.stepfun.com/v1/accounts', 'currency'],
		'kimi-coding': ['https://api.kimi.com/coding/v1/usages', 'quota'],
		openrouter: ['https://openrouter.ai/api/v1/auth/key', 'currency'],
		minimax: ['https://api.minimax.chat/v1/token_plan/remains', 'quota'],
		xai: ['https://api.x.ai/v1/dashboard/billing/credit_grants', 'currency'],
	}
	const seen = {}
	for (const [provider, [url, kind]] of Object.entries(expected)) {
		const { route } = mountRoute({ respond: () => jsonResponse(BODIES[provider]) })
		const { body } = await ask(route, `provider=${encodeURIComponent(provider)}`)
		assert.equal(calls[0].url, url, `${provider} must call ${url}`)
		assert.equal(body.ok, true, `${provider} must parse`)
		assert.equal(body.value.kind, kind, `${provider} kind`)
		assert.equal(body.value.provider, provider)
		seen[provider] = body.value.kind === 'quota' ? `${body.value.remaining}/${body.value.limit}` : body.value.balance
	}
	console.log('D:', JSON.stringify(seen))
}

// E: settings name a base URL or a credential variable; both must win.
{
	const sections = {
		'llm-pi-ai': { providers: { 'my-gateway': { baseURL: 'https://api.stepfun.com/v1' } } },
	}
	const { route } = mountRoute({ sections, respond: () => jsonResponse(BODIES.stepfun) })
	const { body } = await ask(route, 'provider=my-gateway')
	assert.equal(calls[0].url, 'https://api.stepfun.com/v1/accounts', 'an unknown id matched by endpoint host')
	assert.equal(body.value.kind, 'currency')
	console.log('E1:', calls[0].url)

	const override = {
		'llm-pi-ai': { providers: { deepseek: { baseURL: 'https://gw.example/v1', apiKeyEnv: 'MY_DS_KEY' } } },
	}
	const second = mountRoute({ sections: override })
	await ask(second.route, 'provider=deepseek')
	assert.equal(calls[0].url, 'https://gw.example/v1/user/balance', 'the configured base URL wins')
	assert.deepEqual(second.resolved, ['MY_DS_KEY'], 'the configured credential reference is resolved')
	console.log('E2:', calls[0].url, second.resolved)

	const legacy = mountRoute({ sections: { 'llm-deepseek-api-key': { apiKeyEnv: 'LEGACY_DS_KEY' } } })
	await ask(legacy.route, 'provider=deepseek')
	assert.deepEqual(legacy.resolved, ['LEGACY_DS_KEY'], 'llm-deepseek-api-key still names the DeepSeek key')

	// A settings service without describe() (or absent entirely) must degrade to
	// the built-in defaults, not break the answer.
	const silent = mountRoute({ sections: { 'llm-pi-ai': { providers: { deepseek: { baseURL: 'https://ignored.example' } } } }, settings: null })
	await ask(silent.route, 'provider=deepseek')
	assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance', 'no settings service falls back to the official endpoint')
	console.log('E3: settings service absent → built-in defaults')
}

// F: the cache, the refresh floor, and coalescing of concurrent reads.
{
	const { route } = mountRoute({ config: { minIntervalMs: 0 } })
	await ask(route, 'provider=deepseek')
	await ask(route, 'provider=deepseek')
	assert.equal(calls.length, 1, 'a fresh answer is reused without asking again')
	await ask(route, 'provider=deepseek&refresh=1')
	assert.equal(calls.length, 2, 'refresh bypasses freshness when the floor allows it')

	const floored = mountRoute({ config: { minIntervalMs: 60000 } })
	await ask(floored.route, 'provider=deepseek')
	await ask(floored.route, 'provider=deepseek&refresh=1')
	assert.equal(calls.length, 1, 'refresh never reads upstream twice inside the floor')

	const parallel = mountRoute({ config: { minIntervalMs: 0 } })
	const answers = await Promise.all([
		ask(parallel.route, 'provider=deepseek'),
		ask(parallel.route, 'provider=deepseek'),
	])
	assert.equal(calls.length, 1, 'concurrent reads coalesce into one upstream call')
	assert.equal(answers[0].body.value.balance, answers[1].body.value.balance)
	console.log('F ok: cache, refresh floor and coalescing')
}

// G: failures are reported as failures, never as a stale number.
{
	const missing = mountRoute({ credential: undefined })
	const absent = await ask(missing.route, 'provider=deepseek')
	assert.equal(absent.body.ok, false)
	assert.equal(absent.body.error.code, 'provider-query-failed')
	assert.match(absent.body.error.message, /DEEPSEEK_API_KEY/u)

	const blank = mountRoute({ credential: { value: '   ' } })
	const empty = await ask(blank.route, 'provider=deepseek')
	assert.equal(empty.body.ok, false)
	assert.match(empty.body.error.message, /DEEPSEEK_API_KEY/u)

	const server = mountRoute({ respond: () => new Response('boom', { status: 500 }) })
	const broke = await ask(server.route, 'provider=deepseek')
	assert.equal(broke.body.ok, false)
	assert.match(broke.body.error.message, /HTTP 500/u)

	const denied = mountRoute({ respond: () => new Response('nope', { status: 401 }) })
	const refused = await ask(denied.route, 'provider=deepseek')
	assert.match(refused.body.error.message, /拒绝/u)

	const html = mountRoute({ respond: () => new Response('<html>', { status: 200 }) })
	const notJson = await ask(html.route, 'provider=deepseek')
	assert.equal(notJson.body.ok, false)
	assert.match(notJson.body.error.message, /不是 JSON/u)

	const shape = mountRoute({ respond: () => jsonResponse({ unexpected: true }) })
	const unknown = await ask(shape.route, 'provider=deepseek')
	assert.equal(unknown.body.ok, false)
	assert.match(unknown.body.error.message, /无法识别/u)
	console.log('G:', JSON.stringify(broke.body.error), JSON.stringify(unknown.body.error))
}

// H: without the settings service every built-in provider still answers.
{
	const { route } = mountRoute()
	const { body } = await ask(route, 'provider=deepseek')
	assert.equal(body.value.balance, 7.67)
	console.log('H ok: no settings service, still answers')
}

// I: WorkBuddy credit is read from the plugin that owns it, not from an upstream
// billing endpoint, and normalized into this package's own reading shape.
{
	const { route } = mountRoute({ respond: (url) => workbuddyRoute(url, WORKBUDDY_DOCUMENT) })
	const { body } = await ask(route, 'provider=workbuddy')
	console.log('I:', JSON.stringify(body))
	assert.equal(calls.length, 1, 'no credential is resolved for a WorkBuddy read')
	assert.equal(calls[0].url, 'http://127.0.0.1:3080/plugins/dsh-workbuddy-connect/status')
	assert.equal(body.ok, true)
	assert.equal(body.value.queryable, true)
	assert.equal(body.value.kind, 'credits')
	assert.equal(body.value.provider, 'workbuddy', 'the requested id is echoed back')
	assert.equal(body.value.total, 1289)
	assert.equal(body.value.accounts.length, 3)
	assert.deepEqual(body.value.accounts[1], {
		label: 'CodeBuddy 个人版国内运营裂变包',
		remain: 0,
		size: 1000,
	})
	assert.equal(body.value.endpoint, 'http://127.0.0.1:3080/plugins/dsh-workbuddy-connect/status')

	// The international variant is a different provider with a different route.
	const ai = mountRoute({ respond: (url) => workbuddyRoute(url, WORKBUDDY_DOCUMENT) })
	const aiBody = (await ask(ai.route, 'provider=workbuddy-ai')).body
	assert.equal(
		calls[0].url,
		'http://127.0.0.1:3080/plugins/dsh-workbuddy-connect/ai/status',
		'workbuddy-ai reads the AI variant route',
	)
	assert.equal(aiBody.value.provider, 'workbuddy-ai')
	assert.equal(aiBody.value.kind, 'credits')
	console.log('I ok: both WorkBuddy variants read their own status route')
}

// J: the unlimited flag overrides the total, and a row without a numeric remain
// is dropped rather than folded in as a zero.
{
	const document = {
		status: 'signed-in',
		credits: {
			total: 0,
			unlimited: true,
			cycleResetTime: '2026-10-01T00:00:00Z',
			accounts: [
				{ packageName: 'enterprise', remain: 0, size: 0, unlimited: true },
				{ packageName: 'broken', remain: 'nonsense', size: 10 },
			],
		},
	}
	const { route } = mountRoute({ respond: (url) => workbuddyRoute(url, document) })
	const { body } = await ask(route, 'provider=workbuddy')
	assert.equal(body.value.unlimited, true)
	assert.equal(body.value.resetTime, '2026-10-01T00:00:00Z')
	assert.equal(body.value.accounts.length, 1, 'the unreadable row is dropped')
	assert.equal(body.value.accounts[0].unlimited, true)
	console.log('J ok: unlimited survives, unreadable rows drop out')
}

// K: a signed-out app and a failed billing read are refusals, not errors: the
// browser half names the reason instead of showing a red failure.
{
	const out = mountRoute({ respond: (url) => workbuddyRoute(url, WORKBUDDY_SIGNED_OUT) })
	const outBody = (await ask(out.route, 'provider=workbuddy')).body
	assert.equal(outBody.ok, true, 'signed out is an answer, not a failure')
	assert.deepEqual(outBody.value, {
		queryable: false,
		reason: 'signed-out',
		provider: 'workbuddy',
		detail: 'no-credential',
	})

	const broke = mountRoute({ respond: (url) => workbuddyRoute(url, WORKBUDDY_CREDITS_ERROR) })
	const brokeBody = (await ask(broke.route, 'provider=workbuddy')).body
	assert.equal(brokeBody.ok, true)
	assert.deepEqual(brokeBody.value, {
		queryable: false,
		reason: 'credits-error',
		provider: 'workbuddy',
		detail: 'billing 500',
	})
	console.log('K:', JSON.stringify(outBody.value), JSON.stringify(brokeBody.value))
}

// L: an absent or disabled owning plugin, and an unreachable web server, each
// degrade to a named refusal rather than a thrown route failure.
{
	const missing = mountRoute({ respond: () => jsonResponse({ error: 'not found' }, 404) })
	const missingBody = (await ask(missing.route, 'provider=workbuddy')).body
	assert.equal(missingBody.ok, true)
	assert.deepEqual(missingBody.value, {
		queryable: false,
		reason: 'source-missing',
		provider: 'workbuddy',
	})

	// No web server service and a non-loopback Host leaves no origin to read from.
	const unreachable = mountRoute({
		webServer: undefined,
		respond: (url) => workbuddyRoute(url, WORKBUDDY_DOCUMENT),
	})
	const unreachableBody = (
		await ask(unreachable.route, 'provider=workbuddy', { host: 'evil.example' })
	).body
	assert.equal(unreachableBody.ok, true)
	assert.equal(unreachableBody.value.reason, 'source-unreachable')
	assert.equal(calls.length, 0, 'a non-loopback Host never becomes a fetch')
	console.log('L:', JSON.stringify(missingBody.value), JSON.stringify(unreachableBody.value))
}

// M: with no web server service the browser's own Host still supplies the
// origin, so a proxied deployment keeps its WorkBuddy reading.
{
	const { route } = mountRoute({
		webServer: undefined,
		respond: (url) => workbuddyRoute(url, WORKBUDDY_DOCUMENT),
	})
	const { body } = await ask(route, 'provider=workbuddy', { host: 'localhost:9999' })
	assert.equal(calls[0].url, 'http://localhost:9999/plugins/dsh-workbuddy-connect/status')
	assert.equal(body.value.kind, 'credits')
	assert.equal(body.value.total, 1289)
	console.log('M ok: the browser Host supplies the origin when the web server service is absent')
}

// N: the cache still applies, so polling the pill does not re-read the other
// plugin's route on every tick.
{
	const { route } = mountRoute({
		config: { minIntervalMs: 0 },
		respond: (url) => workbuddyRoute(url, WORKBUDDY_DOCUMENT),
	})
	await ask(route, 'provider=workbuddy')
	await ask(route, 'provider=workbuddy')
	assert.equal(calls.length, 1, 'a fresh WorkBuddy answer is reused')
	await ask(route, 'provider=workbuddy&refresh=1')
	assert.equal(calls.length, 2, 'refresh bypasses freshness when the floor allows it')
	console.log('N ok: the WorkBuddy reading shares the route cache')
}

// O: Qoder's allowance is read from its own plugin, and its `total` — which
// means CONSUMPTION there, the opposite of WorkBuddy's — is never mistaken for
// a remaining figure.
{
	const { route } = mountRoute({ respond: (url) => qoderRoute(url, QODER_DOCUMENT) })
	const { body } = await ask(route, 'provider=qoder')
	console.log('O:', JSON.stringify(body))
	assert.equal(calls.length, 1, 'no credential is resolved for a Qoder read')
	assert.equal(calls[0].url, 'http://127.0.0.1:3080/plugins/dsh-qoder-connect/status')
	assert.equal(body.ok, true)
	assert.equal(body.value.kind, 'credits')
	assert.equal(body.value.provider, 'qoder')
	// The source said `total: 99.5` (percent consumed). If that leaked into
	// `total`, this figure would read as 99.5 remaining credits instead of 100.
	assert.equal(body.value.total, 100, 'the remaining total is summed from the rows')
	assert.equal(body.value.usedPercent, 99.5, "the source's own percentage is kept separately")
	assert.equal(body.value.totalSize, 200)
	assert.equal(body.value.accounts.length, 2)

	const ai = mountRoute({ respond: (url) => qoderRoute(url, QODER_DOCUMENT) })
	const aiBody = (await ask(ai.route, 'provider=qoder-global')).body
	assert.equal(
		calls[0].url,
		'http://127.0.0.1:3080/plugins/dsh-qoder-connect/global/status',
		'qoder-global reads the international route',
	)
	assert.equal(aiBody.value.provider, 'qoder-global')
	console.log('O ok: both Qoder variants read their own route with the right semantics')
}

// P: a Qoder signed-out document and a Qoder billing failure degrade like the
// WorkBuddy ones, so the browser half needs no per-plugin special case.
{
	const out = mountRoute({ respond: (url) => qoderRoute(url, { status: 'signed-out', reason: 'no-pat' }) })
	const outBody = (await ask(out.route, 'provider=qoder')).body
	assert.equal(outBody.ok, true)
	assert.deepEqual(outBody.value, {
		queryable: false,
		reason: 'signed-out',
		provider: 'qoder',
		detail: 'no-pat',
	})

	const broke = mountRoute({
		respond: (url) => qoderRoute(url, { status: 'signed-in', creditsError: 'billing 500' }),
	})
	const brokeBody = (await ask(broke.route, 'provider=qoder')).body
	assert.equal(brokeBody.ok, true)
	assert.equal(brokeBody.value.reason, 'credits-error')
	assert.equal(brokeBody.value.detail, 'billing 500')
	console.log('P ok: Qoder degradations reuse the credit-source vocabulary')
}

// Q: the settings route reads defaults, accepts a valid patch, persists it, and
// refuses anything it does not recognise.
{
	assert.equal(existsSync(SETTINGS_FILE), false, 'the suite starts with no settings file')
	const { settings } = mountRoute()
	const call = async (method, body) =>
		settings.fetch(
			new Request(`${ORIGIN}/api/dsh.balance.settings`, {
				method,
				...(body === undefined
					? {}
					: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
			}),
		)

	const initial = await (await call('GET')).json()
	assert.equal(initial.ok, true)
	assert.equal(initial.value.placement, 'sidebar', 'the default placement is the sidebar card')
	assert.equal(initial.value.pollMs, 60000)
	assert.equal(initial.value.warnPercent, 20)
	assert.equal(initial.value.unitStyle, 'symbol')
	assert.equal(initial.defaults.pollMs, 60000, 'the defaults travel with the document')
	assert.equal(existsSync(SETTINGS_FILE), false, 'a read never writes the file')

	const written = await (await call('POST', { placement: 'composer', warnPercent: 35 })).json()
	assert.equal(written.ok, true)
	assert.equal(written.value.placement, 'composer')
	assert.equal(written.value.warnPercent, 35)
	assert.equal(written.value.pollMs, 60000, 'an untouched field keeps its value')
	assert.equal(existsSync(SETTINGS_FILE), true, 'the write lands on disk')
	const onDisk = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
	assert.equal(onDisk.placement, 'composer')
	assert.equal(onDisk.warnPercent, 35)

	// A second mount reads what the first one wrote.
	const reread = await (await mountRoute().settings.fetch(new Request(`${ORIGIN}/api/dsh.balance.settings`))).json()
	assert.equal(reread.value.placement, 'composer', 'the file is the source of truth')
	assert.equal(reread.value.warnPercent, 35)

	// Bounds and enums are enforced, not merely documented.
	const badEnum = await call('POST', { placement: 'nowhere' })
	assert.equal(badEnum.status, 400)
	const badNumber = await call('POST', { warnPercent: 500 })
	assert.equal(badNumber.status, 400)
	const badField = await call('POST', { nonsense: true })
	assert.equal(badField.status, 400)
	const notJson = await settings.fetch(
		new Request(`${ORIGIN}/api/dsh.balance.settings`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{oops',
		}),
	)
	assert.equal(notJson.status, 400)
	// The rejected writes must not have changed anything.
	const after = await (await call('GET')).json()
	assert.equal(after.value.placement, 'composer')
	assert.equal(after.value.warnPercent, 35)

	// `none` is a legitimate placement: hiding the readout must not require
	// disabling the plugin, so the host must accept and persist it.
	const hidden = await (await call('POST', { placement: 'none' })).json()
	assert.equal(hidden.ok, true, 'the none placement is accepted')
	assert.equal(hidden.value.placement, 'none')
	assert.equal(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).placement, 'none', 'and it is persisted')
	const restored = await (await call('POST', { placement: 'sidebar' })).json()
	assert.equal(restored.value.placement, 'sidebar', 'and it can be switched back')

	// The stroke switch is a boolean, so it must reject a non-boolean and survive
	// a round trip like every other field.
	assert.equal(initial.value.cardBorder, true, 'the stroke defaults to on')
	const noStroke = await (await call('POST', { cardBorder: false })).json()
	assert.equal(noStroke.value.cardBorder, false, 'the stroke switch is persisted')
	assert.equal(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).cardBorder, false)
	assert.equal((await call('POST', { cardBorder: 'yes' })).status, 400, 'a non-boolean is refused')
	const stillOff = await (await call('GET')).json()
	assert.equal(stillOff.value.cardBorder, false, 'the refused write changed nothing')
	await call('POST', { cardBorder: true })
	console.log('Q ok: settings read, write, persist, and reject invalid input')
}

// R: a null value resets one field to its default, and a hand-edited file with
// one bad value does not cost the user every other setting.
{
	writeFileSync(
		SETTINGS_FILE,
		JSON.stringify({ placement: 'both', pollMs: 'nonsense', unitStyle: 'name', extra: 1 }),
		'utf8',
	)
	const { settings } = mountRoute({ config: { minRequestIntervalMs: 0 } })
	const document = await (await settings.fetch(new Request(`${ORIGIN}/api/dsh.balance.settings`))).json()
	assert.equal(document.value.placement, 'both', 'a valid stored field is honoured')
	assert.equal(document.value.unitStyle, 'name', 'as is every other valid field')
	assert.equal(document.value.pollMs, 60000, 'the invalid field alone falls back to its default')

	const reset = await settings.fetch(
		new Request(`${ORIGIN}/api/dsh.balance.settings`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ placement: null }),
		}),
	)
	assert.equal((await reset.json()).value.placement, 'sidebar', 'null restores the default')
	console.log('R ok: partial resets and per-field validation')
}

// S: currency readings carry an explicit unit, so the browser never has to guess
// whether a number is money or a credit count.
{
	const { route } = mountRoute()
	const { body } = await ask(route, 'provider=deepseek')
	assert.equal(body.value.kind, 'currency')
	assert.equal(body.value.unit, 'currency', 'a money reading declares itself as money')
	const kimi = mountRoute({
		respond: () => jsonResponse(BODIES['kimi-coding']),
	})
	const quota = (await ask(kimi.route, 'provider=kimi-coding')).body
	assert.equal(quota.value.unit, 'requests', 'a quota reading declares its own unit')
	console.log('S ok: every reading states its unit')
}

// T: the subscription routes. dsh-plugin-subscriptions serves codex, claude,
// grok, copilot and antigravity; its usage is read in the BROWSER, straight
// from that plugin's own RPC channel, so the host route must never answer for
// these ids — not even grok, whose API-billing alias exists for a bare xAI key.
{
	const { route } = mountRoute({ respond: () => jsonResponse({ unexpected: true }) })
	for (const provider of ['codex', 'claude', 'grok', 'copilot', 'antigravity']) {
		const { body } = await ask(route, `provider=${provider}`)
		assert.equal(body.ok, true, `${provider} answers`)
		assert.deepEqual(body.value, { queryable: false, reason: 'no-balance-api', provider }, `${provider} is refused, not read upstream`)
	}
	assert.equal(calls.length, 0, 'no upstream billing call is ever made for a subscription route')
	console.log('T ok: subscription routes are left to the browser half (grok included)')
}

console.log('\nOK: route contract, provider resolution, settings overrides, cache and failure shapes verified')

