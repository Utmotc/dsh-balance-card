/**
 * 百度千帆限流阀门自检（纯逻辑 + 控制器）。
 *
 * 不启动 DSH、不发网络请求：时钟与 sleep 都是注入的虚拟实现，所以「排队 60 秒」
 * 在测试里是几十次微任务。
 *
 * Run: node test/throttle.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	MAX_QUEUE_DEPTH,
	PRIOR_UNKNOWN,
	applyAdmission,
	applyCompletion,
	applyDailyUpkeep,
	applyGrowth,
	applyLimitSignal,
	applyRateLimit,
	calibrate,
	classifyFailure,
	createRouteState,
	estimateRequestTokens,
	needTokens,
	planAdmission,
	pruneWindow,
	reserveOutputTokens,
	resetLearning,
	resolveTargets,
	statusOf,
} from '../lib/throttle.js'
import { createThrottleHost, isQianfanProvider, throttleSettings } from '../lib/throttle-host.js'
import { loadThrottleState, writeThrottleState } from '../lib/throttle-state.js'

const DIR = mkdtempSync(join(tmpdir(), 'dsh-throttle-test-'))
const STATE_FILE = join(DIR, 'throttle-state.json')
process.on('exit', () => {
	try {
		rmSync(DIR, { recursive: true, force: true })
	} catch {
		// 一个残留的临时目录不值得让测试失败。
	}
})

const MINUTE = 60_000

/** 一份设置文档，字段名与 balance-settings.json 一致。 */
const settingsOf = (patch = {}) => ({
	throttleEnabled: true,
	throttleMode: 'manual',
	throttleSafety: 0.7,
	throttleMaxConcurrent: 2,
	throttleCooldownCapMs: 600_000,
	throttlePreset: 'mid',
	throttleManual: {
		low: { rpm: 2, tpm: 8_000, concurrency: 1 },
		mid: { rpm: 6, tpm: 30_000, concurrency: 2 },
		high: { rpm: 15, tpm: 80_000, concurrency: 3 },
	},
	...patch,
})

/** 一个小请求：RPM 是它的主闸门，TPM 远未触顶。 */
const smallRequest = (provider = 'baiduqianfan', model = 'deepseek-v4.1-flash-1017') => ({
	provider,
	model,
	messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
	maxTokens: 64,
})

/** 一个 25k token 量级的请求，用来触发 TPM 闸门与超大请求例外。 */
const bigRequest = (text) => ({
	provider: 'baiduqianfan',
	model: 'deepseek-v4.1-flash-1017',
	messages: [{ role: 'user', content: [{ type: 'text', text }] }],
	maxTokens: 4096,
})

/** 以虚拟时间驱动控制器：`sleep` 直接把时钟往前拨。 */
function virtualHost({ settings = settingsOf(), queueTimeoutMs, clock = { at: 1_700_000_000_000 } } = {}) {
	let current = settingsOf(settings)
	if (queueTimeoutMs !== undefined) current = { ...current, throttleQueueTimeoutMs: queueTimeoutMs }
	const host = createThrottleHost({
		readSettings: () => current,
		stateFile: STATE_FILE,
		now: () => clock.at,
		sleep: async (ms) => {
			clock.at += Math.max(1, ms)
		},
	})
	const listeners = []
	const ctx = {
		on: (name, listener) => {
			listeners.push({ name, listener })
			return () => {}
		},
	}
	host.attach(ctx)
	return {
		host,
		clock,
		setSettings: (next) => {
			current = settingsOf(next)
		},
		gate: (request) => listeners.find((entry) => entry.name === 'llm/stream').listener(request, () => streamOf()),
		close: () => host.dispose(),
	}
}

/** 一条成功的假流：usage + finish。 */
async function* streamOf(usage = { inputTokens: 10, outputTokens: 5 }) {
	yield { type: 'block-start', index: 0, blockType: 'text' }
	yield { type: 'text-delta', index: 0, text: 'ok' }
	yield { type: 'usage', usage }
	yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 一条被 429 拒绝的假流。 */
async function* rateLimitedStream() {
	yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: '429' } } }
}

/** 把一条 async iterable 全部消费掉。 */
async function collect(iterable) {
	const chunks = []
	for await (const chunk of iterable) chunks.push(chunk)
	return chunks
}

/* ── 1. 估算 ───────────────────────────────────────────────────────────── */

{
	const chinese = estimateRequestTokens({
		messages: [{ role: 'user', content: [{ type: 'text', text: '一二三四五' }] }],
	})
	// 5 个汉字 = 5 token，块开销 4，消息开销 4。
	assert.equal(chinese, 13, 'CJK 按 1 字 1 token 计，而不是 char/4')

	const english = estimateRequestTokens({
		messages: [{ role: 'user', content: [{ type: 'text', text: 'abcdefgh' }] }],
	})
	// 8 个 ASCII = 2 token。
	assert.equal(english, 10, 'ASCII 按 4 字符 1 token 计')

	const withTools = estimateRequestTokens({
		messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
		tools: [{ name: 'read', description: '读文件', parameters: {} }],
	})
	assert.ok(withTools > english, '工具 schema 要计入请求体积')
	console.log('1 ok: token 估算按 CJK 与 ASCII 分开计价，工具 schema 计入')
}

{
	assert.equal(reserveOutputTokens({ maxTokens: 500 }, createRouteState({ provider: 'p', model: 'm' })), 500)
	assert.equal(reserveOutputTokens({}, createRouteState({ provider: 'p', model: 'm' })), 1024, '未知时兜底 1024')
	const sampled = {
		...createRouteState({ provider: 'p', model: 'm' }),
		outputSamples: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
	}
	const p95 = reserveOutputTokens({}, sampled)
	assert.ok(p95 >= 90 && p95 <= 100, `未知 max_tokens 时用最近输出的 P95（实际 ${String(p95)}）`)
	console.log('1b ok: 输出预留取 max_tokens / P95 / 1024')
}

/* ── 2. 准入公式 ───────────────────────────────────────────────────────── */

{
	const state = createRouteState({ provider: 'p', model: 'm', prior: { rpm: 6, tpm: 30_000 } })
	const manual = { mode: 'manual', preset: 'mid', manual: settingsOf().throttleManual, safety: 0.7, maxConcurrent: 2 }
	const targets = resolveTargets(manual, state, 0)
	assert.equal(targets.rpm, 6)
	assert.equal(targets.tpm, 30_000)
	assert.equal(targets.concurrency, 2)

	// RPM 未满、TPM 未满、并发未满：立刻放行。
	assert.equal(planAdmission(state, 0, 100, targets).admitted, true)

	// 塞满并发：等一个名额。
	const busy = { ...state, inFlight: 2 }
	const blocked = planAdmission(busy, 0, 100, targets)
	assert.equal(blocked.admitted, false)
	assert.equal(blocked.reason, 'concurrency')

	// 塞满 RPM：等到最老的那条滑出窗口（这些请求都已完成，在飞数为 0）。
	let filled = state
	for (let index = 0; index < 6; index += 1) filled = { ...applyAdmission(filled, 0, 100).state, inFlight: 0 }
	const rpmPlan = planAdmission(filled, 1_000, 100, targets)
	assert.equal(rpmPlan.admitted, false)
	assert.equal(rpmPlan.reason, 'rpm')
	assert.equal(rpmPlan.waitMs, MINUTE - 1_000, '等待时间 = 最早一条滑出的时刻')

	// TPM 闸门：单条 20k 已过半，再来一条就超 30k（这条本身 20k > 15k → 超大请求例外）。
	const near = applyAdmission(state, 0, 20_000).state
	const tpmPlan = planAdmission(near, 1_000, 12_000, targets)
	assert.equal(tpmPlan.admitted, false, '12k 本身不大，但窗口里已有 20k → 32k 超 30k 的 TPM 闸门')
	assert.equal(tpmPlan.reason, 'tpm')

	// 超大请求只绕开 TPM，不绕开 RPM/并发/冷却。
	const oversize = planAdmission(near, 1_000, 40_000, targets)
	assert.equal(oversize.admitted, true)
	assert.equal(oversize.oversize, true)
	const oversizeBlocked = planAdmission({ ...near, inFlight: 2 }, 1_000, 40_000, targets)
	assert.equal(oversizeBlocked.admitted, false, '超大请求仍要等并发名额')

	// 冷却：全局暂停。
	const cooling = { ...state, cooldownUntil: 30_000 }
	const cold = planAdmission(cooling, 0, 10, targets)
	assert.equal(cold.admitted, false)
	assert.equal(cold.reason, 'cooldown')
	assert.equal(cold.waitMs, 30_000)

	// 无限制档：不排队，但仍然保留冷却。
	const unlimited = resolveTargets(
		{ mode: 'manual', preset: 'unlimited', manual: {}, safety: 0.7, maxConcurrent: 2 },
		state,
		0,
	)
	assert.equal(unlimited.unlimited, true)
	assert.equal(planAdmission(state, 0, 1_000_000, unlimited).admitted, true)
	assert.equal(planAdmission(cooling, 0, 10, unlimited).admitted, false, '无限制也要守冷却')
	console.log('2 ok: RPM/TPM/并发/冷却四条闸门与超大请求例外（只绕 TPM）')
}

/* ── 3. 惩罚、恢复、每日衰减 ───────────────────────────────────────────── */

{
	let state = createRouteState({ provider: 'baiduqianfan', model: 'm', prior: { rpm: 6, tpm: 30_000 } })
	const prior = { ...state.prior }
	state = applyRateLimit(state, 0, { cooldownCapMs: 600_000 })
	assert.equal(state.cooldownMs, 15_000, '第一次 429：冷却 15 秒（重试要来得及）')
	assert.equal(state.cooldownUntil, 15_000)
	assert.equal(state.learned.rpm, 3)
	assert.equal(state.learned.tpm, 15_000)
	assert.equal(state.consecutive429, 1)
	assert.equal(state.daily429.count, 1, '按"风暴"计一次')
	assert.equal(state.stormHits, 1)

	// 冷却期内（DSH 重试同一次请求的窗口）再次 429：同一风暴 —— 只加长冷却，
	// 不再折半、不再计安全模式，否则一次抖动就会把账号钉死在最低速。
	state = applyRateLimit(state, 1_000, { cooldownCapMs: 600_000 })
	assert.equal(state.cooldownMs, 30_000, '同一次风暴：冷却 30 秒')
	assert.equal(state.stormHits, 2)
	assert.deepEqual(state.learned, { rpm: 3, tpm: 15_000 }, '同一风暴不重复折半')
	assert.equal(state.consecutive429, 1, '同一风暴只算一次连续触限')
	assert.equal(state.daily429.count, 1)
	state = applyRateLimit(state, 2_000, { cooldownCapMs: 600_000 })
	assert.equal(state.cooldownMs, 60_000, '同一次风暴：冷却 60 秒')

	// 冷却结束、静默窗口之后再来一次 429：新的风暴，重新从 15 秒开始并折半。
	const stormTwoAt = state.cooldownUntil + 20_000 + 1
	state = applyRateLimit(state, stormTwoAt, { cooldownCapMs: 600_000 })
	assert.equal(state.cooldownMs, 15_000, '新风暴：冷却重新从 15 秒开始')
	assert.equal(state.consecutive429, 2)
	assert.equal(state.daily429.count, 2)
	assert.equal(state.stormHits, 1, '风暴计数器重置')
	assert.deepEqual(state.learned, { rpm: 1.5, tpm: 7_500 }, '新风暴才折半')
	const stormThreeAt = state.cooldownUntil + 20_000 + 1
	state = applyRateLimit(state, stormThreeAt, { cooldownCapMs: 600_000 })
	assert.equal(state.safeMode, true, '连续第三个风暴触发日安全模式')
	assert.equal(state.consecutive429, 3)
	assert.ok(
		state.learned.rpm <= prior.rpm * 0.25 && state.learned.tpm <= prior.tpm * 0.25,
		`三个风暴后 learned 降到先验 25% 以下（${String(state.learned.rpm)} rpm / ${String(state.learned.tpm)} tpm）`,
	)
	// 安全模式里不再自动增长。
	const afterSafe = { ...state, cooldownUntil: 0, consecutive429: 0, cleanSince: 0, lastGrowAt: 0 }
	assert.equal(applyGrowth(afterSafe, 10 * MINUTE).learned, afterSafe.learned, '安全模式停止增长')

	// 冷却后第一级恢复是 learned*0.6。
	const recovering = { ...state, safety: 0.7, cooldownUntil: 1_000, safeMode: false }
	const targets = resolveTargets(
		{ mode: 'dynamic', preset: 'mid', manual: undefined, safety: 0.7, maxConcurrent: 2 },
		recovering,
		2_000,
	)
	assert.equal(targets.factor, 0.6, '冷却结束后先按 0.6 倍恢复')
	const later = resolveTargets(
		{ mode: 'dynamic', preset: 'mid', manual: undefined, safety: 0.7, maxConcurrent: 2 },
		recovering,
		1_000 + 120_000 + 1,
	)
	assert.equal(later.factor, 0.7, '两分钟无 429 后回到安全系数')

	// 增长：+5%，且不超过历史 ceiling。
	let grown = createRouteState({ provider: 'p', model: 'm', prior: { rpm: 6, tpm: 30_000 } })
	grown = { ...grown, learned: { rpm: 2, tpm: 8_000 }, ceiling: { rpm: 6, tpm: 30_000 } }
	grown = { ...grown, cooldownUntil: 1_000, cleanSince: 10_000, lastGrowAt: 0 }
	const at = 1_000 + 60_000 + 10 * MINUTE
	const first = applyGrowth(grown, at)
	assert.ok(first.learned.rpm > grown.learned.rpm && first.learned.rpm <= grown.ceiling.rpm)
	assert.equal(first.lastGrowAt, at)
	const tooSoon = applyGrowth(first, at + MINUTE)
	assert.equal(tooSoon.learned, first.learned, '5 分钟内不再增长')
	const capped = applyGrowth({ ...first, learned: { rpm: 6, tpm: 30_000 } }, at + 10 * MINUTE)
	assert.equal(capped.learned.rpm, 6, '增长被 ceiling 挡住')

	// 每日衰减只动 ceiling，且不低于 learned；第一天的记录不衰减。
	const decayed = applyDailyUpkeep({ ...grown, daily429: { day: '2000-01-01', count: 4 } }, Date.UTC(2026, 0, 2))
	assert.ok(decayed.ceiling.rpm < grown.ceiling.rpm, '跨天后 ceiling 乘 0.95')
	assert.equal(decayed.daily429.count, 0)
	assert.equal(decayed.safeMode, grown.safeMode, '跨天不自动退出安全模式')
	const sameDayLow = { ...grown, learned: { rpm: 6, tpm: 30_000 }, ceiling: { rpm: 6, tpm: 30_000 } }
	const cappedDecay = applyDailyUpkeep({ ...sameDayLow, daily429: { day: '2000-01-01', count: 0 } }, Date.UTC(2026, 0, 2))
	assert.equal(cappedDecay.ceiling.rpm, 6, '衰减后 ceiling 仍然不低于 learned')
	const firstRun = applyDailyUpkeep({ ...grown, daily429: { day: '', count: 0 } }, Date.UTC(2026, 0, 2))
	assert.deepEqual(firstRun.ceiling, grown.ceiling, '首次运行不衰减：装好的第一秒不该白掉 5% 上界')
	assert.equal(firstRun.daily429.day, '2026-01-02', '但日期照记')

	// 重置回到先验，并清掉安全模式。
	const reset = resetLearning(state, 0)
	assert.deepEqual(reset.learned, { rpm: 6, tpm: 30_000 })
	assert.equal(reset.safeMode, false)
	assert.equal(reset.cooldownUntil, 0)
	console.log('3 ok: 15/30/60 冷却、同风暴只罚一次、25% 惩罚、安全模式、0.6 恢复、+10% 增长与每日衰减')
}

/* ── 4. 用量校准与失败分类 ─────────────────────────────────────────────── */

{
	const state = createRouteState({ provider: 'p', model: 'm' })
	const applied = applyAdmission(state, 0, 1000)
	const completed = applyCompletion(applied.state, applied.ticket, {
		usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 200 },
		ok: true,
		now: 1_000,
	})
	assert.equal(completed.inFlight, 0)
	assert.equal(completed.window[0].tokens, 1_200, '真实用量回填那一条，不重复计费')
	assert.ok(completed.estRatio > 1, 'actual > est 时校准系数上升')
	assert.equal(completed.outputSamples.at(-1), 100)

	const ratio = calibrate(1, 10, 100)
	assert.equal(ratio, 2, '校准系数夹在 0.5–2.0')

	assert.equal(classifyFailure({ code: 'RATE_LIMIT' }).kind, 'rate-limit')
	assert.equal(classifyFailure({ code: 'WHATEVER', status: 429 }).kind, 'rate-limit')
	assert.equal(classifyFailure({ code: 'QUOTA' }).kind, 'quota')
	assert.equal(classifyFailure({ code: 'ACCOUNT_QUOTA' }).kind, 'quota')
	assert.equal(classifyFailure({ code: 'AUTH' }).kind, 'auth')
	assert.equal(classifyFailure({ code: 'INVALID_CREDENTIAL' }).kind, 'auth')
	assert.equal(classifyFailure({ code: 'SERVER', status: 500 }).kind, 'other')
	// The platform's real 429 wording, as seen in a live session log: HTTP 429 but
	// the field says `quota_exceeded`, and the adapter may drop the status. The
	// wording is then the only evidence — and it must not be read as "no quota".
	const qianfanThrottle = {
		code: 'QUOTA',
		message: 'Token Plan Person request rate limit exceeded',
	}
	assert.equal(classifyFailure(qianfanThrottle).kind, 'rate-limit', '限流措辞优先于 quota 分类')
	assert.equal(
		classifyFailure({ code: 'PI_AI_ERROR', message: 'rate_limit_exceeded' }).kind,
		'rate-limit',
		'适配器自己包装的错误同样按措辞识别',
	)
	assert.equal(
		classifyFailure({ code: 'QUOTA', message: 'insufficient quota' }).kind,
		'quota',
		'真正的额度耗尽措辞仍然归 quota',
	)
	console.log('4 ok: 真实用量回填、EWMA 校准、四种失败分类')
}

/* ── 5. 状态文件来回 ───────────────────────────────────────────────────── */

{
	let state = createRouteState({ provider: 'baiduqianfan', model: 'm', prior: { rpm: 6, tpm: 30_000 } })
	state = applyRateLimit(state, 0, { cooldownCapMs: 600_000 })
	assert.equal(writeThrottleState(STATE_FILE, [state], 123), true)
	const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
	assert.equal(raw.version, 1)
	assert.equal(raw.routes.length, 1)
	assert.equal(raw.routes[0].provider, 'baiduqianfan')
	const loaded = loadThrottleState(STATE_FILE, { preset: 'mid', safety: 0.7, now: 200 })
	assert.equal(loaded.length, 1)
	assert.equal(loaded[0].cooldownUntil, 15_000)
	assert.equal(loaded[0].consecutive429, 1)
	assert.equal(loaded[0].inFlight, 0, '在飞数是运行时事实，不落盘')

	// 文件里留下的 ceiling < learned（手改、或早期版本的衰减）在读回时修正：
	// 否则增长闸门会把 learned 封顶到更低的值。
	writeFileSync(
		STATE_FILE,
		JSON.stringify({
			version: 1,
			savedAt: 1,
			routes: [
				{
					provider: 'baiduqianfan',
					model: 'm',
					learned: { rpm: 6, tpm: 30000 },
					ceiling: { rpm: 5.7, tpm: 28500 },
				},
			],
		}),
		'utf8',
	)
	const repaired = loadThrottleState(STATE_FILE, { preset: 'mid', safety: 0.7, now: 200 })
	assert.deepEqual(repaired[0].ceiling, { rpm: 6, tpm: 30000 }, 'ceiling 不低于 learned')

	writeFileSync(STATE_FILE, '{ not json', 'utf8')
	assert.deepEqual(loadThrottleState(STATE_FILE, { preset: 'mid', safety: 0.7 }), [], '坏文件不抛错、按空状态重来')
	console.log('5 ok: throttle-state.json 原子读写、坏文件降级')
}

/* ── 6. 路由识别与设置收敛 ─────────────────────────────────────────────── */

{
	assert.equal(isQianfanProvider('baiduqianfan'), true)
	assert.equal(isQianfanProvider('baidu-qianfan'), true)
	assert.equal(isQianfanProvider('Qianfan-Token-Plan'), true)
	assert.equal(isQianfanProvider('deepseek'), false)
	assert.equal(isQianfanProvider('workbuddy-ai'), false)

	const resolved = throttleSettings({
		throttleEnabled: true,
		throttleMode: 'dynamic',
		throttleSafety: 5,
		throttleMaxConcurrent: 99,
		throttlePreset: 'nonsense',
	})
	assert.equal(resolved.safety, 0.95, '越界的安全系数夹到上限')
	assert.equal(resolved.maxConcurrent, 5)
	assert.equal(resolved.preset, 'mid', '未知档位回默认')
	assert.equal(throttleSettings({}).enabled, false, '缺字段时默认关闭')
	assert.equal(throttleSettings({}).probePace, 'normal', '缺字段时试探节奏默认正常')
	assert.equal(throttleSettings({ throttleProbePace: 'conservative' }).probePace, 'conservative')
	assert.equal(throttleSettings({ throttleProbePace: 'nonsense' }).probePace, 'normal', '未知试探节奏回默认')
	console.log('6 ok: 千帆路由识别与设置字段的越界收敛')
}

/* ── 7. 控制器：低档限速、透传、不改变请求 ─────────────────────────────── */

{
	const harness = virtualHost({
		settings: settingsOf({ throttleMode: 'manual', throttlePreset: 'low' }),
		clock: { at: 1_000_000 },
	})
	const started = harness.clock.at
	const admissions = []
	for (let index = 0; index < 6; index += 1) {
		const request = smallRequest()
		const chunks = await collect(harness.gate(request))
		// 内层流是瞬时的，所以完成时刻就是放行时刻 —— 差额全部来自闸门的排队。
		admissions.push(harness.clock.at - started)
		assert.equal(chunks.at(-1).reason.kind, 'stop', '六个请求全部拿到响应')
	}
	// 低档 2 RPM / 并发 1：前两个立刻放行，之后每两个要等满一分钟。
	assert.deepEqual(admissions, [0, 0, 60_000, 60_000, 120_000, 120_000], '低档实测 2 次/分')
	assert.ok(
		admissions.filter((at) => at >= 60_000 && at < 120_000).length <= 2,
		'任意 60 秒窗口内不超过 2 个请求',
	)
	harness.close()
	console.log('7 ok: 低档 2 次/分、无请求被丢弃、每分钟窗口不超限')
}

{
	const harness = virtualHost({ settings: settingsOf({ throttlePreset: 'unlimited' }) })
	const request = bigRequest('x'.repeat(4000))
	const frozen = JSON.stringify(request)
	const first = await collect(harness.gate(request))
	assert.equal(first.at(-1).reason.kind, 'stop')
	assert.equal(JSON.stringify(request), frozen, '闸门不修改请求体')
	// 无限制档：没有等待。
	const second = await collect(harness.gate(request))
	assert.equal(second.at(-1).reason.kind, 'stop')
	harness.close()
	console.log('7b ok: 无限制档不排队，请求体逐字节不变')
}

/* ── 8. 控制器：429 冷却、用量、状态面板、重置 ─────────────────────────── */

{
	const clock = { at: 5_000_000 }
	const listeners = []
	const direct = createThrottleHost({
		readSettings: () => settingsOf({ throttleMode: 'dynamic', throttlePreset: 'mid' }),
		stateFile: join(DIR, 'state-2.json'),
		now: () => clock.at,
		sleep: async (ms) => {
			clock.at += Math.max(1, ms)
		},
	})
	direct.attach({
		on: (name, fn) => {
			listeners.push(fn)
			return () => {}
		},
	})
	const gate = (request, stream) => listeners[0](request, () => stream)
	const request = smallRequest()

	await collect(gate(request, streamOf({ inputTokens: 100, outputTokens: 20 })))
	let status = direct.status()
	assert.equal(status.badge, 'normal')
	assert.equal(status.active.used.requests, 1)
	assert.equal(status.active.used.inFlight, 0)
	assert.equal(status.active.learned.rpm, 6, '成功不会改变 learned')

	await collect(gate(request, rateLimitedStream()))
	status = direct.status()
	assert.equal(status.badge, 'cooldown', '429 之后进入冷却')
	assert.ok(status.active.cooldownRemainingMs > 0)
	assert.equal(status.active.learned.rpm, 3, '429 把 learned 折半')
	const beforeCooldown = clock.at
	await collect(gate(request, streamOf()))
	assert.ok(clock.at - beforeCooldown >= 15_000, '冷却期内所有新请求都被暂停')

	// 同一 provider、没见过的模型也要继承账户级冷却。
	await collect(gate(request, rateLimitedStream()))
	const seenBefore = clock.at
	await collect(gate({ ...request, model: 'glm-5.3' }, streamOf()))
	assert.ok(clock.at - seenBefore >= 15_000, '从没见过的模型继承账户级冷却，换模型绕不过去')

	const resetStatus = direct.reset()
	assert.equal(resetStatus.active.safeMode, false)
	assert.equal(resetStatus.lastFailure, null)
	direct.dispose()
	console.log('8 ok: 429 冷却、账户级广播、用量计数、重置')
}

/* ── 9. 队列上限与排队超时 ─────────────────────────────────────────────── */

{
	// 1 RPM + 并发 1：第 1 个放行，其余排队；排队超时设成下限 10 秒。
	const harness = virtualHost({
		settings: settingsOf({
			throttleMode: 'manual',
			throttlePreset: 'low',
			throttleManual: { low: { rpm: 1, tpm: 1000, concurrency: 1 }, mid: { rpm: 6, tpm: 1000, concurrency: 1 }, high: { rpm: 15, tpm: 1000, concurrency: 1 } },
		}),
		queueTimeoutMs: 10_000,
		clock: { at: 9_000_000 },
	})
	const pending = []
	for (let index = 0; index < 3; index += 1) pending.push(collect(harness.gate(smallRequest())))
	const outcomes = await Promise.all(pending)
	const kinds = outcomes.map((chunks) => chunks.at(-1).reason.kind)
	assert.equal(kinds.filter((kind) => kind === 'stop').length, 1, '只有一个请求能进第一分钟的窗口')
	for (const chunks of outcomes) {
		const last = chunks.at(-1)
		if (last.reason.kind === 'error') {
			assert.equal(last.reason.failure.code, 'THROTTLE_QUEUE_TIMEOUT')
			assert.match(last.reason.failure.message, /已排队/u)
		}
	}

	// 队列深度上限：1 RPM，一次塞满 MAX_QUEUE_DEPTH + 2 个。
	const floodHost = virtualHost({
		settings: settingsOf({
			throttleMode: 'manual',
			throttlePreset: 'low',
			throttleManual: { low: { rpm: 1, tpm: 1000, concurrency: 1 }, mid: { rpm: 6, tpm: 1000, concurrency: 1 }, high: { rpm: 15, tpm: 1000, concurrency: 1 } },
		}),
		queueTimeoutMs: 10_000,
		clock: { at: 20_000_000 },
	})
	const flood = []
	for (let index = 0; index < MAX_QUEUE_DEPTH + 3; index += 1) flood.push(collect(floodHost.gate(smallRequest())))
	const floodOutcomes = await Promise.all(flood)
	const codes = floodOutcomes
		.map((chunks) => chunks.at(-1).reason.failure?.code)
		.filter((code) => code === 'THROTTLE_QUEUE_FULL')
	assert.ok(codes.length >= 1, '超过队列深度的请求被明确拒绝，不是静默丢弃')
	harness.close()
	floodHost.close()
	console.log(`9 ok: 排队超时返回 THROTTLE_QUEUE_TIMEOUT；队列深度 ${String(MAX_QUEUE_DEPTH)} 之外返回 THROTTLE_QUEUE_FULL`)
}

/* ── 10. 关闭与无关路由：零干扰 ─────────────────────────────────────────── */

{
	const harness = virtualHost({ settings: settingsOf({ throttleEnabled: false }) })
	const request = smallRequest()
	const stream = streamOf()
	const returned = harness.host.isQianfanProvider(request.provider)
	assert.equal(returned, true)
	harness.close()

	const listeners = []
	const host = createThrottleHost({
		readSettings: () => settingsOf(),
		stateFile: join(DIR, 'state-3.json'),
		// A real timestamp, not 0: the settings snapshot has a 2-second TTL measured
		// from the last read, so a clock stuck at zero would never leave the initial
		// "disabled" snapshot and the gate would silently pass everything.
		now: () => 1_700_000_000_000,
	})
	host.attach({ on: (name, fn) => (listeners.push(fn), () => {}) })
	const passthrough = listeners[0]({ provider: 'deepseek', model: 'x', messages: [] }, () => 'IDENTITY')
	assert.equal(passthrough, 'IDENTITY', '非千帆路由原样透传，不包 async generator')
	// 透传不产生任何学习状态：别的厂商的模型既不入窗口、也不计入排队/冷却。
	assert.deepEqual(host.status().routes, [], '非千帆路由不建任何限流状态')
	// 千帆路由才建状态。
	const gated = listeners[0](
		{ provider: 'baiduqianfan', model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 8 },
		() => (async function* only() {
			yield { type: 'finish', reason: { kind: 'stop' } }
		})(),
	)
	assert.equal(typeof gated[Symbol.asyncIterator], 'function')
	for await (const _chunk of gated) {
		// consume
	}
	assert.equal(host.status().routes.length, 1, '千帆路由被治理')
	host.dispose()
	console.log('10 ok: 关闭时不做任何事；非千帆路由零包装、零状态；只有千帆路由被治理')
}

/* ── 11. 超大请求被计数，且 TPM 不再是唯一闸门 ──────────────────────────── */

{
	const state = {
		...createRouteState({ provider: 'p', model: 'm', prior: { rpm: 6, tpm: 30_000 } }),
		learned: { rpm: 6, tpm: 30_000 },
	}
	const settings = { mode: 'dynamic', preset: 'mid', manual: undefined, safety: 0.7, maxConcurrent: 2 }
	const targets = resolveTargets(settings, state, 10 * MINUTE)
	const status = statusOf(pruneWindow(state, 10 * MINUTE), settings, 10 * MINUTE)
	assert.equal(status.targets.tpm, 21_000)
	assert.equal(targets.tpm, 21_000)

	// 25k 请求在 21k 目标下是超大请求，但仍受 RPM 与并发约束。
	const need = 25_000
	assert.equal(planAdmission(state, 10 * MINUTE, need, targets).oversize, true)
	const full = applyAdmission(state, 10 * MINUTE, 100).state
	assert.equal(planAdmission({ ...full, inFlight: 2 }, 10 * MINUTE, need, targets).reason, 'concurrency')

	// 先验未知时是 3 / 20,000。
	const blank = createRouteState({ provider: 'p', model: 'm', prior: PRIOR_UNKNOWN })
	assert.deepEqual(blank.prior, { rpm: 3, tpm: 20_000 })
	assert.equal(needTokens({ messages: [] }, blank) >= 1024, true)
	console.log('11 ok: 超大请求计数、先验 3/20000、TPM 目标取 learned*safety')
}

/* ── 12. 被误标成额度的限流改写为可重试的 RATE_LIMIT ──────────────────── */

{
	const clock = { at: 2_000_000_000_000 }
	const listeners = []
	const host = createThrottleHost({
		readSettings: () => settingsOf({ throttleMode: 'manual', throttlePreset: 'high' }),
		stateFile: join(DIR, 'state-4.json'),
		now: () => clock.at,
		sleep: async (ms) => {
			clock.at += Math.max(1, ms)
		},
	})
	host.attach({
		on: (name, fn) => {
			listeners.push(fn)
			return () => {}
		},
	})
	const gate = (stream) => listeners[0](smallRequest(), () => stream)

	// 平台真实响应：HTTP 429，但字段写着 quota_exceeded，适配器给出 QUOTA。
	const mislabeled = async function* mislabeledStream() {
		yield {
			type: 'finish',
			reason: {
				kind: 'error',
				failure: { code: 'QUOTA', message: 'Token Plan Person request rate limit exceeded' },
			},
		}
	}
	const chunks = await collect(gate(mislabeled()))
	const failure = chunks.at(-1).reason.failure
	assert.equal(failure.code, 'RATE_LIMIT', '误标成额度的限流改写成 DSH 认识的可重试码')
	assert.equal(failure.status, 429, '并补上 429 状态')
	assert.match(failure.message, /rate limit/u, '消息原样保留')
	assert.ok(host.status().active.cooldownRemainingMs > 0, '阀门同时进入冷却')

	// 真正的额度耗尽：不改写、不重试，面板按额度耗尽显示。
	const genuine = async function* genuineQuotaStream() {
		yield {
			type: 'finish',
			reason: { kind: 'error', failure: { code: 'QUOTA', message: 'insufficient quota for this plan' } },
		}
	}
	const quotaChunks = await collect(gate(genuine()))
	assert.equal(quotaChunks.at(-1).reason.failure.code, 'QUOTA', '真正的额度耗尽不改写')
	assert.equal(host.status().lastFailure.kind, 'quota', '面板按额度耗尽显示')
	host.dispose()
	console.log('12 ok: 误标成额度的限流改写成 RATE_LIMIT（DSH 会重试），真额度耗尽保持 QUOTA（不重试）')
}
/* ── 13. 动态模式向上试探：成功上移、失败只回退 ────────────────────────── */

{
	const dynamic = { mode: 'dynamic', preset: 'mid', manual: undefined, safety: 0.7, maxConcurrent: 2, enabled: true }
	const start = 30_000_000
	let state = createRouteState({
		provider: 'baiduqianfan',
		model: 'm',
		prior: { rpm: 6, tpm: 30_000 },
		safety: 0.7,
		now: start,
	})
	// 一次成功建立 cleanSince；再在试探前补一次近期成功，满足「最近有流量」。
	const first = applyAdmission(state, start, 100)
	state = applyCompletion(first.state, first.ticket, {
		usage: { inputTokens: 90, outputTokens: 10 },
		ok: true,
		now: start,
	})
	// 四档试探节奏：默认「正常」= 连续 2 小时无 429 才允许第一次试探。
	const probeAt = start + 120 * MINUTE + 1
	const recent = applyAdmission(state, probeAt - 1_000, 100)
	state = applyCompletion(recent.state, recent.ticket, {
		usage: { inputTokens: 90, outputTokens: 10 },
		ok: true,
		now: probeAt - 1_000,
	})

	const paceCases = [
		['frequent', 30],
		['normal', 120],
		['conservative', 360],
		['rare', 1440],
	]
	for (const [pace, minutes] of paceCases) {
		const at = start + minutes * MINUTE
		const fresh = {
			...state,
			lastProbeAt: 0,
			lastGrowAt: 0,
			updatedAt: at - 1_000,
		}
		const tooSoon = applyGrowth(fresh, at - 1_000, { mode: 'dynamic', probe: true, probePace: pace })
		assert.equal(tooSoon.probe, null, `${pace}: 未满足连续无 429 时长时不试探`)
		const ready = applyGrowth(fresh, at + 1, { mode: 'dynamic', probe: true, probePace: pace })
		assert.ok(ready.probe !== null, `${pace}: 达到节奏阈值后允许试探`)
	}

	// 回到 ceiling 且干净 2 小时：开始试探，learned 不动，目标临时 +10%。
	const probing = applyGrowth(state, probeAt, { mode: 'dynamic', probe: true, probePace: 'normal' })
	assert.ok(probing.probe !== null, '长期稳定后允许向上试探')
	assert.equal(probing.learned.rpm, 6, '试探期间不直接改 learned')
	assert.equal(Math.round(probing.probe.rpm * 10) / 10, 6.6, '试探基数 +10%')
	const targets = resolveTargets(dynamic, probing, probeAt)
	assert.equal(targets.rpm, 4, '目标仍按 learned 的安全系数计算（整数下限）')
	assert.equal(targets.tpm, 23_100, 'TPM 目标从 21,000 升到 23,100')

	// 试探成功一次并稳定过确认窗口：learned/ceiling 上移，试探结束。
	const admitted = applyAdmission(probing, probeAt, 100)
	const completed = applyCompletion(admitted.state, admitted.ticket, {
		usage: { inputTokens: 90, outputTokens: 10 },
		ok: true,
		now: probeAt + 1_000,
	})
	const confirmed = applyGrowth(completed, probeAt + 180_000 + 1, {
		mode: 'dynamic',
		probe: true,
		probePace: 'normal',
	})
	assert.equal(confirmed.probe, null, '确认后试探结束')
	assert.equal(Math.round(confirmed.learned.rpm * 10) / 10, 6.6, '确认值成为新的 learned')
	assert.equal(Math.round(confirmed.ceiling.rpm * 10) / 10, 6.6, '同时成为新的历史安全上限')
	assert.equal(confirmed.probeBackoffMs, 0)
	const afterConfirm = resolveTargets(dynamic, confirmed, probeAt + 180_000 + 1)
	assert.equal(afterConfirm.tpm, 23_100, '确认后目标保持在试探档，而不是回到旧目标')

	// 在更高的试探档上失败：只回退试探，不折半已确认的安全值。
	const failedProbe = {
		...confirmed,
		probe: { rpm: 7.26, tpm: 36_300, startedAt: probeAt + 300_000, successes: 0 },
		cooldownUntil: 0,
		cooldownMs: 0,
		stormHits: 0,
		consecutive429: 0,
		daily429: { day: '2000-01-01', count: 0 },
		cleanSince: confirmed.cleanSince,
	}
	const rejected = applyRateLimit(failedProbe, probeAt + 300_100, { cooldownCapMs: 600_000 })
	assert.equal(Math.round(rejected.learned.rpm * 10) / 10, 6.6, '试探失败不折半已确认的安全值')
	assert.equal(Math.round(rejected.ceiling.rpm * 10) / 10, 6.6, '试探失败也不降低历史上界')
	assert.equal(rejected.probe, null, '失败后回退到确认状态')
	assert.equal(rejected.probeBackoffMs, 600_000, '失败后退避 10 分钟')
	assert.equal(rejected.probeFailures, 1)
	assert.equal(rejected.consecutive429, 0, '试探失败不计入连续 429')
	assert.equal(rejected.daily429.count, 0, '试探失败不计入单日 429')
	assert.equal(resolveTargets(dynamic, rejected, probeAt + 301_000).tpm, 19_800, '冷却期间先按 0.6 倍恢复')
	assert.equal(
		resolveTargets(dynamic, rejected, probeAt + 300_100 + 15_000 + 120_000 + 1).tpm,
		23_100,
		'恢复窗口结束后回到确认过的目标，不需要重新学',
	)

	// 同一试探失败在重试窗口内再次 429：只延长冷却，退避不再翻倍。
	const retried = applyRateLimit(rejected, probeAt + 300_500, { cooldownCapMs: 600_000 })
	assert.equal(retried.stormHits, 2)
	assert.ok(retried.cooldownUntil > rejected.cooldownUntil, '同一风暴只延长冷却')
	assert.equal(retried.probeBackoffMs, 600_000, '同一风暴不重复放大退避')

	// 基线（非试探）失败仍然折半，并把恢复目标下调 10%。
	const baseline = {
		...createRouteState({ provider: 'baiduqianfan', model: 'm', prior: { rpm: 6, tpm: 30_000 } }),
		learned: { rpm: 6, tpm: 30_000 },
		ceiling: { rpm: 6, tpm: 30_000 },
		cooldownUntil: 0,
		cleanSince: 0,
	}
	const penalized = applyRateLimit(baseline, probeAt, { cooldownCapMs: 600_000 })
	assert.equal(penalized.learned.rpm, 3, '真正的基线 429 才折半')
	assert.equal(penalized.ceiling.rpm, 5.4, 'ceiling 同时下调 10%，避免反复爬回已失效的旧上限')
	assert.ok(penalized.ceiling.rpm >= penalized.learned.rpm, 'ceiling 不低于 learned')

	// 状态面板：实时放行/请求量与安全区间。
	const now = 40_000_000
	const panelState = {
		...createRouteState({ provider: 'baiduqianfan', model: 'm', prior: { rpm: 6, tpm: 30_000 } }),
		learned: { rpm: 6, tpm: 30_000 },
		ceiling: { rpm: 6, tpm: 30_000 },
		cooldownUntil: 0,
		window: [{ at: now, tokens: 500, seq: 1 }],
		arrivals: [now - 1_000, now - 2_000],
		inFlight: 1,
		cleanSince: now - 1_000_000,
		updatedAt: now - 1_000,
	}
	const status = statusOf(pruneWindow(panelState, now), dynamic, now)
	assert.equal(status.demand.requests, 2, '最近 60 秒有 2 个请求进来')
	assert.equal(status.demand.admitted, 1, '其中 1 个被放行')
	assert.equal(status.demand.percent, 50, '发挥速率 = 放行 / 请求量')
	assert.deepEqual(status.safeRange.rpm, { min: 3, max: 4 }, '安全区间：恢复下限到正常上限')
	assert.deepEqual(status.safeRange.tpm, { min: 18_000, max: 21_000 })
	const idle = statusOf(
		pruneWindow({ ...panelState, arrivals: [], window: [] }, now),
		dynamic,
		now,
	)
	assert.equal(idle.demand.percent, null, '没有请求时百分比是 null，而不是伪造的 100%')
	console.log('13 ok: 动态模式向上试探、确认上移、试探失败只回退；实时发挥速率与安全区间')
}

console.log('\nthrottle: 全部自检通过')
