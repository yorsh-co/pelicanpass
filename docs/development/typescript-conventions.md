# TypeScript Conventions

Rules that govern every `.ts` file in this repo. They are not style preferences — each
one exists because the alternative breaks at runtime, at lint time, or silently.

Established during the JavaScript → TypeScript migration. The full migration log, including
what each phase's conversion turned up, is in the private archive repository:
`git show 56eaa23:docs/typescript-migration.md`.

---

## 1. Import specifiers name the file on disk

The backend has **no build step** — `.ts` runs directly on Node 24 via native type
stripping, and **Node resolves import specifiers literally.** TypeScript's `./foo.js`
convention does not apply:

```ts
import { env } from '../config/env.ts'; // ✅ correct
import { env } from '../config/env.js'; // ❌ ERR_MODULE_NOT_FOUND at boot
```

The dangerous part: `tsc` accepts _both_ forms and resolves `.js` → `.ts` happily. A
stale specifier **type-checks clean and dies at boot**. `npm run typecheck` will not
catch it.

`npm run lint` will. `eslint.config.js` runs `import-x/no-unresolved` against import-x's
**Node** resolver, which resolves literally — the same rule Node applies. Verified end
to end:

| Specifier (only `mod.ts` exists) | `tsc` | `node` | `eslint` |
| -------------------------------- | ----- | ------ | -------- |
| `'./mod.js'`                     | 0     | crash  | error    |
| `'./mod.ts'`                     | 0     | 0      | 0        |

The rule **skips type-only imports**, which is correct — they are erased before Node
sees them, so a stale one cannot break a boot. It also means a probe written with
`import type` reports nothing and looks like a resolver failure; use a value import when
testing the rule itself.

> **Do not add `eslint-import-resolver-typescript`.** It is the wrong resolver here: it
> implements TS's `.js` → `.ts` mapping and so reproduces exactly the blind spot this
> rule exists to close. import-x's built-in `createNodeResolver` is what we need, and no
> extra resolver package is required.

The frontend is bundled by esbuild, which resolves either form. It uses `.ts` specifiers
anyway, so there is one rule repo-wide instead of two.

---

## 2. `erasableSyntaxOnly` is on

Node strips types rather than compiling them, so only syntax that erases to nothing is
legal. These are compile errors **by design** — do not reach for them:

| Banned                               | Use instead                                                                |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `enum Foo { ... }`                   | `const FOO = { ... } as const` + `type Foo = typeof FOO[keyof typeof FOO]` |
| `namespace Foo { ... }`              | A module                                                                   |
| `constructor(private readonly x: T)` | An explicit field declaration + assignment                                 |

---

## 3. Augmenting Express types

Use `declare module 'express-serve-static-core'`, **not**
`declare global { namespace Express }`. Both reach `Request` and both satisfy
`erasableSyntaxOnly`, but the global-namespace form trips
`@typescript-eslint/no-namespace` — `tsc` reports 0, `eslint` reports 1.

`src/types/express.d.ts` **must contain a top-level `import`**. In a script file (no
top-level import or export), `declare module 'x'` declares an ambient module that
_replaces_ the real one instead of merging into it.

---

## 4. Lint strictness

`eslint.config.js` runs typescript-eslint's `strictTypeChecked`. It stays. The two
places it reliably fires — `JSON.parse` off Redis and `response.json()` off Turnstile —
are genuine trust boundaries that deserve an explicit assertion rather than a silent
`any`.

`eslint.config.js` is the only JavaScript file left in the repo, and stays that way
deliberately. Converting it costs a new devDependency: ESLint 10.8 declares `jiti` as a
peer and refuses to load a TypeScript config without it. ESLint would then transpile its
own config on every run to gain nothing on a file that is already `// @ts-check`ed and
covered by the backend tsconfig.

Before pushing, `npm run check` runs formatting, lint and both typecheck projects, then the unit tests.
Lint is the one that catches stale import specifiers, so a green `typecheck` alone is
not sufficient.
