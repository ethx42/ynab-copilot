import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importIdFor } from "../src/core/domain/import-id.js";
import { parseBancoDeBogotaSms } from "../src/core/parsers/bancodebogota-sms.js";

const corpus = readFileSync(
  fileURLToPath(new URL("./fixtures/bancodebogota/bancodebogota-sms.txt", import.meta.url)),
  "utf8",
)
  .split(/^---$/m)
  .map((block) =>
    block
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n")
      .trim(),
  )
  .filter((block) => block !== "");

const sms = (needle: string): string => {
  const found = corpus.find((block) => block.includes(needle));
  if (found === undefined) throw new Error(`fixture missing: ${needle}`);
  return found;
};

const parse = (text: string, messageId = "m1") => parseBancoDeBogotaSms({ messageId, text });

describe("Banco de Bogota SMS parser (BB-SMS-1)", () => {
  it("parses an approved purchase: pesos, local date/time, card digits, merchant", () => {
    const outcome = parse(sms("COMCEL"));
    expect(outcome).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          bank: "bancodebogota",
          template: "BB-SMS-1",
          kind: "purchase",
          direction: "outflow",
          amountPesos: 53900,
          date: "2026-10-05",
          time: "10:45",
          account: { kind: "last4", last4: "3429" },
          counterparty: "COMCEL S.A",
          counterAccountLast4: null,
          sourceMessageId: "m1",
        }),
      ],
    });
  });

  it("keeps the merchant text as printed, including asterisks and inner spaces", () => {
    const outcome = parse(sms("mi cuate"));
    expect(outcome.ok && outcome.value[0]?.counterparty).toBe("BOLD SA*mi cuate");
    expect(outcome.ok && outcome.value[0]?.amountPesos).toBe(7100);
  });

  it("parses every approved purchase of the corpus", () => {
    const approved = corpus.filter((block) => block.includes("fue aprobada"));
    expect(approved).toHaveLength(5);
    for (const text of approved) {
      const outcome = parse(text);
      expect(outcome.ok && outcome.value).toHaveLength(1);
    }
  });

  it("tolerates trailing text a mail client may add after the SMS", () => {
    const outcome = parse(`${sms("COMCEL")}\n\nSent from my iPhone`);
    expect(outcome.ok && outcome.value[0]?.amountPesos).toBe(53900);
  });

  it("tolerates a four-digit year and a time without seconds", () => {
    const outcome = parse(
      "Banco de Bogota: Tu compra por 10,000 fue aprobada con Tarjeta Credito 3429 el 05/10/2026 10:45 en UNA TIENDA ¿Dudas? Llama",
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: [{ date: "2026-10-05", time: "10:45", counterparty: "UNA TIENDA" }],
    });
  });

  it("ignores refused purchases: no money moved, nothing to write, not a failure", () => {
    for (const text of corpus.filter((block) => block.includes("RECHAZADA"))) {
      expect(parse(text)).toEqual({ ok: true, value: [] });
    }
  });

  it("ignores one-time codes and Apple Pay notices", () => {
    expect(parse(sms("codigo de verificacion"))).toEqual({ ok: true, value: [] });
    expect(parse(sms("esta lista para Apple Pay"))).toEqual({ ok: true, value: [] });
  });

  it("never echoes an ignorable message (a one-time code must not reach a ticket)", () => {
    const outcome = parse(sms("codigo de verificacion"));
    expect(JSON.stringify(outcome)).not.toContain("000000");
  });

  it("fails loudly on an unknown SMS instead of dropping it", () => {
    const outcome = parse("Banco de Bogota: Tu retiro por 200,000 fue exitoso en CAJERO 1234");
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "unrecognized_format", messageId: "m1" },
    });
  });

  it("fails loudly on an unknown purchase status next to nothing else", () => {
    const outcome = parse(
      "Banco de Bogota: Tu compra por 5,000 fue REVERSADA con Tarjeta Crédito 3429 el 05/10/26 10:45:48 en X ¿Dudas?",
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "unrecognized_format" } });
  });

  it("fails the whole message when a known sentence sits next to an unknown one", () => {
    const outcome = parse(`${sms("COMCEL")} Tu pago por 9,000 fue recibido`);
    expect(outcome).toMatchObject({ ok: false, error: { code: "unrecognized_format" } });
  });

  it("fails the whole message when a known purchase shares the body with a verb-first transaction", () => {
    for (const extra of [
      "Retiraste $200,000 en CAJERO 1234",
      "Recibiste una transferencia por $50,000 de JUAN",
      "Pagaste $9,000 a ACME",
    ]) {
      const outcome = parse(`${sms("COMCEL")} ${extra}`);
      expect(outcome).toMatchObject({ ok: false, error: { code: "unrecognized_format" } });
    }
  });

  it("rejects an amount with other separators rather than reading it 1000x off", () => {
    const outcome = parse(
      "Banco de Bogota: Tu compra por 53.900 fue aprobada con Tarjeta Crédito 3429 el 05/10/26 10:45:48 en X ¿Dudas?",
    );
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "invalid_field", template: "BB-SMS-1", detail: "amount" },
    });
  });

  it("rejects an impossible date", () => {
    const outcome = parse(
      "Banco de Bogota: Tu compra por 5,000 fue aprobada con Tarjeta Crédito 3429 el 31/02/26 10:45:48 en X ¿Dudas?",
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_field", detail: "date" } });
  });

  it("gives a repeated forward of the same SMS the same import id, and another SMS a new one", () => {
    const first = parse(sms("COMCEL"), "mail-1");
    const again = parse(sms("COMCEL"), "mail-2");
    const other = parse(sms("TEMU"), "mail-3");
    if (!first.ok || !again.ok || !other.ok) throw new Error("fixture must parse");
    const [a, b, c] = [first.value[0], again.value[0], other.value[0]];
    if (a === undefined || b === undefined || c === undefined) throw new Error("one tx each");

    expect(importIdFor(a, 0)).toBe(importIdFor(b, 0));
    expect(importIdFor(a, 0)).not.toBe(importIdFor(c, 0));
    expect(importIdFor(a, 0)).toMatch(/^BB:[0-9a-f]{32}$/);
    // Traceability still points at the specific email.
    expect(b.sourceMessageId).toBe("mail-2");
  });
});
