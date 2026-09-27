/**
 * dsh-local-memory — host half
 *
 * The problem this solves: Hindsight has no bank hierarchy. Banks are flat, so
 * you must choose between
 *   (a) one shared bank  — a single "CEO" session sees every project, but the
 *       projects are no longer isolated (recall is bank-wide), or
 *   (b) one bank per repo — clean isolation, but the CEO session's own bank
 *       stays empty, so it can see nothing.
 *
 * This plugin keeps (b) — real per-project isolation, because Hindsight already
 * does it — and adds the missing cross-project view on top by fanning out over
 * the daemon's HTTP API at read time. The aggregate is a VIEW, never a second
 * copy, so there is nothing to keep in sync and no data is duplicated.
 *
 * Verified against the local daemon before writing this:
 *   GET  /v1/default/banks                             -> lists every bank
 *   POST /v1/default/banks/{bank}/memories/recall      -> per-bank recall
 *   (bank isolation and cross-bank fan-out both confirmed with two probe banks)
 */

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'local-memory'

/**
 * Directories never worth descending into when looking for projects. These are
 * dependency trees, build output and caches — a repository nested inside them is
 * a vendored copy, not a project of the user's.
 */
const SCAN_SKIP = new Set([
  'node_modules', '.git', '.pnpm-store', '.cache', '.venv', 'venv',
  'dist', 'build', 'out', 'target', 'vendor', 'Library', '.Trash',
])

/**
 * One repository discovered on disk.
 *
 * `bankId` is derived exactly the way the Hindsight plugin derives it — the
 * rule is `coding-agent::` + the main worktree's directory name, resolved from
 * `git rev-parse --git-common-dir`. Worktrees therefore resolve to the main
 * checkout's name, which is what the plugin does too, so a prediction here and
 * a bank created later agree.
 */
const bankIdForProject = (root) => `coding-agent::${basename(root)}`

/** Resolve the main checkout for a directory that contains a `.git` entry. */
const gitRootOf = (dir, gitEntryPath, isDirectory) => {
  if (isDirectory) return dir
  // A `.git` FILE means a linked worktree (or a submodule). Its gitdir points at
  // `<main>/.git/worktrees/<name>`, so the main checkout is three levels up.
  try {
    const pointer = readFileSync(gitEntryPath, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (match === null) return dir
    const gitdir = resolve(dir, match[1])
    if (basename(dirname(gitdir)) === 'worktrees') {
      const mainGit = dirname(dirname(gitdir))
      return basename(mainGit) === '.git' ? dirname(mainGit) : dir
    }
    return dir
  } catch {
    return dir
  }
}

/**
 * The real git directory behind a `.git` entry.
 *
 * A `.git` DIRECTORY is the ordinary case. A `.git` FILE is a linked worktree or
 * a submodule and holds a `gitdir:` pointer, so the actual object store — and
 * therefore `HEAD` — lives somewhere else entirely. Reading `HEAD` without
 * following that pointer silently reports "no head", which is why this exists
 * separately from `gitRootOf`: the two answer different questions.
 */
const gitDirOf = (dir, gitEntryPath, isDirectory) => {
  if (isDirectory) return gitEntryPath
  try {
    const pointer = readFileSync(gitEntryPath, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    return match === null ? null : resolve(dir, match[1].trim())
  } catch {
    return null
  }
}

const SHA_RE = /^[0-9a-f]{40}$/

/**
 * The commit `HEAD` currently points at, read from disk.
 *
 * Deliberately not `git rev-parse`: discovery walks a whole drive and this runs
 * per repository, so spawning a process each time would dominate the scan. Two
 * small file reads answer the same question. Everything is guarded — an unborn
 * branch, a packed ref, a corrupt file and a bare-repo oddity all mean "cannot
 * tell", which must never break the settings page.
 */
const gitHeadSha = (gitDir) => {
  if (gitDir === null) return null
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    // A detached HEAD holds the sha directly.
    if (!head.startsWith('ref:')) return SHA_RE.test(head) ? head : null
    const ref = head.slice(4).trim()
    if (ref === '') return null
    try {
      const sha = readFileSync(join(gitDir, ref), 'utf8').trim()
      return SHA_RE.test(sha) ? sha : null
    } catch {
      // A ref that has been packed is no longer a loose file.
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
      for (const line of packed.split('\n')) {
        if (line === '' || line.startsWith('#') || line.startsWith('^')) continue
        const [sha, name] = line.trim().split(/\s+/)
        if (name === ref && SHA_RE.test(sha ?? '')) return sha
      }
      return null
    }
  } catch {
    return null
  }
}

/**
 * The Hindsight plugin's own seeding engine.
 *
 * `deepen.js` is what the plugin spawns on session start to create a bank and
 * ingest git history — it is not a reimplementation, it is the same entry point.
 * It is reachable as a real subpath export (`"./dist/*"` is in that package's
 * `exports` map), so resolving it is a supported lookup rather than reaching
 * into a private file.
 *
 * Resolution has to be tolerant because this plugin and that one can be
 * installed by different mechanisms: side by side under `npm install` (a plain
 * sibling resolve works), or each linked separately into a DSH profile (it does
 * not). The profile directories are therefore searched too, and a miss is
 * reported rather than guessed at.
 */
const SEED_PACKAGE = '@vectorize-io/hindsight-coding-agents'
const SEED_SUBPATH = `${SEED_PACKAGE}/dist/deepen.js`

const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a pid is still running.
 *
 * Signal 0 performs the existence and permission checks without delivering
 * anything. `EPERM` means the process exists but belongs to another user, which
 * still counts as alive.
 */
const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const resolveSeedEngine = (fromUrl, dshHome) => {
  const candidates = []
  try {
    const here = dirname(fileURLToPath(fromUrl))
    candidates.push(createRequire(join(here, 'noop.js')).resolve(SEED_SUBPATH))
  } catch {
    // Not installed as a sibling; the profile search below covers the rest.
  }

  let dir = dirname(fileURLToPath(fromUrl))
  for (let i = 0; i < 8; i += 1) {
    candidates.push(join(dir, 'node_modules', SEED_PACKAGE, 'dist', 'deepen.js'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const homes = [dshHome, process.env.DSH_HOME, join(homedir(), '.dsh')]
  for (const home of homes) {
    if (typeof home !== 'string' || home === '') continue
    let profiles
    try {
      profiles = readdirSync(join(home, 'profiles'), { withFileTypes: true })
    } catch {
      continue
    }
    for (const profile of profiles) {
      candidates.push(join(home, 'profiles', profile.name, 'node_modules', SEED_PACKAGE, 'dist', 'deepen.js'))
    }
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate
  }
  return null
}

/**
 * Repositories beneath `root`, to a bounded depth.
 *
 * Depth is bounded because the working roots here can be an entire drive: an
 * unbounded walk would be slow and would surface vendored copies inside
 * dependency trees, which SCAN_SKIP already excludes.
 */
const findProjects = (root, maxDepth = 4) => {
  const found = []
  const seen = new Set()
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.name === '.git') {
        const isDir = entry.isDirectory()
        if (!isDir && !entry.isFile()) continue
        const projectRoot = gitRootOf(dir, full, isDir)
        if (!seen.has(projectRoot)) {
          seen.add(projectRoot)
          found.push(projectRoot)
        }
        continue
      }
      if (depth >= maxDepth) continue
      if (!entry.isDirectory()) continue
      if (SCAN_SKIP.has(entry.name) || entry.name.startsWith('.')) continue
      walk(full, depth + 1)
    }
  }
  walk(root, 1)
  return found
}

/**
 * Whether a discovered directory is a repository, and where its git dir is.
 *
 * Only the directory's OWN `.git` counts. A plain folder under a working root is
 * not a repository, and that distinction is the whole point: a bank only ever
 * reaches `synced` through a `gitlog:<repo>` document, which can only be
 * produced from real git history. Reporting both kinds as "no memory yet" hides
 * which rows can actually be filled.
 */
const gitInfoFor = (root) => {
  const entry = join(root, '.git')
  let stats
  try {
    stats = statSync(entry)
  } catch {
    return { isGit: false, gitDir: null, head: null }
  }
  if (!stats.isDirectory() && !stats.isFile()) return { isGit: false, gitDir: null, head: null }
  const gitDir = gitDirOf(root, entry, stats.isDirectory())
  return { isGit: gitDir !== null, gitDir, head: gitHeadSha(gitDir) }
}

/**
 * The operator skill, read from `skill/SKILL.md` at apply time.
 *
 * The file keeps its YAML frontmatter so it is also a valid standalone skill a
 * user could copy into `.agents/skills/`, but the frontmatter is stripped before
 * registration: name and description are supplied as fields, and leaving the
 * block in `content` would show the agent its own metadata as body text.
 *
 * Returns undefined rather than throwing when the file is unreadable — a
 * packaging mistake must not take the whole profile boot down with it.
 */
const readSkillBody = () => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, '..', 'skill', 'SKILL.md'), 'utf8')
    const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    const body = withoutFrontmatter.trim()
    return body === '' ? undefined : body
  } catch {
    return undefined
  }
}

const SKILL_DESCRIPTION = 'How this machine\'s long-term memory works — the Hindsight daemon behind the '
  + '🧠 banner, the per-project bank layout, how to create a bank for a project that has none '
  + '(seeding), and how to configure, diagnose, or repair it.'

const SKILL_WHEN_TO_USE = 'the user asks about long-term memory, project memory, memory banks, why '
  + 'something is or is not remembered, wants a project remembered or backfilled, or wants local '
  + 'memory configured.'

/** Tuned defaults; every one is overridable from the profile patch `config`. */
const DEFAULT_API_URL = 'http://127.0.0.1:9077'
const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_CONCURRENCY = 6
/** Hits kept per bank. A bank can return dozens; uncapped output floods the turn. */
const DEFAULT_MAX_PER_BANK = 5
/**
 * When a sweep is slow, say so and say why. The time threshold comes from
 * measurement, not guessing: a bank holding ~60 memories really does cost about
 * a second, so anything past this is worth explaining.
 */
const WIDE_SEARCH_BANKS = 8
const SLOW_SEARCH_MS = 1000

export function apply(ctx, config = {}) {
  const apiUrl = String(config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
  const bankPrefix = typeof config.bankPrefix === 'string' && config.bankPrefix !== ''
    ? config.bankPrefix
    : ''
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const concurrency = Number.isFinite(config.concurrency) && config.concurrency > 0
    ? Math.floor(config.concurrency)
    : DEFAULT_CONCURRENCY
  const maxPerBank = Number.isFinite(config.maxPerBank) && config.maxPerBank > 0
    ? Math.floor(config.maxPerBank)
    : DEFAULT_MAX_PER_BANK

  /** One GET against the daemon, bounded in time. Returns parsed JSON. */
  const daemonGet = async (path) => {
    const res = await fetch(`${apiUrl}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
    }
    return res.json()
  }

  /** One POST against the daemon, bounded in time. Returns parsed JSON. */
  const daemonPost = async (path, payload) => {
    const res = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
    }
    return res.json()
  }

  /**
   * Every bank the daemon knows about, narrowed by the optional prefix, with the
   * two facts that make TARGETING an informed choice rather than a guess.
   *
   * Both come from the roster endpoint and both matter for cost:
   *   factCount  — a bank holding hundreds of facts (and tens of thousands of
   *                graph links between them) costs about a second per recall,
   *                while a bank holding a handful answers in tens of milliseconds.
   *   lastWriteAt — when the bank last learned something, which is usually the
   *                best available hint about whether it is relevant at all.
   *
   * Reads only leaf scalars — never returns the live response object upward.
   */
  const listBanksDetailed = async () => {
    const data = await daemonGet('/v1/default/banks')
    const raw = Array.isArray(data?.banks) ? data.banks : []
    return raw
      .map((entry) => {
        if (!entry || typeof entry.bank_id !== 'string') return undefined
        return {
          id: entry.bank_id,
          factCount: Number.isFinite(entry.fact_count) ? entry.fact_count : undefined,
          lastWriteAt: typeof entry.last_write_at === 'string' ? entry.last_write_at : undefined,
        }
      })
      .filter((bank) => bank !== undefined
        && (bankPrefix === '' || bank.id.startsWith(bankPrefix)))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Just the ids, in the same order — what a sweep needs. */
  const listBanks = async () => (await listBanksDetailed()).map((bank) => bank.id)

  /** Run `worker` over `items` with a bounded number in flight. */
  const mapLimit = async (items, limit, worker) => {
    const out = new Array(items.length)
    let cursor = 0
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      for (;;) {
        const index = cursor++
        if (index >= items.length) return
        out[index] = await worker(items[index], index)
      }
    })
    await Promise.all(runners)
    return out
  }

  /** Pull the readable strings out of one recall response. */
  const extractTexts = (data) => {    const items = Array.isArray(data?.results) ? data.results : []
    return items
      .map((item) => {
        if (typeof item === 'string') return item
        const candidate = item?.content ?? item?.text ?? item?.memory
        return typeof candidate === 'string' ? candidate : undefined
      })
      .filter((text) => typeof text === 'string' && text.trim() !== '')
  }

  /**
   * Recall from one bank; a failure here never aborts the other banks.
   *
   * `types: ["observation"]` asks for the consolidated beliefs only. Without it
   * the daemon returns the raw memory AND the observation derived from it, which
   * reads as the same fact twice. Observations are produced by background
   * consolidation, so a bank that was written to moments ago may have none yet —
   * in that case fall back to the unfiltered query rather than reporting nothing.
   */
  const recallOne = async (bankId, query) => {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`
    try {
      const observations = extractTexts(
        await daemonPost(path, { query, types: ['observation'] }),
      )
      if (observations.length > 0) return { bankId, texts: observations, error: undefined }
      const all = extractTexts(await daemonPost(path, { query }))
      return { bankId, texts: all, error: undefined }
    } catch (error) {
      return { bankId, texts: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  const textOutput = (value) => ({
    schema: { type: 'string' },
    render: (_args, rendered) => [{ type: 'text', text: String(rendered) }],
  })

  /* ------------------------------------------------------------------ *
   * Project discovery.
   *
   * The daemon's bank list answers "what do I remember?". It cannot answer
   * "what SHOULD I remember?" — a project with no bank simply is not in it, so
   * silence looks identical to not-existing. That is the wrong half of the
   * question: a user with ten repositories and one bank needs to see nine
   * missing, by name.
   *
   * So this walks the registered workspaces for repositories and derives each
   * one's expected bank id, using the same rule the Hindsight plugin uses. The
   * result is a prediction it will honour when a session first runs there.
   * ------------------------------------------------------------------ */

  const scanDepth = Number.isFinite(config.scanDepth) && config.scanDepth > 0
    ? Math.floor(config.scanDepth)
    : 4

  /** Cached because a scan can walk a whole drive; short TTL, not a store. */
  let scanCache = { at: 0, value: undefined }
  const SCAN_TTL_MS = Number.isFinite(config.scanTtlMs) && config.scanTtlMs >= 0
    ? Math.floor(config.scanTtlMs)
    : 15000

  /* --- seeding: the missing half of the project view ------------------ */

  /**
   * Resolved once. A miss is not fatal and is not hidden either: the view still
   * works, it reports that seeding is unavailable and names the reason, rather
   * than drawing a button that could only ever fail.
   *
   * `seedEnginePath` is an explicit override for an installation this plugin
   * cannot find on its own. A path that is configured but wrong resolves to
   * nothing rather than silently falling back, so the page reports the operator's
   * own configuration back to them instead of quietly using a different engine.
   */
  const seedEngine = typeof config.seedEnginePath === 'string' && config.seedEnginePath !== ''
    ? (isFile(config.seedEnginePath) ? config.seedEnginePath : null)
    : resolveSeedEngine(import.meta.url, config.dshHome)
  const seedHarness = typeof config.seedHarness === 'string' && config.seedHarness !== ''
    ? config.seedHarness
    : 'dsh'
  const seedLimit = Number.isFinite(config.seedLimit) && config.seedLimit > 0
    ? Math.floor(config.seedLimit)
    : 300

  /**
   * Seeds started by THIS process, keyed by project path, holding
   * `{ startedAt, pid }`.
   *
   * In memory on purpose. It exists to stop a second click while a run is going,
   * and a "seeding…" that outlived its own process would be a lie — the whole
   * point of this panel is that its claims are checkable. Entries are retired by
   * evidence (the run landed, or the process is gone), never by a timer alone.
   */
  const seedsInFlight = new Map()
  const SEED_GRACE_MS = 20 * 60 * 1000

  /** Backstop for a run whose process has been reused or whose bank vanished. */
  const pruneSeeds = () => {
    const cutoff = Date.now() - SEED_GRACE_MS
    for (const [path, entry] of seedsInFlight) {
      if (entry.startedAt < cutoff) seedsInFlight.delete(path)
    }
  }

  /**
   * The `gitlog:` document of a bank, if it has one.
   *
   * Found by scanning rather than by fetching a predicted id: the document is
   * normally named after the repository directory, but `banks.<id>.bank` can
   * point several repos at one renamed bank, and a predicted id would then be
   * confidently wrong. Listing is authoritative.
   */
  const gitlogStateOf = async (bankId) => {
    try {
      const data = await daemonGet(`/v1/default/banks/${encodeURIComponent(bankId)}/documents?limit=200`)
      const items = Array.isArray(data?.items) ? data.items : []
      const doc = items.find((item) => typeof item?.id === 'string' && item.id.startsWith('gitlog:'))
      if (doc === undefined) return undefined
      const tags = Array.isArray(doc.tags) ? doc.tags : []
      const headTag = tags.find((tag) => typeof tag === 'string' && tag.startsWith('gitlog-head:'))
      return {
        at: typeof doc.updated_at === 'string'
          ? doc.updated_at
          : (typeof doc.created_at === 'string' ? doc.created_at : undefined),
        head: headTag === undefined ? undefined : headTag.slice('gitlog-head:'.length),
      }
    } catch {
      // A bank whose documents cannot be listed must not break the whole scan.
      return undefined
    }
  }

  /**
   * Start the Hindsight seeding engine for one repository.
   *
   * This runs the plugin's own `deepen.js`, detached, exactly as that plugin
   * does on session start — same bank, same `gitlog` strategy, same target. It
   * is not a reimplementation of the seeding logic, so there is nothing here
   * that can drift away from what a session would have produced.
   */
  const startSeed = (projectPath) => {
    if (seedEngine === null) {
      return { ok: false, error: '找不到 Hindsight 的播种引擎（deepen.js）' }
    }
    if (seedsInFlight.has(projectPath)) return { ok: false, error: '这个项目正在播种中' }
    if (!gitInfoFor(projectPath).isGit) return { ok: false, error: '不是 git 仓库，没有历史可播种' }
    try {
      const child = spawn(process.execPath, [
        seedEngine,
        '--repo', projectPath,
        '--harness', seedHarness,
        '--gitlog-limit', String(seedLimit),
      ], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
      seedsInFlight.set(projectPath, { startedAt: Date.now(), pid: child.pid })
      return { ok: true, bankId: bankIdForProject(projectPath), pid: child.pid }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Reject anything that is not a repository already found by discovery.
   *
   * The route spawns a process, so the path it accepts must be one this plugin
   * itself discovered — never an arbitrary string from the page. Re-running the
   * same discovery (which is cached) is the check: membership in that set is the
   * authorisation, and it is the same set the buttons were drawn from.
   */
  const authoriseSeed = async (rawPath) => {
    if (typeof rawPath !== 'string' || rawPath === '' || !isAbsolute(rawPath)) {
      return { ok: false, error: 'path 必须是绝对路径' }
    }
    const wanted = resolve(rawPath)
    const data = await discoverProjects()
    const hit = data.projects.find((project) => project.path === wanted)
    if (hit === undefined) {
      return { ok: false, error: '这个路径不在已发现的项目里' }
    }
    if (!hit.isGit) return { ok: false, error: '不是 git 仓库，没有历史可播种' }
    return { ok: true, project: hit }
  }

  const discoverProjects = async () => {
    if (scanCache.value !== undefined && Date.now() - scanCache.at < SCAN_TTL_MS) {
      return scanCache.value
    }
    pruneSeeds()

    // Roots come from the durable workspace registry when it is available; the
    // session's own directory is always a root, so discovery still works before
    // the registry has loaded.
    const roots = []
    const push = (value) => {
      if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value)
    }
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) push(workspace?.path)
      } catch {
        // A registry that will not enumerate must not break discovery.
      }
    }
    push(config.root)

    const paths = new Set()
    for (const root of roots) {
      // The root ITSELF is a candidate: a session started there gets a bank named
      // after the directory, whether or not the directory is a repository. Setting
      // a working root to a plain folder is the normal case here, and omitting it
      // reported its bank as matching no project.
      paths.add(root)
      for (const project of findProjects(root, scanDepth)) paths.add(project)
    }

    const banks = new Map((await listBanksDetailed()).map((bank) => [bank.id, bank]))
    const projects = []
    for (const path of [...paths].sort()) {
      const bankId = bankIdForProject(path)
      const bank = banks.get(bankId)
      if (bank !== undefined) banks.delete(bankId)
      const git = gitInfoFor(path)

      // The `gitlog:` document is the plugin's own marker for "git history has
      // been ingested". Reading it is how this view can tell a bank that was
      // created by a conversation apart from one that actually holds history —
      // they look identical in the bank list, and only the first is `synced`.
      const seeded = bank === undefined ? undefined : await gitlogStateOf(bankId)

      // Retire a finished run HERE, against evidence, rather than on a timer.
      //
      // This is not bookkeeping: `seeding` drives the button's label, and a flag
      // that only ever expires made the page say "播种中…" under a line that
      // already read "播种完成" — observed in a real browser. A run is over when
      // the bank's own timestamp for when git history landed is at or after the
      // moment it started, or when the process is simply gone.
      const started = seedsInFlight.get(path)
      if (started !== undefined) {
        const landedAt = seeded?.at === undefined ? NaN : Date.parse(seeded.at)
        const landed = !Number.isNaN(landedAt) && landedAt >= started.startedAt - 60000
        if (landed || !isProcessAlive(started.pid)) seedsInFlight.delete(path)
      }

      projects.push({
        path,
        bankId,
        factCount: bank?.factCount,
        lastWriteAt: bank?.lastWriteAt,
        hasMemory: bank !== undefined,
        isGit: git.isGit,
        // Whether the memory still covers the current commit. `null` means the
        // question cannot be answered (no head, no seeded marker), which is
        // reported as unknown rather than as "up to date".
        behind: git.isGit && seeded?.head !== undefined && git.head !== null
          ? seeded.head !== git.head
          : null,
        gitHead: git.head,
        seededAt: seeded?.at,
        seeding: seedsInFlight.has(path),
        canSeed: git.isGit && seedEngine !== null,
      })
    }

    // Banks left over belong to no project found on disk — an archived project,
    // a workspace that has since moved, or a name that never matched the rule.
    // Reported rather than hidden, because an unexplained bank is exactly the
    // kind of leftover this view exists to expose.
    const unmatched = [...banks.values()].map((bank) => ({
      bankId: bank.id,
      factCount: bank.factCount,
      lastWriteAt: bank.lastWriteAt,
    }))

    const value = {
      roots,
      projects,
      unmatched,
      scannedAt: Date.now(),
      // Whether the seed action is available at all, so the page can say why no
      // button is drawn instead of silently omitting it.
      canSeed: seedEngine !== null,
      seedEngine,
    }
    scanCache = { at: Date.now(), value }
    return value
  }

  const renderProjects = (data) => {
    const withMemory = data.projects.filter((p) => p.hasMemory)
    const without = data.projects.filter((p) => !p.hasMemory)
    const parts = [`${data.roots.length} working root(s), ${data.projects.length} project(s) found, `
      + `${withMemory.length} with memory.`]

    if (withMemory.length > 0) {
      parts.push('', '## With memory')
      for (const p of withMemory) {
        const when = typeof p.lastWriteAt === 'string' ? `, last write ${p.lastWriteAt.slice(0, 16)}` : ''
        const seeded = p.seededAt !== undefined
          ? `, git history seeded ${String(p.seededAt).slice(0, 16)}`
          : (p.isGit
              ? ', but NO git history seeded yet (bank came from conversations only)'
              : ', not a git repository, so there is no history to seed')
        const behind = p.behind === true ? ', NEWER COMMITS ARE NOT IN MEMORY — re-seed to catch up' : ''
        parts.push(`- ${p.path}`, `    ${p.bankId}  (${p.factCount ?? '?'} facts${when}${seeded}${behind})`)
      }
    }
    if (without.length > 0) {
      const seedable = without.filter((p) => p.isGit)
      const notRepos = without.filter((p) => !p.isGit)
      if (seedable.length > 0) {
        parts.push('', '## Git repositories with no memory yet — these are seedable now')
        for (const p of seedable) {
          parts.push(`- ${p.path}`, `    will become ${p.bankId}`)
        }
      }
      if (notRepos.length > 0) {
        parts.push('', '## Plain directories with no memory — NOT repositories, nothing to seed')
        for (const p of notRepos) {
          parts.push(`- ${p.path}`, `    will become ${p.bankId} once a session runs there`)
        }
      }
      parts.push('', seedable.length > 0
        ? 'Call memory_seed with all: true to seed every repository above without opening a session '
          + 'in each one. Seeding runs in the background and takes about a minute per small '
          + 'repository, longer for a large one.'
        : 'Nothing here can be seeded: none of these directories is a git repository, so a bank can '
          + 'only be created by working in one.')
    }
    if (data.projects.length === 0) {
      parts.push('', 'No git repositories found under the working roots.')
    }
    if (data.unmatched.length > 0) {
      parts.push('', '## Banks that match no project on disk')
      for (const u of data.unmatched) {
        parts.push(`- ${u.bankId}  (${u.factCount ?? '?'} facts)`)
      }
    }
    if (data.canSeed === false) {
      parts.push('', 'NOTE: the Hindsight seeding engine (deepen.js) could not be found, so seeding '
        + 'is unavailable here. Memory will still be created by running a session in a project.')
    }
    return parts.join('\n')
  }

  /** What could be seeded right now — the answer to a bare `memory_seed` call. */
  const renderSeedPlan = (data) => {
    const seedable = data.projects.filter((p) => p.isGit)
    const fresh = seedable.filter((p) => !p.hasMemory)
    const stale = seedable.filter((p) => p.hasMemory && p.behind === true)
    const lines = [
      `${seedable.length} git repository/repositories under ${data.roots.length} working root(s):`,
      `- ${fresh.length} with no memory yet`,
      `- ${stale.length} whose memory is behind the current commit`,
      `- ${seedable.length - fresh.length - stale.length} already up to date or not comparable`,
    ]

    if (data.canSeed === false) {
      lines.push('', 'Seeding is UNAVAILABLE: the Hindsight seeding engine (deepen.js) was not found '
        + 'next to this plugin or in a DSH profile. Memory will still be created by running a '
        + 'session inside a project.')
      return lines.join('\n')
    }
    if (fresh.length > 0) {
      lines.push('', 'No memory yet:')
      for (const p of fresh) lines.push(`- ${p.path}  →  ${p.bankId}`)
    }
    if (stale.length > 0) {
      lines.push('', 'Memory behind the current commit:')
      for (const p of stale) lines.push(`- ${p.path}  →  ${p.bankId}`)
    }
    if (fresh.length === 0 && stale.length === 0) {
      lines.push('', 'Nothing to seed.')
      return lines.join('\n')
    }
    lines.push('', 'Call memory_seed again with all: true, or with path / paths to choose.')
    return lines.join('\n')
  }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'memory_banks',
      description:
        'List the long-term memory banks on this machine, with each bank\'s size and last-write '
        + 'time. Each project keeps its own bank (named after the repository), so this is the '
        + 'roster of "what this machine remembers". Use it before memory_recall_all when the user '
        + 'asks which projects have memory, or to check that a project has started accumulating '
        + 'any — and, more importantly, to CHOOSE WHICH BANKS TO SEARCH: size predicts cost (a '
        + 'bank of hundreds of facts costs about a second per search; a small one, tens of '
        + 'milliseconds) and the last-write time is the best hint about relevance. Searching the '
        + 'one or two banks that matter is the fast path; searching everything is the fallback '
        + 'for when you genuinely do not know where to look.',
      parameters: { type: 'object', properties: {} },
      output: textOutput(),
      async execute() {
        let banks
        try {
          banks = await listBanksDetailed()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return `Cannot reach the local memory daemon at ${apiUrl}.\n${detail}\n\n`
            + 'Start it by opening a session (the plugin starts it on demand), or check the '
            + 'Hindsight configuration at ~/.hindsight/coding-agent.json.'
        }
        if (banks.length === 0) {
          return bankPrefix === ''
            ? 'No memory banks yet. A bank is created the first time a session records something.'
            : `No memory banks matching prefix "${bankPrefix}".`
        }
        // Size and recency are shown because a targeted search is the normal case
        // and a full sweep is the exception: a bank holding hundreds of facts costs
        // about a second to search, so knowing which banks are large — and which
        // learned something recently — is what makes `banks` an informed choice
        // instead of a guess. See the tool description for the full guidance.
        const rows = banks.map((bank) => {
          const size = bank.factCount === undefined ? 'unknown size' : `${bank.factCount} facts`
          const when = bank.lastWriteAt === undefined
            ? 'never written'
            : `last write ${bank.lastWriteAt.slice(0, 16).replace('T', ' ')}`
          return `- ${bank.id}  (${size}, ${when})`
        })
        return `${banks.length} memory bank(s):\n${rows.join('\n')}`
      },
    })

    toolCtx.tools.register({
      name: 'memory_recall_all',
      description:
        'Search one, several, or every project memory bank and return the hits grouped by bank. '
        + 'PREFER THE NARROW FORM. Pass `banks` with the one or two banks that plausibly hold the '
        + 'answer (call memory_banks first to pick them by name, size and last-write time): that '
        + 'costs about a second per large bank. Omitting `banks` sweeps everything — roughly a '
        + 'second per large bank, so ten large projects is a ten-second wait — and is the right '
        + 'move only when you genuinely do not know where to look, such as "which project deals '
        + 'with X at all?". Use this rather than the current session\'s own memory when the '
        + 'question spans projects, or when this session has no memory of its own but another '
        + 'project does.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to look for, in natural language. Ask a real question.',
          },
          banks: {
            type: 'string',
            description:
              'Optional comma-separated bank ids to restrict the search. Omit to search all banks.',
          },
        },
        required: ['query'],
      },
      output: textOutput(),
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') return 'memory_recall_all needs a non-empty query.'

        let targets
        try {
          if (typeof args?.banks === 'string' && args.banks.trim() !== '') {
            targets = args.banks.split(',').map((id) => id.trim()).filter((id) => id !== '')
          } else {
            targets = await listBanks()
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return `Cannot reach the local memory daemon at ${apiUrl}.\n${detail}`
        }

        if (targets.length === 0) return 'No memory banks to search.'

        const startedAt = Date.now()
        const results = await mapLimit(targets, concurrency, (bankId) => recallOne(bankId, query))
        const elapsedMs = Date.now() - startedAt

        const sections = []
        const failures = []
        for (const result of results) {
          if (result.error !== undefined) {
            failures.push(`- ${result.bankId}: ${result.error}`)
            continue
          }
          if (result.texts.length === 0) continue
          const seen = new Set()
          const unique = []
          for (const text of result.texts) {
            if (seen.has(text)) continue
            seen.add(text)
            unique.push(text)
          }
          // Cap each bank so one deep bank cannot drown the others, and say so
          // rather than silently dropping the rest.
          const kept = unique.slice(0, maxPerBank)
          const overflow = unique.length - kept.length
          const more = overflow > 0 ? `\n- … ${overflow} more in this bank` : ''
          sections.push(`## ${result.bankId}\n${kept.map((t) => `- ${t}`).join('\n')}${more}`)
        }

        // Measured against the real daemon, and the numbers drive this wording.
        // Cost is per BANK and scales with how much a bank HOLDS: a bank with a
        // handful of facts answers in ~30ms, one holding ~60 answers in ~1s. No
        // client-side knob changes that — disabling reranking (which halves a
        // small bank's call, 85ms -> 37ms) leaves a deep bank at ~1.0s, and
        // max_tokens cutting 59 results to 3 leaves the time at ~1025ms, so the
        // work happens before truncation. Concurrency barely helps either
        // (1/6/13 within 20% of each other). So the trigger is ELAPSED TIME, not
        // width: two deep banks take two seconds just as surely as a dozen
        // shallow ones, and an earlier width-gated version stayed silent then.
        const header = `Searched ${targets.length} bank(s) in ${elapsedMs}ms for: ${query}`
        const parts = [header]
        if (elapsedMs >= SLOW_SEARCH_MS) {
          parts.push(
            '',
            targets.length >= WIDE_SEARCH_BANKS
              ? `Note: ${targets.length} banks took ${elapsedMs}ms. The daemon serves recalls`
                + ' largely serially, so a wide sweep is the sum of its banks. Pass the `banks`'
                + ' argument to search only the projects that matter for this question.'
              : `Note: this took ${elapsedMs}ms because a bank holding a lot of memories costs`
                + ' about a second to search, however few banks are involved. Narrowing the'
                + ' `banks` argument will not speed it up; a narrower query will.',
          )
        }
        if (sections.length > 0) parts.push('', sections.join('\n\n'))
        else parts.push('', 'No bank returned a match.')
        if (failures.length > 0) parts.push('', `Unreachable banks:\n${failures.join('\n')}`)
        return parts.join('\n')
      },
    })

    toolCtx.tools.register({
      name: 'memory_projects',
      description:
        'List every project on this machine and say which ones HAVE long-term memory, which have '
        + 'none yet, and what each one\'s bank will be called. Use this when the user asks what has '
        + 'memory, why a project is missing from the list, or which projects are not being '
        + 'remembered: memory_banks only reports banks that already exist, so a project that has '
        + 'never been worked in is simply absent from it and looks identical to not existing. This '
        + 'walks the registered working roots for git repositories and derives each expected bank '
        + 'id from the same rule the memory backend uses.',
      parameters: { type: 'object', properties: {} },
      output: textOutput(),
      async execute() {
        try {
          return renderProjects(await discoverProjects())
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return `Could not scan for projects.\n${detail}`
        }
      },
    })

    toolCtx.tools.register({
      name: 'memory_seed',
      description:
        'Create or refresh a project\'s long-term memory from its git history, without opening a '
        + 'session inside that project. Memory banks are otherwise created lazily the first time a '
        + 'session runs in a directory, which means a project you have not worked in yet has no '
        + 'memory at all. Use this when the user asks to set up / backfill / refresh memory for a '
        + 'project, or after memory_projects reports projects with no memory. With no arguments it '
        + 'lists what is seedable. Seeding runs in the background and takes roughly a minute for a '
        + 'small repository, longer for a large one; it is not finished when this returns.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path of one project to seed. Must be a git repository already '
              + 'found by memory_projects.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Several absolute project paths to seed at once.',
          },
          all: {
            type: 'boolean',
            description: 'Seed every discovered git repository that has no memory yet.',
          },
        },
      },
      output: textOutput(),
      async execute(args = {}) {
        try {
          const data = await discoverProjects()
          const requested = []
          if (Array.isArray(args.paths)) requested.push(...args.paths)
          if (typeof args.path === 'string' && args.path !== '') requested.push(args.path)
          if (args.all === true) {
            for (const project of data.projects) {
              if (project.isGit && !project.hasMemory) requested.push(project.path)
            }
          }
          if (requested.length === 0) return renderSeedPlan(data)

          const lines = []
          for (const target of requested) {
            const allowed = await authoriseSeed(target)
            if (!allowed.ok) {
              lines.push(`✗ ${target}\n    ${allowed.error}`)
              continue
            }
            const started = startSeed(allowed.project.path)
            lines.push(started.ok
              ? `✓ ${allowed.project.path}\n    正在后台播种到 ${started.bankId}，约一分钟后记忆开始出现`
              : `✗ ${allowed.project.path}\n    ${started.error}`)
          }
          scanCache = { at: 0, value: undefined }
          lines.push('', '用 memory_projects 复查进度；播种完成前该项目的记忆是不完整的。')
          return lines.join('\n')
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return `Could not start seeding.\n${detail}`
        }
      },
    })
  })

  /* ------------------------------------------------------------------ *
   * Settings-page HTTP routes.
   *
   * This is how the browser half reads data: it is served from the same
   * origin as this host, so it simply fetches these paths. There is no other
   * channel between the halves of a FILE plugin — the package-private
   * `harness.handle` RPC is a dynamic-plugin facility and is not available
   * here, which is why the market plugin registers routes the same way.
   * ------------------------------------------------------------------ */

  const sendJson = (response, status, payload) => {
    const body = JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  /** Read a JSON request body, bounded so a stray client cannot balloon memory. */
  const readJsonBody = async (request, limitBytes = 64 * 1024) => {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limitBytes) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /**
   * Register the routes, waiting for `webServer` if it is not mounted yet.
   *
   * A plain `ctx.get('webServer')` guard is WRONG here and shipped broken once:
   * plugin rows activate in parallel, so on a real boot the service is often not
   * there yet, the guard saw undefined, and the routes silently never existed —
   * the settings page then fetched a path the server answered with its own 404.
   * The failure was invisible in tests because a mock always had a webServer.
   *
   * `ctx.inject` is the documented way to wait for a service that must exist:
   * Cordis reactivates this plugin once `webServer` appears. The official
   * client-modules package uses this same get-else-inject shape for the same
   * reason.
   */
  const registerRoutes = (hostCtx, webServer) => {
    if (webServer === undefined) return
    hostCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/local-memory/api',
      handler: async (request, response) => {
        const path = (request.url ?? '').split('?')[0]
        try {
          // Distinguish a wrong method from a missing route: a client that sends
          // the wrong verb is told so, rather than being told the route is gone.
          if (path === '/local-memory/api/banks') {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            return sendJson(response, 200, { apiUrl, banks: await listBanksDetailed() })
          }

          if (path === '/local-memory/api/projects') {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            return sendJson(response, 200, await discoverProjects())
          }

          if (path === '/local-memory/api/seed') {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            const body = await readJsonBody(request)
            const targets = Array.isArray(body.paths) ? body.paths : [body.path]
            if (targets.length === 0 || targets.length > 64) {
              return sendJson(response, 400, { error: 'paths must hold 1..64 entries' })
            }
            const results = []
            for (const target of targets) {
              const allowed = await authoriseSeed(target)
              if (!allowed.ok) {
                results.push({ path: typeof target === 'string' ? target : String(target), ok: false, error: allowed.error })
                continue
              }
              const started = startSeed(allowed.project.path)
              results.push(started.ok
                ? { path: allowed.project.path, ok: true, bankId: started.bankId }
                : { path: allowed.project.path, ok: false, error: started.error })
            }
            // The answer is a claim about a process, so make the next scan tell
            // the truth about it rather than serving a pre-seed snapshot.
            scanCache = { at: 0, value: undefined }
            return sendJson(response, 200, { results })
          }

          if (path === '/local-memory/api/search') {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            const body = await readJsonBody(request)
            const query = typeof body.query === 'string' ? body.query.trim() : ''
            if (query === '') return sendJson(response, 400, { error: 'query must not be empty' })
            const requested = typeof body.banks === 'string' && body.banks.trim() !== ''
              ? body.banks.split(',').map((id) => id.trim()).filter((id) => id !== '')
              : undefined
            const targets = requested ?? await listBanks()
            if (targets.length === 0) {
              return sendJson(response, 200, { query, elapsedMs: 0, sections: [], failures: [] })
            }
            const startedAt = Date.now()
            const results = await mapLimit(targets, concurrency, (bankId) => recallOne(bankId, query))
            const sections = []
            const failures = []
            for (const result of results) {
              if (result.error !== undefined) {
                failures.push({ bankId: result.bankId, error: result.error })
                continue
              }
              const seen = new Set()
              const unique = []
              for (const text of result.texts) {
                if (seen.has(text)) continue
                seen.add(text)
                unique.push(text)
              }
              if (unique.length === 0) continue
              const kept = unique.slice(0, maxPerBank)
              sections.push({
                bankId: result.bankId,
                texts: kept,
                withheld: unique.length - kept.length,
              })
            }
            return sendJson(response, 200, {
              query,
              elapsedMs: Date.now() - startedAt,
              sections,
              failures,
            })
          }

          return sendJson(response, 404, { error: `no such route: ${request.method} ${path}` })
        } catch (error) {
          return sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'local-memory: settings api')
  }

  // Get it if it is already there; otherwise wait for Cordis to reactivate this
  // plugin once `webServer` mounts. Skipping registration silently is the bug
  // this replaces.
  //
  // The service is passed IN rather than read off the context: `ctx.webServer`
  // is an undeclared-access the Guard rejects when the plugin never declared
  // `inject: ['webServer']`, which is exactly the case in the get-it-now branch.
  const existingWebServer = ctx.get('webServer')
  if (existingWebServer === undefined) {
    ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx, webCtx.webServer))
  } else {
    registerRoutes(ctx, existingWebServer)
  }

  /* ------------------------------------------------------------------ *
   * Operator skill.
   *
   * `dsh-package-manifest` knows only `bundle` and `client`, so a plugin
   * cannot DECLARE a skill in package.json — but it can register one at mount
   * time, which is strictly better for the user: installing the plugin is the
   * whole setup, with nothing to copy into `.agents/skills/` by hand.
   *
   * The skill is documentation, not machinery: it collects what configuring
   * this backend actually cost (the bankId trap, the env-var-only LLM key, the
   * restart lock, the measured latency model, the in-place document replace)
   * so the next agent does not rediscover it.
   * ------------------------------------------------------------------ */

  const skillBody = readSkillBody()
  if (skillBody !== undefined) {
    const registerSkill = (hostCtx, skills) => {
      if (skills === undefined) return
      hostCtx.effect(() => skills.register({
        name: 'dsh-local-memory',
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content: skillBody,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
      }), 'local-memory: operator skill')
    }
    // Same get-else-inject shape, and the same reason for passing the service in.
    const existingSkills = ctx.get('skills')
    if (existingSkills === undefined) {
      ctx.inject(['skills'], (skillCtx) => registerSkill(skillCtx, skillCtx.skills))
    } else {
      registerSkill(ctx, existingSkills)
    }
  }
}

export default { name, apply }
