import { describe, expect, it } from "vitest";
import { parseDmyDate, parseClockTime } from "../src/core/domain/datetime.js";
import { parseCoAmount, parseUsAmount, pesosToMilliunits } from "../src/core/domain/money.js";

describe("amount parsing (CO vs US styles must never be confused)", () => {
  it("parses CO card-purchase amounts and truncates cents to whole pesos", () => {
    expect(parseCoAmount("COP39.088,00")).toEqual({ ok: true, value: 39088 });
    expect(parseCoAmount("COP84.442,54")).toEqual({ ok: true, value: 84442 });
    expect(parseCoAmount("COP6.365,18")).toEqual({ ok: true, value: 6365 });
    expect(parseCoAmount("COP1.234.567,00")).toEqual({ ok: true, value: 1234567 });
  });

  it("parses US-style amounts with and without decimals", () => {
    expect(parseUsAmount("$15,823,003.00")).toEqual({ ok: true, value: 15823003 });
    expect(parseUsAmount("$80,000.00")).toEqual({ ok: true, value: 80000 });
    expect(parseUsAmount("$200,000")).toEqual({ ok: true, value: 200000 });
    expect(parseUsAmount("$70,500")).toEqual({ ok: true, value: 70500 });
  });

  it("rejects the wrong style instead of silently misreading by 1000x", () => {
    expect(parseUsAmount("$79.200,00").ok).toBe(false);
    expect(parseCoAmount("COP79,200.00").ok).toBe(false);
    expect(parseCoAmount("$80,000.00").ok).toBe(false);
  });

  it("accepts CO separators behind a bare `$` (debit-card withdrawals) but not US ones", () => {
    expect(parseCoAmount("$500.000,00")).toEqual({ ok: true, value: 500000 });
    expect(parseCoAmount("$80,000.00").ok).toBe(false);
  });

  it("rejects zero, garbage and empty values", () => {
    expect(parseCoAmount("COP0,00").ok).toBe(false);
    expect(parseUsAmount("$").ok).toBe(false);
    expect(parseUsAmount("").ok).toBe(false);
  });

  it("converts whole pesos to YNAB milliunits", () => {
    expect(pesosToMilliunits(217375)).toBe(217375000);
  });
});

describe("date and time parsing", () => {
  it("converts DD/MM/YYYY to ISO and validates the calendar", () => {
    expect(parseDmyDate("02/11/2026")).toEqual({ ok: true, value: "2026-11-02" });
    expect(parseDmyDate("29/02/2028")).toEqual({ ok: true, value: "2028-02-29" });
    expect(parseDmyDate("31/02/2026").ok).toBe(false);
    expect(parseDmyDate("2026-11-02").ok).toBe(false);
  });

  it("validates 24h clock times", () => {
    expect(parseClockTime("23:59")).toEqual({ ok: true, value: "23:59" });
    expect(parseClockTime("24:00").ok).toBe(false);
    expect(parseClockTime("10:60").ok).toBe(false);
  });
});
