/**
 * dsh-plugin-agent-budget settings page (React).
 *
 * Registers a `settings.section` entry whose component is a real React
 * component — DSH's slot renderer mounts slot entries with React, so a
 * factory returning `{ render() }` renders as an empty (invalid) React child.
 * Data flows through the host HTTP API (`/agent-budget/api`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export const inject = ['slots']

/**
 * Minimal browser-plugin context: DSH's slot renderer mounts registrations
 * as React components (see web-react's `entry.component as FC`), so the
 * component face is a React component type, not a `{ render() }` object.
 * Kept local on purpose: the published client type packages pull the host
 * dependency tree (dsh-llm & co.) into the build, which collides with this
 * plugin's host dependency declarations.
 */
type ClientContext = {
  effect(callback: () => unknown, name?: string): unknown
  slots: {
    inject(key: string, factory: () => unknown, name?: string): unknown
    register(
      options: {
        name: string
        id: string
        order: number
        label: () => string
      },
      component: React.ComponentType,
    ): () => void
  }
}

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

interface ScopesResponse {
  ok: boolean
  scopes?: ScopeStatus[]
  error?: string
}

interface ActionResponse {
  ok: boolean
  error?: string
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
.agb-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.agb-input{flex:1;min-width:100px;background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:5px 8px;font-size:12px;max-width:160px}
.agb-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;white-space:nowrap}
.agb-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.agb-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.agb-btn:disabled{opacity:.45;cursor:not-allowed}
.agb-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:180px;overflow:auto;font-size:11px}
`

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  headers.set('x-agent-budget-request', '1')
  const response = await fetch(API + path, {
    ...init,
    headers,
    cache: 'no-store',
    signal: init?.signal ?? AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined)
    const detail = body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : `HTTP ${response.status}`
    throw new Error(detail)
  }
  return response.json()
}

function ScopeRow(props: {
  scope: ScopeStatus
  busy: boolean
  onAdjust: (scopeKey: string, limitTokens: number) => void
  onReset: (scopeKey: string) => void
}): React.JSX.Element {
  const { scope, busy, onAdjust, onReset } = props
  const [limit, setLimit] = useState(String(scope.limitTokens))
  useEffect(() => setLimit(String(scope.limitTokens)), [scope.limitTokens])
  const validLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0
  const pct = scope.limitTokens > 0
    ? Math.min(100, Math.round((scope.usedTokens / scope.limitTokens) * 100))
    : 0
  return (
    <li className="agb-item">
      <div className="agb-item-head">
        <span className="agb-scope" title={scope.scopeKey}>{scope.scopeKey}</span>
        <span className={'agb-badge ' + (scope.exhausted ? 'on' : 'off')}>
          {scope.exhausted ? '已耗尽' : '正常'}
        </span>
      </div>
      <div className="agb-bar">
        <div className="agb-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="agb-meta">
        used {scope.usedTokens} / limit {scope.limitTokens} · remaining {scope.remainingTokens}
        {' '}· unmetered {scope.unmeteredCalls}
      </p>
      <div className="agb-row">
        <input
          className="agb-input"
          type="number"
          min="1"
          max={Number.MAX_SAFE_INTEGER}
          step="1"
          aria-label="Token 预算上限"
          value={limit}
          disabled={busy}
          onChange={event => setLimit(event.target.value)}
        />
        <button
          className="agb-btn"
          disabled={busy || !validLimit}
          onClick={() => onAdjust(scope.scopeKey, Number(limit))}
        >
          调整上限
        </button>
        <button
          className="agb-btn danger"
          disabled={busy}
          onClick={() => onReset(scope.scopeKey)}
        >
          重置用量
        </button>
      </div>
    </li>
  )
}

function AgentBudgetSection(): React.JSX.Element {
  const [scopes, setScopes] = useState<ScopeStatus[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const requestId = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    await fetchJson<ScopesResponse>('/scopes')
      .then((data) => {
        if (!mounted.current || id !== requestId.current) return
        if (!data?.ok) {
          setLoadError(data?.error ?? '加载失败')
          return
        }
        setScopes(data.scopes ?? [])
        setLoadError(undefined)
      })
      .catch((err) => {
        if (mounted.current && id === requestId.current) setLoadError('加载失败: ' + String(err))
      })
      .finally(() => {
        if (mounted.current && id === requestId.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { if (!busyRef.current) void refresh() }, 30000)
    return () => {
      mounted.current = false
      requestId.current += 1
      window.clearInterval(timer)
    }
  }, [refresh])

  const runAction = async (action: () => Promise<ActionResponse>, successText: string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    requestId.current += 1
    setBusy(true)
    setMessage(undefined)
    setError(undefined)
    try {
      const response = await action()
      if (!mounted.current) return
      if (response?.ok) {
        setMessage(successText)
      } else {
        setError(response?.error ?? JSON.stringify(response))
      }
      await refresh()
    } catch (err) {
      if (mounted.current) setError('操作失败: ' + String(err))
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const onAdjust = (scopeKey: string, limitTokens: number): void => {
    if (!Number.isSafeInteger(limitTokens) || limitTokens < 1) return
    void runAction(
      () => fetchJson<ActionResponse>('/adjust-limit', {
        method: 'POST',
        body: JSON.stringify({ scopeKey, limitTokens }),
      }),
      '上限已更新',
    )
  }

  const onReset = (scopeKey: string): void => {
    if (!window.confirm(`确认重置 ${scopeKey} 的用量？`)) return
    void runAction(
      () => fetchJson<ActionResponse>('/reset', {
        method: 'POST',
        body: JSON.stringify({ scopeKey }),
      }),
      '用量已重置',
    )
  }

  const statusText = error ?? loadError ?? message
  return (
    <div className="agb-page">
      <style>{styles}</style>
      <h3>Agent Token 预算（dsh-plugin-agent-budget）</h3>
      <p className="agb-stats">共 {scopes.length} 个预算作用域</p>
      {statusText !== undefined && (
        <div className="agb-msg" role="status" style={{ display: 'block', borderColor: error !== undefined || loadError !== undefined ? '#d33' : 'var(--theme-border,#333)' }}>
          {statusText}
        </div>
      )}
      <ul className="agb-list">
        {scopes.length === 0
          ? <li className="agb-item">{loading ? '加载中…' : loadError ? '预算暂不可用' : '（暂无已开启的预算作用域）'}</li>
          : scopes.map(scope => (
            <ScopeRow
              key={scope.scopeKey}
              scope={scope}
              busy={busy}
              onAdjust={onAdjust}
              onReset={onReset}
            />
          ))}
      </ul>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'agent-budget-settings',
      order: 60,
      label: () => 'Token 预算',
    }, AgentBudgetSection),
  ), 'agent-budget: settings page')
}
