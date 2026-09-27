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
 * When a sweep is both wide and slow, say so in the result. Thresholds come
 * from measurement, not guessing: the daemon serves recalls largely serially at
 * roughly 150ms per bank, so this is where a sweep starts to feel slow.
 */
const SLOW_SEARCH_BANKS = 8
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
   * Every bank the daemon knows about, narrowed by the optional prefix.
   * Reads only leaf scalars — never returns the live response object upward.
   */
  const listBanks = async () => {
    const data = await daemonGet('/v1/default/banks')
    const raw = Array.isArray(data?.banks) ? data.banks : []
    return raw
      .map((entry) => (entry && typeof entry.bank_id === 'string' ? entry.bank_id : undefined))
      .filter((id) => typeof id === 'string' && (bankPrefix === '' || id.startsWith(bankPrefix)))
      .sort()
  }

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
        'List the long-term memory banks on this machine. Each project keeps its own bank '
        + '(named after the repository), so this is the roster of "what this machine remembers". '
        + 'Use it before memory_recall_all when the user asks which projects have memory, or to '
        + 'check that a project has started accumulating any.',
      parameters: { type: 'object', properties: {} },
      output: textOutput(),
      async execute() {
        let banks
        try {
          banks = await listBanks()
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
        return `${banks.length} memory bank(s):\n${banks.map((id) => `- ${id}`).join('\n')}`
      },
    })

    toolCtx.tools.register({
      name: 'memory_recall_all',
      description:
        'Search across EVERY project memory bank at once and return the hits grouped by bank. '
        + 'Use this to answer a question that spans several projects, or when the current session '
        + 'has no memory of its own but another project does. Pass `banks` to narrow the search to '
        + 'specific bank ids (comma-separated).',
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

        // The per-bank cost is paid by the daemon, and it does not shrink when
        // more requests are in flight — measured at roughly 150ms per bank with
        // concurrency 1, 6 and 13 all landing within 20% of each other. Raising
        // `concurrency` therefore buys little; the honest levers are searching
        // fewer banks (the `banks` argument) or accepting the wait. Reporting the
        // measured time and the bank count lets the reader judge, and lets the
        // agent tell the user why a wide search felt slow.
        const header = `Searched ${targets.length} bank(s) in ${elapsedMs}ms for: ${query}`
        const parts = [header]
        if (targets.length >= SLOW_SEARCH_BANKS && elapsedMs >= SLOW_SEARCH_MS) {
          parts.push(
            '',
            `Note: ${targets.length} banks took ${elapsedMs}ms. The daemon serves`
            + ' recalls largely serially, so cost grows with the number of banks.'
            + ' Narrow the search with the `banks` argument when a full sweep is not needed.',
          )
        }
        if (sections.length > 0) parts.push('', sections.join('\n\n'))
        else parts.push('', 'No bank returned a match.')
        if (failures.length > 0) parts.push('', `Unreachable banks:\n${failures.join('\n')}`)
        return parts.join('\n')
      },
    })
  })
}

export default { name, apply }
