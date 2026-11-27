/**
 * dsh-balance-card 2.0 — 每厂商缓存与轮询调度。
 *
 * 一个进程内缓存，一个并发闸门（≤3），一个退避规则：
 *
 * - 成功：`nextAt = now + pollMs`；
 * - 失败：`nextAt = now + min(pollMs × 1.6^失败次数, 30min)`；
 * - 401/403：`nextAt = now + 30min`，等用户改凭据（改完会强制刷新）；
 * - 失败但有上次成功值：状态 `stale`，读数是旧的，绝不冒充新值；
 * - 页面隐藏时浏览器停止轮询，这里自然没有新请求。
 *
 * 缓存不持有设置与凭据：调用方每次传入 `plan`，凭据在真正发请求前才解析。
 * @module dsh-balance-card/cache
 */

/** 同厂商同时只发一个请求。 */
const INFLIGHT = Symbol('inflight')

/**
 * 建一个缓存。
 * @param options - `{ fetchVendor(plan), concurrency?, now?, maxBackoffMs? }`。
 * @returns 缓存控制器。
 */
export function createCache(options) {
	const fetchVendor = options.fetchVendor
	const concurrency = Number.isInteger(options.concurrency) ? Math.max(1, options.concurrency) : 3
	const now = options.now ?? (() => Date.now())
	const maxBackoffMs = options.maxBackoffMs ?? 1_800_000

	/** vendorId → 记录。 */
	const records = new Map()
	/** vendorId → 正在进行的 Promise。 */
	const inflight = new Map()
	/** 等待并发名额的任务。 */
	const queue = []
	let running = 0

	/**
	 * 当前记录；没有时给一个 idle 占位。
	 * @param id - 厂商 id。
	 * @returns 记录。
	 */
	const recordOf = (id) => {
		const existing = records.get(id)
		if (existing !== undefined) return existing
		const created = { vendorId: id, status: 'idle', reading: null, error: null, fetchedAt: 0, nextAt: 0, backoffMs: 0, failures: 0 }
		records.set(id, created)
		return created
	}

	/**
	 * 让出一个并发名额并启动排队任务。
	 */
	const pump = () => {
		while (running < concurrency && queue.length > 0) {
			const job = queue.shift()
			running += 1
			job().finally(() => {
				running -= 1
				pump()
			})
		}
	}

	/**
	 * 发起一次读取（受并发闸门约束）。
	 * @param plan - `{ vendor, settings, configured }`。
	 * @returns 读取 Promise。
	 */
	const launch = (plan) => {
		const id = plan.vendor.id
		const existing = inflight.get(id)
		if (existing !== undefined) return existing
		const record = recordOf(id)
		record.status = record.reading === null ? 'loading' : record.status
		const task = new Promise((resolve) => {
			const job = () => {
				const started = now()
				return Promise.resolve()
					.then(() => fetchVendor(plan))
					.then((reading) => {
						record.status = 'ok'
						record.reading = reading
						record.error = null
						record.fetchedAt = started
						record.failures = 0
						record.backoffMs = 0
						record.nextAt = now() + pollMsOf(plan)
						resolve(record)
					})
					.catch((error) => {
						const code = error?.code
						record.failures += 1
						record.error = {
							code: typeof code === 'string' ? code : 'network',
							message: typeof error?.message === 'string' ? error.message : String(error),
							advice: typeof error?.advice === 'string' ? error.advice : '',
							...(typeof error?.status === 'number' ? { status: error.status } : {}),
						}
						record.status = record.reading === null ? 'error' : 'stale'
						record.fetchedAt = started
						if (code === 'unauthorized' || code === 'forbidden' || code === 'expired') {
							record.backoffMs = maxBackoffMs
						} else {
							record.backoffMs = Math.min(
								maxBackoffMs,
								Math.max(5_000, pollMsOf(plan) * 1.6 ** Math.min(6, record.failures)),
							)
						}
						record.nextAt = now() + record.backoffMs
						resolve(record)
					})
					.finally(() => {
						inflight.delete(id)
					})
			}
			queue.push(job)
			pump()
		})
		inflight.set(id, task)
		return task
	}

	/**
	 * 一家厂商的轮询间隔：厂商覆盖优先，否则跟随全局。
	 * @param plan - `{ vendor, settings, globalPollMs }`。
	 * @returns 毫秒。
	 */
	const pollMsOf = (plan) => {
		const vendorPoll = plan.settings?.pollMs
		if (typeof vendorPoll === 'number' && Number.isFinite(vendorPoll)) return Math.max(15_000, vendorPoll)
		const globalPoll = plan.globalPollMs
		if (typeof globalPoll === 'number' && Number.isFinite(globalPoll)) return Math.max(15_000, globalPoll)
		return 600_000
	}

	/**
	 * 读一家厂商：命中缓存立即返回，过期则启动刷新并最多等待 `waitMs`。
	 * @param plan - `{ vendor, settings, configured, globalPollMs }`。
	 * @param options - `{ force?, waitMs? }`。
	 * @returns 记录。
	 */
	const get = async (plan, options = {}) => {
		const id = plan.vendor.id
		const record = recordOf(id)
		if (plan.vendor.status === 'unsupported') {
			record.status = 'unsupported'
			return record
		}
		if (plan.enabled !== true) {
			record.status = 'disabled'
			return record
		}
		if (plan.configured !== true) {
			record.status = 'unconfigured'
			record.reading = null
			record.error = { code: 'unconfigured', message: '未配置凭据。', advice: '展开该厂商，粘贴并保存凭据。' }
			return record
		}

		const force = options.force === true
		const due = force || record.fetchedAt === 0 || now() >= record.nextAt
		if (!due) return record

		const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, options.waitMs) : 0
		const pending = launch(plan)
		if (waitMs === 0) return record
		return Promise.race([
			pending,
			new Promise((resolve) => {
				const timer = setTimeout(() => resolve(record), waitMs)
				timer.unref?.()
			}),
		])
	}

	/**
	 * 取消一家厂商的缓存（改凭据后强制重读）。
	 * @param id - 厂商 id。
	 */
	const invalidate = (id) => {
		const record = records.get(id)
		if (record === undefined) return
		record.nextAt = 0
		record.fetchedAt = 0
		record.failures = 0
		record.backoffMs = 0
		record.error = null
	}

	/** @returns 全部记录（副本）。 */
	const all = () => new Map(records)

	/** 等待所有正在进行的读取结束（测试与优雅退出用）。 */
	const settle = async () => {
		while (inflight.size > 0) {
			await Promise.allSettled([...inflight.values()])
			// inflight 在 finally 里删除；下一轮读取可能刚刚入队。
			await new Promise((resolve) => setImmediate(resolve))
		}
	}

	return { get, recordOf, all, invalidate, settle, pollMsOf, records }
}