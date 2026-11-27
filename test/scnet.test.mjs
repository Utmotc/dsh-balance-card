/**
 * SCNet console contract self-check.
 *
 * Exercises only lib/scnet.js: the Cookie validator, the Token Plan row
 * selector, the cash-balance reader and the two-endpoint composition. No DSH
 * process, no real network, no Cookie.
 *
 * Run: node test/scnet.test.mjs
 */
import assert from 'node:assert/strict'

import {
	SCNET_BALANCE_URL,
	SCNET_TOKEN_PLAN_URL,
	ScnetAuthError,
	isScnetLoginFailure,
	normalizeScnetCookie,
	parseScnetBalance,
	parseScnetTokenPlan,
	readScnetConsole,
} from '../lib/scnet.js'

/** @param body - decoded document. @returns a JSON response. */
function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// A: the Cookie validator refuses what is not a Cookie header.
{
	assert.equal(normalizeScnetCookie('SESSION=abc; token=def'), 'SESSION=abc; token=def')
	assert.equal(normalizeScnetCookie('  Cookie: SESSION=abc  '), 'SESSION=abc')
	for (const bad of ['', '   ', 'sk-tp-abc', 'SESSION=a\r\nx-injected: 1', 'x'.repeat(17000), null, 42]) {
		assert.equal(normalizeScnetCookie(bad), null, `${String(bad).slice(0, 24)} is not a Cookie`)
	}
	console.log('A ok: only a plausible Cookie header is accepted')
}

// B: the Token Plan reader follows the console's own candidate names.
{
	const candidates = [
		{ totalAmount: 100, usedAmount: 25 },
		{ All: 100, used: 25 },
		{ totalCredits: 100, remainingCredits: 75 },
		{ planCredits: 100, usedCredits: 25 },
		{ monthlyCredits: 100, consumedCredits: 25 },
		{ quota: 100, usage: 25 },
	]
	for (const row of candidates) {
		const reading = parseScnetTokenPlan({ code: '0', data: [row] })
		assert.ok(reading !== null, `${Object.keys(row).join('/')} is understood`)
		assert.equal(reading.limit, 100)
		assert.equal(reading.used, 25)
		assert.equal(reading.remaining, 75)
		assert.equal(reading.unit, 'credits')
		assert.equal(reading.dims.length, 1)
		assert.equal(reading.dims[0].window, 'monthly')
	}
	console.log('B ok: every field-name family the console has used reads the same meter')
}

// C: envelope shapes: bare array, data, data.records, data.list, date.
{
	const row = { totalCredits: 10, usedCredits: 4, name: '基础版' }
	for (const body of [
		[row],
		{ code: '0', data: [row] },
		{ code: '0', data: { records: [row] } },
		{ code: '0', data: { list: [row] } },
		{ date: [row] },
	]) {
		const reading = parseScnetTokenPlan(body)
		assert.ok(reading !== null, JSON.stringify(body).slice(0, 40))
		assert.equal(reading.remaining, 6)
		assert.equal(reading.planLabel, '基础版')
	}
	console.log('C ok: every documented envelope shape unwraps')
}

// D: selection: the active subscription wins over a disabled/expired one.
{
	const reading = parseScnetTokenPlan({
		code: '0',
		data: [
			{ name: '过期', global: true, totalCredits: 10, usedCredits: 10, maxExpireTime: '2000-01-01 00:00:00' },
			{ name: '停用', status: 'disable', totalCredits: 10, usedCredits: 1, maxExpireTime: '2099-01-01 00:00:00' },
			{ name: '生效', status: 'enable', totalCredits: 20, usedCredits: 5, maxExpireTime: '2099-06-01 00:00:00' },
			{ name: '生效但更早', status: 'enable', totalCredits: 30, usedCredits: 5, maxExpireTime: '2099-03-01 00:00:00' },
		],
	})
	assert.equal(reading.planLabel, '生效', 'active plans win, latest expiry first')
	assert.equal(reading.limit, 20)
	console.log('D ok: active rows win; a disabled or expired row is not the current plan')
}

// E: reset time fallback and expiry are wall-clock China time.
{
	const reading = parseScnetTokenPlan({
		code: '0',
		data: [
			{
				totalCredits: 100,
				usedCredits: 1,
				maxExpireTime: '2099-11-18 23:59:59',
			},
		],
	})
	assert.equal(reading.expiresAt, new Date('2099-11-18T23:59:59+08:00').toISOString())
	assert.equal(
		reading.dims[0].resetTime,
		new Date(new Date('2099-11-18T23:59:59+08:00').getTime() + 1000).toISOString(),
		'without a reset field, the reset is the expiring second plus one'
	)

	const explicit = parseScnetTokenPlan({
		code: '0',
		data: [{ totalCredits: 100, usedCredits: 1, resetTime: '2099-11-19 00:00:00' }],
	})
	assert.equal(explicit.dims[0].resetTime, new Date('2099-11-19T00:00:00+08:00').toISOString())
	console.log('E ok: CST wall-clock expiry, and the documented reset fallback')
}

// F: rows without a usable meter are skipped rather than read as zero.
{
	assert.equal(parseScnetTokenPlan({ code: '0', data: [] }), null)
	assert.equal(parseScnetTokenPlan({ code: '0', data: [{ name: '只有目录额度', totalCredits: 60000 }] }), null)
	assert.equal(parseScnetTokenPlan({ code: '0', data: [{ totalCredits: 0, usedCredits: 0 }] }), null)
	assert.equal(
		parseScnetTokenPlan({
			code: '0',
			data: [{ totalCredits: 10, usedCredits: 10, maxExpireTime: '2000-01-01 00:00:00' }],
		}),
		null,
		'an expired-only list is history, not a current reading'
	)
	console.log('F ok: unusable or expired rows produce no reading, never a fabricated zero')
}

// G: the cash reader accepts the balance / cash / gift families.
{
	const direct = parseScnetBalance({ code: '0', data: { balance: 12.345, cashBalance: 10, giftBalance: 2.345 } })
	assert.equal(direct.currency, 'CNY')
	assert.equal(direct.balance, 12.35, 'money keeps two decimals')
	assert.equal(direct.toppedUp, 10)
	assert.equal(direct.granted, 2.35)

	const summed = parseScnetBalance({ code: '0', data: { rechargeBalance: 8, presentBalance: 1.5 } })
	assert.equal(summed.balance, 9.5, 'cash + gift adds up when no total is stated')

	const nested = parseScnetBalance({ data: { data: { availableBalance: '7.00' } } })
	assert.equal(nested.balance, 7)

	const bare = parseScnetBalance({ accountBalance: 0 })
	assert.equal(bare.balance, 0, 'a real zero is a reading')

	assert.equal(parseScnetBalance({ code: '0', data: { unrelated: 1 } }), null)
	assert.equal(parseScnetBalance({ code: '500', msg: 'boom' }), null)
	console.log('G ok: balance candidates, cash + gift fallback, and honest nulls')
}

// H: the two-endpoint reader composes one reading.
{
	const originalFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init })
		if (String(url) === SCNET_TOKEN_PLAN_URL) {
			return jsonResponse({
				code: '0',
				data: [{ status: 'enable', planCredits: 60000, usedCredits: 1234.5, name: '基础版' }],
			})
		}
		if (String(url) === SCNET_BALANCE_URL) return jsonResponse({ code: '0', data: { balance: 56.78 } })
		return jsonResponse({}, 404)
	}
	try {
		const reading = await readScnetConsole('SESSION=abc', 1000)
		assert.equal(reading.kind, 'quota')
		assert.equal(reading.remaining, 58765.5)
		assert.equal(reading.cash.balance, 56.78)
		assert.equal(reading.endpoint, SCNET_TOKEN_PLAN_URL)
		assert.equal(calls.length, 2)
		assert.equal(calls[0].init.headers.cookie, 'SESSION=abc')
		assert.equal(calls[1].init.method, 'POST')
		assert.equal(calls[1].init.body, '{}')
	} finally {
		globalThis.fetch = originalFetch
	}
	console.log('H ok: Token Plan + cash compose one reading with one Cookie')
}

// I: missing plan, failed balance, and a dead session are three outcomes.
{
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		if (String(url) === SCNET_TOKEN_PLAN_URL) return jsonResponse({ code: '0', data: [] })
		return jsonResponse({ code: '0', data: { balance: 3 } })
	}
	try {
		const reading = await readScnetConsole('SESSION=abc', 1000)
		assert.equal(reading.kind, 'currency')
		assert.equal(reading.balance, 3)
		assert.equal(reading.planMissing, true)
	} finally {
		globalThis.fetch = originalFetch
	}

	globalThis.fetch = async (url) => {
		if (String(url) === SCNET_TOKEN_PLAN_URL) return jsonResponse({ code: '0', data: [{ totalCredits: 10, usedCredits: 1 }] })
		return new Response('boom', { status: 500 })
	}
	try {
		const reading = await readScnetConsole('SESSION=abc', 1000)
		assert.equal(reading.kind, 'quota')
		assert.equal(reading.cash, undefined)
		assert.match(reading.cashError, /HTTP 500/u)
	} finally {
		globalThis.fetch = originalFetch
	}

	globalThis.fetch = async () => jsonResponse({ code: '401', msg: '用户未登录!', data: {} }, 401)
	try {
		await assert.rejects(
			() => readScnetConsole('SESSION=abc', 1000),
			(error) => error instanceof ScnetAuthError && /登录已失效/u.test(error.message),
		)
	} finally {
		globalThis.fetch = originalFetch
	}
	console.log('I ok: cash-only, plan-only and expired-session outcomes stay distinct')
}

// J: the auth detector matches every shape the console has used.
{
	assert.equal(isScnetLoginFailure({ code: '401', msg: '用户未登录!' }), true)
	assert.equal(isScnetLoginFailure({ code: 403 }), true)
	assert.equal(isScnetLoginFailure({ code: '0', msg: 'success' }), false)
	assert.equal(isScnetLoginFailure({ message: 'login required' }), true)
	assert.equal(isScnetLoginFailure(null), false)
	console.log('J ok: auth failures are recognised in both HTTP and envelope form')
}

console.log('\nOK: SCNet Cookie, Token Plan and cash-balance contract verified')
