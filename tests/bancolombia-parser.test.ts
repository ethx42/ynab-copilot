import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBancolombia } from "../src/core/parsers/bancolombia.js";
import type { NormalizedTransaction } from "../src/core/domain/transaction.js";

const fixture = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), "utf8");

// Minimal quoted-printable decoder, enough for the single real .eml fixture. (Production MIME
// decoding lives in the Gmail adapter; the pure core only ever sees decoded text.)
const decodeQuotedPrintable = (raw: string): string =>
  Buffer.from(
    raw
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    "latin1",
  ).toString("utf8");

const parseOk = (text: string, messageId = "m1"): readonly NormalizedTransaction[] => {
  const outcome = parseBancolombia({ messageId, text });
  if (!outcome.ok) throw new Error(`expected parse success: ${JSON.stringify(outcome.error)}`);
  return outcome.value;
};

describe("Bancolombia parser — golden corpus", () => {
  it("parses B-1, B-1b and B-3 from the 2026 purchases/QR fixture", () => {
    const txs = parseOk(fixture("bancolombia/bancolombia-2026-cc-purchases-and-qr.txt"));
    expect(txs).toHaveLength(3);
    expect(txs).toContainEqual(
      expect.objectContaining({
        template: "B-1",
        kind: "purchase",
        direction: "outflow",
        amountPesos: 39088,
        date: "2026-05-29",
        time: "11:37",
        account: { kind: "last4", last4: "0338" },
        counterparty: "UBER RIDES",
      }),
    );
    expect(txs).toContainEqual(
      expect.objectContaining({
        template: "B-1b",
        amountPesos: 111850,
        date: "2026-05-27",
        time: "20:43",
        account: { kind: "last4", last4: "0338" },
        counterparty: "RAPPI COLOMBIA*DL",
      }),
    );
    expect(txs).toContainEqual(
      expect.objectContaining({
        template: "B-3",
        kind: "qr_payment",
        amountPesos: 80000,
        date: "2026-05-29",
        time: "19:18",
        account: { kind: "last4", last4: "1560" },
        counterparty: "0090997376",
      }),
    );
  });

  it("parses B-2 (AHORROS inflow): product-type account, inverted time/date, no digits", () => {
    const txs = parseOk(fixture("bancolombia/bancolombia-savings-inflow-and-cc-purchase.txt"));
    const inflow = txs.find((t) => t.template === "B-2");
    expect(inflow).toMatchObject({
      kind: "inflow",
      direction: "inflow",
      amountPesos: 15823003,
      date: "2026-05-27",
      time: "10:02",
      account: { kind: "product", product: "savings" },
      counterparty: "WIZELINE SAS",
    });
    expect(txs).toHaveLength(2);
  });

  it("parses B-4 (transfer) and B-5 (card payment from savings) from 2023 formats", () => {
    const txs = parseOk(fixture("bancolombia/bancolombia-2023-transfers-and-cc-payment.txt"));
    expect(txs).toContainEqual(
      expect.objectContaining({
        template: "B-4",
        kind: "transfer_out",
        amountPesos: 200000,
        date: "2023-06-01",
        time: "21:20",
        account: { kind: "last4", last4: "1560" },
        counterparty: "07471544013",
      }),
    );
    expect(txs).toContainEqual(
      expect.objectContaining({
        template: "B-5",
        kind: "card_payment",
        amountPesos: 5659564,
        account: { kind: "last4", last4: "1560" },
        counterAccountLast4: "2075",
        counterparty: null,
      }),
    );
  });

  it("parses the real raw .eml (line-wrapped sentence, HTML + text parts) into ONE transaction", () => {
    const eml = decodeQuotedPrintable(fixture("bancolombia/bancolombia-cc-purchase-RAW.eml"));
    const txs = parseOk(eml);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      template: "B-1",
      amountPesos: 23943,
      date: "2026-05-30",
      time: "08:39",
      account: { kind: "last4", last4: "0338" },
      counterparty: "UBER RIDES",
    });
  });
});

describe("Bancolombia parser — live alert shapes (2026-11-02)", () => {
  it("keeps whole pesos when the bank prints cents", () => {
    const [tx] = parseOk(
      "¡Listo! Todo salió bien con tus movimientos Bancolombia: Compraste COP217.375,58 en AMAZON MKTPLACE PMTS con tu T.Cred *8139, el 02/11/2026 a las 08:00. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.",
    );
    expect(tx).toMatchObject({ amountPesos: 217375, date: "2026-11-02", time: "08:00" });
  });

  it("parses the B-1b variant without 'con tu' (merchant followed by a comma)", () => {
    const [tx] = parseOk(
      "Bancolombia: Compraste COP19.900,00 en APPLE.COM/BILL, el 02/11/2026 a las 08:05. Esta compra esta asociada a T.Cred *8139. Si tienes dudas, encuentranos aqui: 018000931987.",
    );
    expect(tx).toMatchObject({
      template: "B-1b",
      counterparty: "APPLE.COM/BILL",
      account: { kind: "last4", last4: "8139" },
    });
  });

  it("parses B-6 own-account-to-external transfer", () => {
    const [tx] = parseOk(
      "Bancolombia: Transferiste $70,500 desde tu cuenta *1560 a la cuenta *75639212378 el 01/11/2026 a las 18:34. ¿Dudas? Llamanos al 018000931987.",
    );
    expect(tx).toMatchObject({
      template: "B-6",
      kind: "transfer_out",
      amountPesos: 70500,
      date: "2026-11-01",
      time: "18:34",
      account: { kind: "last4", last4: "1560" },
      counterparty: "*75639212378",
    });
  });

  it("parses B-7 debit-card ATM withdrawals (CO separators behind `$`, double asterisk)", () => {
    const [tx] = parseOk(
      "¡Listo! Todo salió bien con tus movimientos Bancolombia: Retiraste $500.000,00 en UNIC_ARME3 de tu T.Deb **0669 el 26/09/2026 a las 20:31. Si tienes dudas, llamanos al 6045109095. Estamos cerca ¡",
    );
    expect(tx).toMatchObject({
      template: "B-7",
      kind: "withdrawal",
      direction: "outflow",
      amountPesos: 500000,
      date: "2026-09-26",
      time: "20:31",
      account: { kind: "last4", last4: "0669" },
      counterparty: "UNIC_ARME3",
    });
  });

  it("does not let a merchant swallow the next purchase sentence", () => {
    const txs = parseOk(
      "Bancolombia: Compraste COP10.000,00 en UNO, el 01/11/2026 a las 10:00. Esta compra esta asociada a T.Cred *8139. Bancolombia: Compraste COP20.000,00 en DOS con tu T.Cred *8139, el 01/11/2026 a las 10:05.",
    );
    expect(txs.map((t) => [t.counterparty, t.amountPesos])).toEqual(
      expect.arrayContaining([
        ["UNO", 10000],
        ["DOS", 20000],
      ]),
    );
    expect(txs).toHaveLength(2);
  });

  it("collapses a sentence repeated inside ONE email into a single transaction", () => {
    const sentence =
      "Compraste COP12.316,00 en UBER RIDES con tu T.Cred *8139, el 01/11/2026 a las 01:49.";
    expect(parseOk(`${sentence} ... ${sentence}`)).toHaveLength(1);
  });
});

describe("Bancolombia parser — llave transfers and corresponsal cash (2026-10-31 shapes)", () => {
  // Sentences keep the real structure; names, keys and places are invented (public repo).
  it("parses B-8: transfer received through a llave, 2-digit year, thousands separators", () => {
    const [tx] = parseOk(
      "¡Listo! Todo salió bien con tus movimientos Bancolombia: SANTIAGO, recibiste una transferencia de EMPRESA EJEMPLO S.A.S por $77,950.00 en tu cuenta *1560 conectada a la llave 80000001 el 31/10/26 a las 09:20. Con llaves es de una y gratis. Dudas al 018000912345.",
    );
    expect(tx).toMatchObject({
      template: "B-8",
      kind: "inflow",
      direction: "inflow",
      amountPesos: 77950,
      date: "2026-10-31",
      time: "09:20",
      account: { kind: "last4", last4: "1560" },
      counterparty: "EMPRESA EJEMPLO S.A.S",
    });
  });

  it("parses B-9: transfer received, double asterisk, no cents", () => {
    const [tx] = parseOk(
      "¡Listo! Todo salió bien con tus movimientos Bancolombia: Recibiste una transferencia por $300,000 de MARIA PEREZ en tu cuenta **1560, el 31/10/2026 a las 11:52. Si tienes dudas, hablemos: 018000931987.",
    );
    expect(tx).toMatchObject({
      template: "B-9",
      kind: "inflow",
      amountPesos: 300000,
      date: "2026-10-31",
      time: "11:52",
      account: { kind: "last4", last4: "1560" },
      counterparty: "MARIA PEREZ",
    });
  });

  it("parses B-10: transfer sent to a llave, naming the destination person", () => {
    const [tx] = parseOk(
      "¡Listo! Todo salió bien con tus movimientos Bancolombia: SANTIAGO, transferiste $30,000.00 a la llave @alias123 desde tu cuenta *1560 a JUAN EJEMPLO GOMEZ el 31/10/26 a las 15:12. Con Bre-b es de una y gratis. Dudas al 018000912345.",
    );
    expect(tx).toMatchObject({
      template: "B-10",
      kind: "transfer_out",
      direction: "outflow",
      amountPesos: 30000,
      date: "2026-10-31",
      time: "15:12",
      account: { kind: "last4", last4: "1560" },
      counterparty: "JUAN EJEMPLO GOMEZ",
    });
  });

  it("parses B-11: corresponsal withdrawal with no account digits (savings product)", () => {
    const [tx] = parseOk(
      "¡Listo! Todo salió bien con tus movimientos Bancolombia: Retiraste $500,000 en nuestro corresponsal BARRIO EJEMPLO 3 en PUEBLO, el 31/10/26 a las 15:56. Si tienes dudas, hablemos: 018000931987.",
    );
    expect(tx).toMatchObject({
      template: "B-11",
      kind: "withdrawal",
      direction: "outflow",
      amountPesos: 500000,
      date: "2026-10-31",
      time: "15:56",
      account: { kind: "product", product: "savings" },
      counterparty: "BARRIO EJEMPLO 3 en PUEBLO",
    });
  });

  it("still fails loudly when a new llave wording sits next to a known one", () => {
    const outcome = parseBancolombia({
      messageId: "m5",
      text: "Retiraste $500,000 en nuestro corresponsal UNO, el 31/10/26 a las 15:56. Ademas recibiste una transferencia de OTRA FORMA por $1,000 sin cuenta.",
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unrecognized_format" } });
  });
});

describe("Bancolombia parser — B-12 payment to a payee (2026-11-02 shape)", () => {
  const sentence =
    "¡Listo! Todo salió bien con tus movimientos Bancolombia: Pagaste $2000000.00 a Banco de Bogota desde tu producto 1560 el 02/11/2026 21:01:23. ¿Dudas? Llamanos al 6045109095. Estamos cerca";

  it("parses seconds, the unseparated amount and the asterisk-less product digits", () => {
    expect(parseOk(sentence)).toEqual([
      expect.objectContaining({
        template: "B-12",
        kind: "payment",
        direction: "outflow",
        amountPesos: 2000000,
        date: "2026-11-02",
        time: "21:01",
        account: { kind: "last4", last4: "1560" },
        counterparty: "Banco de Bogota",
        counterAccountLast4: null,
      }),
    ]);
  });

  it("does not confuse a QR payment (lowercase 'pagaste ... por codigo QR') with B-12", () => {
    const [tx] = parseOk(
      "SANTIAGO, pagaste $80,000.00 por codigo QR desde tu cuenta *1560 a la llave 0090997376 el 29/05/2026 a las 19:18.",
    );
    expect(tx).toMatchObject({ template: "B-3", kind: "qr_payment" });
  });

  it("fails loud on a 'Pagaste' sentence with a wording it does not know", () => {
    const result = parseBancolombia({
      messageId: "m1",
      text: "Bancolombia: Pagaste $50000.00 a Claro con tu tarjeta debito el 02/11/2026.",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unrecognized_format" } });
  });
});

describe("Bancolombia parser — sentence boundaries and unmatched text", () => {
  it("never merges a malformed B-7 sentence with the next valid one (it fails loudly)", () => {
    // Without the sentence-boundary guard this parsed as ONE withdrawal taking the FIRST amount
    // ($100.000) and the SECOND sentence's date/card: a silently wrong row.
    const outcome = parseBancolombia({
      messageId: "m1",
      text: "Retiraste $100.000,00 en ATM_UNO sin datos. Retiraste $500.000,00 en ATM_DOS de tu T.Deb **0669 el 26/09/2026 a las 20:31.",
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unrecognized_format" } });
  });

  it("never merges a malformed B-2 sentence with the next valid one (it fails loudly)", () => {
    const outcome = parseBancolombia({
      messageId: "m3",
      text: "Recibiste un pago por $1,000.00 de ALGUIEN sin mas. Recibiste un pago por $15,823,003.00 de WIZELINE SAS a tu cuenta AHORROS, el 10:02 a las 27/05/2026.",
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unrecognized_format" } });
  });

  it("fails the whole message when a known purchase sits next to an unknown wording", () => {
    const outcome = parseBancolombia({
      messageId: "m2",
      text: "Bancolombia: Compraste COP10.000,00 en UNO con tu T.Cred *8139, el 02/11/2026 a las 08:00. Ademas Compraste USD 12.00 en OTRO con tu T.Cred *8139 el 02/11/2026.",
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "unrecognized_format", messageId: "m2" },
    });
  });

  it("ignores ordinary boilerplate that merely resembles a transaction verb", () => {
    const [tx] = parseOk(
      "Recibiste este mensaje porque tienes alertas activas. Compraste COP10.000,00 en UNO con tu T.Cred *8139, el 02/11/2026 a las 08:00.",
    );
    expect(tx).toMatchObject({ amountPesos: 10000, counterparty: "UNO" });
  });
});

describe("Bancolombia parser — fail loud, never drop", () => {
  it("reports unrecognized wording explicitly", () => {
    const outcome = parseBancolombia({
      messageId: "m9",
      text: "Bancolombia: Tu compra fue rechazada por saldo insuficiente.",
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "unrecognized_format", messageId: "m9" },
    });
  });

  it("reports an impossible date instead of guessing", () => {
    const outcome = parseBancolombia({
      messageId: "m8",
      text: "Bancolombia: Compraste COP1.000,00 en X con tu T.Cred *1234, el 31/02/2026 a las 10:00.",
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "invalid_field", template: "B-1", detail: "date" },
    });
  });
});
