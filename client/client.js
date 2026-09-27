/**
 * dsh-local-memory — client half
 *
 * A settings page, registered into the shell's `settings.section` list.
 *
 * It talks to its own host half over the same-origin HTTP routes that half
 * registers (`/local-memory/api/...`). That is the only channel a FILE plugin
 * has between its halves — the package-private `harness.handle` RPC belongs to
 * dynamic plugins, not to packages mounted from a profile.
 *
 * Deliberately depends on nothing but `react`. The shell supplies react as a
 * seed module; every other client package would have to be a registered client
 * module in the boot graph, and requiring one that is not mounted throws at
 * load with nothing rendered to explain why. Colors come from the theme's CSS
 * custom properties instead, so light and dark both follow the app.
 *
 * This file is written by hand in the module-loader wrapper the client expects,
 * so the package needs no bundler and no build step.
 */

window.__ModuleLoader__.load({
  id: 'dsh-local-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var name = 'local-memory'
    var inject = ['slots']

    /* ------------------------------------------------------------ tokens */

    var T = {
      bg: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surfaceAlt: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    var API = '/local-memory/api'

    /** GET/POST helper that never throws — the UI renders the failure instead. */
    var request = function (path, init) {
      return fetch(API + path, init).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            var detail = body && body.error ? body.error : 'HTTP ' + res.status
            throw new Error(detail)
          }
          return body
        })
      })
    }

    /** 1234 -> "1,234"; thousands separators make a fact count readable. */
    var group = function (value) {
      if (typeof value !== 'number' || !isFinite(value)) return '—'
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** "2026-09-27T02:33:03+00:00" -> "2026-09-27 02:33", local-agnostic. */
    var shortTime = function (iso) {
      if (typeof iso !== 'string' || iso.length < 16) return '—'
      return iso.slice(0, 16).replace('T', ' ')
    }

    var has = function (object, key) {
      return Object.prototype.hasOwnProperty.call(object, key)
    }

    var copy = function (object) {
      var next = {}
      for (var key in object) if (has(object, key)) next[key] = object[key]
      return next
    }

    /** A small button, matching the search button's language. */
    var btnStyle = function (primary, disabled) {
      return {
        background: primary ? T.brand : 'transparent',
        border: primary ? 'none' : '1px solid ' + T.border,
        borderRadius: '6px',
        color: primary ? '#fff' : T.text,
        cursor: disabled ? 'default' : 'pointer',
        fontSize: '12px',
        opacity: disabled ? 0.45 : 1,
        padding: '4px 12px',
        whiteSpace: 'nowrap',
      }
    }

    /* -------------------------------------------------------------- view */

    var box = function (extra) {
      var style = {
        background: T.surface,
        border: '1px solid ' + T.border,
        borderRadius: '8px',
        padding: '12px 14px',
      }
      for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) style[key] = extra[key]
      return style
    }

    var Section = function () {
      var banksState = React.useState(null)
      var banks = banksState[0]
      var setBanks = banksState[1]

      // Discovery is a separate fetch: the bank list answers "what do I
      // remember?" and this answers "what SHOULD I remember?". A project with no
      // bank is absent from the first and present in the second, which is the
      // whole reason both exist.
      var projectsState = React.useState(null)
      var projects = projectsState[0]
      var setProjects = projectsState[1]

      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]

      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var queryState = React.useState('')
      var query = queryState[0]
      var setQuery = queryState[1]

      var selectedState = React.useState({})
      var selected = selectedState[0]
      var setSelected = selectedState[1]

      var resultState = React.useState(null)
      var result = resultState[0]
      var setResult = resultState[1]

      var refresh = React.useCallback(function () {
        setBusy(true)
        setError(null)
        request('/banks')
          .then(function (data) {
            setBanks(data.banks || [])
            setBusy(false)
          })
          .catch(function (err) {
            setError(err.message)
            setBanks([])
            setBusy(false)
          })
        // Discovery walks the filesystem, so it is allowed to fail on its own
        // without taking the roster down with it.
        request('/projects')
          .then(function (data) { setProjects(data) })
          .catch(function () { setProjects(null) })
      }, [])

      React.useEffect(function () { refresh() }, [refresh])

      var runSearch = function () {
        var trimmed = query.trim()
        if (trimmed === '') return
        var chosen = Object.keys(selected).filter(function (id) { return selected[id] })
        setBusy(true)
        setError(null)
        setResult(null)
        request('/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(chosen.length > 0
            ? { query: trimmed, banks: chosen.join(',') }
            : { query: trimmed }),
        })
          .then(function (data) {
            setResult(data)
            setBusy(false)
          })
          .catch(function (err) {
            setError(err.message)
            setBusy(false)
          })
      }

      var toggle = function (id) {
        setSelected(function (prev) {
          var next = {}
          for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key]
          next[id] = !next[id]
          return next
        })
      }

      /* ---------------------------------------------------------- seeding */

      // A seed is a detached background process on the host. Nothing here can
      // await it, so the page does the two things it actually can: remember
      // WHEN it asked, and keep asking the host for the truth. A run is only
      // called finished when the host reports history seeded at or after that
      // moment — never on a timer alone, because a timer that lies is exactly
      // the failure this panel exists to avoid.

      var pendingState = React.useState({})
      var pending = pendingState[0]
      var setPending = pendingState[1]

      var noteState = React.useState({})
      var notes = noteState[0]
      var setNotes = noteState[1]

      var note = React.useCallback(function (path, text, tone) {
        setNotes(function (prev) {
          var next = copy(prev)
          next[path] = { text: text, tone: tone || 'muted' }
          return next
        })
      }, [])

      var refreshProjects = React.useCallback(function () {
        request('/projects')
          .then(function (data) { setProjects(data) })
          .catch(function () {})
      }, [])

      var runSeed = function (paths) {
        if (!paths || paths.length === 0) return
        setBusy(true)
        setError(null)
        request('/seed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(paths.length === 1 ? { path: paths[0] } : { paths: paths }),
        })
          .then(function (data) {
            var startedAt = Date.now()
            var started = {}
            ;(data.results || []).forEach(function (entry) {
              if (entry.ok) {
                started[entry.path] = startedAt
                note(entry.path, '已开始，后台播种中…', 'muted')
              } else {
                note(entry.path, entry.error || '无法开始', 'error')
              }
            })
            if (Object.keys(started).length > 0) {
              setPending(function (prev) {
                var next = copy(prev)
                for (var path in started) if (has(started, path)) next[path] = started[path]
                return next
              })
            }
            setBusy(false)
            refreshProjects()
          })
          .catch(function (err) {
            setError(err.message)
            setBusy(false)
          })
      }

      var pendingCount = Object.keys(pending).length

      React.useEffect(function () {
        if (pendingCount === 0) return undefined
        var timer = setInterval(function () {
          request('/projects')
            .then(function (data) {
              setProjects(data)
              var rows = data.projects || []
              setPending(function (prev) {
                var next = {}
                var now = Date.now()
                for (var path in prev) {
                  if (!has(prev, path)) continue
                  var row = null
                  for (var i = 0; i < rows.length; i += 1) if (rows[i].path === path) row = rows[i]
                  var startedAt = prev[path]
                  var age = now - startedAt
                  var seededAt = row && row.seededAt ? Date.parse(row.seededAt) : NaN
                  // The host's own record of when git history landed. One minute
                  // of slack absorbs clock skew between this tab and the daemon.
                  var done = !isNaN(seededAt) && seededAt >= startedAt - 60000
                  // The host stops reporting a run for this project and nothing
                  // landed: the process died. Giving up on a timer alone would
                  // show "播种中" forever, which is the kind of claim this panel
                  // exists to avoid making.
                  var died = !done && row && row.seeding === false && age > 60000
                  if (done) {
                    // The milestone this panel can actually verify is the gitlog
                    // document landing. The engine keeps running for another
                    // minute afterwards draining extraction, so the fact count
                    // still climbs — say that, rather than implying it is over.
                    note(path, 'git 历史已入库，事实仍在后台抽取', 'ok')
                  } else if (died) {
                    note(path, '播种进程已结束，但没有写入 git 历史——详见 '
                      + '~/.hindsight/coding-agents-logs/plugin.log', 'error')
                  } else if (age > 20 * 60 * 1000) {
                    note(path, '超过 20 分钟仍未完成，详见 ~/.hindsight/coding-agents-logs/plugin.log', 'warn')
                  } else {
                    next[path] = startedAt
                  }
                }
                return next
              })
            })
            .catch(function () {})
        }, 5000)
        return function () { clearInterval(timer) }
      }, [pendingCount, note])

      var totalFacts = (banks || []).reduce(function (sum, bank) {
        return sum + (typeof bank.factCount === 'number' ? bank.factCount : 0)
      }, 0)

      var chosenCount = Object.keys(selected).filter(function (id) { return selected[id] }).length

      var children = []

      children.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 14px', color: T.muted, fontSize: '13px', lineHeight: '1.6' },
      }, '每个项目有自己的记忆库，互不干扰。「项目」一栏列出磁盘上找到的全部项目，'
        + '标出哪些已经有记忆、哪些还没有——没记忆的项目不会出现在「记忆库」里，'
        + '所以两栏要一起看。还没记忆的 git 仓库可以直接点「建立记忆」把 git 历史'
        + '播进去，不必先在里面开会话；普通文件夹没有历史可播，只能在里面开一次会话时建立。'
        + '库越大搜索越慢（几百条事实的库约一秒），'
        + '查询时按需勾选比全部搜一遍快得多。'))

      if (error) {
        children.push(React.createElement('div', {
          key: 'error',
          style: box({ borderColor: T.error, marginBottom: '12px', color: T.error, fontSize: '13px' }),
        }, '连接失败：' + error + '（记忆服务可能没在运行；打开任意会话会按需把它拉起来）'))
      }

      // --- bank roster -------------------------------------------------
      var bankRows = (banks || []).map(function (bank) {
        return React.createElement('label', {
          key: bank.id,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '8px 4px',
            borderTop: '1px solid ' + T.border,
            cursor: 'pointer',
          },
        }, [
          React.createElement('input', {
            key: 'c',
            type: 'checkbox',
            checked: !!selected[bank.id],
            onChange: function () { toggle(bank.id) },
            style: { accentColor: T.brand, cursor: 'pointer' },
          }),
          React.createElement('span', {
            key: 'id',
            style: { flex: '1 1 auto', fontFamily: 'ui-monospace, monospace', fontSize: '12.5px', color: T.text, wordBreak: 'break-all' },
          }, bank.id),
          React.createElement('span', {
            key: 'size',
            style: { color: T.muted, fontSize: '12px', whiteSpace: 'nowrap' },
          }, group(bank.factCount) + ' 条事实'),
          React.createElement('span', {
            key: 'when',
            style: { color: T.muted, fontSize: '12px', whiteSpace: 'nowrap', minWidth: '120px', textAlign: 'right' },
          }, shortTime(bank.lastWriteAt)),
        ])
      })

      children.push(React.createElement('div', {
        key: 'roster',
        style: box({ marginBottom: '16px' }),
      }, [
        React.createElement('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' },
        }, [
          React.createElement('strong', { key: 't', style: { color: T.text, fontSize: '13.5px' } },
            '记忆库（' + (banks ? banks.length : 0) + '）'),
          React.createElement('span', { key: 'sum', style: { color: T.muted, fontSize: '12px' } },
            banks && banks.length > 0 ? '共 ' + group(totalFacts) + ' 条事实' : ''),
          React.createElement('span', { key: 'sp', style: { flex: '1 1 auto' } }),
          React.createElement('button', {
            key: 'refresh',
            onClick: refresh,
            disabled: busy,
            style: {
              background: 'transparent',
              border: '1px solid ' + T.border,
              borderRadius: '6px',
              color: T.text,
              cursor: busy ? 'default' : 'pointer',
              fontSize: '12px',
              padding: '4px 10px',
              opacity: busy ? 0.5 : 1,
            },
          }, busy ? '刷新中…' : '刷新'),
        ]),
        banks === null
          ? React.createElement('div', { key: 'loading', style: { color: T.muted, fontSize: '12.5px', padding: '8px 4px' } }, '读取中…')
          : bankRows.length === 0
            ? React.createElement('div', { key: 'empty', style: { color: T.muted, fontSize: '12.5px', padding: '8px 4px' } },
                '还没有任何记忆库。在某个项目里开一次会话就会自动建立。')
            : React.createElement('div', { key: 'rows' }, bankRows),
      ]))

      // --- projects: what exists vs what is remembered ------------------
      //
      // This panel used to be a report: it named every project without memory
      // and told the reader to go open a session in each one. That put the work
      // on the person reading it, and it could not distinguish a repository —
      // whose history is seedable right now — from a plain folder, which can
      // never have git history at all. Both are now drawn differently, and the
      // ones that can be filled have the button that fills them.
      if (projects && Array.isArray(projects.projects)) {
        var withMemory = projects.projects.filter(function (p) { return p.hasMemory })
        var without = projects.projects.filter(function (p) { return !p.hasMemory })
        var actionable = projects.projects.filter(function (p) {
          return p.canSeed && (!p.hasMemory || p.behind === true || (p.isGit && p.seededAt === undefined))
        })
        var projRows = []

        var pathLine = function (p, tone) {
          return React.createElement('div', {
            key: 'p',
            style: {
              fontFamily: 'ui-monospace, monospace',
              fontSize: '12.5px',
              color: tone,
              wordBreak: 'break-all',
            },
          }, p.path)
        }

        var detailLine = function (key, text, tone) {
          return React.createElement('div', {
            key: key,
            style: { color: tone, fontSize: '11.5px', marginTop: '2px' },
          }, text)
        }

        projects.projects.forEach(function (p) {
          var noteFor = notes[p.path]
          var waiting = has(pending, p.path) || p.seeding === true
          var elapsed = has(pending, p.path)
            ? Math.max(0, Math.round((Date.now() - pending[p.path]) / 1000))
            : null
          var lines = []
          var action = null

          if (p.hasMemory) {
            lines.push(pathLine(p, T.text))
            var bits = ['✓ ' + p.bankId, group(p.factCount) + ' 条事实']
            if (p.lastWriteAt) bits.push('最近写入 ' + shortTime(p.lastWriteAt))
            lines.push(detailLine('b', bits.join('  ·  '), T.ok))
            if (!p.isGit) {
              lines.push(detailLine('g', '不是 git 仓库，没有 git 历史可播种', T.muted))
            } else if (p.seededAt === undefined) {
              lines.push(detailLine('g', '记忆目前只来自对话，git 历史还没播种', T.warn))
              action = { label: '播种 git 历史', primary: false }
            } else if (p.behind === true) {
              lines.push(detailLine('g', '记忆停在旧提交，之后的新提交还没入库（上次播种 '
                + shortTime(p.seededAt) + '）', T.warn))
              action = { label: '更新记忆', primary: false }
            } else {
              lines.push(detailLine('g', 'git 历史已播种于 ' + shortTime(p.seededAt)
                + (p.behind === false ? '，与当前提交一致' : ''), T.muted))
            }
          } else {
            lines.push(pathLine(p, T.muted))
            lines.push(detailLine('b', '尚无记忆  →  ' + p.bankId, T.muted))
            if (!p.isGit) {
              lines.push(detailLine('g', '不是 git 仓库：只有在里面开一次会话才会建立', T.muted))
            } else {
              lines.push(detailLine('g', 'git 仓库，可以直接播种历史，不必先开会话', T.muted))
              action = { label: '建立记忆', primary: true }
            }
          }

          var right = null
          if (waiting) {
            right = React.createElement('button', {
              key: 'act',
              disabled: true,
              style: btnStyle(true, true),
            }, elapsed === null ? '播种中…' : '播种中… ' + elapsed + 's')
          } else if (action !== null && p.canSeed) {
            right = React.createElement('button', {
              key: 'act',
              disabled: busy,
              onClick: function () { runSeed([p.path]) },
              style: btnStyle(action.primary, busy),
            }, action.label)
          } else if (action !== null) {
            right = React.createElement('span', {
              key: 'act',
              style: { color: T.error, fontSize: '11.5px' },
            }, '播种引擎不可用')
          }

          if (noteFor) {
            lines.push(React.createElement('div', {
              key: 'note',
              style: {
                fontSize: '11.5px',
                marginTop: '3px',
                color: noteFor.tone === 'ok' ? T.ok
                  : noteFor.tone === 'error' ? T.error
                    : noteFor.tone === 'warn' ? T.warn : T.muted,
              },
            }, noteFor.text))
          }

          projRows.push(React.createElement('div', {
            key: p.path,
            style: {
              padding: '8px 4px',
              borderTop: '1px solid ' + T.border,
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
            },
          }, [
            React.createElement('div', {
              key: 'l',
              style: { flex: '1 1 auto', minWidth: 0 },
            }, lines),
            right === null ? null : React.createElement('div', {
              key: 'r',
              style: { flex: '0 0 auto', paddingTop: '1px' },
            }, right),
          ]))
        })

        if (projects.unmatched && projects.unmatched.length > 0) {
          projects.unmatched.forEach(function (u) {
            projRows.push(React.createElement('div', {
              key: 'u-' + u.bankId,
              style: { padding: '8px 4px', borderTop: '1px solid ' + T.border },
            }, [
              React.createElement('div', {
                key: 'b',
                style: { fontFamily: 'ui-monospace, monospace', fontSize: '12.5px', color: T.warn, wordBreak: 'break-all' },
              }, u.bankId),
              React.createElement('div', {
                key: 'd',
                style: { color: T.muted, fontSize: '11.5px', marginTop: '2px' },
              }, '有记忆（' + group(u.factCount) + ' 条），但对不上任何磁盘上的项目'),
            ]))
          })
        }

        var bulk = actionable.filter(function (p) { return pending[p.path] === undefined }).length > 1
          ? React.createElement('button', {
              key: 'bulk',
              disabled: busy,
              onClick: function () {
                runSeed(actionable
                  .filter(function (p) { return pending[p.path] === undefined && p.seeding !== true })
                  .map(function (p) { return p.path }))
              },
              style: btnStyle(false, busy),
            }, '全部建立（' + actionable.length + '）')
          : null

        children.push(React.createElement('div', {
          key: 'projects',
          style: box({ marginBottom: '16px' }),
        }, [
          React.createElement('div', {
            key: 'head',
            style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' },
          }, [
            React.createElement('strong', { key: 't', style: { color: T.text, fontSize: '13.5px' } },
              '项目（' + projects.projects.length + '）'),
            React.createElement('span', { key: 's', style: { color: T.muted, fontSize: '12px' } },
              withMemory.length + ' 个有记忆 · ' + without.length + ' 个还没有'),
            React.createElement('span', { key: 'sp', style: { flex: '1 1 auto' } }),
            bulk,
          ]),
          projects.canSeed === false
            ? React.createElement('div', {
                key: 'noengine',
                style: { color: T.error, fontSize: '11.5px', margin: '2px 4px 6px' },
              }, '找不到 Hindsight 的播种引擎（deepen.js），因此这里不能直接建库。'
                + '在没有按钮的项目里开一次会话仍然会建立记忆。')
            : null,
          projRows.length === 0
            ? React.createElement('div', {
                key: 'none',
                style: { color: T.muted, fontSize: '12.5px', padding: '8px 4px' },
              }, '工作区里没找到任何项目。')
            : React.createElement('div', { key: 'rows' }, projRows),
          actionable.length > 0
            ? React.createElement('div', {
                key: 'hint',
                style: { color: T.muted, fontSize: '11.5px', marginTop: '8px' },
              }, '播种在后台运行，只读取该项目的 git 提交信息，约一分钟；'
                + '期间这个项目会显示「播种中」，完成后事实数会自己长上来。')
            : null,
        ]))
      }

      // --- search ------------------------------------------------------
      children.push(React.createElement('div', {
        key: 'search',
        style: box({ marginBottom: '16px' }),
      }, [
        React.createElement('strong', {
          key: 't',
          style: { color: T.text, fontSize: '13.5px', display: 'block', marginBottom: '8px' },
        }, '跨库查询'),
        React.createElement('div', { key: 'row', style: { display: 'flex', gap: '8px' } }, [
          React.createElement('input', {
            key: 'q',
            value: query,
            placeholder: '想问什么？例如：这个项目用什么数据库？',
            onChange: function (event) { setQuery(event.target.value) },
            onKeyDown: function (event) { if (event.key === 'Enter') runSearch() },
            style: {
              flex: '1 1 auto',
              background: T.surfaceAlt,
              border: '1px solid ' + T.border,
              borderRadius: '6px',
              color: T.text,
              fontSize: '13px',
              outline: 'none',
              padding: '8px 10px',
            },
          }),
          React.createElement('button', {
            key: 'go',
            onClick: runSearch,
            disabled: busy || query.trim() === '',
            style: {
              background: T.brand,
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              cursor: busy || query.trim() === '' ? 'default' : 'pointer',
              fontSize: '13px',
              opacity: busy || query.trim() === '' ? 0.5 : 1,
              padding: '8px 18px',
            },
          }, busy ? '查询中…' : '搜索'),
        ]),
        React.createElement('div', {
          key: 'scope',
          style: { color: T.muted, fontSize: '12px', marginTop: '8px' },
        }, chosenCount === 0
          ? '范围：全部 ' + (banks ? banks.length : 0) + ' 个库（在上面勾选可缩小范围，会快很多）'
          : '范围：已选 ' + chosenCount + ' 个库'),
      ]))

      if (result) {
        var body = []
        body.push(React.createElement('div', {
          key: 'meta',
          style: { color: T.muted, fontSize: '12px', marginBottom: '10px' },
        }, '耗时 ' + result.elapsedMs + 'ms，命中 ' + result.sections.length + ' 个库'
          + (result.failures.length > 0 ? '，' + result.failures.length + ' 个库失败' : '')))

        if (result.sections.length === 0) {
          body.push(React.createElement('div', { key: 'none', style: { color: T.muted, fontSize: '12.5px' } }, '没有找到相关内容。'))
        }
        result.sections.forEach(function (section) {
          body.push(React.createElement('div', { key: section.bankId, style: { marginTop: '10px' } }, [
            React.createElement('div', {
              key: 'h',
              style: { color: T.brand, fontFamily: 'ui-monospace, monospace', fontSize: '12.5px', marginBottom: '4px' },
            }, section.bankId),
            React.createElement('ul', { key: 'l', style: { margin: 0, paddingLeft: '18px' } },
              section.texts.map(function (text, index) {
                return React.createElement('li', {
                  key: index,
                  style: { color: T.text, fontSize: '12.5px', lineHeight: '1.65', marginBottom: '4px' },
                }, text)
              })),
            section.withheld > 0
              ? React.createElement('div', {
                  key: 'w',
                  style: { color: T.muted, fontSize: '11.5px', marginTop: '2px' },
                }, '… 另有 ' + section.withheld + ' 条未显示')
              : null,
          ]))
        })
        result.failures.forEach(function (failure) {
          body.push(React.createElement('div', {
            key: 'f-' + failure.bankId,
            style: { color: T.warn, fontSize: '12px', marginTop: '6px' },
          }, failure.bankId + '：' + failure.error))
        })

        children.push(React.createElement('div', { key: 'result', style: box() }, body))
      }

      return React.createElement('div', {
        style: { color: T.text, fontFamily: 'inherit', padding: '4px 2px 24px' },
      }, children)
    }

    /* -------------------------------------------------------------- apply */

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', function () {
        return slots.register({
          name: 'settings.section',
          id: 'local-memory',
          order: 45,
          // A thunk, so the shell re-reads it on locale change without a re-register.
          label: function () { return '本地记忆' },
        }, Section)
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
