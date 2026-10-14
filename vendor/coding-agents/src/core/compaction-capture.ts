/**
 * Reading a compacted span back out of the session log.
 *
 * Compaction replaces a span of the model's SURFACE but never rewrites the LOG, so the text is
 * still there — provided something can resolve the seqs the compaction named. This module is that
 * resolution, expressed as a lookup function rather than a session object so it can run against
 * either source:
 *
 *   - the watch buffer (`createCompactionWatcher`), which holds the events this process saw appended
 *   - `session.snapshotEvents()`, for the fork-inherited prefix a restored session never re-emits
 *
 * It deliberately never touches the host itself. Callers pass the lookup, which is what keeps this
 * unit-testable without a dsh process and keeps the async host surface out of a pure function.
 */
import { renderSessionJsonl, type TransportTurn } from "./chat";
import type { ShadowSpan } from "./compaction-ledger";
import { readDshEvents, type DshSessionEvent } from "./transcript-dsh";
import { pathsFromToolArgs } from "./transcript-util";

/** A span's reusable content: the normalized turns, and the files it mentions. */
export interface CapturedSpan {
  turns: TransportTurn[];
  /** Absolute-looking file paths the span's tool calls named, deduplicated, in first-seen order. */
  paths: string[];
}

export interface CaptureOptions {
  /**
   * The share of `span.seqs` that must resolve before the capture is worth keeping. Below it the
   * span is reported as uncapturable, and the caller degrades to a handle with no text: a partial
   * transcript would read as the whole span while silently missing the part that mattered.
   */
  minResolvedRatio?: number;
}

/** `tool/call.arguments` is the model's RAW JSON string, unparsed by design (see transcript-dsh). */
export function toolCallPaths(event: DshSessionEvent): string[] {
  if (event.type !== "tool/call") return [];
  const args = (event.data as { arguments?: unknown } | undefined)?.arguments;
  // A non-string is already a structured value (a fixture, or a host that parsed it for us).
  if (typeof args !== "string") return pathsFromToolArgs(args);
  try {
    return pathsFromToolArgs(JSON.parse(args));
  } catch {
    // `arguments` is JSON by contract, so a parse failure means this call's target is UNKNOWN — it
    // does not mean the raw text is a path. Reading it as a bare path would file a fragment like
    // "{oops" as a filename and let a garbage token drive relevance matching.
    return [];
  }
}

/**
 * Resolve a span's events and normalize them, or `undefined` when too few seqs resolve.
 *
 * Normalization goes through the SAME `readDshEvents` the ordinary write-back uses, so a rehydrated
 * span reads exactly like the transcript it was cut from — including the `source.kind === 'user'`
 * filter that keeps plugin-injected context out of memory.
 */
export function captureSpan(
  span: ShadowSpan,
  lookup: (seq: number) => DshSessionEvent | undefined,
  opts: CaptureOptions = {}
): CapturedSpan | undefined {
  if (!span.seqs.length) return undefined;
  const events: DshSessionEvent[] = [];
  for (const seq of span.seqs) {
    const event = lookup(seq);
    if (event) events.push(event);
  }
  const ratio = events.length / span.seqs.length;
  if (ratio < (opts.minResolvedRatio ?? 0.5)) return undefined;

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const path of toolCallPaths(event)) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return { turns: readDshEvents(events), paths };
}

/**
 * The retained document body: the span as the same JSONL transcript every other write-back uses,
 * under a REF-ID that names the compaction rather than the session.
 *
 * Reusing the transcript shape is not cosmetic — the server's structured chunker treats one line as
 * one atomic unit, and a document whose lines look like every other conversation line is what lets
 * extraction, consolidation and knowledge pages treat a recovered span as ordinary history.
 *
 * That invariant is why truncation happens at a LINE boundary. Truncating the rendered string would
 * leave the last line half a JSON object, and the server's `_looks_like_jsonl` requires EVERY line to
 * parse — one torn line silently drops the whole document out of structured chunking. The cut is
 * reported back to the caller so it can say so in the document's `context` instead of writing a
 * marker into the content (a marker line would be a turn the model never said).
 */
export interface SpanDocument {
  text: string;
  truncated: boolean;
}

export function spanDocument(
  refId: string,
  captured: CapturedSpan,
  maxChars: number
): SpanDocument {
  const ts = new Date().toISOString();
  const lines = renderSessionJsonl(refId, captured.turns, ts).split("\n");
  const marker = JSON.stringify({
    role: "system",
    content: "… (truncated: this span exceeded the document budget)",
  });

  // The REF-ID line is kept unconditionally: it is the document's address, and a document whose
  // first line is the marker would not even say which span it is.
  const kept: string[] = lines.length ? [lines[0]] : [];
  let size = kept.length ? kept[0].length : 0;
  let truncated = false;
  for (const line of lines.slice(1)) {
    const next = size + 1 + line.length;
    if (next > maxChars) {
      truncated = true;
      break;
    }
    kept.push(line);
    size = next;
  }
  if (truncated) {
    // Make room for the marker so the document stays inside the budget AND stays valid JSONL.
    while (kept.length > 1 && size + 1 + marker.length > maxChars) {
      size -= kept.pop()!.length + 1;
    }
    kept.push(marker);
  }
  return { text: kept.join("\n"), truncated };
}
