import type { HeartbeatPort } from "../../ports/heartbeat.js";

// healthchecks.io-style dead-man's switch: POST to the check URL = "alive", `<url>/fail` = "the
// run finished but failed". The URL itself is the credential, so it never appears in an error.
const TIMEOUT_MS = 10_000;

export type HealthchecksOptions = {
  readonly pingUrl: string;
  readonly fetchImpl?: typeof fetch;
};

export const createHealthchecksHeartbeat = (options: HealthchecksOptions): HeartbeatPort => {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.pingUrl.replace(/\/+$/, "");
  return {
    ping: async (status, detail) => {
      const response = await doFetch(status === "ok" ? base : `${base}/fail`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: detail.slice(0, 10_000),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`heartbeat service rejected the ping: HTTP ${String(response.status)}`);
      }
    },
  };
};
