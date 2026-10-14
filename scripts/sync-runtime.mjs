#!/usr/bin/env node
/**
 * Re-vendor the shared Hindsight runtime from a `hindsight` checkout.
 *
 * WHY THIS EXISTS. The plugin's host half is a thin shell: the memory runtime it drives (recall,
 * retain, banks, seeding, the knowledge tools, the compaction ledger) lives in
 * `hindsight-integrations/coding-agents`, where twenty other harnesses share it. This package does
 * not reimplement it and does not resolve it at install time; it CARRIES a pinned copy under
 * `vendor/`, and `scripts/build.mjs` inlines that copy into `dist/host.js`. So an install is a link
 * and a copy, nothing resolves inside a profile, and no version can drift under a user.
 *
 * The cost of carrying a copy is that it can fall behind. That is this script's whole job:
 *
 *   node scripts/sync-runtime.mjs --from ../hindsight-main     # take a new copy
 *   node scripts/sync-runtime.mjs --check                      # fail if the copy was hand-edited
 *
 * `--check` never needs a checkout: it verifies the pinned inventory and the boundary below. Given
 * `--from` it additionally proves the copy is byte-identical to that upstream revision, which is
 * how a maintainer confirms a sync actually took.
 *
 * WHAT IS COPIED — and why the boundary is stable. The set below is closed: no vendored file
 * imports anything outside it. The script proves that BEFORE it writes a single byte, against the
 * upstream text, and refuses a tree that would violate it. Checking first is the whole point: the
 * failure mode is otherwise silent — upstream adds one import from `core/` into a harness file, the
 * vendored copy no longer bundles, and the breakage surfaces only later, looking like this
 * package's own bug.
 *
 * `vendor/coding-agents/package.json` is generated, not copied: `core/hindsight.ts` imports its
 * `version` for the `USER_AGENT` it sends the server, so the vendored tree needs a real file there
 * carrying the upstream version. It is inside the hashed set, because a hand-edit there changes
 * what this package claims to be just as surely as an edit to a source file.
 *
 * The vendored copy is the single source of truth for what this package builds against; upstream
 * stays the single source of truth for the code. Re-sync deliberately, and name the upstream
 * revision in the commit.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = join(ROOT, "vendor");
const VENDOR_PKG_DIR = join(VENDOR_DIR, "coding-agents");
const VENDOR_SRC = join(VENDOR_PKG_DIR, "src");
const VENDOR_PKG_JSON = join(VENDOR_PKG_DIR, "package.json");
const LOCK_FILE = join(VENDOR_DIR, "VENDOR.json");

/** Upstream package the runtime lives in, relative to a hindsight checkout root. */
const UPSTREAM_SUBDIR = join("hindsight-integrations", "coding-agents");

/**
 * Whole directories copied minus `*.test.ts`.
 *
 * `core/` is the runtime; its tests stay upstream, where they run against the real package. A few
 * files in here are not reachable from this plugin's entries (the other harnesses' transcript
 * readers); they are copied anyway so the vendored tree stays a coherent `core/` rather than a
 * hand-picked subset the next sync would have to re-derive. esbuild tree-shakes what is unused out
 * of the bundle, so they cost nothing in `dist/`.
 */
const COPY_DIRS = ["core"];

/**
 * Single files the bundle needs beyond `core/`.
 *
 * The four non-`dsh` entries are imported by nothing: the runtime reaches for them BY PATH, as
 * siblings of whatever module is running (`dirname(import.meta.url)`), and spawns them. They must
 * exist beside `dist/host.js` or a feature silently never happens, so they are bundle entrypoints
 * (see `scripts/build.mjs`) and therefore vendored. `harness/registry.ts` is what `core/` imports to
 * enumerate harnesses, so it is the one file pulled in from outside `core/`.
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
 * Generated files that live OUTSIDE `src/`, keyed by their path relative to `src/`.
 *
 * `core/hindsight.ts` imports `../../package.json`; from inside `core/` that resolves to
 * `../package.json` relative to `src/`. Leading `../` segments are stripped before the lookup, so
 * the entry stays correct if a future vendored file sits one level deeper.
 */
const GENERATED_FILES = new Set(["package.json"]);

function toPosix(path) {
  return path.split(sep).join("/");
}

function fail(message) {
  console.error(`sync-runtime: ${message}`);
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

/** The upstream revision this copy came from, when the checkout is a git repo. */
function upstreamCommit(upstream) {
  try {
    return execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** Every path a fresh sync would copy, relative to `vendor/coding-agents/src`. */
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
    if (existsSync(join(dir, UPSTREAM_SUBDIR, "src", "dsh.ts"))) return dir;
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

      // The one legitimate target outside `src/`: the generated package.json, accepted only when
      // the file is really there.
      const target = toPosix(join(dir, spec));
      if (GENERATED_FILES.has(target.replace(/^(\.\.\/)+/, "")) && existsSync(VENDOR_PKG_JSON)) {
        continue;
      }

      const real = existsSync(join(VENDOR_SRC, ...target.split("/")));
      problems.push(
        real
          ? `src/${rel} imports "${spec}", which is real but OUTSIDE the vendored set`
          : `src/${rel} imports "${spec}", which is not vendored — either upstream moved it ` +
              `(re-run the sync with --from <hindsight checkout>) or it is deliberately not ` +
              `vendored, in which case add it to COPY_DIRS/COPY_FILES so the boundary stays closed`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------- run

const args = process.argv.slice(2);
const check = args.includes("--check");
const fromIndex = args.indexOf("--from");
const fromArg = fromIndex !== -1 ? args[fromIndex + 1] : undefined;
if (fromIndex !== -1 && !fromArg) fail("--from needs a path to a hindsight checkout");

function report(problems) {
  for (const problem of problems) console.error(`  ${problem}`);
}

if (!check) {
  const upstream = resolveUpstream(fromArg);
  const wanted = upstreamFileSet(upstream);
  if (wanted.size === 0) fail("the file set is empty — refusing to write an empty vendor tree");

  // Boundary FIRST, against upstream text. A tree that would be broken is never written, so a
  // refused sync leaves the working tree exactly as it found it.
  const readUpstream = (rel) => {
    const path = join(upstreamSrc(upstream), ...rel.split("/"));
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  const escaping = findEscapingImports(wanted, readUpstream);
  if (escaping.length > 0) {
    report(escaping);
    fail(`${escaping.length} problem(s) at the vendoring boundary — nothing was written`);
  }

  mkdirSync(VENDOR_SRC, { recursive: true });

  // Prune first: a file upstream deleted or renamed must not linger here and still be bundled.
  for (const rel of walkVendorSrc()) {
    if (!wanted.has(rel)) rmSync(join(VENDOR_SRC, ...rel.split("/")));
  }

  for (const rel of wanted) {
    const dest = join(VENDOR_SRC, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readUpstream(rel));
  }

  // `core/hindsight.ts` imports this for the User-Agent it sends, so it must carry the real
  // upstream version — not a stub, and not this package's own version.
  const pkg = JSON.parse(readFileSync(upstreamPkgPath(upstream), "utf8"));
  writeFileSync(
    VENDOR_PKG_JSON,
    `${JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2)}\n`,
  );

  const { hash, count } = hashInventory();
  const previous = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, "utf8")) : undefined;
  const upstreamRecord = {
    // Generated by scripts/sync-runtime.mjs — do not edit. `upstream` says where the copy came
    // from; `inventory` is what `--check` verifies in CI, where no checkout exists.
    package: pkg.name,
    version: pkg.version,
    commit: upstreamCommit(upstream) ?? null,
  };

  // Re-syncing the same upstream must leave the tree byte-identical, or every no-op sync would
  // show up as a spurious diff. `syncedAt` describes the content, so it is carried over when the
  // content did not change.
  const unchanged =
    previous !== undefined &&
    previous.inventory === hash &&
    previous.fileCount === count &&
    JSON.stringify(previous.upstream) === JSON.stringify(upstreamRecord);

  writeFileSync(
    LOCK_FILE,
    `${JSON.stringify(
      {
        upstream: upstreamRecord,
        fileCount: count,
        inventory: hash,
        syncedAt: unchanged ? previous.syncedAt : new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `synced ${count} files from ${UPSTREAM_SUBDIR}@${pkg.version}` +
      `${upstreamRecord.commit ? ` (${upstreamRecord.commit.slice(0, 12)})` : ""}` +
      `${unchanged ? " — unchanged" : ""}`,
  );
} else {
  // In check mode the vendored tree is the subject, so it is also the set under test — this keeps
  // `--check` runnable in CI, where no hindsight checkout exists.
  const files = new Set(walkVendorSrc());
  const inventory = hashInventory();
  const lock = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, "utf8")) : undefined;
  const problems = [];

  if (!lock) problems.push("vendor/VENDOR.json is missing — run the sync");
  else if (lock.inventory !== inventory.hash) {
    problems.push(
      `the vendored runtime does not match vendor/VENDOR.json ` +
        `(${inventory.count} files now, ${lock.fileCount} recorded) — a file was hand-edited, ` +
        `added or removed. Re-run the sync with --from <hindsight checkout>.`,
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
    for (const rel of [...files].sort()) {
      const a = join(upstreamSrc(upstream), ...rel.split("/"));
      if (!existsSync(a)) {
        problems.push(`src/${rel} no longer exists upstream — re-check COPY_FILES/COPY_DIRS`);
        continue;
      }
      const b = join(VENDOR_SRC, ...rel.split("/"));
      if (!existsSync(b) || readFileSync(a, "utf8") !== readFileSync(b, "utf8")) {
        problems.push(`src/${rel} differs from upstream`);
      }
    }
    if (JSON.parse(readFileSync(VENDOR_PKG_JSON, "utf8")).version !==
        JSON.parse(readFileSync(upstreamPkgPath(upstream), "utf8")).version) {
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
