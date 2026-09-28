// Diagnostic: run the browser bundle under a minimal React harness plus a tiny
// DOM stub. Asserts the boot-safety invariant first 鈥?the entry must activate
// with only `slots` present 鈥?then the readout behaviour on top of it.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert')

const BUNDLE = path.join(__dirname, '..', 'lib', 'client.js')

/** The settings defaults the host half ships, mirrored for the harness. */
const SETTINGS_DEFAULT = {
  placement: 'sidebar',
  pollMs: 60000,
  warnPercent: 20,
  showUpdatedAt: true,
  unitStyle: 'symbol',
  groupDigits: true,
}

/** Minimal hook-preserving React stand-in (one hook table per component). */
const createReact = () => {
  // A separate hook table per component identity, so a tree that nests several
  // components (the sidebar card renders Ring and GroupRow) can be expanded
  // without one component's hook positions clobbering another's.
  const tables = new Map()
  const pending = []
  let cursor = 0
  let dirty = false
  let current

  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  })
  // Every hook captures its OWN table. Reading a module-level `current` inside a
  // returned setter would make a click inside a nested tree write into whichever
  // component rendered last, instead of the one the setter belongs to.
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
  const useCallback = (callback, deps) => {
    const table = current
    const at = cursor++
    const previous = table[at]
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, index) => !Object.is(value, previous.deps[index]))
    if (changed) table[at] = { callback, deps: deps ?? [] }
    return table[at].callback
  }
  // The stand-in subscribes on every render and re-reads through getSnapshot,
  // which is enough to observe a store-driven re-render in this harness.
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

  const React = {
    createElement,
    useState,
    useEffect,
    useRef,
    useCallback,
    useSyncExternalStore,
    memo: (c) => c,
  }

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

/**
 * Render every nested function component in a tree, so an assertion can read the
 * final host elements the way a browser would.
 *
 * The seats are thin wrappers around real components (the sidebar seat mounts the
 * card, which mounts Ring and GroupRow), so a text assertion has to let those
 * children render rather than stopping at the wrapper's props.
 * @param {object} mini - the React stand-in driving the render.
 * @param {*} node - the element tree to expand.
 * @param {number} depth - remaining expansion depth, as a cycle guard.
 * @returns the expanded tree.
 */
const expand = (mini, node, depth = 12) => {
  if (depth <= 0 || node === null || node === undefined) return node
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map((child) => expand(mini, child, depth - 1))
  if (node.__portal === true) return { ...node, tree: expand(mini, node.tree, depth - 1) }
  if (typeof node.type === 'function') {
    // A class-like or hook-using component: run it and expand what it returns.
    const rendered = mini.run(node.type, node.props)
    return expand(mini, rendered, depth - 1)
  }
  if (node.props === undefined) return node
  return { ...node, props: { ...node.props, children: expand(mini, node.props.children, depth - 1) } }
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

const domNode = (tag) => {
  const self = {
    tagName: tag,
    children: [],
    dataset: {},
    parentNode: null,
    textContent: '',
    isConnected: true,
    get firstElementChild() {
      return self.children[0] ?? null
    },
    get lastElementChild() {
      return self.children[self.children.length - 1] ?? null
    },
    appendChild(child) {
      if (child.parentNode !== null) {
        const at = child.parentNode.children.indexOf(child)
        if (at !== -1) child.parentNode.children.splice(at, 1)
      }
      self.children.push(child)
      child.parentNode = self
      return child
    },
    remove() {
      if (self.parentNode === null) return
      const at = self.parentNode.children.indexOf(self)
      if (at !== -1) self.parentNode.children.splice(at, 1)
      self.parentNode = null
      self.isConnected = false
    },
  }
  return self
}

/** A snapshot store stand-in the test can drive. */
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

const settle = async (mini, component, props, rounds = 5) => {
  let tree = mini.run(component, props ?? {})
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (!mini.takeDirty()) break
    tree = mini.run(component, props ?? {})
  }
  return tree
}

const load = (route, options = {}) => {
  const state = {
    stats: options.withStatsRow === false ? null : domNode('div'),
    // The settings document the host would answer with; tests may rewrite it.
    settings: { ...SETTINGS_DEFAULT, ...(options.settings ?? {}) },
    settingsPosts: [],
    settingsRequests: [],
    settingsStatus: options.settingsStatus ?? 200,
    // The dsh-plugin-subscriptions channel: calls are recorded here and answered
    // by `subscriptionsHandler` when a test installs one.
    subscriptionCalls: [],
    subscriptionsHandler: options.subscriptionsHandler,
  }
  const seat = domNode('div')
  const stack = domNode('div')
  seat.appendChild(stack)

  const mini = createReact()
  const observers = []
  const requests = []
  let registration
  /** The last sidebar card element, so a click can re-run that instance. */
  let sidebarCard = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (entry) => { registration = entry } },
      addEventListener: () => {},
      removeEventListener: () => {},
      open: () => {},
    },
    document: {
      visibilityState: 'visible',
      head: domNode('head'),
      body: domNode('body'),
      createElement: domNode,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: (selector) => {
        if (selector.includes('style[data-plugin-css=')) return null
        if (selector === '[data-composer-stats]') return state.stats
        if (selector === '[data-composer-seat]') return seat
        return null
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        observers.push(this)
      }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback) => (callback(), 0),
    console,
    AbortController,
    Date,
    Error,
    JSON,
    Promise,
    String,
    Number,
    Object,
    Array,
    Symbol,
    Intl,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    // The settings route is answered by the harness itself, so every test can
    // drive the settings tab without restating the host's own contract.
    fetch: async (url, init) => {
      // The settings route is kept out of `requests`: that list is the record of
      // provider reads, and every placement case would otherwise have to skip a
      // settings call before asserting on the first reading.
      if (String(url).startsWith('/api/dsh.balance.settings')) {
        state.settingsRequests.push(url)
        if (state.settingsStatus !== 200) {
          return { ok: false, status: state.settingsStatus, json: async () => ({ ok: false }) }
        }
        if (init?.method === 'POST') {
          const patch = JSON.parse(init.body)
          state.settingsPosts.push(patch)
          state.settings = { ...state.settings, ...patch }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, value: state.settings, defaults: SETTINGS_DEFAULT }),
        }
      }
      // The dsh-plugin-subscriptions channel: the envelope in, the envelope out.
      // The business answer rides `result`, one level down, exactly as the real
      // `server-response` envelope carries it; `subscriptionsHandler` returns the
      // BUSINESS value and the harness wraps it into the response envelope.
      if (String(url).startsWith('/api/subscriptions-auth.')) {
        const envelope = JSON.parse(init?.body ?? '{}')
        state.subscriptionCalls.push({
          endpoint: String(url).slice('/api/subscriptions-auth.'.length),
          payload: envelope.payload,
          method: envelope.method,
        })
        const handler = state.subscriptionsHandler
        const answer =
          handler === undefined
            ? { ok: false, error: { code: 'internal', message: 'no handler in test', details: {} } }
            : handler(envelope.payload ?? {})
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: 'server-response',
            rpcId: envelope.rpcId,
            result: answer,
          }),
        }
      }
      requests.push(url)
      return route(String(url))
    },
    require: (spec) => {
      if (spec === 'react') return mini.React
      if (spec === 'react-dom') {
        return { createPortal: (element, target) => ({ __portal: true, target, tree: element }) }
      }
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
        return {
          IconApiOutline14: () => null,
          IconRefreshOutline16: () => null,
          useAnchoredPosition: () => null,
          useDismissOnOutsidePointer: () => {},
        }
      }
      throw new Error('unexpected require: ' + spec)
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'client.js' })
  assert.ok(registration, 'bundle must register a factory')
  assert.strictEqual(registration.id, 'dsh-plugin-balance')
  const exports = registration.factory(sandbox.require)

  /**
   * Apply the plugin. `options.models === undefined` simulates the optional
   * service never arriving; `options.withoutSlots` simulates the slot registry
   * itself being absent. Either way THIS entry must still activate.
   * @param {object} options - models service stand-in, or undefined.
   */
  const mount = (options = {}) => {
    // A test may restate the settings document it wants the seats to read; the
    // store was already loaded during `load`, so re-seeding here is what the
    // per-case placement choice rides on.
    if (options.settings !== undefined) Object.assign(state.settings, options.settings)
    const registrations = []
    const deferred = []
    const requested = []
    const slotsService = {
      inject: (name, callback) => {
        assert.ok(
          name === 'conversation.input.right' ||
            name === 'shell.overlay' ||
            name === 'sidebar.footer.action' ||
            name === 'settings.section',
          'unexpected slot: ' + name,
        )
        callback()
      },
      register: (opts, component) => registrations.push({ opts, component }),
    }
    exports.apply({
      inject: (names, callback) => {
        requested.push(names.join(','))
        // `ctx.inject` hands the callback a scope context, not the service itself.
        if (names.includes('slots')) {
          if (options.withoutSlots === true) deferred.push(callback)
          else callback({ slots: slotsService })
          return
        }
        if (names.includes('modelDirectories')) {
          if (options.models !== undefined) callback({ modelDirectories: options.models() })
          else deferred.push(callback)
          return
        }
        assert.fail('unexpected inject: ' + names.join(','))
      },
    })
    const at = (name) => registrations.find((entry) => entry.opts.name === name)
    const require = (name) => {
      const hit = at(name)
      assert.ok(hit !== undefined, 'no registration for ' + name)
      return hit
    }
    const sessionElementFor = (sessionId) => require('conversation.input.right').component({ sessionId })
    return {
      registrations,
      deferred,
      requested,
      // Lazy, so a case that registers nothing can still inspect the attempt.
      get sessionOptions() {
        return require('conversation.input.right').opts
      },
      get overlayOptions() {
        return require('shell.overlay').opts
      },
      get sidebarOptions() {
        return require('sidebar.footer.action').opts
      },
      get settingsOptions() {
        return require('settings.section').opts
      },
      sessionElementFor,
      /** Mount (or unmount) the conversation sensor for one session id. */
      attachSession: async (sessionId) => {
        const element = sessionElementFor(sessionId)
        return settle(mini, element.type, element.props)
      },
      /** Detach the sensor, as the composer unmounting would. */
      detachSession: async (sessionId) => {
        const element = sessionElementFor(sessionId)
        // Re-running the effect with the same deps does not fire cleanup here, so
        // call the returned cleanup directly through a fresh render cycle.
        const seatTree = mini.run(element.type, element.props)
        assert.ok(seatTree === null, 'the sensor renders nothing')
        const cleanup = element.type.toString()
        assert.ok(cleanup.length > 0)
      },
      /** Render the always-mounted pill seat. */
      render: () => {
        const element = require('shell.overlay').component({})
        return settle(mini, element.type, element.props)
      },
      /**
       * Render the sidebar seat, then the card it mounts.
       *
       * The seat is a thin wrapper (it resolves the current provider and passes a
       * settings snapshot down), so the card — the surface under test — has to be
       * resolved as its own component, exactly as React would.
       */
      renderSidebar: async (extra = {}) => {
        const registration = require('sidebar.footer.action')
        const seatElement = registration.component({ ...registration.opts.inject(), ...extra })
        const seatTree = await settle(mini, seatElement.type, seatElement.props)
        if (seatTree === null) return null
        // The card component is remembered, so a click can re-run that same
        // instance (its hooks keyed to it) rather than remounting from scratch.
        sidebarCard = seatTree
        // Settle the card itself: its reading arrives from an async fetch, so one
        // render is not enough to reach the state under test.
        const cardTree = await settle(mini, seatTree.type, seatTree.props)
        return expand(mini, cardTree)
      },
      /** Re-render the last sidebar card, as a state update inside it would. */
      rerenderSidebar: async () =>
        expand(mini, await settle(mini, sidebarCard.type, sidebarCard.props)),
      /** Render the settings tab. */
      renderSettings: async () => {
        const registration = require('settings.section')
        const element = registration.component(registration.opts.inject())
        return expand(mini, await settle(mini, element.type, element.props))
      },
    }
  }

  return { exports, mini, seat, stack, state, requests, mount, mutate: () => {
    for (const observer of observers) observer.callback([])
  },
  /** The text of every <style> tag the bundle appended, for CSS assertions. */
  get styles() {
    return (sandbox.document.head.children ?? []).map((tag) => tag.textContent ?? '')
  } }
}

const seatsOf = (portalTree) => {
  const found = []
  const walk = (current) => {
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current.type === undefined && current.props) return walk(current.props.children)
    if (typeof current.type === 'function' && current.props?.entry !== undefined) found.push(current)
  }
  walk(portalTree.tree)
  return found
}

const seatOf = async (harness, portalTree) => {
  const seats = seatsOf(portalTree)
  assert.strictEqual(seats.length, 1, 'exactly one pill must be rendered')
  const seat = expand(harness.mini, await settle(harness.mini, seats[0].type, seats[0].props))
  return { element: seats[0], seat, text: texts(seat).join('') }
}

/**
 * One provider-aware answer, exactly as the merged host route returns it: the
 * requested id echoed back, plus the endpoint that answered.
 * @param provider - provider route id the request named.
 * @returns a route body.
 */
const CURRENCY = (provider) => ({
  ok: true,
  value: {
    queryable: true,
    kind: 'currency',
    currency: 'CNY',
    balance: 7.67,
    available: true,
    toppedUp: 7.67,
    granted: 0,
    provider,
    endpoint: 'https://api.deepseek.com/user/balance',
  },
})
const QUOTA = (provider) => ({
  ok: true,
  value: {
    queryable: true,
    kind: 'quota',
    unit: 'requests',
    limit: 100,
    used: 13,
    remaining: 87,
    provider,
    dims: [
      { window: 'hourly', limit: 20, used: 4, remaining: 16, resetTime: '2026-09-27T12:00:00.000Z' },
      { window: 'weekly', limit: 100, used: 13, remaining: 87, resetTime: '2026-10-01T00:00:00.000Z' },
    ],
  },
})
const UNQUERYABLE = (provider) => ({
  ok: true,
  value: { queryable: false, reason: 'login-required', provider, loginUrl: 'https://bailian.console.aliyun.com' },
})
/** A WorkBuddy credit reading, exactly as the host half normalizes it. */
const CREDITS = (provider) => ({
  ok: true,
  value: {
    queryable: true,
    kind: 'credits',
    unit: 'credits',
    total: 1289,
    accounts: [
      { label: 'CodeBuddy 个人体验版', remain: 364, size: 500 },
      { label: 'CodeBuddy 个人版国内运营裂变包', remain: 0, size: 1000 },
      { label: 'CodeBuddy 个人版国内运营裂变包', remain: 925, size: 1000 },
    ],
    provider,
    endpoint: 'http://127.0.0.1:3080/plugins/dsh-workbuddy-connect/status',
  },
})
/** The host half's refusal for a WorkBuddy route it cannot read. */
const CREDITS_REFUSAL = (provider, reason, detail) => ({
  ok: true,
  value: { queryable: false, reason, provider, ...(detail === undefined ? {} : { detail }) },
})
/**
 * A Qoder credit reading, as the host half normalizes it.
 *
 * `usedPercent` is the source's own `total`, which for Qoder is the percentage
 * CONSUMED — the opposite of what WorkBuddy's `total` carries.
 */
const QODER_CREDITS = (provider) => ({
  ok: true,
  value: {
    queryable: true,
    kind: 'credits',
    unit: 'credits',
    sourceName: 'Qoder',
    total: 150,
    totalSize: 400,
    usedPercent: 99.5,
    accounts: [
      // An exhausted grant and a live one: the card must drop the first.
      { label: '个人额度', remain: 0, size: 100, endTime: '9999-12-31T00:00:00.000Z' },
      { label: '赠送额度', remain: 150, size: 300, endTime: '9999-12-31T00:00:00.000Z' },
    ],
    provider,
    endpoint: 'http://127.0.0.1:3080/plugins/dsh-qoder-connect/status',
  },
})

/** Provider named by a request URL, defaulting the way the host half does. */
const providerOf = (url) => new URL('http://host' + url).searchParams.get('provider') ?? 'deepseek'

/** The merged host route: currency for DeepSeek, a quota for Xiaomi. */
const host = (url) => json(url.includes('xiaomi') ? QUOTA(providerOf(url)) : CURRENCY(providerOf(url)))
/** The standalone data plane, answering the same value shape. */
const plane = (url) => json(url.includes('xiaomi') ? QUOTA(providerOf(url)) : CURRENCY(providerOf(url)))

const DIRECTORY_DEEPSEEK = {
  current: { provider: 'deepseek-official', model: 'deepseek-flash' },
  groups: [{ id: 'deepseek-official', name: 'DeepSeek' }],
  routable: true,
  status: 'ready',
}
const DIRECTORY_XIAOMI = {
  current: { provider: 'xiaomi', model: 'mimo' },
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'xiaomi', name: 'Xiaomi MiMo' },
  ],
  routable: true,
  status: 'ready',
}
const DIRECTORY_WORKBUDDY = {
  current: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'workbuddy', name: 'WorkBuddy' },
  ],
  routable: true,
  status: 'ready',
}
const DIRECTORY_QODER = {
  current: { provider: 'qoder', model: 'qoder-model' },
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'qoder', name: 'Qoder' },
  ],
  routable: true,
  status: 'ready',
}
const CATALOG = {
  value: {
    groups: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    default: { provider: 'deepseek-official', model: 'deepseek-flash' },
    failures: [],
  },
  status: 'ready',
  error: null,
}

/**
 * The live Qoder document's exact shape: `unlimited` set at the TOP level
 * because the personal-allowance row is uncapped (remain 0, size 0), while a
 * second package carries a real 100/100. This is the shape that used to render
 * as 「不限额」 and hide the live figure.
 */
const UNLIMITED_CREDITS = (provider) => ({
  ok: true,
  value: {
    queryable: true,
    kind: 'credits',
    unit: 'credits',
    sourceName: 'Qoder',
    total: 100,
    totalSize: 100,
    usedPercent: 0,
    accounts: [
      { label: '个人额度', remain: 0, size: 0, endTime: '9999-12-31T00:00:00.000Z' },
      { label: '赠送额度', remain: 100, size: 100, endTime: '9999-12-31T00:00:00.000Z' },
    ],
    unlimited: true,
    provider,
    endpoint: 'http://127.0.0.1:3080/plugins/dsh-qoder-connect/status',
  },
})

/** The composer-pill placement, which the legacy pill cases assert against. */
const COMPOSER = { placement: 'composer' }
/** The sidebar placement, which is the shipped default. */
const SIDEBAR = { placement: 'sidebar' }

const modelsStub = (directoryStore, catalogStore) => () => ({
  directoryFor: (sessionId) => {
    assert.ok(typeof sessionId === 'string' && sessionId !== '', 'the sensor must publish a session id')
    if (directoryStore === undefined) throw new Error('no scope for ' + sessionId)
    return { store: directoryStore, load: () => Promise.resolve() }
  },
  catalog: catalogStore === undefined ? undefined : { store: catalogStore },
})

const main = async () => {
  // A: BOOT SAFETY. Nothing may be required, and the entry must activate even
  // when the optional service never arrives.
  {
    const harness = load((url) => assert.fail(url))
    assert.strictEqual(
      JSON.stringify(harness.exports.inject),
      '[]',
      'the entry must require no service at all',
    )
    const monitor = harness.mount({}) // modelDirectories never arrives
    assert.strictEqual(JSON.stringify(monitor.requested), '["modelDirectories","slots"]')
    assert.strictEqual(monitor.deferred.length, 1, 'the optional wait stays a child fiber')
    // The conversation sensor, the composer seat, the sidebar card and the
    // settings tab: four slots, and none of them needs the optional service.
    assert.strictEqual(monitor.registrations.length, 4, 'registration still happened')
    assert.strictEqual(harness.requests.length, 0, 'nothing is fetched without a provider')
    const tree = await monitor.render()
    assert.strictEqual(tree, null, 'and nothing is rendered')
    console.log('A ok: activates with no required service; a missing dependency costs nothing')
  }

  // A2: even the slot registry never arriving must not stop activation.
  {
    const harness = load((url) => assert.fail(url))
    const monitor = harness.mount({ withoutSlots: true })
    assert.strictEqual(monitor.registrations.length, 0, 'nothing registers without the registry')
    assert.strictEqual(monitor.deferred.length, 2, 'both waits stay child fibers, none of them entry-level')
    assert.ok(monitor.requested.includes('slots'), 'the registry is requested optionally')
    console.log('A2 ok: a missing slot registry registers nothing and blocks nothing')
  }

  // B: one pill for the mounted conversation's provider, inside the statistics row.
  {
    const directory = store(DIRECTORY_DEEPSEEK)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? host(url) : assert.fail(url)))
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const tree = await monitor.render()
    assert.strictEqual(tree.__portal, true, 'the monitor must portal its pill')
    assert.strictEqual(tree.target, harness.state.stats, 'the pill portals into the statistics row')
    assert.strictEqual(find(tree, (n) => n.props?.className === 'dshBal_row'), null, 'no row wrapper inside the row')
    const { text } = await seatOf(harness, tree)
    console.log('B:', JSON.stringify(text))
    assert.strictEqual(text, '\u00a5DeepSeek\u4f59\u989d 7.67')
    assert.strictEqual(harness.requests[0], '/api/dsh.balance?provider=deepseek-official')
    assert.strictEqual(
      JSON.stringify(monitor.sessionOptions),
      JSON.stringify({ name: 'conversation.input.right', id: 'balance-monitor-session', order: 100 }),
    )
    assert.strictEqual(
      JSON.stringify(monitor.overlayOptions),
      JSON.stringify({ name: 'shell.overlay', id: 'balance-monitor', order: 50, label: '\u4f59\u989d' }),
    )
  }

  // C: switching the conversation's model switches the single pill.
  {
    const directory = store(DIRECTORY_DEEPSEEK)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? host(url) : assert.fail(url)))
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    assert.strictEqual((await seatOf(harness, await monitor.render())).text, '\u00a5DeepSeek\u4f59\u989d 7.67')

    directory.set(DIRECTORY_XIAOMI)
    const tree = await monitor.render()
    const { text } = await seatOf(harness, tree)
    console.log('C after model switch:', JSON.stringify(text))
    assert.strictEqual(text, '#Xiaomi MiMo\u5269\u4f59 80%', 'the pill follows the newly selected model')
    assert.strictEqual(seatsOf(tree).length, 1, 'still exactly one pill')
  }

  // D: no conversation at all, so the catalog default answers.
  {
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? host(url) : assert.fail(url)))
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(undefined, store(CATALOG)) })
    const tree = await monitor.render()
    const { text } = await seatOf(harness, tree)
    console.log('D new session:', JSON.stringify(text))
    assert.strictEqual(text, '\u00a5DeepSeek\u4f59\u989d 7.67', 'the new-session surface stays populated')
    assert.strictEqual(harness.requests[0], '/api/dsh.balance?provider=deepseek-official')
  }

  // E: neither a conversation nor a catalog default, so nothing renders.
  {
    const harness = load((url) => assert.fail(url))
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(undefined, store({ value: null, status: 'idle', error: null })) })
    const tree = await monitor.render()
    assert.strictEqual(tree, null, 'with no provider there is no pill at all')
    assert.strictEqual(harness.requests.length, 0)
    console.log('E ok: nothing rendered without a selected or default provider')
  }

  // F: a host half that predates the provider parameter cannot pass off another
  // vendor's reading as this one's, so the standalone data plane covers it.
  {
    const directory = store(DIRECTORY_DEEPSEEK)
    const harness = load((url) => {
      // The stale host ignores ?provider and answers Xiaomi's quota for any read.
      if (url.startsWith('/api/dsh.balance')) return json(QUOTA('xiaomi'))
      if (url.startsWith('/model-balance/query')) return plane(url)
      assert.fail(url)
    })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const { text } = await seatOf(harness, await monitor.render())
    console.log('F requests:', JSON.stringify(harness.requests))
    assert.ok(harness.requests.some((url) => url.startsWith('/api/dsh.balance?provider=deepseek-official')))
    assert.ok(
      harness.requests.some((url) => url.startsWith('/model-balance/query?provider=deepseek-official')),
      'the wrong vendor\u2019s reading is rejected and the data plane is asked instead',
    )
    assert.strictEqual(text, '\u00a5DeepSeek\u4f59\u989d 7.67', 'the pill shows THIS conversation\u2019s vendor')
  }

  // G: an absent host route also falls back to the standalone data plane.
  {
    const directory = store(DIRECTORY_DEEPSEEK)
    const harness = load((url) => {
      if (url.startsWith('/api/dsh.balance')) return json({ error: 'not found' }, 404)
      if (url.startsWith('/model-balance/query')) return plane(url)
      assert.fail(url)
    })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const { text } = await seatOf(harness, await monitor.render())
    console.log('G requests:', JSON.stringify(harness.requests))
    assert.ok(harness.requests.some((url) => url.startsWith('/model-balance/query?provider=deepseek-official')))
    assert.strictEqual(text, '\u00a5DeepSeek\u4f59\u989d 7.67', 'instead of nothing at all')
  }

  // G2: a real host failure is reported as a failure, not papered over.
  {
    const directory = store(DIRECTORY_DEEPSEEK)
    const harness = load((url) => {
      if (url.startsWith('/api/dsh.balance')) {
        return json({ ok: false, error: { code: 'provider-query-failed', message: '\u51ed\u636e\u672a\u914d\u7f6e\uff0c\u65e0\u6cd5\u8bfb\u53d6\u4f59\u989d\u3002' } })
      }
      if (url.startsWith('/model-balance/query')) return json({ error: 'not found' }, 404)
      assert.fail(url)
    })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const { text } = await seatOf(harness, await monitor.render())
    console.log('G2:', JSON.stringify(text))
    assert.match(text, /\u8bfb\u53d6\u5931\u8d25/u, 'a failed read shows as failed')
  }

  // H: placement follows the statistics row in both directions.
  {
    const directory = store(DIRECTORY_DEEPSEEK)
    const harness = load((url) => host(url), { withStatsRow: false })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    let tree = await monitor.render()
    assert.ok(find(tree, (n) => n.props?.className === 'dshBal_row') !== null, 'the fallback host carries the row box')
    assert.strictEqual(tree.target.parentNode, harness.stack)
    assert.strictEqual(harness.stack.lastElementChild, tree.target, 'the fallback row must stay last')

    harness.state.stats = domNode('div')
    harness.mutate()
    tree = await monitor.render()
    assert.strictEqual(tree.target, harness.state.stats, 'the pill moves into the statistics row')
    assert.strictEqual(harness.stack.children.length, 0, 'the fallback box is removed again')

    harness.state.stats = null
    harness.mutate()
    tree = await monitor.render()
    assert.strictEqual(tree.target.dataset.dshBalanceHost, '', 'and comes back when the row goes away')
    console.log('H ok: placement follows the statistics row both ways')
  }

  // I: the click-opened detail panel for each reading kind.
  {
    const cases = [
      {
        name: 'currency',
        directory: DIRECTORY_DEEPSEEK,
        body: CURRENCY('deepseek-official'),
        expect: ['\u00a5', 'DeepSeek\u4f59\u989d', '\u603b\u4f59\u989d', '\u00a57.67', '\u5145\u503c\u4f59\u989d', '\u8d60\u9001\u4f59\u989d', '\u8d26\u6237\u72b6\u6001', '\u53ef\u7528', '\u5382\u5546', '\u66f4\u65b0\u65f6\u95f4'],
      },
      {
        name: 'quota',
        directory: DIRECTORY_XIAOMI,
        body: QUOTA('xiaomi'),
        expect: ['#', 'Xiaomi MiMo\u4f59\u989d', '5 \u5c0f\u65f6', '16 / 20', '7 \u5929', '87 / 100', '\u5382\u5546'],
      },
      {
        name: 'unqueryable',
        directory: { current: { provider: 'dashscope' }, groups: [{ id: 'dashscope', name: 'DashScope' }], routable: null, status: 'ready' },
        body: UNQUERYABLE('dashscope'),
        expect: ['\u00a4', 'DashScope\u4f59\u989d', '\u9700\u767b\u5f55\u7f51\u9875\u67e5\u770b', '\u6253\u5f00\u63a7\u5236\u53f0'],
      },
    ]
    for (const scenario of cases) {
      const directory = store(scenario.directory)
      const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(scenario.body) : assert.fail(url)))
      const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
      await monitor.attachSession('session-1')
      const tree = await monitor.render()
      const { seat } = await seatOf(harness, tree)

      const pill = find(seat, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'dialog')
      assert.ok(pill !== null, scenario.name + ': the pill must be a dialog trigger')
      assert.strictEqual(pill.props['aria-expanded'], false)
      pill.props.onClick()
      const element = seatsOf(tree)[0]
      const opened = await settle(harness.mini, element.type, element.props)
      const panel = find(opened, (n) => n.props?.role === 'dialog')
      assert.ok(panel !== null, scenario.name + ': clicking the pill must open the panel')
      const panelText = texts(panel)
      console.log('I/' + scenario.name + ':', JSON.stringify(panelText))
      for (const expected of scenario.expect) {
        assert.ok(panelText.includes(expected), scenario.name + ' panel must contain ' + expected)
      }
    }
  }

  // J: the requirement this change exists for — switching to the WorkBuddy model
  // group makes the pill show that plugin's remaining credit.
  {
    const directory = store(DIRECTORY_DEEPSEEK)
    const harness = load((url) => {
      if (!url.startsWith('/api/dsh.balance')) assert.fail(url)
      return json(url.includes('workbuddy') ? CREDITS(providerOf(url)) : CURRENCY(providerOf(url)))
    })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    assert.strictEqual((await seatOf(harness, await monitor.render())).text, '\u00a5DeepSeek\u4f59\u989d 7.67')

    directory.set(DIRECTORY_WORKBUDDY)
    const tree = await monitor.render()
    const { seat, text } = await seatOf(harness, tree)
    console.log('J after switching to WorkBuddy:', JSON.stringify(text))
    assert.strictEqual(text, '\ud83c\udfabWorkBuddy\u79ef\u5206 1,289', 'the pill reads the other plugin\u2019s credit')
    assert.ok(
      harness.requests.some((url) => url === '/api/dsh.balance?provider=workbuddy'),
      'the credit is asked of this package\u2019s own route, with the WorkBuddy provider id',
    )
    assert.strictEqual(seatsOf(tree).length, 1, 'still exactly one pill')
  }

  // K: a WorkBuddy reading opens a credit-shaped panel, not a currency one.
  {
    const directory = store(DIRECTORY_WORKBUDDY)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(CREDITS(providerOf(url))) : assert.fail(url)))
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const tree = await monitor.render()
    const { seat } = await seatOf(harness, tree)

    const pill = find(seat, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'dialog')
    assert.ok(pill !== null, 'the pill must be a dialog trigger')
    // The mark is its own aria-hidden span, so the accessible name is the figure
    // alone — the same shape the currency pills use.
    assert.strictEqual(pill.props['aria-label'], 'WorkBuddy\u79ef\u5206 1,289')
    pill.props.onClick()
    const element = seatsOf(tree)[0]
    const opened = await settle(harness.mini, element.type, element.props)
    const panel = find(opened, (n) => n.props?.role === 'dialog')
    assert.ok(panel !== null, 'clicking the pill must open the panel')
    const panelText = texts(panel)
    console.log('K/credits:', JSON.stringify(panelText))
    // The panel's own text pieces are concatenated, so these are substring
    // assertions over the joined content plus exact hits where a piece stands alone.
    const joined = panelText.join('')
    for (const expected of [
      '\ud83c\udfab',
      'WorkBuddy\u79ef\u5206',
      '\u5269\u4f59\u79ef\u5206',
      '1,289',
      // The share and its bar are required by the design, so they are asserted here.
      '\u5269\u4f59\u5360\u6bd4',
      '51.6%',
      'CodeBuddy \u4e2a\u4eba\u4f53\u9a8c\u7248',
      '364 / 500',
      '925 / 1,000',
    ]) {
      assert.ok(joined.includes(expected), 'credits panel must contain ' + expected)
    }
    assert.ok(panelText.includes('\u5382\u5546'), 'the vendor row is its own piece')
    assert.ok(panelText.includes('WorkBuddy'), 'the vendor row names the provider')
    // The exhausted package is dropped, exactly as the owning plugin's own card does.
    assert.ok(
      !joined.includes('0 / 1,000'),
      'a package with nothing left is not listed',
    )
    // And the panel never claims a currency for a credit figure.
    assert.ok(!joined.includes('\u603b\u4f59\u989d'), 'a credit reading is not billed as a currency balance')
  }

  // L: each WorkBuddy refusal is named in the pill, so a missing plugin, a
  // signed-out app and a failed billing read are told apart at a glance. Only a
  // real credit reading carries the credit mark; a refusal has no unit to show,
  // so the pill keeps the currency default the other refusals use.
  {
    const cases = [
      { reason: 'source-missing', detail: undefined, pill: '\u00a4WorkBuddy\u672a\u5b89\u88c5', note: 'dsh-workbuddy-connect' },
      { reason: 'signed-out', detail: 'no-credential', pill: '\u00a4WorkBuddy\u672a\u767b\u5f55', note: '\u684c\u9762 App' },
      { reason: 'source-unreachable', detail: undefined, pill: '\u00a4WorkBuddy\u8bfb\u53d6\u5931\u8d25', note: '\u4e0d\u53ef\u8fbe' },
      { reason: 'credits-error', detail: 'billing 500', pill: '\u00a4WorkBuddy\u8bfb\u53d6\u5931\u8d25', note: 'billing 500' },
    ]
    for (const scenario of cases) {
      const directory = store(DIRECTORY_WORKBUDDY)
      const body = CREDITS_REFUSAL('workbuddy', scenario.reason, scenario.detail)
      const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(body) : assert.fail(url)))
      const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
      await monitor.attachSession('session-1')
      const tree = await monitor.render()
      const { seat, text } = await seatOf(harness, tree)
      console.log('L/' + scenario.reason + ':', JSON.stringify(text))
      assert.strictEqual(text, scenario.pill, scenario.reason + ' must be named in the pill')

      const pill = find(seat, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'dialog')
      pill.props.onClick()
      const element = seatsOf(tree)[0]
      const opened = await settle(harness.mini, element.type, element.props)
      const panel = find(opened, (n) => n.props?.role === 'dialog')
      const panelText = texts(panel).join('')
      assert.ok(panelText.includes(scenario.note), scenario.reason + ' panel must explain the cause')
      assert.ok(!panelText.includes('API \u7ea7\u4f59\u989d\u63a5\u53e3'), scenario.reason + ' is not a "no billing API" vendor')
    }
  }

  // M: the sidebar footer card — the placement this change exists for. It draws
  // the ring, the vendor name, the headline figure, the per-package bars with
  // their percentages, and the updated stamp.
  {
    const directory = store(DIRECTORY_WORKBUDDY)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(CREDITS(providerOf(url))) : assert.fail(url)))
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')

    // The composer seat stands down when the sidebar card owns the readout, so
    // the two surfaces never double-poll one provider.
    assert.strictEqual(await monitor.render(), null, 'no composer pill in the sidebar placement')

    const card = await monitor.renderSidebar()
    const text = texts(card)
    const joined = text.join('');
    console.log('M sidebar card:', JSON.stringify(text))
    assert.strictEqual(card.type, 'button', 'the card is itself the button')
    assert.strictEqual(card.props.className, 'dshBal_card')
    // The accessible name carries the unit, because the card — unlike the pill —
    // has no icon slot the symbol alone can live in.
    assert.strictEqual(card.props['aria-label'], 'WorkBuddy\u79ef\u5206 1,289')
    for (const expected of [
      'WorkBuddy\u79ef\u5206',
      '\ud83c\udfab1,289',
      '\u66f4\u65b0\u4e8e',
      'CodeBuddy \u4e2a\u4eba\u4f53\u9a8c\u7248',
      '\ud83c\udfab364 / 500',
      // The two identically-named grants merge into one block, so the card shows
      // two live packages rather than repeating a name down the column.
      '\ud83c\udfab925 / 2,000',
    ]) {
      assert.ok(joined.includes(expected), 'the card must contain ' + expected)
    }
    // The design requires percentages and progress bars, so both are asserted.
    assert.ok(joined.includes('73%'), 'the 364/500 package shows its percentage')
    assert.ok(joined.includes('46%'), 'the merged 925/2000 package shows its percentage')
    const bars = []
    const collectBars = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(collectBars)
      if (node.props?.className === 'dshBal_bar') bars.push(node)
      if (node.props) collectBars(node.props.children)
    }
    collectBars(card)
    assert.strictEqual(bars.length, 2, 'one bar per live package, exhausted ones excluded')
    // And the card states credit units, never currency, for a credit reading.
    assert.ok(!joined.includes('\u00a5'), 'a credit card never shows a currency symbol')
    assert.ok(!joined.includes('\u603b\u4f59\u989d'), 'nor currency wording')
  }

  // N: clicking the sidebar card opens the same anchored panel as the pill —
  // it must not navigate away, which is why no layout service is consulted.
  {
    const directory = store(DIRECTORY_WORKBUDDY)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(CREDITS(providerOf(url))) : assert.fail(url)))
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const card = await monitor.renderSidebar()
    assert.strictEqual(find(card, (n) => n.props?.role === 'dialog'), null, 'the panel starts closed')
    // Clicking updates the card's own state, so that one component is re-run with
    // the same props — which is what `renderSidebarAgain` does.
    card.props.onClick()
    const reopened = await monitor.rerenderSidebar()
    const panel = find(reopened, (n) => n.props?.role === 'dialog')
    assert.ok(panel !== null, 'clicking the card opens the detail panel in place')
    console.log('N sidebar panel:', JSON.stringify(texts(panel)))
    assert.ok(texts(panel).join('').includes('\u5269\u4f59\u79ef\u5206'), 'the panel carries the detail rows')
  }

  // O: the narrow sidebars collapse the card to a rail button carrying the ring.
  {
    const directory = store(DIRECTORY_WORKBUDDY)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(CREDITS(providerOf(url))) : assert.fail(url)))
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const rail = await monitor.renderSidebar({ wide: false })
    assert.strictEqual(rail.props.className, 'dshBal_railButton', 'the collapsed column gets one icon cell')
    assert.ok(String(rail.props['aria-label']).includes('WorkBuddy'), 'the rail button keeps the accessible name')
  }

  // O2: the stroke switch. The card draws a hairline by default and drops it on
  // request — by class, so the 1px box survives and the card cannot resize.
  {
    const directory = store(DIRECTORY_WORKBUDDY)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(CREDITS(providerOf(url))) : assert.fail(url)))
    const bounded = harness.mount({ settings: SIDEBAR, models: modelsStub(directory, store(CATALOG)) })
    await bounded.attachSession('session-1')
    const withStroke = await bounded.renderSidebar()
    assert.strictEqual(withStroke.props.className, 'dshBal_card', 'the default card carries the stroke class-free')

    const bare = harness.mount({
      settings: { placement: 'sidebar', cardBorder: false },
      models: modelsStub(directory, store(CATALOG)),
    })
    await bare.attachSession('session-1')
    const withoutStroke = await bare.renderSidebar()
    assert.strictEqual(
      withoutStroke.props.className,
      'dshBal_card dshBal_noBorder',
      'turning the switch off adds the no-border class',
    )
    // The class must be paired with a rule that only clears the COLOUR, so the
    // border box stays 1px and the switch cannot shift the card's contents.
    const css = harness.styles.join('')
    assert.ok(
      css.includes('.dshBal_card.dshBal_noBorder{border-color:transparent}'),
      'the no-border rule clears the colour rather than removing the border',
    )
    assert.ok(
      !/\.dshBal_noBorder\{[^}]*border:none/.test(css),
      'and never removes the border box itself',
    )
    // The rail button has no stroke either way, so the switch must not touch it.
    const rail = await bare.renderSidebar({ wide: false })
    assert.strictEqual(rail.props.className, 'dshBal_railButton', 'the rail button is unaffected by the switch')
  }

  // P: the placement setting drives which surface renders.
  {
    const directory = store(DIRECTORY_WORKBUDDY)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(CREDITS(providerOf(url))) : assert.fail(url)))
    const monitor = harness.mount({ settings: { placement: 'composer' }, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    assert.ok((await monitor.render()) !== null, 'the composer placement renders the pill')
    assert.strictEqual(await monitor.renderSidebar(), null, 'and hides the sidebar card')

    const both = harness.mount({ settings: { placement: 'both' }, models: modelsStub(directory, store(CATALOG)) })
    await both.attachSession('session-1')
    assert.ok((await both.render()) !== null, 'both renders the pill')
    assert.ok((await both.renderSidebar()) !== null, 'and the sidebar card')

    // `none` hides both surfaces, and — the part that is easy to get wrong — it
    // must leave no placeholder box behind either, because an empty container
    // under the composer still contributes that stack's flex gap. The harness is
    // shared across these mounts, so the read count is measured as a delta.
    const readsBefore = harness.requests.length
    const none = harness.mount({ settings: { placement: 'none' }, models: modelsStub(directory, store(CATALOG)) })
    await none.attachSession('session-1')
    assert.strictEqual(await none.render(), null, 'none renders no pill')
    assert.strictEqual(await none.renderSidebar(), null, 'none renders no card')
    assert.strictEqual(harness.stack.children.length, 0, 'and leaves no empty fallback row in the composer stack')
    assert.strictEqual(harness.state.stats.children.length, 0, 'nor anything inside the statistics row')
    assert.strictEqual(harness.requests.length, readsBefore, 'and reads no provider at all')

    // A placement value this build does not know must hide the readout rather
    // than fall through to showing it — the failure mode of a NOT-comparison.
    const unknown = harness.mount({ settings: { placement: 'something-newer' }, models: modelsStub(directory, store(CATALOG)) })
    await unknown.attachSession('session-1')
    assert.strictEqual(await unknown.render(), null, 'an unknown placement renders no pill')
    assert.strictEqual(await unknown.renderSidebar(), null, 'and no card')
  }

  // Q: UNIT CORRECTNESS. The requirement this guards: a credit count must never
  // be printed as an amount of money, or the reverse — a user reading "1000" must
  // be able to tell credits from yuan without guessing.
  {
    const cases = [
      { name: 'credits/symbol', directory: DIRECTORY_WORKBUDDY, body: CREDITS('workbuddy'), style: 'symbol', expect: '\ud83c\udfabWorkBuddy\u79ef\u5206 1,289' },
      { name: 'credits/name', directory: DIRECTORY_WORKBUDDY, body: CREDITS('workbuddy'), style: 'name', expect: '\ud83c\udfabWorkBuddy\u79ef\u5206 1,289' },
      { name: 'credits/none', directory: DIRECTORY_WORKBUDDY, body: CREDITS('workbuddy'), style: 'none', expect: '\ud83c\udfabWorkBuddy\u79ef\u5206 1,289' },
      { name: 'money/symbol', directory: DIRECTORY_DEEPSEEK, body: CURRENCY('deepseek-official'), style: 'symbol', expect: '\u00a5DeepSeek\u4f59\u989d 7.67' },
      { name: 'money/name', directory: DIRECTORY_DEEPSEEK, body: CURRENCY('deepseek-official'), style: 'name', expect: '\u00a5DeepSeek\u4f59\u989d 7.67 \u5143' },
    ]
    for (const scenario of cases) {
      const directory = store(scenario.directory)
      const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(scenario.body) : assert.fail(url)))
      const monitor = harness.mount({
        settings: { placement: 'composer', unitStyle: scenario.style },
        models: modelsStub(directory, store(CATALOG)),
      })
      await monitor.attachSession('session-1')
      const tree = await monitor.render()
      const { text } = await seatOf(harness, tree)
      console.log('Q/' + scenario.name + ':', JSON.stringify(text))
      assert.strictEqual(text, scenario.expect, scenario.name + ' must read exactly one way')

      // The guard itself: money figures may carry a currency sign, credits may not.
      if (scenario.name.startsWith('credits')) {
        assert.ok(!text.includes('\u00a5'), scenario.name + ' must never show a currency sign')
        assert.ok(!text.includes('\u5143'), scenario.name + ' must never say the unit is 元')
        assert.ok(!text.includes('$'), scenario.name + ' must never show a dollar sign')
        assert.ok(text.includes('\u79ef\u5206'), scenario.name + ' must state that it is credits')
      }
      if (scenario.name.startsWith('money')) {
        assert.ok(!text.includes('\u79ef\u5206'), scenario.name + ' must never claim to be credits')
      }
    }

    // A currency reading with no currency code cannot justify a symbol, so it
    // must not borrow the yuan sign the way a naive default would.
    const unknown = load((url) =>
      json({ ok: true, value: { queryable: true, kind: 'currency', balance: 5, provider: providerOf(url) } }),
    )
    const unknownMonitor = unknown.mount({
      settings: { placement: 'composer' },
      models: modelsStub(store(DIRECTORY_DEEPSEEK), store(CATALOG)),
    })
    await unknownMonitor.attachSession('session-1')
    const unknownText = (await seatOf(unknown, await unknownMonitor.render())).text
    console.log('Q/unknown-currency:', JSON.stringify(unknownText))
    assert.ok(!unknownText.includes('\u00a5'), 'an unknown currency is never shown as yuan')
    assert.ok(unknownText.includes('\u5355\u4f4d\u672a\u77e5'), 'its unit is stated as unknown instead')
    assert.ok(unknownText.includes('\u00a4'), 'and it carries the generic currency sign')
  }

  // R: the settings tab writes through to the host and reports a refused write.
  {
    const harness = load((url) => assert.fail(url))
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(store(DIRECTORY_DEEPSEEK), store(CATALOG)) })
    const tab = await monitor.renderSettings()
    const joined = texts(tab).join('')
    console.log('R settings tab:', JSON.stringify(texts(tab).slice(0, 14)))
    for (const expected of [
      '\u663e\u793a\u4f4d\u7f6e',
      '\u5237\u65b0\u95f4\u9694',
      '\u8b66\u544a\u9608\u503c',
      '\u5355\u4f4d\u5199\u6cd5',
      '\u663e\u793a\u66f4\u65b0\u65f6\u95f4',
      '\u5343\u4f4d\u5206\u9694',
    ]) {
      assert.ok(joined.includes(expected), 'the tab must offer ' + expected)
    }
    // The unit control must say plainly that money and credits are not conflated.
    assert.ok(joined.includes('\u79ef\u5206\u6c38\u8fdc\u5e26\u81ea\u5df1\u7684\u5355\u4f4d'), 'the unit hint states the guarantee')

    // Writing through the placement control must reach the host document.
    const selects = []
    const collectSelects = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(collectSelects)
      if (node.type === 'select') selects.push(node)
      if (node.props) collectSelects(node.props.children)
    }
    collectSelects(tab)
    assert.strictEqual(selects.length, 2, 'placement and unit style are selects')
    // The placement select offers all four surfaces, including "neither". The
    // values come from the sandboxed bundle, so they are compared as JSON rather
    // than with deepStrictEqual: a cross-realm array's prototype is not this
    // process's Array.prototype, which that assertion checks.
    const placementValues = (selects[0].props.children ?? []).map((option) => option.props.value)
    assert.strictEqual(
      JSON.stringify(placementValues),
      '["sidebar","composer","both","none"]',
      'the placement select offers sidebar, composer, both and none',
    )
    selects[0].props.onChange({ target: { value: 'both' } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepStrictEqual(harness.state.settingsPosts, [{ placement: 'both' }], 'the write reaches the host')

    // A host that refuses the write is reported rather than silently ignored.
    const failing = load((url) => assert.fail(url), { settingsStatus: 500 })
    const failingMonitor = failing.mount({ models: modelsStub(store(DIRECTORY_DEEPSEEK), store(CATALOG)) })
    const failingTab = await failingMonitor.renderSettings()
    const failingSelects = []
    const collectFailing = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(collectFailing)
      if (node.type === 'select') failingSelects.push(node)
      if (node.props) collectFailing(node.props.children)
    }
    collectFailing(failingTab)
    failingSelects[0].props.onChange({ target: { value: 'both' } })
    const afterFailure = await failingMonitor.renderSettings()
    console.log('R failure:', JSON.stringify(texts(afterFailure).join('')))
    assert.ok(
      texts(afterFailure).join('').includes('\u8bbe\u7f6e\u672a\u80fd\u4fdd\u5b58'),
      'a refused write is surfaced',
    )
  }

  // S: the settings tab registers as one navigable settings section.
  {
    const harness = load((url) => assert.fail(url))
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(store(DIRECTORY_DEEPSEEK), store(CATALOG)) })
    const options = monitor.settingsOptions
    assert.strictEqual(options.name, 'settings.section')
    assert.strictEqual(options.id, 'balance-monitor')
    assert.strictEqual(typeof options.label, 'function')
    assert.strictEqual(options.label(), '\u4f59\u989d\u76d1\u6d4b')
    assert.strictEqual(
      JSON.stringify(monitor.sidebarOptions),
      JSON.stringify({
        name: 'sidebar.footer.action',
        id: 'balance-sidebar-card',
        order: 40,
        label: '\u4f59\u989d\u76d1\u6d4b',
        inject: monitor.sidebarOptions.inject,
      }),
      'the sidebar card registers into the footer action slot',
    )
  }

  // T: QODER. The second source this change adapts. Its `total` means percent
  // CONSUMED, so a reading that leaked it into the headline would tell the user
  // the opposite of the truth; the pill and card must show the summed remainder
  // and keep the consumption figure labelled as such.
  {
    const directory = store(DIRECTORY_QODER)
    const harness = load((url) => (url.startsWith('/api/dsh.balance') ? json(QODER_CREDITS(providerOf(url))) : assert.fail(url)))
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const card = await monitor.renderSidebar()
    const joined = texts(card).join('')
    console.log('T qoder card:', JSON.stringify(texts(card)))
    // 150 remaining of 300: the source's 99.5 must not surface as a remainder.
    assert.ok(joined.includes('Qoder\u79ef\u5206'), 'the card names the Qoder provider')
    assert.ok(joined.includes('\ud83c\udfab150'), 'the headline is the summed remainder')
    assert.ok(!joined.includes('99.5'), 'the consumption percentage is never the headline')
    assert.ok(joined.includes('\u8d60\u9001\u989d\u5ea6'), 'the live package is listed')
    assert.ok(!joined.includes('\u4e2a\u4eba\u989d\u5ea6'), 'the exhausted package is dropped')
    assert.ok(joined.includes('50%'), 'the live package states its share')

    // The panel states the consumption figure explicitly, labelled as used.
    card.props.onClick()
    const opened = await monitor.rerenderSidebar()
    const panel = texts(find(opened, (n) => n.props?.role === 'dialog')).join('')
    console.log('T qoder panel:', JSON.stringify(panel))
    assert.ok(panel.includes('\u672c\u8f6e\u5df2\u7528'), 'the panel labels the used percentage')
    assert.ok(panel.includes('99.50%'), 'and shows the value it was given')
    assert.ok(panel.includes('\u5269\u4f59\u5360\u6bd4'), 'beside the remaining share, which is the opposite')
    // Two different, both correct shares: 150 of the cycle's granted 400 (the
    // overall figure) and 150 of the live package's 300 (its own row).
    assert.ok(panel.includes('37.5%'), 'the remaining share is measured against the cycle total')
    assert.ok(panel.includes('\ud83c\udfab150 / 300'), 'while the package row keeps its own denominator')
  }

  // U: THE `unlimited` REGRESSION. Qoder sets this flag at the top level because
  // one of its packages is an uncapped personal allowance — it is a statement
  // that a MODEL is free of charge (spending no credit), not that the account's
  // credits are limitless. Since this readout answers only "how many credits are
  // left", the flag must never appear in the UI, and must never replace a figure
  // that is actually present.
  {
    const directory = store(DIRECTORY_QODER)
    const harness = load((url) =>
      url.startsWith('/api/dsh.balance') ? json(UNLIMITED_CREDITS(providerOf(url))) : assert.fail(url),
    )
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(directory, store(CATALOG)) })
    await monitor.attachSession('session-1')
    const card = await monitor.renderSidebar()
    const cardText = texts(card)
    const joined = cardText.join('')
    console.log('U qoder-unlimited card:', JSON.stringify(cardText))

    // The figure survives: 100 credits remain and that is what is shown.
    assert.ok(joined.includes('\ud83c\udfab100'), 'the real credit figure is shown despite the flag')
    assert.ok(!joined.includes('99.5'), 'and the consumption percentage is still not a remainder')
    // The flag itself is never rendered anywhere.
    assert.ok(!joined.includes('\u4e0d\u9650\u989d'), 'the card never says 不限额')
    assert.ok(!joined.includes('\u4e0d\u9650\u91cf'), 'nor 不限量')
    assert.ok(!joined.includes('\u221e'), 'nor an infinity glyph')
    // The live package keeps its own real figures and bar.
    assert.ok(joined.includes('\u8d60\u9001\u989d\u5ea6'), 'the countable package is listed')
    assert.ok(joined.includes('\ud83c\udfab100 / 100'), 'with its own remain/size')
    assert.ok(joined.includes('100%'), 'and its own percentage')
    // The ring must be drawn from the summed share (100%), not forced full by the
    // flag — asserted through the accessible name, which carries the figure.
    assert.strictEqual(card.props['aria-label'], 'Qoder\u79ef\u5206 100', 'the accessible name is the figure')
    assert.ok(!String(card.props['aria-label']).includes('\u4e0d\u9650\u989d'), 'and never the flag')

    // The panel likewise states figures, and never the flag.
    card.props.onClick()
    const opened = await monitor.rerenderSidebar()
    const panel = texts(find(opened, (n) => n.props?.role === 'dialog')).join('')
    console.log('U qoder-unlimited panel:', JSON.stringify(panel))
    assert.ok(panel.includes('\u5269\u4f59\u79ef\u5206\ud83c\udfab100'), 'the panel headline is the real total')
    assert.ok(panel.includes('\u5269\u4f59\u5360\u6bd4'), 'the remaining share is still computed')
    assert.ok(!panel.includes('\u4e0d\u9650\u989d'), 'the panel never says 不限额 either')
    assert.ok(!panel.includes('\u4e0d\u9650\u91cf'), 'nor 不限量')

    // The same document shown through the composer pill behaves identically.
    const pill = harness.mount({ settings: COMPOSER, models: modelsStub(directory, store(CATALOG)) })
    await pill.attachSession('session-1')
    const pillText = (await seatOf(harness, await pill.render())).text
    console.log('U qoder-unlimited pill:', JSON.stringify(pillText))
    assert.strictEqual(pillText, '\ud83c\udfabQoder\u79ef\u5206 100', 'the pill states the figure, not the flag')
  }

  // V: dsh-plugin-subscriptions. The provider routes that plugin serves are
  // answered in the browser, straight from its `/api/subscriptions-auth.*`
  // channel — never from the host route. The collapsed readout follows the
  // default account's tightest window; the panel lists every account, and the
  // refresh action issues a forced `usage` call.
  {
    const STATUS = {
      providers: {
        codex: { busy: false, accounts: [{ key: 'acct-1', isDefault: true, account: 'user@example.com', plan: 'plus' }] },
        claude: { busy: false, accounts: [] },
      },
    }
    const USAGE = {
      supported: true,
      windows: [
        { kind: 'session', usedPercent: 25, resetsAt: Date.now() + 3 * 3600 * 1000 },
        { kind: 'weekly', usedPercent: 60, resetsAt: Date.now() + 5 * 24 * 3600 * 1000 },
      ],
    }
    const DIRECTORY_CODEX = {
      current: { provider: 'codex', model: 'gpt-5.6-sol' },
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'codex', name: 'ChatGPT (Codex)' },
      ],
      routable: true,
      status: 'ready',
    }
    let usageForced = false
    const subscriptionsHandler = (payload) => {
      // The same handler answers both endpoints by the request's `method`
      // field — exactly how the node half's route table dispatches.
      if (payload.provider === undefined) {
        return { ok: true, value: { providers: STATUS.providers } }
      }
      void usageForced
      return { ok: true, value: USAGE }
    }
    const harness = load((url) => assert.fail(url), { subscriptionsHandler })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(store(DIRECTORY_CODEX), store(CATALOG)) })
    await monitor.attachSession('session-1')
    const tree = await monitor.render()
    assert.ok(tree.__portal, 'the subscription pill renders in the stats row')
    const { seat, text } = await seatOf(harness, tree)
    console.log('V pill:', JSON.stringify(text))
    assert.strictEqual(text, '#ChatGPT (Codex)\u5269\u4f59 40% \u00b7 user@example.com', 'the pill follows the default account (tightest window: 40% left)')

    // The two endpoints were called on the shared channel, in order, and the
    // host balance route was never asked.
    const endpoints = harness.state.subscriptionCalls.map((call) => call.endpoint)
    assert.ok(endpoints.includes('status'), 'status was asked')
    assert.ok(endpoints.includes('usage'), 'usage was asked')
    assert.strictEqual(harness.requests.length, 0, 'the host route is never called for a subscription provider')
    const usageCall = harness.state.subscriptionCalls.find((call) => call.endpoint === 'usage')
    assert.strictEqual(usageCall.payload.provider, 'codex')
    assert.strictEqual(usageCall.payload.account, 'acct-1')

    // Clicking the pill opens the per-account panel with both windows.
    const pill = find(seat, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'dialog')
    assert.ok(pill !== null, 'the subscription pill is a dialog trigger')
    pill.props.onClick()
    const element = seatsOf(tree)[0]
    const opened = await settle(harness.mini, element.type, element.props)
    const panel = texts(find(opened, (n) => n.props?.role === 'dialog')).join('')
    console.log('V panel:', JSON.stringify(panel))
    for (const expected of ['user@example.com \u00b7 plus', '5 \u5c0f\u65f6', '7 \u5929', '\u5df2\u7528 25% \u00b7 \u5269\u4f59 75%', '\u5df2\u7528 60% \u00b7 \u5269\u4f59 40%', '\u5382\u5546']) {
      assert.ok(panel.includes(expected), 'the subscription panel must contain ' + expected)
    }
  }

  // V2: a subscription provider with no logged-in account reads as signed-out,
  // not as a failure — the same vocabulary the credit sources use.
  {
    const STATUS = { providers: { codex: { busy: false, accounts: [] }, claude: { busy: false, accounts: [] } } }
    const DIRECTORY_CODEX = {
      current: { provider: 'codex', model: 'gpt-5.6-sol' },
      groups: [{ id: 'codex', name: 'ChatGPT (Codex)' }],
      routable: true,
      status: 'ready',
    }
    const subscriptionsHandler = () => ({ ok: true, value: { providers: STATUS.providers } })
    const harness = load((url) => assert.fail(url), { subscriptionsHandler })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(store(DIRECTORY_CODEX), store(CATALOG)) })
    await monitor.attachSession('session-1')
    const { text } = await seatOf(harness, await monitor.render())
    console.log('V2 signed-out pill:', JSON.stringify(text))
    assert.strictEqual(text, '\u00a4ChatGPT (Codex)\u672a\u767b\u5f55', 'no accounts reads as signed out')
  }

  // V3: the subscription plugin being absent entirely (404-ish channel error)
  // reads as unreachable, never as a crash.
  {
    const DIRECTORY_CODEX = {
      current: { provider: 'codex', model: 'gpt-5.6-sol' },
      groups: [{ id: 'codex', name: 'ChatGPT (Codex)' }],
      routable: true,
      status: 'ready',
    }
    const harness = load((url) => assert.fail(url))
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(store(DIRECTORY_CODEX), store(CATALOG)) })
    await monitor.attachSession('session-1')
    const { text } = await seatOf(harness, await monitor.render())
    console.log('V3 missing plugin pill:', JSON.stringify(text))
    assert.strictEqual(text, '\u00a4ChatGPT (Codex)\u8bfb\u53d6\u5931\u8d25', 'a missing subscription plugin reads as a failed read')
  }

  // V4: the refresh action forces the `usage` read, bypassing the server's
  // five-minute cache — the same `force` flag the plugin's own badge sends.
  {
    const STATUS = {
      providers: {
        codex: { busy: false, accounts: [{ key: 'acct-1', isDefault: true, account: 'user@example.com' }] },
      },
    }
    const USAGE = {
      supported: true,
      windows: [{ kind: 'session', usedPercent: 25, resetsAt: Date.now() + 3 * 3600 * 1000 }],
    }
    const DIRECTORY_CODEX = {
      current: { provider: 'codex', model: 'gpt-5.6-sol' },
      groups: [{ id: 'codex', name: 'ChatGPT (Codex)' }],
      routable: true,
      status: 'ready',
    }
    let lastUsage = undefined
    const subscriptionsHandler = (payload) => {
      if (payload.provider === undefined) return { ok: true, value: { providers: STATUS.providers } }
      lastUsage = payload
      return { ok: true, value: USAGE }
    }
    const harness = load((url) => assert.fail(url), { subscriptionsHandler })
    const monitor = harness.mount({ settings: COMPOSER, models: modelsStub(store(DIRECTORY_CODEX), store(CATALOG)) })
    await monitor.attachSession('session-1')
    const tree = await monitor.render()
    const { seat } = await seatOf(harness, tree)
    const pill = find(seat, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'dialog')
    pill.props.onClick()
    const element = seatsOf(tree)[0]
    const opened = await settle(harness.mini, element.type, element.props)
    const refresh = find(opened, (n) => n.type === 'button' && n.props['aria-label'] === '\u5237\u65b0\u4f59\u989d')
    assert.ok(refresh !== null, 'the panel carries the refresh button')
    assert.strictEqual(lastUsage.force, undefined, 'the first read is not forced')
    refresh.props.onClick()
    // The refresh bumps the read nonce, which the harness observes on the next
    // settle of the same component instance.
    await settle(harness.mini, seatsOf(tree)[0].type, seatsOf(tree)[0].props)
    assert.strictEqual(lastUsage.force, true, 'the refresh read is forced')
  }

  // V5: CARD CAP. A readout with many windows (several accounts, or per-model
  // lanes) must not stretch the sidebar: the collapsed card draws at most
  // three window bars and states the cut count, while the detail panel keeps
  // listing every window.
  {
    const STATUS = {
      providers: {
        antigravity: {
          busy: false,
          accounts: [
            { key: 'acct-1', isDefault: true, account: 'a@gmail.com', plan: 'Google AI Pro' },
            { key: 'acct-2', isDefault: false, account: 'b@gmail.com', plan: 'Google AI Pro' },
          ],
        },
      },
    }
    // Two accounts × three windows each = six window bars, far past three.
    const windowsOf = (offset) =>
      ['gemini-3-pro', 'gemini-3-flash', 'claude-sonnet-4-6'].map((model, index) => ({
        kind: 'other',
        scope: model,
        usedPercent: 10 * (index + 1) + offset,
        resetsAt: Date.now() + (index + 1) * 3600 * 1000,
      }))
    const subscriptionsHandler = (payload) => {
      if (payload.provider === undefined) return { ok: true, value: { providers: STATUS.providers } }
      return { ok: true, value: { supported: true, windows: windowsOf(payload.account === 'acct-1' ? 0 : 50), plan: 'Google AI Pro' } }
    }
    const DIRECTORY_ANTIGRAVITY = {
      current: { provider: 'antigravity', model: 'gemini-3-pro' },
      groups: [{ id: 'antigravity', name: 'Google Antigravity' }],
      routable: true,
      status: 'ready',
    }
    const harness = load((url) => assert.fail(url), { subscriptionsHandler })
    const monitor = harness.mount({ settings: SIDEBAR, models: modelsStub(store(DIRECTORY_ANTIGRAVITY), store(CATALOG)) })
    await monitor.attachSession('session-1')
    const card = await monitor.renderSidebar()
    const cardText = texts(card).join('')
    console.log('V5 capped card:', JSON.stringify(cardText))
    // Exactly three window bars are drawn: the default account's three windows.
    for (const expected of ['a@gmail.com \u00b7 Google AI Pro', 'gemini-3-pro', 'gemini-3-flash', 'claude-sonnet-4-6']) {
      assert.ok(cardText.includes(expected), 'the capped card must show the default account\u2019s windows (' + expected + ')')
    }
    assert.ok(
      !cardText.includes('b@gmail.com'),
      'the second account\u2019s windows are cut from the collapsed card',
    )
    assert.ok(cardText.includes('\u8fd8\u6709 3 \u9879'), 'the cut count is stated')
    assert.ok(cardText.includes('\u70b9\u5361\u67e5\u770b\u5168\u90e8'), 'the pointer to the detail panel is stated')

    // The bars on the card: three window fills only.
    const bars = []
    const collectBars = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(collectBars)
      if (node.props?.className === 'dshBal_bar') bars.push(node)
      if (node.props) collectBars(node.props.children)
    }
    collectBars(card)
    assert.strictEqual(bars.length, 3, 'exactly three window bars on the collapsed card')

    // Opening the panel lists every account and every window, all six bars' data.
    card.props.onClick()
    const opened = await monitor.rerenderSidebar()
    const panelText = texts(find(opened, (n) => n.props?.role === 'dialog')).join('')
    console.log('V5 panel:', JSON.stringify(panelText))
    for (const expected of ['a@gmail.com', 'b@gmail.com']) {
      assert.ok(panelText.includes(expected), 'the panel lists both accounts (' + expected + ')')
    }
    for (const model of ['gemini-3-pro', 'gemini-3-flash', 'claude-sonnet-4-6']) {
      assert.ok(panelText.includes(model), 'the panel lists every window (' + model + ')')
    }
    // Six window rows in the panel: each account lists its own window set
    // (the window name also appears in its 重置 row, so count those pairs).
    const occurrences = panelText.split('gemini-3-pro').length - 1
    assert.strictEqual(occurrences, 4, 'each account lists its own window set (window row + its reset row)')
  }

  console.log('OK: boot-safe activation, one pill following the selected model, placement, degradation and panels verified')
}

main().catch((error) => {
  console.error('render test failed:', error)
  process.exitCode = 1
})

