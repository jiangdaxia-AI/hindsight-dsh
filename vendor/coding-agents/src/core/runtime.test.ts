/**
 * Tests for RuntimeCore's STEP interface — one call per step, prompt or not.
 *
 * WHY THESE EXIST. The adapter used to ask twice, `onPrompt` + `getInjection`, and only on steps that
 * carried a prompt. That gate was correct only while every memory block was delivered synchronously;
 * the moment a synthesis may arrive LATE, the step that has to deliver it is a tool continuation —
 * the case the gate excluded — so the gate and the guarantee cannot both survive. These tests hold
 * the guarantee: a synthesis that misses its wait is still delivered, on a prompt-less step, once.
 *
 * HERMETIC. The client is a stub, the Config comes from `resolveConfig`, and the diagnostics go to a
 * temp directory, so nothing here touches the network, the user's config or the real diag trail.
 *
 * The session cache is the one thing this runtime derives for itself — `sessionCacheFile` puts it in
 * the OS temp directory under the harness name, where REAL sessions of this plugin also live. Each
 * test therefore takes a session id no real session can have and deletes its cache file afterwards,
 * or a rerun would find the previous run's resolved answer and read it as "nothing to do".
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig, type RawConfig } from "./config";
import type { HindsightClient } from "./hindsight";
import { RuntimeCore } from "./runtime";
import { readSessionCache, sessionCacheFile } from "./session-cache";

let dir = "";
const savedEnv: Record<string, string | undefined> = {};
const createdCaches: string[] = [];
let seq = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "runtime-step-"));
  // TMPDIR is what `sessionCacheFile` derives its path from, and it is re-read on every
  // `os.tmpdir()` call — so pointing it here keeps this suite out of the namespace REAL sessions of
  // this plugin use (tmpdir()/hindsight-dsh), rather than relying on unique names and cleanup.
  for (const key of ["HINDSIGHT_DIAG_FILE", "HINDSIGHT_LOG_FILE", "HINDSIGHT_LOG_LEVEL", "TMPDIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HINDSIGHT_DIAG_FILE = join(dir, "diag.jsonl");
  process.env.HINDSIGHT_LOG_FILE = join(dir, "plugin.log");
  process.env.HINDSIGHT_LOG_LEVEL = "error";
  process.env.TMPDIR = dir;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  for (const file of createdCaches.splice(0)) rmSync(file, { force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const PAGE = { id: "kp-1", name: "The architecture page", snippet: "a snippet" };

function makeCore(raw: Partial<RawConfig>, opts: { reflect: () => Promise<string> }) {
  seq += 1;
  // No real session can be named this, and the cache file is removed after the test: a rerun must
  // not find the previous run's resolved answer and pass for the wrong reason.
  const sessionId = `runtime-test-${process.pid}-${Date.now().toString(36)}-${seq}`;
  createdCaches.push(sessionCacheFile("dsh", sessionId));
  const calls = { reflect: 0, listPages: 0, pageListBudgets: [] as (number | undefined)[] };
  const client = {
    bank: "coding-agent::test",
    async reflect() {
      calls.reflect += 1;
      return opts.reflect();
    },
    async listPages(opts?: { timeoutMs?: number }) {
      calls.listPages += 1;
      calls.pageListBudgets.push(opts?.timeoutMs);
      return [];
    },
    async searchKnowledgePages() {
      return [PAGE];
    },
    async recallObservations() {
      return [];
    },
  } as unknown as HindsightClient;
  const cfg = resolveConfig({
    autoInject: "reflect",
    reflectTimeoutMs: 1_000,
    injectTimeoutMs: 200,
    pageRefreshEveryTurns: 1,
    ...raw,
  });
  return { core: new RuntimeCore(client, "coding-agent::test", cfg, "dsh", dir), calls, cfg, sessionId };
}

describe("stepContext", () => {
  it("delivers a synthesis that missed its wait on a prompt-less step, exactly once", async () => {
    const gate = deferred<string>();
    const { core, calls, sessionId } = makeCore(
      { reflectPatienceMs: 10 },
      { reflect: () => gate.promise }
    );

    // The turn itself is not held: the retrieval fallback answers while the synthesis keeps running.
    const first = await core.stepContext(sessionId, "hello");
    expect(first.context).toContain("The architecture page");
    expect(first.context).not.toContain("LATE SYNTHESIS");

    gate.resolve("LATE SYNTHESIS");
    await tick();

    // A tool continuation: no prompt, and the ONLY step that can hand over what finished in between.
    const second = await core.stepContext(sessionId, undefined);
    expect(second.context).toContain("LATE SYNTHESIS");
    // Wrapped as memory, which is what keeps the write-back from re-ingesting it.
    expect(second.context).toContain("<hindsight_memory>");

    const third = await core.stepContext(sessionId, undefined);
    expect(third.context).toBeUndefined();
    expect(calls.reflect).toBe(1);
  });

  /**
   * A continuation is not a turn: it must not advance the cadence or refresh the roster, or the
   * per-turn work would run once per tool call instead of once per user prompt.
   */
  it("does not treat a prompt-less step as a turn", async () => {
    const { core, calls, cfg, sessionId } = makeCore(
      { reflectPatienceMs: 5 },
      { reflect: async () => "MEMORY" }
    );

    await core.stepContext(sessionId, "hello");
    expect(calls.listPages).toBe(1); // stale on the first turn
    // The roster runs on the awaited pre-step, so it carries the injection budget rather than the
    // client's generic request cap (see core/hindsight.ts DEFAULT_REQUEST_TIMEOUT_MS).
    expect(calls.pageListBudgets).toEqual([cfg.injectTimeoutMs]);

    await core.stepContext(sessionId, undefined);
    await core.stepContext(sessionId, undefined);
    expect(calls.listPages).toBe(1); // and never re-fetched by a continuation

    await core.stepContext(sessionId, "again");
    expect(calls.listPages).toBe(2); // a real turn does refresh it
  });

  it("injects the SessionStart preamble on the first turn only", async () => {
    const { core, sessionId } = makeCore({ reflectPatienceMs: 5 }, { reflect: async () => "MEMORY" });

    const first = await core.stepContext(sessionId, "hello");
    expect(first.context).toContain("<hindsight_knowledge>");

    const second = await core.stepContext(sessionId, "again");
    expect(second.context).not.toContain("<hindsight_knowledge>");
  });

  it("gives EACH session of one cold bank its own first-turn deferral", async () => {
    // A persistent host runs several sessions over one workspace; the deferral is per-SESSION
    // (each session's preamble goes in before its own reflect), so the first session taking the
    // core-level flag must not leave the second one synthesizing straight into a cold bank. The
    // flag is set here directly: `seedIfCold` derives it from a live bank query whose answer a
    // hermetic stub cannot steer, and the property under test is the DISTRIBUTION, not the
    // cold-check.
    const { core, calls, sessionId: a } = makeCore({ reflectPatienceMs: 5 }, { reflect: async () => "MEMORY" });
    const b = `runtime-test-${process.pid}-${Date.now().toString(36)}-sibling`;
    createdCaches.push(sessionCacheFile("dsh", b));
    (core as unknown as { deferInitialReflect: boolean }).deferInitialReflect = true;

    const first = await core.stepContext(a, "hello from A");
    expect(first.context).not.toContain("MEMORY"); // deferred: preamble only
    const second = await core.stepContext(b, "hello from B");
    expect(second.context).not.toContain("MEMORY"); // ALSO deferred, not just the first session
    expect(calls.reflect).toBe(0); // neither ran the synthesis
  });

  it("resets the cache's turn counter with the in-memory one on dispose", async () => {
    // The preamble boundary reads the in-memory counter; the roster cadence reads the cache
    // file's. A session disposed and resumed under the SAME id used to start at memory-turn-1
    // with a cache saying turn 5 — preamble AND cadence refresh on one step, one apart forever.
    const { core, sessionId } = makeCore({ reflectPatienceMs: 5 }, { reflect: async () => "MEMORY" });
    const cacheFile = sessionCacheFile("dsh", sessionId);
    await core.stepContext(sessionId, "one");
    await core.stepContext(sessionId, "two");
    const before = JSON.parse(readFileSync(cacheFile, "utf8")) as { turns?: number };
    expect(before.turns).toBe(2);

    core.disposeSession(sessionId);
    const after = readSessionCache(cacheFile);
    expect(after.turns).toBeUndefined(); // cleared WITH the in-memory counter
    expect(after.pages).toBeUndefined();
  });
});

describe("retainIfGrown", () => {
  it("retains a snapshot once, no matter how many paths race to submit it", async () => {
    const { core, sessionId } = makeCore({ reflectPatienceMs: 5 }, { reflect: async () => "MEMORY" });
    const retained: number[][] = [];
    (core as unknown as { client: { retain: (t: number[]) => Promise<void> } }).client.retain = async (turns) => {
      retained.push(turns);
    };

    core.retainIfGrown(sessionId, [{ role: "user", content: "hi" } as never], "idle");
    core.retainIfGrown(sessionId, [{ role: "user", content: "hi" } as never], "dispose");
    await tick();
    expect(retained).toHaveLength(1); // the dedupe gate: the second submit is a no-op

    core.retainIfGrown(sessionId, [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] as never, "dispose");
    await tick();
    expect(retained).toHaveLength(2); // a GROWN transcript goes through
  });
});

describe("flush", () => {
  it("keeps waiting for write-backs that join the set after flush began", async () => {
    // A retain spends up to its daemon-wait budget BEFORE its promise joins `inFlight`, so a
    // single Promise.all(snapshot) at entry misses a write-back that started moments earlier.
    // The loop is what makes unload safe: each pass waits for whatever is in the set NOW, and
    // a set that grew again gets another pass.
    const { core } = makeCore({ reflectPatienceMs: 5 }, { reflect: async () => "MEMORY" });
    const inFlight = (core as unknown as { inFlight: Set<Promise<void>> }).inFlight;
    const order: string[] = [];

    // Write 1: in the set before flush, and slow.
    let releaseFirst: (() => void) | undefined;
    const firstArrived = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstWrite = (async () => {
      order.push("first-start");
      await firstArrived;
      order.push("first-done");
    })();
    inFlight.add(firstWrite);
    void firstWrite.then(() => inFlight.delete(firstWrite));

    // Write 2: joins WHILE flush is waiting for write 1 — the case a single snapshot misses.
    const secondWrite = (async () => {
      order.push("second-start");
      order.push("second-done");
    })();
    const flush = core.flush(2_000);
    inFlight.add(secondWrite);
    void secondWrite.then(() => inFlight.delete(secondWrite));

    releaseFirst?.();
    await flush;
    // What matters: flush waited for the SECOND write too. A single snapshot at entry would
    // have resolved flush the moment write 1 settled, leaving write 2 in the set behind it.
    expect(order).toContain("first-done");
    expect(order).toContain("second-done");
    expect(inFlight.size).toBe(0);
  });
});
