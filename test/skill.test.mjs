/**
 * dsh-local-memory — operator-skill tests
 *
 * The plugin registers its operator skill at mount time, because a plugin cannot
 * DECLARE one: `dsh-package-manifest` knows only `bundle` and `client`. That
 * makes registration code, and registration code needs tests.
 *
 * Run: node --test test/skill.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** A context whose `skills` service records whatever is registered. */
function ctxWithSkills(onRegister) {
  return {
    get: (name) => {
      if (name === 'webServer') return { register: () => () => {} }
      if (name === 'skills') return { register: (skill) => { onRegister(skill); return () => {} } }
      return undefined
    },
    inject: (deps, cb) => {
      const facade = { get: () => undefined, effect: (fn) => { fn(); return () => {} } }
      if (deps.includes('tools')) facade.tools = { register: () => {} }
      cb(facade)
    },
    effect: (fn) => { fn(); return () => {} },
  }
}

test('registers the operator skill on a host that has the registry', () => {
  let registered
  apply(ctxWithSkills((skill) => { registered = skill }), {})
  assert.ok(registered, 'the skill must be registered')
  assert.equal(registered.name, 'dsh-local-memory')
  assert.equal(registered.source, 'runtime')
  assert.deepEqual(registered.invocation, { modelInvocable: true, userInvocable: true })
})

test('the registered body carries no YAML frontmatter', () => {
  // `content` is what the agent reads. Leaving the frontmatter in would show it
  // its own metadata as body text; name and description are separate fields.
  let registered
  apply(ctxWithSkills((skill) => { registered = skill }), {})
  assert.ok(!registered.content.startsWith('---'), 'frontmatter must be stripped')
  assert.match(registered.content, /^# /, 'the body must start with its title')
})

test('the body is substantial and mentions the traps it exists to record', () => {
  // A skill that documents nothing is worse than no skill. These are the
  // concrete findings the skill exists to carry forward.
  let registered
  apply(ctxWithSkills((skill) => { registered = skill }), {})
  const body = registered.content
  assert.ok(body.length > 2000, `expected a real document, got ${body.length} chars`)
  for (const marker of ['bankId', 'HINDSIGHT_API_LLM_', 'EADDRINUSE', 'update_mode', 'fact_count']) {
    assert.ok(body.includes(marker), `the skill should cover ${marker}`)
  }
})

test('the description and whenToUse are set for catalogue display', () => {
  let registered
  apply(ctxWithSkills((skill) => { registered = skill }), {})
  assert.ok(registered.description.length > 40)
  assert.ok(registered.whenToUse.length > 20)
})

test('WAITS for the skills registry instead of skipping when it is absent', () => {
  // Same failure shape the settings routes had: rows activate in parallel, so a
  // bare ctx.get() guard would silently register nothing on a real boot.
  const requested = []
  apply({
    get: (name) => (name === 'webServer' ? { register: () => () => {} } : undefined),
    inject: (deps, cb) => {
      requested.push(deps.join(','))
      if (deps.includes('tools')) cb({ tools: { register: () => {} }, get: () => undefined })
      if (deps.includes('skills')) {
        cb({
          skills: { register: () => () => {} },
          get: () => undefined,
          effect: (fn) => { fn(); return () => {} },
        })
      }
    },
    effect: (fn) => { fn(); return () => {} },
  }, {})
  assert.ok(requested.includes('skills'), `must wait for skills, asked only: ${requested.join(' | ')}`)
})

test('does not throw when neither webServer nor skills is mounted', () => {
  const bare = {
    get: () => undefined,
    inject: () => {},
    effect: (fn) => { fn(); return () => {} },
  }
  assert.doesNotThrow(() => apply(bare, {}))
})
