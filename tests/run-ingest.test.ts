import { describe, expect, it } from "vitest";
import { needsAttention, runIngest } from "../src/core/ingest/run-ingest.js";
import { AccountRegistrySchema } from "../src/core/resolution/account-registry.js";
import type { YnabTransactionDraft } from "../src/core/domain/ynab-draft.js";
import type { AlertEmail, MailPort } from "../src/ports/mail.js";
import type { CreateResult, YnabPort } from "../src/ports/ynab.js";

const VISA = "11111111-1111-4111-8111-111111111111";
const MAIN = "22222222-2222-4222-8222-222222222222";

const registry = AccountRegistrySchema.parse({
  entries: [
    { bank: "bancolombia", last4: ["8139", "0338"], ynabAccountId: VISA },
    { bank: "bancolombia", last4: ["1560", "0669"], ynabAccountId: MAIN },
  ],
});

const email = (messageId: string, receivedAt: string, text: string): AlertEmail => ({
  messageId,
  source: "bancolombia",
  receivedAt,
  from: "alertasynotificaciones@an.notificacionesbancolombia.com",
  text,
});

const purchase = (merchant: string, amount: string, time: string): string =>
  `Compraste COP${amount} en ${merchant} con tu T.Cred *8139, el 02/11/2026 a las ${time}.`;

const fakeMail = (alerts: readonly AlertEmail[]): MailPort => ({
  listAlertsSince: () => Promise.resolve(alerts),
});

const recordingYnab = (
  respond: (drafts: readonly YnabTransactionDraft[]) => CreateResult = (drafts) => ({
    createdIds: drafts.map((d) => `id-${d.importId}`),
    duplicateImportIds: [],
  }),
) => {
  const received: YnabTransactionDraft[][] = [];
  const port: YnabPort = {
    createTransactions: (drafts) => {
      received.push([...drafts]);
      return Promise.resolve(respond(drafts));
    },
  };
  return { port, received };
};

describe("runIngest", () => {
  it("writes ready transactions in chronological order and reports the counts", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([
      // Deliberately out of order: the use case must sort before assigning import ids.
      email("m2", "2026-11-02T14:00:00Z", purchase("DOS", "20.000,00", "09:00")),
      email("m1", "2026-11-02T13:00:00Z", purchase("UNO", "10.000,00", "08:00")),
    ]);

    const report = await runIngest({ mail, ynab: ynab.port, registry }, "2026-11-01T00:00:00Z");

    expect(ynab.received[0]?.map((d) => d.payeeName)).toEqual(["UNO", "DOS"]);
    expect(report).toMatchObject({
      emailsSeen: 2,
      transactionsParsed: 2,
      created: 2,
      duplicates: 0,
      needsReview: [],
      parseFailures: [],
    });
    expect(needsAttention(report)).toBe(false);
  });

  it("counts YNAB duplicates on an overlapping re-run instead of treating them as new", async () => {
    const ynab = recordingYnab((drafts) => ({
      createdIds: [],
      duplicateImportIds: drafts.map((d) => d.importId),
    }));
    const mail = fakeMail([
      email("m1", "2026-11-02T13:00:00Z", purchase("UNO", "10.000,00", "08:00")),
    ]);
    const report = await runIngest({ mail, ynab: ynab.port, registry }, "2026-11-01T00:00:00Z");
    expect(report).toMatchObject({ created: 0, duplicates: 1 });
    expect(needsAttention(report)).toBe(false);
  });

  it("never writes unknown cards or card payments: they come back as review items", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([
      email(
        "m1",
        "2026-11-02T13:00:00Z",
        "Compraste COP10.000,00 en UNO con tu T.Cred *2075, el 02/11/2026 a las 08:00.",
      ),
      email(
        "m2",
        "2026-11-02T14:00:00Z",
        "Pago de Tarjeta de Credito por $5,659,564 desde cta *1560 a la tarjeta *2075. 02/11/2026 09:00.",
      ),
    ]);
    const report = await runIngest({ mail, ynab: ynab.port, registry }, "2026-11-01T00:00:00Z");
    expect(ynab.received[0]).toEqual([]);
    expect(report.needsReview.map((r) => r.reason)).toEqual([
      "unknown_last4",
      "transfer_target_unknown",
    ]);
    expect(needsAttention(report)).toBe(true);
  });

  it("writes a card payment email as a transfer draft pointing at the card's account", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([
      email(
        "m1",
        "2026-11-02T14:00:00Z",
        "Pago de Tarjeta de Credito por $5,659,564 desde cta *1560 a la tarjeta *8139. 02/11/2026 09:00.",
      ),
    ]);
    const report = await runIngest({ mail, ynab: ynab.port, registry }, "2026-11-01T00:00:00Z");
    expect(ynab.received[0]).toEqual([
      expect.objectContaining({
        accountId: MAIN,
        amountMilliunits: -5659564000,
        payeeName: null,
        transferAccountId: VISA,
        approved: false,
      }),
    ]);
    expect(needsAttention(report)).toBe(false);
  });

  it("reports as handled only the emails that parsed and were fully written", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([
      email("ok", "2026-11-02T13:00:00Z", purchase("UBER", "10.000,00", "08:00")),
      email(
        "review",
        "2026-11-02T14:00:00Z",
        "Compraste COP10.000,00 en UNO con tu T.Cred *2075, el 02/11/2026 a las 09:00.",
      ),
      email("bad", "2026-11-02T15:00:00Z", "Bancolombia: Tu compra fue rechazada."),
    ]);
    const report = await runIngest({ mail, ynab: ynab.port, registry }, "2026-11-01T00:00:00Z");
    expect(report.handledMessageIds).toEqual(["ok"]);
  });

  it("surfaces unrecognized emails as parse failures and still writes the good ones", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([
      email("bad", "2026-11-02T12:00:00Z", "Bancolombia: Tu compra fue rechazada."),
      email("ok", "2026-11-02T13:00:00Z", purchase("UNO", "10.000,00", "08:00")),
    ]);
    const report = await runIngest({ mail, ynab: ynab.port, registry }, "2026-11-01T00:00:00Z");
    expect(report.created).toBe(1);
    expect(report.parseFailures).toEqual([
      expect.objectContaining({ code: "unrecognized_format", messageId: "bad" }),
    ]);
    expect(needsAttention(report)).toBe(true);
  });

  it("lets a YNAB failure fail the whole run", async () => {
    const failing: YnabPort = {
      createTransactions: () => Promise.reject(new Error("HTTP 500")),
    };
    const mail = fakeMail([
      email("m1", "2026-11-02T13:00:00Z", purchase("UNO", "10.000,00", "08:00")),
    ]);
    await expect(
      runIngest({ mail, ynab: failing, registry }, "2026-11-01T00:00:00Z"),
    ).rejects.toThrow("HTTP 500");
  });

  it("is a quiet no-op when there are no alerts", async () => {
    const ynab = recordingYnab();
    const report = await runIngest(
      { mail: fakeMail([]), ynab: ynab.port, registry },
      "2026-11-01T00:00:00Z",
    );
    expect(report).toMatchObject({ emailsSeen: 0, created: 0 });
    expect(needsAttention(report)).toBe(false);
  });
});

describe("runIngest with Banco de Bogota SMS", () => {
  const SIGNATURE = "33333333-3333-4333-8333-333333333333";
  const smsRegistry = AccountRegistrySchema.parse({
    entries: [{ bank: "bancodebogota", last4: ["3429"], ynabAccountId: SIGNATURE }],
  });
  const sms = (messageId: string, receivedAt: string, text: string): AlertEmail => ({
    messageId,
    source: "bancodebogota_sms",
    receivedAt,
    from: "santiagov62@gmail.com",
    text,
  });
  const PURCHASE =
    "Banco de Bogota: Tu compra por 7,100 fue aprobada con Tarjeta Crédito 3429 el 02/11/26 17:50:20 en BOLD SA*mi cuate ¿Dudas? Llama a la Servilinea ...";
  const REFUSED =
    "Banco de Bogota: Tu compra por 284,760 fue RECHAZADA por motivo de seguridad deTarjeta Crédito 4513 el 04/10/26 07:52:55 en EXPERIAN COLOMBIA ¿Dudas? Llama a la Servilinea ...";

  it("writes an approved SMS purchase to the card's account, unapproved, as a BB import", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([sms("s1", "2026-11-02T22:50:00Z", PURCHASE)]);
    const report = await runIngest(
      { mail, ynab: ynab.port, registry: smsRegistry },
      "2026-11-01T00:00:00Z",
    );
    expect(ynab.received[0]).toEqual([
      expect.objectContaining({
        accountId: SIGNATURE,
        date: "2026-11-02",
        amountMilliunits: -7100000,
        payeeName: "BOLD SA*mi cuate",
        approved: false,
        importId: expect.stringMatching(/^BB:[0-9a-f]{32}$/) as unknown,
      }),
    ]);
    expect(report).toMatchObject({ created: 1, needsReview: [], parseFailures: [] });
    expect(report.handledMessageIds).toEqual(["s1"]);
  });

  it("treats a refused purchase as handled: nothing written, nothing to review", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([sms("s2", "2026-11-02T22:55:00Z", REFUSED)]);
    const report = await runIngest(
      { mail, ynab: ynab.port, registry: smsRegistry },
      "2026-11-01T00:00:00Z",
    );
    expect(ynab.received[0]).toEqual([]);
    expect(report).toMatchObject({ emailsSeen: 1, transactionsParsed: 0, created: 0 });
    expect(report.handledMessageIds).toEqual(["s2"]);
    expect(needsAttention(report)).toBe(false);
  });

  it("sends the same SMS forwarded twice to YNAB with ONE import id", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([
      sms("s1", "2026-11-02T22:50:00Z", PURCHASE),
      sms("s1-again", "2026-11-02T22:50:09Z", PURCHASE),
    ]);
    await runIngest({ mail, ynab: ynab.port, registry: smsRegistry }, "2026-11-01T00:00:00Z");
    const ids = ynab.received[0]?.map((d) => d.importId) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("asks for review when the SMS card is not in the registry, and when the SMS is unknown", async () => {
    const ynab = recordingYnab();
    const mail = fakeMail([
      sms("s3", "2026-11-02T22:50:00Z", PURCHASE.replace("3429", "9999")),
      sms("s4", "2026-11-02T22:51:00Z", "Banco de Bogota: Tu retiro por 200,000 fue exitoso"),
    ]);
    const report = await runIngest(
      { mail, ynab: ynab.port, registry: smsRegistry },
      "2026-11-01T00:00:00Z",
    );
    expect(ynab.received[0]).toEqual([]);
    expect(report.needsReview.map((r) => r.reason)).toEqual(["unknown_last4"]);
    expect(report.parseFailures.map((f) => f.code)).toEqual(["unrecognized_format"]);
    expect(needsAttention(report)).toBe(true);
  });
});
