/**
 * 千帆限流阀门的开销基准（不属于断言，只打印数字）。
 *
 * 验收第 8 条要求「状态路由 P99 < 5ms；闸门额外开销 < 1ms（不含等待）」，这里就是
 * 那两处的测量脚本。虚拟时钟每轮前进 500ms，让 60 秒窗口保持真实吞吐应有的规模
 * （约 120 条），而不是把两万次调用全都堆在同一个时刻。
 *
 * Run: node test/bench-throttle.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThrottleHost } from '../lib/throttle-host.js'
import { estimateRequestTokens } from '../lib/throttle.js'

const DIR = mkdtempSync(join(tmpdir(), 'dsh-throttle-bench-'))
process.on('exit', () => {
	try {
		rmSync(DIR, { recursive: true, force: true })
	} catch {
		// 残留的临时目录不值得让基准失败。
	}
})

/** 一份「无限制」档设置：闸门全开，只用来量不含等待时的纯开销。 */
const SETTINGS = {
	throttleEnabled: true,
	throttleMode: 'manual',
	throttlePreset: 'unlimited',
	throttleSafety: 0.7,
	throttleMaxConcurrent: 3,
	throttleCooldownCapMs: 600_000,
	throttleManual: {
		low: { rpm: 2, tpm: 8_000, concurrency: 1 },
		mid: { rpm: 6, tpm: 30_000, concurrency: 2 },
		high: { rpm: 15, tpm: 80_000, concurrency: 3 },
	},
}

/** 一个 25k token 量级的真实请求：中文上下文 + 一个工具 schema。 */
const REQUEST = {
	provider: 'baiduqianfan',
	model: 'deepseek-v4.1-flash-1017',
	messages: [{ role: 'user', content: [{ type: 'text', text: '深度求索的 Agent 上下文。'.repeat(2300) }] }],
	maxTokens: 4096,
	tools: [
		{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
	],
}

/** @param samples - 毫秒样本。 @returns 均值与分位数。 */
function stats(samples) {
	const sorted = [...samples].sort((left, right) => left - right)
	const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
	return {
		mean: samples.reduce((total, value) => total + value, 0) / samples.length,
		p50: at(0.5),
		p99: at(0.99),
		max: sorted.at(-1),
	}
}

/**
 * @param label - 打印标题。
 * @param iterations - 取样次数。
 * @param run - 一轮被测操作。
 */
async function bench(label, iterations, run) {
	const samples = []
	for (let index = 0; index < iterations; index += 1) {
		const started = process.hrtime.bigint()
		await run(index)
		samples.push(Number(process.hrtime.bigint() - started) / 1e6)
	}
	// 丢掉前 10% 预热样本：JIT 还没编译完的那几轮不代表稳态。
	const steady = samples.slice(Math.floor(samples.length * 0.1))
	const measured = stats(steady)
	console.log(
		label,
		JSON.stringify({
			mean: Number(measured.mean.toFixed(4)),
			p50: Number(measured.p50.toFixed(4)),
			p99: Number(measured.p99.toFixed(4)),
			max: Number(measured.max.toFixed(4)),
		}),
	)
}

const clock = { at: 1_000_000 }
const host = createThrottleHost({
	readSettings: () => SETTINGS,
	stateFile: join(DIR, 'throttle-state.json'),
	now: () => clock.at,
	sleep: async () => {},
})
host.attach({ on: () => () => {} })

console.log('request estimate:', estimateRequestTokens(REQUEST), 'tokens')

await bench('admit + release (25k tokens, unlimited, ~120-entry window)', 20000, async () => {
	clock.at += 500
	const ticket = await host.admit({ provider: REQUEST.provider, model: REQUEST.model, request: REQUEST })
	host.release(ticket, { usage: { inputTokens: 24000, outputTokens: 500 }, ok: true })
})

await bench('status() (one route, ~120-entry window)', 20000, () => {
	clock.at += 500
	return host.status()
})

await bench('estimateRequestTokens (25k tokens, 1 tool)', 20000, () => estimateRequestTokens(REQUEST))

host.dispose()