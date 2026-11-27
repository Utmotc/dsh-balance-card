/**
 * OpenDesign — 工作区额度 + 钱包余额。
 *
 * Control Key 走 `billing/preflight`（Bearer）；控制台 Cookie 走
 * `billing/coding-plan-usage`。两者都要求 `x-vela-workspace-id`，因此高级设置里
 * 必须填 Workspace ID。
 * @module dsh-balance-card/vendors/opendesign
 */
import { VendorError } from '../errors.js'
import { requestJson } from '../net.js'
import { num, percentReading } from '../parse.js'

const API = 'https://amr-api.open-design.ai/api/v1'

/**
 * @param context - `{ credentials, settings, timeoutMs, signal }`。
 * @returns 百分比读数。
 */
export async function query({ credentials, settings, timeoutMs, signal }) {
	const token = credentials.token
	if (typeof token !== 'string' || token === '') throw new VendorError('unconfigured', '未配置 OPENDESIGN_CREDENTIAL。')
	const workspaceId = typeof settings?.advanced?.workspaceId === 'string' ? settings.advanced.workspaceId : ''
	if (workspaceId === '') throw new VendorError('unconfigured', '请在高级设置里填写 OpenDesign Workspace ID。')

	const isCookie = token.includes('=') && !/^(?:Bearer\s|vela_ctrl_)/iu.test(token)
	const headers = {
		accept: 'application/json',
		'x-vela-workspace-id': workspaceId,
		...(isCookie ? { cookie: token } : { authorization: `Bearer ${token.replace(/^Bearer\s+/iu, '')}` }),
	}
	const endpoint = isCookie ? `${API}/workspaces/${encodeURIComponent(workspaceId)}/billing/coding-plan-usage` : `${API}/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`
	const body = await requestJson(endpoint, { headers, timeoutMs, signal })
	const windows = parse(body)
	if (windows.length === 0) throw new VendorError('no_reading', 'OpenDesign 没有返回有效的额度窗口（可能未订阅）。')
	return percentReading({ windows, primary: windows[0].id })
}

/**
 * 解析 windows 数组。
 * @param body - 响应。
 * @returns 窗口数组。
 */
function parse(body) {
	const root = body?.codingPlan !== null && typeof body?.codingPlan === 'object' ? { ...body, ...body.codingPlan } : body
	const rows = Array.isArray(root?.windows) ? root.windows : []
	const windows = []
	for (const [index, row] of rows.entries()) {
		if (row === null || typeof row !== 'object') continue
		const limit = num(row.limitCredits)
		const used = num(row.usedCredits)
		const remaining = num(row.remainingCredits)
		if (limit === undefined || limit <= 0) continue
		const usedValue = used ?? (remaining === undefined ? undefined : limit - remaining)
		if (usedValue === undefined) continue
		const percent = Math.min(100, Math.max(0, 100 - (usedValue / limit) * 100))
		const duration = num(row.durationSeconds)
		const id = duration === 18_000 ? 'five-hour' : duration === 604_800 ? 'weekly' : `window-${index}`
		windows.push({
			id,
			label: id === 'five-hour' ? '5 小时' : id === 'weekly' ? '周额度' : `${duration ?? '?'} 秒窗口`,
			percent,
			remaining: percent,
			total: 100,
			used: 100 - percent,
			resetsAt: row.resetsAt ?? '',
			expiresAt: '',
			unlimited: false,
			note: '',
		})
	}
	return windows
}