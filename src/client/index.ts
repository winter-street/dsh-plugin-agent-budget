/**
 * dsh-plugin-agent-budget settings page.
 *
 * Pure DOM settings.section panel backed by the host HTTP API
 * (`/agent-budget/api`). Lists every open budget scope and lets the user
 * adjust the token limit or reset usage. Polls every 30 seconds.
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  effect(callback: () => unknown, name?: string): unknown
  slots: SlotsService
}

export const inject = ['slots']

const API = '/agent-budget/api'

interface ScopeStatus {
  scopeKey: string
  limitTokens: number
  usedTokens: number
  remainingTokens: number
  exhausted: boolean
  usage: {
    inputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
  }
  meteringComplete: boolean
  unmeteredCalls: number
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== void 0) node.textContent = text
  return node
}

const styles = `
.agb-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:14px 16px;max-width:760px}
.agb-page h3{margin:0 0 8px;font-size:13px}
.agb-stats{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 10px}
.agb-list{list-style:none;margin:0;padding:0}
.agb-item{border:1px solid var(--theme-border,#333);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.agb-item-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.agb-scope{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agb-badge{font-size:10px;padding:2px 8px;border-radius:10px}
.agb-badge.on{background:rgba(231,76,60,.15);color:#e74c3c}
.agb-badge.off{background:rgba(46,204,113,.15);color:#2ecc71}
.agb-bar{height:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);border-radius:4px;overflow:hidden;margin:4px 0 8px}
.agb-bar-fill{height:100%;background:var(--theme-accent,#4a9eff)}
.agb-meta{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 8px}
.agb-row{display:flex;gap:6px;align-items:center}
.agb-input{flex:1;background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:5px 8px;font-size:12px;max-width:160px}
.agb-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;white-space:nowrap}
.agb-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.agb-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.agb-btn:disabled{opacity:.45;cursor:not-allowed}
.agb-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:180px;overflow:auto;font-size:11px}
`

function fetchJson(path: string, init?: RequestInit): Promise<any> {
  return fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  }).then(response => response.json())
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'agent-budget-settings',
      order: 60,
      label: () => 'Token 预算',
      component: () => ({
        render() {
          const style = document.createElement('style')
          style.textContent = styles

          const page = el('div', 'agb-page')
          const title = el('h3', undefined, 'Agent Token 预算（dsh-plugin-agent-budget）')
          const stats = el('p', 'agb-stats')
          page.append(style, title, stats)

          const list = el('ul', 'agb-list')
          page.append(list)

          const msg = el('div', 'agb-msg')
          msg.style.display = 'none'
          page.append(msg)

          const say = (text: string, isErr = false): void => {
            msg.textContent = text
            msg.style.display = text ? 'block' : 'none'
            msg.style.borderColor = isErr ? '#d33' : 'var(--theme-border,#333)'
          }

          const renderScope = (scope: ScopeStatus): HTMLElement => {
            const item = el('li', 'agb-item')
            const head = el('div', 'agb-item-head')
            const name = el('span', 'agb-scope', scope.scopeKey)
            const badge = el(
              'span',
              'agb-badge ' + (scope.exhausted ? 'on' : 'off'),
              scope.exhausted ? '已耗尽' : '正常',
            )
            head.append(name, badge)

            const pct = scope.limitTokens > 0
              ? Math.min(100, Math.round((scope.usedTokens / scope.limitTokens) * 100))
              : 0
            const bar = el('div', 'agb-bar')
            const fill = el('div', 'agb-bar-fill')
            fill.style.width = `${pct}%`
            bar.append(fill)

            const meta = el(
              'p',
              'agb-meta',
              `used ${scope.usedTokens} / limit ${scope.limitTokens} · remaining ${scope.remainingTokens} · unmetered ${scope.unmeteredCalls}`,
            )

            const row = el('div', 'agb-row')
            const input = el('input', 'agb-input') as HTMLInputElement
            input.type = 'number'
            input.min = '1'
            input.value = String(scope.limitTokens)
            const adjust = el('button', 'agb-btn', '调整上限') as HTMLButtonElement
            const reset = el('button', 'agb-btn danger', '重置用量') as HTMLButtonElement
            row.append(input, adjust, reset)

            adjust.addEventListener('click', () => {
              const limitTokens = Number(input.value)
              adjust.disabled = reset.disabled = true
              fetchJson('/adjust-limit', {
                method: 'POST',
                body: JSON.stringify({ scopeKey: scope.scopeKey, limitTokens }),
              })
                .then((response) => {
                  say(response?.ok ? '上限已更新' : JSON.stringify(response), !response?.ok)
                  refresh()
                })
                .catch((error) => say('调整失败: ' + error, true))
                .finally(() => {
                  adjust.disabled = reset.disabled = false
                })
            })

            reset.addEventListener('click', () => {
              adjust.disabled = reset.disabled = true
              fetchJson('/reset', {
                method: 'POST',
                body: JSON.stringify({ scopeKey: scope.scopeKey }),
              })
                .then((response) => {
                  say(response?.ok ? '用量已重置' : JSON.stringify(response), !response?.ok)
                  refresh()
                })
                .catch((error) => say('重置失败: ' + error, true))
                .finally(() => {
                  adjust.disabled = reset.disabled = false
                })
            })

            item.append(head, bar, meta, row)
            return item
          }

          const refresh = (): void => {
            fetchJson('/scopes')
              .then((data) => {
                if (!data?.ok) return say(JSON.stringify(data), true)
                const scopes = (data.scopes ?? []) as ScopeStatus[]
                stats.textContent = `共 ${scopes.length} 个预算作用域 · 30s 自动刷新`
                list.textContent = ''
                if (scopes.length === 0) {
                  list.append(el('li', 'agb-item', '（暂无已开启的预算作用域）'))
                  return
                }
                for (const scope of scopes) list.append(renderScope(scope))
              })
              .catch((error) => say('加载失败: ' + error, true))
          }

          refresh()
          const timer = window.setInterval(refresh, 30000)
          return {
            dispose: () => window.clearInterval(timer),
          }
        },
      }),
    }),
  ), 'agent-budget: settings page')
}
