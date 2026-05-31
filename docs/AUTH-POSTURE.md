# Auth Posture & Runbooks (ROADMAP Phase-0 Criterion 4)

> Phase 0 **documents and provisions** the credential posture. It wires **no** auth code.
> YNAB PAT is the active v1 credential; Google OAuth is documented now, **wired in Phase 2**.

## 1. YNAB — Personal Access Token (ACTIVE in v1)

The locked v1 credential (CONTEXT.md / PROJECT.md). PAT is chosen over OAuth for v1 because it
**never expires** and does not depend on a rotating refresh token.

**Provision:**

1. YNAB → **Account Settings → Developer Settings → New Token**.
2. Copy the token once (it is shown only once).
3. Store it as the **`YNAB_PAT`** secret (local `.env` for dev, GitHub Secret in CI — see
   `SECRETS.md`). Never commit or log it.

**Properties:**

- **Never expires** (no refresh lifecycle to manage).
- **Full read-write by default** — this is the account-scoped least-privilege option YNAB
  offers for a PAT; there is no narrower PAT scope. Marked least-privilege within YNAB's PAT model.
- Rate limit: 200 requests/hour (operational note for Phase 4+).

**Port mapping:** PAT is consumed by `PatTokenStore`, the **active** implementation of the
`TokenStore` port. `OAuthTokenStore` is **built-but-dormant** until a later phase (Phase 4).

## 2. Google OAuth — Gmail (DOCUMENTED now, WIRED in Phase 2)

Gmail read access uses OAuth 2.0 with a long-lived refresh token (`google-auth-library`
`OAuth2Client`). **Wiring is Phase 2** — Phase 0 only provisions the posture and records the
one operational landmine that causes a guaranteed recurring outage if mishandled.

### The 7-day refresh-token death (Pitfall 1 — must be neutralized before any live run)

With the OAuth consent screen in **Testing** status and user type **External**, Google
**revokes refresh tokens after 7 days** (unless the only scopes are name/email/profile). An
unattended job works for ~a week, then every run fails `invalid_grant` ("Token has been
expired or revoked") — a silent, recurring total outage.

### Fix (verified against Google docs)

1. Google Cloud Console → **Google Auth Platform → Audience**.
2. Click **"Publish app"** → publishing status becomes **"In production"**.
   - A project is considered _In production_ after selecting **Publish app**.
3. For self-use (**< 100 users**) the app may remain **unverified** — the user clicks through
   the "unverified app" warning at consent. Verification is only required to exceed 100 users.
4. **Re-issue the refresh token AFTER publishing.** A Testing-era token already carries the
   final 7-day clock and **cannot be revived** (a revoked Google refresh-token event is final).
   Re-run the one-time consent flow to mint a durable token, then store **that** token as the
   Gmail refresh-token GitHub Secret (see `SECRETS.md`).
5. In Production, refresh tokens expire only on: user revocation, **6 months** of non-use, a
   password change (for Gmail scopes), or admin restriction.

**Warning sign:** runs green for ~7 days, then all fail `invalid_grant`.

**Scope:** request only **`gmail.readonly`** — least privilege; the pipeline only reads
notification emails.

**Phase note:** Phase 0 = document + provision the OAuth Production posture (criterion 4).
Gmail **wiring** (token storage, message fetch) is **Phase 2**.

## Least-Privilege Summary

| Credential  | Scope                      | Least-privilege rationale                                                               |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------- |
| YNAB PAT    | account-scoped, read-write | Narrowest PAT scope YNAB offers; alternative (OAuth read-only) is dormant until Phase 4 |
| Gmail OAuth | `gmail.readonly`           | Read-only — the job never mutates the mailbox                                           |

## Pending User Actions (for the phase-gate review of Criterion 4)

- [ ] YNAB PAT issued and stored as `YNAB_PAT`.
- [ ] Google OAuth consent screen published to **In production** and a fresh refresh token
      re-issued (the re-issue can be deferred to when Gmail is wired in Phase 2, but the
      Production publish should happen before any live Gmail run to avoid the 7-day clock).
