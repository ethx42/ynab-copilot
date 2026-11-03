import { err, ok, type Result } from "./result.js";

// Bancolombia mixes two amount styles across templates (see tests/fixtures/MANIFEST.md):
//   CO: `COP39.088,00`  (dot = thousands, comma = decimals)   — card purchases
//   US: `$15,823,003.00` (comma = thousands, dot = decimals) — transfers / inflows / QR
// Debit-card withdrawals print the CO separators behind a bare `$` (`$500.000,00`), so the CO
// parser accepts either prefix; the separators, never the prefix, decide the style.
// Mixing them up silently is a 1000x error, so each style has its own strict parser.
const CO_AMOUNT = /^(?:COP|\$)(?<int>\d{1,3}(?:\.\d{3})*)(?:,(?<dec>\d{1,2}))?$/;
const US_AMOUNT = /^\$\s?(?<int>\d{1,3}(?:,\d{3})*|\d+)(?:\.(?<dec>\d{1,2}))?$/;

export type AmountError = { readonly code: "invalid_amount"; readonly raw: string };

const toWholePesos = (
  raw: string,
  groups: Record<string, string | undefined> | undefined,
  thousandsSeparator: string,
): Result<number, AmountError> => {
  const intPart = groups?.["int"];
  if (intPart === undefined) return err({ code: "invalid_amount", raw });
  // The YNAB budget uses 0 decimal digits (COP): amounts are recorded in whole pesos,
  // truncating the cents (e.g. 84.442,54 -> 84.442), matching how the budget is kept.
  const pesos = Number(intPart.replaceAll(thousandsSeparator, ""));
  if (!Number.isSafeInteger(pesos) || pesos <= 0) return err({ code: "invalid_amount", raw });
  return ok(pesos);
};

export const parseCoAmount = (raw: string): Result<number, AmountError> => {
  const match = CO_AMOUNT.exec(raw);
  if (match === null) return err({ code: "invalid_amount", raw });
  return toWholePesos(raw, match.groups, ".");
};

export const parseUsAmount = (raw: string): Result<number, AmountError> => {
  const match = US_AMOUNT.exec(raw);
  if (match === null) return err({ code: "invalid_amount", raw });
  return toWholePesos(raw, match.groups, ",");
};

// YNAB stores money in milliunits (1000 milliunits = 1 currency unit).
export const pesosToMilliunits = (pesos: number): number => pesos * 1000;
