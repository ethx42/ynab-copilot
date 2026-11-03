import { createHash } from "node:crypto";
import type { NormalizedTransaction } from "./transaction.js";

// YNAB `import_id` is at most 36 characters. Format: `<BANK>:<32 hex>` (35 chars), where the
// hex is the SHA-256 of `<bank>|<Gmail message id>|<position inside that email>`.
//
// Why the email, not the amount/time: the id must not depend on which OTHER alerts happen to be
// inside the Gmail lookback window (a counter would shift after an outage and silently turn a
// real purchase into a "duplicate"), and it must stay within 36 chars for any amount. Every bank
// alert is its own email, so two genuinely identical purchases get two different ids, while a
// re-read of the same email always yields the same id and YNAB reports it in
// `duplicate_import_ids` instead of creating it twice.
const BANK_CODE: Record<NormalizedTransaction["bank"], string> = {
  bancolombia: "BC",
  bancodebogota: "BB",
};

// Used to recognise the rows this pipeline created (e.g. to count the unapproved ones).
export const isPipelineImportId = (importId: string): boolean =>
  Object.values(BANK_CODE).some((code) => importId.startsWith(`${code}:`));

export const importIdFor = (tx: NormalizedTransaction, positionInMessage: number): string => {
  const digest = createHash("sha256")
    .update(`${tx.bank}|${tx.sourceMessageId}|${String(positionInMessage)}`)
    .digest("hex")
    .slice(0, 32);
  return `${BANK_CODE[tx.bank]}:${digest}`;
};

export type WithImportId = { readonly tx: NormalizedTransaction; readonly importId: string };

// The position counts transactions of the SAME email in the order they were parsed, so it is
// stable for a given email regardless of what else is in the batch.
export const assignImportIds = (txs: readonly NormalizedTransaction[]): WithImportId[] => {
  const seenPerMessage = new Map<string, number>();
  return txs.map((tx) => {
    const position = seenPerMessage.get(tx.sourceMessageId) ?? 0;
    seenPerMessage.set(tx.sourceMessageId, position + 1);
    return { tx, importId: importIdFor(tx, position) };
  });
};
