// dsh-balance-card 2.0 — 浏览器半边的冒烟测试。
//
// 这不是 DOM 测试：它用最小的 React hook 替身 + DOM 桩跑真实 bundle，断言
//   - 启动安全（只有 slots 也能激活，并注册卡片/会话/设置三席）；
//   - 四种风格的卡片用同一份读数；
//   - 未映射/未开启/失败三态；
//   - 设置页三段标签与厂商行开关的乐观 POST；
//   - 点击卡片展开面板。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert')

const BUNDLE = path.join(__dirname, '..', 'lib', 'client.js')

/** Minimal hook-preserving React stand-in（沿用 1.x 的测试骨架）。 */
const createReact = () => {
  const tables = new Map()
  const pending = []
  let cursor = 0
  let dirty = false
  let current

  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  })
  const Fragment = Symbol.for('react.fragment')
  const useState = (initial) => {
    const table = current
    const at = cursor++
    if (!(at in table)) table[at] = typeof initial === 'function' ? initial() : initial
    return [
      table[at],
      (next) => {
        const value = typeof next === 'function' ? next(table[at]) : next
        if (Object.is(value, table[at])) return
        table[at] = value
        dirty = true
      },
    ]
  }
  const useEffect = (effect, deps) => {
    const table = current
    const at = cursor++
    const previous = table[at]
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, index) => !Object.is(value, previous.deps[index]))
    if (changed) pending.push({ table, at, effect, deps: deps ?? [] })
  }
  const useRef = (initial) => {
    const table = current
    const at = cursor++
    if (!(at in table)) table[at] = { current: initial }
    return table[at]
  }
  const useSyncExternalStore = (subscribe, getSnapshot) => {
    const table = current
    const at = cursor++
    if (!(at in table)) table[at] = { unsubscribe: undefined }
    useEffect(() => {
      const unsubscribe = subscribe(() => {
        dirty = true
      })
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    }, [subscribe])
    return getSnapshot()
  }

  const React = { createElement, Fragment, useState, useEffect, useRef, useSyncExternalStore, memo: (c) => c }
  return {
    React,
    run(component, props) {
      if (!tables.has(component)) tables.set(component, [])
      current = tables.get(component)
      cursor = 0
      pending.length = 0
      const tree = component(props)
      const ran = [...pending]
      pending.length = 0
      for (const entry of ran) {
        entry.effect()
        entry.table[entry.at] = { deps: entry.deps }
      }
      return tree
    },
    takeDirty: () => {
      const value = dirty
      dirty = false
      return value
    },
  }
}

const expand = (mini, node, depth = 60) => {
  if (depth <= 0 || node === null || node === undefined) return node
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map((child) => expand(mini, child, depth - 1))
  if (node.__portal === true) return { ...node, tree: expand(mini, node.tree, depth - 1) }
  if (typeof node.type === 'function') return expand(mini, mini.run(node.type, node.props), depth - 1)
  if (node.props === undefined) return node
  const expanded = { ...node, props: { ...node.props, children: expand(mini, node.props.children, depth - 1) } }
  // React would assign refs on commit; this stand-in assigns a DOM-like node so
  // useCompact/panel anchoring can measure a width.
  if (expanded.props.ref !== null && typeof expanded.props.ref === 'object') {
    expanded.props.ref.current = {
      getBoundingClientRect: () => ({ top: 600, left: 20, right: 284, bottom: 700, width: 264, height: 100 }),
      contains: () => false,
      focus: () => {},
    }
  }
  return expanded
}

const texts = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (node.__portal === true) return texts(node.tree, out)
  return node.props ? texts(node.props.children, out) : out
}

const find = (node, predicate) => {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.__portal === true) return find(node.tree, predicate)
  if (node.props && predicate(node)) return node
  return node.props ? find(node.props.children, predicate) : null
}

const findAll = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (node.__portal === true) {
    findAll(node.tree, predicate, out)
    return out
  }
  if (node.props && predicate(node)) out.push(node)
  if (node.props) findAll(node.props.children, predicate, out)
  return out
}

const domNode = (tag) => {
  const self = {
    tagName: tag,
    children: [],
    dataset: {},
    parentNode: null,
    textContent: '',
    isConnected: true,
    style: {},
    getBoundingClientRect: () => ({ top: 600, left: 20, right: 284, bottom: 700, width: 264, height: 100 }),
    focus: () => {},
    contains: () => false,
    appendChild(child) {
      self.children.push(child)
      child.parentNode = self
      return child
    },
    remove() {
      self.parentNode = null
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  return self
}

const store = (initial) => {
  const listeners = new Set()
  let value = initial
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

const vendorSettings = (enabled = true) => ({
  enabled,
  pollMs: null,
  warnPercent: null,
  window: 'auto',
  budget: null,
  unitOverride: null,
  account: 'default',
  advanced: {},
})

const toolSettings = () => ({
  qianfanThrottle: {
    enabled: false,
    mode: 'dynamic',
    preset: 'mid',
    safety: 0.7,
    maxConcurrent: 2,
    cooldownCapMs: 600000,
    queueTimeoutMs: 180000,
    probe: true,
    probePace: 'normal',
    manual: {
      low: { rpm: 2, tpm: 8000, concurrency: 1 },
      mid: { rpm: 6, tpm: 30000, concurrency: 2 },
      high: { rpm: 15, tpm: 80000, concurrency: 3 },
    },
  },
  lowBalanceAlert: { enabled: true, warnPercent: 20, criticalPercent: 10, notify: false, quietHours: null },
  dailyReport: { enabled: false, time: '09:00', format: 'digest' },
})

const baseSettings = (overrides = {}) => ({
  version: 2,
  theme: 'light',
  visualStyle: 'grid',
  accent: 'jade',
  density: 'comfortable',
  card: {
    showPercent: true,
    showBar: true,
    showUpdatedAt: true,
    showSubtitle: true,
    showStatusText: false,
    groupDigits: true,
    currencyStyle: 'symbol',
    pollMs: 600000,
    warnPercent: 20,
    clickAction: 'panel',
    visible: true,
  },
  vendors: { 'baidu-qianfan': vendorSettings(true) },
  tools: toolSettings(),
  ...overrides,
})

const qianfanVendor = (overrides = {}) => ({
  id: 'baidu-qianfan',
  group: 'console',
  label: '百度千帆',
  short: '千',
  status: 'stable',
  batch: 1,
  note: '',
  credential: {
    type: 'cookie',
    fields: [{ field: 'cookie', label: '控制台 Cookie', secret: true, multiline: true }],
    consoleUrl: 'https://console.bce.baidu.com/qianfan/resource/token-plan',
    hint: '只发给 console.bce.baidu.com。',
  },
  display: { kind: 'quota', unit: '积分', windows: ['monthly'], primary: 'auto' },
  configured: true,
  enabled: true,
  settings: vendorSettings(true),
  credentialFields: [{ field: 'cookie', label: '控制台 Cookie', secret: true, multiline: true, configured: true, preview: 'abc•', source: 'file', writable: true }],
  ...overrides,
})

const reading = {
  kind: 'credits',
  unit: '积分',
  remaining: 9642,
  total: 10000,
  used: 358,
  percent: 96.42,
  windows: [
    {
      id: 'monthly',
      label: '月度 · Token Plan',
      remaining: 9642,
      total: 10000,
      used: 358,
      percent: 96.42,
      resetsAt: '',
      expiresAt: '2026-12-31T00:00:00.000Z',
      unlimited: false,
      unit: '',
      note: '',
    },
  ],
  primary: 'monthly',
  note: '',
}

const snapshot = (options = {}) => {
  const settings = baseSettings(options.settings)
  return {
    version: '2.0.0',
    settings,
    vendors: options.vendors ?? [qianfanVendor({ enabled: settings.vendors['baidu-qianfan']?.enabled === true })],
    unsupported: [
      {
        id: 'grok',
        group: 'console',
        label: 'Grok (X Premium)',
        short: 'X',
        status: 'unsupported',
        batch: 0,
        note: '需要登录态插件。',
        credential: { type: 'none', fields: [], consoleUrl: '', hint: '' },
        display: { kind: 'quota', unit: '次', windows: [] },
        configured: false,
        enabled: false,
        settings: vendorSettings(false),
      },
    ],
    readings: options.readings ?? {
      'baidu-qianfan': { status: 'ok', reading, error: null, fetchedAt: Date.now() - 120000, nextAt: 0 },
    },
    tools: {
      qianfanThrottle: {
        settings: settings.tools.qianfanThrottle,
        status: {
          enabled: false,
          mode: 'dynamic',
          probeEnabled: true,
          probePace: 'normal',
          preset: 'mid',
          safety: 0.7,
          maxConcurrent: 2,
          cooldownCapMs: 600000,
          queueTimeoutMs: 180000,
          queued: 0,
          badge: 'off',
          active: null,
          routes: [],
        },
      },
      lowBalanceAlert: settings.tools.lowBalanceAlert,
      dailyReport: { settings: settings.tools.dailyReport, days: [] },
      slots: [],
      notifySupported: false,
    },
    meta: {
      migrated: false,
      migrationNotes: [],
      migrationError: '',
      credentialsAvailable: true,
      routeMap: {
        baiduqianfan: 'baidu-qianfan',
        baidu: 'baidu-qianfan',
        qianfan: 'baidu-qianfan',
        deepseek: 'deepseek',
      },
      routePrefixes: [
        ['baiduqianfan', 'baidu-qianfan'],
        ['qianfan', 'baidu-qianfan'],
        ['deepseek', 'deepseek'],
      ],
      generatedAt: Date.now(),
    },
  }
}

const load = (options = {}) => {
  const state = {
    snapshot: options.snapshot ?? snapshot(),
    settingsPosts: [],
    requests: [],
    snapshotCalls: 0,
    throttle: options.throttle ?? null,
  }
  const mini = createReact()
  let registration
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (entry) => { registration = entry } },
      innerWidth: 1200,
      innerHeight: 900,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    },
    document: {
      visibilityState: 'visible',
      head: domNode('head'),
      body: domNode('body'),
      createElement: domNode,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback }
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback }
      observe() { this.callback([{ contentRect: { width: 264 } }]) }
      disconnect() {}
    },
    fetch: async (url, init) => {
      state.requests.push({ url: String(url), init })
      const target = String(url)
      if (target.includes('/v2/snapshot')) {
        state.snapshotCalls += 1
        return json({ ok: true, value: state.snapshot })
      }
      if (target.includes('/v2/settings')) {
        const body = init?.body === undefined ? {} : JSON.parse(init.body)
        state.settingsPosts.push(body)
        const next = { ...state.snapshot.settings }
        if (body.card !== undefined) next.card = { ...next.card, ...body.card }
        if (body.visualStyle !== undefined) next.visualStyle = body.visualStyle
        if (body.theme !== undefined) next.theme = body.theme
        if (body.accent !== undefined) next.accent = body.accent
        if (body.vendors !== undefined) {
          next.vendors = { ...next.vendors }
          for (const [id, part] of Object.entries(body.vendors)) next.vendors[id] = { ...(next.vendors[id] ?? {}), ...part }
        }
        if (body.tools !== undefined) next.tools = { ...next.tools, ...body.tools }
        // 真实宿主会把设置落盘，下一次 snapshot 返回新值；桩也要同步，否则
        // patch 后的主动刷新会用旧设置把乐观结果覆盖回去。
        state.snapshot = { ...state.snapshot, settings: next }
        return json({ ok: true, value: { settings: next } })
      }
      if (target.includes('/v2/throttle/status')) return json({ ok: true, value: state.throttle ?? state.snapshot.tools.qianfanThrottle.status })
      if (target.includes('/v2/refresh')) return json({ ok: true, value: { throttled: false, readings: {} } })
      if (target.includes('/v2/credentials/test')) return json({ ok: true, value: { reachable: true, reading } })
      if (target.includes('/v2/credentials')) return json({ ok: true, value: { saved: true } })
      return json({ ok: false, error: { code: 'not-found', message: 'no route' } }, 404)
    },
    createPortal: (tree) => ({ __portal: true, tree }),
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    console,
    URL,
    Blob: class {},
    navigator: { clipboard: { writeText: async () => {} } },
    AbortController,
    Date,
    Error,
    JSON,
    Promise,
    String,
    Number,
    Object,
    Array,
    Math,
    Symbol,
    RegExp,
    Map,
    Set,
    WeakMap,
    Intl,
    isFinite,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, { filename: BUNDLE })
  assert.ok(registration !== undefined, 'bundle must register through __ModuleLoader__')
  const require = (id) => {
    if (id === 'react') return mini.React
    if (id === 'react-dom') return { createPortal: sandbox.createPortal }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error('unexpected require: ' + id)
  }
  const exports = registration.factory(require)
  return { exports, mini, state, registration, sandbox }
}

const render = (mini, component, props) => expand(mini, mini.run(component, props))

const settle = async (mini, component, props, state, rounds = 8) => {
  let tree = render(mini, component, props)
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15))
    if (!mini.takeDirty() && state.snapshotCalls > 0) break
    tree = render(mini, component, props)
  }
  return tree
}

const modelsService = (provider) => ({
  models: {
    catalog: { store: store({ value: { default: { provider }, groups: [] } }) },
  },
})

const seatProps = (exports, provider = 'baiduqianfan', wide = true) => {
  const optional = store(modelsService(provider))
  const session = store('session-1')
  const wallet = exports.createWalletStore()
  return { optional, session, wallet, wide }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('bundle registers under the package id', () => {
  const { registration } = load()
  assert.equal(registration.id, '@utmotc/dsh-balance-card')
})

test('boot safety: apply activates with slots only', () => {
  const { exports } = load()
  const registered = []
  let injectCallback
  const ctx = {
    inject: (services, callback) => {
      if (services.includes('slots')) injectCallback = callback
    },
    effect: () => {},
  }
  assert.doesNotThrow(() => exports.apply(ctx))
  assert.equal(typeof injectCallback, 'function')
  const slots = {
    inject: (name, fn) => fn(),
    register: (options) => {
      registered.push(options)
      return options
    },
  }
  injectCallback({ slots })
  const ids = registered.map((entry) => entry.id)
  assert.ok(ids.includes('balance-session'))
  assert.ok(ids.includes('balance-sidebar-card'))
  assert.ok(ids.includes('balance-monitor'))
})

test('card renders grid style figures', async () => {
  const { exports, mini, state } = load()
  const props = seatProps(exports)
  const tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const all = texts(tree).join(' ')
  assert.ok(all.includes('百度千帆'), all)
  assert.ok(all.includes('9,642'), all)
  assert.ok(all.includes('96.42'), all)
  const card = find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-style-grid'))
  assert.ok(card !== null, 'grid card must render')
})

test('ring style renders a 58px ring and switches without refetch', async () => {
  const { exports, mini, state } = load()
  const props = seatProps(exports)
  await settle(mini, exports.SidebarBalanceSeat, props, state)
  await props.wallet.patch({ visualStyle: 'ring' })
  const tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const card = find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-style-ring'))
  assert.ok(card !== null, 'ring card must render')
  const ring = find(tree, (node) => node.type === 'svg' && node.props?.width === 58)
  assert.ok(ring !== null, 'ring svg must be 58px')
})

test('theme follows the software and cannot be forced dark', async () => {
  const { exports, mini, state, sandbox } = load()
  const props = seatProps(exports)
  sandbox.document.body.dataset.dsDarkTheme = 'true'
  const tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const card = find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-style-'))
  assert.equal(card.props['data-dark'], 'true')
})

test('unmapped provider shows 未监控, not a fabricated zero', async () => {
  const { exports, mini, state } = load()
  const props = seatProps(exports, 'unknown-provider')
  const tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const all = texts(tree).join(' ')
  assert.ok(all.includes('当前厂商未监控'), all)
  assert.ok(!all.includes('9,642'), all)
})

test('disabled vendor shows 未开启监控', async () => {
  const { exports, mini, state } = load()
  state.snapshot = snapshot({
    settings: { vendors: { 'baidu-qianfan': vendorSettings(false) } },
    vendors: [qianfanVendor({ enabled: false })],
  })
  const props = seatProps(exports)
  const tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const all = texts(tree).join(' ')
  assert.ok(all.includes('未开启监控'), all)
})

test('failed reading shows the reason and never 0', async () => {
  const { exports, mini, state } = load()
  state.snapshot = snapshot({
    readings: {
      'baidu-qianfan': {
        status: 'error',
        reading: null,
        error: { code: 'expired', message: '控制台登录已过期。', advice: '重新复制 Cookie。' },
        fetchedAt: Date.now(),
      },
    },
  })
  const props = seatProps(exports)
  const tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const all = texts(tree).join(' ')
  assert.ok(all.includes('登录已过期'), all)
  assert.ok(!all.includes('0.00'), all)
})

test('clicking the card opens the detail panel', async () => {
  const { exports, mini, state } = load()
  const props = seatProps(exports)
  let tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const card = find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-style-grid'))
  assert.ok(card !== null)
  card.props.onClick()
  tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const panel = find(tree, (node) => node.props?.role === 'dialog')
  assert.ok(panel !== null, 'panel must open')
  // 面板底边锚在卡片顶边上方，而不是按固定高度往上顶。
  assert.equal(panel.props.style.top, 'auto')
  assert.ok(typeof panel.props.style.bottom === 'number' && panel.props.style.bottom > 0)
  const all = texts(tree).join(' ')
  assert.ok(all.includes('月度 · Token Plan'), all)
  assert.ok(all.includes('刷新'), all)
})

test('settings section renders three tabs and vendor rows', async () => {
  const { exports, mini, state } = load()
  const wallet = exports.createWalletStore()
  const tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  let all = texts(tree).join(' ')
  assert.ok(all.includes('卡片样式'), all)
  assert.ok(all.includes('厂商监控'), all)
  assert.ok(all.includes('其他工具'), all)
  assert.ok(!all.includes('跟随软件'), all)
  assert.ok(!all.includes('浅色'), all)
  assert.ok(!all.includes('深色'), all)
  const vendorsTab = find(tree, (node) => node.props?.role === 'tab' && texts(node).join('') === '厂商监控')
  assert.ok(vendorsTab !== null, 'vendor tab must exist')
  vendorsTab.props.onClick()
  const tree2 = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  all = texts(tree2).join(' ')
  assert.ok(all.includes('百度千帆'), all)
  assert.ok(all.includes('Grok (X Premium)'), all)
  assert.ok(all.includes('暂不支持'), all)
})

test('vendor switch posts an optimistic settings patch', async () => {
  const { exports, mini, state } = load()
  const wallet = exports.createWalletStore()
  let tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const vendorsTab = find(tree, (node) => node.props?.role === 'tab' && texts(node).join('') === '厂商监控')
  vendorsTab.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const switchNode = find(tree, (node) => node.props?.role === 'switch' && node.props?.['aria-label'] === '监控 百度千帆')
  assert.ok(switchNode !== null, 'vendor switch must render')
  switchNode.props.onClick({ stopPropagation: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const patch = state.settingsPosts.find((body) => body.vendors?.['baidu-qianfan'] !== undefined)
  assert.ok(patch !== undefined, JSON.stringify(state.settingsPosts))
  assert.equal(patch.vendors['baidu-qianfan'].enabled, false)
})

test('figureOf formats money, units and plain style', () => {
  const { exports } = load()
  const money = exports.figureOf(
    { kind: 'currency', unit: '¥', remaining: 1234.5, total: null, used: null, percent: null, windows: [] },
    { card: { currencyStyle: 'symbol', groupDigits: true } },
  )
  assert.equal(money.prefix, '¥')
  assert.equal(money.main, '1,234.50')
  const plain = exports.figureOf(
    { kind: 'currency', unit: '¥', remaining: 12.3, total: null, used: null, percent: null, windows: [] },
    { card: { currencyStyle: 'plain', groupDigits: false } },
  )
  assert.equal(plain.prefix, '')
  assert.equal(plain.main, '12.30')
  const credits = exports.figureOf(
    { kind: 'credits', unit: '积分', remaining: 9642, total: 10000, used: 358, percent: 96.42, windows: [] },
    { card: { currencyStyle: 'symbol', groupDigits: true } },
  )
  assert.equal(credits.main, '9,642')
  assert.equal(credits.suffix, '积分')
})

test('cardModel maps states from the snapshot', () => {
  const { exports } = load()
  const data = snapshot()
  const ok = exports.cardModel(data, 'baiduqianfan', data.settings)
  assert.equal(ok.state, 'ok')
  assert.equal(ok.vendor.id, 'baidu-qianfan')
  const customRoute = exports.cardModel(data, 'baiduqianfanlyq', data.settings)
  assert.equal(customRoute.state, 'ok')
  assert.equal(customRoute.vendor.id, 'baidu-qianfan')
  const unmapped = exports.cardModel(data, 'no-such-route', data.settings)
  assert.equal(unmapped.state, 'unmapped')
  const disabled = exports.cardModel(
    { ...data, settings: baseSettings({ vendors: { 'baidu-qianfan': vendorSettings(false) } }) },
    'baiduqianfan',
    baseSettings({ vendors: { 'baidu-qianfan': vendorSettings(false) } }),
  )
  assert.equal(disabled.state, 'disabled')
})

test('style picker posts the new visual style', async () => {
  const { exports, mini, state } = load()
  const wallet = exports.createWalletStore()
  let tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const ringOption = find(
    tree,
    (node) =>
      typeof node.props?.className === 'string' &&
      node.props.className.includes('dbc-style-option') &&
      texts(node).join('').startsWith('圆环'),
  )
  assert.ok(ringOption !== null, 'style options must render')
  ringOption.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(
    state.settingsPosts.some((body) => body.visualStyle === 'ring'),
    JSON.stringify(state.settingsPosts),
  )
})

test('tools page exposes the four probe paces and posts a change', async () => {
  const { exports, mini, state } = load()
  const wallet = exports.createWalletStore()
  let tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const toolsTab = find(tree, (node) => node.props?.role === 'tab' && texts(node).join('') === '其他工具')
  assert.ok(toolsTab !== null)
  toolsTab.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  let all = texts(tree).join(' ')
  assert.ok(all.includes('百度千帆限流'), all)
  assert.ok(all.includes('低余额告警'), all)
  assert.ok(all.includes('用量日报'), all)
  assert.ok(all.includes('自定义工具槽位'), all)

  const throttleRow = find(
    tree,
    (node) => node.props?.role === 'button' && texts(node).join(' ').includes('百度千帆限流'),
  )
  assert.ok(throttleRow !== null)
  throttleRow.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  // 关闭状态下只展示模式；先切到「动态」再检查四档节奏。
  const dynamic = find(tree, (node) => node.type === 'button' && texts(node).join('') === '动态')
  assert.ok(dynamic !== null)
  dynamic.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  all = texts(tree).join(' ')
  for (const label of ['频繁', '正常', '保守', '几乎不']) assert.ok(all.includes(label), label)

  const conservative = find(tree, (node) => node.type === 'button' && texts(node).join('') === '保守')
  assert.ok(conservative !== null)
  conservative.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(
    state.settingsPosts.some((body) => body.tools?.qianfanThrottle?.probePace === 'conservative'),
    JSON.stringify(state.settingsPosts),
  )
})

test('credential editor tests a saved cookie through the host route', async () => {
  const { exports, mini, state } = load()
  const wallet = exports.createWalletStore()
  let tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const vendorsTab = find(tree, (node) => node.props?.role === 'tab' && texts(node).join('') === '厂商监控')
  vendorsTab.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const row = find(
    tree,
    (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-vendor-row'),
  )
  assert.ok(row !== null)
  row.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const testButton = find(tree, (node) => node.type === 'button' && texts(node).join('') === '测试连接')
  assert.ok(testButton !== null)
  testButton.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  assert.ok(texts(tree).join(' ').includes('连接正常'), texts(tree).join(' '))
})

test('grid card enters compact mode at 264px', () => {
  const { exports, mini } = load()
  const settings = baseSettings()
  const model = exports.cardModel(snapshot(), 'baiduqianfan', settings)
  const tree = render(mini, exports.BalanceCard, { model, settings, dark: false, compact: true, preview: true })
  const card = find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-style-grid'))
  assert.ok(card.props.className.includes('compact'), card.props.className)
  assert.ok(texts(tree).join(' ').includes('9,642'))
})

test('current provider comes from session request events', async () => {
  const { exports, mini, state } = load()
  const sessions = {
    binding: () => ({
      eventSource: store({
        entries: [
          { type: 'event', event: { type: 'request/context', data: { provider: 'baiduqianfan', model: 'ernie' } } },
        ],
      }),
    }),
  }
  const optional = store({ sessions })
  const session = store('session-1')
  const wallet = exports.createWalletStore()
  const tree = await settle(mini, exports.SidebarBalanceSeat, { optional, session, wallet, wide: true }, state)
  const all = texts(tree).join(' ')
  assert.ok(all.includes('百度千帆'), all)
  assert.ok(all.includes('9,642'), all)
  assert.ok(!all.includes('当前厂商未监控'), all)
})

test('current provider prefers the session modelSelection projection', async () => {
  const { exports, mini, state } = load()
  const selection = store({ next: { provider: 'baiduqianfan', model: 'ernie' } })
  const sessions = {
    binding: () => ({
      session: { projections: { faceOf: () => selection } },
      eventSource: store({ entries: [] }),
    }),
  }
  const optional = store({ sessions })
  const session = store('session-1')
  const wallet = exports.createWalletStore()
  const tree = await settle(mini, exports.SidebarBalanceSeat, { optional, session, wallet, wide: true }, state)
  const all = texts(tree).join(' ')
  assert.ok(all.includes('百度千帆'), all)
  assert.ok(all.includes('9,642'), all)
})

test('clicking an unmapped card opens the panel instead of settings', async () => {
  const { exports, mini, state } = load()
  const props = seatProps(exports, 'unknown-provider')
  let tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const card = find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-style-'))
  card.props.onClick()
  tree = await settle(mini, exports.SidebarBalanceSeat, props, state)
  const panel = find(tree, (node) => node.props?.role === 'dialog')
  assert.ok(panel !== null, 'panel must open for an unmapped provider')
  assert.ok(texts(tree).join(' ').includes('当前厂商未监控'))
})

test('vendor switch flips immediately from the optimistic settings patch', async () => {
  const { exports, mini, state } = load()
  const wallet = exports.createWalletStore()
  let tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const vendorsTab = find(tree, (node) => node.props?.role === 'tab' && texts(node).join('') === '厂商监控')
  vendorsTab.props.onClick()
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const switchNode = find(tree, (node) => node.props?.role === 'switch' && node.props?.['aria-label'] === '监控 百度千帆')
  assert.equal(switchNode.props['aria-checked'], true)
  switchNode.props.onClick({ stopPropagation: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 20))
  tree = await settle(mini, exports.WalletSettingsSection, { wallet }, state)
  const after = find(tree, (node) => node.props?.role === 'switch' && node.props?.['aria-label'] === '监控 百度千帆')
  assert.equal(after.props['aria-checked'], false)
})

test('money-only cards hide the progress and enlarge the amount', () => {
  const { exports, mini } = load()
  const settings = baseSettings()
  const reading = {
    kind: 'currency',
    unit: '¥',
    remaining: 88.5,
    total: null,
    used: null,
    percent: null,
    windows: [{ id: 'balance', label: '账户余额', remaining: 88.5, total: null, used: null, percent: null, resetsAt: '', expiresAt: '', unlimited: false, unit: '', note: '' }],
    primary: 'balance',
    note: '',
  }
  const model = { state: 'ok', vendor: qianfanVendor(), reading, percent: null, warnPercent: 20, error: null, fetchedAt: Date.now() }
  const grid = render(mini, exports.BalanceCard, { model, settings: { ...settings, visualStyle: 'grid' }, dark: false, compact: true, preview: true })
  assert.ok(texts(grid).join(' ').includes('88.50'))
  assert.ok(find(grid, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-grid-money')) !== null)
  assert.equal(find(grid, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-grid-bar')), null)
  assert.ok(texts(grid).join(' ').includes('账户余额'))

  const ring = render(mini, exports.BalanceCard, { model, settings: { ...settings, visualStyle: 'ring' }, dark: false, compact: true, preview: true })
  assert.ok(find(ring, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-ring-money')) !== null)
  assert.equal(find(ring, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-ring-wrap')), null)

  const line = render(mini, exports.BalanceCard, { model, settings: { ...settings, visualStyle: 'line' }, dark: false, compact: true, preview: true })
  assert.ok(find(line, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-money-amount')) !== null)
  assert.equal(find(line, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-ticks')), null)

  const gradient = render(mini, exports.BalanceCard, { model, settings: { ...settings, visualStyle: 'gradient' }, dark: false, compact: true, preview: true })
  assert.ok(find(gradient, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-money-amount')) !== null)
  assert.equal(find(gradient, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-glow')), null)
})

test('density is applied to the card as a spacing hook', () => {
  const { exports, mini } = load()
  const settings = baseSettings({ density: 'compact' })
  const model = exports.cardModel(snapshot(), 'baiduqianfan', settings)
  const tree = render(mini, exports.BalanceCard, { model, settings, dark: false, compact: true, preview: true })
  const card = find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dbc-style-grid'))
  assert.equal(card.props['data-density'], 'compact')
})

;(async () => {
  let failed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log('ok - ' + name)
    } catch (error) {
      failed += 1
      console.error('not ok - ' + name)
      console.error(error)
    }
  }
  if (failed > 0) {
    console.error(failed + ' test(s) failed')
    process.exit(1)
  }
  console.log(tests.length + ' tests passed')
  // wallet 的轮询定时器会保持事件循环；测试结束直接退出。
  process.exit(0)
})()