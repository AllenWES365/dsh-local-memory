/**
 * dsh-local-memory — project discovery tests
 *
 * Discovery answers the question the bank roster cannot: "what SHOULD I
 * remember?" A project with no bank is absent from the roster entirely, so
 * silence and non-existence look the same. These tests build real directory
 * trees (with real `.git` entries) under a temp root, because the walk is the
 * thing under test and a virtual filesystem would not exercise it.
 *
 * Run: node --test test/discovery.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/* ------------------------------------------------------------------ helpers */

/** A throwaway directory tree. Returned handle removes it. */
function makeTree(shape) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-discovery-'))
  for (const [relative, kind] of Object.entries(shape)) {
    const full = join(root, relative)
    mkdirSync(full, { recursive: true })
    if (kind === 'git-dir') mkdirSync(join(full, '.git'), { recursive: true })
    if (kind === 'git-file') {
      // A linked worktree: `.git` is a FILE pointing at the main checkout.
      writeFileSync(join(full, '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'wt')}\n`)
      mkdirSync(join(root, 'main', '.git', 'worktrees', 'wt'), { recursive: true })
    }
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Boot a mock daemon that only serves a bank roster. */
async function startRosterMock(bankIds) {
  const server = createServer((req, res) => {
    const payload = JSON.stringify({
      banks: bankIds.map((id) => ({ bank_id: id, fact_count: 7, last_write_at: '2026-09-27T01:02:03+00:00' })),
    })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Load the plugin and hand back the discovery tool plus any captured route. */
function load(apiUrl, { workspaces = [], config = {} } = {}) {
  const registered = []
  let route
  const registry = { list: () => workspaces.map((path) => ({ path })) }
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return { register: (r) => { route = r; return () => {} } }
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
    inject: (deps, cb) => {
      const facade = {
        get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
        effect: (fn) => { fn(); return () => {} },
      }
      if (deps.includes('tools')) facade.tools = { register: (def) => registered.push(def) }
      cb(facade)
    },
    effect: (fn) => { fn(); return () => {} },
  }
  apply(ctx, { apiUrl, ...config })
  return {
    route,
    projects: registered.find((t) => t.name === 'memory_projects'),
  }
}

/* --------------------------------------------------------------- the tool */

test('registers memory_projects alongside the other two tools', () => {
  const { projects } = load('http://127.0.0.1:1')
  assert.ok(projects, 'memory_projects must register')
  assert.equal(projects.parameters.type, 'object')
})

test('the working root itself counts as a project', async () => {
  // The root is normally a plain folder, not a repository, and a session started
  // there still gets a bank named after the directory. Omitting it made that
  // bank look like it matched no project at all.
  const tree = makeTree({ 'alpha': 'git-dir' })
  const mock = await startRosterMock([])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const out = await projects.execute({})
    const rootName = tree.root.split('/').pop()
    assert.match(out, new RegExp(`will become coding-agent::${rootName}\\b`))
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('finds repositories beneath the roots and names each bank', async () => {
  const tree = makeTree({ 'alpha': 'git-dir', 'beta': 'git-dir', 'plain': 'dir' })
  const mock = await startRosterMock([])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const out = await projects.execute({})
    assert.match(out, /will become coding-agent::alpha/)
    assert.match(out, /will become coding-agent::beta/)
    // The root plus alpha and beta. `plain` has no `.git`, and a subdirectory
    // that is not a repository is not a project — only the ROOTS qualify
    // without git, because a session started at a root gets a bank regardless.
    assert.match(out, /3 project\(s\) found/)
    assert.ok(!out.includes('coding-agent::plain'), 'a non-repository subdirectory is not a project')
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('marks the projects that already have memory, with their size', async () => {
  const tree = makeTree({ 'alpha': 'git-dir', 'beta': 'git-dir' })
  const mock = await startRosterMock([`coding-agent::alpha`])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const out = await projects.execute({})
    assert.match(out, /1 with memory/)
    assert.match(out, /## With memory/)
    assert.match(out, /coding-agent::alpha {2}\(7 facts/)
    // And beta is still listed as missing rather than silently dropped.
    assert.match(out, /will become coding-agent::beta/)
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('reports a bank that matches no project on disk instead of hiding it', async () => {
  const tree = makeTree({ 'alpha': 'git-dir' })
  const mock = await startRosterMock(['coding-agent::alpha', 'coding-agent::ghost'])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const out = await projects.execute({})
    assert.match(out, /## Banks that match no project on disk/)
    assert.match(out, /coding-agent::ghost/)
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('skips dependency and build directories', async () => {
  const tree = makeTree({
    'node_modules/vendored': 'git-dir',
    'dist/built': 'git-dir',
    'real': 'git-dir',
  })
  const mock = await startRosterMock([])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const out = await projects.execute({})
    assert.match(out, /will become coding-agent::real/)
    assert.ok(!out.includes('coding-agent::vendored'), 'node_modules must not be walked')
    assert.ok(!out.includes('coding-agent::built'), 'build output must not be walked')
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('a linked worktree resolves to its main checkout name', async () => {
  // `.git` as a FILE is a worktree; the backend names its bank after the MAIN
  // checkout, so the prediction has to agree or it would name a bank that never
  // gets created.
  const tree = makeTree({ 'main': 'git-dir', 'feature-wt': 'git-file' })
  const mock = await startRosterMock([])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const out = await projects.execute({})
    assert.ok(out.includes('will become coding-agent::main'))
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('a detached or unreadable .git file does not break the walk', async () => {
  const tree = makeTree({ 'ok': 'git-dir' })
  mkdirSync(join(tree.root, 'broken'), { recursive: true })
  writeFileSync(join(tree.root, 'broken', '.git'), 'not a gitdir line\n')
  const mock = await startRosterMock([])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const out = await projects.execute({})
    assert.match(out, /will become coding-agent::ok/)
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('the scan is cached briefly so repeated calls do not re-walk', async () => {
  const tree = makeTree({ 'alpha': 'git-dir' })
  const mock = await startRosterMock([])
  try {
    const { projects } = load(mock.url, { workspaces: [tree.root] })
    const first = await projects.execute({})
    // A new repository appears; without a cache this would show immediately.
    mkdirSync(join(tree.root, 'gamma', '.git'), { recursive: true })
    const second = await projects.execute({})
    assert.equal(second, first, 'the second call must be served from the cache')
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('a workspaces registry that throws does not break discovery', async () => {
  const tree = makeTree({ 'alpha': 'git-dir' })
  const mock = await startRosterMock([])
  try {
    const registered = []
    const ctx = {
      get: (name) => {
        if (name === 'webServer') return { register: () => () => {} }
        if (name === 'workspaceRegistry') return { list: () => { throw new Error('registry offline') } }
        return undefined
      },
      inject: (deps, cb) => {
        const facade = {
          get: (name) => (name === 'workspaceRegistry' ? { list: () => { throw new Error('offline') } } : undefined),
          effect: (fn) => { fn(); return () => {} },
        }
        if (deps.includes('tools')) facade.tools = { register: (def) => registered.push(def) }
        cb(facade)
      },
      effect: (fn) => { fn(); return () => {} },
    }
    apply(ctx, { apiUrl: mock.url, root: tree.root })
    const tool = registered.find((t) => t.name === 'memory_projects')
    const out = await tool.execute({})
    // Falls back to the configured root rather than failing outright.
    assert.match(out, /will become coding-agent::alpha/)
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

/* -------------------------------------------------------------- the route */

test('GET /api/projects returns the discovery payload', async () => {
  const tree = makeTree({ 'alpha': 'git-dir' })
  const mock = await startRosterMock([`coding-agent::alpha`])
  try {
    const { route } = load(mock.url, { workspaces: [tree.root] })
    assert.ok(route, 'a route must be registered')
    const request = { method: 'GET', url: '/local-memory/api/projects', async *[Symbol.asyncIterator]() {} }
    let status
    let body
    await route.handler(request, {
      writeHead: (code) => { status = code },
      end: (payload) => { body = payload },
    })
    assert.equal(status, 200)
    const parsed = JSON.parse(body)
    assert.ok(Array.isArray(parsed.projects))
    assert.ok(parsed.projects.some((p) => p.bankId === 'coding-agent::alpha' && p.hasMemory === true))
    assert.equal(parsed.unmatched.length, 0)
  } finally {
    await mock.close()
    tree.cleanup()
  }
})

test('POST /api/projects is refused with 405', async () => {
  const tree = makeTree({ 'alpha': 'git-dir' })
  const mock = await startRosterMock([])
  try {
    const { route } = load(mock.url, { workspaces: [tree.root] })
    const request = { method: 'POST', url: '/local-memory/api/projects', async *[Symbol.asyncIterator]() {} }
    let status
    await route.handler(request, { writeHead: (code) => { status = code }, end: () => {} })
    assert.equal(status, 405)
  } finally {
    await mock.close()
    tree.cleanup()
  }
})
