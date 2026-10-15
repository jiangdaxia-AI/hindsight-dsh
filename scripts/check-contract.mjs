#!/usr/bin/env node
/**
 * Assert that what this package tells dsh to load is what it actually built and would publish.
 *
 * WHY THIS IS A FILE, NOT AN INLINE `node -e "..."`. It started as one, in the CI step, and that
 * was a bug: the script sits inside a double-quoted shell string, where a backtick in a comment
 * becomes a command substitution. It ran `files` as a shell command and spliced the empty result
 * into the JavaScript — harmless that time, a corrupted script the next. Nothing here needs the
 * shell, so nothing here goes through it.
 *
 * WHAT IT CAN CATCH THAT THE BUILD CANNOT. `scripts/build.mjs` bundles a FIXED list of entries. The
 * runtime reaches for four of them by path (`dirname(import.meta.url)` + a filename) rather than by
 * importing them, so if upstream grows a fifth such sibling, nothing breaks loudly: the bundle still
 * builds, the import graph never mentions the new file, and the feature simply never happens — the
 * runtime spawns a path that is not there, usually with stdio ignored. The last check below reads
 * the vendored source for exactly that pattern and fails if a spawn target is not a built entry.
 *
 * Run it after `pnpm run build`. Exits non-zero with every problem listed, so one CI run shows all
 * of them rather than the first.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * Entry points the host bundle must produce.
 *
 * The first is the plugin itself; the rest are `scripts/build.mjs`'s "siblings the runtime spawns by
 * path" and must exist beside it in `dist/`.
 */
const HOST_ENTRIES = [
  "host",
  "daemon-start",
  "deepen",
  "mcp-server",
  "survey-supervisor",
];

/** The build output a profile loads: the two halves, plus the patch that mounts the host half. */
const CLIENT_BUNDLE = "lib/client.js";
const HOST_BUNDLE = "dist/host.js";
/** The `bin` entry: the same reports as `/hindsight`, from a shell. */
const CLI_BUNDLE = "dist/cli.js";
const PATCH = "cordis.patch.yml";

const problems = [];
const complain = (message) => problems.push(message);

/** Strip the leading `./` npm allows on a manifest path. */
const pathOf = (value) => (typeof value === "string" ? value.replace(/^\.\//, "") : undefined);

/** Read an `exports` entry that may be a plain string or a conditions object. */
function target(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.default;
  return undefined;
}

// 1. Every artifact exists.
const required = [
  HOST_BUNDLE,
  ...HOST_ENTRIES.slice(1).map((name) => `dist/${name}.js`),
  CLI_BUNDLE,
  CLIENT_BUNDLE,
  PATCH,
];
for (const file of required) {
  if (!existsSync(join(ROOT, file))) complain(`missing build artifact: ${file} (run \`pnpm run build\`)`);
}

// 2. The manifest points at those artifacts, and nowhere else.
const exportsMap = pkg.exports ?? {};
const entryFor = {
  ".": HOST_BUNDLE,
  "./dsh": HOST_BUNDLE,
  "./cli": CLI_BUNDLE,
  "./client": CLIENT_BUNDLE,
};
for (const [key, expected] of Object.entries(entryFor)) {
  const actual = pathOf(target(exportsMap[key]));
  if (actual === undefined) complain(`exports["${key}"] is missing`);
  else if (actual !== expected) complain(`exports["${key}"] is ${actual}, expected ${expected}`);
}

// 2b. The shell reports are reachable. `bin` has to name the built CLI, and that file has to open
//     with a shebang: without one it is executed as a shell script and dies on the first `import`.
const binEntry = pathOf(pkg.bin?.["hindsight-dsh"]);
if (binEntry === undefined) {
  complain('bin["hindsight-dsh"] is missing — the shell reports would not be installed');
} else if (binEntry !== CLI_BUNDLE) {
  complain(`bin["hindsight-dsh"] is ${binEntry}, expected ${CLI_BUNDLE}`);
} else {
  try {
    const firstLine = readFileSync(join(ROOT, CLI_BUNDLE), "utf8").split("\n", 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) complain(`${CLI_BUNDLE} has no shebang — the bin entry would not run`);
  } catch {
    /* missing artifact: already reported above */
  }
}

const patchEntry = pathOf(pkg.dsh?.bundle?.patch);
if (patchEntry === undefined) complain("dsh.bundle.patch is missing — a profile would not mount the plugin");
else if (patchEntry !== PATCH) complain(`dsh.bundle.patch is ${patchEntry}, expected ${PATCH}`);

// The browser half is served only if the manifest declares it with the packages the kernel injects.
if (pkg.dsh?.client?.platform !== "web") {
  complain('dsh.client.platform is not "web" — the settings page would never be served');
}
if (!Array.isArray(pkg.dsh?.client?.inject) || pkg.dsh.client.inject.length === 0) {
  complain("dsh.client.inject is missing or empty");
}

// 3. `files` is what npm actually packs: anything it omits never reaches a user, however well it
//    built locally. Its flip side matters just as much — `files` must not ship the build inputs.
const shipped = pkg.files ?? [];
for (const file of required) {
  const top = file.split("/")[0];
  if (!shipped.includes(top)) complain(`files does not ship "${top}", so ${file} would not publish`);
}
for (const leaking of ["src", "vendor", "scripts"]) {
  if (shipped.includes(leaking)) {
    complain(`files ships "${leaking}" — that is a build input, not part of the published plugin`);
  }
}

// 4. Every spawn-by-path target in the vendored source is a built entry.
//
//    Two shapes account for all of them: `join(dirname(fileURLToPath(import.meta.url)), "x.js")`,
//    and `join(here, "x.js")` where `here` is that same directory. A third shape would slip past
//    this check, which is why the message below says what to do rather than claiming completeness.
const spawnPattern =
  /join\(\s*(?:dirname\(fileURLToPath\(import\.meta\.url\)\)|here)\s*,\s*"([\w.\-]+\.js)"/g;
const builtEntries = new Set(HOST_ENTRIES.map((name) => `${name}.js`));
const vendorSrc = join(ROOT, "vendor", "coding-agents", "src");

function scanForSpawnTargets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForSpawnTargets(full);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    for (const match of readFileSync(full, "utf8").matchAll(spawnPattern)) {
      const target = match[1];
      if (!builtEntries.has(target)) {
        complain(
          `${full.slice(ROOT.length + 1)} spawns "${target}" by path, but nothing builds it — ` +
            `add it to the entryPoints in scripts/build.mjs and to COPY_FILES in ` +
            `scripts/sync-runtime.mjs, or that feature will silently never run`,
        );
      }
    }
  }
}

if (existsSync(vendorSrc)) scanForSpawnTargets(vendorSrc);

if (problems.length > 0) {
  console.error(`check-contract: ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`contract OK — ${required.length} artifacts, ${HOST_ENTRIES.length} host entries, manifest consistent`);
