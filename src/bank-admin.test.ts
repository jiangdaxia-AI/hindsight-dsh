import { describe, expect, it } from "vitest";
import {
  handleLibraryRequest,
  listLibraries,
  removeLibrary,
  type BankAdminDeps,
  type BankTransport,
} from "./bank-admin";
import { BANK_PREFIX, CONVERSATION_PREFIX } from "./inspect";

/** A transport that answers from a path → body table and records every call. */
function transport(
  bodies: Record<string, unknown>,
  options: { fail?: string } = {},
): { t: BankTransport; asked: Array<{ method: string; url: string }> } {
  const asked: Array<{ method: string; url: string }> = [];
  // The LONGEST matching key wins, so a table can carry both `/v1/default/banks` and the
  // `…/documents?q=` count URL without the shorter prefix swallowing the more specific one.
  const keys = () => Object.keys(bodies).sort((a, b) => b.length - a.length);
  return {
    asked,
    t: {
      apiUrl: "http://127.0.0.1:9077/",
      async req(method, url) {
        asked.push({ method, url });
        if (options.fail !== undefined && url.includes(options.fail)) throw new Error("ECONNREFUSED");
        const key = keys().find((candidate) => url.includes(candidate));
        if (key === undefined) return new Response("missing", { status: 404 });
        return new Response(JSON.stringify(bodies[key]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

/** The bank list every test starts from: one of ours, one of ours that never moved, one of theirs. */
const BANKS = {
  banks: [
    {
      bank_id: "coding-agent::hindsight-dsh",
      name: "coding-agent::hindsight-dsh",
      fact_count: 57,
      created_at: "2026-10-15T09:14:06.101102+00:00",
      last_write_at: "2026-10-15T10:01:40.146826+00:00",
    },
    { bank_id: "coding-agent::ifs", name: "coding-agent::ifs", fact_count: 34 },
    { bank_id: "someone-elses", name: "someone-elses", fact_count: 900, last_write_at: "2026-10-16T00:00:00Z" },
  ],
  total: 3,
};

/** A dependency set that answers like a healthy daemon in daemon mode. */
function deps(t: BankTransport, overrides: Partial<BankAdminDeps> = {}): BankAdminDeps {
  return { transport: () => t, serverMode: () => "daemon", disabled: () => false, ...overrides };
}

/** The URL one bank's session count is asked at. */
const COUNT_PATH = `/documents?limit=1&q=${encodeURIComponent(CONVERSATION_PREFIX)}`;

describe("listing a server's libraries", () => {
  it("keeps this integration's banks, newest write first, and counts their sessions", async () => {
    const { t, asked } = transport({
      "/v1/default/banks": BANKS,
      [COUNT_PATH]: { total: 2 },
    });
    const listed = await listLibraries(t, { all: false });
    expect(listed.libraries.map((row) => row.bankId)).toEqual(["coding-agent::hindsight-dsh", "coding-agent::ifs"]);
    expect(listed.libraries[0]).toEqual({
      bankId: "coding-agent::hindsight-dsh",
      label: "coding-agent::hindsight-dsh",
      factCount: 57,
      sessions: 2,
      createdAt: "2026-10-15T09:14:06.101102+00:00",
      lastWriteAt: "2026-10-15T10:01:40.146826+00:00",
    });
    // The bank that never moved still carries its count, and still sorts last.
    expect(listed.libraries[1]?.sessions).toBe(2);
    // `total` is the server's, `hidden` is what this listing left out — the page needs both to
    // offer "show every library" only when there is something to show.
    expect(listed.total).toBe(3);
    expect(listed.hidden).toBe(1);
    expect(asked[0]?.url).toBe("http://127.0.0.1:9077/v1/default/banks?limit=200");
    // One count per SHOWN row, never for the banks that were filtered out.
    expect(asked.filter((call) => call.url.includes("q=conversation%3A"))).toHaveLength(2);
  });

  it("includes every origin when asked, and stops calling any of them hidden", async () => {
    const { t } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    const listed = await listLibraries(t, { all: true });
    expect(listed.libraries.map((row) => row.bankId)).toEqual([
      "someone-elses",
      "coding-agent::hindsight-dsh",
      "coding-agent::ifs",
    ]);
    expect(listed.hidden).toBe(0);
  });

  it("reports an unreadable count as unknown rather than as zero sessions", async () => {
    // One broken count must not fail the listing, and it must not claim the bank is empty either.
    const { t } = transport({ "/v1/default/banks": BANKS }, { fail: "/documents" });
    const listed = await listLibraries(t, { all: false });
    expect(listed.libraries.map((row) => row.sessions)).toEqual([null, null]);
  });

  it("drops rows the server did not spell as banks", async () => {
    const { t } = transport({
      "/v1/default/banks": { banks: [{ bank_id: "coding-agent::ok", fact_count: 1 }, { nope: true }, { bank_id: "" }] },
      [COUNT_PATH]: { total: 1 },
    });
    const listed = await listLibraries(t, { all: false });
    expect(listed.libraries.map((row) => row.bankId)).toEqual(["coding-agent::ok"]);
  });

  it("prefers a display alias over the server's own name, and the id when neither exists", async () => {
    const { t } = transport({
      "/v1/default/banks": {
        banks: [
          { bank_id: "coding-agent::a", name: "raw", display_alias: "Nice name" },
          { bank_id: "coding-agent::b", name: "raw b" },
          { bank_id: "coding-agent::c" },
        ],
      },
      [COUNT_PATH]: { total: 0 },
    });
    const listed = await listLibraries(t, { all: false });
    expect(listed.libraries.map((row) => row.label)).toEqual(["Nice name", "raw b", "coding-agent::c"]);
  });
});

describe("removing a library", () => {
  it("refuses an id the server is not showing, and sends no delete at all", async () => {
    const { t, asked } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    await expect(removeLibrary(t, "coding-agent::typo", false)).rejects.toThrow("no such bank");
    expect(asked.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses a bank this listing is not scoped to, so 'show mine' cannot delete someone else's", async () => {
    const { t, asked } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    await expect(removeLibrary(t, "someone-elses", false)).rejects.toThrow("no such bank");
    expect(asked.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("deletes one that is, addressed by its encoded id", async () => {
    const { t, asked } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    await removeLibrary(t, "coding-agent::hindsight-dsh", false);
    const deleted = asked.find((call) => call.method === "DELETE");
    expect(deleted?.url).toBe("http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Ahindsight-dsh");
  });

  it("uses the same prefix for listing and for the delete guard", async () => {
    const { t, asked } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    await removeLibrary(t, "someone-elses", true);
    expect(asked.some((call) => call.method === "DELETE" && call.url.endsWith("someone-elses"))).toBe(true);
  });
});

describe("answering the settings page", () => {
  const req = (method: string, url = "http://dsh.internal/api/hindsight/libraries", body?: unknown) =>
    new Request(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });

  it("lists on GET, naming the server the answer came from", async () => {
    const { t } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 2 } });
    const answer = await handleLibraryRequest(req("GET"), deps(t));
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.endpoint).toBe("http://127.0.0.1:9077/");
    expect(body.serverMode).toBe("daemon");
    expect(body.disabled).toBe(false);
    expect(body.all).toBe(false);
    expect((body.libraries as unknown[]).length).toBe(2);
    expect(answer.headers.get("cache-control")).toBe("no-store");
  });

  it("honours the page's request to widen the listing", async () => {
    const { t } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    const answer = await handleLibraryRequest(req("GET", "http://dsh.internal/api/hindsight/libraries?all=1"), deps(t));
    const body = (await answer.json()) as { all: boolean; libraries: unknown[] };
    expect(body.all).toBe(true);
    expect(body.libraries).toHaveLength(3);
  });

  it("deletes on POST and answers with the state AFTER it, in one round trip", async () => {
    // A mutable stand-in for the server: the delete really removes the bank, so the answer to the
    // POST can only be right if it is read back after the delete rather than assembled from before.
    let banks = BANKS.banks.map((bank) => ({ ...bank }));
    const asked: Array<{ method: string; url: string }> = [];
    const server: BankTransport = {
      apiUrl: "http://127.0.0.1:9077/",
      async req(method, url) {
        asked.push({ method, url });
        if (method === "DELETE") {
          banks = banks.filter((bank) => !url.includes(encodeURIComponent(String(bank.bank_id))));
          return new Response(null, { status: 200 });
        }
        if (url.includes(CONVERSATION_PREFIX)) {
          return new Response(JSON.stringify({ total: 2 }), { status: 200 });
        }
        return new Response(JSON.stringify({ banks, total: banks.length }), { status: 200 });
      },
    };
    const answer = await handleLibraryRequest(
      req("POST", "http://dsh.internal/api/hindsight/libraries", { action: "delete", bankId: "coding-agent::hindsight-dsh" }),
      deps(server),
    );
    const body = (await answer.json()) as { ok: boolean; libraries: Array<{ bankId: string }> };
    expect(answer.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(asked.some((call) => call.method === "DELETE")).toBe(true);
    expect(body.libraries.map((row) => row.bankId)).toEqual(["coding-agent::ifs"]);
  });

  it("answers a refused delete with its own status and reason, not with 'unreachable'", async () => {
    const { t } = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    const answer = await handleLibraryRequest(
      req("POST", "http://dsh.internal/api/hindsight/libraries", { action: "delete", bankId: "coding-agent::typo" }),
      deps(t),
    );
    expect(answer.status).toBe(404);
    await expect(answer.json()).resolves.toMatchObject({ ok: false, code: "refused" });
  });

  it("rejects a body that is not a delete request", async () => {
    const { t } = transport({ "/v1/default/banks": BANKS });
    const cases: Array<[string, Request]> = [
      ["not JSON", new Request("http://dsh.internal/api/hindsight/libraries", { method: "POST", body: "{" })],
      ["no action", req("POST", "http://dsh.internal/api/hindsight/libraries", { bankId: "a" })],
      ["no bank", req("POST", "http://dsh.internal/api/hindsight/libraries", { action: "delete" })],
    ];
    for (const [name, request] of cases) {
      const answer = await handleLibraryRequest(request, deps(t));
      expect(answer.status, name).toBe(400);
      await expect(answer.json()).resolves.toMatchObject({ ok: false, code: "bad-request" });
    }
  });

  it("refuses a method it does not have rather than guessing at one", async () => {
    const { t } = transport({ "/v1/default/banks": BANKS });
    const answer = await handleLibraryRequest(req("PUT"), deps(t));
    expect(answer.status).toBe(405);
    await expect(answer.json()).resolves.toMatchObject({ ok: false, code: "bad-request" });
  });

  it("turns an unreachable server into a value the page can render", async () => {
    // The one case this must not do is throw: an unreachable server is the situation the page
    // exists for, and a rejected handler would reach the browser as a transport failure with no
    // reason attached.
    const { t } = transport({}, { fail: "/v1/default/banks" });
    const answer = await handleLibraryRequest(req("GET"), deps(t));
    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toMatchObject({ ok: false, code: "unreachable" });
  });

  it("reads the server at request time, so a save a moment ago is the one in force", async () => {
    // The page's own settings can move the endpoint while it is open; resolving the transport per
    // request is what makes the next refresh ask the server the user just switched to.
    const first = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    const second = transport({ "/v1/default/banks": BANKS, [COUNT_PATH]: { total: 0 } });
    let current = first.t;
    const answer = await handleLibraryRequest(req("GET"), deps(second.t, { transport: () => current }));
    expect(((await answer.json()) as { endpoint: string }).endpoint).toBe(first.t.apiUrl);
    current = second.t;
    const again = await handleLibraryRequest(req("GET"), deps(first.t, { transport: () => current }));
    expect(((await again.json()) as { endpoint: string }).endpoint).toBe(second.t.apiUrl);
  });
});

describe("the bank prefix this feature is scoped to", () => {
  it("is the same one the reports filter on", () => {
    expect(BANK_PREFIX).toBe("coding-agent::");
  });
});
