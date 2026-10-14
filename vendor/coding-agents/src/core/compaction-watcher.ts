/**
 * Watching one dsh process for compactions, and keeping what they removed recoverable.
 *
 * ONE PROCESS SERVES MANY SESSIONS, so this is keyed by session id throughout, exactly like the
 * per-workspace RuntimeCore cache in `dsh.ts`. It is a separate module because it needs no host:
 * `onSessionEvent` takes the session id and the event, and a `retain` callback is injected. That is
 * what lets the whole feature be tested against a fake log instead of a running dsh.
 *
 * ── Why a buffer, when the session log is already readable ──────────────────────────────────────
 *
 * `Session.eventAt(seq)` (the legacy indexer) or `snapshotEvents()` (the current public accessor)
 * would answer most questions here — but only by reaching back into a live session on every lookup,
 * and `captureSpan` is deliberately a pure function over a lookup so it can be tested against a fake
 * log. Keeping the events this process saw appended in an array is what preserves that: it holds
 * REFERENCES, not copies, and the events are deep-frozen and immutable, so the cost is one pointer
 * per event.
 *
 * That array is indexed by `event.seq`, which is exactly what the log is: dsh assigns
 * `seq: SessionSeq(this.log.length)` at append time, so seq IS the array index. A restored session
 * never re-emits its inherited prefix through `session/event`, so the caller may pass an
 * `inherited` lookup for seqs this process never saw; that is the only path back to the host, and it
 * is optional so an older host degrades to "spans overlapping the prefix are not capturable".
 */
import { captureSpan, spanDocument, toolCallPaths, type CapturedSpan } from "./compaction-capture";
import { spanFromEvent, type ShadowSpan } from "./compaction-ledger";
import type { DshSessionEvent } from "./transcript-dsh";

/** One span's retained form, already shaped for the Hindsight client. */
export interface SpanRetainRequest {
  documentId: string;
  content: string;
  context: string;
  tags: string[];
  metadata: Record<string, string>;
}

/** Everything the watcher knows about one session, and the delivery budget it has spent. */
export interface SessionLedger {
  /** Compactions this session has undergone, in order. */
  spans: ShadowSpan[];
  /** Span key -> its recovered text, for rehydration that needs no network round-trip. */
  captures: Map<string, CapturedSpan>;
  /**
   * Span keys a handle has already NAMED. Kept separate from `delivered` on purpose: naming a span
   * must not burn the chance to inject its text later, or a session that was told "this exists,
   * here is how to read it" could never be shown the text even when the relevant step arrived.
   */
  announced: Set<string>;
  /** Span keys whose TEXT has been injected, so an `auto` block is never repeated. */
  delivered: Set<string>;
  /** Characters of span text already injected this session — the context-growth budget. */
  deliveredChars: number;
  /** How many handle notes this session has been given (they accumulate in history forever). */
  handles: number;
}

export interface CompactionWatcherOptions {
  /**
   * Retain one captured span into the bank. Called at most once per span and never awaited — a
   * compaction must not be delayed by a network write-back. The caller owns the in-flight set that
   * a host flush drains. The session is already named by the request (`documentId`, `metadata`), so
   * it is not passed twice.
   */
  retain: (request: SpanRetainRequest) => void;
  /** Character budget for one retained span document. */
  maxChars: number;
  /**
   * The user's configured provenance for one session (`retainTags`/`retainMetadata`, resolved by
   * `buildRetainStamp`). A factory rather than a plain pair because those templates can name the
   * session, and this watcher is the only writer that knows which session a span came from.
   */
  stampFor?: (sessionId: string) => {
    tags: readonly string[];
    metadata: Readonly<Record<string, string>>;
  };
  harness: string;
  /** Diagnostics sink. Kept injectable so this module never imports the log directly. */
  diag?: (event: string, fields: Record<string, unknown>) => void;
}

export interface SessionEventInput {
  sessionId: string;
  event: DshSessionEvent;
  /**
   * Seq -> event for anything this process did not see appended: a restored session's inherited
   * prefix. Consulted only when the buffer misses, so the common path never leaves the process.
   */
  inherited?: (seq: number) => DshSessionEvent | undefined;
  /**
   * Whether a span found on this event should be retained. Only `seedFromLog` passes `false`: those
   * spans were retained by the process that witnessed them, and retaining them again would mint a
   * duplicate document for one compaction.
   */
  retain?: boolean;
}

export interface CompactionWatcher {
  /** Fold one appended session event into the watcher's state. Never throws. */
  onSessionEvent(input: SessionEventInput): void;
  /**
   * Fold a session's EXISTING log in without retaining anything.
   *
   * A resumed session replays its log as a seed and never re-emits it through `session/event`, so
   * everything that happened before this process — including compactions that already ran — is
   * otherwise invisible. Seeding it gives a resumed session the same ledger, the same recoverable
   * spans and the same tool-path history a live one has, at the cost of one pass over its log.
   *
   * Tail-biased when the log exceeds `maxEvents`: a session long enough to be capped is one whose
   * recent end is what it is about to work from.
   */
  seedFromLog(sessionId: string, events: readonly DshSessionEvent[], maxEvents?: number): void;
  ledgerFor(sessionId: string): SessionLedger | undefined;
  /**
   * File paths named by the session's most recent tool calls, newest first.
   *
   * This is the relevance signal for rehydration, and it has to come from the log rather than from
   * the step's own messages: the steps that most need a compacted detail are the TOOL
   * CONTINUATIONS, where dsh hands `agent/pre-step` no new messages at all — the tool calls that
   * identify the work are already in the log behind us.
   */
  recentToolPaths(sessionId: string, limit?: number): string[];
  /** Record an injected block against the session's dedupe set and character budget. */
  noteDelivered(input: {
    sessionId: string;
    keys: readonly string[];
    chars: number;
    kind: "handle" | "span";
  }): void;
  /** Drop one session's state. Called when the host disposes its agent. */
  forget(sessionId: string): void;
}

/** The retained document's id — deterministic, so rehydration can address it without a search. */
export function spanDocumentId(sessionId: string, span: { key: string }): string {
  return `compaction:${sessionId}:${span.key}`;
}

/**
 * The retain request for one captured span.
 *
 * Split out as a pure function so the shape can be asserted without a client. Two decisions are
 * load-bearing and easy to undo by accident:
 *
 *   - the compaction marker lives in `context`, NOT `metadata`, because recall and knowledge-page
 *     synthesis read `context` and STRIP `metadata` (`_UNREAD_RESULT_FIELDS`).
 *   - the host's own `summary` also goes in `context` rather than into `content`: it is what the
 *     compaction wrote INSTEAD of the span, so filing it as span text would claim the model said it.
 */
export function spanRetainRequest(
  sessionId: string,
  span: ShadowSpan,
  captured: CapturedSpan,
  document: string,
  opts: Pick<CompactionWatcherOptions, "harness"> & {
    baseTags?: readonly string[];
    baseMetadata?: Readonly<Record<string, string>>;
    /** The document hit its character budget, so the span is not fully represented. */
    truncated?: boolean;
  }
): SpanRetainRequest {
  const documentId = spanDocumentId(sessionId, span);
  const summary = span.summary ? ` The compaction replaced it with: ${span.summary}` : "";
  const cut = opts.truncated
    ? " The recovered text was truncated to the document budget; read the source for the rest."
    : "";
  return {
    documentId,
    content: document,
    context:
      `A span of an agent session that context compaction removed from the model's view, retained ` +
      `so the detail survives it. Session ${sessionId}, surface seqs [${span.start}..${span.end}], ` +
      `${span.kind}, ${span.tokens} tokens. [[compaction:${span.key}]]${summary}${cut}`,
    tags: [
      ...new Set([
        ...(opts.baseTags ?? []),
        "source:chat",
        `harness:${opts.harness}`,
        "knowledge:compacted-span",
      ]),
    ],
    metadata: {
      ...opts.baseMetadata,
      source: "chat",
      session_id: sessionId,
      ref_id: documentId,
      shadowed_start: String(span.start),
      shadowed_end: String(span.end),
      shadowed_tokens: String(span.tokens),
      ...(span.compactionId ? { compaction_id: span.compactionId } : {}),
      ...(span.turn === null ? {} : { turn: String(span.turn) }),
    },
  };
}

export function createCompactionWatcher(opts: CompactionWatcherOptions): CompactionWatcher {
  /** sessionId -> the session's log as far as this process has seen it, indexed by seq. */
  const buffers = new Map<string, (DshSessionEvent | undefined)[]>();
  const ledgers = new Map<string, SessionLedger>();
  /**
   * sessionId -> compactionId -> the turn that opened it.
   *
   * `compaction/summary` and `compaction/prune` do NOT carry the owning turn; `compaction/start`
   * does and always precedes them. Kept outside {@link SessionLedger} so that stays the shape the
   * rehydration planner consumes.
   */
  const openerTurns = new Map<string, Map<string, number>>();

  const diag = opts.diag ?? (() => {});
  const ledgerOf = (sessionId: string): SessionLedger => {
    const existing = ledgers.get(sessionId);
    if (existing) return existing;
    const created: SessionLedger = {
      spans: [],
      captures: new Map(),
      announced: new Set(),
      delivered: new Set(),
      deliveredChars: 0,
      handles: 0,
    };
    ledgers.set(sessionId, created);
    return created;
  };

  const append = ({ sessionId, event, inherited, retain = true }: SessionEventInput): void => {
    // Fail-open by construction: this runs inside the host's append path, where a throw would
    // surface as a session error. Nothing below is allowed to escape.
    if (!event || typeof event !== "object") return;

    const buffer = buffers.get(sessionId) ?? [];
    buffers.set(sessionId, buffer);
    // `event.seq` is the log index (see the module comment). An event without one predates the
    // accessor or is malformed; it is kept out of the buffer because nothing can address it.
    if (typeof event.seq === "number" && event.seq >= 0) buffer[event.seq] = event;

    // The owner turn lives on the START of a compaction, not on its summary/prune — see the payload
    // note in compaction-ledger.ts. Remember it before any span is built from the later events.
    if (event.type === "compaction/start") {
      const start = event.data as { compactionId?: unknown; turn?: unknown } | undefined;
      if (typeof start?.compactionId === "string" && typeof start.turn === "number") {
        const turns = openerTurns.get(sessionId) ?? new Map<string, number>();
        turns.set(start.compactionId, start.turn);
        openerTurns.set(sessionId, turns);
      }
    }

    const span = spanFromEvent(event);
    if (!span) return;
    if (span.turn === null && span.compactionId) {
      const opened = openerTurns.get(sessionId)?.get(span.compactionId);
      if (opened !== undefined) span.turn = opened;
    }

    const ledger = ledgerOf(sessionId);
    // Idempotent by span key. `sessionStart` can run twice for one session (a host firing both
    // `agent/session-start` and `agent/created`), and a resumed session replays its log as a seed;
    // without this check every replay appends the same span again and the model is shown it twice.
    if (ledger.spans.some((known) => known.key === span.key)) return;

    const captured = captureSpan(span, (seq) => buffer[seq] ?? inherited?.(seq));

    if (!captured || !captured.turns.length) {
      // Legal degradation, not an error: the span is still recorded so a handle can point at it,
      // it just has no recoverable text. This is what a span overlapping a restored session's
      // inherited prefix looks like when the host offers no `inherited` lookup.
      ledger.spans.push(span);
      diag("compaction_uncaptured", {
        session: sessionId,
        key: span.key,
        seqs: span.seqs.length,
      });
      return;
    }

    span.paths = captured.paths;
    ledger.spans.push(span);
    ledger.captures.set(span.key, captured);
    if (!retain) return; // seeded history: already retained by the process that saw it live

    const stamp = opts.stampFor?.(sessionId);
    const document = spanDocument(spanDocumentId(sessionId, span), captured, opts.maxChars);
    opts.retain(
      spanRetainRequest(sessionId, span, captured, document.text, {
        harness: opts.harness,
        baseTags: stamp?.tags,
        baseMetadata: stamp?.metadata,
        truncated: document.truncated,
      })
    );
    diag("compaction_captured", {
      session: sessionId,
      key: span.key,
      seqs: span.seqs.length,
      turns: captured.turns.length,
      tokens: span.tokens,
    });
  };

  return {
    onSessionEvent: append,

    seedFromLog(sessionId: string, events: readonly DshSessionEvent[], maxEvents = 20_000): void {
      const log = events || [];
      const from = Math.max(0, log.length - maxEvents);
      for (let index = from; index < log.length; index++) {
        append({ sessionId, event: log[index], retain: false });
      }
    },

    ledgerFor(sessionId: string): SessionLedger | undefined {
      return ledgers.get(sessionId);
    },

    recentToolPaths(sessionId: string, limit = 40): string[] {
      const buffer = buffers.get(sessionId);
      if (!buffer?.length) return [];
      const out: string[] = [];
      const seen = new Set<string>();
      let scanned = 0;
      for (let seq = buffer.length - 1; seq >= 0 && scanned < limit; seq--) {
        const event = buffer[seq];
        if (!event || event.type !== "tool/call") continue;
        scanned++;
        for (const path of toolCallPaths(event)) {
          if (seen.has(path)) continue;
          seen.add(path);
          out.push(path);
        }
      }
      return out;
    },

    noteDelivered({ sessionId, keys, chars, kind }): void {
      const ledger = ledgerOf(sessionId);
      if (kind === "handle") {
        // A handle only NAMES a span; the chance to inject its text survives.
        for (const key of keys) ledger.announced.add(key);
        ledger.handles += 1;
        return;
      }
      for (const key of keys) {
        ledger.delivered.add(key);
        ledger.announced.add(key);
      }
      ledger.deliveredChars += chars;
    },

    forget(sessionId: string): void {
      buffers.delete(sessionId);
      ledgers.delete(sessionId);
      openerTurns.delete(sessionId);
    },
  };
}
