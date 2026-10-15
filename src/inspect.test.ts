import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../vendor/coding-agents/src/core/config";
import type { SyncStatus } from "../vendor/coding-agents/src/core/status";
import {
  collectBank,
  collectBanks,
  collectDoctor,
  collectDocuments,
  collectOverview,
  createInspectApi,
  formatBank,
  formatBanks,
  formatDoctor,
  formatDocuments,
  formatOverview,
  parseInspectInput,
  runInspect,
  type InspectApi,
  type InspectDeps,
  type InspectTransport,
} from "./inspect";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A config with only the fields the reports read; the token is deliberately absent. */
function cfg(overrides: Partial<Config> = {}): Config {
  return { apiUrl: "http://127.0.0.1:9077", serverMode: "daemon", disabled: false, ...overrides } as unknown as Config;
}

function stubApi(overrides: Partial<InspectApi> = {}): InspectApi {
  return {
    banks: async () => ({ total: 0, banks: [] }),
    documentCount: async () => 0,
    documents: async () => ({ total: 0, items: [] }),
    pages: async () => [],
    activeOperations: async () => 0,
    health: async () => true,
    ...overrides,
  };
}

function deps(overrides: Partial<InspectDeps> = {}): InspectDeps {
  return {
    api: stubApi(),
    cfg: cfg(),
    directory: "/tmp/repo",
    bankId: "coding-agent::repo",
    ...overrides,
  };
}

const BANK = {
  bankId: "coding-agent::hindsight-main",
  factCount: 686,
  createdAt: "2026-10-14T03:02:44.000Z",
  lastWriteAt: "2026-10-14T07:01:44.000Z",
};

describe("reading /hindsight's own arguments", () => {
  it("treats an empty line as the overview", () => {
    expect(parseInspectInput("")).toEqual({ kind: "overview" });
    expect(parseInspectInput("   ")).toEqual({ kind: "overview" });
  });

  it("reads the subcommands, with --all only where it means something", () => {
    expect(parseInspectInput("banks")).toEqual({ kind: "banks", all: false });
    expect(parseInspectInput("banks --all")).toEqual({ kind: "banks", all: true });
    // A bank id contains `::`, so the id must survive as ONE word.
    expect(parseInspectInput("bank coding-agent::hindsight-main")).toEqual({
      kind: "bank",
      bankId: "coding-agent::hindsight-main",
    });
    expect(parseInspectInput("doctor")).toEqual({ kind: "doctor" });
    expect(parseInspectInput("help")).toEqual({ kind: "help" });
  });

  it("reads documents' own flags, after the bank id", () => {
    expect(parseInspectInput("documents coding-agent::repo")).toEqual({
      kind: "documents",
      bankId: "coding-agent::repo",
      limit: 20,
      tags: [],
    });
    expect(parseInspectInput("documents coding-agent::repo --limit 3")).toEqual({
      kind: "documents",
      bankId: "coding-agent::repo",
      limit: 3,
      tags: [],
    });
    expect(parseInspectInput("documents coding-agent::repo --tags source:chat,harness:dsh --q session")).toEqual({
      kind: "documents",
      bankId: "coding-agent::repo",
      limit: 20,
      tags: ["source:chat", "harness:dsh"],
      q: "session",
    });
    // A limit nobody can read is clamped rather than refused; a nonsense one is refused.
    expect(parseInspectInput("documents b --limit 9999")).toMatchObject({ limit: 500 });
    expect(parseInspectInput("documents b --limit 0")).toEqual({ kind: "invalid", word: "0" });
    expect(parseInspectInput("documents b --limit many")).toEqual({ kind: "invalid", word: "many" });
    expect(parseInspectInput("documents b --limit")).toEqual({ kind: "invalid", word: "--limit" });
    expect(parseInspectInput("documents b --tags")).toEqual({ kind: "invalid", word: "--tags" });
    expect(parseInspectInput("documents b --tags ,,")).toEqual({ kind: "invalid", word: ",," });
    expect(parseInspectInput("documents b --wat")).toEqual({ kind: "invalid", word: "--wat" });
    expect(parseInspectInput("documents")).toEqual({ kind: "invalid", word: "" });
  });

  it("refuses an unknown word instead of guessing", () => {
    expect(parseInspectInput("bank")).toEqual({ kind: "invalid", word: "" });
    expect(parseInspectInput("banks --wat")).toEqual({ kind: "invalid", word: "--wat" });
    expect(parseInspectInput("teleport")).toEqual({ kind: "invalid", word: "teleport" });
  });
});

describe("the server adapter", () => {
  /** A transport that answers from a path → body table and records what was asked. */
  function transport(bodies: Record<string, unknown>): { t: InspectTransport; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      t: {
        apiUrl: "http://127.0.0.1:9077/",
        async req(_method, url) {
          asked.push(url);
          const key = Object.keys(bodies).find((k) => url.includes(k));
          if (key === undefined) return new Response("missing", { status: 404 });
          return new Response(JSON.stringify(bodies[key]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    };
  }

  it("maps the bank list and drops malformed rows", async () => {
    const { t, asked } = transport({
      "/v1/default/banks": { total: 2, banks: [{ bank_id: "a", fact_count: 3 }, { nope: true }] },
    });
    const api = createInspectApi(t);
    await expect(api.banks()).resolves.toEqual({
      total: 2,
      banks: [{ bankId: "a", factCount: 3, createdAt: undefined, lastWriteAt: undefined, mission: undefined }],
    });
    // A trailing slash on the configured URL must not double up.
    expect(asked[0]).toBe("http://127.0.0.1:9077/v1/default/banks?limit=200");
  });

  it("counts documents from the total, and only page nodes as pages", async () => {
    const { t } = transport({
      "/documents": { total: 7, items: [{}] },
      "/knowledge-base/tree": { roots: [{ kind: "page", name: "Component map" }, { kind: "folder", name: "x" }] },
    });
    const api = createInspectApi(t);
    await expect(api.documentCount("coding-agent::a")).resolves.toBe(7);
    await expect(api.pages("coding-agent::a")).resolves.toEqual(["Component map"]);
  });

  it("counts only operations that are still running", async () => {
    const { t } = transport({
      "/operations": {
        operations: [{ status: "running" }, { status: "completed" }, { status: "failed" }, {}],
      },
    });
    const api = createInspectApi(t);
    await expect(api.activeOperations("coding-agent::a")).resolves.toBe(1);
  });

  it("reports an unreachable daemon instead of throwing", async () => {
    const api = createInspectApi({
      apiUrl: "http://127.0.0.1:1",
      req: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(api.health()).resolves.toBe(false);
    await expect(api.banks()).rejects.toThrow("ECONNREFUSED");
  });

  it("maps a document listing, and asks for tags as REPEATED keys", async () => {
    // The one mistake this pins: `tags` is a list-typed query parameter, so a comma-joined value is
    // looked up as ONE literal tag and matches nothing — silently, with a 200.
    const { t, asked } = transport({
      "/documents": {
        total: 4,
        items: [{ id: "conversation:s1", updated_at: "2026-10-14T06:14:54+00:00", tags: ["source:chat", 7] }],
      },
    });
    const api = createInspectApi(t);
    const page = await api.documents("coding-agent::a", { limit: 5, tags: ["source:chat", "harness:dsh"] });
    expect(page.total).toBe(4);
    expect(page.items).toEqual([
      { id: "conversation:s1", updatedAt: "2026-10-14T06:14:54+00:00", createdAt: undefined, tags: ["source:chat"] },
    ]);
    const query = new URL(asked[0]!).searchParams;
    expect(query.getAll("tags")).toEqual(["source:chat", "harness:dsh"]);
    expect(query.get("tags_match")).toBe("all_strict");
    expect(query.get("limit")).toBe("5");
  });

  it("leaves the tag filter alone when no tags were asked for", async () => {
    const { t, asked } = transport({ "/documents": { total: 0, items: [] } });
    await createInspectApi(t).documents("coding-agent::a");
    expect(asked[0]).not.toContain("tags");
    expect(asked[0]).toContain("limit=20");
  });
});

describe("the bank listing", () => {
  const api = stubApi({
    banks: async () => ({
      total: 3,
      banks: [
        { bankId: "shared::team", factCount: 1, lastWriteAt: "2026-10-14T09:00:00.000Z" },
        { bankId: "coding-agent::old", factCount: 2, lastWriteAt: "2026-10-13T09:00:00.000Z" },
        BANK,
      ],
    }),
  });

  it("shows this integration's banks by default, newest write first", async () => {
    const report = await collectBanks(deps({ api }));
    expect(report.total).toBe(3);
    expect(report.shown.map((bank) => bank.bankId)).toEqual(["coding-agent::hindsight-main", "coding-agent::old"]);
    expect(report.hidden).toBe(1);
  });

  it("adds everything with --all, and nothing is then hidden", async () => {
    const report = await collectBanks(deps({ api }), true);
    expect(report.shown.map((bank) => bank.bankId)).toEqual([
      "shared::team",
      "coding-agent::hindsight-main",
      "coding-agent::old",
    ]);
    expect(report.hidden).toBe(0);
  });

  it("renders a table with the counts the list endpoint already carries", async () => {
    const text = formatBanks(await collectBanks(deps({ api })), false);
    expect(text).toContain("coding-agent::hindsight-main");
    expect(text).toContain("686");
    expect(text).toContain("1 more bank(s) not created by this integration — add --all");
  });

  it("says so when nothing has been recorded yet", () => {
    const text = formatBanks({ total: 0, shown: [], hidden: 0 }, false);
    expect(text).toContain("no banks yet");
  });
});

describe("the overview", () => {
  const sync: SyncStatus = {
    bank: BANK.bankId,
    gitlogPresent: true,
    gitDiffDocs: 3,
    gitDiffTarget: 36,
    chatDocs: 1,
    pagesCount: 5,
    surveyBaseline: "abc",
    surveyDocs: 4,
    surveyCommitsBehind: 2,
    activeOps: 0,
    synced: true,
  };

  it("names the resolved bank, its records and the sync state", async () => {
    const api = stubApi({
      banks: async () => ({ total: 2, banks: [BANK, { bankId: "coding-agent::other", factCount: 1 }] }),
      documentCount: async () => 7,
      pages: async () => ["a", "b", "c", "d", "e"],
    });
    const text = formatOverview(
      await collectOverview(deps({ api, bankId: BANK.bankId, sync: async () => sync })),
    );
    expect(text).toContain("daemon · http://127.0.0.1:9077 · daemon healthy");
    expect(text).toContain("/tmp/repo → coding-agent::hindsight-main");
    expect(text).toContain("686 facts · 7 documents · 5 knowledge pages");
    expect(text).toContain("sync      synced · gitlog yes · deepen 3/36");
    expect(text).toContain("2 bank(s) from this integration, 2 total");
  });

  it("still answers when the server is down — that is when it is asked", async () => {
    const api = stubApi({
      health: async () => false,
      banks: async () => {
        throw new Error("ECONNREFUSED");
      },
      documentCount: async () => {
        throw new Error("ECONNREFUSED");
      },
      pages: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const text = formatOverview(await collectOverview(deps({ api })));
    expect(text).toContain("daemon NOT answering");
    expect(text).toContain("— (the server did not answer)");
    expect(text).toContain("records   0 facts · 0 documents · 0 knowledge pages");
  });

  it("says memory is off where no bank resolved", async () => {
    const text = formatOverview(await collectOverview(deps({ bankId: "", sync: undefined })));
    expect(text).toContain("(no bank — disabled or opted out here)");
    expect(text).toContain("records   — memory is off for this directory");
  });
});

describe("one bank", () => {
  it("reports documents, pages and running extractions", async () => {
    const api = stubApi({
      banks: async () => ({ total: 1, banks: [BANK] }),
      documentCount: async () => 7,
      pages: async () => ["Component map", "Core concepts"],
      activeOperations: async () => 2,
    });
    const text = formatBank(await collectBank(deps({ api }), BANK.bankId));
    expect(text).toContain(`bank       ${BANK.bankId}`);
    expect(text).toContain("documents  7");
    expect(text).toContain("pages      2 — Component map, Core concepts");
    expect(text).toContain("operations 2 still running");
  });

  it("does not pretend a missing server is zero pages", async () => {
    const api = stubApi({
      banks: async () => {
        throw new Error("nope");
      },
      activeOperations: async () => {
        throw new Error("nope");
      },
    });
    const text = formatBank(await collectBank(deps({ api }), "coding-agent::gone"));
    expect(text).toContain("operations — (the server did not answer)");
    expect(text).toContain("pages      none yet");
  });
});

describe("the document listing", () => {
  const DOCS = [
    { id: "gitlog:hindsight-main", updatedAt: "2026-10-14T07:00:57+00:00", tags: ["source:git", "source:git-log"] },
    { id: "conversation:session-5a7e7359", updatedAt: "2026-10-14T06:14:54+00:00", tags: ["harness:dsh", "source:chat"] },
  ];

  it("lists id, last write and provenance, newest first", async () => {
    const api = stubApi({ documents: async () => ({ total: 2, items: DOCS }) });
    const text = formatDocuments(
      await collectDocuments(deps({ api }), { bankId: BANK.bankId, limit: 20, tags: [] }),
    );
    expect(text).toContain(`Hindsight documents · ${BANK.bankId}`);
    expect(text).toContain("DOCUMENT");
    expect(text).toContain("gitlog:hindsight-main");
    expect(text).toContain("source:git source:git-log");
  });

  it("names the filter it applied, and says a tag is required rather than any", async () => {
    const api = stubApi({ documents: async () => ({ total: 2, items: DOCS }) });
    const text = formatDocuments(
      await collectDocuments(deps({ api }), {
        bankId: BANK.bankId,
        limit: 20,
        tags: ["source:chat", "harness:dsh"],
        q: "session",
      }),
    );
    expect(text).toContain("tags source:chat + harness:dsh (all)");
    expect(text).toContain('q "session"');
  });

  it("says how many were left out when the limit bites", async () => {
    const api = stubApi({ documents: async () => ({ total: 137, items: DOCS }) });
    const text = formatDocuments(
      await collectDocuments(deps({ api }), { bankId: BANK.bankId, limit: 2, tags: [] }),
    );
    expect(text).toContain("showing 2 of 137 — raise --limit (max 500)");
  });

  it("distinguishes an empty filter result from an empty bank", async () => {
    const api = stubApi({ documents: async () => ({ total: 0, items: [] }) });
    const text = formatDocuments(
      await collectDocuments(deps({ api }), { bankId: BANK.bankId, limit: 20, tags: ["source:upload"] }),
    );
    expect(text).toContain("no documents match");
    expect(text).toContain("tags source:upload (all)");
  });

  it("shows a row with no tags as a dash rather than a blank column", async () => {
    const api = stubApi({ documents: async () => ({ total: 1, items: [{ id: "x", tags: [] }] }) });
    const text = formatDocuments(await collectDocuments(deps({ api }), { bankId: "b", limit: 20, tags: [] }));
    expect(text).toMatch(/x\s+—/);
  });
});

describe("the doctor report", () => {
  /** Write the three log files into a temp dir and point the report at them. */
  function logFiles(plugin: string, diag = "", usage = ""): InspectDeps["files"] {
    dir = mkdtempSync(join(tmpdir(), "hindsight-doctor-"));
    const files = {
      plugin: join(dir, "plugin.log"),
      diag: join(dir, "diag.jsonl"),
      usage: join(dir, "usage.jsonl"),
      config: join(dir, "coding-agent.json"),
    };
    writeFileSync(files.plugin, plugin);
    writeFileSync(files.diag, diag);
    writeFileSync(files.usage, usage);
    return files;
  }

  it("shows the last bind, the last diag event and the last bank a turn touched", async () => {
    const files = logFiles(
      "2026-10-14T10:03:23.746Z INFO  [dsh] memory plugin bound {\"mode\":\"daemon\"}\n",
      '{"ts":"2026-10-14T08:45:46.005Z","harness":"dsh","event":"daemon_restarted"}\n',
      '{"ts":"2026-10-14T06:14:30.266Z","harness":"dsh","bank":"coding-agent::hindsight-main","turn":3}\n',
    );
    const text = formatDoctor(await collectDoctor(deps({ files })));
    expect(text).toContain('last "memory plugin bound"');
    expect(text).toContain("last event daemon_restarted");
    expect(text).toContain("last turn");
    expect(text).toContain("coding-agent::hindsight-main");
  });

  it("says the plugin is not binding when there is no bind line at all", async () => {
    const files = logFiles("2026-10-14T10:03:23.746Z INFO  [dsh] something else\n");
    const text = formatDoctor(await collectDoctor(deps({ files })));
    expect(text).toContain('NO "memory plugin bound"');
    expect(text).toContain("this plugin is not binding");
  });

  it("surfaces a bind that FAILED, with the reason", async () => {
    // The exact line the fail-open catch writes: this is the diagnosis the report exists for.
    const files = logFiles(
      '2026-10-14T11:03:55.340Z ERROR [dsh] hindsight: memory disabled — the plugin failed to bind: cannot get property "llm" without inject\n',
    );
    const text = formatDoctor(await collectDoctor(deps({ files })));
    expect(text).toContain("bind      FAILED");
    expect(text).toContain('cannot get property "llm" without inject');
  });

  it("reports a missing log directory instead of failing", async () => {
    const report = await collectDoctor(
      deps({
        files: {
          plugin: "/nonexistent/plugin.log",
          diag: "/nonexistent/diag.jsonl",
          usage: "/nonexistent/usage.jsonl",
          config: "/nonexistent/coding-agent.json",
        },
      }),
    );
    expect(report.bind).toEqual({ logBytes: undefined });
    expect(report.configPresent).toBe(false);
    expect(report.diag).toBeNull();
  });
});

describe("dispatch", () => {
  it("returns the help text for help and for a bad argument", async () => {
    expect(await runInspect(deps(), { kind: "help" })).toContain("hindsight — this project's memory");
    expect(await runInspect(deps(), { kind: "invalid", word: "x" })).toContain("hindsight — this project's memory");
  });

  it("routes each request to its report", async () => {
    const api = stubApi({
      banks: async () => ({ total: 1, banks: [BANK] }),
      documents: async () => ({ total: 1, items: [{ id: "gitlog:repo", tags: ["source:git"] }] }),
    });
    expect(await runInspect(deps({ api }), { kind: "banks", all: false })).toContain("Hindsight banks");
    expect(await runInspect(deps({ api }), { kind: "bank", bankId: BANK.bankId })).toContain(`bank       ${BANK.bankId}`);
    expect(await runInspect(deps({ api }), { kind: "documents", bankId: BANK.bankId, limit: 20, tags: [] })).toContain(
      "Hindsight documents",
    );
    expect(await runInspect(deps({ api }), { kind: "doctor" })).toContain("hindsight doctor");
    expect(await runInspect(deps({ api }), { kind: "overview" })).toContain("hindsight · dsh memory");
  });
});
