# Corpus Fixtures Manifest

Golden email/SMS corpus wired as CI fixtures for the pure-core unit tests (QG-03).
Source of truth: `.planning/corpus/CORPUS-FINDINGS.md` (catalogued from real Gmail samples,
2026-05-30). Fixtures are copied here verbatim — never reformatted (see `.prettierignore`).

- **Real `.eml`** (true MIME fixture): `bancolombia/bancolombia-cc-purchase-RAW.eml` — the only
  raw email sample today. `multipart/alternative`; the `text/plain` part is quoted-printable with
  soft line-wraps. Match on the `From`/DKIM domain `notificacionesbancolombia.com`.
- **Extracted `.txt`** (prose transcribed from PDF-only Gmail exports): the remaining fixtures.
  PDFs are Gmail *exports*, not raw MIME, so they are not parseable email fixtures — the catalogued
  prose strings are transcribed instead. Do NOT treat `.txt` fixtures as MIME.

## Per-template trailing-digit catalogue

| Bank | Product | Template | Identifier as seen | Trailing-digit count / position | Amount style | Date format | Fixture |
|------|---------|----------|--------------------|---------------------------------|--------------|-------------|---------|
| Bancolombia | Credit card | B-1 (CC purchase) | `T.Cred *0338` | 4 digits, after `T.Cred *`, mid-sentence | CO `COP39.088,00` (dot=thousands, comma=decimals) | `DD/MM/YYYY a las HH:MM` | bancolombia/bancolombia-2026-cc-purchases-and-qr.txt |
| Bancolombia | Credit card | B-1b (CC purchase, acct at END) | `T.Cred *0338` | 4 digits, after `T.Cred *`, at sentence end | CO `COP111.850,00` | `DD/MM/YYYY a las HH:MM` | bancolombia/bancolombia-2026-cc-purchases-and-qr.txt |
| Bancolombia | Savings | **B-2 (savings INFLOW)** | **`AHORROS` — NO NUMBER** | **0 digits — product-type word only (the load-bearing exception)** | US `$15,823,003.00` (comma=thousands, dot=decimals) | inverted `el HH:MM a las DD/MM/YYYY` | bancolombia/bancolombia-savings-inflow-and-cc-purchase.txt |
| Bancolombia | Savings | B-3 (QR payment outflow) | `cuenta *1560` | 4 digits, after `cuenta *` | US `$80,000.00` | `DD/MM/YYYY a las HH:MM` | bancolombia/bancolombia-2026-cc-purchases-and-qr.txt |
| Bancolombia | Savings | B-4 (transfer, 2023) | `cta *1560` | 4 digits, after `cta *` | US `$200,000` (sometimes no decimals) | `DD/MM/YYYY HH:MM` | bancolombia/bancolombia-2023-transfers-and-cc-payment.txt |
| Bancolombia | Credit card | B-5 (CC payment from savings, 2023) | `tarjeta *2075` (from `cta *1560`) | 4 digits each, after `*` | US `$5,659,564` | `DD/MM/YYYY HH:MM` | bancolombia/bancolombia-2023-transfers-and-cc-payment.txt |
| Banco de Bogotá | Savings + CC | BDB-1 (Pago de Obligación) | savings `No. 3172`, obligación `2596` | 4 digits each, label-anchored | CO `$ 140,00` (label `Monto`, NOT `Costo de la transacción`) | ISO `YYYY-MM-DD HH:MM:SS` | bancodebogota/bancodebogota-pago-obligacion.txt |

### The AHORROS no-number exception (load-bearing)

Template **B-2** (Bancolombia savings inflow, `Recibiste un pago ... a tu cuenta AHORROS`) names the
product **TYPE word "AHORROS" only — with no trailing digits**. The deterministic trailing-digit
join therefore CANNOT resolve this template; it requires a **product-type fallback** (single savings
account) in Phase 3. Every other template carries 4 trailing digits as the tier-1 join key. This
exception is encoded as an assertion in `tests/corpus.test.ts`.

> Note: `*0338` (current) and `*2075` (2023) are two CC last-4s likely mapping to the same YNAB
> credit-card account (reissued card) — the registry must tolerate many last-4 → one account.

## Documented Gaps (copied verbatim from CORPUS-FINDINGS.md "## Gaps")

Still needed for a complete Phase-0 corpus — corpus-collection follow-up, NOT fabricated here:

- [ ] Banco de Bogotá: a **card purchase**, a **savings inflow**, a **savings outflow/transfer** sample.
- [ ] **Credit line** samples for both banks (no sample yet).
- [ ] At least one **failed/rejected** transaction (to test the success-flag guard).
- [ ] Raw **`.eml`/HTML** exports (not PDF) — true fixtures for parser unit tests. PDFs catalogued in
  CORPUS-FINDINGS.md; only one raw `.eml` exists today (`bancolombia-cc-purchase-RAW.eml`).

Banco de Bogotá everyday alerts arrive as **SMS** (shortcode 85264) forwarded to Gmail; the
SMS→email forwarding wrapper format is still undecided (Phase-0 blocker for the BdB adapter). BdB is
a deferred fast-follow, so the corpus is intentionally Bancolombia-heavy today.
