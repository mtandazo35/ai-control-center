import type { Register } from 'claude-code'

/**
 * AI Control Center feed.
 *
 * On every `session.measure` (after each main-thread turn, and when a rate-limit window moves a whole point)
 * it writes the figures the status line has — the account's rate-limit windows, the context fill and the
 * session's cost — to `<data dir>/inbox/claude-mod-<session id>.json`, where the AI Control Center extension
 * and agent read them. Nothing else is read or written: no prompt, no path, no token, no network.
 */

const VERSION = '0.1.0'

export const register: Register = on => {
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      // Data folder of AI Control Center (same rule as the extension; AI_CONTROL_CENTER_DATA overrides).
      let dir: string | undefined
      let sep = '/'
      const override = await $.env.get('AI_CONTROL_CENTER_DATA')
      const local = await $.env.get('LOCALAPPDATA')
      const home = await $.env.get('HOME')
      if (override) {
        dir = override
        sep = override.includes('\\') ? '\\' : '/'
      } else if (local) {
        dir = `${local}\\ai-control-center`
        sep = '\\'
      } else if (home) {
        const xdg = await $.env.get('XDG_DATA_HOME')
        dir = (await $.fs.exists(`${home}/Library/Application Support`))
          ? `${home}/Library/Application Support/ai-control-center`
          : `${xdg ?? `${home}/.local/share`}/ai-control-center`
      }
      if (!dir) return result
      const inbox = `${dir}${sep}inbox`
      // No inbox = AI Control Center is not installed here: write nothing.
      if (!(await $.fs.exists(inbox))) return result
      const id = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
      const body = {
        source: 'claude-mod',
        version: VERSION,
        observedAt: new Date(await $.clock.now()).toISOString(),
        sessionId: id,
        claudeConfigDir: (await $.env.get('CLAUDE_CONFIG_DIR')) ?? null,
        rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null })),
        context: { percent: e.context.percent ?? null, tokens: e.context.tokens ?? null, window: e.context.window },
        costUsd: e.cost?.usd ?? null,
      }
      await $.fs.write(`${inbox}${sep}claude-mod-${id}.json`, JSON.stringify(body))
    } catch {
      // Never disturb the session: a failed write only means one missed reading.
    }
    return result
  })
}
