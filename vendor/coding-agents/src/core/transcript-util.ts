/** Shared transcript-rendering helpers used by both the Claude (transcript.ts) and Codex
 *  (transcript-codex.ts) session readers. */

/** Cap on any single rendered tool input or tool result (mirrors v1's 2000-char cap): small
 *  edits/commands are captured verbatim while a giant Write/output is bounded. */
export const TOOL_TEXT_CAP = 2000;

/** Injected context — stripped from retained text so a write-back never re-ingests its own
 *  injected memory (a retain→reflect feedback loop). Covers every block the hooks inject, PLUS
 *  the host's own hook-transport wrappers, which arrive as ordinary USER messages and would
 *  otherwise be extracted as things the user said (#3023):
 *    <hook_prompt>        codex surfaces hook stdout/errors this way
 *    <task-notification>  Claude Code reports a background task's outcome — task id, tool-use id,
 *                         status; measured at 39 of these across 400 local transcripts, each one
 *                         the entire message
 *    <system-reminder>    same class; today it only rides inside `tool_result` blocks, which the
 *                         Claude reader already drops, so this is insurance against it moving
 *  Tag-structural, not content-guessing. The block is removed and any surrounding text KEPT — a
 *  message that is nothing but a wrapper then renders empty and is dropped as a no-content turn. */
const MEMORY_TAG_RE =
  /<(hook_prompt|task-notification|system-reminder|hindsight_memory|hindsight_memories|hindsight_bank|relevant_memories|user_feedback|hindsight_knowledge|hindsight_knowledge_refresh|hindsight_compacted)\b[\s\S]*?<\/\1>/g;

export function stripInjectedMemory(s: string): string {
  return s.replace(MEMORY_TAG_RE, "");
}

export function truncate(s: string, max = TOOL_TEXT_CAP): string {
  return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
}

/** Keys tried, in order, to find a tool call's primary target for the compact action line. */
const TARGET_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "command",
  "pattern",
  "query",
  "url",
  "name",
  "id",
] as const;

const ACTION_TARGET_CAP = 100;

/**
 * Keys that name a FILE, as opposed to the other things a tool call targets (`command`, `pattern`,
 * `query`, `url`, `name`, `id` in {@link TARGET_KEYS}). Deliberately narrower than that list:
 * everything here decides whether a compacted span and the current step are about the same code, so
 * a command string or a search pattern matching by accident would make every span look relevant.
 */
const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "target_file",
  "absolute_path",
] as const;

/**
 * File paths named in a tool call's arguments.
 *
 * Values are returned verbatim — no normalisation, no existence check. The caller is comparing two
 * strings that came from the same agent working in the same tree, so exact equality is the right
 * test, and a filesystem probe would only add latency to a path that runs inside an awaited hook.
 */
export function pathsFromToolArgs(args: unknown): string[] {
  if (typeof args === "string") {
    // Some tools take a bare path rather than an object; a single-line string is the best reading.
    const line = args.trim().split("\n")[0];
    return line ? [line] : [];
  }
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  return out;
}

/**
 * Compact one tool call into an action line: the tool name plus its primary target — a file path,
 * command, pattern, … — with NO full arguments and NO output (e.g. `Edit boltons/strutils.py`).
 * Retaining raw args/outputs buries the session's decisions in mechanical noise; the extractor only
 * needs WHAT was touched.
 */
export function actionLine(tool: string, input: unknown): string {
  let target = "";
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    for (const k of TARGET_KEYS) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) {
        target = v.trim().split("\n")[0];
        break;
      }
    }
  } else if (typeof input === "string") {
    target = input.trim().split("\n")[0];
  }
  if (target.length > ACTION_TARGET_CAP) target = `${target.slice(0, ACTION_TARGET_CAP)}…`;
  return target ? `${tool} ${target}` : tool;
}
