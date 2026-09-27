/**
 * A stand-in for Hindsight's `deepen.js`, used to prove the spawn is real.
 *
 * The seed route starts a detached child process. Testing that against the real
 * engine would ingest git history into the user's actual memory banks and take
 * about a minute per repository, so the route is tested with this: it does the
 * one thing under test — record the argv it was handed — and exits.
 *
 * It writes to the file named by FAKE_DEEPEN_OUT (set by the test), because a
 * detached child cannot hand anything back through the parent's stdout.
 *
 * FAKE_DEEPEN_HOLD_MS makes it linger after recording, so a test can observe
 * the in-flight state without racing the child's exit.
 */

import { appendFileSync } from 'node:fs'

const out = process.env.FAKE_DEEPEN_OUT
if (typeof out === 'string' && out !== '') {
  appendFileSync(out, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
  }) + '\n')
}

const hold = Number(process.env.FAKE_DEEPEN_HOLD_MS ?? '0')
if (Number.isFinite(hold) && hold > 0) {
  await new Promise((resolve) => setTimeout(resolve, hold))
}
