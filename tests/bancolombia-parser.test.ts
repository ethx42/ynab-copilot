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
