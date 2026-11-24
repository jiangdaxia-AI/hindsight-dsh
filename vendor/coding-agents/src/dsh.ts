/**
 * DeepSeek Harness (`dsh`) entrypoint — a native Cordis plugin.
 *
 * dsh is plugin-first: its canonical extension surface is a set of typed lifecycle events, and its
 * Claude Code / Codex hook bridges are just translators onto that same surface. So this integration
 * binds the events directly instead of installing hook binaries — a bridge would cost the same
 * install (neither bridge ships in a default profile) while losing the transcript, the session id
 * and the awaited stop boundary.
 *
 *   agent/session-start  -> RuntimeCore.seedIfCold      (cold-check + background git/codebase seed)
 *   agent/pre-step       -> RuntimeCore.stepContext  (recall) + the injection as a sourced message
 *   agent/turn-stopping  -> RuntimeCore.onSessionIdle   (write-back of the completed exchange)
 *   ctx.tools            -> the hindsight_* knowledge suite, registered natively
 *
 * ONE dsh PROCESS SERVES MANY WORKSPACES. Unlike opencode/Kilo/Cline — one process, one project —
 * dsh's Web UI creates sessions in whatever directory the user picks, each with its own
 * `session.header.cwd`. Memory is per-repo, so a RuntimeCore (bank, client, seed) is built PER
 * WORKSPACE ROOT and cached, never once per process.
 *
 * The plugin imports NOTHING from dsh at all: every host shape is structurally typed here, and the
 * tool definitions are built in dsh's own registry shape rather than through its `defineTool`
 * builder (see `toDshParameters`). So there is no dsh package for pnpm to resolve inside a profile,
 * and no version to keep in step — any dsh whose event names still match can load this file.
 */
import { randomUUID } from "node:crypto";
import type { RawConfig } from "./core/config";
import { resolveHostMemory } from "./core/host-client";
import {
  codeFactDocument,
  readWorkingTreeChange,
  sessionTouchedPaths,
  touchedPathsFromEvents,
} from "./core/code-facts";
import {
  createCompactionWatcher,
  spanDocumentId,
  type CompactionWatcher,
} from "./core/compaction-watcher";
import { diag } from "./core/diag";
import type { ToolSpec } from "./core/knowledge-tools";
import { describeError, log } from "./core/log";
import {
  planRehydration,
  renderSpanText,
  renderStoredSpanText,
  REHYDRATION_TAG,
  type RehydrateConfig,
} from "./core/rehydration";
import { buildRetainStamp, type RetainStamp } from "./core/retain-stamp";
import { RuntimeCore } from "./core/runtime";
import { HINDSIGHT_PLUGIN, readDshEvents, type DshSessionEvent } from "./core/transcript-dsh";

const HARNESS = "dsh";

/** Cordis plugin name (loader diagnostics, and the `source.plugin` on everything we inject). */
export const name = HINDSIGHT_PLUGIN;

/** The agent registry owns the lifecycle events below; without it there is nothing to bind. */
export const inject = ["agents"];

// ── host shapes (structural: this package must not depend on dsh's packages) ─────

interface DshSession {
  readonly header: { readonly id: string; readonly cwd?: string; readonly origin?: string };
  /**
   * Legacy in-memory event log. Present on DeepSeek Harness < alpha.4; removed in alpha.4+.
   * Prefer {@link snapshotEvents} when available.
   */
  readonly events?: readonly DshSessionEvent[];
  /** Public accessor on DeepSeek Harness alpha.4+ (replaces the removed `events` property). */
  snapshotEvents?(): readonly DshSessionEvent[];
}

interface DshAgent {
  readonly session: DshSession;
}

/** A `user/message` as dsh's pre-step decision carries it. */
interface DshUserMessage {
  role: "user";
  content: { type: string; text?: string }[];
  source: { kind: string; form?: string };
  id?: string;
}

type PreStepDecision =
  | { kind: "enter"; messages: DshUserMessage[] }
  | { kind: "reject"; [key: string]: unknown };

interface PreStepPayload {
  agent: DshAgent;
  signal: AbortSignal;
}

/** The Cordis context surface this plugin uses. */
interface DshContext {
  /**
   * Legacy session-start event. Present on DeepSeek Harness 0.1.x, ABSENT from 0.2.x — binding a
   * missing event is inert rather than an error, so it is kept for older hosts and paired with
   * `agent/created` below.
   */
  on(
    event: "agent/session-start",
    listener: (payload: { agent: DshAgent }) => void
  ): (() => void) | void;
  /**
   * The 0.2.x replacement for `agent/session-start`: an entered agent is ready for per-agent
   * initialization. `source` says why the session lifecycle began.
   *
   * `mode: serial` — listeners are AWAITED before creation resolves and AgentLoop holds queued
   * input until they finish ("A throw or rejection fails creation and skips later listeners"), so
   * this listener must return immediately and must never await a network round-trip.
   */
  on(
    event: "agent/created",
    listener: (payload: {
      agent: DshAgent;
      source: "startup" | "resume" | "clear" | "compact";
      signal?: AbortSignal;
    }) => undefined | Promise<undefined>
  ): (() => void) | void;
  on(
    event: "agent/pre-step",
    listener: (
      payload: PreStepPayload,
      next: () => Promise<PreStepDecision>
    ) => Promise<PreStepDecision>,
    options?: { prepend?: boolean }
  ): (() => void) | void;
  on(
    event: "agent/turn-stopping",
    listener: (payload: { agent: DshAgent }) => Promise<void> | void
  ): (() => void) | void;
  on(
    event: "agent/disposed",
    listener: (payload: { agent: DshAgent }) => void
  ): (() => void) | void;
  /**
   * The post-commit append feed, for EVERY session in the process. `compaction/*` are durable
   * session event types rather than Cordis events, so this is the only way to observe them — dsh's
   * own docs say to listen here and switch on `event.type`.
   *
   * A listener registered from the plugin's own context is untagged and therefore receives every
   * session, which is what one-process-many-workspaces requires.
   */
  on(
    event: "session/event",
    listener: (session: DshSession, event: DshSessionEvent) => void
  ): (() => void) | void;
  inject(names: string[], callback: (ctx: DshToolContext) => void): void;
  /**
   * Register a teardown that runs when this plugin unloads. Everything registered through `ctx` is
   * disposed automatically, so this exists only for work the framework cannot know about — an
   * in-flight network write-back, which nothing else would ever wait for.
   */
  effect(callback: () => (() => void) | void): (() => void) | void;
}

interface DshToolContext {
  tools: {
    register(definition: unknown): void;
    /** Registry introspection; used only to log what the host ended up exposing. */
    schemas?(): { name: string }[];
  };
}

/** `exec` as a dsh tool body receives it (only the caller matters to us). */
interface DshToolRunContext {
  readonly agent?: DshAgent;
}

// ── per-workspace runtime cache ─────────────────────────────────────────────────

export interface Workspace {
  core: RuntimeCore;
  root: string;
  /** Started by the first SESSION in this repo, then shared by every later one. */
  seeded?: Promise<void>;
  tools?: ToolSpec[];
  /**
   * Watches this workspace's sessions for context compactions. Built with the workspace so it
   * carries THIS repo's bank config and retain stamp, not the launch directory's.
   */
  watcher?: CompactionWatcher;
  /**
   * Rehydration limits, resolved once from this workspace's bank config. Held here rather than read
   * off `core` per step because `agent/pre-step` is an awaited waterfall and nothing on it should
   * re-derive config.
   */
  rehydrate: RehydrateConfig;
  /**
   * Code-grounded facts, resolved once from this workspace's bank config. Off by default: it adds
   * an extraction per changed turn and changes what the bank contains.
   */
  codeFacts: { enabled: boolean; maxChars: number };
  /**
   * The user's `retainTags`/`retainMetadata` for one session, resolved against this workspace's bank.
   * A factory because those templates can name the session, and the two document types written
   * outside the ordinary write-back (compacted spans, code facts) are the ones that used to miss the
   * user's provenance entirely.
   */
  stampFor: (sessionId: string) => RetainStamp;
}

/** `null` caches "memory is off for this repo" so a disabled bank isn't re-derived every turn. */
const workspaces = new Map<string, Workspace | null>();
/**
 * sessionId -> agent, so a core's transcript source (which only receives the id) can read the live
 * log back on stop. `agent/disposed` is what bounds it: an agent holds its whole session log, so
 * dropping the entry when the host disposes the agent is what keeps a long-lived Web server from
 * pinning every session it ever opened.
 */
const liveAgents = new Map<string, DshAgent>();
/**
 * Which sessions have had their one `seedFromLog` pass. Guards against the double bind below
 * (`agent/session-start` AND `agent/created` both firing on hosts that carry both events): the
 * by-key span dedupe keeps a second pass HARMLESS, but it is a full scan of a resumed session's
 * log for nothing. Dropped on disposal like every other per-session map.
 */
const sessionStarted = new Set<string>();
/**
 * sessionId -> the watcher that owns its compaction ledger.
 *
 * `session/event` fires for EVERY session in the process, including ones this plugin does not
 * track, so the handler needs an O(1) "do I care about this session" test that does not touch the
 * filesystem or derive a bank. This map is that test: it is populated when a session is entered
 * (when the workspace is already being resolved for other reasons) and dropped on disposal.
 *
 * A session that is absent is simply not tracked — a subagent, or a repo where memory is off — and
 * its events are ignored, which is the correct outcome rather than a miss.
 */
const sessionWatchers = new Map<string, CompactionWatcher>();

/**
 * The host's OWN configuration layer, when the host owns an in-app settings surface.
 *
 * `undefined` for the packaged plugin, which reads `~/.hindsight/coding-agent.json` — the file every
 * other Hindsight harness shares. A host that renders its own page (the standalone dsh plugin)
 * registers a thunk here instead, so the values the user just saved are the values this runtime
 * uses, and the config file stays the fallback for every field the page does not name.
 *
 * A thunk and not a value: a volatile settings write updates the running fiber's config references
 * in place, so a snapshot captured once at load would answer with the value from before the edit.
 */
let runtimeOverrides: (() => RawConfig | undefined) | undefined;

/**
 * Install (or clear) the host-owned configuration layer, dropping every cached workspace so the next
 * event re-derives against the new values.
 *
 * Cached workspaces are keyed by repo and close over their `Config`, so a setting that changes an
 * endpoint, a bank, or the opt-out cannot reach a workspace that already exists. Each one is flushed
 * before it is forgotten: `agent/disposed` looks its workspace up by root, and one dropped here would
 * never be drained by that path.
 *
 * @param source - returns the host's layer, or `undefined` to fall back to file + environment.
 */
export function setRuntimeConfigSource(source: (() => RawConfig | undefined) | undefined): void {
  runtimeOverrides = source;
  for (const workspace of workspaces.values()) void workspace?.core.flush();
  workspaces.clear();
}


/**
 * Prefer `session.snapshotEvents()` (DeepSeek Harness alpha.4+); fall back to the legacy
 * `session.events` property so older hosts keep working. Missing both yields an empty log —
 * which is exactly the alpha.4 breakage when callers still read `events` alone.
 */
export function dshSessionEvents(
  session: Pick<DshSession, "snapshotEvents" | "events">
): readonly DshSessionEvent[] {
  return session.snapshotEvents?.() ?? session.events ?? [];
}

/** Where a session is working. dsh records it on the session header; a session without one is rare. */
function workspaceRoot(agent: DshAgent): string {
  return agent.session.header.cwd || process.cwd();
}

/**
 * The memory runtime for one workspace root, built on first use.
 *
 * Bank derivation and the per-bank opt-out live here rather than in `apply`, because the plugin
 * loads before any session exists and the process may end up serving several unrelated
 * repositories. Building one has NO side effect: the seed is started by `ensureSeeded` when a
 * session actually opens, so merely registering the tools never seeds the launch directory.
 */
function workspaceFor(root: string): Workspace | undefined {
  const cached = workspaces.get(root);
  if (cached !== undefined) return cached ?? undefined;

  // One shared builder for every long-lived host (core/host-client.ts): the global switch, the
  // per-bank opt-out and `optInOnly` all land in `cfg.disabled`.
  const { cfg, bankId, client } = resolveHostMemory(HARNESS, root, runtimeOverrides?.());
  if (cfg.disabled) {
    workspaces.set(root, null); // inert: same agent, no memory (baseline parity)
    return undefined;
  }
  // The 5th argument is this host's whole reason for existing here: RuntimeCore binds the
  // knowledge tools (and retain stamps) to the workspace it is given, and dsh's process cwd is the
  // launch directory, routinely a different repository from the session's.
  const core = new RuntimeCore(client, bankId, cfg, HARNESS, root);
  // The write-back path reads the log back off the live agent — dsh keeps the whole session in
  // memory, so unlike opencode there is nothing to refetch over HTTP.
  core.setTranscriptSource(async (sessionId) => {
    const agent = liveAgents.get(sessionId);
    // alpha.4+ removed Session.events; snapshotEvents() is the public accessor.
    return agent ? readDshEvents(dshSessionEvents(agent.session)) : [];
  });
  const stampFor = (sessionId: string): RetainStamp =>
    buildRetainStamp(cfg, { directory: root, harness: HARNESS, bankId, sessionId });
  const workspace: Workspace = {
    core,
    root,
    stampFor,
    rehydrate: {
      mode: cfg.rehydrateMode,
      maxChars: cfg.rehydrateMaxChars,
      sessionMaxChars: cfg.rehydrateSessionMaxChars,
      maxHandles: cfg.rehydrateMaxHandles,
    },
    codeFacts: { enabled: cfg.codeFactEnabled, maxChars: cfg.codeFactMaxChars },
  };
  // Compaction awareness is built WITH the workspace so it inherits this repo's bank and retain
  // stamp. It is created even when `compactionAware` is off — an inert watcher costs one map — so
  // the `session/event` path has no branch to get wrong.
  if (cfg.compactionAware) {
    workspace.watcher = createCompactionWatcher({
      harness: HARNESS,
      maxChars: cfg.compactionMaxChars,
      stampFor: (sessionId) => {
        const stamp = stampFor(sessionId);
        return { tags: stamp.tags, metadata: stamp.metadata };
      },
      retain: (request) => {
        if (!cfg.compactionRetain) return;
        core.retainDocument(request);
      },
      diag: (event, fields) => diag(HARNESS, event, fields),
    });
  }
  workspaces.set(root, workspace);
  return workspace;
}

/**
 * Start this repo's cold-check + background seed once.
 *
 * Fire-and-forget by design: `agent/session-start` is an emit that no extension point awaits, and
 * the Web UI must not wait on a network round-trip to open a session. Nothing the first prompt
 * needs comes from here — it builds its own knowledge preamble from that session's page list.
 */
function ensureSeeded(workspace: Workspace): void {
  workspace.seeded ??= workspace.core.seedIfCold(workspace.root);
}

function workspaceForAgent(agent: DshAgent): Workspace | undefined {
  // A subagent session is a child of a conversation we already track: injecting into it would pay
  // for a second recall per delegation, and retaining it would file a fragment of a session that
  // the parent already stores in full.
  if (agent.session.header.origin === "subagent") return undefined;
  return workspaceFor(workspaceRoot(agent));
}

// ── message helpers ─────────────────────────────────────────────────────────────

/**
 * The human text in this step's claimed batch.
 *
 * `agent/pre-step` fires before EVERY step, including tool continuations that claimed no new input,
 * and other plugins contribute their own context messages to the same batch (V3 hosts tag them
 * `kind: 'plugin'`, V4 hosts use a producer-owned kind such as `time-context`). Only a
 * `kind: 'user'` message is a prompt worth recalling on.
 */
function promptOf(messages: readonly DshUserMessage[]): string {
  return (messages || [])
    .filter((message) => message?.source?.kind === "user")
    .flatMap((message) => message.content || [])
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n")
    .trim();
}

/**
 * Build the injected memory message.
 *
 * `form: 'recall'` is dsh's own vocabulary for retrieved context, so its UI renders the block as
 * recalled material rather than as something the user typed. Session format V4 requires injected
 * messages to use a producer-owned source kind; `plugin:hindsight` is the canonical fallback name
 * for an unregistered plugin. The non-user source also keeps the block out of a write-back.
 */
function injectionMessage(text: string): DshUserMessage {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: `plugin:${HINDSIGHT_PLUGIN}`, form: "recall" },
  };
}

/**
 * Build the rehydration message.
 *
 * Same source and `form` as {@link injectionMessage}, so dsh renders it as recalled material and
 * the write-back skips it for the same reason. The extra wrapper is for the SECOND half of that
 * guard: a span's recovered text can itself contain a previously injected block, and
 * `stripInjectedMemory` needs a tag to remove (`REHYDRATION_TAG` is in its allow-list).
 */
function rehydrationMessage(text: string): DshUserMessage {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: `<${REHYDRATION_TAG}>\n${text}\n</${REHYDRATION_TAG}>` }],
    source: { kind: `plugin:${HINDSIGHT_PLUGIN}`, form: "recall" },
  };
}

// ── the lifecycle, testable without a dsh host ──────────────────────────────────

/**
 * sessionId -> how many code facts this PROCESS has written for it, used only for ATTRIBUTION (the
 * "after turn N" wording and the diag record). It is deliberately not the document identity any
 * more: a resumed session restarts this count, so using it in the id both duplicated unchanged
 * diffs and overwrote an earlier process's first document. Identity is the diff digest. Bounded by
 * `agent/disposed`, like every other per-session map here.
 */
const codeFactTurns = new Map<string, number>();

/**
 * Retain this turn's implemented changes, read from the working tree.
 *
 * The paths come from the session's own tool calls and are used only to NARROW the diff; `git diff`
 * decides what actually changed, so a path that was merely read contributes nothing. Never throws —
 * this runs at a turn boundary, and a repo without git or without commits is an ordinary state, not
 * an error.
 */
async function retainCodeFacts(
  workspace: Workspace,
  sessionId: string,
  agent: DshAgent
): Promise<void> {
  const turn = (codeFactTurns.get(sessionId) ?? 0) + 1;
  codeFactTurns.set(sessionId, turn);
  try {
    // Paths narrow the diff; git decides what actually changed. The watcher is the cheap source, but
    // code facts do not depend on compaction awareness being on — without a watcher the session log
    // answers instead, so the two settings stay independent.
    const named = workspace.watcher
      ? workspace.watcher.recentToolPaths(sessionId, 400)
      : touchedPathsFromEvents(dshSessionEvents(agent.session));
    const paths = sessionTouchedPaths(named);
    // No named file means no evidence that THIS session touched anything, and the reader would fall
    // back to the whole dirty worktree — attributing the user's or another tool's uncommitted work
    // to this conversation. A missing document is the honest outcome.
    if (!paths.length) {
      diag(HARNESS, "codefact_no_paths", { session: sessionId, turn });
      return;
    }
    const diff = await readWorkingTreeChange(workspace.root, paths, workspace.codeFacts.maxChars);
    if (!diff) return; // nothing changed this turn: no document, no extraction paid for
    const stamp = workspace.stampFor(sessionId);
    workspace.core.retainDocument(
      codeFactDocument({
        sessionId,
        turn,
        diff,
        paths,
        harness: HARNESS,
        baseTags: stamp.tags,
        baseMetadata: stamp.metadata,
      })
    );
    diag(HARNESS, "codefact_ok", {
      session: sessionId,
      turn,
      chars: diff.length,
      paths: paths.length,
    });
  } catch (e) {
    diag(HARNESS, "codefact_failed", { session: sessionId, error: describeError(e) });
  }
}

/**
 * The three lifecycle handlers, over an injectable workspace resolver. `apply` binds these to the
 * real Cordis events; the tests drive them with a stand-in agent and core.
 */
export function createDshHooks(resolve: (agent: DshAgent) => Workspace | undefined) {
  // sessionId -> the block last appended. dsh keeps every injected message in the history it sends,
  // so re-appending an unchanged block (the per-turn roster) only stacks identical copies (#5026).
  const lastInjected = new Map<string, string>();
  return {
    sessionStart({ agent, source }: { agent: DshAgent; source?: string }): void {
      const workspace = resolve(agent);
      if (!workspace) return;
      const sessionId = agent.session.header.id;
      liveAgents.set(sessionId, agent);
      // Claim this session's events for its workspace's watcher. Done here rather than in the
      // `session/event` handler because THIS is where the workspace is already resolved — the
      // handler runs on every append and must stay an O(1) map lookup.
      if (workspace.watcher) {
        sessionWatchers.set(sessionId, workspace.watcher);
        // A resumed session replays its log as a SEED and never re-emits it through
        // `session/event`, so everything before this process — including compactions that already
        // ran — would otherwise be invisible and unrecoverable. Seeding costs one pass over a log
        // this process already holds, and retains nothing (see `seedFromLog`).
        //
        // `sessionStarted` guards the DOUBLE BIND below: on a host that still fires 0.1's
        // `agent/session-start` AND 0.2's `agent/created`, the second firing used to run
        // seedFromLog again — by-key span dedupe kept it harmless, but a full log pass per
        // session per event is a real cost on long resumed sessions, and the legacy payload
        // carries no `source`, so a startup session was scanned too. The seed runs ONCE, and
        // the guard resets on `agent/disposed` like every other per-session map.
        if (source !== "startup" && sessionStarted.add(sessionId)) {
          workspace.watcher.seedFromLog(sessionId, dshSessionEvents(agent.session));
        }
      }
      ensureSeeded(workspace);
    },

    async preStep(
      { agent, signal }: PreStepPayload,
      next: () => Promise<PreStepDecision>
    ): Promise<PreStepDecision> {
      const decision = await next();
      if (decision.kind !== "enter" || signal.aborted) return decision;
      const workspace = resolve(agent);
      if (!workspace) return decision;
      const sessionId = agent.session.header.id;
      liveAgents.set(sessionId, agent);
      // A resumed session gets no `agent/session-start` in some compositions; seeding here too
      // keeps the cold-check exactly-once without depending on which events a host fired.
      ensureSeeded(workspace);
      if (workspace.watcher) sessionWatchers.set(sessionId, workspace.watcher);

      const messages = [...decision.messages];

      // Memory answers "what does the bank know about this STEP". It runs on every step, not only on
      // the ones carrying a prompt: the whole point of a bounded wait is that a synthesis which
      // missed it is delivered later, and a later step is where that happens — this same turn's tool
      // continuation, if it landed in between, or the next turn. A prompt-only gate left the late
      // answer with nowhere to go, because on a continuation the block is NOT already in the history
      // being sent (see core/auto-inject.ts).
      const prompt = promptOf(decision.messages);
      const injection = await workspace.core.stepContext(sessionId, prompt || undefined);
      if (injection.context) {
        const block = injection.context;
        if (block === lastInjected.get(sessionId)) {
          diag(HARNESS, "inject_unchanged", { session: sessionId });
        } else {
          lastInjected.set(sessionId, block);
          diag(HARNESS, "inject_ok", { session: sessionId, chars: block.length });
          messages.push(injectionMessage(block));
        }
      } else if (prompt) {
        // Only a step that carried a prompt is a TURN with no memory; saying it on every tool
        // continuation would turn one memory-less session into a page of noise.
        diag(HARNESS, "inject_empty", { session: sessionId });
      }

      // Compaction recovery is deliberately NOT gated on a prompt. The steps that most need a
      // detail the window dropped are the TOOL CONTINUATIONS — where `messages` is empty, and where
      // the prompt-only guard this replaces meant memory was never consulted at all.
      //
      // Everything it reads is already in memory: the ledger the watcher filled, and the paths of
      // the session's recent tool calls. Nothing in THIS block may go to the network, because
      // `agent/pre-step` is an awaited waterfall and every millisecond is on the user's critical
      // path — the memory call above is the one thing on this path that talks to a server, and it is
      // held to its own budgets for exactly that reason (see core/auto-inject.ts).
      // The relevance signal costs a backward scan of the session log, and only `auto` reads it —
      // the default `handle` mode names spans without judging relevance — so a step that cannot use
      // it does not compute it.
      const toolTargets =
        workspace.rehydrate.mode === "auto"
          ? workspace.watcher?.recentToolPaths(sessionId)
          : undefined;
      const recovery = planRehydration({
        ledger: workspace.watcher?.ledgerFor(sessionId),
        cfg: workspace.rehydrate,
        toolTargets,
      });
      if (recovery && workspace.watcher) {
        workspace.watcher.noteDelivered({
          sessionId,
          keys: recovery.keys,
          // Only recovered TEXT spends the context budget; a pointer costs nothing to keep.
          chars: recovery.kind === "span" ? recovery.text.length : 0,
          kind: recovery.kind,
        });
        diag(HARNESS, "rehydrate_ok", {
          session: sessionId,
          kind: recovery.kind,
          chars: recovery.text.length,
        });
        messages.push(rehydrationMessage(recovery.text));
      }

      return messages.length === decision.messages.length ? decision : { kind: "enter", messages };
    },

    /**
     * Fold one appended event into its session's watcher.
     *
     * This fires for EVERY session in the process and for every append, so it does exactly one
     * cheap thing first: look the session up. A session that is not in the map is one we do not
     * track — a subagent, or a repo where memory is off — and its events are dropped.
     */
    onSessionEvent(session: DshSession, event: DshSessionEvent): void {
      const sessionId = session.header?.id;
      if (!sessionId) return;
      const watcher = sessionWatchers.get(sessionId);
      if (!watcher) return;
      let log: Map<number, DshSessionEvent> | undefined;
      watcher.onSessionEvent({
        sessionId,
        event,
        // Only reached for a restored session's fork-inherited prefix, which dsh replays as a seed
        // and never re-emits here. Built lazily because the ordinary path never asks for it.
        inherited: (seq) => {
          log ??= new Map(
            dshSessionEvents(session)
              .filter((candidate) => typeof candidate.seq === "number")
              .map((candidate) => [candidate.seq as number, candidate])
          );
          return log.get(seq);
        },
      });
    },

    async turnStopping({ agent }: { agent: DshAgent }): Promise<void> {
      const workspace = resolve(agent);
      if (!workspace) return;
      const sessionId = agent.session.header.id;
      liveAgents.set(sessionId, agent);
      // The stop boundary is the only moment the completed exchange is readable, so this bypasses
      // the turn cadence exactly like the opencode idle path it shares (`onSessionIdle`).
      await workspace.core.onSessionIdle(sessionId);
      if (workspace.codeFacts.enabled) await retainCodeFacts(workspace, sessionId, agent);
    },

    disposed({ agent }: { agent: DshAgent }): void {
      const sessionId = agent.session.header.id;
      // Lookup-only, deliberately never `workspaceFor`: that would CONSTRUCT a RuntimeCore while an
      // agent is being torn down, just to flush it.
      const workspace = workspaces.get(workspaceRoot(agent));
      if (workspace) {
        // The LAST write-back, taken synchronously while the live log is still attached: a host
        // can fire `agent/disposed` while `agent/turn-stopping`'s async refetch is still in
        // flight, and that fetch comes back empty the moment disposal drops the live-agent entry
        // — the session's final exchange was lost to exactly that race. Snapshotting here and
        // handing it to `retainIfGrown` closes it: the dedupe gate makes whichever path lands
        // first the winner and the other a no-op, so there is no double-write either.
        try {
          workspace.core.retainIfGrown(sessionId, readDshEvents(dshSessionEvents(agent.session)), "dispose");
        } catch {
          /* a snapshot that cannot be read is the pre-existing behaviour: flush only */
        }
        // Drain this workspace's in-flight write-backs. `agent/disposed` fires "after driver
        // quiescence and scoped-registration unwind, but before session detachment", so the live log
        // our transcript source reads is still attached here — this boundary is the last one where a
        // drain can still see the session.
        void workspace.core.flush();
        // Drop this session's local state with it: the turn counter, the write-back cursor, and the
        // injector's per-session entry — including a synthesis still in flight, which settles into
        // the session cache rather than into a map for a session nobody will ask about again.
        workspace.core.disposeSession(sessionId);
        // Drop the ledger with the session. A resumed session rebuilds it from its own log, so
        // nothing is lost by forgetting it here, and a long-lived server does not pin the event
        // buffer of every session it ever opened.
        workspace.watcher?.forget(sessionId);
      }
      sessionWatchers.delete(sessionId);
      sessionStarted.delete(sessionId);
      codeFactTurns.delete(sessionId);
      liveAgents.delete(sessionId);
      lastInjected.delete(sessionId);
    },
  };
}

// ── native tools ────────────────────────────────────────────────────────────────

/**
 * Project one harness-agnostic ToolSpec's input onto the JSON Schema dsh's registry stores.
 *
 * dsh's own `defineTool` is a pure builder — it compiles this exact schema shape and wraps the
 * callbacks — and `ctx.tools.register` validates a definition structurally, not by module identity.
 * Building the schema here therefore keeps the plugin free of a `@deepseek-ai/dsh-tools` dependency
 * that pnpm would have to resolve inside the profile, at the cost of one small projection.
 *
 * Our specs state their input as a Zod raw shape (the MCP dialect every harness shares) and are
 * deliberately flat: required or optional strings. Optionality and the description are the only two
 * facts to carry across; a parameter that is ever anything but a string fails loudly here rather
 * than registering a mis-typed tool.
 */
export function toDshParameters(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(spec.inputSchema)) {
    const zod = schema as {
      def?: { type?: string; innerType?: { def?: { type?: string } } };
      description?: string;
      isOptional?: () => boolean;
    };
    // `.optional()` wraps the real type, so unwrap before checking it — otherwise every optional
    // parameter would pass the guard below whatever it actually holds.
    const inner = zod.def?.type === "optional" ? zod.def.innerType?.def?.type : zod.def?.type;
    if (inner !== undefined && inner !== "string") {
      throw new Error(
        `hindsight tool ${spec.name}: dsh projection supports string parameters only`
      );
    }
    properties[key] = {
      type: "string",
      ...(zod.description ? { description: zod.description } : {}),
    };
    if (typeof zod.isOptional !== "function" || !zod.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** The tool bodies return MCP-shaped results and never throw; dsh wants a value or a throw. */
async function runSpec(spec: ToolSpec, args: Record<string, unknown>): Promise<string> {
  const result = await spec.handler(args);
  const text = (result.content || []).map((block) => block.text).join("\n");
  // dsh normalizes a thrown tool body into an isError result with this message, which is exactly
  // what our isError:true means — mapping it any other way would report a failure as a success.
  if (result.isError) throw new Error(text || "hindsight tool failed");
  return text;
}

/**
 * The compaction-recovery tools, in dsh's own registry shape.
 *
 * Deliberately NOT built by the shared `knowledge-tools.ts` factory. They read a ledger only dsh
 * produces, so on the other harnesses that factory serves they would register tools that can never
 * return anything — and `toDshParameters`' string-only projection (see above) is the wrong
 * constraint for a schema written once, here. Every parameter is a string anyway.
 */
interface DshLocalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, string>, workspace: Workspace, sessionId: string): Promise<string>;
}

export function compactionToolDefinitions(): DshLocalTool[] {
  return [
    {
      name: "hindsight_list_compacted",
      description:
        "List the spans of THIS session that context compaction removed from your view, without " +
        "reading any of them. Each entry gives the span id, its size and the files it touched. " +
        "Call it when you need to know whether something was dropped before you tell the user a " +
        "detail is unavailable or re-decide something an earlier turn may have settled. Reading is " +
        "a separate, more expensive call: hindsight_read_compacted.",
      parameters: { type: "object", properties: {} },
      async run(_args, workspace, sessionId) {
        // "Nothing was compacted" and "nothing was TRACKED" are different claims, and only the first
        // is knowable. Reporting the second as the first told the model its history was complete
        // when tracking was simply off (or the process had restarted).
        if (!workspace.watcher) {
          return (
            "Compaction tracking is off for this workspace, so compacted spans are not recorded " +
            "here — do not read that as the history being complete."
          );
        }
        const ledger = workspace.watcher.ledgerFor(sessionId);
        if (!ledger?.spans.length) {
          return (
            "No compaction has been observed in this session since this process started, so there " +
            "is nothing to read back. A compaction that ran before this process started is not " +
            "tracked here."
          );
        }
        return ledger.spans
          .map((span) => {
            const readable = ledger.captures.has(span.key)
              ? "readable now"
              : "text not held in this process; may still be readable from the bank";
            const paths = span.paths?.length
              ? ` — touches ${span.paths.slice(0, 6).join(", ")}`
              : "";
            return `${span.key}: ${span.kind}, surface seqs ${span.start}..${span.end}, ${span.tokens} tokens, ${readable}${paths}`;
          })
          .join("\n");
      },
    },
    {
      name: "hindsight_read_compacted",
      description:
        "Read back the verbatim text of one compacted span, by the id hindsight_list_compacted " +
        "returned. Use it before re-deciding anything the span may already have settled, and " +
        "before asserting that a detail is gone — compaction removed it from your VIEW, not from " +
        "the record. Cheaper and more exact than searching: this returns the span itself.",
      parameters: {
        type: "object",
        properties: {
          span_id: {
            type: "string",
            description:
              "Span id from hindsight_list_compacted, e.g. a compaction id or `seq:123`.",
          },
        },
        required: ["span_id"],
      },
      async run(args, workspace, sessionId) {
        const spanId = (args.span_id ?? "").trim();
        if (!spanId) return "span_id is required — call hindsight_list_compacted for the ids.";
        const ledger = workspace.watcher?.ledgerFor(sessionId);
        const span = ledger?.spans.find((candidate) => candidate.key === spanId);
        // Local first: exact, instant, and it still answers when the bank is unreachable.
        const captured = ledger?.captures.get(spanId);
        if (span && captured) return renderSpanText(span, captured);
        // Durable second. A restart empties the in-memory log, and a span retained earlier in the
        // session is still addressable by the same deterministic document id. Rendered through the
        // shared `role: content` shape so the same span read two ways does not answer differently —
        // only the header differs, because the surface bounds are no longer known here.
        const text = await workspace.core.readDocument(spanDocumentId(sessionId, { key: spanId }));
        if (text) return renderStoredSpanText(spanId, text);
        return (
          `No compacted span ${spanId} in this session, and no retained copy in the bank. ` +
          "Call hindsight_list_compacted to see which ids exist."
        );
      },
    },
  ];
}

/**
 * Register the hindsight_* suite on `ctx.tools`.
 *
 * The dsh tools registry is host+per-scope layered, so a host-plane registration is visible to
 * every agent — including the Web surface's per-session agent presets. Each call resolves the bank
 * from the CALLING agent's workspace, because one process serves many repositories.
 */
function registerTools(toolCtx: DshToolContext, fallbackRoot: string): void {
  // The registry is populated at plugin load, before any session exists, so the NAMES and schemas
  // come from the launch directory's workspace and each call rebinds to its own caller's bank. The
  // one consequence: if memory is off for the launch directory specifically (a `banks.<id>`
  // opt-out) the tools are absent even for other repositories this process later serves.
  const template = workspaceFor(fallbackRoot);
  if (!template) return; // memory disabled where this process was launched
  for (const definition of compactionToolDefinitions()) {
    toolCtx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: { type: "string" },
        render: (_args: unknown, value: string) => [{ type: "text", text: value }],
      },
      async execute(args: Record<string, unknown>, exec: DshToolRunContext): Promise<string> {
        const workspace = exec?.agent ? workspaceForAgent(exec.agent) : undefined;
        const sessionId = exec?.agent?.session.header.id;
        if (!workspace || !sessionId) {
          return "Compaction recovery is unavailable for this session.";
        }
        return definition.run(
          Object.fromEntries(
            Object.entries(args ?? {}).map(([key, value]) => [key, String(value ?? "")])
          ),
          workspace,
          sessionId
        );
      },
    });
  }
  for (const spec of specsOf(template)) {
    toolCtx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: toDshParameters(spec),
      output: {
        schema: { type: "string" },
        render: (_args: unknown, value: string) => [{ type: "text", text: value }],
      },
      async execute(args: Record<string, unknown>, exec: DshToolRunContext): Promise<string> {
        // Bind to the caller's repository, not to whichever workspace happened to load first.
        const workspace = exec?.agent ? workspaceForAgent(exec.agent) : template;
        if (!workspace) return "Hindsight memory is disabled for this workspace.";
        const bound = specsOf(workspace).find((candidate) => candidate.name === spec.name);
        if (!bound) return `Hindsight tool ${spec.name} is unavailable.`;
        return runSpec(bound, args);
      },
    });
  }
  // Log what the HOST sees, not just what we handed it: a tool that registers cleanly but never
  // reaches a model is the failure mode worth catching, and this is the one line that shows it.
  const exposed = toolCtx.tools.schemas?.() ?? [];
  log.debug(HARNESS, "tools registered", {
    count: specsOf(template).length,
    hostCatalog: exposed.length,
    hindsight: exposed.filter((schema) => schema.name?.startsWith("hindsight_")).length,
  });
}

/** The tool specs for one workspace, built once (each closes over that bank's client and root). */
function specsOf(workspace: Workspace): ToolSpec[] {
  workspace.tools ??= workspace.core.toolSpecs();
  return workspace.tools;
}

// ── cordis entrypoint ───────────────────────────────────────────────────────────

/**
 * Bind the memory lifecycle for the lifetime of `ctx`. Every listener is fail-open: RuntimeCore
 * never throws, and a workspace we cannot resolve simply leaves that session unmemoried.
 */
export function apply(ctx: DshContext): void {
  const hooks = createDshHooks(workspaceForAgent);
  // `agent/session-start` is 0.1.x's event; 0.2.x replaced it with `agent/created` and the old name
  // is simply absent. Bind BOTH: subscribing to an event a host does not have is inert, whereas
  // missing the one it DOES have skips every session's warm-up silently — which is exactly what the
  // 0.1.x-only binding did on 0.2.x. Re-entering `sessionStart` is safe because each of its effects
  // is idempotent: `liveAgents.set`, `ensureSeeded`'s `??=`, and the watcher's by-key span check
  // (without which a second `seedFromLog` appended every span again).
  //
  // The wrapper matters for typing as well as intent: `agent/created` is `serial`, so its listener
  // is AWAITED before creation resolves, and it must return `undefined` rather than a value.
  // `sessionStart` never awaits anything, which is the property that keeps it safe here.
  ctx.on("agent/session-start", hooks.sessionStart);
  ctx.on("agent/created", (payload) => void hooks.sessionStart(payload));
  // `prepend: true` puts this listener outermost, so the injection is appended AFTER every other
  // contributor's messages — the memory block reads last, closest to the model's turn.
  ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
  ctx.on("agent/turn-stopping", hooks.turnStopping);
  ctx.on("agent/disposed", hooks.disposed);
  // The only way to see `compaction/*`: those are durable SESSION events, not Cordis events. An
  // untagged listener receives every session in the process, which is what one-process-many-repos
  // requires; `hooks.onSessionEvent` drops the ones this plugin does not track.
  ctx.on("session/event", hooks.onSessionEvent);
  // Plugin unload is this host's only real process-shutdown boundary. A persistent-plugin host has
  // no session-end hook to ride (the reason RuntimeCore has no client-side retain cadence), so
  // without this a write-back started moments before exit is simply lost — `flush` is the only
  // thing that ever waited for one.
  ctx.effect(() => () => {
    for (const workspace of workspaces.values()) void workspace?.core.flush();
  });
  // The tools registry is optional: a composition without it (a bare headless assembly) still gets
  // recall, injection and write-back.
  ctx.inject(["tools"], (toolCtx) => {
    registerTools(toolCtx, process.cwd());
  });
}

export default { name, inject, apply };
