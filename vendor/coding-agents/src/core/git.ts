/**
 * Harness-agnostic git ingestion. Two paths:
 *  - `ingestGit`/`retainCommit`: per-commit, full message + full diff (opt-in, `--diffs`). Expensive
 *    (one extraction op per commit).
 *  - `ingestGitLog`/`gitLogText`: the last N commit MESSAGES ONLY, aggregated into ONE document
 *    (default). Cheap (one extraction op total).
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { projectNameOf } from "./bank";
import type { HindsightClient } from "./hindsight";
import type { RetainStamp } from "./retain-stamp";
import { pool } from "./util";

const US = "\x1f";
const RS = "\x1e"; // record separator between commits in gitLogText
const GITLOG_HEAD = "gitlog-head:"; // tag naming the commit the git-log document was written at

function git(repo: string, ...args: string[]): string {
  // `log.showSignature=true` in the user's config makes `git log`/`git show` print signature
  // checks to stdout ahead of the formatted output, which we parse as data (#5269).
  return execFileSync("git", ["-C", repo, "-c", "log.showSignature=false", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    windowsHide: true,
    // execFileSync otherwise forwards failed git stderr into the host's TUI,
    // even when callers catch the error. Keep diagnostics on the error instead.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const execFileAsync = promisify(execFile);

/**
 * Async twin of {@link git}, for the HOT path: code facts are read at `agent/turn-stopping`, which
 * the host AWAITS (it is a serial listener), so a synchronous subprocess here blocks the event loop
 * of a process that serves every session — including the Web UI. `execFileSync` is still what the
 * seed/backfill paths use, where nothing is waiting on a keystroke.
 */
async function gitAsync(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repo, "-c", "log.showSignature=false", ...args],
    { encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true }
  );
  return stdout;
}

/**
 * Like {@link gitAsync}, but tolerates a non-zero exit whose stdout is still the answer.
 *
 * `git diff --no-index` is the one call that needs this: it exits 1 to mean "these differ", which is
 * the normal, successful outcome for an untracked file.
 */
async function gitAsyncAllowingDiffExit(repo: string, ...args: string[]): Promise<string> {
  try {
    return await gitAsync(repo, ...args);
  } catch (e) {
    const stdout = (e as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout) return stdout;
    throw e;
  }
}

/** The worktree's top level, or null when `dir` is not inside a repository. */
export async function gitToplevel(dir: string): Promise<string | null> {
  try {
    return (await gitAsync(dir, "rev-parse", "--show-toplevel")).trim() || null;
  } catch {
    return null;
  }
}

/** The bank-facing name for a repo — WORKTREE-AWARE (all worktrees produce the main checkout's
 *  name, mirroring bank resolution) and path-spelling-proof ("." names the directory). Document
 *  ids derived from this must be identical from every worktree of the same repo. */
export function repoNameOf(repo: string): string {
  return projectNameOf(resolve(repo));
}

/** HEAD's sha, or null on any failure (empty repo, not a repo). */
export function gitHeadSha(dir: string): string | null {
  try {
    return git(dir, "rev-parse", "HEAD").trim() || null;
  } catch {
    return null;
  }
}

/**
 * The working tree's uncommitted changes, bounded — what a session has actually IMPLEMENTED but not
 * yet committed.
 *
 * `git diff HEAD` rather than bare `git diff`: HEAD covers staged and unstaged alike, so a change
 * does not vanish from the record the moment the agent stages it. A repo with no commits yet has no
 * HEAD, which is not an error — the fallback diffs the index instead.
 *
 * `paths` narrows the diff to files the session touched. It is a FILTER, not a claim: passing a path
 * that did not change simply contributes nothing, which is why callers can pass every path a tool
 * call named without first deciding which of them were writes.
 *
 * Returns undefined when nothing changed, when `git` is unavailable, or on any other failure —
 * never throws, because this runs inside a turn boundary.
 */
export async function gitWorkingDiff(
  repo: string,
  paths: readonly string[] = [],
  maxChars = 24_000
): Promise<string | undefined> {
  const tail = paths.length ? ["--", ...paths] : [];
  let out: string;
  try {
    out = await gitAsync(repo, "diff", "--no-color", "--unified=3", "HEAD", ...tail);
  } catch {
    try {
      out = await gitAsync(repo, "diff", "--no-color", "--unified=3", ...tail);
    } catch {
      return undefined;
    }
  }
  const text = out.trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

/**
 * The uncommitted content of files git does not track yet.
 *
 * `git diff HEAD` only ever reports TRACKED changes, so a session whose whole output is new files —
 * the commonest interesting case for a coding agent — produced no code fact at all. `--no-index`
 * against /dev/null renders an untracked file as a diff without touching the index (no `git add -N`,
 * which would mutate the user's staging area).
 */
export async function untrackedDiff(
  repo: string,
  paths: readonly string[] = [],
  maxChars = 24_000
): Promise<string | undefined> {
  if (maxChars <= 0) return undefined;
  const tail = paths.length ? ["--", ...paths] : [];
  let listed: string;
  try {
    listed = await gitAsync(repo, "ls-files", "--others", "--exclude-standard", ...tail);
  } catch {
    return undefined;
  }
  const files = listed.split("\n").map((f) => f.trim()).filter(Boolean);
  const parts: string[] = [];
  let size = 0;
  for (const file of files) {
    let part: string;
    try {
      part = (await gitAsyncAllowingDiffExit(
        repo,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-index",
        "--",
        "/dev/null",
        file
      )).trim();
    } catch {
      continue; // one unreadable file must not drop the rest
    }
    if (!part) continue;
    if (size + part.length > maxChars) {
      const room = maxChars - size;
      if (room > 0) parts.push(`${part.slice(0, room)}\n… (truncated)`);
      break;
    }
    parts.push(part);
    size += part.length + 2;
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * Count commits reachable from HEAD but NOT from `sinceSha` (`git rev-list --count sinceSha..HEAD`).
 * Branch-robust "new commits since a baseline": counts what's reachable from wherever HEAD is now, so
 * switching to a behind-branch yields 0 and a feature branch counts only its own new commits. Returns
 * null when `sinceSha` is unknown to the repo (rebased/gc'd/foreign) or on any git error — the caller
 * treats null as "not a reachable baseline" rather than "0 new".
 *
 * `sinceSha` is read back from the bank (survey-baseline document ids, the git-log document's
 * gitlog-head tag), so only a full object name reaches git: `git rev-list` parses an argument that
 * starts with "-" as an option, and `--output=<path>..HEAD` creates that file before failing.
 */
export function commitsSince(dir: string, sinceSha: string): number | null {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sinceSha)) return null;
  try {
    const n = Number.parseInt(git(dir, "rev-list", "--count", `${sinceSha}..HEAD`).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** True iff `dir` is a git repo with at least one commit. Fast (--max-count=1). False on non-git/empty/error. */
export function hasGitHistory(dir: string): boolean {
  try {
    return git(dir, "rev-list", "--max-count=1", "HEAD").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Retain ONE commit (full message + full diff) under the `git` strategy. The document_id is `git:<sha>`,
 * so a later run (or the live git-sync) can tell what's already ingested and stays idempotent. Shared by
 * both the backfill and the incremental sync so the encoding is identical across the two entry points.
 */
export async function retainCommit(
  client: HindsightClient,
  repo: string,
  sha: string,
  repoName: string,
  stamp?: RetainStamp
): Promise<void> {
  const [h, an, ae, aISO, cISO, subj, body] = git(
    repo,
    "show",
    "-s",
    `--format=%H${US}%an${US}%ae${US}%aI${US}%cI${US}%s${US}%b`,
    sha
  ).split(US);
  const msg = (subj + (body?.trim() ? "\n\n" + body.trim() : "")).trim();
  const diff = git(repo, "show", "--format=", sha); // FULL diff, uncapped
  const content =
    `REF-ID: git:${sha.slice(0, 12)}\n` +
    `Git commit ${sha.slice(0, 12)} in the ${repoName} repository (${an}, ${aISO}).\n\n` +
    `Message:\n${msg}\n\nDiff:\n${diff}`;
  await client.retain(
    content,
    `git commit in ${repoName}`,
    `git:${sha}`,
    [...new Set([...(stamp?.tags ?? []), "source:git"])],
    "git",
    {
      timestamp: aISO, // the memory's timestamp is the commit's author date
      metadata: {
        ...stamp?.metadata,
        source: "git",
        repo: repoName,
        commit: h,
        short_sha: sha.slice(0, 12),
        author: an,
        author_email: ae,
        authored_at: aISO,
        committed_at: cISO,
        subject: subj,
      },
    }
  );
}

export async function ingestGit(
  client: HindsightClient,
  repo: string,
  opts: {
    limit?: number;
    concurrency?: number;
    log?: (m: string) => void;
    stampFor?: () => RetainStamp;
  } = {}
): Promise<number> {
  const log = opts.log ?? (() => {});
  // NEWEST-first: recent commits (the project's own decision commits) extract before the ancient
  // upstream noise, so the decisions that matter aren't starved at the tail of the extraction queue.
  let shas = git(repo, "rev-list", "HEAD").trim().split("\n").filter(Boolean);
  if (opts.limit) shas = shas.slice(0, opts.limit); // most recent N (validate the machine on a slice first)
  const repoName = repoNameOf(repo);
  log(`[git] ingesting ${shas.length} commits (full message + full diff, no filter) …`);
  let failures = 0;
  await pool(
    shas,
    opts.concurrency ?? 8,
    async (sha) => {
      await retainCommit(client, repo, sha, repoName, opts.stampFor?.());
    },
    (i, e) => {
      failures++;
      log(`  ! commit ${i} failed to enqueue: ${(e as Error).message?.slice(0, 120)}`);
    },
    (done) => {
      if (done % 25 === 0) log(`  ${done}/${shas.length}`);
    }
  );
  log(`[git] done: ${shas.length} commits ingested under strategy 'git'`);
  return failures;
}

/**
 * Up to the last `limit` commits as an aggregated MESSAGES-ONLY block (no diffs) — one record per
 * commit: "<shortsha> <date> <author>\n<subject>\n\n<body>", OLDEST first, separated by a divider
 * line. Thin wrapper over `git log`; empty repo (no commits) -> "".
 *
 * Built so a new commit only APPENDS to the previous text (#5003). The server's delta retain keeps
 * every chunk whose text is unchanged at the same index, so an append re-extracts only the tail.
 * This used to be the newest `limit` commits, newest first: every commit shifted the whole text,
 * no chunk survived, and the entire history was re-extracted and re-consolidated each time.
 * Flipping the order alone is not enough once the window is full — dropping the oldest commit
 * shifts the text again — so the window's START moves in fixed steps of half the limit (counted
 * from the root commit), and the document holds between limit/2 and `limit` commits. The history
 * is rewritten once per step instead of once per commit. Commits that land in the middle of the
 * date order (a merged branch, a rebase) still shift the text, which costs the full re-extraction
 * every commit used to.
 */
export function gitLogText(repo: string, limit: number): string {
  let raw: string;
  try {
    const total = Number(git(repo, "rev-list", "--count", "--no-merges", "HEAD").trim());
    const step = Math.max(1, Math.ceil(limit / 2));
    const start = total > limit ? Math.ceil((total - limit) / step) * step : 0;
    raw = git(
      repo,
      "log",
      `-n`,
      String(total - start),
      "--no-merges",
      "--reverse", // applied after -n: the newest N, printed oldest first
      "--date=short",
      `--format=%h${US}%ad${US}%an${US}%s${US}%b${RS}`
    );
  } catch {
    return ""; // no commits yet (or not a git repo) — caller handles empty
  }
  return raw
    .split(RS)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, author, subj, body] = rec.split(US);
      const header = `${sha} ${date} ${author}`;
      const msg = subj + (body?.trim() ? "\n\n" + body.trim() : "");
      return `${header}\n${msg}`;
    })
    .join("\n\n---\n\n");
}

/**
 * The author date (strict ISO 8601) of the newest commit `gitLogText` would include — i.e. the newest
 * non-merge commit reachable from HEAD, matching that function's traversal. This is the aggregated
 * document's temporal anchor: without it the retain API stamps "now" and the extraction prompt gets
 * `Event Date: Unknown`, so every extracted fact lands with a null occurred_start/occurred_end.
 * Null on an empty repo, a non-repo, or any git error — the caller then omits the timestamp.
 */
export function gitLogNewestAuthorDate(repo: string): string | null {
  try {
    return git(repo, "log", "-n", "1", "--no-merges", "--format=%aI").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ingest the aggregated commit-message history (last `opts.limit` commits, no diffs) as ONE document —
 * a single retain/extraction op, orders of magnitude cheaper than per-commit full-diff ingestion. The
 * document_id is `gitlog:<repoName>` so a re-seed replaces it (idempotent) rather than duplicating.
 * Tags keep `source:git` (alongside `source:git-log`) so the cold-repo check (`listDocumentIds("source:git")`)
 * still sees the bank as warm after a default (message-only) seed.
 */
export async function ingestGitLog(
  client: HindsightClient,
  repo: string,
  opts: { limit: number; log?: (m: string) => void; stampFor?: () => RetainStamp } = { limit: 300 }
): Promise<number> {
  const log = opts.log ?? (() => {});
  const text = gitLogText(repo, opts.limit);
  if (!text) {
    log("[gitlog] no commits found — skipping");
    return 0;
  }
  const repoName = repoNameOf(repo);
  const n = text.split("\n\n---\n\n").length;
  log(`[gitlog] ingesting last ${n} commit messages for ${repoName} as ONE document …`);
  try {
    // The gitlog-head:<sha> tag records the commit this document is written at: the deepen engine
    // re-upserts it (same id — replaces, never duplicates) only when HEAD has moved past that
    // commit (see gitLogIsCurrent).
    const head = gitHeadSha(repo);
    const stamp = opts.stampFor?.();
    const tags = [
      ...new Set([
        ...(stamp?.tags ?? []),
        "source:git",
        "source:git-log",
        ...(head ? [`${GITLOG_HEAD}${head}`] : []),
      ]),
    ];
    await client.retain(
      text,
      `git commit-message history (last ${n}) for ${repoName}`,
      `gitlog:${repoName}`,
      tags,
      "gitlog",
      {
        // Anchor the document in time on the newest commit it contains, so extraction can date the
        // facts it pulls out of these messages. Previously no timestamp was passed at all: retain
        // then stamped "now", the extraction prompt got `Event Date: Unknown`, and every fact landed
        // with a null occurred_start/occurred_end — invisible to temporal search (#3602).
        timestamp: gitLogNewestAuthorDate(repo) ?? undefined,
        // `retain` only sets metadata when it is truthy, so an empty stamp sends none.
        metadata: Object.keys(stamp?.metadata ?? {}).length ? stamp?.metadata : undefined,
      }
    );
    log(`[gitlog] done: ${n} commit messages ingested as 1 document under strategy 'gitlog'`);
    return 0;
  } catch (e) {
    log(`  ! gitlog ingest failed: ${(e as Error).message?.slice(0, 120)}`);
    return 1;
  }
}

/**
 * Whether this repository's canonical git-log document already reflects HEAD, so re-ingesting it
 * would add no commit it lacks. One tag query answers the usual case, a document written at HEAD.
 * Otherwise the document's gitlog-head tag names the commit it WAS written at, and it is still
 * current when HEAD is an ancestor of that commit (`commitsSince` counts 0): re-ingesting there
 * would only replace the log with an older one.
 *
 * The exact-HEAD query used to be the whole check. Every worktree of a repository writes the same
 * `gitlog:<repoName>` document, so returning to a worktree behind the last writer (A -> B -> A)
 * re-sent and re-extracted the whole log, although B's copy held every commit of A's (#4661). A HEAD
 * with a commit the document lacks (new work, a worktree that diverged) still reads as stale, and so
 * does a recorded commit this clone does not know (a same-named foreign repository, a rebase).
 * Server errors reject: the callers decide what an unreachable server means. `documentTags` is
 * optional so a client without it (SessionStart's minimal test clients) keeps the exact-HEAD check.
 */
export async function gitLogIsCurrent(
  client: Pick<HindsightClient, "listDocumentIds"> & Partial<Pick<HindsightClient, "documentTags">>,
  repo: string,
  head: string
): Promise<boolean> {
  const canonical = `gitlog:${repoNameOf(repo)}`;
  if ((await client.listDocumentIds(`${GITLOG_HEAD}${head}`, "all_strict")).has(canonical))
    return true;
  const tags = (await client.documentTags?.(canonical)) ?? [];
  return tags.some(
    (tag) => tag.startsWith(GITLOG_HEAD) && commitsSince(repo, tag.slice(GITLOG_HEAD.length)) === 0
  );
}

/**
 * Ensure this repository's canonical aggregated git-log document is current.
 *
 * Older deepen versions enumerated every `source:git-log` document in the bank and deleted every
 * non-canonical id. A bank can be shared by unrelated repositories, so that name comparison was
 * not an ownership check and could cascade-delete foreign memories (#3877). The canonical retain is
 * already an idempotent upsert; ambiguous legacy documents are deliberately left untouched.
 */
export async function syncGitLog(
  client: HindsightClient,
  repo: string,
  opts: { limit: number; log?: (m: string) => void; stampFor?: () => RetainStamp }
): Promise<number> {
  const log = opts.log ?? (() => {});
  const head = gitHeadSha(repo);
  const current = head !== null && (await gitLogIsCurrent(client, repo, head).catch(() => false));
  if (current) {
    log("[gitlog] current with HEAD — skipping");
    return 0;
  }
  return ingestGitLog(client, repo, opts);
}
