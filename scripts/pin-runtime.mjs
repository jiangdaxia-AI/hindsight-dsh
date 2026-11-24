#!/usr/bin/env node
/**
 * Guard — and, optionally, re-pin — the runtime this package owns.
 *
 * WHAT THE RUNTIME IS NOW. The memory runtime (recall, retain, banks, seeding, the knowledge tools,
 * the compaction ledger) was forked out of `hindsight-integrations/coding-agents`, where twenty
 * other harnesses shared it, so that this package could be cloned, installed and built on its own.
 * As of the session-injection work it is **this project's own source**: `vendor/coding-agents/` is
 * first-party code, `scripts/build.mjs` inlines it into `dist/host.js`, and a change to it is an
 * ordinary change to this repository. `vendor/VENDOR.json` records where the fork came from
 * (`origin`) and what the tree looks like (`inventory`) — provenance and a pin, not a promise that
 * the two still agree. They deliberately do NOT, and `--from` will say so.
 *
 * THREE MODES:
 *
 *   node scripts/pin-runtime.mjs --record    # I changed the runtime: re-pin it as it stands
 *   node scripts/pin-runtime.mjs --check     # fail if the tree drifted from the recorded pin
 *   node scripts/pin-runtime.mjs --from ../hindsight-main   # report divergence from a checkout
 *
 * WHY THE PIN IS STILL WORTH KEEPING. Ownership does not make the boundary safe. The failure mode is
 * silent in both directions: a half-finished or stray edit changes what the bundle does while
 * looking like any other diff, and one import out of `core/` into a harness file means the tree no
 * longer bundles at all. So `--check` proves, on every CI run, that the tree is byte-for-byte what
 * the pin records and that the imported set is still closed. `--record` is the honest way to move
 * the pin — it re-hashes and re-checks the boundary FIRST, so it cannot pin a tree that is broken —
 * and it exists so that "the guard is in the way" never becomes a reason to hand-edit the manifest.
 *
 * `--from` is a DIAGNOSTIC, not a sync path: it compares the tree against a hindsight checkout in
 * both directions ("every file we carry still matches", "every file upstream has that we never
 * took") and reports differences as problems. After a deliberate local change it is EXPECTED to
 * fail; that is the information, not a defect. Copying from a checkout is the one thing this script
 * no longer does, because the tree is no longer a copy.
 *
 * `vendor/coding-agents/package.json` is inside the hashed set on purpose: `core/hindsight.ts`
 * imports its `version` for the `USER_AGENT` it sends the server, so an edit there changes what this
 * package claims to be just as surely as an edit to a source file.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = join(ROOT, "vendor");
const VENDOR_PKG_DIR = join(VENDOR_DIR, "coding-agents");
const VENDOR_SRC = join(VENDOR_PKG_DIR, "src");
const VENDOR_PKG_JSON = join(VENDOR_PKG_DIR, "package.json");
const LOCK_FILE = join(VENDOR_DIR, "VENDOR.json");

/**
 * Where the runtime was forked from, recorded when the lock file does not exist yet. Metadata: it
 * says which upstream revision this tree STARTED as, not that it still equals it — see the header.
 */
const FORK_ORIGIN = {
  package: "@vectorize-io/hindsight-coding-agents",
  version: "0.8.1",
  commit: "ff9d09dd54ab8977e0901aeeae18f7db164511b0",
  note:
    "Forked from hindsight-integrations/coding-agents and now first-party source of this package; " +
    "the tree MAY differ from this revision by design (see scripts/pin-runtime.mjs).",
};


/** Upstream package the runtime lives in, relative to a hindsight checkout root. */
const UPSTREAM_SUBDIR = join("hindsight-integrations", "coding-agents");

/**
 * What this package's runtime tree holds beyond `core/`.
 *
 * `core/` comes as a whole directory (minus `*.test.ts`, which run against the runtime here and are
 * NOT part of the shipped tree): a few files in it are unreachable from this package's entries (the
 * other harnesses' transcript readers), and they are kept anyway so `core/` stays a coherent
 * directory rather than a hand-picked subset. esbuild tree-shakes what is unused out of the bundle,
 * so they cost nothing in `dist/`.
 *
 * The two lists together are also what `--from` compares a hindsight checkout against, which is the
 * only thing they are read for now that the tree is not copied from anywhere.
 */
const COPY_DIRS = ["core"];

/**
 * Single files the bundle needs beyond `core/`.
 *
 * The four non-`dsh` entries are imported by nothing: the runtime reaches for them BY PATH, as
 * siblings of whatever module is running (`dirname(import.meta.url)`), and spawns them. They must
 * exist beside `dist/host.js` or a feature silently never happens, so they are bundle entrypoints
 * (see `scripts/build.mjs`). `harness/registry.ts` is what `core/` imports to enumerate harnesses, so
 * it is the one file pulled in from outside `core/`.
 */
const COPY_FILES = [
  "dsh.ts",
  "daemon-start.ts",
  "deepen.ts",
  "mcp-server.ts",
  "survey-supervisor.ts",
  "harness/registry.ts",
];

/**
 * Generated files that live OUTSIDE `src/`.
 *
 * `core/hindsight.ts` imports `../../package.json`, which resolves to `vendor/coding-agents/
 * package.json`. The boundary check recognises it by comparing RESOLVED PATHS against
 * `VENDOR_PKG_JSON` rather than by matching a name here, because a name match cannot tell the real
 * target from a specifier of the wrong depth that resolves to nothing.
 */

function toPosix(path) {
  return path.split(sep).join("/");
}

function fail(message) {
  console.error(`pin-runtime: ${message}`);
  process.exit(1);
}

/**
 * Every file under a directory, as paths relative to that directory.
 *
 * The prefix has to be threaded by hand: a `relative(dir, full)` computed inside the recursion is
 * relative to the level it is standing on, which silently flattens `core/a.ts` to `a.ts`.
 */
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function digestOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashRows(rows) {
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** Every source path the vendored tree holds, relative to `vendor/coding-agents/src`. */
function walkVendorSrc() {
  if (!existsSync(VENDOR_SRC)) return [];
  return walk(VENDOR_SRC).map(toPosix);
}

/**
 * Content-addressed record of the whole vendored package: order-independent, path-sensitive.
 *
 * Rooted at `vendor/coding-agents`, NOT at its `src/`, so the generated `package.json` is covered
 * too. That file is not decoration — `core/hindsight.ts` reads its `version` for the `User-Agent`
 * the runtime sends the server — so leaving it outside the hash would let a hand-edit change what
 * this package tells the server it is while `--check` reported the tree intact.
 */
function hashInventory() {
  if (!existsSync(VENDOR_PKG_DIR)) return { hash: hashRows([]), count: 0 };
  const rows = walk(VENDOR_PKG_DIR)
    .map(toPosix)
    .sort()
    .map((rel) => `${rel}\0${digestOf(join(VENDOR_PKG_DIR, ...rel.split("/")))}`);
  return { hash: hashRows(rows), count: rows.length };
}

// ---------------------------------------------------------------- upstream lookup

function upstreamSrc(upstream) {
  return join(upstream, UPSTREAM_SUBDIR, "src");
}

function upstreamPkgPath(upstream) {
  return join(upstream, UPSTREAM_SUBDIR, "package.json");
}

/** Every path a hindsight checkout's runtime holds, relative to its `src/` — what `--from`
 *  compares the owned tree against, in both directions. */
function upstreamFileSet(upstream) {
  const wanted = new Set();
  for (const rel of COPY_FILES) {
    if (!existsSync(join(upstreamSrc(upstream), ...rel.split("/")))) {
      fail(`upstream has no src/${rel} — re-check COPY_FILES`);
    }
    wanted.add(rel);
  }
  for (const dir of COPY_DIRS) {
    const base = join(upstreamSrc(upstream), dir);
    if (!existsSync(base)) fail(`upstream has no src/${dir}`);
    for (const rel of walk(base)) {
      if (rel.endsWith(".test.ts")) continue;
      wanted.add(toPosix(join(dir, rel)));
    }
  }
  return wanted;
}

function resolveUpstream(explicit) {
  const candidates = [
    explicit,
    process.env.HINDSIGHT_REPO,
    join(ROOT, "..", "hindsight-main"),
    join(ROOT, "..", "hindsight"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (!existsSync(join(dir, UPSTREAM_SUBDIR, "src", "dsh.ts"))) continue;
    // The checkout must also carry the manifest: it supplies both the version baked into the
    // vendored package.json and the User-Agent the runtime sends. Caught here so a partial
    // checkout is a clear refusal, not an ENOENT from deep inside the copy loop.
    if (!existsSync(upstreamPkgPath(dir))) {
      fail(
        `${dir} has ${UPSTREAM_SUBDIR}/src/dsh.ts but no ${UPSTREAM_SUBDIR}/package.json — ` +
          `the vendored manifest is generated from it, so the checkout is incomplete`,
      );
    }
    return dir;
  }
  fail(
    `could not find a hindsight checkout — pass --from <path> or set HINDSIGHT_REPO.\n` +
      `  looked in: ${candidates.map((c) => resolve(c)).join(", ")}`,
  );
}

// ---------------------------------------------------------------- boundary

/**
 * Resolve one relative specifier against a set of vendored paths.
 *
 * Resolution follows the bundler: extensionless, `.ts`, `.tsx`, a directory's `index.ts`, and the
 * ESM `.js`-that-means-`.ts` rewrite.
 *
 * @returns the resolved vendor-relative path, or `undefined` when nothing real is there.
 */
function resolveSpecifier(dir, spec, files) {
  const base = toPosix(join(dir, spec));
  const stripped = base.replace(/\.js$/, ".ts");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, stripped]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Prove a set is closed: every relative import inside it resolves to another member.
 *
 * @param files - the set to verify, `src/`-relative.
 * @param readSource - reads one member's text, or returns `undefined` if it is not there. Injected
 *   so a sync can check the UPSTREAM text before it writes anything, leaving the tree untouched
 *   when it refuses.
 * @returns human-readable violations; empty when clean.
 */
function findEscapingImports(files, readSource) {
  const problems = [];
  const specifier = /(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g;

  for (const rel of [...files].sort()) {
    const source = readSource(rel);
    if (source === undefined) {
      problems.push(`src/${rel} is declared but not present in the tree being checked`);
      continue;
    }
    const dir = dirname(rel);
    for (const match of source.matchAll(specifier)) {
      const spec = match[1];
      if (resolveSpecifier(dir, spec, files) !== undefined) continue;

      // The one legitimate target outside `src/`: the generated package.json that
      // `core/hindsight.ts` reads for its version.
      //
      // Compared as a RESOLVED PATH, not as a normalised string. `join` collapses
      // `core/../package.json` to `package.json`, which made a specifier that actually points at
      // the non-existent `src/package.json` look identical to the real `core/../../package.json`.
      // Resolving against the filesystem keeps the two apart, and lets a genuinely missing
      // generated file say so instead of blaming the reader with "add it to COPY_FILES".
      if (resolve(VENDOR_SRC, dir, spec) === VENDOR_PKG_JSON) {
        if (!existsSync(VENDOR_PKG_JSON)) {
          problems.push(
            `src/${rel} imports "${spec}", which is generated (vendor/coding-agents/package.json) ` +
              `but is MISSING — restore it from git; it is not copied from anywhere`,
          );
        }
        continue;
      }

      const target = resolve(VENDOR_SRC, dir, spec);
      const real = existsSync(target);
      problems.push(
        real
          ? `src/${rel} imports "${spec}", which is real but OUTSIDE the bundled set`
          : `src/${rel} imports "${spec}", which is not in the bundled set — add it to ` +
              `COPY_DIRS/COPY_FILES so the boundary stays closed, or the bundle will not build`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------- run

const args = process.argv.slice(2);
const check = args.includes("--check");
const record = args.includes("--record");
const fromIndex = args.indexOf("--from");
const fromArg = fromIndex !== -1 ? args[fromIndex + 1] : undefined;
if (fromIndex !== -1 && !fromArg) fail("--from needs a path to a hindsight checkout");
if (check && record) fail("--check and --record are opposites — pass one");
if (record && fromArg) fail("--record re-pins the tree as it stands and takes no --from");

function report(problems) {
  for (const problem of problems) console.error(`  ${problem}`);
}

/** The boundary problems in the tree AS IT STANDS — what `--record` must clear before it pins. */
function boundaryProblems() {
  return findEscapingImports(new Set(walkVendorSrc()), (rel) => {
    const path = join(VENDOR_SRC, ...rel.split("/"));
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  });
}

if (record) {
  const { hash, count } = hashInventory();
  if (count === 0) fail("the runtime tree is empty — refusing to record nothing");

  // Boundary FIRST, exactly like a write used to be: pinning a tree that cannot bundle would make
  // the guard promise something false, and leave the breakage to surface as a bundling error later.
  const escaping = boundaryProblems();
  if (escaping.length > 0) {
    report(escaping);
    fail(`${escaping.length} problem(s) at the runtime boundary — nothing was recorded`);
  }

  const previous = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, "utf8")) : undefined;
  // Re-recording an unchanged tree must be a no-op, or every record would show up as a diff and the
  // timestamp would stop meaning "when this content became the pin".
  const unchanged =
    previous !== undefined && previous.inventory === hash && previous.fileCount === count;

  writeFileSync(
    LOCK_FILE,
    `${JSON.stringify(
      {
        origin: previous?.origin ?? FORK_ORIGIN,
        fileCount: count,
        inventory: hash,
        recordedAt: unchanged ? previous.recordedAt : new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `recorded ${count} files — the runtime pins as it stands` +
      `${unchanged ? " (unchanged)" : ""}`,
  );
} else if (!check) {
  fail(
    "this script no longer copies a runtime from a hindsight checkout — the tree under " +
      "vendor/coding-agents is this package's own source. Pass --record to re-pin a deliberate " +
      "change, --check to verify the pin, or --check --from <checkout> to compare against upstream.",
  );
} else {
  // In check mode the vendored tree is the subject, so it is also the set under test — this keeps
  // `--check` runnable in CI, where no hindsight checkout exists.
  const files = new Set(walkVendorSrc());
  const inventory = hashInventory();
  const lock = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, "utf8")) : undefined;
  const problems = [];

  if (!lock) problems.push("vendor/VENDOR.json is missing — run --record to pin the tree");
  else if (lock.inventory !== inventory.hash) {
    problems.push(
      `the runtime does not match vendor/VENDOR.json ` +
        `(${inventory.count} files now, ${lock.fileCount} recorded) — a file was edited, added or ` +
        `removed since it was pinned. If the change was DELIBERATE, re-pin it with ` +
        `\`node scripts/pin-runtime.mjs --record\`; if it was not, you have a stray edit.`,
    );
  }
  problems.push(
    ...findEscapingImports(files, (rel) => {
      const path = join(VENDOR_SRC, ...rel.split("/"));
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }),
  );

  if (fromArg) {
    const upstream = resolveUpstream(fromArg);

    // A DIAGNOSTIC, and its findings are expected to be non-empty: this tree is owned source and
    // MAY differ from the revision it was forked from. What it is for is telling the two apart —
    // "we changed this on purpose" from "we are behind a fix upstream has".
    //
    // Every file we carry must still be there upstream, and match it byte for byte.
    // Only files BOTH trees have can differ. A file this tree carries and the checkout does not is
    // either ours (`core/auto-inject.ts` was written here) or a file upstream dropped, and the
    // filesystem cannot tell those apart — reporting it as "no longer exists upstream, re-check
    // COPY_FILES" was advice about a copy list that no longer copies. `*.test.ts` are excluded
    // because the bundled set excludes them by contract, which also keeps a local test from
    // colliding with an upstream one of the same name.
    const expected = upstreamFileSet(upstream);
    for (const rel of [...files].sort()) {
      if (rel.endsWith(".test.ts") || !expected.has(rel)) continue;
      const a = join(upstreamSrc(upstream), ...rel.split("/"));
      const b = join(VENDOR_SRC, ...rel.split("/"));
      if (!existsSync(b) || readFileSync(a, "utf8") !== readFileSync(b, "utf8")) {
        problems.push(`src/${rel} differs from upstream`);
      }
    }

    // The comparison has to run the other way too. Without it, a tree that is merely BEHIND —
    // upstream added a file this package never took — reported OK, which is exactly the case
    // `--from` exists to catch.
    for (const rel of [...expected].sort()) {
      if (!files.has(rel)) {
        problems.push(`src/${rel} exists upstream but is NOT vendored — never taken, or dropped`);
      }
    }

    if (!existsSync(VENDOR_PKG_JSON)) {
      problems.push("vendor/coding-agents/package.json is missing — run --record");
    } else if (
      JSON.parse(readFileSync(VENDOR_PKG_JSON, "utf8")).version !==
      JSON.parse(readFileSync(upstreamPkgPath(upstream), "utf8")).version
    ) {
      problems.push("vendor/coding-agents/package.json does not carry the upstream version");
    }
  }

  if (problems.length > 0) {
    report(problems);
    fail(`${problems.length} problem(s) in the vendored runtime`);
  }
  console.log(
    `vendored runtime OK — ${inventory.count} files, inventory ${inventory.hash.slice(0, 12)}`,
  );
}
