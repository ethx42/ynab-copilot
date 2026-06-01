# Branch Protection — making the CI gate BLOCK merges (QG-04)

The `ci` workflow (`.github/workflows/ci.yml`) only _runs_ the quality gate. A workflow alone
does **not** block a merge. Branch protection with **required status checks** is what turns
"CI runs" into "a red build cannot be merged" — this is what satisfies QG-04.

## Required status check names

These are the check names exactly as GitHub displays them on a PR (verified on a real run).
Branch protection must require all five:

- `quality (typecheck)`
- `quality (lint)`
- `quality (format:check)`
- `quality (test)`
- `boundaries`

> Note: GitHub registers a check name as "available" only after it has run at least once on the
> repo. All five have already run (on the green push to `main` and on the `ci-redproof` PR), so
> they are selectable.

## Apply via `gh api` (repo owner / admin token)

Requires a token with admin on the repo (the `repo` scope covers owned repos). Run as the repo
owner (`ethx42`):

```bash
gh api -X PUT repos/ethx42/ynab-copilot/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "quality (typecheck)" },
      { "context": "quality (lint)" },
      { "context": "quality (format:check)" },
      { "context": "quality (test)" },
      { "context": "boundaries" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

- `strict: true` — branches must be up to date with `main` before merging.
- `enforce_admins: true` — even admins cannot bypass the red gate (drop to `false` if you want an
  admin override hatch).
- `required_pull_request_reviews: null` — no human-review requirement is added here (this gate is
  about the automated checks; add reviews later if desired).
- `restrictions: null` — no push-actor restriction.

Verify it stuck:

```bash
gh api repos/ethx42/ynab-copilot/branches/main/protection \
  --jq '.required_status_checks.checks[].context'
```

## Apply via the GitHub UI (equivalent)

1. Repo → **Settings → Branches → Add branch protection rule** (or edit the rule for `main`).
2. **Branch name pattern:** `main`.
3. Enable **Require status checks to pass before merging**.
4. Enable **Require branches to be up to date before merging** (= `strict: true`).
5. In the check search box, add each of the five names above.
6. (Optional) Enable **Do not allow bypassing the above settings** (= `enforce_admins: true`).
7. **Create / Save changes.**

## Verify it BLOCKS (the QG-04 proof)

1. Open the deliberately-broken PR from branch `ci-redproof`
   (https://github.com/ethx42/ynab-copilot/pull/new/ci-redproof). It adds an implicit-any type
   error, so `quality (typecheck)` goes **red**.
2. With branch protection active, the PR must show **"Required statuses must pass before merging"**
   and the **Merge** button disabled — a red build literally cannot merge.
3. After confirming, close the PR and delete the `ci-redproof` branch (and remove
   `src/_ci_redproof.ts` if it ever lands anywhere).

The green baseline is already proven: the push to `main` ran all five checks green
(`gh run list --repo ethx42/ynab-copilot`).
