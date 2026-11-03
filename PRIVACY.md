# Privacy

ynab-copilot is a personal, single-user tool. It is not offered to the public and has no
other users.

**What it accesses.** With the owner's explicit consent and read-only permission
(`gmail.readonly`), it reads the owner's own bank notification emails (sender domain
`notificacionesbancolombia.com`) and uses them to create transactions in the owner's own YNAB
budget.

**What it stores.** Nothing. It keeps no database and no copy of any email. Credentials live
only in the owner's encrypted GitHub Actions secrets. Workflow logs contain only counts, error
codes and message ids — never email contents, merchants, amounts or card digits.

**What it shares.** Nothing is sold, shared or used for advertising. Data is sent only to the
owner's own YNAB account.

**Contact / revoking access.** The owner can revoke the Gmail permission at any time at
https://myaccount.google.com/permissions.
