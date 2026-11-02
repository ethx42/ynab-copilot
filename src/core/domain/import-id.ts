import type { NormalizedTransaction } from "./transaction.js";

// YNAB `import_id` max length is 36. Format: `<BANK>:<ACCT>:<YYYYMMDD>T<HHMM>:<PESOS>:<N>`
// e.g. `BC:8139:20261102T0800:217375:1` (31 chars). Deterministic from the bank's own
// printed fields, so re-running the pipeline can never create a duplicate: YNAB lists
// repeats in `duplicate_import_ids` instead of creating them.
const BANK_CODE: Record<NormalizedTransaction["bank"], string> = {
  bancolombia: "BC",
  bancodebogota: "BB",
};

export const baseImportKey = (tx: NormalizedTransaction): string => {
  const acct = tx.account.kind === "last4" ? tx.account.last4 : "SAV";
  const stamp = `${tx.date.replaceAll("-", "")}T${tx.time.replace(":", "")}`;
  return `${BANK_CODE[tx.bank]}:${acct}:${stamp}:${tx.amountPesos}`;
};

export type WithImportId = { readonly tx: NormalizedTransaction; readonly importId: string };

// Two genuinely identical purchases in the same minute (same card, same amount) need
// distinct ids: the Nth repeat of a base key gets `:N`. Callers MUST pass transactions in a
// stable order (Gmail internalDate, then message id) so the same email always gets the same N.
export const assignImportIds = (txs: readonly NormalizedTransaction[]): WithImportId[] => {
  const seen = new Map<string, number>();
  return txs.map((tx) => {
    const base = baseImportKey(tx);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { tx, importId: `${base}:${n}` };
  });
};
