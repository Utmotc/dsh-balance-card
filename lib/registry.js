/**
 * dsh-balance-card 2.0 — 厂商注册表。
 *
 * 一张表回答四个问题：这家是谁、怎么认证、读哪个接口、画什么单位。浏览器只
 * 拿到这里导出的公开字段（label / short / group / display / status），凭据引用名
 * 也会出现在 roster 里，但凭据值永远不进响应。
 *
 * 约定：
 * - `id` 是稳定的机器 id，不做重命名；显示名可以改。
 * - `aliases` 只用于「当前会话 provider route → 厂商」的映射，不做模糊匹配。
 * - `status: 'unsupported'` 的厂商仍然出现在列表里，但开关禁用、不展开。
 * - `batch` 记录设计文档的实现批次（1 = P1，2 = P2）。
 * @module dsh-balance-card/registry
 */

/** 分组顺序与标题。 */
export const GROUPS = [
	{ id: 'console', label: '控制台与订阅', hint: 'Cookie、OAuth 与本机登录态' },
	{ id: 'api', label: '官方 API', hint: 'API Key 直连账单接口' },
	{ id: 'custom', label: '自定义', hint: '任意 HTTPS 余额接口' },
	{ id: 'more', label: '更多厂商', hint: '折叠显示', collapsed: true },
]

/**
 * 一个厂商的完整定义。
 *
 * `adapter` 指向 `lib/vendors/index.js` 的读取函数；没有适配器的厂商只展示说明。
 * `credential.fields[].refs` 是候选凭据引用名，按顺序取第一个已配置的值。
 */
export const VENDORS = [
	{
		id: 'baidu-qianfan',
		group: 'console',
		label: '百度千帆',
		short: '千',
		aliases: ['baiduqianfan', 'baidu', 'qianfan', 'baidu-coding', 'baidu-coding-plan', 'qianfan-coding-plan', 'baidu-token-plan', 'qianfan-token-plan'],
		credential: {
			type: 'cookie',
			fields: [{ field: 'cookie', label: '控制台 Cookie', refs: ['BAIDU_QIANFAN_COOKIE'], secret: true, multiline: true }],
			consoleUrl: 'https://console.bce.baidu.com/qianfan/resource/token-plan',
			hint: '只发给 console.bce.baidu.com；API Key 不能代替 Cookie。',
		},
		display: { kind: 'quota', unit: '积分', windows: ['monthly', 'expiry'], primary: 'auto' },
		adapter: 'baidu-qianfan',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'scnet',
		group: 'console',
		label: 'SCNet 超算互联网',
		short: '超',
		aliases: ['scnet-console', 'scnet-token-plan', 'scnet-tokenplan', 'chaosuan', 'sugon'],
		credential: {
			type: 'cookie',
			fields: [{ field: 'cookie', label: '控制台 Cookie', refs: ['SCNET_COOKIE'], secret: true, multiline: true }],
			consoleUrl: 'https://www.scnet.cn/ui/mall/',
			hint: '只发给 www.scnet.cn；同时读取 Token Plan 与现金余额。',
		},
		display: { kind: 'credits', unit: '积分', windows: ['tokenplan', 'cash'], primary: 'tokenplan' },
		adapter: 'scnet',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'mimo',
		group: 'console',
		label: '小米 MiMo',
		short: '米',
		aliases: ['mimo', 'xiaomi', 'xiaomimimo', 'mimo-token-plan'],
		credential: {
			type: 'cookie',
			fields: [{ field: 'cookie', label: '控制台 Cookie', refs: ['MIMO_COOKIE'], secret: true, multiline: true }],
			consoleUrl: 'https://platform.xiaomimimo.com/console/balance',
			hint: '需要包含 userId 与 serviceToken 的完整控制台 Cookie。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['plan', 'compensation', 'balance'], primary: 'plan' },
		adapter: 'mimo',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'zhipu',
		group: 'console',
		label: '智谱 GLM / Z.ai',
		short: '智',
		aliases: ['zai', 'zhipu', 'bigmodel', 'glm', 'z-ai', 'zai-coding', 'glm-coding'],
		credential: {
			type: 'api-key',
			fields: [
				{
					field: 'key',
					label: 'Coding Plan Key',
					refs: ['ZAI_API_KEY', 'BIGMODEL_API_KEY'],
					secret: true,
					multiline: false,
				},
			],
			hint: '国内 Key 配 bigmodel.cn，国际 Key 配 z.ai；两个域名会自动尝试。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['five-hour', 'weekly'], primary: 'five-hour' },
		adapter: 'zhipu',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'volcengine',
		group: 'console',
		label: '火山方舟',
		short: '火',
		aliases: ['volcengine', 'ark', 'volc', 'volcengine-ark', 'doubao'],
		credential: {
			type: 'aksk',
			fields: [
				{ field: 'accessKeyId', label: 'AccessKey ID', refs: ['VOLC_ACCESSKEY'], secret: false, multiline: false },
				{ field: 'secretAccessKey', label: 'Secret Access Key', refs: ['VOLC_SECRETKEY'], secret: true, multiline: false },
			],
			hint: '使用火山 OpenAPI 的 HMAC-SHA256 签名，仅发送只读 Action。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['five-hour', 'weekly', 'monthly'], primary: 'five-hour' },
		adapter: 'volcengine',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'qwen',
		group: 'console',
		label: '千问 Qwen',
		short: '问',
		aliases: ['qwen', 'bailian', 'dashscope', 'qwen-token-plan', 'qwen-coding-plan'],
		credential: {
			type: 'cookie',
			fields: [{ field: 'cookie', label: '控制台 Cookie', refs: ['QWEN_COOKIE'], secret: true, multiline: true }],
			consoleUrl: 'https://bailian.console.aliyun.com/',
			hint: '阿里云百炼未提供稳定的额度接口；可在高级设置填端点覆盖，或等待本地计量。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['monthly'], primary: 'monthly' },
		adapter: 'qwen',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'claude',
		group: 'console',
		label: 'Claude Pro / Max',
		short: 'C',
		aliases: ['anthropic', 'claude', 'claude-code'],
		credential: {
			type: 'oauth',
			fields: [{ field: 'token', label: 'OAuth Token', refs: ['ANTHROPIC_OAUTH_TOKEN'], secret: true, multiline: false }],
			hint: '粘贴 Claude Code 的 OAuth token；接口非公开，可能随版本失效。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['five-hour', 'seven-day'], primary: 'five-hour' },
		adapter: 'claude',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'chatgpt',
		group: 'console',
		label: 'ChatGPT / Codex',
		short: 'G',
		aliases: ['openai', 'codex', 'chatgpt', 'openai-codex'],
		credential: {
			type: 'oauth',
			fields: [{ field: 'token', label: 'Codex Token', refs: ['OPENAI_CODEX_API_KEY'], secret: true, multiline: false }],
			hint: '手动粘贴 Codex token；接口非公开，不依赖其他插件。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['five-hour', 'weekly'], primary: 'five-hour' },
		adapter: 'chatgpt',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'antigravity',
		group: 'console',
		label: 'Google Antigravity',
		short: 'A',
		aliases: ['antigravity', 'google-antigravity'],
		credential: {
			type: 'oauth',
			fields: [{ field: 'token', label: '本机访问 Token', refs: ['ANTIGRAVITY_TOKEN'], secret: true, multiline: false }],
			hint: '本机登录态需手动粘贴 access token；不复制任何登录文件。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['models'], primary: 'auto' },
		adapter: 'antigravity',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'grok',
		group: 'console',
		label: 'Grok (X Premium)',
		short: 'X',
		aliases: ['grok-subscription', 'x-premium'],
		credential: null,
		display: { kind: 'quota', unit: '次', windows: [], primary: 'auto' },
		adapter: null,
		batch: 0,
		status: 'unsupported',
		note: '需要登录态插件，与自包含目标冲突。xAI API 额度请用下面的 xAI。',
	},
	{
		id: 'copilot',
		group: 'console',
		label: 'GitHub Copilot',
		short: 'CP',
		aliases: ['github-copilot', 'copilot-subscription'],
		credential: null,
		display: { kind: 'quota', unit: '次', windows: [], primary: 'auto' },
		adapter: null,
		batch: 0,
		status: 'unsupported',
		note: '需要登录态插件，本插件不引入新的插件依赖。',
	},
	{
		id: 'opendesign',
		group: 'more',
		label: 'OpenDesign',
		short: 'O',
		aliases: ['open-design', 'open-design-api'],
		credential: {
			type: 'custom',
			fields: [{ field: 'token', label: 'Control Key / Cookie', refs: ['OPENDESIGN_CREDENTIAL'], secret: true, multiline: true }],
			hint: '需要在高级设置里填写 Workspace ID。',
		},
		display: { kind: 'quota', unit: 'Credits', windows: ['five-hour', 'weekly', 'balance'], primary: 'five-hour' },
		adapter: 'opendesign',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'factory',
		group: 'more',
		label: 'Factory (Droid)',
		short: 'F',
		aliases: ['factory', 'droid', 'factory-ai'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['FACTORY_API_KEY'], secret: true, multiline: false }],
			hint: '可选填写 Organization ID。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['five-hour', 'weekly', 'monthly'], primary: 'five-hour' },
		adapter: 'factory',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'commandcode',
		group: 'more',
		label: 'CommandCode',
		short: 'CC',
		aliases: ['commandcode', 'command-code'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['COMMANDCODE_API_KEY'], secret: true, multiline: false }],
			hint: '读取 5 小时 / 周 / 月窗口。',
		},
		display: { kind: 'quota', unit: 'Credits', windows: ['fiveHour', 'weekly', 'monthly'], primary: 'fiveHour' },
		adapter: 'commandcode',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'clinepass',
		group: 'more',
		label: 'Cline Pass',
		short: 'CL',
		aliases: ['clinepass', 'cline-pass', 'cline'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['CLINE_PASS_API_KEY'], secret: true, multiline: false }],
			hint: '读取 5 小时 / 周 / 月窗口。',
		},
		display: { kind: 'quota', unit: 'Tokens', windows: ['fiveHour', 'weekly', 'monthly'], primary: 'fiveHour' },
		adapter: 'clinepass',
		batch: 2,
		status: 'experimental',
	},
	{
		id: 'deepseek',
		group: 'api',
		label: 'DeepSeek',
		short: 'D',
		aliases: ['deepseek', 'deepseek-official', 'deepseek-account'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['DEEPSEEK_API_KEY'], secret: true, multiline: false }],
			hint: '读取 `/user/balance`。',
		},
		display: { kind: 'currency', unit: '¥', windows: ['balance'], primary: 'balance' },
		adapter: 'deepseek',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'stepfun',
		group: 'api',
		label: 'StepFun',
		short: 'S',
		aliases: ['stepfun', 'stepfun-api'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['STEPFUN_API_KEY'], secret: true, multiline: false }],
			hint: '读取 `/v1/accounts`。',
		},
		display: { kind: 'currency', unit: '¥', windows: ['balance'], primary: 'balance' },
		adapter: 'stepfun',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'kimi',
		group: 'api',
		label: 'Kimi / Moonshot',
		short: 'K',
		aliases: ['kimi', 'moonshot', 'kimi-coding', 'kimi-code'],
		credential: {
			type: 'api-key',
			fields: [
				{
					field: 'key',
					label: 'API Key',
					refs: ['KIMI_API_KEY', 'KIMI_CODING_API_KEY'],
					secret: true,
					multiline: false,
				},
			],
			hint: '订阅 Key 读 5 小时 / 周窗口；普通 Key 读账户余额。',
		},
		display: { kind: 'quota', unit: '次', windows: ['weekly', 'hourly'], primary: 'weekly' },
		adapter: 'kimi',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'openrouter',
		group: 'api',
		label: 'OpenRouter',
		short: 'R',
		aliases: ['openrouter'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['OPENROUTER_API_KEY'], secret: true, multiline: false }],
			hint: '读取 `/api/v1/auth/key` 的额度与用量。',
		},
		display: { kind: 'currency', unit: '$', windows: ['credits'], primary: 'credits' },
		adapter: 'openrouter',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'minimax',
		group: 'api',
		label: 'MiniMax',
		short: 'M',
		aliases: ['minimax', 'minimaxi'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['MINIMAX_API_KEY'], secret: true, multiline: false }],
			hint: '读取 Token Plan 的 5 小时 / 周窗口。',
		},
		display: { kind: 'quota', unit: '次', windows: ['five-hour', 'weekly'], primary: 'five-hour' },
		adapter: 'minimax',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'xai',
		group: 'api',
		label: 'xAI / Grok API',
		short: 'x',
		aliases: ['xai', 'grok', 'grok-api', 'x-ai'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['XAI_API_KEY'], secret: true, multiline: false }],
			hint: '读取 `credit_grants`；与 X Premium 订阅无关。',
		},
		display: { kind: 'currency', unit: '$', windows: ['balance'], primary: 'balance' },
		adapter: 'xai',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'siliconflow',
		group: 'api',
		label: 'SiliconFlow 硅基流动',
		short: '硅',
		aliases: ['siliconflow', 'silicon-flow', 'siliconcloud'],
		credential: {
			type: 'api-key',
			fields: [{ field: 'key', label: 'API Key', refs: ['SILICONFLOW_API_KEY'], secret: true, multiline: false }],
			hint: '读取 `/v1/user/info` 的账户余额。',
		},
		display: { kind: 'currency', unit: '¥', windows: ['balance'], primary: 'balance' },
		adapter: 'siliconflow',
		batch: 1,
		status: 'stable',
	},
	{
		id: 'custom',
		group: 'custom',
		label: '自定义余额接口',
		short: '＋',
		aliases: [],
		credential: {
			type: 'custom',
			fields: [
				{ field: 'key', label: '凭据（可选）', refs: ['CUSTOM_BALANCE_KEY'], secret: true, multiline: false },
			],
			hint: 'HTTPS GET/POST + JSON 路径；只允许公网 HTTPS，私有网段需显式开启。',
		},
		display: { kind: 'currency', unit: '¥', windows: ['balance'], primary: 'balance' },
		adapter: 'custom',
		batch: 1,
		status: 'stable',
	},
]

/** 以 id 建索引。 */
const BY_ID = new Map(VENDORS.map((vendor) => [vendor.id, vendor]))

/** 以别名（小写）建索引。 */
const BY_ALIAS = new Map()
for (const vendor of VENDORS) {
	for (const alias of vendor.aliases) BY_ALIAS.set(alias.toLowerCase(), vendor.id)
	BY_ALIAS.set(vendor.id.toLowerCase(), vendor.id)
}

/** @param id - 厂商 id。 @returns 定义或 undefined。 */
export function vendorById(id) {
	return BY_ID.get(id)
}

/** @returns 全部厂商定义（按注册表顺序）。 */
export function allVendors() {
	return VENDORS
}

/** @returns 可监控（有适配器且未被标记不支持）的厂商。 */
export function monitorableVendors() {
	return VENDORS.filter((vendor) => vendor.status !== 'unsupported' && vendor.adapter !== null)
}

/**
 * route 前缀 → 厂商。DSH 的 provider id 可以由用户自由命名，例如
 * `baiduqianfanlyq`、`baiduqianfan-utmotc` 都是「百度千帆」的不同账号路由；
 * 它们没有出现在别名表里，但前缀明确。这里只对常见厂商做受控前缀匹配，
 * 且要求后缀只含 `a-z0-9_-`，避免把 `openrouter-pro` 之类的另一个产品误认。
 */
export const ROUTE_PREFIXES = [
	['baiduqianfan', 'baidu-qianfan'],
	['baidu-coding', 'baidu-qianfan'],
	['baidu-token-plan', 'baidu-qianfan'],
	['qianfan', 'baidu-qianfan'],
	['deepseek', 'deepseek'],
	['stepfun', 'stepfun'],
	['kimi-coding', 'kimi'],
	['kimi', 'kimi'],
	['moonshot', 'kimi'],
	['openrouter', 'openrouter'],
	['minimax', 'minimax'],
	['siliconflow', 'siliconflow'],
	['volcengine', 'volcengine'],
	['antigravity', 'antigravity'],
	['anthropic', 'claude'],
	['claude', 'claude'],
	['chatgpt', 'chatgpt'],
	['codex', 'chatgpt'],
	['zhipu', 'zhipu'],
	['bigmodel', 'zhipu'],
	['bailian', 'qwen'],
	['dashscope', 'qwen'],
	['qwen', 'qwen'],
	['scnet', 'scnet'],
	['xiaomi', 'mimo'],
	['mimo', 'mimo'],
	['xai', 'xai'],
	['glm', 'zhipu'],
	['ark', 'volcengine'],
].sort((left, right) => right[0].length - left[0].length)

/**
 * 把当前会话的 provider route 映射成厂商 id。
 *
 * 先做别名精确匹配（小写）；再做受控前缀匹配。`baiduqianfanlyq` 这类用户自定义
 * 路由名在前缀匹配里仍归到百度千帆，但 `openrouter-pro` 只有在 `openrouter`
 * 前缀且后缀合法时才会命中——不做模糊包含，避免显示错账户。
 * @param route - DSH provider route id。
 * @returns 厂商 id 或 undefined。
 */
export function vendorForRoute(route) {
	if (typeof route !== 'string' || route === '') return undefined
	const key = route.toLowerCase()
	if (BY_ALIAS.has(key)) return BY_ALIAS.get(key)
	const prefix = 'vision-toolkit-'
	if (key.startsWith(prefix)) return BY_ALIAS.get(key.slice(prefix.length))
	for (const [lead, id] of ROUTE_PREFIXES) {
		if (!key.startsWith(lead) || key.length === lead.length) continue
		const suffix = key.slice(lead.length)
		// 允许 -utmotc / lyq / 01 这类账号后缀，但拒绝路径、空格与点号。
		if (/^[a-z0-9_-]+$/u.test(suffix)) return id
	}
	return undefined
}

/**
 * 一家厂商在浏览器里可见的公开投影。
 * @param vendor - 注册表条目。
 * @param settings - 该厂商的设置。
 * @param credentialState - `{ configured, fields }`。
 * @returns roster 行。
 */
export function vendorView(vendor, settings, credentialState) {
	return {
		id: vendor.id,
		group: vendor.group,
		label: vendor.label,
		short: vendor.short,
		status: vendor.status,
		batch: vendor.batch,
		note: vendor.note ?? '',
		credential: {
			type: vendor.credential?.type ?? 'none',
			fields: (vendor.credential?.fields ?? []).map((field) => ({
				field: field.field,
				label: field.label,
				secret: field.secret === true,
				multiline: field.multiline === true,
			})),
			consoleUrl: vendor.credential?.consoleUrl ?? '',
			hint: vendor.credential?.hint ?? '',
		},
		display: vendor.display,
		configured: credentialState?.configured === true,
		enabled: settings?.enabled === true,
		settings,
	}
}