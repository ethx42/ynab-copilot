import { z } from "zod";

// The single internal contract (CLAUDE.md "Normalized Transaction"). Every bank adapter
// produces this; nothing downstream knows about bank wording.
export const AccountRefSchema = z.discriminatedUnion("kind", [
  // Trailing digits printed by the bank (`T.Cred *8139`, `cuenta *1560`) — tier-1 join key.
  z.object({ kind: z.literal("last4"), last4: z.string().regex(/^\d{4}$/) }),
  // Template B-2 only names the product type ("AHORROS"), no digits: needs a product fallback.
  z.object({ kind: z.literal("product"), product: z.literal("savings") }),
]);

export const NormalizedTransactionSchema = z.object({
  bank: z.enum(["bancolombia", "bancodebogota"]),
  template: z.string().min(1),
  kind: z.enum([
    "purchase",
    "qr_payment",
    "transfer_out",
    // Paying a card from savings with the card's own digits printed (B-5): always a transfer.
    "card_payment",
    // "Pagaste $X a <payee> desde tu producto ####" (B-12): a transfer when the payee is one of
    // the owner's own accounts (registry `transferTargets`), an ordinary expense otherwise.
    "payment",
    "inflow",
    "withdrawal",
  ]),
  direction: z.enum(["outflow", "inflow"]),
  // Whole pesos, strictly positive; the sign lives in `direction`.
  amountPesos: z.number().int().positive(),
  // Local bank time as printed (America/Bogota): `YYYY-MM-DD` and `HH:MM`.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  account: AccountRefSchema,
  // Merchant / payer / destination exactly as the bank printed it (no cleanup here).
  counterparty: z.string().min(1).nullable(),
  // For own-account moves (card payment from savings): the other side's last4.
  counterAccountLast4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  // Gmail message id — lets every YNAB row be traced back to its source email.
  sourceMessageId: z.string().min(1),
  // Optional stable identity of the transaction itself, for sources where the SAME alert can
  // reach us as several emails (an SMS forwarded twice by a phone automation). When present it
  // replaces the message id in the `import_id`, so the repeat is a YNAB duplicate, not a new row.
  // Bancolombia leaves it unset: one alert is one email there.
  dedupeKey: z.string().min(1).optional(),
});

export type AccountRef = z.infer<typeof AccountRefSchema>;
export type NormalizedTransaction = z.infer<typeof NormalizedTransactionSchema>;
