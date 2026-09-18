// @vitest-environment jsdom
import { act, createElement } from 'react'
import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

let container: HTMLDivElement
let root: Root
const scope = { scopeKey: 'root', limitTokens: 100, usedTokens: 10, remainingTokens: 90, exhausted: false, unmeteredCalls: 0 }
const fetchMock = vi.fn<typeof fetch>()
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  fetchMock.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  let component: ComponentType | undefined
  apply({
    effect: callback => callback(),
    slots: {
      inject: (_key, factory) => factory(),
      register: (_options, entry) => { component = entry; return () => {} },
    },
  })
  if (!component) throw new Error('settings component missing')
  const entry = component
  await act(async () => root.render(createElement(entry)))
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')]
}

describe('settings interactions', () => {
  it('preserves an API error instead of overwriting it with a refresh', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, scopes: [scope] }))
    await mount()
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: 'cannot reset an active scope' }, 409))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => buttons()[1]!.click())
    expect(container.querySelector('[role="status"]')?.textContent).toContain('cannot reset an active scope')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('x-agent-budget-request')).toBe('1')
  })

  it('refreshes the controlled limit value after adjustment', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, scopes: [scope] }))
    await mount()
    fetchMock.mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply({ ok: true, scopes: [{ ...scope, limitTokens: 200 }] }))
    await act(async () => buttons()[0]!.click())
    expect(container.querySelector('input')?.value).toBe('200')
    expect(buttons()[0]?.disabled).toBe(false)
  })

  it('allows invalid numeric input to be corrected while disabling submission', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, scopes: [scope] }))
    await mount()
    const input = container.querySelector('input')!
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!
    await act(async () => {
      descriptor.set!.call(input, '0')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttons()[0]?.disabled).toBe(true)
    expect(input.disabled).toBe(false)
    await act(async () => {
      descriptor.set!.call(input, '50')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttons()[0]?.disabled).toBe(false)
  })

  it('does not reset when confirmation is cancelled', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, scopes: [scope] }))
    await mount()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => buttons()[1]!.click())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows unavailable state when the initial load fails', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: 'forbidden' }, 403))
    await mount()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('forbidden')
    expect(container.querySelector('li')?.textContent).toBe('预算暂不可用')
  })
})
