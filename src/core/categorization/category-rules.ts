import { z } from "zod";
import type { CategoryAssignment } from "../domain/ynab-draft.js";
import { normalizeCounterparty } from "../domain/counterparty.js";
import type { NormalizedTransaction } from "../domain/transaction.js";

// Rules Map (zero tokens): the merchant text the bank prints -> the YNAB payee + category the
// owner already uses for it. A rule only ever FILLS IN a category on a row that is written
// unapproved anyway; no rule means the row stays uncategorized for a human, never a guess.
//
// The rules hold the owner's real YNAB category ids, so they are a secret (JSON in
// `CATEGORY_RULES_JSON`), never committed to this public repo.
export const CategoryRulesSchema = z
  .object({
    rules: z
      .array(
        z.object({
          // Compared case-insensitively with whitespace collapsed.
          counterparty: z.string().min(1),
          // `exact`: the whole merchant text. `prefix`: it starts with this (ids/suffixes vary).
          match: z.enum(["exact", "prefix"]).default("exact"),
          // The payee name to post under: reuse an existing YNAB payee so its history applies.
          payeeName: z.string().min(1).max(200),
          categoryId: z.string().uuid(),
        }),
      )
      .default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const rule of value.rules) {
      const key = `${rule.match}:${normalizeCounterparty(rule.counterparty)}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `duplicate rule for ${key}` });
      seen.add(key);
    }
  });

export type CategoryRules = z.infer<typeof CategoryRulesSchema>;

export const EMPTY_CATEGORY_RULES: CategoryRules = { rules: [] };

// Pure and total. An exact rule beats a prefix rule; among prefix rules the longest wins, so
// the most specific rule decides. Only kinds whose counterparty IS the merchant/payer qualify:
// transfers, QR payments, withdrawals and card payments keep their own handling.
export const applyCategoryRule = (
  tx: NormalizedTransaction,
  rules: CategoryRules,
): CategoryAssignment | null => {
  if ((tx.kind !== "purchase" && tx.kind !== "inflow") || tx.counterparty === null) return null;
  const subject = normalizeCounterparty(tx.counterparty);

  let best: { readonly rank: number; readonly assignment: CategoryAssignment } | null = null;
  for (const rule of rules.rules) {
    const key = normalizeCounterparty(rule.counterparty);
    const rank =
      rule.match === "exact"
        ? subject === key
          ? Number.MAX_SAFE_INTEGER
          : -1
        : subject.startsWith(key)
          ? key.length
          : -1;
    if (rank >= 0 && (best === null || rank > best.rank)) {
      best = { rank, assignment: { payeeName: rule.payeeName, categoryId: rule.categoryId } };
    }
  }
  return best?.assignment ?? null;
};
