import { describe, expect, it, vi } from "vitest";
import { createGmailMailPort, type GmailApi } from "../src/adapters/gmail/gmail-mail.js";

const mime = (parts: string): Buffer =>
  Buffer.from(
    [
      "From: Alertas y Notificaciones <alertasynotificaciones@an.notificacionesbancolombia.com>",
      "To: santiagov62@gmail.com",
      "Subject: Alertas y Notificaciones",
      "MIME-Version: 1.0",
      parts,
    ].join("\r\n"),
  );

const textPart = mime(
  [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Bancolombia: Compraste COP19.900,00 en APPLE.COM/BILL, el 02/11/2026 a las 08:05. =",
    "Esta compra esta asociada a T.Cred *8139.",
  ].join("\r\n"),
);

const htmlOnlyPart = mime(
  [
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><style>p{color:red}</style><body><p>Compraste COP11.852,00 en UBER&nbsp;RIDES con tu T.Cred *8139, el 02/11/2026 a las 09:00.</p></body></html>",
  ].join("\r\n"),
);

// The shape Bancolombia really sends: multipart/alternative holding ONLY a text/html part, with a
// tracking pixel first, entities, and several table cells. mailparser leaves `text` empty here.
const multipartHtmlOnly = mime(
  [
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<!DOCTYPE html> <html> <head> <title></title> <style>td{color:red}</style> </head> <body>" +
      '<img alt="" src="https://tracking.example/open/abc" /> <!-- Fluid Grid Master -->' +
      "<table><tbody><tr><td>Todo sali&oacute; bien con tus movimientos</td></tr>" +
      "<tr><td>&nbsp;</td></tr><tr><td>Bancolombia: Compraste COP79.200,00 en BOLD SA*mi cuate con tu T.Cred *8139, el 02/11/2026 a las 16:16. Si tienes dudas, encuentranos aqui: 6045109095.</td></tr></tbody></table>" +
      "</body></html>",
    "--b1--",
    "",
  ].join("\r\n"),
);

const fakeApi = (
  messages: Record<string, { raw: Buffer; internalDateMs: number }>,
): GmailApi & { queries: string[] } => {
  const queries: string[] = [];
  return {
    queries,
    listMessageIds: (query) => {
      queries.push(query);
      return Promise.resolve(Object.keys(messages));
    },
    getRaw: (id) => {
      const message = messages[id];
      return message === undefined
        ? Promise.reject(new Error("missing"))
        : Promise.resolve(message);
    },
  };
};

describe("Gmail mail port", () => {
  it("queries only the bank domain after the given instant (epoch seconds)", async () => {
    const api = fakeApi({});
    await createGmailMailPort(api).listAlertsSince("2026-11-02T00:00:00Z");
    expect(api.queries).toEqual(["from:notificacionesbancolombia.com after:1793577600"]);
  });

  it("decodes quoted-printable text and stamps the Gmail receive time", async () => {
    const api = fakeApi({ m1: { raw: textPart, internalDateMs: Date.UTC(2026, 10, 2, 13, 5) } });
    const [alert] = await createGmailMailPort(api).listAlertsSince("2026-11-01T00:00:00Z");
    expect(alert).toMatchObject({
      messageId: "m1",
      receivedAt: "2026-11-02T13:05:00.000Z",
    });
    expect(alert?.from).toContain("notificacionesbancolombia.com");
    expect(alert?.text).toContain("Compraste COP19.900,00 en APPLE.COM/BILL");
    expect(alert?.text).toContain("asociada a T.Cred *8139");
  });

  it("derives text from an HTML-only alert (the parser collapses any line wrapping)", async () => {
    const api = fakeApi({
      m2: { raw: htmlOnlyPart, internalDateMs: Date.UTC(2026, 10, 2, 14, 0) },
    });
    const [alert] = await createGmailMailPort(api).listAlertsSince("2026-11-01T00:00:00Z");
    expect(alert?.text.replace(/\s+/g, " ")).toBe(
      "Compraste COP11.852,00 en UBER RIDES con tu T.Cred *8139, el 02/11/2026 a las 09:00.",
    );
  });

  it("derives text from a multipart/alternative alert that carries only an HTML part", async () => {
    const api = fakeApi({
      m3: { raw: multipartHtmlOnly, internalDateMs: Date.UTC(2026, 10, 2, 21, 16) },
    });
    const [alert] = await createGmailMailPort(api).listAlertsSince("2026-11-01T00:00:00Z");
    const text = alert?.text.replace(/\s+/g, " ") ?? "";
    expect(text).toContain(
      "Compraste COP79.200,00 en BOLD SA*mi cuate con tu T.Cred *8139, el 02/11/2026 a las 16:16.",
    );
    expect(text).toContain("salió bien");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("tracking.example");
  });

  it("rejects an invalid since timestamp instead of querying everything", async () => {
    const api = fakeApi({});
    const list = vi.spyOn(api, "listMessageIds");
    await expect(createGmailMailPort(api).listAlertsSince("not-a-date")).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });

  describe("Banco de Bogota SMS forwarded by the phone", () => {
    const smsMime = (from: string, body: string): Buffer =>
      Buffer.from(
        [
          `From: ${from}`,
          "To: santiagov62@gmail.com",
          "Subject: SMSBDB",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          body,
        ].join("\r\n"),
      );
    const SMS =
      "Banco de Bogota: Tu compra por 7,100 fue aprobada con Tarjeta Crédito 3429 el 02/11/26 17:50:20 en BOLD SA*mi cuate ¿Dudas? Llama a la Servilinea ...";

    // Gmail answers per query: the bank-domain query and the SMS query find different mail.
    const routedApi = (
      bank: Record<string, { raw: Buffer; internalDateMs: number }>,
      sms: Record<string, { raw: Buffer; internalDateMs: number }>,
    ): GmailApi & { queries: string[] } => {
      const queries: string[] = [];
      return {
        queries,
        listMessageIds: (query) => {
          queries.push(query);
          return Promise.resolve(Object.keys(query.includes("SMSBDB") ? sms : bank));
        },
        getRaw: (id) => {
          const message = bank[id] ?? sms[id];
          return message === undefined
            ? Promise.reject(new Error("missing"))
            : Promise.resolve(message);
        },
      };
    };

    it("does not look for SMS mail unless a sender is configured", async () => {
      const api = routedApi({}, {});
      await createGmailMailPort(api).listAlertsSince("2026-11-02T00:00:00Z");
      expect(api.queries).toHaveLength(1);
    });

    it("queries the configured sender and subject, and tags the alert as an SMS", async () => {
      const api = routedApi(
        { m1: { raw: textPart, internalDateMs: Date.UTC(2026, 10, 2, 13, 5) } },
        {
          s1: {
            raw: smsMime("Santiago <Santiagov62@gmail.com>", SMS),
            internalDateMs: Date.UTC(2026, 10, 2, 22, 50),
          },
        },
      );
      const alerts = await createGmailMailPort(api, {
        smsForwardFrom: ["santiagov62@gmail.com"],
      }).listAlertsSince("2026-11-02T00:00:00Z");

      expect(api.queries).toEqual([
        "from:notificacionesbancolombia.com after:1793577600",
        'from:(santiagov62@gmail.com) subject:"SMSBDB" after:1793577600',
      ]);
      expect(alerts.map((a) => [a.messageId, a.source])).toEqual([
        ["m1", "bancolombia"],
        ["s1", "bancodebogota_sms"],
      ]);
      expect(alerts[1]?.text).toContain("Tu compra por 7,100 fue aprobada");
    });

    it("rejects mail whose real sender differs, even if the display name matches", async () => {
      const api = routedApi(
        {},
        {
          spoof: {
            raw: smsMime("santiagov62@gmail.com <attacker@evil.example>", SMS),
            internalDateMs: Date.UTC(2026, 10, 2, 22, 50),
          },
        },
      );
      const alerts = await createGmailMailPort(api, {
        smsForwardFrom: ["santiagov62@gmail.com"],
      }).listAlertsSince("2026-11-02T00:00:00Z");
      expect(alerts).toEqual([]);
    });
  });
});
