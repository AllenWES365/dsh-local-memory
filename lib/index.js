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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
  + '🧠 banner, the per-project bank layout, and how to configure, diagnose, or repair it.'

const SKILL_WHEN_TO_USE = 'the user asks about long-term memory, project memory, memory banks, why '
  + 'something is or is not remembered, or wants local memory configured.'

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
  const SCAN_TTL_MS = 15000

  const discoverProjects = async () => {
    if (scanCache.value !== undefined && Date.now() - scanCache.at < SCAN_TTL_MS) {
      return scanCache.value
    }

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
    const projects = [...paths].sort().map((path) => {
      const bankId = bankIdForProject(path)
      const bank = banks.get(bankId)
      if (bank !== undefined) banks.delete(bankId)
      return {
        path,
        bankId,
        factCount: bank?.factCount,
        lastWriteAt: bank?.lastWriteAt,
        hasMemory: bank !== undefined,
      }
    })

    // Banks left over belong to no project found on disk — an archived project,
    // a workspace that has since moved, or a name that never matched the rule.
    // Reported rather than hidden, because an unexplained bank is exactly the
    // kind of leftover this view exists to expose.
    const unmatched = [...banks.values()].map((bank) => ({
      bankId: bank.id,
      factCount: bank.factCount,
      lastWriteAt: bank.lastWriteAt,
    }))

    const value = { roots, projects, unmatched, scannedAt: Date.now() }
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
        parts.push(`- ${p.path}`, `    ${p.bankId}  (${p.factCount ?? '?'} facts${when})`)
      }
    }
    if (without.length > 0) {
      parts.push('', '## Project found, no memory yet')
      for (const p of without) {
        parts.push(`- ${p.path}`, `    will become ${p.bankId}`)
      }
      parts.push('', 'Run one session inside a directory listed here and its bank is created and '
        + 'seeded from that project\'s git history automatically.')
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
    return parts.join('\n')
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
