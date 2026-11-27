/**
 * SCNet 超算互联网 — 控制台 Token Plan + 现金余额，控制台 Cookie。
 *
 * `readScnetConsole()` 一次读两条并合成内部读数；这里翻译成 2.0 形状，并把现金
 * 余额作为带自己单位的第二个窗口（混合单位靠窗口 unit 表达）。
 * @module dsh-balance-card/vendors/scnet
 */
import { VendorError } from '../errors.js'
import { readScnetConsole, probeScnetCookie } from '../scnet.js'
import { currencyReading, num, quotaReading, usedWindow } from '../parse.js'

/**
 * @param context - `{ credentials, timeoutMs, signal }`。
 * @returns 额度或金额读数。
 */
export async function query({ credentials, timeoutMs }) {
	const cookie = credentials.cookie
	if (typeof cookie !== 'string' || cookie === '') {
		throw new VendorError('unconfigured', '未配置 SCNET_COOKIE（需要控制台 Cookie）。')
	}
	let reading
	try {
		reading = await readScnetConsole(cookie, timeoutMs)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/登录|Cookie|401|403|auth/iu.test(message)) throw new VendorError('expired', message)
		throw new VendorError('network', message)
	}

	if (reading?.kind === 'currency') {
		const remaining = num(reading.balance)
		if (remaining === undefined) throw new VendorError('parse', 'SCNet 现金余额不是数字。')
		return currencyReading({
			unit: '¥',
			remaining,
			windows: [{ id: 'cash', label: '现金余额', remaining }],
			note: '未发现有效的 Token Plan',
		})
	}

	const remaining = num(reading?.remaining)
	const total = num(reading?.limit)
	const used = num(reading?.used)
	if (remaining === undefined) throw new VendorError('parse', 'SCNet Token Plan 缺少 remaining。')
	const windows = [usedWindow({ id: 'tokenplan', label: 'Token Plan', total, used, remaining })]
	const cash = num(reading?.cash?.balance)
	if (cash !== undefined) {
		windows.push({
			id: 'cash',
			label: '现金余额',
			remaining: cash,
			total: null,
			used: null,
			percent: null,
			unit: '¥',
			resetsAt: '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	return quotaReading({
		kind: 'credits',
		unit: '积分',
		windows,
		primary: 'tokenplan',
		note: '',
	})
}

/**
 * 测试连接。
 * @param cookie - 控制台 Cookie。
 * @param timeoutMs - 超时。
 * @returns `{ reachable, reading?, message? }`。
 */
export async function probe(cookie, timeoutMs) {
	const probeResult = await probeScnetCookie(cookie, timeoutMs)
	if (probeResult.reachable === true) {
		return { reachable: true, reading: probeResult.reading }
	}
	return { reachable: false, message: probeResult.message ?? '无法读取 SCNet 控制台。' }
}