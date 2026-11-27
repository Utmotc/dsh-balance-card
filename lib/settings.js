/**
 * dsh-balance-card 2.0 — 设置文档。
 *
 * 一个文件、一个 schema、一个迁移器。普通设置（风格、开关、阈值、工具参数）
 * 全部写在这里；API Key / Cookie 只进 DSH 凭据库，永不落盘到本文件。
 *
 * ## 为什么自己校验而不是 schemastery
 *
 * 宿主半边只 import node 内置模块与本包模块（见 index.js 的 portability 注释），
 * 所以这里手写校验：每个字段都有安全默认值，坏值退默认，绝不让一个手改字段
 * 拖垮整份设置。POST 路由与读文件走同一套 `normalizeSettings`，因此手改文件
 * 不能绕过路由的校验。
 *
 * ## 版本与迁移
 *
 * 1.6.x 的 `balance-settings.json` 先读后迁移到 `balance-settings-v2.json`：
 * 旧文件保留、另存 `balance-settings.v1.backup.json`，迁移失败则整份退默认，
 * 由设置页显示失败原因。
 * @module dsh-balance-card/settings
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 当前设置版本。 */
export const SETTINGS_VERSION = 2
/** v2 文件名。 */
export const SETTINGS_FILE = 'balance-settings-v2.json'
/** 1.x 文件名，只在迁移时读取。 */
export const LEGACY_SETTINGS_FILE = 'balance-settings.json'

/** 四种最终视觉风格。`grid` 是首次安装与未知迁移值的默认。 */
export const VISUAL_STYLE_IDS = ['grid', 'ring', 'line', 'gradient']
/** 旧风格名到最终 id 的映射（设计文档 §14.2）。 */
export const VISUAL_STYLE_MIGRATION = {
	instrument: 'line',
	glass: 'gradient',
	tile: 'ring',
	// 第一版内部名，避免测试/历史文件落空
	ink: 'grid',
	porcelain: 'ring',
	grid: 'grid',
	ring: 'ring',
	line: 'line',
	gradient: 'gradient',
}
/** 主题：只保留「跟随软件」，不再提供强制浅色/深色。 */
export const THEME_IDS = ['system']
/** 强调色：三个固定值 + `vendor` 跟随厂商 + 自定义 `#rrggbb`。 */
export const ACCENT_IDS = ['jade', 'ink', 'amber', 'vendor']
/** 密度。 */
export const DENSITY_IDS = ['comfortable', 'compact']
/** 点击卡片的行为。 */
export const CLICK_ACTIONS = ['panel', 'settings']
/** 货币写法。 */
export const CURRENCY_STYLES = ['symbol', 'plain']
/** 刷新间隔（毫秒）：1 / 5 / 10 / 30 分钟。 */
export const POLL_CHOICES = [60_000, 300_000, 600_000, 1_800_000]
/** 千帆试探节奏四档。 */
export const PROBE_PACE_IDS = ['frequent', 'normal', 'conservative', 'rare']
/** 千帆限流预设。 */
export const THROTTLE_PRESET_IDS = ['low', 'mid', 'high', 'unlimited']
/** 限流模式：手动固定 / 动态学习。关闭由 enabled=false 表达。 */
export const THROTTLE_MODE_IDS = ['manual', 'dynamic']

/** 单个厂商的设置默认值。 */
export function defaultVendorSettings() {
	return {
		enabled: false,
		pollMs: null,
		warnPercent: null,
		window: 'auto',
		budget: null,
		unitOverride: null,
		account: 'default',
		advanced: {},
	}
}

/** 卡片设置默认值。 */
export function defaultCardSettings() {
	return {
		showPercent: true,
		showBar: true,
		showUpdatedAt: true,
		showSubtitle: true,
		showStatusText: false,
		groupDigits: true,
		currencyStyle: 'symbol',
		pollMs: 600_000,
		warnPercent: 20,
		clickAction: 'panel',
		visible: true,
	}
}

/** 千帆限流工具默认值。 */
export function defaultThrottleTool() {
	return {
		enabled: false,
		mode: 'dynamic',
		preset: 'mid',
		safety: 0.7,
		maxConcurrent: 2,
		cooldownCapMs: 600_000,
		queueTimeoutMs: 180_000,
		probe: true,
		probePace: 'normal',
		manual: {
			low: { rpm: 2, tpm: 8_000, concurrency: 1 },
			mid: { rpm: 6, tpm: 30_000, concurrency: 2 },
			high: { rpm: 15, tpm: 80_000, concurrency: 3 },
		},
	}
}

/** 低余额告警默认值。 */
export function defaultLowBalanceAlert() {
	return {
		enabled: true,
		warnPercent: 20,
		criticalPercent: 10,
		notify: false,
		quietHours: null,
	}
}

/** 用量日报默认值。 */
export function defaultDailyReport() {
	return { enabled: false, time: '09:00', format: 'digest' }
}

/** 工具默认值。 */
export function defaultTools() {
	return {
		qianfanThrottle: defaultThrottleTool(),
		lowBalanceAlert: defaultLowBalanceAlert(),
		dailyReport: defaultDailyReport(),
	}
}

/** 整份设置默认值。 */
export function defaultSettings() {
	return {
		version: SETTINGS_VERSION,
		theme: 'system',
		visualStyle: 'grid',
		accent: 'jade',
		density: 'comfortable',
		card: defaultCardSettings(),
		vendors: {},
		tools: defaultTools(),
	}
}

/** @param value - 任意值。 @returns 有限数字或 undefined。 */
function finite(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** @param value - 任意值。 @returns 0–100 之间的有限数字或 undefined。 */
function percent(value) {
	const n = finite(value)
	return n === undefined ? undefined : Math.min(100, Math.max(0, Math.round(n * 100) / 100))
}

/** @param value - 任意值。 @returns 非空字符串或 undefined。 */
function text(value, max = 2048) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed === '' || trimmed.length > max ? undefined : trimmed
}

/** @param value - 候选枚举值。 @param allowed - 合法值表。 @param fallback - 不合法时的值。 */
function oneOf(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback
}

/** @param value - 候选值。 @returns 合法 `#rgb` / `#rrggbb` 或 undefined。 */
function colour(value) {
	return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u.test(value) ? value : undefined
}

/**
 * 校验一个厂商设置对象，坏值逐字段退默认。
 * @param raw - 未知输入。
 * @returns 规范化后的厂商设置。
 */
export function normalizeVendorSettings(raw) {
	const base = defaultVendorSettings()
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const poll = finite(source.pollMs)
	const warn = percent(source.warnPercent)
	const budget = finite(source.budget)
	const unit = text(source.unitOverride, 24)
	const account = text(source.account, 64) ?? base.account
	const window = text(source.window, 64) ?? base.window
	const advanced =
		source.advanced !== null && typeof source.advanced === 'object' && !Array.isArray(source.advanced)
			? sanitizeAdvanced(source.advanced)
			: {}
	return {
		enabled: source.enabled === true,
		pollMs: poll === undefined ? null : Math.min(3_600_000, Math.max(15_000, Math.round(poll))),
		warnPercent: warn === undefined ? null : warn,
		window,
		budget: budget === undefined || budget < 0 ? null : Math.round(budget * 100) / 100,
		unitOverride: unit === undefined ? null : unit,
		account,
		advanced,
	}
}

/**
 * 校验厂商展开面板里的高级字段。只接受已知键，避免把任意对象写进设置文件。
 * @param raw - 未知输入。
 * @returns 白名单化后的高级设置。
 */
function sanitizeAdvanced(raw) {
	const out = {}
	const url = text(raw.endpoint, 2048)
	if (url !== undefined && /^https:\/\//iu.test(url)) out.endpoint = url
	const method = oneOf(raw.method, ['GET', 'POST'], 'GET')
	if (raw.method !== undefined) out.method = method
	const timeout = finite(raw.timeoutMs)
	if (timeout !== undefined) out.timeoutMs = Math.min(60_000, Math.max(3_000, Math.round(timeout)))
	const headerName = text(raw.headerName, 64)
	if (headerName !== undefined) out.headerName = headerName
	const jsonPath = text(raw.jsonPath, 256)
	if (jsonPath !== undefined) out.jsonPath = jsonPath
	const expression = text(raw.expression, 512)
	if (expression !== undefined) out.expression = expression
	const unit = text(raw.unit, 24)
	if (unit !== undefined) out.unit = unit
	// 少数厂商需要额外的标识：OpenDesign 的工作区、Factory 的组织、Codex 的账号。
	const workspaceId = text(raw.workspaceId, 128)
	if (workspaceId !== undefined) out.workspaceId = workspaceId
	const orgId = text(raw.orgId, 128)
	if (orgId !== undefined) out.orgId = orgId
	const accountId = text(raw.accountId, 128)
	if (accountId !== undefined) out.accountId = accountId
	const projectId = text(raw.projectId, 128)
	if (projectId !== undefined) out.projectId = projectId
	if (raw.allowPrivate === true) out.allowPrivate = true
	return out
}

/**
 * 校验卡片设置。
 * @param raw - 未知输入。
 * @returns 规范化后的卡片设置。
 */
export function normalizeCardSettings(raw) {
	const base = defaultCardSettings()
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const bool = (key) => (typeof source[key] === 'boolean' ? source[key] : base[key])
	const poll = finite(source.pollMs)
	const warn = percent(source.warnPercent)
	return {
		showPercent: bool('showPercent'),
		showBar: bool('showBar'),
		showUpdatedAt: bool('showUpdatedAt'),
		showSubtitle: bool('showSubtitle'),
		showStatusText: bool('showStatusText'),
		groupDigits: bool('groupDigits'),
		currencyStyle: oneOf(source.currencyStyle, CURRENCY_STYLES, base.currencyStyle),
		pollMs: poll === undefined ? base.pollMs : Math.min(3_600_000, Math.max(15_000, Math.round(poll))),
		warnPercent: warn === undefined ? base.warnPercent : warn,
		clickAction: oneOf(source.clickAction, CLICK_ACTIONS, base.clickAction),
		visible: typeof source.visible === 'boolean' ? source.visible : base.visible,
	}
}

/**
 * 校验千帆限流工具设置。兼容 1.x 的顶层字段（迁移路径）。
 * @param raw - 未知输入。
 * @returns 规范化后的限流工具设置。
 */
export function normalizeThrottleTool(raw) {
	const base = defaultThrottleTool()
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const number = (value, fallback, low, high) => {
		const n = finite(value)
		return n === undefined ? fallback : Math.min(high, Math.max(low, n))
	}
	const manual =
		source.manual !== null && typeof source.manual === 'object' && !Array.isArray(source.manual)
			? normalizePresets(source.manual)
			: base.manual
	return {
		enabled: source.enabled === true,
		mode: oneOf(source.mode, THROTTLE_MODE_IDS, base.mode),
		preset: oneOf(source.preset, THROTTLE_PRESET_IDS, base.preset),
		safety: number(source.safety, base.safety, 0.5, 0.95),
		maxConcurrent: Math.round(number(source.maxConcurrent, base.maxConcurrent, 1, 5)),
		cooldownCapMs: number(source.cooldownCapMs, base.cooldownCapMs, 60_000, 3_600_000),
		queueTimeoutMs: number(source.queueTimeoutMs, base.queueTimeoutMs, 10_000, 300_000),
		probe: typeof source.probe === 'boolean' ? source.probe : base.probe,
		probePace: oneOf(source.probePace, PROBE_PACE_IDS, base.probePace),
		manual,
	}
}

/**
 * 校验三档手动预设。
 * @param raw - 未知输入。
 * @returns 每档 `{ rpm, tpm, concurrency }`。
 */
export function normalizePresets(raw) {
	const base = defaultThrottleTool().manual
	const pick = (id) => {
		const row = raw !== null && typeof raw === 'object' ? raw[id] : undefined
		const source = row !== null && typeof row === 'object' && !Array.isArray(row) ? row : {}
		const number = (value, fallback, low, high) => {
			const n = finite(value)
			return n === undefined ? fallback : Math.min(high, Math.max(low, Math.round(n)))
		}
		return {
			rpm: number(source.rpm, base[id].rpm, 1, 600),
			tpm: number(source.tpm, base[id].tpm, 1_000, 10_000_000),
			concurrency: number(source.concurrency, base[id].concurrency, 1, 64),
		}
	}
	return { low: pick('low'), mid: pick('mid'), high: pick('high') }
}

/**
 * 校验低余额告警。
 * @param raw - 未知输入。
 * @returns 规范化后的告警设置。
 */
export function normalizeLowBalanceAlert(raw) {
	const base = defaultLowBalanceAlert()
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const warn = percent(source.warnPercent)
	const critical = percent(source.criticalPercent)
	const quiet =
		source.quietHours !== null && typeof source.quietHours === 'object' && !Array.isArray(source.quietHours)
			? {
					start: /^\d{2}:\d{2}$/u.test(source.quietHours.start) ? source.quietHours.start : '22:00',
					end: /^\d{2}:\d{2}$/u.test(source.quietHours.end) ? source.quietHours.end : '08:00',
				}
			: null
	return {
		enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
		warnPercent: warn === undefined ? base.warnPercent : warn,
		criticalPercent: critical === undefined ? base.criticalPercent : critical,
		notify: typeof source.notify === 'boolean' ? source.notify : base.notify,
		quietHours: quiet,
	}
}

/**
 * 校验用量日报。
 * @param raw - 未知输入。
 * @returns 规范化后的日报设置。
 */
export function normalizeDailyReport(raw) {
	const base = defaultDailyReport()
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const time = typeof source.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(source.time) ? source.time : base.time
	return {
		enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
		time,
		format: oneOf(source.format, ['digest', 'detail'], base.format),
	}
}

/**
 * 校验全部工具。
 * @param raw - 未知输入。
 * @returns 规范化后的工具设置。
 */
export function normalizeTools(raw) {
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	return {
		qianfanThrottle: normalizeThrottleTool(source.qianfanThrottle),
		lowBalanceAlert: normalizeLowBalanceAlert(source.lowBalanceAlert),
		dailyReport: normalizeDailyReport(source.dailyReport),
	}
}

/**
 * 校验整份设置。未知字段丢弃，已知字段逐项退默认。
 * @param raw - 未知输入。
 * @returns 规范化后的 v2 文档。
 */
export function normalizeSettings(raw) {
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const vendors = {}
	const rawVendors = source.vendors !== null && typeof source.vendors === 'object' ? source.vendors : {}
	for (const [id, value] of Object.entries(rawVendors)) {
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) continue
		vendors[id] = normalizeVendorSettings(value)
	}
	return {
		version: SETTINGS_VERSION,
		theme: oneOf(source.theme, THEME_IDS, 'system'),
		visualStyle: VISUAL_STYLE_IDS.includes(source.visualStyle) ? source.visualStyle : 'grid',
		accent: ACCENT_IDS.includes(source.accent) ? source.accent : (colour(source.accent) ?? 'jade'),
		density: oneOf(source.density, DENSITY_IDS, 'comfortable'),
		card: normalizeCardSettings(source.card),
		vendors,
		tools: normalizeTools(source.tools),
	}
}

/**
 * 把一份补丁合并进当前文档。`vendors.<id>` 与 `tools.*` 是深合并，其余字段是替换。
 * @param current - 当前文档（可已是规范化后的）。
 * @param patch - 浏览器提交的补丁。
 * @returns `{ next }` 或 `{ error }`。
 */
export function applySettingsPatch(current, patch) {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
		return { error: '设置补丁必须是一个对象。' }
	}
	const base = normalizeSettings(current)
	const merged = { ...base }
	for (const [field, value] of Object.entries(patch)) {
		if (field === 'vendors') {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				return { error: 'vendors 必须是对象。' }
			}
			const vendors = { ...base.vendors }
			for (const [id, part] of Object.entries(value)) {
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) return { error: `厂商 id 不合法：${id}` }
				if (part === null || typeof part !== 'object' || Array.isArray(part)) {
					return { error: `厂商 ${id} 的设置必须是对象。` }
				}
				vendors[id] = normalizeVendorSettings({
					...(base.vendors[id] ?? defaultVendorSettings()),
					...part,
					advanced: {
						...(base.vendors[id]?.advanced ?? {}),
						...(part.advanced !== null && typeof part.advanced === 'object' ? part.advanced : {}),
					},
				})
			}
			merged.vendors = vendors
			continue
		}
		if (field === 'tools') {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				return { error: 'tools 必须是对象。' }
			}
			merged.tools = normalizeTools({
				...base.tools,
				...value,
				qianfanThrottle: { ...base.tools.qianfanThrottle, ...(value.qianfanThrottle ?? {}) },
				lowBalanceAlert: { ...base.tools.lowBalanceAlert, ...(value.lowBalanceAlert ?? {}) },
				dailyReport: { ...base.tools.dailyReport, ...(value.dailyReport ?? {}) },
			})
			continue
		}
		if (field === 'card') {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				return { error: 'card 必须是对象。' }
			}
			merged.card = normalizeCardSettings({ ...base.card, ...value })
			continue
		}
		if (!(field in base)) return { error: `未知设置字段：${field}` }
		merged[field] = value
	}
	return { next: normalizeSettings(merged) }
}

/**
 * 读一份 JSON 文件；不存在或坏文件返回 undefined。
 * @param filePath - 绝对路径。
 * @returns 解析后的对象，或 undefined。
 */
function readJson(filePath) {
	try {
		if (!existsSync(filePath)) return undefined
		const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * 读设置文件并按 schema 规范化。损坏字段退默认，不抛。
 * @param filePath - v2 文件路径。
 * @returns 规范化后的设置。
 */
export function readSettingsFile(filePath) {
	return normalizeSettings(readJson(filePath))
}

/**
 * 原子写设置文件（临时文件 + rename）。写入顺序稳定，便于 diff。
 * @param filePath - v2 文件路径。
 * @param values - 已规范化的设置。
 */
export function writeSettingsFile(filePath, values) {
	const ordered = normalizeSettings(values)
	mkdirSync(dirname(filePath), { recursive: true })
	const temporary = `${filePath}.tmp`
	writeFileSync(temporary, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
	renameSync(temporary, filePath)
	return ordered
}

/**
 * 解析本插件设置目录。
 * @param config - 已解析的包配置。
 * @returns `{ dir, file, legacyFile, backupFile }`。
 */
export function settingsPaths(config) {
	if (typeof config?.settingsFile === 'string' && config.settingsFile !== '') {
		return {
			dir: dirname(config.settingsFile),
			file: config.settingsFile,
			legacyFile: join(dirname(config.settingsFile), LEGACY_SETTINGS_FILE),
			backupFile: join(dirname(config.settingsFile), 'balance-settings.v1.backup.json'),
		}
	}
	const home =
		process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
			? process.env.DSH_HOME
			: join(homedir(), '.dsh')
	const dir = join(home, 'dsh-balance-card')
	return {
		dir,
		file: join(dir, SETTINGS_FILE),
		legacyFile: join(dir, LEGACY_SETTINGS_FILE),
		backupFile: join(dir, 'balance-settings.v1.backup.json'),
	}
}

/**
 * 把 1.x 文档迁移成 2.0 文档。
 *
 * 只搬仍然存在的语义：显示位置 → 卡片可见、旧风格名 → 新风格、六个 API 厂商的
 * 开关 → vendors、限流字段 → tools.qianfanThrottle。WorkBuddy / Qoder / OrcaTerm /
 * cost-meter / MobileClaw 一律丢弃，不再出现在 UI 里。
 * @param legacy - 1.x 的 JSON 对象。
 * @param knownVendorIds - 当前注册表里的厂商 id，用于丢弃已删除项。
 * @returns `{ settings, notes }`。
 */
export function migrateLegacySettings(legacy, knownVendorIds = []) {
	const notes = []
	const source = legacy !== null && typeof legacy === 'object' ? legacy : {}
	const next = defaultSettings()

	const placement = source.placement
	if (typeof placement === 'string') {
		next.card.visible = placement !== 'none'
		if (placement !== 'sidebar') notes.push('输入框胶囊已移除，卡片固定在侧边栏。')
	}

	const style = VISUAL_STYLE_MIGRATION[String(source.visualStyle ?? '')]
	if (style !== undefined) {
		next.visualStyle = style
		if (source.visualStyle !== style) notes.push(`视觉样式 ${String(source.visualStyle)} 已迁移为 ${style}。`)
	}

	if (typeof source.accentColor === 'string') {
		const candidate = colour(source.accentColor)
		if (candidate !== undefined && candidate.toLowerCase() !== '#ffffff') next.accent = candidate
	}

	if (typeof source.pollMs === 'number' && Number.isFinite(source.pollMs)) {
		next.card.pollMs = Math.min(3_600_000, Math.max(15_000, Math.round(source.pollMs)))
	}
	if (typeof source.warnPercent === 'number' && Number.isFinite(source.warnPercent)) {
		next.card.warnPercent = Math.min(100, Math.max(0, source.warnPercent))
		// 卡片阈值在 2.0 由「低余额告警」统一管理；旧值同时搬过去，避免默认 20 覆盖它。
		next.tools.lowBalanceAlert.warnPercent = Math.min(100, Math.max(0, source.warnPercent))
	}
	if (typeof source.showUpdatedAt === 'boolean') next.card.showUpdatedAt = source.showUpdatedAt
	if (typeof source.showPercent === 'boolean') next.card.showPercent = source.showPercent
	if (typeof source.showBar === 'boolean') next.card.showBar = source.showBar
	if (typeof source.cardBorder === 'boolean') next.card.showBar = source.cardBorder
	if (typeof source.groupDigits === 'boolean') next.card.groupDigits = source.groupDigits
	if (source.unitStyle === 'none') next.card.currencyStyle = 'plain'
	if (source.unitStyle === 'name') {
		next.card.currencyStyle = 'symbol'
		notes.push('货币「名称」写法已改为「符号」。')
	}

	const known = new Set(knownVendorIds)
	const providerMap = { 'kimi-coding': 'kimi' }
	const toggles = source.providers !== null && typeof source.providers === 'object' ? source.providers : {}
	for (const [id, enabled] of Object.entries(toggles)) {
		const vendorId = providerMap[id] ?? id
		if (!known.has(vendorId)) continue
		next.vendors[vendorId] = { ...defaultVendorSettings(), enabled: enabled !== false }
	}

	// 限流字段（1.x 是顶层），迁移进工具。
	const throttle = next.tools.qianfanThrottle
	if (typeof source.throttleEnabled === 'boolean') throttle.enabled = source.throttleEnabled
	if (source.throttleMode === 'manual' || source.throttleMode === 'dynamic') throttle.mode = source.throttleMode
	if (THROTTLE_PRESET_IDS.includes(source.throttlePreset)) throttle.preset = source.throttlePreset
	if (typeof source.throttleProbe === 'boolean') throttle.probe = source.throttleProbe
	if (PROBE_PACE_IDS.includes(source.throttleProbePace)) throttle.probePace = source.throttleProbePace
	if (typeof source.throttleSafety === 'number' && Number.isFinite(source.throttleSafety)) {
		throttle.safety = Math.min(0.95, Math.max(0.5, source.throttleSafety))
	}
	if (typeof source.throttleMaxConcurrent === 'number' && Number.isFinite(source.throttleMaxConcurrent)) {
		throttle.maxConcurrent = Math.min(5, Math.max(1, Math.round(source.throttleMaxConcurrent)))
	}
	if (typeof source.throttleCooldownCapMs === 'number') throttle.cooldownCapMs = source.throttleCooldownCapMs
	if (typeof source.throttleQueueTimeoutMs === 'number') throttle.queueTimeoutMs = source.throttleQueueTimeoutMs
	if (source.throttleManual !== null && typeof source.throttleManual === 'object') {
		throttle.manual = normalizePresets(source.throttleManual)
	}

	next.tools = normalizeTools(next.tools)
	return { settings: normalizeSettings(next), notes }
}

/**
 * 执行一次迁移：备份旧文件、写新文件。
 *
 * 失败时不写新文件，抛出的错误由调用方转成设置页的「迁移失败」提示；旧文件始终
 * 保留，用户可手工回退。
 * @param paths - `settingsPaths()` 的返回值。
 * @param knownVendorIds - 当前注册表里的厂商 id。
 * @returns `{ migrated, notes }`，或 `{ migrated: false }` 当没有旧文件。
 */
export function migrateIfNeeded(paths, knownVendorIds = []) {
	if (existsSync(paths.file)) return { migrated: false, notes: [] }
	const legacy = readJson(paths.legacyFile)
	if (legacy === undefined) {
		// 没有旧文件：写一份默认文档，让首次打开的设置页有确定的状态。
		writeSettingsFile(paths.file, defaultSettings())
		return { migrated: false, notes: [] }
	}
	mkdirSync(paths.dir, { recursive: true })
	writeFileSync(paths.backupFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
	const outcome = migrateLegacySettings(legacy, knownVendorIds)
	writeSettingsFile(paths.file, outcome.settings)
	return { migrated: true, notes: outcome.notes }
}