<!-- GSD:project-start source:PROJECT.md -->

## Project

**ynab-copilot**

An unattended, daily pipeline that reads bank transaction notification emails (Bancolombia,
Banco de Bogotá), parses them, resolves each transaction to the correct YNAB account, and
records it in [YNAB](https://www.ynab.com/) — with no manual export, no manual trigger. Built
for a single user (Santiago) but architected with tenant-agnostic seams so it can later become
a multi-user "selling service" by extraction rather than rewrite.

**Core Value:** Every email-notified transaction lands in the **correct YNAB account, same day, automatically**
— and a transaction is *never* silently lost. (A few minutes' scheduling delay is fine; a
dropped transaction is not.)

### Constraints

- **Tech stack**: TypeScript throughout — single Normalized Transaction type as the internal
  contract; strong typing at every seam. (Aligns with the existing YNAB client.)

- **Architecture**: Hexagonal / ports-and-adapters — pure core, impure edges. Non-negotiable
  for testability, swappability, and the SaaS-ready seams.

- **Token efficiency**: Deterministic stages cost zero tokens; the model is invoked only for
  genuinely novel/ambiguous cases. Rules Map drives token cost *down* over time.

- **Resilience**: Fail loud, never silent. Unrecognized formats and zero-transaction business
  days must alert, never drop. Idempotent runs via deterministic `import_id`.

- **Security**: All secrets (Gmail creds, YNAB token, Claude API key) stored encrypted
  (GitHub Secrets / secrets manager); never in code, logs, or URLs. Least-privilege scopes,
  never logged.

- **Deployment**: Scheduled unattended execution via GitHub Actions (cron). Claude Code as the
  orchestration engine; Claude Cowork retained only for ad-hoc analysis.

- **Engineering quality gate (non-negotiable)**: Enterprise-grade TypeScript. `strict` (and
  ideally `strictest`) tsconfig, no implicit `any`, no unchecked casts at trusted boundaries;
  zod validation at every untrusted edge (email input, Claude output) before any YNAB write.
  Linting + formatting enforced; meaningful unit tests for the pure core (adapters, resolution,
  dedup) with a fixture corpus; CI blocks merge on type-check, lint, or test failure. A
  codebase that doesn't meet enterprise-grade standards is not acceptable. — Mandated by the user.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Node.js** | **24.x (Active LTS)** | Runtime for the unattended job | Active LTS through Oct 2026, maintained to Apr 2028. Native `fetch`, native test runner, stable ESM, native `--env-file`. Pin in `package.json` `engines` and `actions/setup-node`. (Node 22 is the conservative fallback — Maintenance LTS, supported to Apr 2027.) |
| **TypeScript** | **^5.9** (latest line is 6.0.3) | Type system; the single Normalized Transaction contract | Strong typing at every seam is a hard project constraint. **Recommend pinning ^5.9, not 6.x, at project start** — 6.0 is brand-new (released ~2026); let the ecosystem (`ts-jest`/`tsx`/`@typescript-eslint`) catch up before adopting. Revisit 6.x once toolchain support is confirmed. |
| **tsx** | **^4.22** | Run/execute TS directly (`tsx src/main.ts`) in CI + locally | Zero-config TS execution via esbuild. Ideal for a scheduled job: the GH Action entrypoint runs `tsx` with no separate build step. Faster startup than `ts-node`; respects `tsconfig` paths. |
| **zod** | **^4.4** (4.4.3 current) | Runtime validation + schema for: env vars, Normalized Transaction, YAML adapter config, **Claude tool-output validation** | The validation boundary of the hexagon. v4 is current, faster, smaller than v3. Single source of truth: derive TS types via `z.infer`. Validate every untrusted edge: email payloads, YAML, env, and especially the LLM's JSON output before it touches YNAB. |
| **ynab** | **^4.1** (4.1.0 current) | Official YNAB REST client (typed) | First-party, fully typed SDK. Accepts a bearer access token: `new ynab.API(accessToken)`. Wrap behind your YNAB port — the SDK does **not** manage OAuth refresh; you supply a fresh access token. Reuse the existing prototyped typed client/delta-sync if it wraps this. |
| **@googleapis/gmail** | **^17.0** (17.0.0 current) | Gmail API: `users.messages.list` / `.get` | Modular Gmail-only package. Far smaller install + faster cold start than the monolithic `googleapis` (~hundreds of APIs). Google officially recommends submodules when startup time matters — exactly the unattended-job case. |
| **google-auth-library** | **^10.6** (10.6.2 current) | `OAuth2Client` for Gmail unattended auth + automatic access-token refresh | Holds the long-lived Gmail **refresh token**; auto-acquires/refreshes access tokens on each call. This is the canonical unattended pattern (no interactive consent at runtime). Pulled in transitively by `@googleapis/gmail` but declare it explicitly since you construct the client. |
| **@anthropic-ai/sdk** | **^0.100** (0.100.1 current) | Claude (Messages API) for the tier-3 judgment layer only | First-party TS SDK. Use `client.messages.create` with **tool use / structured output** so Claude returns a typed JSON decision you validate with zod before trust. Invoked only on novel/ambiguous cases — keep it behind a `Judge` port so the core stays pure and the call is mockable. |
| **yaml** (eemeli/yaml) | **^2.9** (2.9.0 current) | Parse the declarative bank-adapter YAML | Actively maintained, spec-compliant, preserves comments, better error positions than `js-yaml`. Parse → validate the result with a zod schema → feed the YAML adapter engine. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **node-html-parser** | **^7.1** | Extract text/fields from HTML email bodies | Bank alerts are HTML. Lightweight, fast DOM querying (CSS selectors) without a full browser engine. Sufficient for pulling trailing-digits/amount/merchant from notification markup. |
| **cheerio** | **^1.2** | Heavier-duty HTML parsing alternative | Use instead of node-html-parser only if a bank's HTML is gnarly enough to want full jQuery-style traversal. Otherwise node-html-parser is leaner for this job. |
| **mailparser** | **^3.9** | Decode raw RFC822 MIME → structured `{ html, text, headers }` | Use when you fetch Gmail messages in `format=raw` (full MIME). If you instead use `format=full` and walk Gmail's `payload` parts + base64url-decode yourself, you may not need it. Recommend `raw` + mailparser for robustness against multipart/encoding quirks. |
| **pino** | **^10.3** | Structured JSON logging | "Fail loud, never silent" is a constraint. Structured logs make the GH Actions run auditable and alerting (zero-transaction day, unmatched sender) tractable. **Never log tokens/PII** — use redaction paths. |
| **dotenv** | not needed | — | Skip it. Node 24 has native `--env-file=.env` for local dev; in CI, GitHub Secrets are injected as env vars directly. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **Vitest** (^4.1) | Test runner for the pure core + adapter contract tests | First-class ESM + TS, near-zero config, fast watch, built-in mocking/coverage. Ideal for a hexagonal codebase: unit-test the pure core with no I/O; mock ports for adapter tests. Preferred over Jest (no `ts-jest`/babel/ESM friction). |
| **@typescript-eslint** (^8.x) + **ESLint 9** (flat config) | Lint/type-aware rules | Enforce the architectural seams (e.g. forbid core importing adapters). |
| **Prettier** (^3.x) | Formatting | Standard; pairs with ESLint flat config. |
| **tsup** (^8.5) | Optional bundler | Only if you want a single compiled artifact. For a `tsx`-run GH Action this is **optional** — you can ship source and run with `tsx`. Add tsup only if cold-start or distribution demands it. |

## Installation

# Core runtime deps

# Dev dependencies

# .github/workflows/ingest.yml (excerpt)

- uses: actions/setup-node@v4

## Auth Architecture (the load-bearing detail)

| Concern | Mechanism | Refresh behavior | Storage implication |
|---------|-----------|------------------|---------------------|
| **YNAB** | OAuth 2.0 Authorization Code. Access token via `new ynab.API(accessToken)`. | Access token expires in **7200s (2h)**. POST `grant_type=refresh_token` to `https://app.ynab.com/oauth/token`. **The refresh token ROTATES** — each refresh returns a *new* `refresh_token`; the old one is consumed. | **Critical for GH Actions:** a workflow run with a read-only Secret cannot persist the rotated refresh token. You must write the new refresh token back to GitHub Secrets via the `gh` API (PAT with `secrets:write`) at the end of each run, **or** store the token in an external KV (e.g. a tiny encrypted gist, Cloudflare KV, or a secrets manager) the job can write to. **Solve this in Phase 0 — it is the #1 operational pitfall.** |
| **Gmail** | OAuth 2.0 via `google-auth-library` `OAuth2Client`. Set the long-lived **refresh token** once (`setCredentials({ refresh_token })`, `access_type=offline`). | Library auto-acquires/refreshes the access token per call. The Gmail **refresh token is long-lived and does NOT rotate** under normal use — store it once in GitHub Secrets. Listen for the `'tokens'` event only if you want to capture a re-issued token. | Stable secret; far simpler than YNAB. Mint it once via a local interactive consent script, then commit only to Secrets. |
| **Anthropic** | Static API key (`ANTHROPIC_API_KEY`). | No refresh. | Plain GitHub Secret. Rotate manually. |

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `@googleapis/gmail` (modular) | `googleapis` (monolith, ^173) | Only if you need several Google APIs at once. For Gmail-only, the monolith just bloats install + cold start. |
| `google-auth-library` OAuth2Client | Service Account + domain-wide delegation | Only on Google Workspace where an admin can delegate. For a personal `@gmail.com` mailbox, delegation is unavailable — OAuth refresh token is the correct path. |
| Vitest | Node's built-in `node:test` runner | Viable and dependency-free for a small project. Choose it if you want zero test deps; Vitest wins on DX, mocking, and coverage ergonomics for adapter contract tests. |
| `@anthropic-ai/sdk` (direct) | Vercel AI SDK (`ai`) | Use the AI SDK only if you want provider-agnostic swapping or its tool/streaming abstractions. For a single-provider, single-call judgment layer, the first-party SDK is leaner and more direct. |
| `yaml` (eemeli) | `js-yaml` (^4.1) | js-yaml is fine and ubiquitous, but `yaml` has better error positions and comment handling — valuable when humans hand-author bank adapters. |
| `node-html-parser` | `cheerio` (^1.2) | Cheerio for complex/messy bank HTML needing full jQuery traversal. |
| `tsx` (run source) | `tsup`/`tsc` build step | Add a build step only if you need a distributable artifact or measurably faster cold start. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **YNAB Personal Access Token (PAT)** | Long-lived, all-access, unrevocable-per-scope credential — violates the project's least-privilege/rotatable security constraint, and the Key Decisions explicitly chose OAuth. | OAuth 2.0 Authorization Code + refresh-token rotation. |
| **`googleapis` monolith** for Gmail only | Pulls in hundreds of API surfaces → slower install + cold start in CI for no benefit. | `@googleapis/gmail` modular package. |
| **Storing the YNAB refresh token only in a static GitHub Secret with no write-back** | YNAB **rotates** the refresh token on every refresh. After the first refresh the stored token is stale → next run fails auth silently. | Write the rotated token back (gh secrets API or external KV) every run. |
| **`dotenv`** | Redundant on Node 24 (native `--env-file`); in CI secrets are env vars already. | Native `--env-file=.env` locally; GitHub Secrets in CI. |
| **`ts-node`** | Slower startup, more ESM/config friction than esbuild-based runners. | `tsx`. |
| **Jest** (with `ts-jest`/babel) | ESM + TS configuration overhead; slower. | Vitest (or `node:test`). |
| **`request` / `node-fetch`** for token calls | `request` is deprecated; `node-fetch` is unnecessary. | Native `fetch` (Node 18+) for the YNAB token POSTs. |
| **Trusting Claude's raw JSON output** | An LLM can emit malformed/hallucinated account IDs → wrong YNAB postings, which violates "never silently mis-resolve." | Force tool-use/structured output, then **validate with zod** and gate behind `approved=false` (per the cascade design) before any write. |
| **TypeScript 6.0** on day one | Brand-new major; toolchain (linters, runners, types) lag a new TS major. | Pin `^5.9` now; adopt 6.x after toolchain confirms support. |
| **Service Account auth for a personal Gmail** | Domain-wide delegation requires Workspace admin; impossible on a personal `@gmail.com`. | OAuth2Client + offline refresh token. |

## Stack Patterns by Variant

- Move token state to a tiny external store the job owns (encrypted gist, Cloudflare KV/D1, Deno KV, or a managed secrets manager) and keep only the *bootstrap* secret in GitHub Secrets.
- Because: GH Actions Secrets are designed to be read-mostly; rotating a value every run via the API works but is brittle and races if runs overlap. An external KV is the cleaner seam — and it aligns with the SaaS-ready posture (per-tenant token store later).
- Upgrade Gmail scope `gmail.readonly` → `gmail.modify` and re-consent once.
- Because: read-only cannot mutate labels; the trade is a slightly broader scope.
- Add `tsup` to emit a single bundled `dist/main.js` and run `node dist/main.js`.
- Because: bundling trims module resolution at startup; otherwise `tsx`-run source is simpler.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@googleapis/gmail@^17` | `google-auth-library@^10` | The 17.x line targets google-auth-library 10.x. Let the gmail package pull it transitively but pin `^10` to avoid a major drift. |
| `zod@^4` | `typescript@^5.5+` | zod v4 requires reasonably modern TS; fine on 5.9. If any dependency still expects zod v3 APIs, isolate it — v3→v4 has breaking changes. |
| `ynab@^4.1` | Node 18+ / native fetch | SDK takes a bearer token only; OAuth lifecycle is your code's responsibility. |
| `typescript@^5.9` | `tsx@^4`, `vitest@^4`, `@typescript-eslint@^8` | Verified-current toolchain. Holding at 5.9 (not 6.0) keeps this matrix green. |
| `@anthropic-ai/sdk@^0.100` | Node 18+ | Pre-1.0 SDK — pin exact-ish (`~0.100`) and read release notes before bumping; minor versions can carry breaking changes. |
| Node 24 | all of the above | Active LTS; native fetch, test runner, `--env-file`. |

## Sources

- `/ynab/ynab-sdk-js` (Context7) — client instantiation, bearer-token model, error shape — **HIGH**
- `/websites/api_ynab` (Context7) + https://api.ynab.com/ (official) — OAuth Authorization Code + refresh flow, 2h access-token expiry, refresh-token rotation, `read-only` scope, 200 req/hr rate limit — **HIGH**
- `/websites/googleapis_dev_nodejs_googleapis` (Context7) — `OAuth2Client.setCredentials`, `access_type=offline`, `tokens` event, auto-refresh, Gmail client init — **HIGH**
- npm registry (live, 2026-05-30) — current versions: ynab 4.1.0, @googleapis/gmail 17.0.0, google-auth-library 10.6.2, @anthropic-ai/sdk 0.100.1, zod 4.4.3, vitest 4.1.7, tsx 4.22.3, typescript 6.0.3, yaml 2.9.0, node-html-parser 7.1.0, mailparser 3.9.9, pino 10.3.1 — **HIGH**
- nodejs.org Release schedule / endoflife.date — Node 24 Active LTS (to Oct 2026), Node 22 Maintenance LTS (to Apr 2027) — **HIGH**
- npmjs.com `@googleapis/gmail` + googleapis maintenance-mode note — modular-over-monolith recommendation — **MEDIUM** (Google guidance, phrasing inferred)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
