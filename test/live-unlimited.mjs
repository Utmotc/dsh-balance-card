/**
 * Regression probe for the Qoder `unlimited` bug.
 *
 * The live Qoder document sets `unlimited: true` at the TOP level because its
 * personal-allowance row is uncapped, while the rest of the document still
 * carries real figures. The readout must show those figures, not 「不限额」.
 *
 * Run: node test/live-unlimited.mjs [port]
 */
import assert from 'node:assert/strict'

const PORT = process.argv[2] ?? '3080'
const SOURCES = ['workbuddy', 'workbuddy-ai', 'qoder', 'qoder-global']
const PLUGIN = new URL('../lib/index.js', import.meta.url).href

const plugin = await import(PLUGIN)

function mountBalance() {
	const registered = []
	plugin.apply(
		{
			get: (name) => (name === 'webServer' ? { port: Number(PORT) } : undefined),
			inject: (deps, callback) =>
				callback({
					credentials: { resolve: async () => ({ value: 'unused' }) },
					connection: { fetch: { register: (route) => registered.push(route) } },
					get: (name) => (name === 'webServer' ? { port: Number(PORT) } : undefined),
				}),
		},
		{ settingsFile: undefined },
	)
	return registered.find((route) => route.path === '/api/dsh.balance')
}

const balance = mountBalance()

for (const provider of SOURCES) {
	const body = await (
		await balance.fetch(
			new Request(`http://127.0.0.1:${PORT}/api/dsh.balance?provider=${provider}&refresh=1`),
		)
	).json()
	const value = body.value
	if (value.queryable !== true) {
		console.log(`${provider}: not queryable (${value.reason}) — nothing to hide here`)
		continue
	}
	const remain = (value.accounts ?? []).reduce((sum, account) => sum + account.remain, 0)
	const size = (value.accounts ?? []).reduce((sum, account) => sum + account.size, 0)
	console.log(`\n${provider}`)
	console.log(`  unlimited flag : ${String(value.unlimited)}`)
	console.log(`  total / size   : ${String(value.total)} / ${String(value.totalSize)}`)
	console.log(`  rows           : ${String((value.accounts ?? []).length)}`)
	console.log(`  summed         : ${String(remain)} / ${String(size)}`)
	if (value.unlimited === true) {
		// The flag must never be the reason a figure disappeared: the reading still
		// has to carry whatever counts it actually received.
		assert.equal(
			value.total,
			remain,
			`${provider}: the headline stays the summed remainder even when unlimited is set`,
		)
		console.log('  -> unlimited is set, yet a real figure is still reported (correct)')
	}
}

console.log('\nprobe complete')
