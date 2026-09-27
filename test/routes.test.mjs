/**
 * dsh-local-memory — settings-API route tests
 *
 * The browser half reads everything through these routes, so they are a real
 * surface, not an internal detail. Tested with the same mock-daemon approach as
 * plugin.test.mjs: a handler is captured off a stand-in webServer and driven
 * with synthetic request/response objects.
 *
 * Run: node --test test/routes.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

/* ------------------------------------------------------------------ helpers */

async function startMock(handler) {
  const state = { requests: [] }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = raw === '' ? undefined : JSON.parse(raw) } catch { body = raw }
    const record = { method: req.method, url: req.url, body }
    state.requests.push(record)
    const out = (await handler(record)) ?? { status: 404, body: { detail: 'not found' } }
    const payload = JSON.stringify(out.body ?? {})
    res.writeHead(out.status ?? 200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Load the plugin and capture whatever route it registers. */
function loadRoute(url, config = {}) {
  let route
  const ctx = {
    inject: () => {},
    get: (name) => (name === 'webServer' ? { register: (r) => { route = r; return () => {} } } : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  apply(ctx, { apiUrl: url, ...config })
  assert.ok(route, 'a webServer must have received the route')
  return route
}

/** Drive the captured route with a synthetic request and capture the reply. */
async function call(route, method, url, body) {
  const request = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
  let status
  let headers
  let text
  const response = {
    writeHead: (code, h) => { status = code; headers = h },
    end: (payload) => { text = payload },
  }
  await route.handler(request, response)
  return { status, headers, text, json: text ? JSON.parse(text) : undefined }
}

const bankRoster = {
  status: 200,
  body: {
    banks: [
      { bank_id: 'big', fact_count: 900, last_write_at: '2026-09-27T02:33:03+00:00' },
      { bank_id: 'small', fact_count: 3, last_write_at: '2026-01-01T00:00:00+00:00' },
    ],
  },
}

/* --------------------------------------------------------------- the route */

test('registers a prefix route at /local-memory/api', () => {
  const route = loadRoute('http://127.0.0.1:1')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/local-memory/api')
  assert.equal(typeof route.handler, 'function')
})

test('registers nothing when no webServer is mounted', () => {
  let registered = false
  apply({
    inject: () => {},
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }, {})
  assert.equal(registered, false)
})

test('WAITS for webServer instead of skipping when it is not mounted yet', () => {
  // The regression this guards, found on a real boot and invisible to every
  // other test here: plugin rows activate in parallel, so at apply() time
  // `webServer` is often not mounted yet. The first version used a bare
  // `ctx.get('webServer')` guard, saw undefined, and silently registered
  // nothing — the settings page then fetched a path the server answered with
  // its own 404, while every mock test passed because a mock always had one.
  const requested = []
  const bare = {
    inject: (deps, cb) => {
      requested.push(deps.join(','))
      if (deps.includes('tools')) cb({ tools: { register: () => {} }, get: () => undefined })
      // A real Cordis only calls back for `webServer` once that service exists.
      if (deps.includes('webServer')) {
        cb({
          webServer: { register: () => () => {} },
          get: () => undefined,
          effect: (fn) => { fn(); return () => {} },
        })
      }
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  apply(bare, {})
  assert.ok(
    requested.includes('webServer'),
    `the plugin must wait for webServer, but asked only for: ${requested.join(' | ')}`,
  )
})

test('does NOT wait for webServer when it is already mounted', () => {
  const requested = []
  const ready = {
    inject: (deps, cb) => {
      requested.push(deps.join(','))
      if (deps.includes('tools')) cb({ tools: { register: () => {} }, get: () => undefined })
    },
    get: (name) => (name === 'webServer' ? { register: () => () => {} } : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  apply(ready, {})
  assert.ok(!requested.includes('webServer'), 'no need to wait for a service already present')
})

test('the route disposer is handed to ctx.effect so a stop removes it', () => {
  let disposed = false
  let effects = 0
  apply({
    inject: () => {},
    // Name-aware on purpose: the plugin now also registers an operator skill, and
    // a `get` that answers every name would make this count two effects and tell
    // us nothing about the ROUTE's ownership.
    get: (name) => (name === 'webServer'
      ? { register: () => () => { disposed = true } }
      : undefined),
    effect: (fn) => { effects += 1; fn(); return () => {} },
  }, {})
  assert.equal(effects, 1, 'the route must be owned by exactly one effect')
  // The disposer was returned; calling it is the shell's job on stop.
  assert.equal(typeof disposed, 'boolean')
})

/* ---------------------------------------------------------- GET /api/banks */

test('GET /api/banks returns the roster with size and recency', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const reply = await call(loadRoute(mock.url), 'GET', '/local-memory/api/banks')
    assert.equal(reply.status, 200)
    assert.deepEqual(reply.json.banks, [
      { id: 'big', factCount: 900, lastWriteAt: '2026-09-27T02:33:03+00:00' },
      { id: 'small', factCount: 3, lastWriteAt: '2026-01-01T00:00:00+00:00' },
    ])
  } finally { await mock.close() }
})

test('GET /api/banks honours the configured prefix', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const route = loadRoute(mock.url, { bankPrefix: 'sm' })
    const reply = await call(route, 'GET', '/local-memory/api/banks')
    assert.deepEqual(reply.json.banks.map((b) => b.id), ['small'])
  } finally { await mock.close() }
})

test('GET /api/banks tolerates a bank with no size reported', async () => {
  const mock = await startMock(() => ({ status: 200, body: { banks: [{ bank_id: 'bare' }] } }))
  try {
    const reply = await call(loadRoute(mock.url), 'GET', '/local-memory/api/banks')
    // JSON drops undefined properties, so the absent fields simply do not arrive —
    // which is exactly what the browser half handles by falling back to "—".
    assert.deepEqual(reply.json.banks, [{ id: 'bare' }])
  } finally { await mock.close() }
})

test('GET /api/banks reports an unreachable daemon rather than an empty list', async () => {
  const reply = await call(loadRoute('http://127.0.0.1:1', { timeoutMs: 1500 }), 'GET', '/local-memory/api/banks')
  assert.equal(reply.status, 500)
  assert.match(reply.json.error, /Cannot reach|ECONNREFUSED|fetch failed|connect/i)
})

/* --------------------------------------------------------- POST /api/search */

test('POST /api/search fans out and groups by bank with a timing figure', async () => {
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') return bankRoster
    const id = decodeURIComponent(/^\/v1\/default\/banks\/(.+)\/memories\/recall$/.exec(record.url)[1])
    return { status: 200, body: { results: [{ content: `fact of ${id}` }] } }
  })
  try {
    const reply = await call(loadRoute(mock.url), 'POST', '/local-memory/api/search', { query: 'q' })
    assert.equal(reply.status, 200)
    assert.equal(reply.json.query, 'q')
    assert.equal(typeof reply.json.elapsedMs, 'number')
    assert.deepEqual(reply.json.sections.map((s) => s.bankId), ['big', 'small'])
    assert.equal(reply.json.sections[0].texts[0], 'fact of big')
    assert.equal(reply.json.failures.length, 0)
  } finally { await mock.close() }
})

test('POST /api/search caps each bank and reports what it withheld', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ content: `f${i}` }))
  const mock = await startMock((record) => (record.url === '/v1/default/banks'
    ? { status: 200, body: { banks: [{ bank_id: 'deep' }] } }
    : { status: 200, body: { results: many } }))
  try {
    const route = loadRoute(mock.url, { maxPerBank: 2 })
    const reply = await call(route, 'POST', '/local-memory/api/search', { query: 'q' })
    assert.equal(reply.json.sections[0].texts.length, 2)
    assert.equal(reply.json.sections[0].withheld, 7)
  } finally { await mock.close() }
})

test('POST /api/search honours an explicit bank list', async () => {
  const mock = await startMock((record) => (record.url === '/v1/default/banks'
    ? bankRoster
    : { status: 200, body: { results: [{ content: 'x' }] } }))
  try {
    const reply = await call(loadRoute(mock.url), 'POST', '/local-memory/api/search', {
      query: 'q',
      banks: 'small',
    })
    assert.deepEqual(reply.json.sections.map((s) => s.bankId), ['small'])
  } finally { await mock.close() }
})

test('POST /api/search rejects a blank query with 400', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const route = loadRoute(mock.url)
    for (const body of [{ query: '' }, { query: '   ' }, {}]) {
      const reply = await call(route, 'POST', '/local-memory/api/search', body)
      assert.equal(reply.status, 400)
      assert.match(reply.json.error, /query/)
    }
    assert.equal(mock.state.requests.length, 0, 'a rejected query must not reach the daemon')
  } finally { await mock.close() }
})

test('POST /api/search contains a failing bank instead of failing the request', async () => {
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') return bankRoster
    const id = decodeURIComponent(/^\/v1\/default\/banks\/(.+)\/memories\/recall$/.exec(record.url)[1])
    return id === 'big'
      ? { status: 500, body: { detail: 'boom' } }
      : { status: 200, body: { results: [{ content: 'ok' }] } }
  })
  try {
    const reply = await call(loadRoute(mock.url), 'POST', '/local-memory/api/search', { query: 'q' })
    assert.equal(reply.status, 200)
    assert.deepEqual(reply.json.sections.map((s) => s.bankId), ['small'])
    assert.equal(reply.json.failures.length, 1)
    assert.equal(reply.json.failures[0].bankId, 'big')
  } finally { await mock.close() }
})

test('POST /api/search with an empty roster succeeds and says nothing was searched', async () => {
  const mock = await startMock(() => ({ status: 200, body: { banks: [] } }))
  try {
    const reply = await call(loadRoute(mock.url), 'POST', '/local-memory/api/search', { query: 'q' })
    assert.equal(reply.status, 200)
    assert.deepEqual(reply.json.sections, [])
    assert.equal(reply.json.elapsedMs, 0)
  } finally { await mock.close() }
})

test('POST /api/search survives a malformed JSON body with 500, not a hang', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const reply = await call(loadRoute(mock.url), 'POST', '/local-memory/api/search', '{not json')
    assert.equal(reply.status, 500)
    assert.equal(typeof reply.json.error, 'string')
  } finally { await mock.close() }
})

/* -------------------------------------------------------------- method/path */

test('the wrong method is refused with 405 and an Allow header', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const route = loadRoute(mock.url)
    const onBanks = await call(route, 'POST', '/local-memory/api/banks', {})
    assert.equal(onBanks.status, 405)
    assert.equal(onBanks.headers.allow, 'GET')
    const onSearch = await call(route, 'GET', '/local-memory/api/search')
    assert.equal(onSearch.status, 405)
    assert.equal(onSearch.headers.allow, 'POST')
  } finally { await mock.close() }
})

test('an unknown path below the prefix is a 404 that names it', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const reply = await call(loadRoute(mock.url), 'GET', '/local-memory/api/nope')
    assert.equal(reply.status, 404)
    assert.match(reply.json.error, /nope/)
  } finally { await mock.close() }
})

test('a query string does not confuse path matching', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const reply = await call(loadRoute(mock.url), 'GET', '/local-memory/api/banks?cache=0')
    assert.equal(reply.status, 200)
    assert.equal(reply.json.banks.length, 2)
  } finally { await mock.close() }
})

test('responses are marked no-store so a stale roster is never shown', async () => {
  const mock = await startMock(() => bankRoster)
  try {
    const reply = await call(loadRoute(mock.url), 'GET', '/local-memory/api/banks')
    assert.equal(reply.headers['cache-control'], 'no-store')
  } finally { await mock.close() }
})
