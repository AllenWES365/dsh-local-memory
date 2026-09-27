/**
 * dsh-local-memory — stress tests
 *
 * Kept apart from plugin.test.mjs because these are about scale and duration,
 * not correctness of a single behaviour. Every one runs against the mock
 * daemon, so a failure here means the plugin degrades under load, not that the
 * machine is busy.
 *
 * Run: node --test test/stress.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

async function startMock(handler) {
  const state = { inflight: 0, maxInflight: 0, served: 0 }
  const server = createServer(async (req, res) => {
    state.inflight += 1
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    state.served += 1
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = raw === '' ? undefined : JSON.parse(raw) } catch { body = raw }
    try {
      const out = await handler({ method: req.method, url: req.url, body })
      const payload = JSON.stringify(out.body ?? {})
      res.writeHead(out.status ?? 200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    } finally {
      state.inflight -= 1
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function loadTools(url, config = {}) {
  const registered = []
  apply(
    { inject: (_deps, cb) => cb({ tools: { register: (def) => registered.push(def) } }), get: (n) => (n === 'webServer' ? { register: () => () => {} } : undefined), effect: (fn) => { fn(); return () => {} } },
    { apiUrl: url, ...config },
  )
  return {
    banks: registered.find((t) => t.name === 'memory_banks'),
    recall: registered.find((t) => t.name === 'memory_recall_all'),
  }
}

const bankIdOf = (url) => decodeURIComponent(/^\/v1\/default\/banks\/(.+)\/memories\/recall$/.exec(url)[1])

/* ------------------------------------------------------------------- scale */

test('scale: 500 banks — every bank is searched exactly once', async () => {
  const ids = Array.from({ length: 500 }, (_, i) => `coding-agent::p${String(i).padStart(3, '0')}`)
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
    return { status: 200, body: { results: [{ content: 'one fact' }] } }
  })
  try {
    const { recall } = loadTools(mock.url, { concurrency: 8, maxPerBank: 5 })
    const started = Date.now()
    const out = await recall.execute({ query: 'anything' })
    const elapsed = Date.now() - started

    assert.match(out, /Searched 500 bank\(s\)/)
    assert.equal(out.split('\n').filter((l) => l.startsWith('## ')).length, 500)
    assert.equal(mock.state.served, 501, '1 roster call + 500 recalls, no duplicates')
    assert.ok(mock.state.maxInflight <= 8, `concurrency breached: ${mock.state.maxInflight}`)
    console.log(`      [500 banks] ${elapsed}ms, peak concurrency ${mock.state.maxInflight}/8`)
  } finally { await mock.close() }
})

test('scale: 500 banks, half of them failing, still reports the healthy half', async () => {
  const ids = Array.from({ length: 500 }, (_, i) => `b${i}`)
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    const index = Number(bankIdOf(record.url).slice(1))
    if (index % 2 === 0) return { status: 500, body: { detail: 'deliberate failure' } }
    return { status: 200, body: { results: [{ content: `ok ${index}` }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.equal(out.split('\n').filter((l) => l.startsWith('## ')).length, 250, '250 healthy banks')
    assert.equal(
      out.split('\n').filter((l) => /^- b\d+: /.test(l)).length,
      250,
      '250 failures listed',
    )
  } finally { await mock.close() }
})

test('scale: every bank failing produces a report, not a crash', async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `b${i}`)
  const mock = await startMock((record) => (record.url === '/v1/default/banks'
    ? { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    : { status: 503, body: { detail: 'down' } }))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /No bank returned a match/)
    assert.match(out, /Unreachable banks:/)
  } finally { await mock.close() }
})

test('scale: one bank returning 500 hits is capped, not concatenated', async () => {
  const huge = Array.from({ length: 500 }, (_, i) => ({ content: `hit ${i}` }))
  const mock = await startMock((record) => (record.url === '/v1/default/banks'
    ? { status: 200, body: { banks: [{ bank_id: 'huge' }] } }
    : { status: 200, body: { results: huge } }))
  try {
    const { recall } = loadTools(mock.url, { maxPerBank: 5 })
    const out = await recall.execute({ query: 'q' })
    assert.equal(out.split('\n').filter((l) => l.startsWith('- hit')).length, 5)
    assert.match(out, /… 495 more in this bank/)
    assert.ok(out.length < 2000, `output should stay small, was ${out.length} chars`)
  } finally { await mock.close() }
})

/* ------------------------------------------------------------- concurrency */

test('concurrency: 20 simultaneous tool calls stay independent', async () => {
  const ids = ['a', 'b', 'c', 'd']
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Delimit the marker on both sides: a bare "|q1" would also match "|q10",
    // which would make this assertion fire on a correct implementation.
    return { status: 200, body: { results: [{ content: `|${bankIdOf(record.url)}|${record.body.query}|` }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const queries = Array.from({ length: 20 }, (_, i) => `q${i}`)
    const outputs = await Promise.all(queries.map((query) => recall.execute({ query })))
    outputs.forEach((out, index) => {
      assert.ok(out.includes(`|a|q${index}|`), `call ${index} must see its own query`)
      // No other call's marker may appear in this call's output.
      for (const other of queries) {
        if (other === `q${index}`) continue
        assert.ok(!out.includes(`|${other}|`), `call ${index} leaked query ${other}`)
      }
    })
  } finally { await mock.close() }
})

test('concurrency: 50 sequential calls do not accumulate state', async () => {
  const mock = await startMock((record) => (record.url === '/v1/default/banks'
    ? { status: 200, body: { banks: [{ bank_id: 'solo' }] } }
    : { status: 200, body: { results: [{ content: 'stable' }] } }))
  try {
    const { recall } = loadTools(mock.url)
    for (let i = 0; i < 50; i += 1) {
      const out = await recall.execute({ query: `iteration ${i}` })
      assert.equal(out.split('\n').filter((l) => l.startsWith('## ')).length, 1)
    }
  } finally { await mock.close() }
})

/* ------------------------------------------------------------------ limits */

test('limits: a bank slower than the timeout is dropped without stalling the call', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `b${i}`)
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    if (bankIdOf(record.url) === 'b0') {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return { status: 200, body: { results: [{ content: 'late' }] } }
    }
    return { status: 200, body: { results: [{ content: 'fast' }] } }
  })
  try {
    const { recall } = loadTools(mock.url, { timeoutMs: 500 })
    const started = Date.now()
    const out = await recall.execute({ query: 'q' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2500, `a hung bank must not hold the call (${elapsed}ms)`)
    assert.equal(out.split('\n').filter((l) => l.startsWith('## ')).length, 9, '9 healthy banks')
    assert.match(out, /Unreachable banks:/)
  } finally { await mock.close() }
})

test('limits: an empty roster short-circuits with no recall traffic', async () => {
  const mock = await startMock(() => ({ status: 200, body: { banks: [] } }))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /No memory banks to search/)
    assert.equal(mock.state.served, 1, 'only the roster call should happen')
  } finally { await mock.close() }
})

test('limits: the roster call is not repeated per bank', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => `b${i}`)
  const mock = await startMock((record) => (record.url === '/v1/default/banks'
    ? { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    : { status: 200, body: { results: [{ content: 'x' }] } }))
  try {
    const { recall } = loadTools(mock.url)
    await recall.execute({ query: 'q' })
    assert.equal(mock.state.served, 41, 'exactly one roster + 40 recalls')
  } finally { await mock.close() }
})
