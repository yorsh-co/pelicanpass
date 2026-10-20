# Contributing

This is a portfolio project provided as is (see the [Disclaimer](./README.md#disclaimer)). Issues
and pull requests are read when time allows and may not be answered or merged. Forking under the
[MIT License](./LICENSE) is always welcome.

**Security issues never go in an issue or pull request.** Follow [`SECURITY.md`](./SECURITY.md).

## Workflow

The repository follows git-flow:

- `main` holds released code; `develop` is the integration branch.
- Branch from `develop` with a type prefix: `feature/`, `fix/`, `bugfix/`, `refactor/`, `docs/` or
  `chore/`, for example `fix/compose-redis-password-guard`.
- Merge back into `develop` with `--no-ff`, so each branch stays visible as one unit in history.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`,
with a body explaining _why_ when the change is not self-evident.

## Before pushing

```bash
npm run check
```

It is the pre-push gate: format, lint, typecheck, i18n and content checks, then the unit tests. It must pass.

The unit tests cover pure logic only, with no database or Redis. Verify behaviour against the running
stack, using the acceptance checks in [`docs/operations/deployment.md` § Verification](./docs/operations/deployment.md#verification) for anything that
touches routing, limits, sessions or infrastructure.

## Style

- Formatting is Prettier's; run `npm run format`.
- TypeScript rules and their reasons: [`docs/development/typescript-conventions.md`](./docs/development/typescript-conventions.md).
- Comments and module headers follow the README's [Development](./README.md#development) section
  ("House style").
- User-facing text goes through the message catalogs, never inline:
  [`docs/development/copy-management.md`](./docs/development/copy-management.md).
