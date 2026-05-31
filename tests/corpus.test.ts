import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), "utf8");

describe("corpus fixtures (QG-03)", () => {
  it("loads the real Bancolombia .eml fixture, non-empty, with the DKIM/From anchor", () => {
    const raw = fixture("bancolombia/bancolombia-cc-purchase-RAW.eml");
    expect(raw.length).toBeGreaterThan(0);
    // The sender/DKIM domain — the deterministic match anchor for Bancolombia.
    expect(raw).toContain("notificacionesbancolombia.com");
  });

  it("encodes the AHORROS no-number exception: B-2 names the product type with no trailing digits", () => {
    const inflow = fixture("bancolombia/bancolombia-savings-inflow-and-cc-purchase.txt");

    // Isolate the inflow line (B-2). It must name the product TYPE word...
    const inflowLine = inflow.split("\n").find((l) => l.includes("Recibiste un pago"));
    expect(inflowLine).toBeDefined();
    expect(inflowLine).toContain("AHORROS");

    // ...and carry NO `*<4-digit>` trailing-digit token (the load-bearing exception):
    // the deterministic join cannot resolve it and needs a product-type fallback (Phase 3).
    expect(inflowLine).not.toMatch(/\*\d{4}/);
  });
});
