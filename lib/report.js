/**
 * 用量日报 — 本地快照差分，不额外请求厂商。
 *
 * 每次 `/snapshot` 顺手记录每家厂商「今天第一次看到的余额」与「最近一次余额」，
 * 两者之差就是今天的消耗。只保留 14 天；设置页展示最近 7 天。
 *
 * 这里只做本地统计，不做账单对账，也不推断价格。
 * @module dsh-balance-card/report
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 写入节流：同一进程 5 分钟内只落一次盘。 */
const WRITE_GAP_MS = 300_000
/** 保留天数。 */
const KEEP_DAYS = 14
/** 上次写入时间。 */
let lastWriteAt = 0

/**
 * 本地日期 `YYYY-MM-DD`。
 * @param now - 时间戳。
 * @returns 日期字符串。
 */
function localDate(now) {
	const date = new Date(now)
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${year}-${month}-${day}`
}

/**
 * 读日报文件。
 * @param file - 绝对路径。
 * @returns `{ days: { date: { vendors } } }`。
 */
function readFile(file) {
	try {
		if (!existsSync(file)) return { days: {} }
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		if (parsed !== null && typeof parsed === 'object' && parsed.days !== null && typeof parsed.days === 'object') {
			return parsed
		}
	} catch {
		// 坏文件当作空报告，下一次快照会重建。
	}
	return { days: {} }
}

/**
 * 记录一次快照。
 * @param file - 日报文件路径。
 * @param readings - `vendorId → { status, reading }`。
 * @param now - 时间戳（测试注入）。
 */
export function recordSnapshot(file, readings, now = Date.now()) {
	const today = localDate(now)
	const store = readFile(file)
	const day = store.days[today] ?? { vendors: {} }
	const vendors = day.vendors

	for (const [id, entry] of Object.entries(readings ?? {})) {
		if (entry === null || typeof entry !== 'object') continue
		const reading = entry.reading
		if (reading === null || typeof reading !== 'object') continue
		if (typeof reading.remaining !== 'number' || !Number.isFinite(reading.remaining)) continue
		const unit = typeof reading.unit === 'string' ? reading.unit : ''
		const current = vendors[id]
		if (current === undefined || current.unit !== unit) {
			vendors[id] = { unit, first: reading.remaining, last: reading.remaining, consumed: 0, updatedAt: now }
		} else {
			// 额度补发或套餐升级会让余额上升；消耗只记下降，不记负数。
			current.consumed = Math.max(0, Math.round((current.first - reading.remaining) * 100) / 100)
			current.last = reading.remaining
			current.updatedAt = now
		}
	}

	store.days[today] = day
	// 只保留最近 KEEP_DAYS 天。
	const dates = Object.keys(store.days).sort()
	while (dates.length > KEEP_DAYS) {
		const oldest = dates.shift()
		delete store.days[oldest]
	}

	if (now - lastWriteAt < WRITE_GAP_MS) return
	lastWriteAt = now
	try {
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
	} catch {
		// 统计落盘失败不影响读数。
	}
}

/**
 * 读最近 7 天报告，供设置页展示。
 * @param file - 日报文件路径。
 * @returns `[{ date, vendors: [{ id, unit, first, last, consumed }] }]`。
 */
export function readReport(file) {
	const store = readFile(file)
	const dates = Object.keys(store.days).sort().reverse().slice(0, 7)
	return dates.map((date) => {
		const vendors = store.days[date]?.vendors ?? {}
		return {
			date,
			vendors: Object.entries(vendors).map(([id, row]) => ({
				id,
				unit: typeof row.unit === 'string' ? row.unit : '',
				first: typeof row.first === 'number' ? row.first : null,
				last: typeof row.last === 'number' ? row.last : null,
				consumed: typeof row.consumed === 'number' ? row.consumed : null,
			})),
		}
	})
}

/**
 * 读取最新一份昨日摘要。
 * @param file - 日报文件路径。
 * @returns 摘要或 null。
 */
export function readDigest(file) {
	const store = readFile(file)
	const digests = store.digests !== null && typeof store.digests === 'object' ? store.digests : {}
	const dates = Object.keys(digests).sort().reverse()
	if (dates.length === 0) return null
	return digests[dates[0]]
}

/**
 * 到点生成昨日摘要（每天一份，只生成一次）。
 *
 * 这是「日报」里唯一由时间驱动的部分：`enabled` 为真、当前本地时间已过设置的
 * HH:MM、且昨天有快照时，写一份 `{ date, generatedAt, vendors }`。通知服务缺席
 * 时摘要只在设置页内展示，不推送。
 * @param file - 日报文件路径。
 * @param settings - `tools.dailyReport`。
 * @param now - 时间戳（测试注入）。
 * @returns 是否新生成。
 */
export function maybeGenerateDigest(file, settings, now = Date.now()) {
	if (settings?.enabled !== true) return false
	if (typeof settings.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(settings.time)) return false
	const store = readFile(file)
	const yesterdayDate = new Date(now)
	yesterdayDate.setDate(yesterdayDate.getDate() - 1)
	const yesterday = localDate(yesterdayDate.getTime())
	const day = store.days[yesterday]
	if (day === undefined || day.vendors === undefined || Object.keys(day.vendors).length === 0) return false

	const [hour, minute] = settings.time.split(':').map((part) => Number(part))
	const current = new Date(now)
	if (current.getHours() * 60 + current.getMinutes() < hour * 60 + minute) return false

	store.digests = store.digests !== null && typeof store.digests === 'object' ? store.digests : {}
	if (store.digests[yesterday] !== undefined) return false

	const vendors = Object.entries(day.vendors).map(([id, row]) => ({
		id,
		unit: typeof row.unit === 'string' ? row.unit : '',
		first: typeof row.first === 'number' ? row.first : null,
		last: typeof row.last === 'number' ? row.last : null,
		consumed: typeof row.consumed === 'number' ? row.consumed : 0,
	}))
	store.digests[yesterday] = {
		date: yesterday,
		generatedAt: new Date(now).toISOString(),
		vendors,
	}
	try {
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
		lastWriteAt = now
		return true
	} catch {
		return false
	}
}