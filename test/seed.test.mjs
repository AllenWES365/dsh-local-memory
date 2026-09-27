/**
 * dsh-local-memory — seeding tests
 *
 * The projects panel used to be a report: it named every project without memory
 * and told the reader to go open a session in each one. These tests cover the
 * half that replaced it — the action, and the checks that decide whether an
 * action is offered at all.
 *
 * Two things are exercised against reality rather than mocks:
 *
 *   - the git readers run against real repositories created here, including a
 *     linked worktree (where `.git` is a FILE) and a packed ref, because those
 *     are exactly the cases a hand-written reader gets wrong;
 *   - the spawn is proven by running a real detached child and reading back the
 *     argv it was handed. A stub that only records "spawn was called" would not
 *     have caught a wrong flag or a missing `--repo`.
 *
 * The real engine is deliberately NOT run: it would write into the user's
 * memory banks and take about a minute per repository.
 *
 * Run: node --test test/seed.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const FAKE_ENGINE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-deepen.mjs')

/* ------------------------------------------------------------------ helpers */

/** A throwaway root directory. Returned handle removes it. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-seed-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** A real, committed git repository at `<parent>/<name>`. */
function makeRepo(parent, name, message = 'one') {
  const repo = join(parent, name)
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '.'], { cwd: repo })
  writeFileSync(join(repo, 'file.txt'), `${message}\n`)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message], { cwd: repo })
  return repo
}

const headOf = (repo) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

/** A mock daemon serving a bank roster and per-bank documents. */
async function startDaemon({ banks = [], documents = {} } = {}) {
  const state = { paths: [] }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://placeholder')
    state.paths.push(url.pathname)
    const docPath = /^\/v1\/default\/banks\/(.+)\/documents$/.exec(url.pathname)
    let payload
    if (docPath !== null) {
      payload = { items: documents[decodeURIComponent(docPath[1])] ?? [] }
    } else if (url.pathname === '/v1/default/banks') {
      payload = {
        banks: banks.map((bank) => ({
          bank_id: bank.id,
          fact_count: bank.factCount ?? 0,
          last_write_at: bank.lastWriteAt ?? '2026-09-27T01:02:03+00:00',
        })),
      }
    } else {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"detail":"not found"}')
      return
    }
    const body = JSON.stringify(payload)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Load the plugin and capture the route plus the registered tools. */
function load(url, config = {}) {
  let route
  const tools = []
  const ctx = {
    inject: (deps, cb) => {
      if (deps.includes('tools')) cb({ tools: { register: (def) => tools.push(def) } })
    },
    get: (name) => (name === 'webServer' ? { register: (r) => { route = r; return () => {} } } : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  apply(ctx, { apiUrl: url, seedEnginePath: FAKE_ENGINE, ...config })
  assert.ok(route, 'a webServer must have received the route')
  return { route, tools, tool: (name) => tools.find((t) => t.name === name) }
}

/** Drive the captured route with a synthetic request. */
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

/** Wait for a detached child to leave its mark. */
async function waitForFile(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      // A file can exist before the write is flushed; require a parseable line.
      const raw = readFileSync(path, 'utf8').trim()
      if (raw !== '') return raw.split('\n').map((line) => JSON.parse(line))
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`the detached child never wrote ${path}`)
}

/* ------------------------------------------------------------- the readers */

test('a real repository is recognised and its HEAD is read', async () => {
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    const repo = makeRepo(root, 'plain')
    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'GET', '/local-memory/api/projects')
    const project = reply.json.projects.find((p) => p.path === repo)
    assert.equal(project.isGit, true)
    assert.equal(project.gitHead, headOf(repo))
    assert.equal(project.canSeed, true)
  } finally {
    await daemon.close()
    cleanup()
  }
})

test('HEAD of a linked worktree is read through the .git file', async () => {
  // The case a naive `readFileSync(join(dir, '.git', 'HEAD'))` gets wrong: in a
  // worktree `.git` is a FILE holding a `gitdir:` pointer, so that path is a
  // directory read, not a file read, and the head would silently come back null.
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    const main = makeRepo(root, 'main')
    const wt = join(root, 'wt')
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', wt, '-b', 'side'], { cwd: root })
    assert.equal(existsSync(join(wt, '.git')), true)
    assert.equal(readFileSync(join(wt, '.git'), 'utf8').startsWith('gitdir:'), true)

    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'GET', '/local-memory/api/projects')
    // The worktree resolves to the MAIN checkout, which is the project whose
    // bank it shares — that is what `gitRootOf` is for.
    const project = reply.json.projects.find((p) => p.path === main)
    assert.ok(project, 'the main checkout must be the discovered project')
    assert.equal(project.gitHead, headOf(main))
  } finally {
    await daemon.close()
    cleanup()
  }
})

test('HEAD is read from packed-refs when the loose ref is gone', async () => {
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    const repo = makeRepo(root, 'packed')
    execFileSync('git', ['pack-refs', '--all'], { cwd: repo })
    const sha = headOf(repo)
    const loose = join(repo, '.git', 'refs', 'heads', 'main')
    // `pack-refs` must really have removed the loose file, or this test would
    // pass through the ordinary path and prove nothing about packed refs.
    if (existsSync(loose)) rmSync(loose)
    assert.equal(existsSync(loose), false)
    assert.equal(readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/main')
    assert.match(readFileSync(join(repo, '.git', 'packed-refs'), 'utf8'), /refs\/heads\/main/)

    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'GET', '/local-memory/api/projects')
    const project = reply.json.projects.find((p) => p.path === repo)
    assert.equal(project.gitHead, sha)
  } finally {
    await daemon.close()
    cleanup()
  }
})

test('a plain directory is reported as not a repository, not as "no memory yet"', async () => {
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    mkdirSync(join(root, 'just-a-folder'), { recursive: true })
    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'GET', '/local-memory/api/projects')
    const project = reply.json.projects.find((p) => p.path === root)
    assert.equal(project.isGit, false)
    assert.equal(project.canSeed, false, 'a folder with no history must never be offered a seed button')
    assert.equal(project.behind, null)
  } finally {
    await daemon.close()
    cleanup()
  }
})

/* -------------------------------------------------- what the panel reports */

test('a bank whose gitlog head matches the current commit is not "behind"', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const repo = makeRepo(root, 'current')
    const sha = headOf(repo)
    const daemon = await startDaemon({
      banks: [{ id: 'coding-agent::current', factCount: 12 }],
      documents: {
        'coding-agent::current': [
          { id: 'gitlog:current', tags: [`gitlog-head:${sha}`, 'source:git'], updated_at: '2026-09-27T03:00:00+00:00' },
        ],
      },
    })
    try {
      const { route } = load(daemon.url, { root })
      const reply = await call(route, 'GET', '/local-memory/api/projects')
      const project = reply.json.projects.find((p) => p.path === repo)
      assert.equal(project.hasMemory, true)
      assert.equal(project.behind, false)
      assert.equal(project.seededAt, '2026-09-27T03:00:00+00:00')
    } finally {
      await daemon.close()
    }
  } finally {
    cleanup()
  }
})

test('a bank left at an older commit is reported as behind', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const repo = makeRepo(root, 'stale', 'first')
    const staleSha = headOf(repo)
    writeFileSync(join(repo, 'file.txt'), 'second\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'second'], { cwd: repo })
    const daemon = await startDaemon({
      banks: [{ id: 'coding-agent::stale', factCount: 4 }],
      documents: {
        'coding-agent::stale': [{ id: 'gitlog:stale', tags: [`gitlog-head:${staleSha}`] }],
      },
    })
    try {
      const { route } = load(daemon.url, { root })
      const reply = await call(route, 'GET', '/local-memory/api/projects')
      const project = reply.json.projects.find((p) => p.path === repo)
      assert.equal(project.behind, true)
    } finally {
      await daemon.close()
    }
  } finally {
    cleanup()
  }
})

test('a bank built only from conversations reports no seeded history', async () => {
  // This is the case the bank roster cannot show: a bank exists and has facts,
  // so it looks remembered, but no git history was ever ingested.
  const { root, cleanup } = makeRoot()
  try {
    const repo = makeRepo(root, 'chatonly')
    const daemon = await startDaemon({
      banks: [{ id: 'coding-agent::chatonly', factCount: 30 }],
      documents: {
        'coding-agent::chatonly': [{ id: 'conversation:abc', tags: ['source:chat'] }],
      },
    })
    try {
      const { route } = load(daemon.url, { root })
      const reply = await call(route, 'GET', '/local-memory/api/projects')
      const project = reply.json.projects.find((p) => p.path === repo)
      assert.equal(project.hasMemory, true)
      assert.equal(project.seededAt, undefined)
      assert.equal(project.behind, null, 'no seeded marker means unknown, never "up to date"')
    } finally {
      await daemon.close()
    }
  } finally {
    cleanup()
  }
})

test('a configured-but-missing engine turns seeding off and says so', async () => {
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    makeRepo(root, 'repo')
    const { route } = load(daemon.url, { root, seedEnginePath: join(root, 'nope-not-here.js') })
    const reply = await call(route, 'GET', '/local-memory/api/projects')
    assert.equal(reply.json.canSeed, false)
    assert.equal(reply.json.projects.find((p) => p.isGit).canSeed, false)
  } finally {
    await daemon.close()
    cleanup()
  }
})

/* -------------------------------------------------------------- the action */

test('POST /api/seed runs the engine as a real detached child', async () => {
  const { root, cleanup } = makeRoot()
  const marker = join(root, 'argv.jsonl')
  const daemon = await startDaemon()
  const previous = process.env.FAKE_DEEPEN_OUT
  process.env.FAKE_DEEPEN_OUT = marker
  try {
    const repo = makeRepo(root, 'seedme')
    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'POST', '/local-memory/api/seed', { path: repo })
    assert.equal(reply.status, 200)
    assert.equal(reply.json.results.length, 1)
    assert.equal(reply.json.results[0].ok, true)
    assert.equal(reply.json.results[0].bankId, 'coding-agent::seedme')

    const records = await waitForFile(marker)
    assert.equal(records.length, 1)
    // The exact argv matters: a missing --repo or a wrong harness would seed the
    // wrong bank, and a stub that only reported "spawn called" would not notice.
    assert.deepEqual(records[0].argv, [
      '--repo', repo,
      '--harness', 'dsh',
      '--gitlog-limit', '300',
    ])
  } finally {
    if (previous === undefined) delete process.env.FAKE_DEEPEN_OUT
    else process.env.FAKE_DEEPEN_OUT = previous
    await daemon.close()
    cleanup()
  }
})

test('a second seed of the same project is refused while the first is running', async () => {
  const { root, cleanup } = makeRoot()
  const marker = join(root, 'argv.jsonl')
  const daemon = await startDaemon()
  const previous = process.env.FAKE_DEEPEN_OUT
  process.env.FAKE_DEEPEN_OUT = marker
  try {
    const repo = makeRepo(root, 'twice')
    const { route } = load(daemon.url, { root })
    await call(route, 'POST', '/local-memory/api/seed', { path: repo })
    const second = await call(route, 'POST', '/local-memory/api/seed', { path: repo })
    assert.equal(second.json.results[0].ok, false)
    assert.match(second.json.results[0].error, /正在播种/)
    await waitForFile(marker)
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'only one child may run')
  } finally {
    if (previous === undefined) delete process.env.FAKE_DEEPEN_OUT
    else process.env.FAKE_DEEPEN_OUT = previous
    await daemon.close()
    cleanup()
  }
})

test('the in-flight state is reported back to the page', async () => {
  const { root, cleanup } = makeRoot()
  const marker = join(root, 'argv.jsonl')
  const daemon = await startDaemon()
  const previousOut = process.env.FAKE_DEEPEN_OUT
  const previousHold = process.env.FAKE_DEEPEN_HOLD_MS
  process.env.FAKE_DEEPEN_OUT = marker
  // Hold the child open so the in-flight state is observed rather than raced.
  process.env.FAKE_DEEPEN_HOLD_MS = '15000'
  try {
    const repo = makeRepo(root, 'inflight')
    const { route } = load(daemon.url, { root, scanTtlMs: 0 })
    await call(route, 'POST', '/local-memory/api/seed', { path: repo })
    const reply = await call(route, 'GET', '/local-memory/api/projects')
    const project = reply.json.projects.find((p) => p.path === repo)
    assert.equal(project.seeding, true)
    await waitForFile(marker)
  } finally {
    if (previousOut === undefined) delete process.env.FAKE_DEEPEN_OUT
    else process.env.FAKE_DEEPEN_OUT = previousOut
    if (previousHold === undefined) delete process.env.FAKE_DEEPEN_HOLD_MS
    else process.env.FAKE_DEEPEN_HOLD_MS = previousHold
    await daemon.close()
    cleanup()
  }
})

test('a run whose process is gone stops being reported as in flight', async () => {
  // Seen in a real browser: the panel said "播种完成" and "播种中…" at the same
  // time, because the in-flight flag only ever expired on a 20-minute timer.
  // It has to be retired against evidence, and a dead process is evidence.
  const { root, cleanup } = makeRoot()
  const marker = join(root, 'argv.jsonl')
  const daemon = await startDaemon()
  const previous = process.env.FAKE_DEEPEN_OUT
  process.env.FAKE_DEEPEN_OUT = marker
  try {
    const repo = makeRepo(root, 'deads')
    const { route } = load(daemon.url, { root, scanTtlMs: 0 })
    await call(route, 'POST', '/local-memory/api/seed', { path: repo })
    await waitForFile(marker)
    // The fake engine exits immediately, and it wrote no gitlog document, so
    // this is exactly the "the process died without landing anything" case.
    const deadline = Date.now() + 5000
    let last
    for (;;) {
      last = (await call(route, 'GET', '/local-memory/api/projects')).json
        .projects.find((p) => p.path === repo)
      if (last.seeding === false) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(last.seeding, false, 'a dead run must not keep claiming to be seeding')
    assert.equal(last.seededAt, undefined)
  } finally {
    if (previous === undefined) delete process.env.FAKE_DEEPEN_OUT
    else process.env.FAKE_DEEPEN_OUT = previous
    await daemon.close()
    cleanup()
  }
})

test('a run whose git history landed stops being reported as in flight', async () => {
  const { root, cleanup } = makeRoot()
  const marker = join(root, 'argv.jsonl')
  const documents = {}
  const daemon = await startDaemon({ banks: [{ id: 'coding-agent::landed', factCount: 1 }], documents })
  const previous = process.env.FAKE_DEEPEN_OUT
  const previousHold = process.env.FAKE_DEEPEN_HOLD_MS
  process.env.FAKE_DEEPEN_OUT = marker
  // Keep the process alive, so retirement is attributed to the landed document
  // rather than to the process being gone.
  process.env.FAKE_DEEPEN_HOLD_MS = '15000'
  try {
    const repo = makeRepo(root, 'landed')
    const { route } = load(daemon.url, { root, scanTtlMs: 0 })
    await call(route, 'POST', '/local-memory/api/seed', { path: repo })
    await waitForFile(marker)
    const before = (await call(route, 'GET', '/local-memory/api/projects')).json
      .projects.find((p) => p.path === repo)
    assert.equal(before.seeding, true, 'the process is still alive, so it is still in flight')

    // The engine writes the gitlog document as its last ingest step, well before
    // the process exits; that timestamp is what retires the run.
    documents['coding-agent::landed'] = [{
      id: 'gitlog:landed',
      tags: [`gitlog-head:${headOf(repo)}`, 'source:git'],
      updated_at: new Date(Date.now() + 1000).toISOString(),
    }]
    const after = (await call(route, 'GET', '/local-memory/api/projects')).json
      .projects.find((p) => p.path === repo)
    assert.equal(after.seeding, false)
    assert.ok(after.seededAt, 'the landed timestamp is what the page shows')
    assert.equal(after.behind, false)
  } finally {
    if (previous === undefined) delete process.env.FAKE_DEEPEN_OUT
    else process.env.FAKE_DEEPEN_OUT = previous
    if (previousHold === undefined) delete process.env.FAKE_DEEPEN_HOLD_MS
    else process.env.FAKE_DEEPEN_HOLD_MS = previousHold
    await daemon.close()
    cleanup()
  }
})

test('seeding a path that discovery never found is refused', async () => {
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    mkdirSync(join(root, 'inside'), { recursive: true })
    const { route } = load(daemon.url, { root })
    // A real repository, but outside every configured working root: this is the
    // check that stops the route from being a "spawn a process anywhere" button.
    const outside = makeRepo(mkdtempSync(join(tmpdir(), 'dsh-outside-')), 'elsewhere')
    const reply = await call(route, 'POST', '/local-memory/api/seed', { path: outside })
    assert.equal(reply.json.results[0].ok, false)
    assert.match(reply.json.results[0].error, /不在已发现的项目里/)
  } finally {
    await daemon.close()
    cleanup()
  }
})

test('a relative path is refused', async () => {
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'POST', '/local-memory/api/seed', { path: 'some/repo' })
    assert.equal(reply.json.results[0].ok, false)
    assert.match(reply.json.results[0].error, /绝对路径/)
  } finally {
    await daemon.close()
    cleanup()
  }
})

test('a discovered directory that is not a repository is refused', async () => {
  const { root, cleanup } = makeRoot()
  const daemon = await startDaemon()
  try {
    // The root itself is always discovered, so it is a valid target that is not
    // a repository — the case that must be refused with a reason, not a crash.
    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'POST', '/local-memory/api/seed', { path: root })
    assert.equal(reply.json.results[0].ok, false)
    assert.match(reply.json.results[0].error, /不是 git 仓库/)
  } finally {
    await daemon.close()
    cleanup()
  }
})

test('a batch reports per-path outcomes rather than all-or-nothing', async () => {
  const { root, cleanup } = makeRoot()
  const marker = join(root, 'argv.jsonl')
  const daemon = await startDaemon()
  const previous = process.env.FAKE_DEEPEN_OUT
  process.env.FAKE_DEEPEN_OUT = marker
  try {
    const good = makeRepo(root, 'good')
    const alsoGood = makeRepo(root, 'also-good')
    const { route } = load(daemon.url, { root })
    const reply = await call(route, 'POST', '/local-memory/api/seed', {
      paths: [good, root, alsoGood, '/tmp'],
    })
    const byPath = {}
    for (const entry of reply.json.results) byPath[entry.path] = entry
    assert.equal(byPath[good].ok, true)
    assert.equal(byPath[alsoGood].ok, true)
    assert.equal(byPath[root].ok, false)
    assert.equal(byPath['/tmp'].ok, false)
    const records = await waitForFile(marker)
    assert.equal(records.length, 2, 'exactly the two valid repositories may be spawned')
  } finally {
    if (previous === undefined) delete process.env.FAKE_DEEPEN_OUT
    else process.env.FAKE_DEEPEN_OUT = previous
    await daemon.close()
    cleanup()
  }
})

test('GET /api/seed is refused with 405 and an Allow header', async () => {
  const daemon = await startDaemon()
  try {
    const { route } = load(daemon.url)
    const reply = await call(route, 'GET', '/local-memory/api/seed')
    assert.equal(reply.status, 405)
    assert.equal(reply.headers.allow, 'POST')
  } finally {
    await daemon.close()
  }
})

test('an absurd batch is refused before anything is spawned', async () => {
  const daemon = await startDaemon()
  try {
    const { route } = load(daemon.url)
    const reply = await call(route, 'POST', '/local-memory/api/seed', {
      paths: new Array(65).fill('/tmp'),
    })
    assert.equal(reply.status, 400)
  } finally {
    await daemon.close()
  }
})

/* ---------------------------------------------------------------- the tool */

test('memory_seed with no arguments reports what could be seeded', async () => {
  const { root, cleanup } = makeRoot()
  try {
    makeRepo(root, 'alpha')
    makeRepo(root, 'beta')
    const daemon = await startDaemon({ banks: [{ id: 'coding-agent::alpha', factCount: 5 }] })
    try {
      const { tool } = load(daemon.url, { root })
      const text = await tool('memory_seed').execute({})
      assert.match(text, /2 git repository/)
      assert.match(text, /1 with no memory yet/)
      assert.match(text, /beta/)
      assert.doesNotMatch(text, /alpha  →/, 'a project that already has memory is not offered')
    } finally {
      await daemon.close()
    }
  } finally {
    cleanup()
  }
})

test('memory_seed all:true spawns only git repositories without memory', async () => {
  const { root, cleanup } = makeRoot()
  const marker = join(root, 'argv.jsonl')
  const previous = process.env.FAKE_DEEPEN_OUT
  process.env.FAKE_DEEPEN_OUT = marker
  try {
    const fresh = makeRepo(root, 'fresh')
    const remembered = makeRepo(root, 'remembered')
    mkdirSync(join(root, 'plain-folder'), { recursive: true })
    const daemon = await startDaemon({ banks: [{ id: 'coding-agent::remembered', factCount: 5 }] })
    try {
      const { tool } = load(daemon.url, { root })
      const text = await tool('memory_seed').execute({ all: true })
      assert.match(text, /正在后台播种/)
      const records = await waitForFile(marker)
      assert.equal(records.length, 1)
      assert.equal(records[0].argv[1], fresh)
      assert.ok(!records.some((r) => r.argv[1] === remembered), 'a project with memory must be skipped')
      assert.ok(!records.some((r) => r.argv[1] === join(root, 'plain-folder')), 'a plain folder must be skipped')
    } finally {
      await daemon.close()
    }
  } finally {
    if (previous === undefined) delete process.env.FAKE_DEEPEN_OUT
    else process.env.FAKE_DEEPEN_OUT = previous
    cleanup()
  }
})

test('memory_projects separates seedable repositories from plain folders', async () => {
  const { root, cleanup } = makeRoot()
  try {
    makeRepo(root, 'a-repo')
    // An empty subdirectory is deliberately NOT a project: discovery reports
    // repositories and the working roots themselves. Listing every folder would
    // bury the handful that matter, and a bank created by a session in some
    // other subdirectory still surfaces — in the "matches no project" group.
    mkdirSync(join(root, 'not-a-repo'), { recursive: true })
    const daemon = await startDaemon()
    try {
      const { tool } = load(daemon.url, { root })
      const text = await tool('memory_projects').execute()
      assert.match(text, /Git repositories with no memory yet/)
      assert.match(text, /NOT repositories, nothing to seed/)
      assert.ok(text.includes(`- ${root}\n`), 'the working root itself is the plain directory reported')
      assert.doesNotMatch(text, /not-a-repo/)
    } finally {
      await daemon.close()
    }
  } finally {
    cleanup()
  }
})
