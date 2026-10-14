/**
 * Code-grounded facts: what the session actually IMPLEMENTED, read from the working tree.
 *
 * The ordinary write-back records the CONVERSATION — what was asked, what was said, which files
 * were named. `transcript-dsh.ts` deliberately drops `tool/result`, so for the concrete content of a
 * change memory has only ever had the action line (`edit src/chat.ts`), never the change itself.
 * That is enough to recall that something happened and not enough to answer "what does this
 * actually do now", which is the question an agent asks before changing it.
 *
 * So this reads the SOURCE instead of the chat. The working tree is the one record that cannot be
 * paraphrased, mis-summarized, or compacted away.
 *
 * Deliberately diff-shaped rather than file-shaped: a whole file is mostly unchanged context that
 * costs extraction budget and dilutes the signal, while a diff is exactly the set of decisions the
 * session made. It is also naturally bounded — an unchanged file contributes nothing.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gitToplevel, gitWorkingDiff, untrackedDiff } from "./git";
import { toolCallPaths } from "./compaction-capture";
import type { DshSessionEvent } from "./transcript-dsh";

/** The retained document's records. Shaped for the Hindsight client by `dsh.ts`. */
export interface CodeFactDocument {
  documentId: string;
  content: string;
  context: string;
  tags: string[];
  metadata: Record<string, string>;
}

/**
 * Every path the session's tool calls named, deduplicated, newest first and capped.
 *
 * This is intentionally NOT filtered to write-like tool names. A heuristic over tool names would
 * have to guess whether `bash` edited something, and guessing wrong loses the change silently;
 * `git diff` already answers the question the heuristic was trying to approximate, because a path
 * that did not change contributes nothing to the diff. Passing everything and letting git decide is
 * both simpler and strictly more accurate.
 */
export function sessionTouchedPaths(paths: readonly string[], maxPaths = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= maxPaths) break;
  }
  return out;
}

/** Paths named by a log's tool calls — the input `sessionTouchedPaths` expects. */
export function touchedPathsFromEvents(events: readonly DshSessionEvent[] | undefined): string[] {
  const out: string[] = [];
  for (const event of events || []) {
    if (event?.type !== "tool/call") continue;
    out.push(...toolCallPaths(event));
  }
  return out;
}

/**
 * The retained document for one turn's code changes.
 *
 * `knowledge:code-fact` is what makes these separable from the user's own preferences, which the
 * extractor files under the SAME `world` fact type (see `FACT_KIND_FILTERS` in
 * `knowledge-tools.ts`). Without the tag there is no way to ask for "what the code does" without
 * also getting "how the user likes it done".
 */
export function codeFactDocument(input: {
  sessionId: string;
  turn: number;
  diff: string;
  paths: readonly string[];
  harness: string;
  baseTags?: readonly string[];
  baseMetadata?: Readonly<Record<string, string>>;
}): CodeFactDocument {
  // The id is a digest of the DIFF, not of the turn counter. Two properties fall out of that, both
  // of which the counter got wrong: the same uncommitted change retained again maps to the same
  // document (byte-identical content is a no-op server-side, so a long session stops re-extracting
  // near-identical diffs every turn), and a NEW process — which cannot know the previous one's
  // count — does not collide with and overwrite an earlier turn's document. The turn itself is
  // attribution, so it lives in `context`/`metadata` where it does not affect the digest.
  const digest = createHash("sha1").update(input.diff).digest("hex").slice(0, 12);
  const documentId = `codefact:${input.sessionId}:${digest}`;
  const pathList = input.paths.length ? input.paths.slice(0, 40).join(", ") : "(paths unknown)";
  return {
    documentId,
    content: `Uncommitted working-tree changes.\n\n\`\`\`diff\n${input.diff}\n\`\`\`\n`,
    context:
      `The code this session has actually written: the uncommitted working-tree diff after turn ` +
      `${input.turn}, covering ${pathList}. This is the implementation as it stands, not a ` +
      `description of it — use it as fact about what the code does now.`,
    tags: [
      ...new Set([
        ...(input.baseTags ?? []),
        "source:git",
        `harness:${input.harness}`,
        "knowledge:code-fact",
      ]),
    ],
    metadata: {
      ...input.baseMetadata,
      source: "git",
      session_id: input.sessionId,
      ref_id: documentId,
      turn: String(input.turn),
      paths: pathList,
    },
  };
}

/**
 * `realpath`, tolerating a path that no longer exists.
 *
 * Both sides of the containment test have to be spelled the same way or they never match: on macOS
 * `/var/folders/...` and git's `/private/var/folders/...` are the same directory, and a symlinked
 * workspace (`/home` → `/mnt/home`) is the same story on Linux. Without this, EVERY tool path looked
 * like it was outside the repository and the whole code fact silently vanished.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A named-but-deleted file: canonicalise the directory it lived in and keep its name.
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/**
 * Tool-call paths, narrowed to a pathspec list git accepts.
 *
 * Tool paths arrive verbatim and may be absolute, relative to the session's cwd, or point entirely
 * outside the repository. Every one of those cases used to be dangerous: an out-of-repo path makes
 * `git diff -- <path>` exit 128, which failed BOTH attempts and silently dropped the whole turn's
 * code fact, and a path that merely resolved elsewhere contributed nothing while looking like it
 * had been considered. Resolving against the repo root and keeping only paths under the worktree
 * turns "N paths" into a list that can only narrow the diff.
 */
export function repoTouchedPaths(
  repoRoot: string,
  toplevel: string,
  paths: readonly string[],
  maxPaths = 40
): string[] {
  const root = canonical(toplevel);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const absolute = canonical(isAbsolute(path) ? path : resolve(repoRoot, path));
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue; // outside this worktree
    const normalized = rel.split("\\").join("/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxPaths) break;
  }
  return out;
}

/**
 * The uncommitted change this session made, or undefined when there is nothing to record.
 *
 * Both halves of the working tree are read: tracked changes through `git diff HEAD` (staged and
 * unstaged alike) and NEW FILES through `untrackedDiff`, because a session that only adds files is
 * invisible to the first.
 */
export async function readWorkingTreeChange(
  repoRoot: string,
  paths: readonly string[],
  maxChars: number
): Promise<string | undefined> {
  const toplevel = await gitToplevel(repoRoot);
  if (!toplevel) return undefined;
  const scoped = repoTouchedPaths(repoRoot, toplevel, paths);
  if (!scoped.length) return undefined;
  const tracked = await gitWorkingDiff(toplevel, scoped, maxChars);
  const untracked = await untrackedDiff(toplevel, scoped, maxChars - (tracked?.length ?? 0));
  const combined = [tracked, untracked].filter(Boolean).join("\n\n");
  return combined || undefined;
}
