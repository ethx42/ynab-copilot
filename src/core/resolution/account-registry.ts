import { z } from "zod";
import { normalizeCounterparty } from "../domain/counterparty.js";
import type { NormalizedTransaction } from "../domain/transaction.js";

const Bank = z.enum(["bancolombia", "bancodebogota"]);

// Maps the digits the bank prints (`*8139`) to a YNAB account. Many last-4 -> ONE account is
// allowed (a reissued card keeps its YNAB account); the reverse ambiguity (one last-4 -> two
// accounts) is rejected when the registry is loaded, because guessing would mis-post silently.
export const AccountRegistrySchema = z
  .object({
    entries: z.array(
      z.object({
        bank: Bank,
        last4: z.array(z.string().regex(/^\d{4}$/)).min(1),
        ynabAccountId: z.string().uuid(),
      }),
    ),
    // Template B-2 names only "AHORROS": resolved by product type, one account per bank.
    productFallbacks: z
      .array(
        z.object({
          bank: Bank,
          product: z.literal("savings"),
          ynabAccountId: z.string().uuid(),
        }),
      )
      .default([]),
    // Payees that are really the owner's OWN YNAB accounts (template B-12 prints only the bank
    // name, e.g. "Banco de Bogota"): a payment to them is a transfer, not an expense.
    transferTargets: z
      .array(z.object({ counterparty: z.string().min(1), ynabAccountId: z.string().uuid() }))
      .default([]),
  })
  .superRefine((registry, ctx) => {
    const targets = new Set<string>();
    for (const target of registry.transferTargets) {
      const key = normalizeCounterparty(target.counterparty);
      if (targets.has(key)) {
        ctx.addIssue({ code: "custom", message: `duplicate transfer target for ${key}` });
      }
      targets.add(key);
    }
    const seen = new Set<string>();
    for (const entry of registry.entries) {
      for (const last4 of entry.last4) {
        const key = `${entry.bank}:${last4}`;
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", message: `duplicate mapping for ${key}` });
        }
        seen.add(key);
      }
    }
    const fallbacks = new Set<string>();
    for (const fb of registry.productFallbacks) {
      const key = `${fb.bank}:${fb.product}`;
      if (fallbacks.has(key)) {
        ctx.addIssue({ code: "custom", message: `duplicate product fallback for ${key}` });
      }
      fallbacks.add(key);
    }
  });

export type AccountRegistry = z.infer<typeof AccountRegistrySchema>;

export type Resolution =
  | { readonly status: "resolved"; readonly ynabAccountId: string }
  | { readonly status: "unresolved"; readonly reason: "unknown_last4" | "no_product_fallback" };

// Pure and total: an unknown account is an explicit `unresolved`, never a guess.
export const resolveAccount = (
  tx: NormalizedTransaction,
  registry: AccountRegistry,
): Resolution => {
  if (tx.account.kind === "last4") {
    const { last4 } = tx.account;
    const entry = registry.entries.find((e) => e.bank === tx.bank && e.last4.includes(last4));
    return entry === undefined
      ? { status: "unresolved", reason: "unknown_last4" }
      : { status: "resolved", ynabAccountId: entry.ynabAccountId };
  }
  // Narrowing on `tx.account` is lost inside a callback, so bind the value first.
  const { product } = tx.account;
  const fallback = registry.productFallbacks.find(
    (f) => f.bank === tx.bank && f.product === product,
  );
  return fallback === undefined
    ? { status: "unresolved", reason: "no_product_fallback" }
    : { status: "resolved", ynabAccountId: fallback.ynabAccountId };
};

export type TransferTarget =
  | { readonly status: "none" }
  | { readonly status: "transfer"; readonly ynabAccountId: string }
  | { readonly status: "unresolved"; readonly reason: "transfer_target_unknown" };

// Is this outflow really a move between the owner's own accounts? Pure and total.
// - card_payment (B-5) names the card's last4: it MUST resolve, otherwise a human decides.
// - payment (B-12) names a payee: a registered own-account payee is a transfer, anything else
//   is an ordinary expense.
export const resolveTransferTarget = (
  tx: NormalizedTransaction,
  registry: AccountRegistry,
): TransferTarget => {
  if (tx.kind === "card_payment") {
    const { counterAccountLast4: last4 } = tx;
    const entry =
      last4 === null
        ? undefined
        : registry.entries.find((e) => e.bank === tx.bank && e.last4.includes(last4));
    return entry === undefined
      ? { status: "unresolved", reason: "transfer_target_unknown" }
      : { status: "transfer", ynabAccountId: entry.ynabAccountId };
  }
  if (tx.kind === "payment" && tx.counterparty !== null) {
    const subject = normalizeCounterparty(tx.counterparty);
    const target = registry.transferTargets.find(
      (t) => normalizeCounterparty(t.counterparty) === subject,
    );
    if (target !== undefined) return { status: "transfer", ynabAccountId: target.ynabAccountId };
  }
  return { status: "none" };
};
