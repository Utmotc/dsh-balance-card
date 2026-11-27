/**
 * dsh-balance-card 2.0 — DSH 凭据库的薄封装。
 *
 * 浏览器永远拿不到明文：`describeVendor()` 只返回「是否已配置、来源、掩码预览」，
 * 明文只在 host 半边按请求解析一次，直接放进厂商请求头。
 *
 * 一个厂商可能有多个候选引用（例如智谱的 ZAI_API_KEY / BIGMODEL_API_KEY、小米的
 * 单个 Cookie），写入统一落在第一个引用上，读取按顺序取第一个已配置的值——与 1.x
 * 的引用名保持一致，升级后用户无需重新粘贴。
 * @module dsh-balance-card/credentials
 */

/**
 * 引用 → 掩码。只保留少量前缀，足够认出「是哪一份」而不泄露内容。
 * @param value - 明文凭据。
 * @param visible - 保留的字符数。
 * @returns 掩码字符串。
 */
export function maskValue(value, visible = 6) {
	if (typeof value !== 'string' || value === '') return ''
	if (value.length <= visible) return '••••••'
	return `${value.slice(0, visible)}${'•'.repeat(6)}`
}

/**
 * 建一个凭据读写器。
 * @param service - DSH 的 `credentials` 服务（可能缺席）。
 * @returns 读写器。
 */
export function createCredentials(service) {
	const available = service !== undefined && service !== null

	/**
	 * 读一个引用的状态。服务缺席或 describe 不可用时返回 undefined（未知），
	 * 与「确定未配置」区分开。
	 * @param ref - 凭据引用名。
	 * @returns `{ configured, source }` 或 undefined。
	 */
	const describeRef = async (ref) => {
		if (!available || typeof service.describe !== 'function') return undefined
		try {
			const info = await service.describe(ref)
			if (info === null || typeof info !== 'object') return undefined
			return {
				configured: info.configured === true,
				source: typeof info.source === 'string' ? info.source : '',
				writable: info.writable !== false,
				// 宿主的 describe 已经提供浏览器安全掩码；没有时才在前端显示空。
				masked: typeof info.masked === 'string' ? info.masked : '',
			}
		} catch {
			return undefined
		}
	}

	/**
	 * 解析一个引用的明文。只在 host 内部使用，结果不得进入响应。
	 * @param ref - 凭据引用名。
	 * @returns 明文或 undefined。
	 */
	const resolveRef = async (ref) => {
		if (!available || typeof service.resolve !== 'function') return undefined
		try {
			const hit = await service.resolve(ref)
			const value = hit !== undefined && typeof hit.value === 'string' ? hit.value.trim() : ''
			return value === '' ? undefined : value
		} catch {
			return undefined
		}
	}

	/**
	 * 按顺序解析一组候选引用。
	 * @param refs - 引用名数组。
	 * @returns `{ ref, value }` 或 undefined。
	 */
	const resolveFirst = async (refs) => {
		for (const ref of refs) {
			const value = await resolveRef(ref)
			if (value !== undefined) return { ref, value }
		}
		return undefined
	}

	/**
	 * 一个字段要尝试的引用：插件自己的引用优先，其次宿主官方配置的引用。
	 * @param field - 注册表凭据字段。
	 * @param extraRefs - `{ field: string[] }`，例如 DSH `llm-pi-ai` 里的 `apiKeyEnv`。
	 * @returns 去重后的引用列表。
	 */
	const refsFor = (field, extraRefs) => {
		const extra = extraRefs?.[field.field]
		if (!Array.isArray(extra) || extra.length === 0) return field.refs
		return [...new Set([...field.refs, ...extra])]
	}

	/**
	 * 描述一个厂商的凭据状态（浏览器可见）。
	 * @param vendor - 注册表条目。
	 * @param extraRefs - `{ field: string[] }`，DSH 官方提供商已配置的密钥引用。
	 * @returns `{ type, configured, fields, consoleUrl }`。
	 */
	const describeVendor = async (vendor, extraRefs = {}) => {
		const fields = []
		let configured = false
		for (const field of vendor.credential?.fields ?? []) {
			let fieldConfigured = false
			let source = ''
			let masked = ''
			let usedRef = ''
			for (const ref of refsFor(field, extraRefs)) {
				const info = await describeRef(ref)
				if (info?.configured === true) {
					fieldConfigured = true
					source = info.source
					masked = info.masked
					usedRef = ref
					break
				}
			}
			configured = configured || fieldConfigured
			fields.push({
				field: field.field,
				label: field.label,
				secret: field.secret === true,
				multiline: field.multiline === true,
				configured: fieldConfigured,
				preview: fieldConfigured ? masked : '',
				source,
				// true = 复用 DSH 官方提供商配置的 Key，而不是本插件自己保存的。
				external: fieldConfigured && !field.refs.includes(usedRef),
				writable: available,
			})
		}
		return {
			type: vendor.credential?.type ?? 'none',
			configured,
			fields,
			consoleUrl: vendor.credential?.consoleUrl ?? '',
			available,
		}
	}

	/**
	 * 保存一份凭据。写入该字段的第一个引用。
	 * @param vendor - 注册表条目。
	 * @param fieldName - 字段名（`cookie` / `key` / `token` / `accessKeyId` / `secretAccessKey`）。
	 * @param value - 明文。
	 * @returns `{ ok: true }` 或 `{ ok: false, message }`。
	 */
	const saveVendor = async (vendor, fieldName, value) => {
		const field = vendor.credential?.fields?.find((entry) => entry.field === fieldName)
		if (field === undefined) return { ok: false, message: `未知凭据字段：${fieldName}` }
		if (!available || typeof service.set !== 'function') {
			return { ok: false, message: '当前 DSH 没有可写的凭据服务。' }
		}
		const trimmed = typeof value === 'string' ? value.trim() : ''
		if (trimmed === '') return { ok: false, message: '凭据不能为空。' }
		if (trimmed.length > 65_536) return { ok: false, message: '凭据过长。' }
		try {
			await service.set(field.refs[0], trimmed)
			return { ok: true, ref: field.refs[0] }
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) }
		}
	}

	/**
	 * 清除一份凭据（该字段所有候选引用）。
	 * @param vendor - 注册表条目。
	 * @param fieldName - 字段名。
	 * @returns `{ ok: true }` 或 `{ ok: false, message }`。
	 */
	const clearVendor = async (vendor, fieldName) => {
		const field = vendor.credential?.fields?.find((entry) => entry.field === fieldName)
		if (field === undefined) return { ok: false, message: `未知凭据字段：${fieldName}` }
		if (!available || typeof service.unset !== 'function') {
			return { ok: false, message: '当前 DSH 没有可写的凭据服务。' }
		}
		try {
			for (const ref of field.refs) await service.unset(ref)
			return { ok: true }
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) }
		}
	}

	/**
	 * 解析一家厂商的读取凭据包：`{ field: value }`。
	 * @param vendor - 注册表条目。
	 * @param extraRefs - `{ field: string[] }`，DSH 官方提供商已配置的密钥引用。
	 * @returns 已配置字段的对象；缺失的字段不出现。
	 */
	const bundleFor = async (vendor, extraRefs = {}) => {
		const bundle = {}
		for (const field of vendor.credential?.fields ?? []) {
			const hit = await resolveFirst(refsFor(field, extraRefs))
			if (hit !== undefined) bundle[field.field] = hit.value
		}
		return bundle
	}

	return {
		available,
		describeRef,
		resolveFirst,
		describeVendor,
		saveVendor,
		clearVendor,
		bundleFor,
	}
}