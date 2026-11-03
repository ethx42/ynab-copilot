import { parseClockTime, parseDmyDate } from "../domain/datetime.js";
import { parseUsAmount } from "../domain/money.js";
import { err, ok, type Result } from "../domain/result.js";
import { NormalizedTransactionSchema, type NormalizedTransaction } from "../domain/transaction.js";
import { normalizeText, type ParseFailure, type ParseInput } from "./bancolombia.js";

// Deterministic (zero-token) parser for Banco de Bogotá SMS alerts (shortcode 85264). Bogotá
// sends no email for everyday card use, so the owner's phone forwards each SMS to this mailbox
// and the Gmail adapter hands us the SMS text as the email body.
//
// Wordings catalogued from live SMS (tests/fixtures/bancodebogota/bancodebogota-sms.txt):
//   BB-SMS-1  `Banco de Bogota: Tu compra por 53,900 fue aprobada con Tarjeta Crédito 3429 el
//             05/10/26 10:45:48 en COMCEL S.A ¿Dudas? Llama a la Servilinea ...`
//   (ignored) `... Tu compra por 284,760 fue RECHAZADA por motivo de seguridad deTarjeta Crédito
//             4513 ...`  — a refused purchase moved no money, so it is not a transaction.
//   (ignored) one-time codes and "tu tarjeta esta lista para Apple Pay" notices.
// Anything else that looks like a transaction is `unrecognized_format` — NEVER dropped.
//
// Output echoes no SMS text for the ignorable kinds: one-time codes must never end up in a log
// or in a (public) review ticket.

export type SmsParseOutcome = Result<readonly NormalizedTransaction[], ParseFailure>;

// Amount as printed: US separators and no currency sign (`1,646,362`). The strict US parser then
// rejects anything with other separators, so a wording change cannot become a 1000x error.
const APPROVED_PURCHASE = new RegExp(
  String.raw`Banco de Bogota: Tu compra por (?<amt>[\d.,]+) fue aprobada con Tarjeta Cr[eé]dito (?<last4>\d{4}) el (?<date>\d{2}\/\d{2}\/(?:\d{4}|\d{2})) (?<time>\d{2}:\d{2})(?::(?<sec>\d{2}))? en (?<cp>.+?) ¿Dudas\?`,
  "g",
);

const REFUSED_PURCHASE = /Tu compra por [\d.,]+ fue RECHAZADA/g;

// Not transactions, never worth a human's time. Kept narrow on purpose: an unfamiliar message is
// reported, not assumed harmless.
const IGNORABLE: readonly RegExp[] = [
  /\bcodigo de verificacion\b/i,
  /\bcódigo de verificación\b/i,
  /\besta lista para Apple Pay\b/i,
];

// What is left over after removing the known sentences. If any of these remain, the SMS
// carries a transaction we do not understand (a reversal, a withdrawal, a payment...).
const STRAY_TRANSACTION = /\bTu (?:compra|pago|retiro|transferencia|avance|abono|reversion)\b/i;

const excerptOf = (text: string, index: number): string => text.slice(index, index + 160);

export const parseBancoDeBogotaSms = (input: ParseInput): SmsParseOutcome => {
  const text = normalizeText(input.text);
  const found: NormalizedTransaction[] = [];
  const seenSentences = new Set<string>();

  for (const match of text.matchAll(APPROVED_PURCHASE)) {
    if (seenSentences.has(match[0])) continue;
    seenSentences.add(match[0]);
    const g = match.groups ?? {};
    const fail = (detail: string): Result<never, ParseFailure> =>
      err({ code: "invalid_field", messageId: input.messageId, template: "BB-SMS-1", detail });

    const amtRaw = g["amt"];
    const dateRaw = g["date"];
    const timeRaw = g["time"];
    if (amtRaw === undefined || dateRaw === undefined || timeRaw === undefined) {
      return fail("missing_capture");
    }
    const amount = parseUsAmount(`$${amtRaw}`);
    if (!amount.ok) return fail("amount");
    const date = parseDmyDate(dateRaw);
    if (!date.ok) return fail("date");
    const time = parseClockTime(timeRaw);
    if (!time.ok) return fail("time");

    const counterparty = g["cp"]?.trim() ?? "";
    const last4 = g["last4"];
    // The SMS prints the second, so the alert itself has a stable identity: a repeated forward
    // of the same SMS must not become a second YNAB row.
    const dedupeKey = [
      "sms",
      last4,
      date.value,
      `${time.value}:${g["sec"] ?? "00"}`,
      String(amount.value),
      counterparty,
    ].join("|");

    const parsed = NormalizedTransactionSchema.safeParse({
      bank: "bancodebogota",
      template: "BB-SMS-1",
      kind: "purchase",
      direction: "outflow",
      amountPesos: amount.value,
      date: date.value,
      time: time.value,
      account: { kind: "last4", last4 },
      counterparty: counterparty === "" ? null : counterparty,
      counterAccountLast4: null,
      sourceMessageId: input.messageId,
      dedupeKey,
    });
    if (!parsed.success) return fail("schema");
    found.push(parsed.data);
  }

  const leftover = [APPROVED_PURCHASE, REFUSED_PURCHASE].reduce(
    (rest, pattern) => rest.replace(pattern, " "),
    text,
  );
  const stray = STRAY_TRANSACTION.exec(leftover);
  if (stray !== null) {
    return err({
      code: "unrecognized_format",
      messageId: input.messageId,
      excerpt: excerptOf(leftover, stray.index),
    });
  }

  if (found.length > 0) return ok(found);

  // Nothing to write. That is only fine when the message is a refused purchase or a known
  // non-transaction notice; anything else is an unknown SMS and must be seen by a human.
  const refused = new RegExp(REFUSED_PURCHASE.source).test(text);
  if (refused || IGNORABLE.some((pattern) => pattern.test(text))) return ok([]);
  return err({
    code: "unrecognized_format",
    messageId: input.messageId,
    // Bounded to the start of the message; one-time codes were screened out above.
    excerpt: excerptOf(text, 0),
  });
};
