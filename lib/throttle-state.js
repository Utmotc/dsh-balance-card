/**
 * `throttle-state.json` — 限流学习状态的原子读写。
 *
 * 与 `balance-settings.json` 分开存放是刻意的：前者是运行时学习状态（每秒都可能
 * 变，包含窗口、冷却与 429 计数），后者是用户可见配置（只在用户点选时写）。混在
 * 一起会让设置页每次轮询都触发一次写盘。
 *
 * 写入沿用插件已有的原子写方式（临时文件 + rename）：崩溃后要么读到上一份完整
 * 文档，要么读到新的一份，不会读到半个 JSON。
 *
 * 这里只碰 `node:` 内置模块，与宿主半边其余部分的「不 import dsh 包」规则一致。
 *
 * @module dsh-balance-card/throttle-state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_ROUTES, activeRoutes, restoreRoute, serializeRoute } from './throttle.js'

/** 状态文件名，位于插件自己的 profile 目录下。 */
export const THROTTLE_STATE_FILE = 'throttle-state.json'
/** 文档版本；读到别的版本就当作没有历史状态（学习重来一次比读错状态安全）。 */
export const THROTTLE_STATE_VERSION = 1

/**
 * 解析状态文件的绝对路径。
 * @param configured - 包配置里的 `throttleStateFile`，为空时按 `$DSH_HOME` 推导。
 * @returns 绝对路径。
 */
export function throttleStateFilePath(configured) {
	if (typeof configured === 'string' && configured !== '') return configured
	const home =
		process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'dsh-balance-card', THROTTLE_STATE_FILE)
}

/**
 * 读回状态文档里的原始条目。
 *
 * 缺失、不可读、版本不符、结构不对都只返回空列表：学习状态是可以安全重建的缓存，
 * 一次损坏的文件绝不能挡住限流本身。
 * @param filePath - 状态文件绝对路径。
 * @returns 原始路由条目数组（未校验）。
 */
export function readThrottleStateFile(filePath) {
	let parsed
	try {
		if (!existsSync(filePath)) return []
		parsed = JSON.parse(readFileSync(filePath, 'utf8'))
	} catch {
		return []
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
	if (parsed.version !== THROTTLE_STATE_VERSION) return []
	return Array.isArray(parsed.routes) ? parsed.routes : []
}

/**
 * 读回并校验成路由状态。
 * @param filePath - 状态文件绝对路径。
 * @param options - `{ preset, manual, safety, now }`，用于补齐缺失字段。
 * @returns 路由状态数组（丢弃不可用条目，按最近活跃排序）。
 */
export function loadThrottleState(filePath, options) {
	const routes = []
	for (const raw of readThrottleStateFile(filePath)) {
		const state = restoreRoute(raw, options)
		if (state !== undefined) routes.push(state)
	}
	return activeRoutes(routes, MAX_ROUTES)
}

/**
 * 原子写入限流状态。
 *
 * 只写最近活跃的若干条路由，并按固定字段顺序序列化，让文件可读、diff 稳定。
 * @param filePath - 状态文件绝对路径。
 * @param routes - 路由状态数组。
 * @param now - 当前毫秒时间。`@returns` 写入是否成功（失败不抛出，限流不能因磁盘问题停摆）。
 */
export function writeThrottleState(filePath, routes, now) {
	try {
		const kept = activeRoutes(routes, MAX_ROUTES)
		const document = {
			version: THROTTLE_STATE_VERSION,
			savedAt: now,
			routes: kept.map(serializeRoute),
		}
		mkdirSync(dirname(filePath), { recursive: true })
		const temporary = `${filePath}.tmp`
		writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
		renameSync(temporary, filePath)
		return true
	} catch {
		return false
	}
}