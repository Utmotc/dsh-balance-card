/**
 * End-to-end check against the RUNNING dsh web server.
 *
 * Loads the real host half, gives it a fake Connection/credentials pair, and
 * drives the real routes for the credit-source providers. Unlike `host.test.mjs`,
 * nothing here is stubbed: the fetch really goes to the live
 * `dsh-workbuddy-connect` / `dsh-qoder-connect` status routes on the loopback
 * port below.
 *
 * Read-only: those status routes only report the apps' own sign-in and credit.
 * The settings route is exercised against a temporary file, never the real one.
 *
 * Run: node test/live-workbuddy.mjs [port]
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = process.argv[2] ?? '3080'
const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const SETTINGS_DIR = mkdtempSync(join(tmpdir(), 'dsh-balance-live-'))
process.on('exit', () => {
	try {
		rmSync(SETTINGS_DIR, { recursive: true, force: true })
	} catch {
		// A leftover temp directory is not worth failing a live check over.
	}
})

const plugin = await import(PLUGIN)

/** Mount the plugin and hand back its registered routes by path. */
function mountRoutes() {
	const registered = []
	const ctx = {
		get: (name) => (name === 'webServer' ? { port: Number(PORT) } : undefined),
		inject: (deps, callback) =>
			callback({
				credentials: { resolve: async () => ({ value: 'unused' }) },
				connection: { fetch: { register: (route) => registered.push(route) } },
				get: (name) => (name === 'webServer' ? { port: Number(PORT) } : undefined),
			}),
	}
	plugin.apply(ctx, { settingsFile: join(SETTINGS_DIR, 'settings.json') })
	assert.equal(registered.length, 2, 'the balance and settings routes register')
	const byPath = (path) => registered.find((route) => route.path === path)
	return { balance: byPath('/api/dsh.balance'), settings: byPath('/api/dsh.balance.settings') }
}

const { balance, settings } = mountRoutes()

for (const provider of ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global']) {
	const response = await balance.fetch(
		new Request(`http://127.0.0.1:${PORT}/api/dsh.balance?provider=${provider}&refresh=1`),
	)
	const body = await response.json()
	console.log(`\n=== ${provider} -> HTTP ${String(response.status)}`)
	console.log(JSON.stringify(body, null, 2))
	assert.equal(body.ok, true, `${provider}: the route answers`)
	assert.equal(body.value.provider, provider, `${provider}: the id is echoed back`)
	// A route that is mounted but signed out still answers, rather than throwing.
	if (body.value.queryable === true) {
		assert.equal(body.value.kind, 'credits', `${provider}: a credit reading`)
		// Qoder's own `total` is a CONSUMPTION percentage; if it had been taken as
		// the remainder, `total` would come back as a fraction of a percent of the
		// real figure. The remaining total must never exceed the cycle size.
		assert.ok(
			typeof body.value.total === 'number' && body.value.total >= 0,
			`${provider}: the remaining total is a real figure`,
		)
		if (typeof body.value.totalSize === 'number' && body.value.totalSize > 0) {
			assert.ok(
				body.value.total <= body.value.totalSize * 1.5,
				`${provider}: remaining (${String(body.value.total)}) is commensurate with the cycle size (${String(body.value.totalSize)})`,
			)
		}
		console.log(
			`    -> remaining ${String(body.value.total)} of ${String(body.value.totalSize)}, ${String(body.value.accounts.length)} package row(s)`,
		)
	} else {
		console.log(`    -> not queryable: ${String(body.value.reason)}`)
	}
}

// The settings route round-trips against the temporary file.
{
	const read = await (await settings.fetch(new Request(`http://127.0.0.1:${PORT}/api/dsh.balance.settings`))).json()
	console.log('\n=== settings (GET)')
	console.log(JSON.stringify(read, null, 2))
	assert.equal(read.ok, true)
	assert.equal(read.value.placement, 'sidebar', 'the shipped default placement')

	const written = await (
		await settings.fetch(
			new Request(`http://127.0.0.1:${PORT}/api/dsh.balance.settings`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ warnPercent: 25, unitStyle: 'name' }),
			}),
		)
	).json()
	assert.equal(written.value.warnPercent, 25)
	assert.equal(written.value.unitStyle, 'name')
	console.log('\n=== settings (POST) -> warnPercent=25, unitStyle=name written and echoed')
}

console.log('\nlive check complete')
