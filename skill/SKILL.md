---
name: dsh-local-memory
description: How this machine's long-term memory works — the Hindsight daemon behind the 🧠 banner, the per-project bank layout, and how to configure, diagnose, or repair it. Use when the user asks about long-term memory, project memory, memory banks, "why does it remember/not remember", or wants local (offline-ish) memory configured.
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
