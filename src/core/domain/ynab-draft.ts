import { pesosToMilliunits } from "./money.js";
import type { NormalizedTransaction } from "./transaction.js";

// What the YNAB port is asked to create. Always `approved: false` — the human (or a later,
// validated rule) approves; the pipeline never auto-approves its own writes.
export type YnabTransactionDraft = {
  readonly accountId: string;
  readonly date: string;
  // Signed: negative = outflow.
  readonly amountMilliunits: number;
  readonly payeeName: string | null;
  readonly memo: string | null;
  readonly importId: string;
  readonly cleared: "cleared";
  readonly approved: false;
};

const memoFor = (tx: NormalizedTransaction): string | null => {
  switch (tx.kind) {
    case "transfer_out":
      return tx.counterparty === null ? null : `Transferencia Bancolombia a ${tx.counterparty}`;
    case "qr_payment":
      return tx.counterparty === null ? null : `Pago QR a llave ${tx.counterparty}`;
    case "purchase":
    case "inflow":
    case "card_payment":
      return null;
  }
};

export const toDraft = (
  tx: NormalizedTransaction,
  accountId: string,
  importId: string,
): YnabTransactionDraft => {
  const magnitude = pesosToMilliunits(tx.amountPesos);
  // Purchases and inflows carry the merchant/payer as the payee; transfers and QR payments
  // carry the destination in the memo instead (it is an account/key number, not a payee).
  const payeeName = tx.kind === "purchase" || tx.kind === "inflow" ? tx.counterparty : null;
  return {
    accountId,
    date: tx.date,
    amountMilliunits: tx.direction === "outflow" ? -magnitude : magnitude,
    payeeName,
    memo: memoFor(tx),
    importId,
    cleared: "cleared",
    approved: false,
  };
};
