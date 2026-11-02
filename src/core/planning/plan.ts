import { assignImportIds } from "../domain/import-id.js";
import type { NormalizedTransaction } from "../domain/transaction.js";
import { toDraft, type YnabTransactionDraft } from "../domain/ynab-draft.js";
import { resolveAccount, type AccountRegistry } from "../resolution/account-registry.js";

export type PlanItem =
  | { readonly status: "ready"; readonly draft: YnabTransactionDraft }
  | {
      readonly status: "needs_review";
      readonly tx: NormalizedTransaction;
      readonly importId: string;
      readonly reason: "unknown_last4" | "no_product_fallback" | "card_payment_needs_transfer";
    };

// Turns parsed transactions into either a ready-to-write draft or an explicit review item.
// Nothing is dropped: every input produces exactly one PlanItem (core value: never silently lose).
// `txs` MUST be in a stable order (see assignImportIds).
export const planTransactions = (
  txs: readonly NormalizedTransaction[],
  registry: AccountRegistry,
): PlanItem[] =>
  assignImportIds(txs).map(({ tx, importId }): PlanItem => {
    // Paying the card from savings is a TRANSFER between two YNAB accounts, not an expense:
    // it needs the transfer payee of the target account, so a human routes it for now.
    if (tx.kind === "card_payment") {
      return { status: "needs_review", tx, importId, reason: "card_payment_needs_transfer" };
    }
    const resolution = resolveAccount(tx, registry);
    if (resolution.status === "unresolved") {
      return { status: "needs_review", tx, importId, reason: resolution.reason };
    }
    return { status: "ready", draft: toDraft(tx, resolution.ynabAccountId, importId) };
  });
