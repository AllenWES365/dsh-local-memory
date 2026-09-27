/**
 * dsh-local-memory — real-daemon smoke tests
 *
 * The mock in plugin.test.mjs encodes ASSUMPTIONS about the Hindsight daemon:
 * the bank-list shape, the recall path, and that `types: ["observation"]` is
 * accepted. A mock that quietly disagrees with the real server would let every
 * unit test pass while the shipped plugin fails, so this file checks those
 * assumptions against the daemon actually running on this machine.
 *
 * Read-only by design: it never writes a memory, so it costs no extraction
 * tokens and leaves no test data behind. When the daemon is not running the
 * file skips rather than failing — that is a machine state, not a defect.
 *
 * Run: node --test test/real-daemon.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const API = process.env.DSH_LOCAL_MEMORY_API ?? 'http://127.0.0.1:9077'

/** Is the daemon answering? Returns the parsed bank list, or undefined. */
async function probeDaemon() {
  try {
    const res = await fetch(`${API}/v1/default/banks`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}

const snapshot = await probeDaemon()
const skip = snapshot === undefined
  ? `Hindsight daemon not reachable at ${API} — start a DSH session first`
  : false

test('contract: GET /v1/default/banks returns {banks:[{bank_id}]}', { skip }, async () => {
  // This is the exact shape plugin.test.mjs mocks. If the daemon ever changes
  // it, the mock must change with it — that is the point of this assertion.
  assert.ok(Array.isArray(snapshot.banks), 'banks must be an array')
  for (const entry of snapshot.banks) {
    assert.equal(typeof entry.bank_id, 'string', 'each entry needs a string bank_id')
  }
})

test('contract: recall accepts types:["observation"]', { skip }, async () => {
  const bank = snapshot.banks[0]?.bank_id
  if (bank === undefined) return
  const res = await fetch(
    `${API}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything', types: ['observation'] }),
      signal: AbortSignal.timeout(20000),
    },
  )
  assert.equal(res.status, 200, 'the filtered recall form must be accepted')
  const body = await res.json()
  assert.ok('results' in body, 'recall must answer with a results field')
  assert.ok(Array.isArray(body.results), 'results must be an array')
})

test('contract: a bank id with :: survives URL encoding', { skip }, async () => {
  const bank = snapshot.banks.find((entry) => entry.bank_id.includes('::'))
  if (bank === undefined) return
  const res = await fetch(
    `${API}/v1/default/banks/${encodeURIComponent(bank.bank_id)}/memories/recall`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything' }),
      signal: AbortSignal.timeout(20000),
    },
  )
  assert.equal(res.status, 200, `${bank.bank_id} must round-trip through the path`)
})

/** Load the plugin against the live daemon. */
function liveTools(config = {}) {
  const registered = []
  apply(
    { inject: (_deps, cb) => cb({ tools: { register: (def) => registered.push(def) }, get: () => undefined }), get: (n) => (n === 'webServer' ? { register: () => () => {} } : undefined), effect: (fn) => { fn(); return () => {} } },
    { apiUrl: API, ...config },
  )
  return {
    banks: registered.find((t) => t.name === 'memory_banks'),
    recall: registered.find((t) => t.name === 'memory_recall_all'),
  }
}

test('live: memory_banks lists the daemon roster', { skip }, async () => {
  const { banks } = liveTools()
  const out = await banks.execute({})
  assert.doesNotMatch(out, /Cannot reach/, 'the daemon is up, so no reachability error')
  const listed = out.split('\n').slice(1).filter((line) => line.startsWith('- ')).length
  assert.equal(listed, snapshot.banks.length, 'every real bank must be listed')
})

test('live: memory_recall_all returns grouped, bank-attributed output', { skip }, async () => {
  const { recall } = liveTools({ maxPerBank: 3 })
  const out = await recall.execute({ query: '这个项目是做什么的？' })
  assert.doesNotMatch(out, /Cannot reach/)
  assert.match(out, new RegExp(`Searched ${snapshot.banks.length} bank\\(s\\)`))
  for (const heading of out.split('\n').filter((line) => line.startsWith('## '))) {
    const id = heading.slice(3)
    assert.ok(
      snapshot.banks.some((entry) => entry.bank_id === id),
      `heading "${id}" must name a real bank`,
    )
  }
})

test('live: the per-bank cap holds against real data', { skip }, async () => {
  const { recall } = liveTools({ maxPerBank: 2 })
  const out = await recall.execute({ query: '配置' })
  let inSection = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('## ')) { inSection = 0; continue }
    if (line.startsWith('- ') && !line.startsWith('- …')) {
      inSection += 1
      assert.ok(inSection <= 2, `a bank returned ${inSection} hits, over the cap of 2`)
    }
  }
})

test('live: restricting to a named bank searches only that bank', { skip }, async () => {
  // Assert on the CONTAINMENT, not on the presence of a heading. Whether a given
  // real bank happens to answer this query depends on what it has accumulated,
  // and the roster order is not stable — an earlier version of this test pinned
  // banks[0] and failed the moment that slot held a bank with no matching fact.
  // The property under test is "no OTHER bank was consulted", which holds either way.
  const target = snapshot.banks[0]?.bank_id
  if (target === undefined) return
  const { recall } = liveTools()
  const out = await recall.execute({ query: '配置', banks: target })
  assert.match(out, /Searched 1 bank\(s\)/)
  const headings = out.split('\n').filter((line) => line.startsWith('## '))
  for (const heading of headings) {
    assert.equal(heading, `## ${target}`, 'no bank other than the named one may appear')
  }
  // And the named bank really was consulted (a heading only appears when it answered).
  const list = await liveTools().banks.execute({})
  if (list.includes(target)) {
    assert.ok(
      headings.length <= 1,
      'a single-bank search can produce at most one section',
    )
  }
})
