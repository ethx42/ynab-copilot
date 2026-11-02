import { parseClockTime, parseDmyDate } from "../domain/datetime.js";
import { parseCoAmount, parseUsAmount } from "../domain/money.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  NormalizedTransactionSchema,
  type AccountRef,
  type NormalizedTransaction,
} from "../domain/transaction.js";

// Deterministic (zero-token) parser for Bancolombia notification text. One entry per
// template catalogued in tests/fixtures/MANIFEST.md (B-1 .. B-5) plus B-6, seen in a live
// alert on 2026-11-02 ("Transferiste ... desde tu cuenta *1560 a la cuenta *...").
// Anything that matches no template is reported as `unrecognized_format` — NEVER dropped.

export type ParseInput = {
  readonly messageId: string;
  // Decoded text/plain body (quoted-printable already resolved by the Gmail/MIME adapter).
  readonly text: string;
};

export type ParseFailure =
  | { readonly code: "unrecognized_format"; readonly messageId: string; readonly excerpt: string }
  | {
      readonly code: "invalid_field";
      readonly messageId: string;
      readonly template: string;
      readonly detail: string;
    };

export type ParseOutcome = Result<readonly NormalizedTransaction[], ParseFailure>;

type Groups = Readonly<Record<string, string | undefined>>;

type TemplateSpec = {
  readonly template: string;
  readonly pattern: RegExp;
  readonly kind: NormalizedTransaction["kind"];
  readonly direction: NormalizedTransaction["direction"];
  readonly amountStyle: "co" | "us";
  // True for B-2, which names the product type ("AHORROS") instead of trailing digits.
  readonly savingsProduct?: true;
};

const DATE = String.raw`(?<date>\d{2}\/\d{2}\/\d{4})`;
const TIME = String.raw`(?<time>\d{2}:\d{2})`;
// Merchant text may not run across another "Compraste ..." sentence.
const MERCHANT = String.raw`(?<cp>(?:(?!Compraste ).)+?)`;

const TEMPLATES: readonly TemplateSpec[] = [
  {
    // B-1: `Compraste COP39.088,00 en UBER RIDES con tu T.Cred *0338, el 29/05/2026 a las 11:37.`
    template: "B-1",
    pattern: new RegExp(
      String.raw`Compraste (?<amt>COP[\d.,]+) en ${MERCHANT} con tu T\.Cred \*(?<last4>\d{4}), el ${DATE} a las ${TIME}`,
      "g",
    ),
    kind: "purchase",
    direction: "outflow",
    amountStyle: "co",
  },
  {
    // B-1b: `Compraste COP111.850,00 en RAPPI COLOMBIA*DL, el 27/05/2026 a las 20:43. Esta compra esta asociada a T.Cred *0338.`
    template: "B-1b",
    pattern: new RegExp(
      String.raw`Compraste (?<amt>COP[\d.,]+) en ${MERCHANT}, el ${DATE} a las ${TIME}\. Esta compra esta asociada a T\.Cred \*(?<last4>\d{4})`,
      "g",
    ),
    kind: "purchase",
    direction: "outflow",
    amountStyle: "co",
  },
  {
    // B-2: `Recibiste un pago por $15,823,003.00 de WIZELINE SAS a tu cuenta AHORROS, el 10:02 a las 27/05/2026.`
    // NOTE the inverted time/date order and the absence of trailing digits.
    template: "B-2",
    pattern: new RegExp(
      String.raw`Recibiste un pago por (?<amt>\$[\d.,]+) de (?<cp>.+?) a tu cuenta AHORROS, el ${TIME} a las ${DATE}`,
      "g",
    ),
    kind: "inflow",
    direction: "inflow",
    amountStyle: "us",
    savingsProduct: true,
  },
  {
    // B-3: `... pagaste $80,000.00 por codigo QR desde tu cuenta *1560 a la llave 0090997376 el 29/05/2026 a las 19:18.`
    template: "B-3",
    pattern: new RegExp(
      String.raw`pagaste (?<amt>\$[\d.,]+) por codigo QR desde tu cuenta \*(?<last4>\d{4}) a la llave (?<cp>\S+) el ${DATE} a las ${TIME}`,
      "g",
    ),
    kind: "qr_payment",
    direction: "outflow",
    amountStyle: "us",
  },
  {
    // B-4: `Transferencia por $200,000 desde cta *1560 a cta 07471544013. 01/06/2023 21:20.`
    template: "B-4",
    pattern: new RegExp(
      String.raw`Transferencia por (?<amt>\$[\d.,]+) desde cta \*(?<last4>\d{4}) a cta (?<cp>[\d*]+)\. ${DATE} ${TIME}`,
      "g",
    ),
    kind: "transfer_out",
    direction: "outflow",
    amountStyle: "us",
  },
  {
    // B-5: `Pago de Tarjeta de Credito por $5,659,564 desde cta *1560 a la tarjeta *2075. 01/06/2023 21:29.`
    template: "B-5",
    pattern: new RegExp(
      String.raw`Pago de Tarjeta de Credito por (?<amt>\$[\d.,]+) desde cta \*(?<last4>\d{4}) a la tarjeta \*(?<other>\d{4})\. ${DATE} ${TIME}`,
      "g",
    ),
    kind: "card_payment",
    direction: "outflow",
    amountStyle: "us",
  },
  {
    // B-6: `Transferiste $70,500 desde tu cuenta *1560 a la cuenta *75639212378 el 01/11/2026 a las 18:34.`
    template: "B-6",
    pattern: new RegExp(
      String.raw`Transferiste (?<amt>\$[\d.,]+) desde tu cuenta \*(?<last4>\d{4}) a la cuenta (?<cp>\*?\d+) el ${DATE} a las ${TIME}`,
      "g",
    ),
    kind: "transfer_out",
    direction: "outflow",
    amountStyle: "us",
  },
];

// Emails wrap lines mid-sentence (`en\r\nUBER RIDES`) and use non-breaking spaces.
export const normalizeText = (text: string): string => text.replace(/[\s ]+/g, " ").trim();

const buildTransaction = (
  spec: TemplateSpec,
  g: Groups,
  messageId: string,
): Result<NormalizedTransaction, ParseFailure> => {
  const fail = (detail: string): Result<never, ParseFailure> =>
    err({ code: "invalid_field", messageId, template: spec.template, detail });

  const amtRaw = g["amt"];
  const dateRaw = g["date"];
  const timeRaw = g["time"];
  if (amtRaw === undefined || dateRaw === undefined || timeRaw === undefined) {
    return fail("missing_capture");
  }

  const amount = spec.amountStyle === "co" ? parseCoAmount(amtRaw) : parseUsAmount(amtRaw);
  if (!amount.ok) return fail("amount");
  const date = parseDmyDate(dateRaw);
  if (!date.ok) return fail("date");
  const time = parseClockTime(timeRaw);
  if (!time.ok) return fail("time");

  const last4 = g["last4"];
  let account: AccountRef | undefined;
  if (spec.savingsProduct === true) account = { kind: "product", product: "savings" };
  else if (last4 !== undefined) account = { kind: "last4", last4 };
  if (account === undefined) return fail("missing_account");

  const cpRaw = g["cp"]?.trim();
  const parsed = NormalizedTransactionSchema.safeParse({
    bank: "bancolombia",
    template: spec.template,
    kind: spec.kind,
    direction: spec.direction,
    amountPesos: amount.value,
    date: date.value,
    time: time.value,
    account,
    counterparty: cpRaw === undefined || cpRaw === "" ? null : cpRaw,
    counterAccountLast4: g["other"] ?? null,
    sourceMessageId: messageId,
  });
  return parsed.success ? ok(parsed.data) : fail("schema");
};

export const parseBancolombia = (input: ParseInput): ParseOutcome => {
  const text = normalizeText(input.text);
  const found: NormalizedTransaction[] = [];
  // The same sentence can appear twice inside ONE email (preheader + body). Two genuinely
  // identical purchases arrive as two separate emails, so collapsing per message is safe.
  const seenSentences = new Set<string>();

  for (const spec of TEMPLATES) {
    for (const match of text.matchAll(spec.pattern)) {
      if (seenSentences.has(match[0])) continue;
      seenSentences.add(match[0]);
      const built = buildTransaction(spec, match.groups ?? {}, input.messageId);
      if (!built.ok) return built;
      found.push(built.value);
    }
  }

  if (found.length === 0) {
    const start = Math.max(text.indexOf("Bancolombia"), 0);
    return err({
      code: "unrecognized_format",
      messageId: input.messageId,
      excerpt: text.slice(start, start + 160),
    });
  }
  return ok(found);
};
