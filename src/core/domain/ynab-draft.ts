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
  // Set only by a Rules Map match; null leaves the row uncategorized for the owner.
  readonly categoryId: string | null;
  // Set for moves between the owner's own accounts: the YNAB account on the other side. The
  // adapter turns it into that account's transfer payee, so YNAB creates both legs.
  readonly transferAccountId: string | null;
  readonly memo: string | null;
  readonly importId: string;
  readonly cleared: "cleared";
  readonly approved: false;
};

// What the Rules Map decided for a transaction: post it under this payee and category.
export type CategoryAssignment = {
  readonly payeeName: string;
  readonly categoryId: string;
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
    case "payment":
    case "withdrawal":
      return null;
  }
};

// Santiago's YNAB convention: ATM withdrawals are posted to the payee "Cash" (the ATM id the
// bank prints is not a payee).
export const CASH_PAYEE = "Cash";

const payeeFor = (tx: NormalizedTransaction): string | null => {
  switch (tx.kind) {
    case "purchase":
    case "inflow":
    case "payment":
      return tx.counterparty;
    case "withdrawal":
      return CASH_PAYEE;
    case "transfer_out":
    case "qr_payment":
    case "card_payment":
      return null;
  }
};

export const toDraft = (
  tx: NormalizedTransaction,
  accountId: string,
  importId: string,
  assignment: CategoryAssignment | null = null,
  transferAccountId: string | null = null,
): YnabTransactionDraft => {
  const magnitude = pesosToMilliunits(tx.amountPesos);
  // Purchases and inflows carry the merchant/payer as the payee; transfers and QR payments
  // carry the destination in the memo instead (it is an account/key number, not a payee).
  return {
    accountId,
    date: tx.date,
    amountMilliunits: tx.direction === "outflow" ? -magnitude : magnitude,
    // A transfer is identified by its counterpart account, not by a payee name or a category.
    payeeName: transferAccountId === null ? (assignment?.payeeName ?? payeeFor(tx)) : null,
    categoryId: transferAccountId === null ? (assignment?.categoryId ?? null) : null,
    transferAccountId,
    memo: memoFor(tx),
    importId,
    cleared: "cleared",
    approved: false,
  };
};
