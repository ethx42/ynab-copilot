import { describe, expect, it } from "vitest";
import { buildDigest, type DigestFacts } from "../src/core/reporting/digest.js";

const facts = (overrides: Partial<DigestFacts> = {}): DigestFacts => ({
  windowHours: 24,
  emailsSeen: 6,
  movements: 7,
  attention: 0,
  openTickets: 0,
  unapproved: 4,
  ...overrides,
});

describe("buildDigest", () => {
  it("summarises a normal day at default priority", () => {
    const notice = buildDigest(facts());
    expect(notice.priority).toBe("default");
    expect(notice.title).toBe("YNAB: resumen diario");
    expect(notice.message).toBe(
      [
        "Últimas 24 h: 6 correos del banco, 7 movimientos.",
        "4 filas sin aprobar en YNAB.",
        "Nada pendiente de revisión.",
      ].join("\n"),
    );
  });

  it("uses singular forms", () => {
    const notice = buildDigest(
      facts({ emailsSeen: 1, movements: 1, unapproved: 1, openTickets: 1 }),
    );
    expect(notice.message).toContain("1 correo del banco, 1 movimiento.");
    expect(notice.message).toContain("1 fila sin aprobar");
    expect(notice.message).toContain("1 issue abierto por revisar en GitHub.");
  });

  it("goes high priority when something needs the owner", () => {
    expect(buildDigest(facts({ openTickets: 2 })).priority).toBe("high");
    expect(buildDigest(facts({ attention: 1 })).priority).toBe("high");
    expect(buildDigest(facts({ openTickets: 2 })).title).toContain("requiere revisión");
  });

  it("says so when there were no bank emails at all, instead of staying quiet", () => {
    const notice = buildDigest(facts({ emailsSeen: 0, movements: 0 }));
    expect(notice.message).toContain("Sin correos del banco en las últimas 24 h.");
  });

  it("admits when it could not read the unapproved rows instead of guessing", () => {
    expect(buildDigest(facts({ unapproved: null })).message).toContain(
      "No pude leer las filas sin aprobar de YNAB.",
    );
  });
});
