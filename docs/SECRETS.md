# Secrets Posture (QG-05)

> **Rule, one line:** Every secret is sourced **only** from a local `.env` (gitignored) or
> **GitHub Secrets** in CI. Never committed, never logged, never placed in a URL.

This document is the QG-05 contract: secrets never appear in code, logs, or URLs; they are
stored in env / GitHub Secrets with least-privilege scopes. It is enforced by `.gitignore`,
the zod env edge (`src/config/env.ts`), and the logging rule below.

## Secret Inventory

| Secret | Purpose | Status (v1) | Source of truth | Scope |
|--------|---------|-------------|-----------------|-------|
| `YNAB_PAT` | YNAB Personal Access Token — authenticates every YNAB write | **ACTIVE** | YNAB → Account Settings → Developer Settings → New Token | Account-scoped, read-write, never expires (see `AUTH-POSTURE.md`) |
| `YNAB_BUDGET_ID` | Target YNAB budget UUID | **ACTIVE** | YNAB budget URL / API | Single budget |
| `ANTHROPIC_API_KEY` | Claude (tier-3 judgment layer) API key | Active (wired Phase 5) | Anthropic Console → API Keys | Static key, rotate manually |
| Gmail OAuth **refresh token** | Unattended Gmail read | **FUTURE** (Phase 2 wiring) | One-time local consent flow after OAuth app is "In production" (see `AUTH-POSTURE.md`) | `gmail.readonly` (least privilege) |

The canonical name list lives in **`.env.example`** (names + provenance only, **no values**).
`.env.example` is the single source of truth for which env vars exist.

## Storage Rules

- **Local development:** a gitignored `.env`, loaded with Node 24's native `--env-file=.env`
  (no `dotenv` dependency). `.env` MUST NOT be committed.
- **CI (GitHub Actions):** values are injected as **GitHub Secrets** → env vars. The CI quality
  gate (`.github/workflows/ci.yml`) deliberately requires **no secrets** — it runs on the
  skeleton, so no secret is ever present in a gate job's environment or logs.
- **No secret in a URL** — never append a token as a query param; pass via header / SDK
  bearer-token argument only.

## `.gitignore` Enforcement

`.gitignore` excludes the entire `.env*` family and re-includes only the example:

```
.env
.env.*
!.env.example
```

Verify locally: `git check-ignore .env` exits 0 (ignored); `git check-ignore .env.example`
exits 1 (tracked). Proven in plan 00-01.

## Logging Rule (V7 Error Handling & Logging)

- **Never** `console.log(process.env)` or print a raw secret value anywhere.
- When validation fails at the env edge, log **only** the zod `error.issues` — the array of
  `{ path, message }` — never the raw input that may contain a secret value. This is exactly
  what `formatEnvIssues` in `src/config/env.ts` does (proven in plan 00-02 to not echo a
  secret sentinel).
- Structured logging (pino) lands later; when it does, use **redaction paths** for any field
  that could carry a token/PII. GitHub additionally masks registered Secrets in Actions logs,
  but masking is a backstop, not a substitute for never logging them.

## Threat Mitigations Referenced

- **T-0-03 (Information Disclosure — secrets in code/logs):** this document + the
  log-only-issues rule + gate jobs using no secrets + GitHub secret masking.
- **T-0-SC (Tampering — dependency install):** `pnpm install --frozen-lockfile` in CI and a
  pinned `packageManager` (orthogonal to secrets, but part of the same supply-chain posture).
