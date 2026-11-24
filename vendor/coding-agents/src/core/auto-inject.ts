/**
 * What memory a STEP gets, and when the expensive half of it is allowed to arrive.
 *
 * WHY THIS IS ITS OWN MODULE. Two jobs used to share one `await`: matching the prompt against the
 * bank's knowledge pages (a local GET, measured 0-16ms) and asking the server to SYNTHESISE the
 * bank's history with an LLM (measured 0.5s-120s). One knob, `reflectTimeoutMs`, governed both "how
 * long the synthesis may take to SUCCEED" and "how long the user is made to wait on the session's
 * first prompt" — so a synthesis that was merely slow and one that was dead cost the user exactly
 * the same minute. In this repo's own diag trail that was 471s of a 657s total spent waiting on
 * reflections that FAILED, while 95% of the successful ones returned in under a second: the long
 * wait was buying almost nothing.
 *
 * This module owns every question the old code answered inline across three files — is this
 * session's synthesis still eligible, how long may THIS step wait for it, what does the step get
 * when the wait expires, where does an answer that arrives afterwards wait for its step, and when is
 * an attempt charged against the retry budget. Callers ask one question ("what is this step's
 * memory?") and never see a budget. Its interface is deliberately two methods.
 *
 * TWO HOST LIFECYCLES, ONE INTERFACE. A persistent-plugin host (this plugin, opencode, pi) keeps
 * the process alive across steps, so a synthesis that outlives one step's wait is delivered on a
 * LATER step of the same turn — `agent/pre-step` fires before every step, tool continuations
 * included — or on a later turn. A hook harness (Claude Code, Codex, ...) runs one process per
 * prompt and exits, so nothing could ever deliver a late answer to it: it passes
 * `patienceMs: Infinity` and waits out the whole `reflectTimeoutMs` exactly as it always has. That
 * is a policy VALUE, not a second code path — `Infinity` routes through this same module.
 *
 * DELIVERY IS IN-PROCESS ON PURPOSE. A late answer is an in-flight promise, so the only process that
 * can ever deliver it is the one that started it: a file or a helper process would add
 * serialization, liveness and crash surface to reach a place the caller is already in. (A hook
 * harness is the one host that genuinely cannot do this — which is why nothing there is deferred.)
 *
 * THE PRICE OF THAT CHOICE, stated rather than discovered later: a process that dies between a
 * synthesis settling and the next step loses that one body. Its settle was already recorded in the
 * session cache as this session's answer, so a later process treats the session as resolved rather
 * than re-running a ~90-second synthesis per restart — the better trade, but a trade. The loss is
 * bounded to a session that ends inside that window, and `reflect_late_dropped` (see `dispose`) is
 * what tells it apart from "no memory was ever produced".
 *
 * The cache file stays the cross-PROCESS record of what a session already resolved (`reflectAnswer`
 * / `reflectAttempts`), because a hook harness is a new process on every prompt. This module is its
 * only writer; the step builder writes `turns`/`pages` and merges.
 */
import type { Config } from "./config";
import { diag } from "./diag";
import { ReflectError } from "./hindsight";
import {
  buildReflectQuery,
  formatPageFallback,
  formatRecallFallback,
  PAGE_INJECT_LEAD,
  RECALL_INJECT_LEAD,
} from "./inject";
import { describeError, log } from "./log";
import { readSessionCache, writeSessionCache, type SessionCache } from "./session-cache";

/** Minimal client shape this module needs — `HindsightClient` satisfies it structurally. */
export interface AutoInjectClient {
  reflect(query: string, opts: { budget?: string; timeoutMs: number }): Promise<string>;
  searchKnowledgePages(
    query: string,
    opts?: { limit?: number; timeoutMs?: number }
  ): Promise<{ id: string; name: string; snippet: string }[]>;
  recallObservations(query: string, opts: { timeoutMs: number }): Promise<string[]>;
  knowledgePagesSupported?: boolean;
  /** Recorded on reflect failures so the diag trail says which bank to look at server-side. */
  readonly bank?: string;
}

/** Everything one step's automatic injection needs — without the goal, which is the STEP's (see
 *  `forStep`): carrying it here as well is how the same string ends up meaning two things. */
export interface AutoInjectInputs {
  harness: string;
  sessionId: string;
  cfg: Config;
  client: AutoInjectClient;
  cacheFile: string;
}

/**
 * What this step's memory turned out to be. The FACTS are here; the wording is the caller's, because
 * the user-facing sentence differs per harness and per source.
 *
 * Invariants: `body` is set exactly when `source !== "none"`; `failed` is set only alongside
 * `source: "none"` (a step that got memory did not fail, however it got it); `goal` is set only for
 * `source: "synthesis"`.
 */
export interface AutoInjectDelivery {
  /** The memory body to inject on this step, or undefined when there is nothing to inject. */
  body?: string;
  /**
   *   "synthesis" — this step took the session's synthesis: it finished inside the wait, or it is
   *                 the late answer a later step is here to collect.
   *   "source"    — this step ran the CONFIGURED retrieval source (`autoInject: pages`/`recall`)
   *                 and it answered. Cached like a synthesis: injected once, not retried.
   *   "fallback"  — the synthesis missed this step's wait (or failed); cheap retrieval answered
   *                 instead. The session still has memory, so the caller stays silent about it.
   *   "none"      — no injection: already resolved earlier, deferred on a cold bank, or a tool
   *                 continuation with nothing waiting.
   */
  source: "synthesis" | "source" | "fallback" | "none";
  /** The synthesis was attempted and FAILED with nothing to fall back to. Worth telling the user. */
  failed: boolean;
  /**
   * The goal the synthesis was actually built for. Needed because a late answer is claimed by a step
   * that may be a DIFFERENT turn than the one that asked: reporting it against the newer prompt would
   * attribute the memory to a question it never saw. Absent for a step's own retrieval source, whose
   * goal is by definition this step's prompt.
   */
  goal?: string;
}

/**
 * How many steps the SYNTHESIS may fail on before the session gives up on it. Measured in steps,
 * not time: each retry is another full attempt (up to `reflectTimeoutMs` server-side, and up to
 * `patienceMs` in front of the user).
 */
const SYNTHESIS_FAILED_ATTEMPTS = 2;

/**
 * Retrieval-only sources get a larger EMPTY budget: an empty retrieval is cheap (no LLM) and its
 * query is the CURRENT prompt, so an opener like "hi" matching nothing says nothing about the real
 * question — the session would otherwise lose its memory over a greeting.
 */
const RETRIEVAL_EMPTY_ATTEMPTS = 5;

/**
 * Servers older than the query truncation reject a recall query over 500 tokens with HTTP 400,
 * which cost the turn its memory on long or non-Latin prompts. A byte-level BPE token never covers
 * less than one UTF-8 byte, so non-ASCII is costed at its byte length (a true ceiling) and ASCII at
 * half a token, which still leaves English and code ~1000 characters.
 */
const RECALL_QUERY_MAX_TOKENS = 500;

function boundRecallQuery(prompt: string): string {
  let cost = 0;
  let end = 0;
  for (const ch of prompt) {
    const cp = ch.codePointAt(0)!;
    cost += cp < 0x80 ? 0.5 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (cost > RECALL_QUERY_MAX_TOKENS) break;
    end += ch.length;
  }
  return prompt.slice(0, end);
}

/** Knowledge-page search for the prompt, formatted for injection. `null` = it ran and nothing
 *  matched (an answer); `undefined` = it FAILED (recorded as `${event}_failed`) and is worth
 *  retrying. The two used to be one value, which cached a transient failure as "this session has no
 *  memory" for every remaining turn. Never throws. */
async function injectPages(
  harness: string,
  prompt: string,
  client: AutoInjectClient,
  timeoutMs: number,
  event: string,
  lead?: string
): Promise<string | null | undefined> {
  const t0 = Date.now();
  try {
    // The search query rides in a GET query string; the goal's opening carries its keywords.
    const hits = await client.searchKnowledgePages(prompt.slice(0, 500), { timeoutMs });
    diag(harness, event, { ms: Date.now() - t0, count: hits.length });
    return hits.length ? formatPageFallback(hits, lead) : null;
  } catch (e) {
    diag(harness, `${event}_failed`, { ms: Date.now() - t0, error: describeError(e) });
    return undefined;
  }
}

/** Raw recall over the bank (what it asks for is the client's `recallOptions`), formatted for
 *  injection; same contract as `injectPages`. Never throws. */
async function injectRecall(
  harness: string,
  prompt: string,
  client: AutoInjectClient,
  timeoutMs: number,
  event: string,
  lead?: string
): Promise<string | null | undefined> {
  const t0 = Date.now();
  try {
    const observations = await client.recallObservations(boundRecallQuery(prompt), { timeoutMs });
    diag(harness, event, { ms: Date.now() - t0, count: observations.length });
    return observations.length ? formatRecallFallback(observations, lead) : null;
  } catch (e) {
    diag(harness, `${event}_failed`, { ms: Date.now() - t0, error: describeError(e) });
    return undefined;
  }
}

/**
 * What to cache for a once-per-session injection, given what a retrieval source returned.
 *
 * `null` (ran, nothing matched) and `undefined` (failed) both stay UNRESOLVED so a later step can
 * try again, each until its own attempt budget is spent. Caching either as an answer cost the whole
 * session its memory: a first-prompt timeout, or a first prompt that simply matched nothing.
 *
 * Returns the answer to cache — a body, or `""` for "resolved with nothing to inject" — or
 * `undefined` for "unresolved, worth another attempt".
 */
function resolveRetrieval(got: string | null | undefined, attempts: number): string | undefined {
  if (got != null) return got;
  const budget = got === null ? RETRIEVAL_EMPTY_ATTEMPTS : SYNTHESIS_FAILED_ATTEMPTS;
  return attempts >= budget ? "" : undefined;
}

/** What one synthesis attempt resolved to. Never thrown — this is a return value. */
type Outcome =
  | { kind: "memory"; body: string }
  /** It ran and the bank holds nothing bearing on the goal. An ANSWER: not retried, like reflect_empty. */
  | { kind: "empty" }
  | {
      kind: "failed";
      /** Worth another step's attempt (transient, and the budget is not spent). */
      retryable: boolean;
      /** The cheap retrieval endpoints may still answer where the synthesis broke. */
      fallbackEligible: boolean;
    };

/** One session's synthesis, as far as delivery is concerned. */
interface Run {
  /** Never rejects: `attempt` returns its failures as values. */
  promise: Promise<void>;
  /** The goal this synthesis was built for — see `AutoInjectDelivery.goal`. */
  goal: string;
  /** Set when the attempt resolved. Delivery reads ONLY this. */
  outcome?: Outcome;
  /** The claim flag for exactly-once delivery — see `claim`. */
  delivered: boolean;
}

interface SessionState {
  /** The harness this session belongs to, kept so `dispose` can record without an input. */
  harness: string;
  /** Attempts spent, mirroring the cache's `reflectAttempts`. */
  attempts: number;
  /** The cache already holds this session's answer: nothing more to run, nothing more to deliver. */
  cacheResolved: boolean;
  /** The session's synthesis, from the moment it starts until it is delivered. */
  run?: Run;
}

/**
 * The automatic injection for a session, one step at a time.
 *
 * Construct ONE per host process and share it across sessions: the per-session state it keeps is
 * what lets a later step collect a late synthesis, and a throwaway instance per step would lose
 * exactly that.
 */
export class AutoInject {
  private readonly states = new Map<string, SessionState>();

  /**
   * @param opts.patienceMs - how long one step waits for the synthesis before it takes the cheap
   *   retrieval instead and leaves the synthesis running. `Infinity` = wait for it however long it
   *   takes, which is what a host that cannot deliver later (a hook harness) must do.
   */
  constructor(private readonly opts: { patienceMs: number }) {}

  /**
   * This step's memory. Starts the session's synthesis if it is still eligible, waits at most
   * `patienceMs` for it, and hands over whatever is in hand — including a synthesis whose run
   * finished since an earlier step, which is why this must be called on EVERY step, prompt or not.
   *
   * `prompt` is the goal this step carries, or undefined on a tool continuation. It is the ONLY
   * place a goal enters this module: the same string travelling in two shapes is how "this step's
   * prompt" and "the goal the synthesis was built for" start meaning different things.
   *
   * BOUNDS, precisely, because "bounded" is the whole point of this module. The synthesis wait is
   * `patienceMs` and nothing else. A step can additionally spend `cfg.injectTimeoutMs` on the
   * retrieval path, which is the pre-existing bound on those endpoints (7s by default) — so a step
   * that takes the fallback costs at most `patienceMs + injectTimeoutMs`, and a configured
   * `autoInject: pages`/`recall` step costs at most `injectTimeoutMs` (it never waits for an LLM).
   *
   * Never throws.
   */
  async forStep(
    req: AutoInjectInputs,
    prompt: string | undefined
  ): Promise<AutoInjectDelivery> {
    const st = this.stateFor(req);

    // (1) Whatever step this is, take a synthesis that no step has collected yet. This is the whole
    // delivery channel for an answer that missed its step's wait, and it is why a tool continuation
    // (prompt === undefined) must still call here: the block is NOT already in the history it sends,
    // which is the assumption the prompt-gate used to rest on.
    const late = this.claim(st);
    if (late !== undefined) {
      diag(req.harness, "reflect_late_ok", { session: req.sessionId, chars: late.length });
      return { body: late, source: "synthesis", failed: false, goal: st.run?.goal };
    }
    if (!prompt) return { source: "none", failed: false };

    // (2) A real user turn. A new/empty bank defers its first synthesis so the tool-guide preamble
    // goes in first; the marker is consumed here, exactly once, so the NEXT turn stays eligible.
    if (this.consumeDefer(req)) {
      diag(req.harness, "reflect_deferred_new_bank", { query: prompt.slice(0, 80) });
      return { source: "none", failed: false };
    }
    if (st.cacheResolved) return { source: "none", failed: false };
    if (req.cfg.autoInject === "none") return { source: "none", failed: false };

    // (3) Retrieval-only sources: no LLM, so no patience and no late delivery — they are cheap
    // enough to be the step's own synchronous answer, which is what they have always been.
    if (req.cfg.autoInject === "pages" || req.cfg.autoInject === "recall") {
      st.attempts += 1;
      const got = await this.retrievalSource(req, prompt, req.cfg.autoInject);
      const answer = resolveRetrieval(got, st.attempts);
      this.record(req, st, answer);
      if (answer) return { body: answer, source: "source", failed: false };
      // A failed REQUEST is worth saying out loud; an empty bank is not (there is no error to report
      // and the agent has the tools to look for itself).
      return { source: "none", failed: got === undefined };
    }

    // (4) The synthesis. Start it if this session has never resolved and still has budget.
    if (!st.run && st.attempts < SYNTHESIS_FAILED_ATTEMPTS) this.start(req, st, prompt);
    const run = st.run;
    if (!run) return { source: "none", failed: false };

    await this.waitFor(run);
    const body = this.claim(st);
    if (body !== undefined) return { body, source: "synthesis", failed: false, goal: run.goal };
    // It ran and the bank holds nothing for this goal. That is an answer — do NOT paper over it
    // with a retrieval search, which is what the empty/failed distinction is for.
    if (run.outcome?.kind === "empty") return { source: "none", failed: false };

    if (run.outcome?.kind === "failed") {
      // Settled as a failure, so nothing more is coming: the retrieval chain is this step's answer,
      // and a body it finds resolves the session exactly like a synthesis would (no retry).
      const got = run.outcome.fallbackEligible
        ? await this.reflectFallback(req, prompt)
        : undefined;
      if (got) {
        this.record(req, st, got);
        return { body: got, source: "fallback", failed: false };
      }
      return { source: "none", failed: true };
    }

    // Settled as memory, but another step claimed it first (two steps of one session can overlap in
    // a host that does not serialise them). Nothing is left to deliver and nothing is still running,
    // so this step must NOT fall through to the retrieval branch below — that would inject a page
    // list on top of the synthesis the other step just injected.
    if (run.outcome !== undefined) return { source: "none", failed: false };

    // (5) Still running. Do not hold the step for it: answer with the cheap retrieval, and leave the
    // synthesis running for a later step. Deliberately NOT recorded as resolved — the session's
    // answer is still the synthesis, and this body is a stopgap the caller dedupes if it repeats.
    diag(req.harness, "reflect_deferred", {
      session: req.sessionId,
      patienceMs: Number.isFinite(this.opts.patienceMs) ? this.opts.patienceMs : null,
      query: prompt.slice(0, 80),
    });
    const got = await this.reflectFallback(req, prompt);
    return got
      ? { body: got, source: "fallback", failed: false }
      : { source: "none", failed: false };
  }

  /**
   * Forget a session. Called when the host disposes it, so a long-lived process does not pin one
   * entry per session it ever opened. A run still in flight is NOT cancelled — it settles and
   * records its answer in the session cache, where a later process finds it.
   *
   * One thing IS lost here, and it is recorded rather than silent: a synthesis that had already
   * settled with a body no step had collected yet. The cache calls the session resolved (so no later
   * process re-runs a 90-second synthesis to re-derive it), which means that body is gone — hence
   * `reflect_late_dropped`, the only way to tell "the session ended before memory arrived" from
   * "memory never arrived at all".
   */
  dispose(sessionId: string): void {
    const st = this.states.get(sessionId);
    const dropped = st?.run;
    if (st && dropped?.outcome?.kind === "memory" && !dropped.delivered) {
      diag(st.harness, "reflect_late_dropped", {
        session: sessionId,
        chars: dropped.outcome.body.length,
      });
    }
    this.states.delete(sessionId);
  }

  // ── internals ───────────────────────────────────────────────────────────────────

  private stateFor(req: AutoInjectInputs): SessionState {
    const existing = this.states.get(req.sessionId);
    if (existing) return existing;
    // Seeded from the cache: for a hook harness this process has never seen the session, and for a
    // persistent host this is a session resumed from a previous process. Both must respect an answer
    // an earlier process already resolved.
    const cached = readSessionCache(req.cacheFile);
    const st: SessionState = {
      harness: req.harness,
      attempts: cached.reflectAttempts ?? 0,
      cacheResolved: cached.reflectAnswer !== undefined,
    };
    this.states.set(req.sessionId, st);
    return st;
  }

  /** Start (never restart) the session's synthesis. The attempt is charged immediately, like the
   *  pre-refactor code, so two steps cannot both spend one. */
  private start(req: AutoInjectInputs, st: SessionState, prompt: string): void {
    st.attempts += 1;
    const run: Run = { promise: Promise.resolve(), goal: prompt, delivered: false };
    st.run = run;
    run.promise = (async () => {
      const outcome = await this.attempt(req, prompt, st.attempts);
      run.outcome = outcome;
      if (outcome.kind === "memory") this.record(req, st, outcome.body);
      else if (outcome.kind === "empty") this.record(req, st, "");
      else if (outcome.retryable) {
        // Unresolved on purpose: the cache keeps the spent attempt and leaves the answer unset, so a
        // later step tries again. This is also why the attempt is charged on SETTLEMENT of the wait
        // rather than when patience expires — a step that merely stopped waiting must not burn the
        // session's second attempt and then discard the answer it was still waiting for.
        this.record(req, st, undefined);
        if (st.run === run) st.run = undefined;
      } else this.record(req, st, "");
    })();
  }

  /** One reflect attempt, as a value. Never throws — a failure here is an ordinary outcome. */
  private async attempt(
    req: AutoInjectInputs,
    prompt: string,
    attempts: number
  ): Promise<Outcome> {
    const timeoutMs = req.cfg.reflectTimeoutMs;
    const t0 = Date.now();
    try {
      const answer = await req.client.reflect(buildReflectQuery(prompt), {
        // Automatic reflection runs inside the host's window. Hindsight's low budget is the
        // supported default for bounded reflect calls; callers that explicitly invoke the MCP tool
        // still get the deeper high-budget path.
        budget: "low",
        timeoutMs,
      });
      diag(req.harness, answer ? "reflect_ok" : "reflect_empty", {
        ms: Date.now() - t0,
        chars: answer.length,
        session: req.sessionId,
        query: prompt.slice(0, 80),
        // Verbatim injected synthesis — the ONLY durable record of what the agent actually saw
        // (post-mortems otherwise depend on the harness happening to persist hook context).
        answer: answer.slice(0, 8000),
      });
      return answer ? { kind: "memory", body: answer } : { kind: "empty" };
    } catch (e) {
      // A failure is RETRYABLE until the budget is spent, not an answer. Caching "" here meant one
      // timeout on the session's first prompt disabled synthesis for the ENTIRE session, and against
      // a real server a reflect near the timeout is a coin flip, not an edge case.
      // ...except a permanent 4xx, which fails identically on every later attempt: resolve it now
      // rather than spend the session's second attempt on a call that cannot succeed.
      const permanent = e instanceof ReflectError && e.permanent;
      const retryable = !permanent && attempts < SYNTHESIS_FAILED_ATTEMPTS;
      const fallbackEligible = e instanceof ReflectError && e.fallbackEligible;
      log.warn(req.harness, "reflect failed — session runs without memory", {
        error: describeError(e),
      });
      diag(req.harness, "reflect_failed", {
        ms: Date.now() - t0,
        bank: req.client.bank,
        session: req.sessionId,
        timeoutMs,
        // Wider than describeError's default: the server's error body is the useful part.
        error: describeError(e, 1500),
        query: prompt.slice(0, 80),
      });
      return { kind: "failed", retryable, fallbackEligible };
    }
  }

  /**
   * Wait for the run, at most `patienceMs`.
   *
   * `Infinity` is handled WITHOUT a timer on purpose: `setTimeout` overflows on Infinity (Node fires
   * it after ~1ms and warns), which would silently turn a hook harness's "wait for it" into "never
   * wait at all". Its promise is awaited outright — exactly what the pre-refactor code did.
   */
  private async waitFor(run: Run): Promise<void> {
    if (!Number.isFinite(this.opts.patienceMs)) {
      await run.promise;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run.promise,
        new Promise<void>((resolve) => {
          // 0 = "never wait", but still yield one macrotask so a synthesis that already resolved
          // synchronously is delivered on this very step.
          timer = setTimeout(resolve, Math.max(this.opts.patienceMs, 0));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Take a settled synthesis that no step has taken yet, or undefined. The flag IS the claim, which
   * is what makes delivery exactly once across the many steps a turn can have.
   */
  private claim(st: SessionState): string | undefined {
    const run = st.run;
    if (!run || run.delivered) return undefined;
    const outcome = run.outcome;
    if (outcome?.kind !== "memory") return undefined;
    run.delivered = true;
    return outcome.body;
  }

  /**
   * Record what the session resolved to, in the cache AND in this process's state (`cacheResolved`).
   * `undefined` = still unresolved (the spent attempt is recorded so a later step does not re-charge
   * it as if the session were new).
   *
   * Merged, never replaced: the step builder owns `turns`/`pages` in the same file, and a synthesis
   * that settles AFTER a step wrote those must not drop them.
   */
  private record(req: AutoInjectInputs, st: SessionState, answer: string | undefined): void {
    if (answer !== undefined) st.cacheResolved = true;
    writeSessionCache(req.cacheFile, {
      ...readSessionCache(req.cacheFile),
      // Present (even "") means "resolved": no more attempts, no more delivery.
      ...(answer !== undefined ? { reflectAnswer: answer } : {}),
      reflectAttempts: st.attempts,
    } satisfies SessionCache);
  }

  /** Consume the cold-bank marker, exactly once. Returns true when THIS step was deferred.
   *
   *  The KEY is deleted rather than set false: the marker is read as `=== true` either way, but a
   *  hook harness (patience Infinity) then leaves a session cache byte-identical to the one the
   *  pre-split code wrote, which is what "hook behaviour is unchanged" has to mean. */
  private consumeDefer(req: AutoInjectInputs): boolean {
    const cached = readSessionCache(req.cacheFile);
    if (cached.deferInitialReflect !== true) return false;
    const rest: SessionCache = { ...cached };
    delete rest.deferInitialReflect;
    writeSessionCache(req.cacheFile, rest);
    return true;
  }

  /** The configured retrieval-only source (`autoInject: pages`/`recall`). */
  private retrievalSource(
    req: AutoInjectInputs,
    prompt: string,
    mode: "pages" | "recall"
  ): Promise<string | null | undefined> {
    return mode === "pages"
      ? injectPages(
          req.harness,
          prompt,
          req.client,
          req.cfg.injectTimeoutMs,
          "inject_pages",
          PAGE_INJECT_LEAD
        )
      : injectRecall(
          req.harness,
          prompt,
          req.client,
          req.cfg.injectTimeoutMs,
          "inject_recall",
          RECALL_INJECT_LEAD
        );
  }

  /**
   * Reflect timed out, 5xx'd, or missed this step's wait: the synthesis path did not answer, but
   * retrieval may still do so. Try the curated knowledge pages first, and only when none match fall
   * back to a raw recall over the bank's memories.
   *
   * Page search and recall share ONE retrieval budget, rather than each spending a full
   * `injectTimeoutMs` and doubling the time added to the step. Never throws; `null`/`undefined` mean
   * "nothing matched" and "it failed", which the callers here treat the same (no body).
   *
   * This is the one call in this module that a step still pays AFTER `patienceMs` has expired, and it
   * is why the module's bound is `patienceMs + injectTimeoutMs` rather than `patienceMs` alone.
   */
  private async reflectFallback(
    req: AutoInjectInputs,
    prompt: string
  ): Promise<string | null | undefined> {
    const deadline = Date.now() + req.cfg.injectTimeoutMs;
    const remaining = () => Math.max(deadline - Date.now(), 1);
    return (
      (await injectPages(
        req.harness,
        prompt,
        req.client,
        remaining(),
        "reflect_fallback_pages"
      )) ??
      // Event name predates the `injectRecall` rename and is kept: it is a logged contract that
      // other tools read, so renaming it would silently break them.
      (await injectRecall(
        req.harness,
        prompt,
        req.client,
        remaining(),
        "reflect_fallback_observations"
      ))
    );
  }
}
