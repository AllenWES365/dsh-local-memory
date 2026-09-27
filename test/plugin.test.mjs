/**
 * dsh-local-memory — test suite
 *
 * Two layers, deliberately separated:
 *
 *   1. Mock-daemon tests (this file, the bulk). A local HTTP server stands in
 *      for the Hindsight daemon, so edge cases that are expensive or impossible
 *      to provoke for real — 100 banks, a hung bank, malformed JSON, a bank id
 *      needing URL-encoding — are cheap and deterministic.
 *
 *   2. Real-daemon smoke tests (test/real-daemon.test.mjs), which prove the
 *      contract the mock is modelling actually matches the shipped daemon.
 *
 * Run: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

/* ------------------------------------------------------------------ helpers */

/** Boot a mock daemon. `handler` returns {status, body} or {status} for no body. */
async function startMock(handler) {
  const state = { inflight: 0, maxInflight: 0, requests: [] }
  const server = createServer(async (req, res) => {
    state.inflight += 1
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = raw === '' ? undefined : JSON.parse(raw) } catch { body = raw }
    const record = { method: req.method, url: req.url, body }
    state.requests.push(record)
    try {
      const out = (await handler(record, state)) ?? { status: 404, body: { detail: 'not found' } }
      const payload = out.body === undefined ? '' : JSON.stringify(out.body)
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
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Load the plugin against `url` and hand back its two registered tools. */
function loadTools(url, config = {}) {
  const registered = []
  const ctx = {
    inject: (_deps, cb) => cb({ tools: { register: (def) => registered.push(def) } }),
  }
  apply(ctx, { apiUrl: url, ...config })
  const banks = registered.find((t) => t.name === 'memory_banks')
  const recall = registered.find((t) => t.name === 'memory_recall_all')
  assert.ok(banks, 'memory_banks must register')
  assert.ok(recall, 'memory_recall_all must register')
  return { banks, recall, registered }
}

/** Decode the bank id out of a recall URL path. */
function bankIdOf(url) {
  const match = /^\/v1\/default\/banks\/(.+)\/memories\/recall$/.exec(url)
  assert.ok(match, `unexpected recall url: ${url}`)
  return decodeURIComponent(match[1])
}

/** A daemon serving `bankIds`, each returning one observation per query. */
const simpleDaemon = (bankIds) => (record) => {
  if (record.url === '/v1/default/banks') {
    return { status: 200, body: { banks: bankIds.map((bank_id) => ({ bank_id })) } }
  }
  if (record.url.endsWith('/memories/recall')) {
    const id = bankIdOf(record.url)
    return { status: 200, body: { results: [{ content: `fact from ${id}` }] } }
  }
  return { status: 404, body: { detail: 'not found' } }
}

/* ------------------------------------------------------- registration shape */

test('registers exactly the two documented tools', () => {
  const registered = []
  apply(
    { inject: (_d, cb) => cb({ tools: { register: (def) => registered.push(def) } }) },
    {},
  )
  assert.deepEqual(registered.map((t) => t.name).sort(), ['memory_banks', 'memory_recall_all'])
})

test('every tool declares a JSON-schema parameter block and a text renderer', () => {
  const registered = []
  apply(
    { inject: (_d, cb) => cb({ tools: { register: (def) => registered.push(def) } }) },
    {},
  )
  for (const def of registered) {
    assert.equal(typeof def.description, 'string')
    assert.equal(def.parameters.type, 'object')
    assert.ok(def.parameters.properties, `${def.name} needs properties`)
    assert.equal(typeof def.output.render, 'function')
    const rendered = def.output.render({}, 'sample')
    assert.deepEqual(rendered, [{ type: 'text', text: 'sample' }])
  }
})

test('the plugin does not throw when the tools service is absent', () => {
  // ctx.inject simply never calls back — an unmounted registry must not crash boot.
  assert.doesNotThrow(() => apply({ inject: () => {} }, {}))
})

/* --------------------------------------------------------------- memory_banks */

test('memory_banks lists every bank, sorted', async () => {
  const mock = await startMock(simpleDaemon(['zeta', 'alpha', 'mid']))
  try {
    const { banks } = loadTools(mock.url)
    const out = await banks.execute({})
    assert.match(out, /3 memory bank\(s\)/)
    const ids = out.split('\n').slice(1).map((line) => line.replace(/^- /, '').split('  (')[0])
    assert.deepEqual(ids, ['alpha', 'mid', 'zeta'])
  } finally { await mock.close() }
})

test('memory_banks reports size and last-write time so targeting is informed', async () => {
  // These two fields are the whole point of the listing: size predicts cost, and
  // recency is the best hint about relevance. Without them the caller can only
  // guess which banks to search — or sweep everything, which is the slow path.
  const mock = await startMock(() => ({
    status: 200,
    body: {
      banks: [
        {
          bank_id: 'big',
          fact_count: 873,
          last_write_at: '2026-09-27T02:33:03.973637+00:00',
        },
        { bank_id: 'small', fact_count: 4, last_write_at: '2026-01-02T03:04:05+00:00' },
      ],
    },
  }))
  try {
    const { banks } = loadTools(mock.url)
    const out = await banks.execute({})
    assert.match(out, /- big {2}\(873 facts, last write 2026-09-27 02:33\)/)
    assert.match(out, /- small {2}\(4 facts, last write 2026-01-02 03:04\)/)
  } finally { await mock.close() }
})

test('memory_banks degrades gracefully when a bank reports no size', async () => {
  const mock = await startMock(() => ({
    status: 200,
    body: { banks: [{ bank_id: 'unknown' }] },
  }))
  try {
    const { banks } = loadTools(mock.url)
    const out = await banks.execute({})
    assert.match(out, /- unknown {2}\(unknown size, never written\)/)
  } finally { await mock.close() }
})

test('memory_banks applies the configured prefix filter', async () => {
  const mock = await startMock(simpleDaemon(['coding-agent::a', 'coding-agent::b', 'other::c']))
  try {
    const { banks } = loadTools(mock.url, { bankPrefix: 'coding-agent::' })
    const out = await banks.execute({})
    assert.match(out, /2 memory bank\(s\)/)
    assert.ok(!out.includes('other::c'), 'non-matching bank must be filtered out')
  } finally { await mock.close() }
})

test('memory_banks drops entries with no usable bank_id', async () => {
  const mock = await startMock(() => ({
    status: 200,
    body: { banks: [{ bank_id: 'good' }, { nope: 1 }, null, { bank_id: 42 }] },
  }))
  try {
    const { banks } = loadTools(mock.url)
    const out = await banks.execute({})
    assert.match(out, /1 memory bank\(s\)/)
    assert.ok(out.includes('- good'))
  } finally { await mock.close() }
})

test('memory_banks reports an empty roster without erroring', async () => {
  const mock = await startMock(() => ({ status: 200, body: { banks: [] } }))
  try {
    const { banks } = loadTools(mock.url)
    assert.match(await banks.execute({}), /No memory banks yet/)
  } finally { await mock.close() }
})

test('memory_banks explains an unmatched prefix rather than claiming emptiness', async () => {
  const mock = await startMock(simpleDaemon(['other::a']))
  try {
    const { banks } = loadTools(mock.url, { bankPrefix: 'coding-agent::' })
    const out = await banks.execute({})
    assert.match(out, /No memory banks matching prefix "coding-agent::"/)
  } finally { await mock.close() }
})

test('memory_banks surfaces an unreachable daemon with the address', async () => {
  const { banks } = loadTools('http://127.0.0.1:1', { timeoutMs: 2000 })
  const out = await banks.execute({})
  assert.match(out, /Cannot reach the local memory daemon/)
  assert.match(out, /127\.0\.0\.1:1/)
})

test('memory_banks survives a malformed JSON body', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"banks": [')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { banks } = loadTools(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 2000 })
    const out = await banks.execute({})
    assert.match(out, /Cannot reach the local memory daemon/)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('memory_banks reports an HTTP error status rather than an empty roster', async () => {
  const mock = await startMock(() => ({ status: 503, body: { detail: 'database down' } }))
  try {
    const { banks } = loadTools(mock.url)
    const out = await banks.execute({})
    assert.match(out, /Cannot reach the local memory daemon/)
    assert.match(out, /503/)
  } finally { await mock.close() }
})

/* ---------------------------------------------------------- memory_recall_all */

test('memory_recall_all fans out and groups hits by bank', async () => {
  const mock = await startMock(simpleDaemon(['repo::one', 'repo::two']))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'anything' })
    assert.match(out, /Searched 2 bank\(s\)/)
    assert.match(out, /## repo::one\n- fact from repo::one/)
    assert.match(out, /## repo::two\n- fact from repo::two/)
  } finally { await mock.close() }
})

test('memory_recall_all sends the query verbatim and asks for observations first', async () => {
  const mock = await startMock(simpleDaemon(['b1']))
  try {
    const { recall } = loadTools(mock.url)
    await recall.execute({ query: '为什么用 Postgres？' })
    const call = mock.state.requests.find((r) => r.url.endsWith('/memories/recall'))
    assert.equal(call.method, 'POST')
    assert.equal(call.body.query, '为什么用 Postgres？')
    assert.deepEqual(call.body.types, ['observation'])
  } finally { await mock.close() }
})

test('memory_recall_all falls back to unfiltered recall when no observation exists yet', async () => {
  // A bank written moments ago has raw memories but no consolidated observation.
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'fresh' }] } }
    }
    if (record.url.endsWith('/memories/recall')) {
      const filtered = Array.isArray(record.body?.types)
      return {
        status: 200,
        body: { results: filtered ? [] : [{ content: 'raw memory only' }] },
      }
    }
    return { status: 404 }
  })
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /raw memory only/, 'must fall back rather than report nothing')
    const recalls = mock.state.requests.filter((r) => r.url.endsWith('/memories/recall'))
    assert.equal(recalls.length, 2, 'one filtered attempt then one fallback')
  } finally { await mock.close() }
})

test('memory_recall_all does not fall back when observations are found', async () => {
  const mock = await startMock(simpleDaemon(['b1']))
  try {
    const { recall } = loadTools(mock.url)
    await recall.execute({ query: 'q' })
    const recalls = mock.state.requests.filter((r) => r.url.endsWith('/memories/recall'))
    assert.equal(recalls.length, 1, 'no second call when the first had hits')
  } finally { await mock.close() }
})

test('memory_recall_all de-duplicates identical texts inside one bank', async () => {
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'dup' }] } }
    }
    return { status: 200, body: { results: [{ content: 'same' }, { content: 'same' }, { content: 'other' }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.equal(out.split('\n').filter((l) => l === '- same').length, 1)
    assert.equal(out.split('\n').filter((l) => l === '- other').length, 1)
  } finally { await mock.close() }
})

test('memory_recall_all caps each bank and says how many were withheld', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ content: `fact ${i}` }))
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'deep' }] } }
    }
    return { status: 200, body: { results: many } }
  })
  try {
    const { recall } = loadTools(mock.url, { maxPerBank: 3 })
    const out = await recall.execute({ query: 'q' })
    assert.equal(out.split('\n').filter((l) => l.startsWith('- fact')).length, 3)
    assert.match(out, /… 9 more in this bank/, 'overflow must be stated, not hidden')
  } finally { await mock.close() }
})

test('memory_recall_all honours an explicit banks argument', async () => {
  const mock = await startMock(simpleDaemon(['a', 'b', 'c']))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q', banks: 'a, c' })
    assert.match(out, /Searched 2 bank\(s\)/)
    assert.ok(!out.includes('## b'), 'unlisted bank must not be searched')
    const recallUrls = mock.state.requests.filter((r) => r.url.endsWith('/memories/recall'))
    assert.deepEqual(recallUrls.map((r) => bankIdOf(r.url)).sort(), ['a', 'c'])
  } finally { await mock.close() }
})

test('memory_recall_all tolerates padding in the banks argument', async () => {
  const mock = await startMock(simpleDaemon(['a', 'b']))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q', banks: '  a ,, b ,  ' })
    assert.match(out, /Searched 2 bank\(s\)/)
  } finally { await mock.close() }
})

test('memory_recall_all rejects a blank query', async () => {
  const mock = await startMock(simpleDaemon(['a']))
  try {
    const { recall } = loadTools(mock.url)
    assert.match(await recall.execute({ query: '   ' }), /needs a non-empty query/)
    assert.match(await recall.execute({}), /needs a non-empty query/)
    assert.equal(mock.state.requests.length, 0, 'no request should be made')
  } finally { await mock.close() }
})

test('one failing bank does not abort the others, and is reported', async () => {
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'good' }, { bank_id: 'bad' }] } }
    }
    if (bankIdOf(record.url) === 'bad') return { status: 500, body: { detail: 'boom' } }
    return { status: 200, body: { results: [{ content: 'healthy' }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /healthy/, 'the healthy bank must still be reported')
    assert.match(out, /Unreachable banks:/)
    assert.match(out, /bad/)
  } finally { await mock.close() }
})

test('a bank that returns nothing is simply omitted', async () => {
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'empty' }, { bank_id: 'full' }] } }
    }
    return bankIdOf(record.url) === 'empty'
      ? { status: 200, body: { results: [] } }
      : { status: 200, body: { results: [{ content: 'present' }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.ok(!out.includes('## empty'), 'an empty bank gets no heading')
    assert.match(out, /## full/)
  } finally { await mock.close() }
})

test('a query matching nowhere says so', async () => {
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'a' }] } }
    }
    return { status: 200, body: { results: [] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    assert.match(await recall.execute({ query: 'q' }), /No bank returned a match/)
  } finally { await mock.close() }
})

test('bank ids are URL-encoded on the wire and decoded back for display', async () => {
  const id = 'coding-agent::a/b c&d'
  const mock = await startMock(simpleDaemon([id]))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    const call = mock.state.requests.find((r) => r.url.endsWith('/memories/recall'))
    assert.ok(!call.url.includes(' '), 'a raw space must never reach the wire')
    assert.ok(call.url.includes('%3A%3A'), 'the :: separator must be encoded')
    assert.equal(bankIdOf(call.url), id)
    assert.match(out, new RegExp(`## ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  } finally { await mock.close() }
})

test('a hung bank times out without hanging the whole call', async () => {
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'slow' }, { bank_id: 'fast' }] } }
    }
    if (bankIdOf(record.url) === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      return { status: 200, body: { results: [{ content: 'too late' }] } }
    }
    return { status: 200, body: { results: [{ content: 'quick' }] } }
  })
  try {
    const { recall } = loadTools(mock.url, { timeoutMs: 600 })
    const started = Date.now()
    const out = await recall.execute({ query: 'q' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 4000, `should not wait for the hung bank (took ${elapsed}ms)`)
    assert.match(out, /quick/, 'the fast bank still answers')
    assert.match(out, /Unreachable banks:/)
    assert.match(out, /slow/)
  } finally { await mock.close() }
})

test('a non-JSON body from a bank is contained to that bank', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/default/banks') {
      const payload = JSON.stringify({ banks: [{ bank_id: 'html' }] })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>proxy error</html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { recall } = loadTools(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 2000 })
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /Unreachable banks:/)
    assert.match(out, /html/)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('recall against an unreachable daemon explains the failure', async () => {
  const { recall } = loadTools('http://127.0.0.1:1', { timeoutMs: 2000 })
  const out = await recall.execute({ query: 'q' })
  assert.match(out, /Cannot reach the local memory daemon/)
})

/* ------------------------------------------------------------------- stress */

test('stress: 120 banks are all searched and the fan-out stays bounded', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `coding-agent::repo-${String(i).padStart(3, '0')}`)
  // The recall handler must occupy the event loop briefly. With an INSTANT
  // handler each request is fully served between two arrivals, so the inflight
  // high-water mark reads 1 even though the client issued six at once — timing
  // (see the budget test below) stays the honest proof of parallelism; this
  // small delay just makes the same fact observable through the counter.
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { status: 200, body: { results: [{ content: `fact from ${bankIdOf(record.url)}` }] } }
  })
  try {
    const { recall } = loadTools(mock.url, { concurrency: 6, maxPerBank: 5 })
    const out = await recall.execute({ query: 'anything' })
    assert.match(out, /Searched 120 bank\(s\)/)
    assert.equal(out.split('\n').filter((l) => l.startsWith('## ')).length, 120)
    assert.ok(
      mock.state.maxInflight <= 6,
      `concurrency must be bounded at 6, saw ${mock.state.maxInflight}`,
    )
    assert.ok(mock.state.maxInflight > 1, 'work must actually run in parallel')
  } finally { await mock.close() }
})

test('overhead: the plugin adds little on top of the bank round-trips', async () => {
  // SCOPE — read this before trusting the number. This measures the PLUGIN's own
  // overhead against a local mock: request building, fan-out bookkeeping, string
  // assembly. It says NOTHING about real-world latency, and an earlier version of
  // this test was read as if it did.
  //
  // Measured against the real daemon: a sweep costs roughly 150ms per bank,
  // because the daemon serves recalls largely serially — concurrency 1, 6 and 13
  // land within 20% of each other, and disabling reranking (which halves a single
  // call, 85ms -> 37ms) changes a 13-bank sweep not at all (1862ms either way).
  // So 120 real banks would take ~18s whatever this test prints.
  const ids = Array.from({ length: 120 }, (_, i) => `b${i}`)
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    // 25ms per bank: serial needs ~3s, so finishing well under that proves only
    // that the plugin overlaps its own round-trips.
    await new Promise((resolve) => setTimeout(resolve, 25))
    return { status: 200, body: { results: [{ content: 'hit' }] } }
  })
  try {
    const { recall } = loadTools(mock.url, { concurrency: 8 })
    const started = Date.now()
    await recall.execute({ query: 'q' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2500, `plugin-side fan-out should overlap round-trips (took ${elapsed}ms)`)
  } finally { await mock.close() }
})

test('stress: interleaved calls do not share mutable state', async () => {
  const ids = ['x', 'y', 'z']
  const mock = await startMock((record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    const id = bankIdOf(record.url)
    return { status: 200, body: { results: [{ content: `${id}-${record.body.query}` }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const [a, b] = await Promise.all([
      recall.execute({ query: 'first' }),
      recall.execute({ query: 'second' }),
    ])
    assert.ok(a.includes('x-first') && !a.includes('x-second'), 'results must not bleed across calls')
    assert.ok(b.includes('x-second') && !b.includes('x-first'))
  } finally { await mock.close() }
})

test('stress: a 4000-character query is passed through intact', async () => {
  const mock = await startMock(simpleDaemon(['a']))
  try {
    const { recall } = loadTools(mock.url)
    const query = 'x'.repeat(4000)
    await recall.execute({ query })
    const call = mock.state.requests.find((r) => r.url.endsWith('/memories/recall'))
    assert.equal(call.body.query.length, 4000)
  } finally { await mock.close() }
})

test('defaults are sane when no config is supplied', async () => {
  const mock = await startMock(simpleDaemon(['a']))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /## a/)
  } finally { await mock.close() }
})

/* ------------------------------------------------------ measured reporting */

test('the header reports how long the sweep actually took', async () => {
  const mock = await startMock(simpleDaemon(['a']))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /^Searched 1 bank\(s\) in \d+ms for: q$/m)
  } finally { await mock.close() }
})

test('a wide, slow sweep says why it was slow and how to narrow it', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `b${i}`)
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: ids.map((bank_id) => ({ bank_id })) } }
    }
    // 12 banks at concurrency 3 is 4 serial waves; 350ms each clears the 1s
    // reporting threshold with margin.
    await new Promise((resolve) => setTimeout(resolve, 350))
    return { status: 200, body: { results: [{ content: 'x' }] } }
  })
  try {
    const { recall } = loadTools(mock.url, { concurrency: 3 })
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /Note: 12 banks took \d+ms/)
    assert.match(out, /wide sweep is the sum of its banks/)
    assert.match(out, /`banks` argument/)
  } finally { await mock.close() }
})

test('a NARROW but slow sweep blames depth, not width', async () => {
  // The regression this guards: the note used to require >=8 banks, so two deep
  // banks taking two seconds — the real shape of a deep memory bank — passed
  // silently while the reader was left guessing why it was slow.
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'deep-one' }, { bank_id: 'deep-two' }] } }
    }
    // Two banks at the default concurrency run in parallel, so the sweep costs
    // one delay — it must clear 1s on its own to trip the threshold.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return { status: 200, body: { results: [{ content: 'x' }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.match(out, /Note: this took \d+ms because a bank holding a lot of memories/)
    assert.match(out, /will not speed it up/)
    assert.ok(!out.includes('wide sweep'), 'a two-bank sweep must not be called wide')
  } finally { await mock.close() }
})

test('a narrow, fast sweep stays quiet about timing', async () => {
  const mock = await startMock(async (record) => {
    if (record.url === '/v1/default/banks') {
      return { status: 200, body: { banks: [{ bank_id: 'only' }] } }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { status: 200, body: { results: [{ content: 'x' }] } }
  })
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.ok(!out.includes('Note:'), 'a quick sweep needs no explanation')
  } finally { await mock.close() }
})

test('a fast wide sweep does not warn either', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `b${i}`)
  const mock = await startMock(simpleDaemon(ids))
  try {
    const { recall } = loadTools(mock.url)
    const out = await recall.execute({ query: 'q' })
    assert.ok(!out.includes('Note:'), 'speed, not width, is what needs explaining')
  } finally { await mock.close() }
})
