import { describe, expect, it, vi } from "vitest";
import { createGithubReviewQueue } from "../src/adapters/github/github-issues.js";
import { createHealthchecksHeartbeat } from "../src/adapters/healthchecks/healthchecks-http.js";
import { createNtfyNotifier } from "../src/adapters/ntfy/ntfy-http.js";
import { createYnabReadAdapter } from "../src/adapters/ynab/ynab-read.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch = (
  respond: (call: number, url: string, init: RequestInit | undefined) => Response,
) => {
  let calls = 0;
  return vi.fn<typeof fetch>((input, init) => {
    calls += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(respond(calls, url, init));
  });
};

const bodyOf = (fetchImpl: ReturnType<typeof fakeFetch>, call = 0): unknown => {
  const body = fetchImpl.mock.calls[call]?.[1]?.body;
  if (typeof body !== "string") throw new Error("expected a string body");
  return JSON.parse(body) as unknown;
};

describe("healthchecks heartbeat", () => {
  const URL_ = "https://hc-ping.com/11111111-2222-4333-8444-555555555555";

  it("pings the check URL for ok and /fail for failures, ignoring a trailing slash", async () => {
    const fetchImpl = fakeFetch(() => new Response("OK"));
    const hb = createHealthchecksHeartbeat({ pingUrl: `${URL_}/`, fetchImpl });
    await hb.ping("ok", "1 emails");
    await hb.ping("fail", "2 emails");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(URL_);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${URL_}/fail`);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe("1 emails");
  });

  it("throws a status-only error that never contains the secret URL", async () => {
    const fetchImpl = fakeFetch(() => new Response("nope", { status: 404 }));
    const hb = createHealthchecksHeartbeat({ pingUrl: URL_, fetchImpl });
    const error = await hb.ping("ok", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("404");
    expect((error as Error).message).not.toContain("hc-ping.com");
  });
});

describe("ntfy notifier", () => {
  it("publishes JSON (accents stay out of headers) with the priority mapped", async () => {
    const fetchImpl = fakeFetch(() => json(200, {}));
    const notifier = createNtfyNotifier({
      server: "https://ntfy.sh/",
      topic: "my-topic_1",
      fetchImpl,
    });
    await notifier.send({ title: "Revisión", message: "Hay 2 pendientes ñ", priority: "high" });
    await notifier.send({ title: "t", message: "m", priority: "default" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://ntfy.sh/");
    expect(bodyOf(fetchImpl, 0)).toMatchObject({
      topic: "my-topic_1",
      title: "Revisión",
      message: "Hay 2 pendientes ñ",
      priority: 4,
    });
    expect(bodyOf(fetchImpl, 1)).toMatchObject({ priority: 3 });
  });

  it("throws a status-only error without the topic", async () => {
    const fetchImpl = fakeFetch(() => new Response("", { status: 429 }));
    const notifier = createNtfyNotifier({
      server: "https://ntfy.sh",
      topic: "secret-topic",
      fetchImpl,
    });
    const error = await notifier
      .send({ title: "t", message: "m", priority: "default" })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain("429");
    expect((error as Error).message).not.toContain("secret-topic");
  });
});

describe("GitHub review queue", () => {
  const issue = (number: number, title: string, state: "open" | "closed", extra = {}) => ({
    number,
    title,
    state,
    ...extra,
  });

  it("lists open and closed tickets, skipping pull requests and unrelated issues", async () => {
    const fetchImpl = fakeFetch(() =>
      json(200, [
        issue(1, "[review] needs_review:m1:unknown_last4", "open"),
        issue(2, "[review] parse_failure:m2:unrecognized_format", "closed"),
        issue(3, "[review] needs_review:m3:unknown_last4", "open", { pull_request: {} }),
        issue(4, "Some other issue", "open"),
      ]),
    );
    const queue = createGithubReviewQueue({ token: "tok", repository: "o/r", fetchImpl });
    expect(await queue.listKnown()).toEqual([
      { key: "needs_review:m1:unknown_last4", open: true, ref: "1" },
      { key: "parse_failure:m2:unrecognized_format", open: false, ref: "2" },
    ]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/o/r/issues?labels=needs-review&state=all&per_page=100&page=1",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("pages through full pages and fails loudly past the safety cap", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      issue(i + 1, `[review] needs_review:m${String(i)}:unknown_last4`, "open"),
    );
    const endless = fakeFetch(() => json(200, full));
    const queue = createGithubReviewQueue({ token: "tok", repository: "o/r", fetchImpl: endless });
    await expect(queue.listKnown()).rejects.toThrow("too many review tickets");
    expect(endless).toHaveBeenCalledTimes(10);

    const twoPages = fakeFetch((call) =>
      json(200, call === 1 ? full : [issue(500, "[review] a:b:c", "open")]),
    );
    const q2 = createGithubReviewQueue({ token: "tok", repository: "o/r", fetchImpl: twoPages });
    expect(await q2.listKnown()).toHaveLength(101);
  });

  it("opens a labelled issue and closes by comment + completed state", async () => {
    const fetchImpl = fakeFetch(() => json(201, {}));
    const queue = createGithubReviewQueue({ token: "tok", repository: "o/r", fetchImpl });
    await queue.open({ key: "k", title: "[review] k", body: "b" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/o/r/issues");
    expect(bodyOf(fetchImpl, 0)).toEqual({
      title: "[review] k",
      body: "b",
      labels: ["needs-review"],
    });

    await queue.close({ key: "k", open: true, ref: "42" }, "Resuelto");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/o/r/issues/42/comments",
    );
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("https://api.github.com/repos/o/r/issues/42");
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(bodyOf(fetchImpl, 2)).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("throws a status-only error without the token", async () => {
    const fetchImpl = fakeFetch(() => new Response("", { status: 403 }));
    const queue = createGithubReviewQueue({
      token: "super-secret-token",
      repository: "o/r",
      fetchImpl,
    });
    const error = await queue.open({ key: "k", title: "t", body: "b" }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("GitHub request failed: HTTP 403");
  });
});

describe("YNAB read adapter", () => {
  it("counts only unapproved rows this pipeline imported", async () => {
    const fetchImpl = fakeFetch(() =>
      json(200, {
        data: {
          transactions: [
            { import_id: "BC:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", deleted: false },
            { import_id: "BB:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", deleted: false },
            { import_id: "BC:cccccccccccccccccccccccccccccccc", deleted: true },
            { import_id: "YNAB:-1000:2026-11-02:1", deleted: false },
            { import_id: null, deleted: false },
            {},
          ],
        },
      }),
    );
    const ynab = createYnabReadAdapter({ accessToken: "tok", budgetId: "b", fetchImpl });
    expect(await ynab.countUnapprovedImported()).toBe(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.ynab.com/v1/budgets/b/transactions?type=unapproved",
    );
  });

  it("fails with a status-only error", async () => {
    const fetchImpl = fakeFetch(() => new Response("", { status: 401 }));
    const ynab = createYnabReadAdapter({ accessToken: "tok", budgetId: "b", fetchImpl });
    await expect(ynab.countUnapprovedImported()).rejects.toThrow("HTTP 401");
  });
});
