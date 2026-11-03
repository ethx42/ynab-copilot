import type { NotifierPort } from "../../ports/notifier.js";

// ntfy JSON publishing (POST to the server root with the topic in the body), which keeps accents
// out of HTTP headers. On ntfy.sh the topic name IS the password: it never appears in an error.
const TIMEOUT_MS = 10_000;

export type NtfyOptions = {
  readonly server: string;
  readonly topic: string;
  readonly fetchImpl?: typeof fetch;
};

export const createNtfyNotifier = (options: NtfyOptions): NotifierPort => {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    send: async (notice) => {
      const response = await doFetch(options.server.replace(/\/+$/, "") + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: options.topic,
          title: notice.title,
          message: notice.message,
          priority: notice.priority === "high" ? 4 : 3,
          tags: notice.priority === "high" ? ["warning"] : ["moneybag"],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`push service rejected the message: HTTP ${String(response.status)}`);
      }
    },
  };
};
