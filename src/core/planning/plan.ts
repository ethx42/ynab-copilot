import {
  applyCategoryRule,
  EMPTY_CATEGORY_RULES,
  type CategoryRules,
} from "../categorization/category-rules.js";
import { assignImportIds } from "../domain/import-id.js";
import type { NormalizedTransaction } from "../domain/transaction.js";
import { toDraft, type YnabTransactionDraft } from "../domain/ynab-draft.js";
import {
  resolveAccount,
  resolveTransferTarget,
  type AccountRegistry,
} from "../resolution/account-registry.js";

export type PlanItem =
  | { readonly status: "ready"; readonly draft: YnabTransactionDraft }
  | {
      readonly status: "needs_review";
      readonly tx: NormalizedTransaction;
      readonly importId: string;
      readonly reason: "unknown_last4" | "no_product_fallback" | "transfer_target_unknown";
    };

// Turns parsed transactions into either a ready-to-write draft or an explicit review item.
// Nothing is dropped: every input produces exactly one PlanItem (core value: never silently lose).
export const planTransactions = (
  txs: readonly NormalizedTransaction[],
  registry: AccountRegistry,
  rules: CategoryRules = EMPTY_CATEGORY_RULES,
): PlanItem[] =>
  assignImportIds(txs).map(({ tx, importId }): PlanItem => {
    const resolution = resolveAccount(tx, registry);
    if (resolution.status === "unresolved") {
      return { status: "needs_review", tx, importId, reason: resolution.reason };
    }
    // Paying a card from savings is a TRANSFER between two YNAB accounts, not an expense. A
    // transfer whose other side is unknown is never guessed: a human routes it.
    const target = resolveTransferTarget(tx, registry);
    if (target.status === "unresolved") {
      return { status: "needs_review", tx, importId, reason: target.reason };
    }
    if (target.status === "transfer") {
      if (target.ynabAccountId === resolution.ynabAccountId) {
        return { status: "needs_review", tx, importId, reason: "transfer_target_unknown" };
      }
      return {
        status: "ready",
        draft: toDraft(tx, resolution.ynabAccountId, importId, null, target.ynabAccountId),
      };
    }
    const assignment = applyCategoryRule(tx, rules);
    return {
      status: "ready",
      draft: toDraft(tx, resolution.ynabAccountId, importId, assignment),
    };
  });
