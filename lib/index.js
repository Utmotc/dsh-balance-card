/**
 * dsh-balance-card 2.0 — 宿主半边。
 *
 * 一个自包含的余额/额度监控器：
 * - 只读 19 家厂商的官方账单/额度接口，凭据从 DSH `credentials` 按请求解析；
 * - 浏览器只拿到归一化读数、状态与错误码，永远拿不到 Key / Cookie / 原始响应；
 * - 设置写本插件自己的 `balance-settings-v2.json`（原子写、串行化），不写 loader；
 * - 千帆限流阀门继续复用 1.x 的 `throttle*.js` 与旧状态文件。
 *
 * ## 路由
 *
 * 全部注册在 Connection 的鉴权 `/api` 通道上，只接受 loopback/owner：
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | GET | `/api/dsh-balance-card/v2/snapshot` | 设置 + 厂商目录 + 全部读数 |
 * | GET | `/api/dsh-balance-card/v2/providers` | 厂商目录与凭据状态 |
 * | POST | `/api/dsh-balance-card/v2/settings` | 设置补丁 |
 * | POST | `/api/dsh-balance-card/v2/refresh` | 手动刷新（单家或全部） |
 * | POST | `/api/dsh-balance-card/v2/credentials` | 保存凭据 |
 * | POST | `/api/dsh-balance-card/v2/credentials/test` | 只测试，不保存 |
 * | POST | `/api/dsh-balance-card/v2/credentials/clear` | 清除凭据 |
 * | GET/POST | `/api/dsh-balance-card/v2/tools` | 工具状态与设置 |
 * | GET | `/api/dsh-balance-card/v2/throttle/status` | 限流状态 |
 * | POST | `/api/dsh-balance-card/v2/throttle/reset` | 重置学习值 |
 * | GET | `/api/dsh-balance-card/v2/export` | 导出设置（不含密钥） |
 * | POST | `/api/dsh-balance-card/v2/import` | 导入设置 |
 * | GET | `/api/dsh-balance-card/v2/diagnostics` | 脱敏诊断 |
 *
 * ## 启动安全
 *
 * `inject` 为空：`credentials` / `connection` 通过 `ctx.inject` 的子 fiber 等待，
 * 任何一个服务缺席只会让本插件退化为「没有卡片」，不会让整页启动失败。
 * @module dsh-balance-card
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCache } from './cache.js'
import { createCredentials } from './credentials.js'
import { ERROR_ADVICE, describeError } from './errors.js'
import { allVendors, monitorableVendors, ROUTE_PREFIXES, vendorById, vendorForRoute, vendorView } from './registry.js'
import { applySettingsPatch, defaultVendorSettings, migrateIfNeeded, readSettingsFile, settingsPaths, writeSettingsFile } from './settings.js'
import { createThrottleHost, isQianfanProvider } from './throttle-host.js'
import { queryVendor, probeVendor } from './vendors/index.js'
import { maybeGenerateDigest, readDigest, readReport, recordSnapshot } from './report.js'

/** 本包版本（与 package.json 同步）。 */
export const PLUGIN_VERSION = '2.0.0'

/** 插件 id。 */
export const name = 'balance-monitor'

/** 没有任何硬依赖；全部能力在 `apply` 内通过 `ctx.inject` 获取。 */
export const inject = []

/** 路由前缀。 */
const API = '/api/dsh-balance-card/v2'

/** 默认超时与手动刷新节流。 */
const DEFAULT_TIMEOUT_MS = 15_000
const MANUAL_REFRESH_GAP_MS = 5_000
const SNAPSHOT_WAIT_MS = 2_500

/**
 * 读一份 JSON 文件；坏文件返回 undefined。
 * @param file - 绝对路径。
 * @returns 对象或 undefined。
 */
function readJson(file) {
	try {
		if (!existsSync(file)) return undefined
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * 统一失败响应。
 * @param code - 机器码。
 * @param message - 中文说明。
 * @param status - HTTP 状态。
 * @returns Response。
 */
function failure(code, message, status = 400) {
	return Response.json({ ok: false, error: { code, message } }, { status })
}

/**
 * 统一成功响应（禁止缓存）。
 * @param value - 响应体。
 * @returns Response。
 */
function success(value) {
	return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * 安全解析请求体。
 * @param request - Fetch Request。
 * @returns 对象或 undefined。
 */
async function bodyOf(request) {
	try {
		const parsed = await request.json()
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * 规范化用户粘贴的凭据：容忍 `Cookie:` 前缀与换行，不改变内容本身。
 * @param value - 原始输入。
 * @returns 规范化后的字符串。
 */
function normalizeSecret(value) {
	let text = typeof value === 'string' ? value.trim() : ''
	if (text === '') return ''
	text = text.replace(/^(?:cookie|authorization)\s*:\s*/iu, '').replace(/[\r\n]+/gu, ' ').trim()
	if (
		(text.startsWith('"') && text.endsWith('"')) ||
		(text.startsWith("'") && text.endsWith("'"))
	) {
		text = text.slice(1, -1).trim()
	}
	return text
}

/**
 * 一家厂商是否已经具备读取条件。
 *
 * 必填字段全部有值才算已配置；自定义接口与千问允许「只填端点」——它们的凭据
 * 是可选的，端点本身就是配置。
 * @param vendor - 注册表条目。
 * @param bundle - `{ field: value }`。
 * @param settings - 该厂商的设置。
 * @returns 是否可读。
 */
function isConfigured(vendor, fieldStates, settings) {
	// 自定义接口与千问：端点本身就是配置，Key 可选；没有端点就是「待配置」。
	if (vendor.id === 'custom' || vendor.id === 'qwen') {
		const endpoint = settings?.advanced?.endpoint
		return typeof endpoint === 'string' && endpoint !== ''
	}
	const fields = vendor.credential?.fields ?? []
	const states = new Map((fieldStates ?? []).map((entry) => [entry.field, entry.configured === true]))
	return fields.every((field) => states.get(field.field) === true)
}

/**
 * 生成本插件配置目录。
 * @param config - 行配置。
 * @returns 路径集合。
 */
function resolvePaths(config) {
	const paths = settingsPaths(config)
	const dir = paths.dir
	return {
		...paths,
		throttleStateFile:
			typeof config?.throttleStateFile === 'string' && config.throttleStateFile !== ''
				? config.throttleStateFile
				: join(dir, 'throttle-state.json'),
		reportFile: join(dir, 'daily-usage.json'),
	}
}

/**
 * 建一个可注入时钟的限流阀门（测试可替换 now/sleep）。
 * @param ctx - 插件上下文。
 * @param paths - 路径集合。
 * @returns 阀门。
 */
function createThrottle(ctx, paths) {
	return createThrottleHost({
		readSettings: () => readSettingsFile(paths.file),
		stateFile: paths.throttleStateFile,
		warn: (message) => ctx.logger?.warn?.(message),
	})
}

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 * @param config - 行配置。
 */
export function apply(ctx, config) {
	const resolved = config !== null && typeof config === 'object' ? config : {}
	const paths = resolvePaths(resolved)
	const timeoutMs =
		typeof resolved.timeoutMs === 'number' && Number.isFinite(resolved.timeoutMs)
			? Math.min(60_000, Math.max(3_000, resolved.timeoutMs))
			: DEFAULT_TIMEOUT_MS

	/** 最近一次真实模型请求的 provider：会话事件拿不到时的兜底。 */
	let lastProvider = ''
	if (typeof ctx.on === 'function') {
		try {
			ctx.effect?.(
				() =>
					ctx.on('llm/stream', (request, next) => {
						if (typeof request?.provider === 'string' && request.provider !== '') lastProvider = request.provider
						return next(request)
					}),
				'balance-card: 记录当前 provider',
			)
		} catch (error) {
			ctx.logger?.warn?.(`balance-card: 无法记录 provider：${error instanceof Error ? error.message : String(error)}`)
		}
	}

	let throttle
	try {
		throttle = createThrottle(ctx, paths)
		// 把阀门挂到 llm/stream 的 waterfall 上：只治理千帆路由，其余直通。
		throttle.attach(ctx)
		ctx.effect?.(() => () => throttle.dispose(), 'balance-card: 千帆限流阀门')
	} catch (error) {
		ctx.logger?.warn?.(`balance-card: 限流阀门未启动：${error instanceof Error ? error.message : String(error)}`)
	}

	ctx.inject(['credentials', 'connection'], (scope) => {
		register(scope, {
			paths,
			timeoutMs,
			throttle,
			lastProvider: () => lastProvider,
		})
	})
}

/**
 * 注册全部路由。
 * @param ctx - 已注入服务的子上下文。
 * @param options - `{ paths, timeoutMs, throttle }`。
 */
function register(ctx, options) {
	const { paths, timeoutMs, throttle } = options
	const lastProvider = typeof options.lastProvider === 'function' ? options.lastProvider : () => ''
	const credentialsService = ctx.credentials
	const credentials = createCredentials(credentialsService)

	/** 首次迁移；失败只记录，不阻塞卡片。 */
	let migration = { migrated: false, notes: [] }
	let migrationError = ''
	try {
		migration = migrateIfNeeded(
			paths,
			allVendors().map((vendor) => vendor.id),
		)
	} catch (error) {
		migrationError = error instanceof Error ? error.message : String(error)
	}

	/** 设置写入串行化：读-改-写必须按顺序完成。 */
	let writeChain = Promise.resolve()
	/** 手动刷新节流。 */
	const lastManual = new Map()

	/**
	 * 应用一份设置补丁并原子写入。
	 * @param patch - 浏览器补丁。
	 * @returns `{ ok: true, value }` 或 `{ ok: false, error }`。
	 */
	const patchSettings = (patch) => {
		const run = writeChain.then(() => {
			const outcome = applySettingsPatch(readSettingsFile(paths.file), patch)
			if (outcome.error !== undefined) return { ok: false, error: outcome.error }
			const written = writeSettingsFile(paths.file, outcome.next)
			// 开关/凭据/高级设置变化后，下一次读必须重新发请求。
			for (const vendor of monitorableVendors()) cache.invalidate(vendor.id)
			return { ok: true, value: written }
		})
		writeChain = run.catch(() => {})
		return run
	}

	/**
	 * 建缓存：真正发请求前才解析凭据。
	 * @param plan - `{ vendor, settings, configured }`。
	 * @returns 归一化读数。
	 */
	const fetchVendor = async (plan) => {
		const bundle = await credentials.bundleFor(plan.vendor, dshKeyRefs(plan.vendor))
		try {
			return await queryVendor(plan.vendor, {
				credentials: bundle,
				settings: plan.settings,
				timeoutMs,
			})
		} catch (error) {
			const described = describeError(error)
			const wrapped = new Error(described.message)
			wrapped.code = described.code
			wrapped.advice = described.advice
			if (described.status !== undefined) wrapped.status = described.status
			throw wrapped
		}
	}

	const cache = createCache({ fetchVendor, concurrency: 3 })

	/**
	 * 读取一家厂商的凭据状态（浏览器安全）。
	 * @param vendor - 注册表条目。
	 * @returns `{ bundle, configured, fields }`。
	 */
	const credentialStateOf = async (vendor) => {
		const state = await credentials.describeVendor(vendor, dshKeyRefs(vendor))
		return {
			...state,
			configured: isConfigured(vendor, state.fields, currentSettings().vendors[vendor.id] ?? defaultVendorSettings()),
		}
	}

	/**
	 * 当前设置（读文件 + 校验）。
	 * @returns 设置文档。
	 */
	const currentSettings = () => readSettingsFile(paths.file)

	/**
	 * 一家厂商的读取计划。
	 * @param vendor - 注册表条目。
	 * @param settings - 设置文档。
	 * @param configured - 凭据是否齐全。
	 * @returns plan。
	 */
	const planOf = (vendor, settings, configured) => ({
		vendor,
		settings: settings.vendors[vendor.id] ?? defaultVendorSettings(),
		enabled: (settings.vendors[vendor.id] ?? defaultVendorSettings()).enabled === true,
		configured,
		globalPollMs: settings.card.pollMs,
	})

	/**
	 * 组装快照：设置、厂商目录、读数、工具状态。
	 * @param options - `{ force?, waitMs?, vendorId? }`。
	 * @returns 快照。
	 */
	const snapshot = async ({ force = false, waitMs = 0, vendorId } = {}) => {
		const settings = currentSettings()
		const vendors = monitorableVendors()
		const states = new Map()
		await Promise.all(
			vendors.map(async (vendor) => {
				states.set(vendor.id, await credentialStateOf(vendor))
			}),
		)
		const targets = vendorId === undefined ? vendors : vendors.filter((vendor) => vendor.id === vendorId)
		const records = await Promise.all(
			targets.map(async (vendor) => {
				const state = states.get(vendor.id)
				const plan = planOf(vendor, settings, state?.configured === true)
				const record = await cache.get(plan, { force, waitMs })
				return [vendor.id, record]
			}),
		)
		const readings = {}
		for (const [id, record] of records) {
			readings[id] = {
				status: record.status,
				reading: record.reading,
				error: record.error,
				fetchedAt: record.fetchedAt,
				nextAt: record.nextAt,
			}
		}
		const roster = vendors.map((vendor) => {
			const state = states.get(vendor.id)
			const view = vendorView(vendor, settings.vendors[vendor.id] ?? defaultVendorSettings(), {
				configured: state?.configured === true,
			})
			return {
				...view,
				credentialFields: state?.fields ?? [],
			}
		})
		const unsupported = allVendors()
			.filter((vendor) => vendor.status === 'unsupported')
			.map((vendor) => vendorView(vendor, defaultVendorSettings(), { configured: false }))

		// 日报只在这里顺手记一笔，不额外请求厂商。
		try {
			recordSnapshot(paths.reportFile, readings)
			maybeGenerateDigest(paths.reportFile, settings.tools.dailyReport)
		} catch {
			// 统计失败不影响读数。
		}

		return {
			version: PLUGIN_VERSION,
			settings,
			vendors: roster,
			unsupported,
			readings,
			tools: toolsView(settings),
			meta: {
				migrated: migration.migrated,
				migrationNotes: migration.notes,
				migrationError,
				credentialsAvailable: credentials.available,
				routeMap: routeMap(),
				// 自定义 provider 后缀（如 baiduqianfanlyq）由浏览器按同一张前缀表匹配。
				routePrefixes: ROUTE_PREFIXES,
				// 最近一次真实模型请求的 provider；浏览器优先用会话事件，拿不到时用这个。
				currentProvider: lastProvider(),
				// 新会话尚未选模型时，用 DSH 的全局默认选择兜底。
				defaultProvider: defaultProvider(),
				generatedAt: Date.now(),
			},
		}
	}

	/** @returns provider route → vendor id。 */
	const routeMap = () => {
		const map = {}
		for (const vendor of allVendors()) {
			for (const alias of vendor.aliases) map[alias.toLowerCase()] = vendor.id
			map[vendor.id] = vendor.id
		}
		return map
	}

	/**
	 * DSH 的全局默认模型选择（新会话尚未选择时使用）。
	 * @returns provider route 或空串。
	 */
	const defaultProvider = () => {
		try {
			const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
			const provider = selection?.provider
			return typeof provider === 'string' ? provider : ''
		} catch {
			return ''
		}
	}

	/**
	 * 工具状态投影。
	 * @param settings - 设置文档。
	 * @returns 工具与限流状态。
	 */
	const toolsView = (settings) => {
		let throttleStatus = null
		if (throttle !== undefined) {
			try {
				throttleStatus = throttle.status({
					retryHint: retryHintFor(),
					governedRoutes: governedRoutesFor(),
				})
			} catch {
				throttleStatus = null
			}
		}
		return {
			qianfanThrottle: {
				settings: settings.tools.qianfanThrottle,
				status: throttleStatus,
			},
			lowBalanceAlert: settings.tools.lowBalanceAlert,
			dailyReport: {
				settings: settings.tools.dailyReport,
				days: readReport(paths.reportFile),
				digest: readDigest(paths.reportFile),
			},
			slots: [],
			notifySupported: false,
		}
	}

	/**
	 * 读取一次设置服务快照，短 TTL 缓存。
	 * 一次 snapshot 会为每家 API 厂商查同一个 `llm-pi-ai` section；不缓存会把
	 * `settings.describe()` 调几十次。500ms 足够覆盖一次请求，也不会让刚改的
	 * apiKeyEnv 长时间不生效。
	 * @returns describe() 行数组，服务缺席时为空数组。
	 */
	let describedRows = null
	let describedRowsAt = 0
	const describeRows = () => {
		const now = Date.now()
		if (describedRows !== null && now - describedRowsAt < 500) return describedRows
		try {
			const settings = ctx.get('settings')
			if (settings === undefined || typeof settings.describe !== 'function') return []
			describedRows = settings.describe()
			describedRowsAt = now
			return describedRows
		} catch {
			return []
		}
	}

	/**
	 * 读一个设置 section（限流提示/官方 Key 复用用）。
	 * @param namespace - 设置命名空间。
	 * @returns section 对象或 undefined。
	 */
	const sectionOf = (namespace) => {
		const row = describeRows().find((entry) => entry !== null && entry.ns === namespace)
		const value = row?.value
		return value !== null && typeof value === 'object' ? value : undefined
	}

	/**
	 * DSH 官方提供商已经配置好的 API Key 引用。
	 *
	 * 只对 `api-key` 类型生效：这些厂商的账单接口通常接受与推理相同的 Key。
	 * 控制台 Cookie / OAuth / AK-SK / 本机登录态不属于这里——能调用模型不代表
	 * 能用同一份凭据读余额。
	 * @param vendor - 注册表条目。
	 * @returns `{ key: string[] }`，没有可复用引用时为空对象。
	 */
	const dshKeyRefs = (vendor) => {
		if (vendor?.credential?.type !== 'api-key') return {}
		const refs = new Set()
		const providers = sectionOf('llm-pi-ai')?.providers
		if (providers !== null && typeof providers === 'object') {
			for (const [route, profile] of Object.entries(providers)) {
				if (vendorForRoute(route) !== vendor.id) continue
				const ref = profile?.apiKeyEnv
				if (typeof ref === 'string' && ref !== '') refs.add(ref)
			}
		}
		if (vendor.id === 'deepseek') {
			const ref = sectionOf('llm-deepseek-api-key')?.apiKeyEnv
			if (typeof ref === 'string' && ref !== '') refs.add(ref)
		}
		return refs.size === 0 ? {} : { key: [...refs] }
	}

	/** @returns 被阀门治理的 provider id。 */
	const governedRoutesFor = () => {
		const providers = sectionOf('llm-pi-ai')?.providers
		if (providers === null || typeof providers !== 'object') return []
		return Object.keys(providers).filter((provider) => isQianfanProvider(provider))
	}

	/** @returns 千帆路由的重试策略提示。 */
	const retryHintFor = () => {
		const providers = sectionOf('llm-pi-ai')?.providers
		if (providers === null || typeof providers !== 'object') return null
		for (const [provider, profile] of Object.entries(providers)) {
			if (!isQianfanProvider(provider)) continue
			const configured = profile?.retryPolicy
			const maxRetries =
				configured !== null && typeof configured === 'object' && Number.isInteger(configured.maxRetries)
					? Math.max(0, configured.maxRetries)
					: 5
			return { provider, maxRetries, configured: configured !== undefined }
		}
		return null
	}

	/**
	 * 注册一个鉴权路由。
	 * @param path - 精确路径。
	 * @param methods - HTTP 方法。
	 * @param handler - 处理函数。
	 */
	const route = (path, methods, handler) => {
		ctx.connection.fetch.register({
			path,
			methods,
			requestBody: 'buffered',
			fetch: async (request) => {
				try {
					return await handler(request)
				} catch (error) {
					const described = describeError(error)
					return Response.json(
						{ ok: false, error: { ...described, advice: ERROR_ADVICE[described.code] ?? described.advice } },
						{ status: 500 },
					)
				}
			},
		})
	}

	route(`${API}/snapshot`, ['GET'], async () => success(await snapshot({ waitMs: SNAPSHOT_WAIT_MS })))

	route(`${API}/providers`, ['GET'], async () => {
		const settings = currentSettings()
		const vendors = monitorableVendors()
		const states = new Map()
		await Promise.all(vendors.map(async (vendor) => states.set(vendor.id, await credentialStateOf(vendor))))
		return success({
			vendors: vendors.map((vendor) => {
				const state = states.get(vendor.id)
				return {
					...vendorView(vendor, settings.vendors[vendor.id] ?? defaultVendorSettings(), {
						configured: state?.configured === true,
					}),
					credentialFields: state?.fields ?? [],
				}
			}),
			unsupported: allVendors()
				.filter((vendor) => vendor.status === 'unsupported')
				.map((vendor) => vendorView(vendor, defaultVendorSettings(), { configured: false })),
			routeMap: routeMap(),
		})
	})

	route(`${API}/settings`, ['GET', 'POST'], async (request) => {
		if (request.method === 'GET') {
			return success({ settings: currentSettings(), migration: { ...migration, error: migrationError } })
		}
		const patch = await bodyOf(request)
		if (patch === undefined) return failure('invalid-json', '请求体不是 JSON 对象。')
		const outcome = await patchSettings(patch)
		if (outcome.ok !== true) return failure('invalid-patch', outcome.error)
		return success({ settings: outcome.value })
	})

	route(`${API}/refresh`, ['POST'], async (request) => {
		const body = (await bodyOf(request)) ?? {}
		const vendorId = typeof body.vendorId === 'string' ? body.vendorId : ''
		const settings = currentSettings()
		const now = Date.now()
		if (vendorId !== '') {
			const vendor = vendorById(vendorId)
			if (vendor === undefined || vendor.status === 'unsupported') {
				return failure('unknown-vendor', `未知厂商：${vendorId}`, 404)
			}
			const state = await credentialStateOf(vendor)
			const last = lastManual.get(vendorId) ?? 0
			if (now - last < MANUAL_REFRESH_GAP_MS) {
				return success({ throttled: true, retryAfterMs: MANUAL_REFRESH_GAP_MS - (now - last) })
			}
			lastManual.set(vendorId, now)
			const plan = planOf(vendor, settings, state.configured)
			cache.invalidate(vendorId)
			const record = await cache.get(plan, { force: true, waitMs: timeoutMs + 1_000 })
			return success({
				throttled: false,
				readings: {
					[vendorId]: {
						status: record.status,
						reading: record.reading,
						error: record.error,
						fetchedAt: record.fetchedAt,
					},
				},
			})
		}

		// 全部刷新：每家独立 5 秒节流，并发由缓存闸门限制。
		const vendors = monitorableVendors()
		const states = new Map()
		await Promise.all(vendors.map(async (vendor) => states.set(vendor.id, await credentialStateOf(vendor))))
		const readings = {}
		await Promise.all(
			vendors.map(async (vendor) => {
				const last = lastManual.get(vendor.id) ?? 0
				if (now - last < MANUAL_REFRESH_GAP_MS) {
					const record = cache.recordOf(vendor.id)
					readings[vendor.id] = { status: record.status, reading: record.reading, error: record.error, fetchedAt: record.fetchedAt, throttled: true }
					return
				}
				lastManual.set(vendor.id, now)
				const plan = planOf(vendor, settings, states.get(vendor.id)?.configured === true)
				cache.invalidate(vendor.id)
				const record = await cache.get(plan, { force: true, waitMs: timeoutMs + 1_000 })
				readings[vendor.id] = { status: record.status, reading: record.reading, error: record.error, fetchedAt: record.fetchedAt }
			}),
		)
		return success({ throttled: false, readings })
	})

	route(`${API}/credentials`, ['POST'], async (request) => {
		const body = await bodyOf(request)
		if (body === undefined) return failure('invalid-json', '请求体不是 JSON 对象。')
		const vendorId = typeof body.vendorId === 'string' ? body.vendorId : ''
		const field = typeof body.field === 'string' ? body.field : ''
		const vendor = vendorById(vendorId)
		if (vendor === undefined || vendor.status === 'unsupported') return failure('unknown-vendor', `未知厂商：${vendorId}`, 404)
		const value = normalizeSecret(body.value)
		if (value === '') return failure('invalid-credential', '凭据不能为空。')
		const saved = await credentials.saveVendor(vendor, field, value)
		if (saved.ok !== true) return failure('save-failed', saved.message, 500)
		cache.invalidate(vendor.id)
		const state = await credentialStateOf(vendor)
		// 只回公开字段：bundle 里的明文永远不出 host。
		return success({
			saved: true,
			credential: { configured: state.configured, fields: state.fields, type: state.type, consoleUrl: state.consoleUrl },
		})
	})

	route(`${API}/credentials/test`, ['POST'], async (request) => {
		const body = await bodyOf(request)
		if (body === undefined) return failure('invalid-json', '请求体不是 JSON 对象。')
		const vendorId = typeof body.vendorId === 'string' ? body.vendorId : ''
		const vendor = vendorById(vendorId)
		if (vendor === undefined || vendor.status === 'unsupported') return failure('unknown-vendor', `未知厂商：${vendorId}`, 404)
		const settings = currentSettings()
		const vendorSettings = settings.vendors[vendor.id] ?? defaultVendorSettings()
		const saved = await credentials.bundleFor(vendor, dshKeyRefs(vendor))
		const overrides = {}
		if (typeof body.field === 'string' && typeof body.value === 'string' && body.value !== '') {
			overrides[body.field] = normalizeSecret(body.value)
		}
		const result = await probeVendor(vendor, {
			credentials: { ...saved, ...overrides },
			settings: vendorSettings,
			timeoutMs,
		})
		return success(result)
	})

	route(`${API}/credentials/clear`, ['POST'], async (request) => {
		const body = await bodyOf(request)
		if (body === undefined) return failure('invalid-json', '请求体不是 JSON 对象。')
		const vendorId = typeof body.vendorId === 'string' ? body.vendorId : ''
		const field = typeof body.field === 'string' ? body.field : ''
		const vendor = vendorById(vendorId)
		if (vendor === undefined || vendor.status === 'unsupported') return failure('unknown-vendor', `未知厂商：${vendorId}`, 404)
		const cleared = await credentials.clearVendor(vendor, field)
		if (cleared.ok !== true) return failure('clear-failed', cleared.message, 500)
		cache.invalidate(vendor.id)
		const state = await credentialStateOf(vendor)
		return success({
			cleared: true,
			credential: { configured: state.configured, fields: state.fields, type: state.type, consoleUrl: state.consoleUrl },
		})
	})

	route(`${API}/tools`, ['GET', 'POST'], async (request) => {
		if (request.method === 'GET') return success(toolsView(currentSettings()))
		const body = await bodyOf(request)
		if (body === undefined) return failure('invalid-json', '请求体不是 JSON 对象。')
		const patch = body.tools !== null && typeof body.tools === 'object' ? { tools: body.tools } : { tools: body }
		const outcome = await patchSettings(patch)
		if (outcome.ok !== true) return failure('invalid-patch', outcome.error)
		return success(toolsView(outcome.value))
	})

	route(`${API}/throttle/status`, ['GET'], async () => {
		if (throttle === undefined) return failure('throttle-unavailable', '限流阀门未启动。', 503)
		return success(throttle.status({ retryHint: retryHintFor(), governedRoutes: governedRoutesFor() }))
	})

	route(`${API}/throttle/reset`, ['POST'], async () => {
		if (throttle === undefined) return failure('throttle-unavailable', '限流阀门未启动。', 503)
		return success(throttle.reset({ retryHint: retryHintFor(), governedRoutes: governedRoutesFor() }))
	})

	route(`${API}/export`, ['GET'], async () => {
		const settings = currentSettings()
		const credentialsState = {}
		for (const vendor of monitorableVendors()) {
			const state = await credentialStateOf(vendor)
			const fields = {}
			for (const field of state.fields) fields[field.field] = field.configured
			credentialsState[vendor.id] = fields
		}
		return success({
			version: PLUGIN_VERSION,
			exportedAt: new Date().toISOString(),
			settings,
			credentials: credentialsState,
		})
	})

	route(`${API}/import`, ['POST'], async (request) => {
		const body = await bodyOf(request)
		if (body === undefined) return failure('invalid-json', '请求体不是 JSON 对象。')
		const imported = body.settings !== null && typeof body.settings === 'object' ? body.settings : body
		const outcome = await patchSettings({ ...imported, version: 2 })
		if (outcome.ok !== true) return failure('invalid-import', outcome.error)
		return success({ imported: true, settings: outcome.value })
	})

	route(`${API}/diagnostics`, ['GET'], async () => {
		const settings = currentSettings()
		const vendors = []
		for (const vendor of monitorableVendors()) {
			const state = await credentialStateOf(vendor)
			const record = cache.recordOf(vendor.id)
			vendors.push({
				id: vendor.id,
				label: vendor.label,
				status: vendor.status,
				enabled: settings.vendors[vendor.id]?.enabled === true,
				configured: state.configured,
				readingStatus: record.status,
				fetchedAt: record.fetchedAt,
				errorCode: record.error?.code ?? '',
				errorMessage: typeof record.error?.message === 'string' ? record.error.message.slice(0, 200) : '',
			})
		}
		return success({
			version: PLUGIN_VERSION,
			settingsPath: paths.file,
			settingsExists: existsSync(paths.file),
			migration,
			migrationError,
			credentialsAvailable: credentials.available,
			vendors,
			generatedAt: new Date().toISOString(),
		})
	})
}

/** 供测试直接使用的工具函数。 */
export { isConfigured, normalizeSecret, resolvePaths }