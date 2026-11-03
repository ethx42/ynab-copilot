import { describe, expect, it } from "vitest";
import type { IngestReport } from "../src/core/ingest/run-ingest.js";
import type { NormalizedTransaction } from "../src/core/domain/transaction.js";
import { attentionItems, toTicket } from "../src/core/reporting/attention.js";
import { finishRun, type OpsDeps } from "../src/core/reporting/finish-run.js";
import type { HeartbeatPort } from "../src/ports/heartbeat.js";
import type { Notice, NotifierPort } from "../src/ports/notifier.js";
import type { KnownTicket, ReviewQueuePort, ReviewTicket } from "../src/ports/review-queue.js";

const tx = (messageId: string): NormalizedTransaction => ({
  bank: "bancolombia",
  template: "B-1",
  kind: "purchase",
  direction: "outflow",
  amountPesos: 12345,
  date: "2026-11-02",
  time: "08:00",
  account: { kind: "last4", last4: "9999" },
  counterparty: "SOME MERCHANT",
  counterAccountLast4: null,
  sourceMessageId: messageId,
});

const report = (overrides: Partial<IngestReport> = {}): IngestReport => ({
  emailsSeen: 5,
  transactionsParsed: 5,
  created: 2,
  duplicates: 3,
  needsReview: [],
  parseFailures: [],
  handledMessageIds: [],
  ...overrides,
});

const withReview = (messageId: string): Partial<IngestReport> => ({
  needsReview: [
    { status: "needs_review", tx: tx(messageId), importId: "BC:x", reason: "unknown_last4" },
  ],
});

const KEY = "needs_review:m1:unknown_last4";

type Harness = {
  readonly ops: OpsDeps;
  readonly opened: ReviewTicket[];
  readonly closed: { ticket: KnownTicket; note: string }[];
  readonly pushes: Notice[];
  readonly pings: { status: string; detail: string }[];
  readonly logs: string[];
};

const harness = (
  options: {
    known?: readonly KnownTicket[];
    review?: boolean;
    notifier?: boolean;
    heartbeat?: boolean;
    failOpen?: boolean;
    failList?: boolean;
    failPush?: boolean;
    failPing?: boolean;
  } = {},
): Harness => {
  const opened: ReviewTicket[] = [];
  const closed: { ticket: KnownTicket; note: string }[] = [];
  const pushes: Notice[] = [];
  const pings: { status: string; detail: string }[] = [];
  const logs: string[] = [];
  const review: ReviewQueuePort = {
    listKnown: () =>
      options.failList === true
        ? Promise.reject(new Error("GitHub request failed: HTTP 500"))
        : Promise.resolve(options.known ?? []),
    open: (ticket) => {
      if (options.failOpen === true)
        return Promise.reject(new Error("GitHub request failed: HTTP 403"));
      opened.push(ticket);
      return Promise.resolve();
    },
    close: (ticket, note) => {
      closed.push({ ticket, note });
      return Promise.resolve();
    },
  };
  const notifier: NotifierPort = {
    send: (notice) => {
      if (options.failPush === true)
        return Promise.reject(new Error("push service rejected: HTTP 500"));
      pushes.push(notice);
      return Promise.resolve();
    },
  };
  const heartbeat: HeartbeatPort = {
    ping: (status, detail) => {
      if (options.failPing === true)
        return Promise.reject(new Error("heartbeat rejected: HTTP 502"));
      pings.push({ status, detail });
      return Promise.resolve();
    },
  };
  return {
    ops: {
      review: options.review === false ? null : review,
      notifier: options.notifier === false ? null : notifier,
      heartbeat: options.heartbeat === false ? null : heartbeat,
      log: (line) => logs.push(line),
    },
    opened,
    closed,
    pushes,
    pings,
    logs,
  };
};

describe("finishRun", () => {
  it("a clean run exits 0, opens nothing, pushes nothing and pings ok with counts only", async () => {
    const h = harness();
    expect(await finishRun(report(), h.ops, 72)).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(h.pings).toEqual([
      {
        status: "ok",
        detail: "5 emails, 5 transactions, 2 created, 3 already in YNAB, 0 need attention",
      },
    ]);
  });

  it("opens ONE ticket and sends ONE push for a new item, and the run still counts as healthy", async () => {
    const h = harness();
    expect(await finishRun(report(withReview("m1")), h.ops, 72)).toBe(0);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatchObject({ key: KEY, title: `[review] ${KEY}` });
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ priority: "high" });
    expect(h.pings[0]?.status).toBe("ok");
  });

  it("does not open or push again for an item that already has a ticket (open)", async () => {
    const h = harness({ known: [{ key: KEY, open: true, ref: "7" }] });
    expect(await finishRun(report(withReview("m1")), h.ops, 72)).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(h.closed).toEqual([]);
  });

  it("respects a ticket the owner closed: no reopening, no push", async () => {
    const h = harness({ known: [{ key: KEY, open: false, ref: "7" }] });
    expect(await finishRun(report(withReview("m1")), h.ops, 72)).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it("fails the run, and the heartbeat, when an item could not be handed to a human", async () => {
    const h = harness({ failOpen: true });
    expect(await finishRun(report(withReview("m1")), h.ops, 72)).toBe(1);
    expect(h.pushes).toEqual([]);
    expect(h.pings[0]?.status).toBe("fail");
    expect(h.logs.join("\n")).toContain("opening review ticket failed");
  });

  it("fails the run when the queue cannot even be listed (cannot tell what is new)", async () => {
    const h = harness({ failList: true });
    expect(await finishRun(report(withReview("m1")), h.ops, 72)).toBe(1);
    expect(h.opened).toEqual([]);
  });

  it("behaves like before when no review queue is configured: any item fails the run", async () => {
    const h = harness({ review: false });
    expect(await finishRun(report(withReview("m1")), h.ops, 72)).toBe(1);
    expect(h.logs).toContain("needs review: unknown_last4 (template B-1, message m1)");
    expect(h.pings[0]?.status).toBe("fail");
  });

  it("treats parse failures like review items", async () => {
    const h = harness();
    const r = report({
      parseFailures: [{ code: "unrecognized_format", messageId: "m9", excerpt: "x" }],
    });
    expect(await finishRun(r, h.ops, 72)).toBe(0);
    expect(h.opened[0]?.key).toBe("parse_failure:m9:unrecognized_format");
  });

  it("fails loudly when no bank alert was seen in the whole window", async () => {
    const h = harness();
    expect(await finishRun(report({ emailsSeen: 0, transactionsParsed: 0 }), h.ops, 72)).toBe(1);
    expect(h.logs).toContain("no bank alerts in the last 72h — failing loudly");
    expect(h.pings[0]?.status).toBe("fail");
  });

  it("closes a ticket only when its email was handled in this run", async () => {
    const h = harness({
      known: [
        { key: "needs_review:m1:unknown_last4", open: true, ref: "1" },
        { key: "needs_review:m2:unknown_last4", open: true, ref: "2" },
        { key: "needs_review:m3:unknown_last4", open: false, ref: "3" },
      ],
    });
    // m1 now parses and was written; m2 simply aged out of the window (not resolved); m3 closed.
    expect(await finishRun(report({ handledMessageIds: ["m1", "m3"] }), h.ops, 72)).toBe(0);
    expect(h.closed.map((c) => c.ticket.ref)).toEqual(["1"]);
    expect(h.closed[0]?.note).toContain("Resuelto");
  });

  it("a failing push or heartbeat never changes the exit code, and never logs a URL or topic", async () => {
    const h = harness({ failPush: true, failPing: true });
    expect(await finishRun(report(withReview("m1")), h.ops, 72)).toBe(0);
    const logged = h.logs.join("\n");
    expect(logged).toContain("sending push failed");
    expect(logged).toContain("heartbeat ping failed");
    expect(logged).not.toMatch(/https?:\/\//);
  });

  it("works with every channel off (the legacy mode) when nothing needs attention", async () => {
    const h = harness({ review: false, notifier: false, heartbeat: false });
    expect(await finishRun(report(), h.ops, 72)).toBe(0);
  });
});

describe("review tickets", () => {
  it("carry ids, a reason and instructions, but no transaction data (the repo is public)", () => {
    const [item] = attentionItems(report(withReview("m1")));
    expect(item).toBeDefined();
    if (item === undefined) return;
    const ticket = toTicket(item);
    expect(ticket.body).toContain("https://mail.google.com/mail/u/0/#all/m1");
    expect(ticket.body).toContain("ACCOUNT_REGISTRY_JSON");
    for (const secret of ["SOME MERCHANT", "12345", "9999", "2026-11-02"]) {
      expect(`${ticket.title}\n${ticket.body}`).not.toContain(secret);
    }
  });

  it("dedupes several sentences of one email with the same reason into one item", () => {
    const r = report({
      needsReview: [
        { status: "needs_review", tx: tx("m1"), importId: "BC:a", reason: "unknown_last4" },
        { status: "needs_review", tx: tx("m1"), importId: "BC:b", reason: "unknown_last4" },
      ],
    });
    expect(attentionItems(r)).toHaveLength(1);
  });
});
