---
name: dsh-local-memory
description: How this machine's long-term memory works — the Hindsight daemon behind the 🧠 banner, the per-project bank layout, how to create a bank for a project that has none (seeding), and how to configure, diagnose, or repair it. Use when the user asks about long-term memory, project memory, memory banks, "why does it remember/not remember", wants a project remembered or backfilled, or wants local (offline-ish) memory configured.
---

# Local long-term memory (Hindsight)

This machine runs **Hindsight** as the memory behind the `memory_banks` /
`memory_recall_all` tools and the 🧠 banner. This skill is the operator's
manual for it: how it is wired, what the numbers mean, and every trap that was
paid for in real debugging time.

**Scope warning.** This describes the *memory backend*. Memory for the current
session is injected automatically — you do not need to do anything for that.

## The shape of it

```
DSH process ──env vars──▶  hindsight daemon  (uvx hindsight-embed, port 9077)
                                   │
                                   ├── local embeddings  (bge-small)
                                   ├── local reranker    (ms-marco cross-encoder)
                                   ├── embedded Postgres (~/.pg0/instances/hindsight-embed-coding-agent)
                                   └── fact extraction ──▶ DeepSeek API   ← the only egress
```

Only fact extraction leaves the machine. Retrieval — embeddings and reranking —
is local and free.

## Bank layout: one bank per repository

| Session's working directory | Bank |
| --- | --- |
| `/Volumes/SSD-2TB` (not a git repo → directory name) | `coding-agent::SSD-2TB` |
| `/Volumes/SSD-2TB/project/verify` | `coding-agent::verify` |
| `/Volumes/SSD-2TB/Loop` | `coding-agent::Loop` |

The rule is `coding-agent::` + the project directory name, resolved from
`agent.session.header.cwd`. Banks are **flat** — there is no hierarchy, no
"master bank". Worktrees of one repo share the main checkout's name.

A bank is created the first time a session records something there. Opening a
project you have never worked in produces no bank yet — that is expected, not a
fault.

## Creating a bank without opening a session (seeding)

A cold project has no bank at all, so it is invisible to `memory_banks` and
cannot be searched. You do **not** have to open a session in it to fix that:
Hindsight ships a standalone seeding engine, and this plugin's settings panel
exposes it directly.

```sh
node <hindsight-coding-agents>/dist/deepen.js \
    --repo <project> --harness dsh --gitlog-limit 300
```

That is not a reimplementation — it is the **same entry point the Hindsight
plugin spawns on session start** (`startBackgroundSeed`). Running it is exactly
equivalent to what a session in that directory would have triggered, so nothing
about the resulting bank can differ.

**Finding the engine.** The package declares `"./dist/*"` in its `exports` map, so
`@vectorize-io/hindsight-coding-agents/dist/deepen.js` is a supported subpath,
not a private file. Resolve it from the same `node_modules` the plugin is
installed in, or from `~/.dsh/profiles/*/node_modules/`.

> `dist/hindsight-seed.js seed --repo <dir>` is a second, thinner wrapper over
> the same call. It hardcodes the `claude-code` harness while resolving the bank,
> so prefer calling `deepen.js` directly here.

**What it does, in order** (all of it visible in
`~/.hindsight/coding-agents-logs/plugin.log`):

1. `configureBank` — **creates the bank immediately**, with the missions,
   strategies, entity labels and knowledge pages.
2. Imports developer conversations that are not already ingested.
3. Ingests git commit **messages** as **one** aggregated document
   (`--git-ingest message`, the default; `full` also reads diffs, `none` skips).
4. Drains the extraction queue and waits for server-side ops to settle.

**It is slow, and the bank is usable before it finishes.** Measured on a
9-commit repository: 90.4 s wall — 35 s of extraction plus the settle wait. The
bank and its knowledge pages exist within the first second; fact counts climb
over the following minute. Never report a seed as complete because the process
was started.

**The marker that proves it worked** is a document named `gitlog:<repo-name>`
tagged `gitlog-head:<sha>` `source:git-log` `source:git`. That tag is how you
tell "history ingested" from "bank created by conversations only" — the two look
identical in the bank roster, and only the first can ever reach
`synced: true` (`synced = gitlogPresent && pages > 0 && no active ops`).
Compare `gitlog-head:<sha>` against `git rev-parse HEAD` to decide whether a
re-seed would add anything.

**Re-seeding is safe and incremental.** A per-bank lock file (stale after 30
min) means a second concurrent run for the same bank prints
`another run holds the lock` and exits rather than double-writing; already
ingested conversations are skipped by id.

## From an agent

`memory_seed` does all of the above:

| Call | Effect |
| --- | --- |
| `memory_seed()` | Lists what is seedable — no side effects. |
| `memory_seed({ all: true })` | Seeds every discovered git repository with no memory. |
| `memory_seed({ path })` / `{ paths: [...] }` | Seeds exactly those, as long as discovery already found them. |

A path outside the configured working roots, a relative path, or a directory
that is not a repository is refused with a reason. Seeding always runs detached
in the background; use `memory_projects` afterwards to watch the fact counts.

In the settings panel the same thing is a button per project. A project is only
offered one when its directory is a real git repository — a plain folder has no
history to ingest and says so instead of showing a button that cannot work.

## Configuration

One JSON file: `~/.hindsight/coding-agent.json`.

```json
{ "serverMode": "daemon" }
```

**That is the whole correct file.** Everything else is a mistake:

| Field | Why it must NOT be set |
| --- | --- |
| `bankId` | **Forces every project into one bank**, which destroys per-project isolation and makes the cross-bank view pointless. This is the single most damaging setting. |
| `retainTags` / `retainMetadata` | Redundant once each bank *is* a project. |
| `observationScopes` | The default `shared` is correct for one-bank-per-project. `combined` was only needed to fake partitioning inside a single bank. |

`serverMode: "daemon"` also makes `apiUrl` resolve to `http://127.0.0.1:9077`
and removes the need for any token. The default is **cloud**
(`https://api.hindsight.vectorize.io`) with no token — which fails every call
with `401 Authentication failed: API key required`.

### The LLM key is NOT a config field

`resolveConfig()` has **no LLM fields at all**. The daemon collects only
`HINDSIGHT_API_*` variables from the environment of the process that starts it,
so the DSH process must carry them:

```sh
export HINDSIGHT_API_LLM_PROVIDER=deepseek
export HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash
export HINDSIGHT_API_LLM_API_KEY=...
```

Put these in `~/.zshrc` **and open a NEW terminal** — `.zshrc` is read once per
interactive shell, so restarting `dsh web` in the old terminal picks up nothing.
Whatever process starts the daemon hands it its environment; the daemon inherits
nothing from anywhere else.

`HINDSIGHT_API_LLM_PROVIDER` accepts (among others) `deepseek`, `openai`,
`anthropic`, `ollama`, `lmstudio`. With `ollama` the whole pipeline is offline.

## Cost and speed — the measured model

Bank size, not bank count, drives the cost:

| Bank | Facts | One recall |
| --- | --- | --- |
| Small (a handful of facts) | ~5 | ~30 ms |
| Large (hundreds of facts, tens of thousands of graph links) | ~600–900 | ~1.0–1.4 s |

A sweep is roughly the sum of its banks. **No client-side knob changes the
per-bank cost** — measured on a large bank: disabling reranking 1035 ms vs
1030 ms baseline; `budget: low` 1255 ms (slower); `max_tokens: 300` still
1025 ms while cutting 59 results to 3; `limit` is ignored. Concurrency 1, 6 and
13 land within 20% of each other because the daemon serves recalls largely
serially.

**Therefore: search the one or two banks that plausibly hold the answer. Sweep
only when you genuinely do not know where to look, and say what it cost.**

## Diagnosing

```sh
curl -s localhost:9077/health                    # {"status":"healthy",...}
curl -s localhost:9077/v1/default/banks | jq     # roster + fact_count + last_write_at
```

The roster endpoint already carries `fact_count` and `last_write_at` per bank —
which is exactly what makes targeting an informed choice instead of a guess, and
is why `memory_banks` shows them.

Logs: `~/.hindsight/coding-agents-logs/{plugin.log,diag.jsonl}`.
`diag.jsonl` records `session_start`, `retain_ok`, `pages_ok`, `reflect_failed`
and friends — a run whose reflects failed is a no-memory run.

The `hindsight_diagnose` tool reports the gap between what the config FILE says
and what the RUNNING client is using. Config is read **once per workspace, at
plugin load**, so every change needs a DSH restart; `apiToken` is the sole
exception.

## Repair procedures

### "Not configured / everything 401"
Point at the cloud with no token. Write `{"serverMode":"daemon"}`, ensure the
`HINDSIGHT_API_LLM_*` variables exist, then restart.

### Restart fails with EADDRINUSE, or a plugin says "already owned by process N"
An older DSH is still alive holding both the port and a plugin's exclusive lock.
Kill it first (`kill <pid>`; find it with
`lsof -nP -iTCP:3080 -sTCP:LISTEN`). A detached instance has no controlling
terminal — `ps -o tty` shows `??` — so there is no window to Ctrl-C in.

If a fresh boot ever fails, `dsh --profile rescue` starts the same web UI from a
clean profile with no community plugins.

### A bank was created under the wrong name
Two banks holding the same project is what a mid-project rename looks like.
Documents carry a `ref_id` metadata field, and that value **is** the document
id, so the fix is an in-place replace rather than a copy:

```jsonc
POST /v1/default/banks/<target>/memories
{ "items": [{
    "content": "<full original_text>",
    "document_id": "conversation:session-…",   // = the source doc's ref_id
    "update_mode": "replace",                   // omit ⇒ append; be explicit
    "context": "…", "metadata": {…}, "tags": […],
    "observation_scopes": "shared"
}]}
```

Do **not** rely on the plugin to migrate for you: it retains with a cursor and
`updateMode: append`, so a bank switch can leave a *partial* document behind.
Replace deliberately, verify the document count is unchanged and the length
matches, then delete the orphan (`DELETE /v1/default/banks/<id>`).

### Reading a bank before deleting it
`GET /v1/default/banks/<id>/documents` lists documents, and
`GET /v1/default/banks/<id>/documents/<docId>` returns `original_text` — the
full source text. `GET /export` does **not**: it is ~1.5 KB of configuration and
mental models with no memories in it.

## Non-obvious facts worth knowing

- **Hindsight only reads git** — `rev-parse` for the repo name, plus commit
  messages for seeding. It never commits, pushes, or modifies a repository.
- Seeding needs a git repository. A working directory that is not one cannot
  reach `synced: true`, because that flag is defined as
  `gitlogPresent && …`.
- A bank holding a session's transcript grows by **upsert**, not append, for the
  full-text path, so the document always reflects the whole session.
- **"Has a bank" is not "has memory about the code."** A bank that only ever saw
  conversations holds decisions from those conversations and nothing about the
  repository's own history. `hindsight_sync_status` distinguishes them;
  `memory_banks` does not, because the roster cannot see documents.
- `deepen.js` writes to stdout only; it is meant to be spawned detached with
  `stdio: 'ignore'`, which is why nothing comes back from a seed through the
  caller. Read `plugin.log`, or the `gitlog:` document, for the outcome.
- An empty subdirectory under a working root is not a discovered project. This
  plugin reports repositories plus the working roots themselves; a bank created
  by a session in some other subdirectory still shows up, in the "matches no
  project on disk" group.
