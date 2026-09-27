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

export const name = 'local-memory'

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
  const extractTexts = (data) => {
    const items = Array.isArray(data?.results) ? data.results : []
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
  const registerRoutes = (webCtx) => {
    const webServer = webCtx.webServer ?? webCtx.get('webServer')
    if (webServer === undefined) return
    webCtx.effect(() => webServer.register({
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
  if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], registerRoutes)
  else registerRoutes(ctx)
}

export default { name, apply }
