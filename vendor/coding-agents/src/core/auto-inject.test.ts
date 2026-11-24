/**
 * Tests for core/auto-inject.ts — the split between how long the synthesis may TAKE and how long a
 * step WAITS, and the delivery of an answer that outlives the wait.
 *
 * WHY THESE EXIST. This module exists because two latency classes (a local page search, and an LLM
 * synthesis that can run for minutes) were behind one `await` and one budget, so a slow synthesis
 * and a dead one cost the user the same minute. Every property that makes the split safe is
 * invisible in a green build: exactly one synthesis per session however many steps ask, attempts
 * charged on settlement rather than on the wait, a late answer delivered once, and the hook
 * harnesses (patience Infinity) seeing precisely the behaviour they had before. Each of those is a
 * test below.
 *
 * HERMETIC. No network, no config file, no real diag trail: the client is a stub, the Config comes
 * from `resolveConfig` over an explicit RawConfig, and HINDSIGHT_DIAG_FILE/HINDSIGHT_LOG_FILE point
 * at a temp directory so a test cannot pollute the trail an actual diagnosis reads.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AutoInject,
  type AutoInjectClient,
  type AutoInjectInputs,
} from "./auto-inject";
import { resolveConfig, type RawConfig } from "./config";
import { ReflectError } from "./hindsight";
import { readSessionCache, writeSessionCache } from "./session-cache";

let dir = "";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "auto-inject-"));
  for (const key of ["HINDSIGHT_DIAG_FILE", "HINDSIGHT_LOG_FILE", "HINDSIGHT_LOG_LEVEL"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HINDSIGHT_DIAG_FILE = join(dir, "diag.jsonl");
  process.env.HINDSIGHT_LOG_FILE = join(dir, "plugin.log");
  process.env.HINDSIGHT_LOG_LEVEL = "error";
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A promise the test resolves by hand — how a slow synthesis is expressed without real waiting. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled promise's continuation run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface ClientOptions {
  reflect?: () => Promise<string>;
  pages?: () => Promise<{ id: string; name: string; snippet: string }[]>;
  recall?: () => Promise<string[]>;
}

const PAGE = { id: "kp-1", name: "The architecture page", snippet: "a snippet" };

/** A stub client that counts what was asked, so "exactly once" is an assertion and not a hope. */
function makeClient(opts: ClientOptions = {}) {
  const calls = { reflect: 0, pages: 0, recall: 0 };
  const client: AutoInjectClient = {
    bank: "coding-agent::test",
    async reflect() {
      calls.reflect += 1;
      return opts.reflect ? opts.reflect() : "MEMORY";
    },
    async searchKnowledgePages() {
      calls.pages += 1;
      return opts.pages ? opts.pages() : [];
    },
    async recallObservations() {
      calls.recall += 1;
      return opts.recall ? opts.recall() : [];
    },
  };
  return { client, calls };
}

let seq = 0;

/**
 * One session: its own session id and cache file, a stub client, and the inputs each step hands the
 * module. `step()` is a USER TURN; `continuation()` is a tool continuation — a step with no prompt,
 * which can only collect what an earlier step's wait did not. (They are separate calls on purpose:
 * an `undefined` argument that means "continuation" must not also be what "prompt omitted" looks
 * like.)
 */
function scenario(raw: Partial<RawConfig> = {}, opts: ClientOptions = {}) {
  seq += 1;
  const sessionId = `session-${seq}`;
  const cacheFile = join(dir, `session-${seq}.json`);
  const { client, calls } = makeClient(opts);
  const cfg = resolveConfig({
    autoInject: "reflect",
    reflectTimeoutMs: 1_000,
    injectTimeoutMs: 200,
    ...raw,
  });
  // The goal is the STEP's, so it is passed as the step's prompt and nowhere else.
  const inputs: AutoInjectInputs = { harness: "dsh", sessionId, cfg, client, cacheFile };
  return {
    cacheFile,
    calls,
    cfg,
    client,
    sessionId,
    cache: () => readSessionCache(cacheFile),
    // Scoped to THIS session: the diag trail is one append-only file for the whole suite, so a
    // bare text search would find the previous test's events too.
    diag: () => {
      try {
        return readFileSync(join(dir, "diag.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.includes(sessionId))
          .join("\n");
      } catch {
        return "";
      }
    },
    step: (step: AutoInject, prompt = "hello") => step.forStep(inputs, prompt),
    continuation: (step: AutoInject) => step.forStep(inputs, undefined),
  };
}

describe("what one step gets", () => {
  it("takes a synthesis that arrives inside the wait, and records it", async () => {
    const s = scenario({ reflectPatienceMs: 200 }, { reflect: async () => "MEMORY" });

    const delivery = await s.step(new AutoInject({ patienceMs: 200 }));

    expect(delivery).toMatchObject({ body: "MEMORY", source: "synthesis", failed: false });
    expect(s.cache().reflectAnswer).toBe("MEMORY");
    expect(s.cache().reflectAttempts).toBe(1);
  });

  /**
   * The whole point. A synthesis that is still running must not hold the step: the cheap retrieval
   * answers instead, the synthesis keeps running, and a LATER step — including a tool continuation,
   * which carries no prompt — collects it.
   */
  it("does not hold the step, and delivers the answer on a later step exactly once", async () => {
    const gate = deferred<string>();
    const s = scenario(
      { reflectPatienceMs: 10 },
      { reflect: () => gate.promise, pages: async () => [PAGE] }
    );
    const inject = new AutoInject({ patienceMs: 10 });

    const first = await s.step(inject);
    expect(first.source).toBe("fallback");
    expect(first.body).toContain("The architecture page");
    expect(s.cache().reflectAnswer).toBeUndefined(); // still unresolved: the synthesis is the answer

    gate.resolve("LATE SYNTHESIS");
    await tick();

    const second = await s.continuation(inject);
    expect(second).toMatchObject({ body: "LATE SYNTHESIS", source: "synthesis" });
    expect(s.cache().reflectAnswer).toBe("LATE SYNTHESIS");

    const third = await s.continuation(inject);
    expect(third).toMatchObject({ source: "none", failed: false });
  });

  /**
   * `patienceMs: 0` still yields one macrotask, so a synthesis that is already in hand is delivered
   * rather than discarded — the "never wait" value must not mean "throw away what arrived".
   */
  it("delivers a synthesis that is already in hand even at patience 0", async () => {
    const s = scenario({}, { reflect: async () => "MEMORY" });

    const delivery = await s.step(new AutoInject({ patienceMs: 0 }));

    expect(delivery).toMatchObject({ body: "MEMORY", source: "synthesis" });
  });

  /**
   * A hook harness exits with the turn, so nothing could ever deliver a late answer to it: it waits
   * the synthesis out. That is the pre-split behaviour, and it is a policy VALUE, not a code path —
   * so it is asserted here rather than assumed.
   */
  it("waits the synthesis out when patience is Infinity, and never falls back", async () => {
    const gate = deferred<string>();
    const s = scenario({}, { reflect: () => gate.promise, pages: async () => [PAGE] });

    const pending = s.step(new AutoInject({ patienceMs: Infinity }));
    setTimeout(() => gate.resolve("SLOW BUT WAITED"), 20);

    const delivery = await pending;

    expect(delivery).toMatchObject({ body: "SLOW BUT WAITED", source: "synthesis" });
    expect(s.calls.pages).toBe(0);
  });
});

describe("one synthesis per session", () => {
  /**
   * Steps are cheap and frequent (every pre-step), so "start it if it is not running" must be a
   * JOIN: a second start would double both the LLM cost and the wait, which is exactly the shape of
   * the bug this module replaces.
   */
  it("joins an in-flight synthesis instead of starting another", async () => {
    const gate = deferred<string>();
    const s = scenario({ reflectPatienceMs: 5 }, { reflect: () => gate.promise });
    const inject = new AutoInject({ patienceMs: 5 });

    await s.step(inject);
    await s.continuation(inject); // a tool continuation, mid-flight
    await s.step(inject); // the next turn, still mid-flight

    expect(s.calls.reflect).toBe(1);
  });

  /**
   * Regression risk of the split itself: charging the attempt when patience EXPIRES would burn the
   * session's second attempt on a step that merely stopped waiting, and then discard the answer it
   * was still waiting for. Attempts are charged on settlement.
   */
  it("charges the attempt on settlement, not on the step that stopped waiting", async () => {
    const gate = deferred<string>();
    const s = scenario({ reflectPatienceMs: 5 }, { reflect: () => gate.promise });
    const inject = new AutoInject({ patienceMs: 5 });

    await s.step(inject);
    expect(s.cache().reflectAttempts).toBeUndefined();
    expect(s.calls.reflect).toBe(1);

    gate.resolve("FINALLY");
    await tick();
    await s.continuation(inject);

    expect(s.cache().reflectAttempts).toBe(1);
    expect(s.cache().reflectAnswer).toBe("FINALLY");
  });

  it("retries a failed synthesis once, then gives up for good", async () => {
    const s = scenario(
      { reflectPatienceMs: 200 },
      {
        reflect: async () => {
          throw new Error("connection reset");
        },
      }
    );
    const inject = new AutoInject({ patienceMs: 200 });

    const first = await s.step(inject);
    // A plain network error is not a ReflectError, so no retrieval endpoint is tried: the failure is
    // reported and the attempt stays unresolved for a retry.
    expect(first).toMatchObject({ source: "none", failed: true });
    expect(s.cache().reflectAnswer).toBeUndefined();
    expect(s.cache().reflectAttempts).toBe(1);

    const second = await s.step(inject);
    expect(second).toMatchObject({ source: "none", failed: true });
    expect(s.calls.reflect).toBe(2);
    expect(s.cache().reflectAnswer).toBe(""); // budget spent: resolved with nothing to inject

    const third = await s.step(inject);
    expect(third).toMatchObject({ source: "none", failed: false });
    expect(s.calls.reflect).toBe(2);
  });

  /** A 5xx is the synthesis breaking, not the bank being unreachable: retrieval still answers, and
   *  its body resolves the session exactly like a synthesis would (injected once, not retried). */
  it("falls back to retrieval on a 5xx, and resolves the session with what it found", async () => {
    const s = scenario(
      {},
      {
        reflect: async () => {
          throw new ReflectError("reflect 500", 500, false);
        },
        pages: async () => [PAGE],
      }
    );

    const delivery = await s.step(new AutoInject({ patienceMs: 200 }));

    expect(delivery).toMatchObject({ source: "fallback", failed: false });
    expect(delivery.body).toContain("The architecture page");
    expect(s.cache().reflectAnswer).toContain("The architecture page");
  });
});

describe("the sources that are not the synthesis", () => {
  it("defers a cold bank's first synthesis exactly once", async () => {
    const s = scenario({ reflectPatienceMs: 200 }, { reflect: async () => "MEMORY" });
    writeSessionCache(s.cacheFile, { deferInitialReflect: true });
    const inject = new AutoInject({ patienceMs: 200 });

    const first = await s.step(inject);
    expect(first.source).toBe("none");
    expect(s.calls.reflect).toBe(0);
    expect(s.cache().deferInitialReflect).not.toBe(true); // consumed, so turn 2 stays eligible

    const second = await s.step(inject);
    expect(second).toMatchObject({ body: "MEMORY", source: "synthesis" });
  });

  it("answers from a retrieval-only source without ever starting a synthesis", async () => {
    const s = scenario(
      { autoInject: "pages" },
      { pages: async () => [PAGE], reflect: async () => "NEVER USED" }
    );

    const delivery = await s.step(new AutoInject({ patienceMs: 5 }));

    expect(delivery).toMatchObject({ source: "source", failed: false });
    expect(delivery.body).toContain("The architecture page");
    expect(s.calls.reflect).toBe(0);
  });

  /** An empty retrieval is cheap and its query is the current prompt, so it keeps its own, larger
   *  attempt budget — unlike a failure, which is reported. */
  it("keeps retrying an empty retrieval instead of treating it as a failure", async () => {
    const s = scenario({ autoInject: "pages" }, { pages: async () => [] });
    const inject = new AutoInject({ patienceMs: 5 });

    const empty = await s.step(inject);
    expect(empty).toMatchObject({ source: "none", failed: false });
    expect(s.cache().reflectAnswer).toBeUndefined();

    // Five empty attempts are its budget (no LLM, so it is cheap); the fifth resolves the session.
    for (let i = 0; i < 4; i++) await s.step(inject);
    expect(s.calls.pages).toBe(5);
    expect(s.cache().reflectAnswer).toBe("");
  });

  it("reports a failing retrieval source", async () => {
    const s = scenario(
      { autoInject: "recall" },
      {
        recall: async () => {
          throw new Error("daemon offline");
        },
      }
    );

    const delivery = await s.step(new AutoInject({ patienceMs: 5 }));

    expect(delivery).toMatchObject({ source: "none", failed: true });
  });

  it("injects nothing at all when autoInject is none", async () => {
    const s = scenario({ autoInject: "none" }, { reflect: async () => "NEVER USED" });

    const delivery = await s.step(new AutoInject({ patienceMs: 5 }));

    expect(delivery).toMatchObject({ source: "none", failed: false });
    expect(s.calls.reflect).toBe(0);
  });
});

describe("the edges the review found", () => {
  /**
   * Two steps of one session can overlap in a host that does not serialise them. The loser of the
   * claim must find NOTHING to add: before this was fixed it fell through to the retrieval branch and
   * injected a page list on top of the synthesis the winner had just injected.
   */
  it("adds nothing when a concurrent step already took the answer", async () => {
    const s = scenario(
      { reflectPatienceMs: 200 },
      { reflect: async () => "MEMORY", pages: async () => [PAGE] }
    );
    const inject = new AutoInject({ patienceMs: 200 });

    const [a, b] = await Promise.all([s.step(inject), s.step(inject)]);

    const bodies = [a, b].filter((d) => d.body);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ source: "synthesis", body: "MEMORY" });
    const empty = [a, b].find((d) => !d.body);
    expect(empty).toMatchObject({ source: "none", failed: false });
    expect(s.calls.pages).toBe(0);
  });

  /**
   * A late answer the session never got to collect is a real outcome, not silence: the cache marks
   * the session resolved (so no later process re-runs a 90-second synthesis), which means the body is
   * gone — and `reflect_late_dropped` is the only way to tell that from "memory never arrived".
   */
  it("records a late answer that the session was disposed before collecting", async () => {
    const gate = deferred<string>();
    const s = scenario({ reflectPatienceMs: 5 }, { reflect: () => gate.promise });
    const inject = new AutoInject({ patienceMs: 5 });

    await s.step(inject); // patience expires; the synthesis keeps running
    gate.resolve("ARRIVED TOO LATE");
    await tick();

    inject.dispose(s.sessionId);

    expect(s.diag()).toContain("reflect_late_dropped");
    expect(s.cache().reflectAnswer).toBe("ARRIVED TOO LATE");
  });

  it("records nothing dropped when the answer was delivered before disposal", async () => {
    const s = scenario({ reflectPatienceMs: 200 }, { reflect: async () => "MEMORY" });
    const inject = new AutoInject({ patienceMs: 200 });

    await s.step(inject); // delivered on this very step
    inject.dispose(s.sessionId);

    expect(s.diag()).not.toContain("reflect_late_dropped");
    expect(s.diag()).toContain("reflect_ok");
  });

  /**
   * A synthesis collected on a LATER turn must report the goal it was built for. Attributing it to
   * the newer prompt would claim memory of a question the synthesis never saw.
   */
  it("reports the goal the synthesis was built for, not the step that collected it", async () => {
    const gate = deferred<string>();
    const s = scenario({ reflectPatienceMs: 5 }, { reflect: () => gate.promise });
    const inject = new AutoInject({ patienceMs: 5 });

    await s.step(inject, "the original goal");
    gate.resolve("LATE SYNTHESIS");
    await tick();

    const collected = await s.step(inject, "a completely different later question");

    expect(collected).toMatchObject({ body: "LATE SYNTHESIS", source: "synthesis" });
    expect(collected.goal).toBe("the original goal");
  });
});
