# Contributing to dsh-plugin-agent-budget

Thanks for your interest! This project is intentionally small, but it touches
DSH session events, `llm/stream` hooks, and tool registration, so a few
guidelines help keep it reliable.

## Development

Requirements:

- Node.js `^22.19.0` or `>=24.0.0`
- pnpm `11.7.0`

```bash
pnpm install
pnpm check
```

`pnpm check` runs:

1. `tsc --noEmit`
2. oxlint
3. vitest unit/integration tests
4. `tsdown` build
5. `verify-pack.mjs` (publint + `npm pack` artifact verification)

## Tests

- Tests use deterministic mock streams by default.
- `pnpm test:smoke` runs a small real DeepSeek request only when
  `DEEPSEEK_API_KEY` is set; otherwise it is skipped.
- When changing accounting behavior, add or update tests in `tests/` that fold
  event logs and verify admission decisions.

## Design constraints

Please read [docs/design.md](docs/design.md) before changing behavior. The most
important invariants are:

- The ledger must be a pure fold of session events, so it stays replayable.
- `budget/open` must remain fixed after the first metered call in a root
  session.
- Unknown or invalid provider usage must fail closed by default.
- The plugin should stay self-contained: no UI, no external service, no
  mandatory cost/carbon features.

## Pull request checklist

- [ ] `pnpm check` passes locally
- [ ] New behavior has a test
- [ ] README/docs updated if user-facing behavior changed
- [ ] No unrelated formatting churn

## Code style

- TypeScript strict mode with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`.
- Keep the public export shape minimal:
  `name`, `inject`, `apply`, `Config`, and no default export.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
