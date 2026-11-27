// dsh-balance-card 2.0 — Host 半边测试。
//
// 覆盖：设置 schema/迁移、注册表别名、归一化读数、缓存退避与并发闸门、
// 厂商适配器（用 fetch 桩）、以及 v2 路由的凭据/设置行为。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCache } from '../lib/cache.js'
import { createCredentials, maskValue } from '../lib/credentials.js'
import { describeError } from '../lib/errors.js'
import { allVendors, vendorForRoute, vendorById } from '../lib/registry.js'
import { applySettingsPatch, migrateLegacySettings, normalizeCardSettings, normalizeSettings, readSettingsFile, defaultSettings, writeSettingsFile } from '../lib/settings.js'
import { maybeGenerateDigest, readDigest, readReport, recordSnapshot } from '../lib/report.js'
import { makeReading, percentReading, remainingFromUsed, round2, isoOf, currencyReading } from '../lib/parse.js'
import { queryVendor } from '../lib/vendors/index.js'
import { evaluate, pathValue } from '../lib/vendors/custom.js'
import { apply } from '../lib/index.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

/** 把一次 fetch 响应做成 requestJson 能消费的最小对象。 */
const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  body: { cancel: () => {} },
})

/** 在一个临时 DSH_HOME 里跑测试。 */
const withTempHome = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-balance-v2-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 记录请求并逐条回放 fetch 桩。 */
const stubFetch = (handler) => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => handler(String(url), init)
  return () => {
    globalThis.fetch = original
  }
}

/** 一个可读写的 DSH credentials 替身。 */
const credentialsStub = () => {
  const values = new Map()
  return {
    values,
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined
    },
    async describe(ref) {
      return { configured: values.has(ref), source: 'file', writable: true }
    },
    async set(ref, value) {
      values.set(ref, value)
    },
    async unset(ref) {
      values.delete(ref)
    },
  }
}

/** 建一个只收集路由的插件上下文。 */
const hostHarness = async (dir, options = {}) => {
  const routes = new Map()
  const credentials = credentialsStub()
  const connection = {
    fetch: {
      register: ({ path, methods, fetch }) => {
        routes.set(path, { methods, fetch })
      },
    },
  }
  const settingsRows = options.settingsRows ?? []
  const settingsService = { describe: () => settingsRows }
  const get = (name) => (name === 'settings' ? settingsService : undefined)
  const ctx = {
    credentials,
    connection,
    logger: { warn: () => {} },
    effect: () => {},
    get,
    inject: (services, callback) => callback({ credentials, connection, get }),
  }
  apply(ctx, { settingsFile: join(dir, 'balance-settings-v2.json'), timeoutMs: 5000 })
  return { routes, credentials }
}

const call = async (routes, path, init) => {
  const entry = routes.get(path)
  assert.ok(entry !== undefined, 'missing route ' + path)
  const request = new Request('http://127.0.0.1' + path, init)
  const answer = await entry.fetch(request)
  return { status: answer.status, body: await answer.json() }
}

test('default settings are valid and stable', () => {
  const settings = defaultSettings()
  assert.equal(settings.version, 2)
  assert.equal(settings.visualStyle, 'grid')
  assert.equal(settings.card.pollMs, 600000)
  assert.equal(settings.tools.qianfanThrottle.probePace, 'normal')
  assert.deepEqual(normalizeSettings(settings), settings)
})

test('settings patch merges vendors and rejects unknown fields', () => {
  const base = defaultSettings()
  const outcome = applySettingsPatch(base, {
    visualStyle: 'ring',
    vendors: { deepseek: { enabled: true, warnPercent: 15 } },
    tools: { qianfanThrottle: { probePace: 'conservative' } },
  })
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.next.visualStyle, 'ring')
  assert.equal(outcome.next.vendors.deepseek.enabled, true)
  assert.equal(outcome.next.vendors.deepseek.warnPercent, 15)
  assert.equal(outcome.next.tools.qianfanThrottle.probePace, 'conservative')
  // 未提供的字段保留默认值
  assert.equal(outcome.next.vendors.deepseek.pollMs, null)
  assert.equal(outcome.next.tools.qianfanThrottle.preset, 'mid')

  const bad = applySettingsPatch(base, { unknownField: 1 })
  assert.ok(typeof bad.error === 'string')

  const badVendor = applySettingsPatch(base, { vendors: { 'Bad Id': { enabled: true } } })
  assert.ok(typeof badVendor.error === 'string')
})

test('card normalization clamps out-of-range values', () => {
  const card = normalizeCardSettings({ pollMs: 1, warnPercent: 300, currencyStyle: 'nope' })
  assert.equal(card.pollMs, 15000)
  assert.equal(card.warnPercent, 100)
  assert.equal(card.currencyStyle, 'symbol')
})

test('legacy settings migrate to the final style ids and vendor ids', () => {
  const { settings, notes } = migrateLegacySettings(
    {
      placement: 'composer',
      visualStyle: 'instrument',
      accentColor: '#123456',
      pollMs: 30000,
      warnPercent: 25,
      showUpdatedAt: false,
      unitStyle: 'name',
      groupDigits: false,
      providers: { 'kimi-coding': false, deepseek: true, workbuddy: true, qoder: true },
      throttleEnabled: true,
      throttlePreset: 'high',
      throttleProbePace: 'rare',
      throttleManual: { low: { rpm: 1, tpm: 1000, concurrency: 1 } },
    },
    allVendors().map((vendor) => vendor.id),
  )
  assert.equal(settings.card.visible, true)
  assert.equal(settings.visualStyle, 'line')
  assert.equal(settings.accent, '#123456')
  assert.equal(settings.card.pollMs, 30000)
  assert.equal(settings.card.warnPercent, 25)
  assert.equal(settings.card.showUpdatedAt, false)
  assert.equal(settings.card.currencyStyle, 'symbol')
  assert.equal(settings.card.groupDigits, false)
  assert.equal(settings.vendors.kimi.enabled, false)
  assert.equal(settings.vendors.deepseek.enabled, true)
  assert.equal(settings.vendors.workbuddy, undefined)
  assert.equal(settings.vendors.qoder, undefined)
  assert.equal(settings.tools.qianfanThrottle.enabled, true)
  assert.equal(settings.tools.qianfanThrottle.preset, 'high')
  assert.equal(settings.tools.qianfanThrottle.probePace, 'rare')
  assert.ok(notes.length >= 1)
})

test('registry maps provider routes by exact alias and never guesses', () => {
  assert.equal(vendorForRoute('baiduqianfan'), 'baidu-qianfan')
  assert.equal(vendorForRoute('BAIDU'), 'baidu-qianfan')
  assert.equal(vendorForRoute('baiduqianfanlyq'), 'baidu-qianfan')
  assert.equal(vendorForRoute('baiduqianfan-utmotc'), 'baidu-qianfan')
  assert.equal(vendorForRoute('kimi'), 'kimi')
  assert.equal(vendorForRoute('moonshot'), 'kimi')
  assert.equal(vendorForRoute('zai'), 'zhipu')
  assert.equal(vendorForRoute('openrouter-pro'), 'openrouter')
  assert.equal(vendorForRoute('openrouter.pro'), undefined)
  assert.equal(vendorForRoute(''), undefined)
  assert.equal(allVendors().length, 23)
  assert.equal(vendorById('grok').status, 'unsupported')
  assert.equal(vendorById('copilot').status, 'unsupported')
  assert.equal(vendorById('deepseek').batch, 1)
  assert.equal(vendorById('mimo').batch, 2)
})

test('reading normalization computes remaining percent once', () => {
  const reading = makeReading({
    kind: 'credits',
    unit: '积分',
    remaining: 9642,
    total: 10000,
    used: 358,
    windows: [{ id: 'monthly', label: '月度', remaining: 9642, total: 10000, used: 358 }],
  })
  assert.equal(reading.percent, 96.42)
  assert.equal(reading.primary, 'monthly')
  assert.equal(reading.windows[0].percent, 96.42)
  assert.equal(remainingFromUsed(3.58), 96.42)
  assert.equal(round2(1.005), 1.01)
  assert.equal(isoOf(1700000000), new Date(1700000000000).toISOString())
  assert.equal(isoOf(''), '')
})

test('percent-only readings keep a drawable percent without inventing totals', () => {
  const reading = percentReading({
    windows: [{ id: 'five-hour', label: '5 小时', percent: 42.5, resetsAt: '' }],
    primary: 'five-hour',
    note: 'Claude',
  })
  assert.equal(reading.unit, '%')
  assert.equal(reading.remaining, 42.5)
  assert.equal(reading.total, 100)
  assert.equal(reading.used, 57.5)
  assert.equal(reading.percent, 42.5)
  assert.equal(reading.windows.length, 1)
})

test('deepseek adapter parses the balance document', async () => {
  const restore = stubFetch((url) => {
    assert.ok(url.endsWith('/user/balance'))
    return response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.50', granted_balance: '0', topped_up_balance: '88.50' }] })
  })
  try {
    const vendor = vendorById('deepseek')
    const reading = await queryVendor(vendor, { credentials: { key: 'sk-test' }, settings: {}, timeoutMs: 5000 })
    assert.equal(reading.kind, 'currency')
    assert.equal(reading.remaining, 88.5)
    assert.equal(reading.unit, '¥')
    assert.equal(reading.windows[0].id, 'balance')
  } finally {
    restore()
  }
})

test('unconfigured adapters throw the unconfigured code', async () => {
  const vendor = vendorById('deepseek')
  await assert.rejects(
    () => queryVendor(vendor, { credentials: {}, settings: {}, timeoutMs: 1000 }),
    (error) => error.code === 'unconfigured',
  )
})

test('kimi falls back from the coding endpoint to the PAYG balance', async () => {
  let calls = 0
  const restore = stubFetch((url) => {
    calls += 1
    if (url.includes('api.kimi.com')) return response({ error: 'unauthorized' }, 401)
    assert.ok(url.includes('api.moonshot.cn'))
    return response({ data: { available_balance: 12.34 } })
  })
  try {
    const reading = await queryVendor(vendorById('kimi'), {
      credentials: { key: 'sk-test' },
      settings: {},
      timeoutMs: 5000,
    })
    assert.equal(calls, 2)
    assert.equal(reading.kind, 'currency')
    assert.equal(reading.remaining, 12.34)
  } finally {
    restore()
  }
})

test('baidu console login failure is classified as expired', async () => {
  const restore = stubFetch(() => response({ code: 401, message: { redirect: true } }))
  try {
    await assert.rejects(
      () =>
        queryVendor(vendorById('baidu-qianfan'), {
          credentials: { cookie: 'a=b' },
          settings: {},
          timeoutMs: 5000,
        }),
      (error) => error.code === 'expired',
    )
  } finally {
    restore()
  }
})

test('custom adapter reads a JSON path and applies a one-variable expression', async () => {
  const restore = stubFetch(() => response({ data: { balance: 12345 } }))
  try {
    const reading = await queryVendor(vendorById('custom'), {
      credentials: {},
      settings: {
        advanced: { endpoint: 'https://example.com/balance', jsonPath: 'data.balance', expression: 'value / 100', unit: '¥' },
      },
      timeoutMs: 5000,
    })
    assert.equal(reading.remaining, 123.45)
    assert.equal(reading.kind, 'currency')
  } finally {
    restore()
  }
  assert.equal(pathValue({ a: [{ b: 2 }] }, 'a[0].b'), 2)
  assert.equal(evaluate('value * 2 + 1', 3), 7)
  assert.equal(evaluate('process.exit(1)', 1), undefined)
})

test('custom adapter rejects plain HTTP before any request', async () => {
  const restore = stubFetch(() => {
    throw new Error('must not be called')
  })
  try {
    await assert.rejects(
      () =>
        queryVendor(vendorById('custom'), {
          credentials: {},
          settings: { advanced: { endpoint: 'http://example.com/balance' } },
          timeoutMs: 5000,
        }),
      (error) => error.code === 'blocked',
    )
  } finally {
    restore()
  }
})

test('cache backs off after a failure and keeps the last good reading', async () => {
  let clock = 1000
  let calls = 0
  const cache = createCache({
    now: () => clock,
    fetchVendor: async () => {
      calls += 1
      if (calls === 1) return { remaining: 10 }
      const error = new Error('nope')
      error.code = 'network'
      throw error
    },
  })
  const plan = {
    vendor: { id: 'deepseek', status: 'stable' },
    enabled: true,
    configured: true,
    settings: { pollMs: null },
    globalPollMs: 60000,
  }
  let record = await cache.get(plan, { waitMs: 1000 })
  assert.equal(record.status, 'ok')
  assert.equal(record.reading.remaining, 10)
  clock += 600000
  record = await cache.get(plan, { force: true, waitMs: 1000 })
  assert.equal(record.status, 'stale')
  assert.equal(record.reading.remaining, 10)
  assert.ok(record.backoffMs > 0)
  // 退避期间不重复请求
  const before = calls
  await cache.get(plan, { waitMs: 0 })
  assert.equal(calls, before)
  await cache.settle()
})

test('cache gates concurrency at three', async () => {
  let running = 0
  let peak = 0
  const cache = createCache({
    concurrency: 3,
    fetchVendor: async (plan) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running -= 1
      return { id: plan.vendor.id, remaining: 1 }
    },
  })
  const plans = Array.from({ length: 8 }, (_, index) => ({
    vendor: { id: 'v' + index, status: 'stable' },
    enabled: true,
    configured: true,
    settings: { pollMs: null },
    globalPollMs: 60000,
  }))
  await Promise.all(plans.map((plan) => cache.get(plan, { waitMs: 1000 })))
  assert.equal(peak, 3)
  await cache.settle()
})

test('credentials wrapper never returns a raw secret in describeVendor', async () => {
  const vendor = vendorById('deepseek')
  const service = credentialsStub()
  const credentials = createCredentials(service)
  await service.set('DEEPSEEK_API_KEY', 'sk-super-secret-value')
  const state = await credentials.describeVendor(vendor)
  assert.equal(state.configured, true)
  assert.ok(!JSON.stringify(state).includes('sk-super-secret-value'))
  assert.equal(maskValue('sk-super-secret-value'), 'sk-sup••••••')
  const bundle = await credentials.bundleFor(vendor)
  assert.equal(bundle.key, 'sk-super-secret-value')
})

test('host routes answer settings, providers and snapshot without secrets', async () => {
  await withTempHome(async (dir) => {
    const { routes, credentials } = await hostHarness(dir)
    await credentials.set('DEEPSEEK_API_KEY', 'sk-hidden-value')
    await credentials.set('BAIDU_QIANFAN_COOKIE', 'session=hidden-cookie')

    const settingsGet = await call(routes, '/api/dsh-balance-card/v2/settings')
    assert.equal(settingsGet.status, 200)
    assert.equal(settingsGet.body.value.settings.visualStyle, 'grid')

    const patched = await call(routes, '/api/dsh-balance-card/v2/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visualStyle: 'ring' }),
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.value.settings.visualStyle, 'ring')
    assert.equal(readSettingsFile(join(dir, 'balance-settings-v2.json')).visualStyle, 'ring')

    const providers = await call(routes, '/api/dsh-balance-card/v2/providers')
    assert.equal(providers.status, 200)
    const deepseek = providers.body.value.vendors.find((row) => row.id === 'deepseek')
    assert.equal(deepseek.configured, true)
    assert.equal(deepseek.enabled, false)
    assert.ok(!JSON.stringify(providers.body).includes('sk-hidden-value'))
    assert.ok(!JSON.stringify(providers.body).includes('hidden-cookie'))

    const snapshot = await call(routes, '/api/dsh-balance-card/v2/snapshot')
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.body.value.version, '2.0.0')
    assert.ok(Array.isArray(snapshot.body.value.vendors))
    assert.ok(snapshot.body.value.meta.routeMap.deepseek === 'deepseek')
    assert.ok(Array.isArray(snapshot.body.value.meta.routePrefixes))
    assert.ok(snapshot.body.value.meta.routePrefixes.some((entry) => entry[0] === 'baiduqianfan' && entry[1] === 'baidu-qianfan'))
    assert.ok(!JSON.stringify(snapshot.body).includes('sk-hidden-value'))
  })
})

test('host credential route saves, tests and clears without echoing the value', async () => {
  await withTempHome(async (dir) => {
    const { routes, credentials } = await hostHarness(dir)
    const restore = stubFetch(() =>
      response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] }),
    )
    try {
      const saved = await call(routes, '/api/dsh-balance-card/v2/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vendorId: 'deepseek', field: 'key', value: 'sk-new-secret' }),
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.value.credential.configured, true)
      assert.ok(!JSON.stringify(saved.body).includes('sk-new-secret'))
      assert.equal(credentials.values.get('DEEPSEEK_API_KEY'), 'sk-new-secret')

      const tested = await call(routes, '/api/dsh-balance-card/v2/credentials/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vendorId: 'deepseek' }),
      })
      assert.equal(tested.status, 200)
      assert.equal(tested.body.value.reachable, true)
      assert.equal(tested.body.value.reading.remaining, 5)

      const cleared = await call(routes, '/api/dsh-balance-card/v2/credentials/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vendorId: 'deepseek', field: 'key' }),
      })
      assert.equal(cleared.status, 200)
      assert.equal(cleared.body.value.credential.configured, false)
    } finally {
      restore()
    }
  })
})

test('host reuses the official provider API key when the vendor accepts the same credential', async () => {
  await withTempHome(async (dir) => {
    const { routes, credentials } = await hostHarness(dir, {
      settingsRows: [
        {
          ns: 'llm-pi-ai',
          value: { providers: { 'deepseek-custom': { apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' } } },
        },
      ],
    })
    await credentials.set('CUSTOM_DEEPSEEK_KEY', 'sk-from-dsh')
    const providers = await call(routes, '/api/dsh-balance-card/v2/providers')
    const deepseek = providers.body.value.vendors.find((row) => row.id === 'deepseek')
    assert.equal(deepseek.configured, true)
    assert.equal(deepseek.credentialFields[0].external, true)
    assert.ok(!JSON.stringify(providers.body).includes('sk-from-dsh'))

    const restore = stubFetch((url, init) => {
      assert.ok(url.endsWith('/user/balance'))
      assert.equal(init.headers.authorization, 'Bearer sk-from-dsh')
      return response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '3.50' }] })
    })
    try {
      const tested = await call(routes, '/api/dsh-balance-card/v2/credentials/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vendorId: 'deepseek' }),
      })
      assert.equal(tested.status, 200)
      assert.equal(tested.body.value.reachable, true)
      assert.equal(tested.body.value.reading.remaining, 3.5)
    } finally {
      restore()
    }
  })
})

test('host rejects unknown fields and invalid credentials', async () => {
  await withTempHome(async (dir) => {
    const { routes } = await hostHarness(dir)
    const bad = await call(routes, '/api/dsh-balance-card/v2/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    })
    assert.equal(bad.status, 400)
    const empty = await call(routes, '/api/dsh-balance-card/v2/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendorId: 'deepseek', field: 'key', value: '   ' }),
    })
    assert.equal(empty.status, 400)
  })
})

test('error classification is stable and advice-bearing', () => {
  const expired = describeError(Object.assign(new Error('登录已过期'), { code: 'expired' }))
  assert.equal(expired.code, 'expired')
  assert.ok(expired.advice.includes('Cookie'))
  const network = describeError(new Error('boom'))
  assert.equal(network.code, 'network')
  assert.ok(network.message.length > 0)
})

test('minimax continues past a moved endpoint (404) to the next official host', async () => {
  let calls = 0
  const restore = stubFetch((url) => {
    calls += 1
    if (url.includes('www.minimax.cn')) return response({}, 404)
    if (url.includes('www.minimaxi.com')) {
      return response({
        data: {
          model_remains: [
            { model_name: 'general', current_interval_remaining_percent: 80, current_weekly_remaining_percent: 60 },
          ],
        },
      })
    }
    return response({}, 404)
  })
  try {
    const reading = await queryVendor(vendorById('minimax'), {
      credentials: { key: 'sk-test' },
      settings: {},
      timeoutMs: 5000,
    })
    assert.ok(calls >= 2)
    assert.equal(reading.unit, '%')
    assert.equal(reading.percent, 80)
    assert.equal(reading.windows.length, 2)
  } finally {
    restore()
  }
})

test('a console redirect is classified as an expired login, not a network failure', async () => {
  const restore = stubFetch(() => response({}, 302))
  try {
    await assert.rejects(
      () =>
        queryVendor(vendorById('baidu-qianfan'), {
          credentials: { cookie: 'a=b' },
          settings: {},
          timeoutMs: 5000,
        }),
      (error) => error.code === 'expired',
    )
  } finally {
    restore()
  }
})

test('daily report records consumption and generates one digest after the configured time', async () => {
  await withTempHome(async (dir) => {
    const file = join(dir, 'daily-usage.json')
    const day = Date.parse('2026-12-01T10:00:00+08:00')
    recordSnapshot(file, { deepseek: { status: 'ok', reading: { remaining: 100, unit: '¥' } } }, day)
    recordSnapshot(file, { deepseek: { status: 'ok', reading: { remaining: 80, unit: '¥' } } }, day + 3_600_000)
    const days = readReport(file)
    assert.equal(days[0].date, '2026-12-01')
    assert.equal(days[0].vendors[0].consumed, 20)

    const before = maybeGenerateDigest(file, { enabled: true, time: '09:00' }, Date.parse('2026-12-02T08:00:00+08:00'))
    assert.equal(before, false)
    const generated = maybeGenerateDigest(file, { enabled: true, time: '09:00' }, Date.parse('2026-12-02T09:30:00+08:00'))
    assert.equal(generated, true)
    const digest = readDigest(file)
    assert.equal(digest.date, '2026-12-01')
    assert.equal(digest.vendors[0].consumed, 20)
    // 同一天只生成一次
    assert.equal(maybeGenerateDigest(file, { enabled: true, time: '09:00' }, Date.parse('2026-12-02T10:00:00+08:00')), false)
  })
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
  process.exit(0)
})()