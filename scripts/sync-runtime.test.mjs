/**
 * Tests for `scripts/sync-runtime.mjs` — the pinning and boundary guard.
 *
 * WHY THESE EXIST. The script is this package's only defence against the vendored runtime drifting:
 * it is what CI trusts to notice a hand-edited copy, and what stops a re-sync from writing a tree
 * that cannot build. That makes it the worst place in the repository to have untested behaviour —
 * a guard that silently stops guarding is indistinguishable from no guard at all, and both look
 * like a green CI run.
 *
 * HERMETIC BY CONSTRUCTION. The script derives the tree it owns from its own location, so each test
 * builds a throwaway project in a temp directory — a copy of the real script and a copy of the real
 * `vendor/` — and points it at a throwaway upstream. Nothing here touches the working tree, which
 * matters because every assertion below is about files being rewritten or deliberately not.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REAL_VENDOR = join(PACKAGE_ROOT, "vendor");

/** Files `sync-runtime` insists upstream provides; content is irrelevant to these tests. */
const UPSTREAM_ENTRIES = [
  "dsh.ts",
  "daemon-start.ts",
  "deepen.ts",
  "mcp-server.ts",
  "survey-supervisor.ts",
  "harness/registry.ts",
];

const cleanups = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `sync-runtime-${label}-`));
  cleanups.push(dir);
  return dir;
}

/**
 * A throwaway project: the real script plus a copy of the real vendored tree, so a test can watch
 * the script rewrite it without the working tree ever being involved.
 */
function makeProject() {
  const root = tempDir("project");
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(HERE, "sync-runtime.mjs"), join(root, "scripts", "sync-runtime.mjs"));
  cpSync(REAL_VENDOR, join(root, "vendor"), { recursive: true });
  return root;
}

/** A throwaway hindsight checkout, holding only what the script reaches for. */
function makeUpstream({ extraCore = {} } = {}) {
  const root = tempDir("upstream");
  const src = join(root, "hindsight-integrations", "coding-agents", "src");
  mkdirSync(join(src, "core"), { recursive: true });
  mkdirSync(join(src, "harness"), { recursive: true });
  for (const rel of UPSTREAM_ENTRIES) {
    writeFileSync(join(src, rel), `// upstream ${rel}\nexport {};\n`);
  }
  writeFileSync(join(src, "core", "log.ts"), `// upstream core/log.ts\nexport const log = () => {};\n`);
  for (const [rel, body] of Object.entries(extraCore)) {
    writeFileSync(join(src, "core", rel), body);
  }
  writeFileSync(
    join(root, "hindsight-integrations", "coding-agents", "package.json"),
    `${JSON.stringify({ name: "@vectorize-io/hindsight-coding-agents", version: "9.9.9" }, null, 2)}\n`,
  );
  return root;
}

/** Run the script in `project`, returning its exit code and output instead of throwing. */
function run(project, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(project, "scripts", "sync-runtime.mjs"), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Every file under `vendor/coding-agents`, with its bytes — for proving nothing moved. */
function snapshotVendor(project) {
  const out = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.set(rel, readFileSync(join(dir, entry.name), "utf8"));
    }
  };
  walk(join(project, "vendor", "coding-agents"), "");
  return out;
}

describe("checking the vendored runtime", () => {
  it("accepts the tree this repository actually ships", () => {
    const project = makeProject();
    const result = run(project, ["--check"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("vendored runtime OK");
  });

  it("rejects a hand-edited source file", () => {
    const project = makeProject();
    const victim = join(project, "vendor", "coding-agents", "src", "core", "log.ts");
    writeFileSync(victim, `${readFileSync(victim, "utf8")}\n// hand edit\n`);

    const result = run(project, ["--check"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("does not match vendor/VENDOR.json");
  });

  /**
   * Regression: the inventory hash used to be rooted at `vendor/coding-agents/src`, so the
   * GENERATED package.json beside it was outside the hashed set. Editing it changed the
   * `User-Agent` the bundled runtime sends the server while `--check` still reported the tree
   * intact.
   */
  it("rejects a hand-edited generated package.json", () => {
    const project = makeProject();
    writeFileSync(
      join(project, "vendor", "coding-agents", "package.json"),
      `${JSON.stringify({ name: "@vectorize-io/hindsight-coding-agents", version: "99.99.99" }, null, 2)}\n`,
    );

    const result = run(project, ["--check"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("does not match vendor/VENDOR.json");
  });

  it("rejects a vendored file that imports outside the set", () => {
    const project = makeProject();
    writeFileSync(
      join(project, "vendor", "coding-agents", "src", "core", "escape.ts"),
      'import { x } from "../cline";\nexport const probe = x;\n',
    );

    const result = run(project, ["--check"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("is not vendored");
  });
});

describe("syncing from upstream", () => {
  it("copies the file set and pins it", () => {
    const project = makeProject();
    const upstream = makeUpstream();

    const result = run(project, ["--from", upstream]);
    expect(result.code).toBe(0);
    expect(existsSync(join(project, "vendor", "coding-agents", "src", "core", "log.ts"))).toBe(true);

    // The generated package.json carries the UPSTREAM version, because the runtime reads it for
    // the User-Agent it sends. This package's own version would be a lie.
    const generated = JSON.parse(readFileSync(join(project, "vendor", "coding-agents", "package.json"), "utf8"));
    expect(generated.version).toBe("9.9.9");

    expect(run(project, ["--check"]).code).toBe(0);
  });

  it("takes a file upstream has added", () => {
    const project = makeProject();
    const upstream = makeUpstream({ extraCore: { "brand-new.ts": "export const added = 1;\n" } });

    expect(run(project, ["--from", upstream]).code).toBe(0);
    expect(existsSync(join(project, "vendor", "coding-agents", "src", "core", "brand-new.ts"))).toBe(true);
  });

  /**
   * Regression: the boundary used to be checked AFTER the copy, so a refused sync still left the
   * new files in the tree with a stale lock beside them. A sync that cannot be trusted must not
   * have written anything.
   */
  it("writes nothing at all when the boundary would be broken", () => {
    const project = makeProject();
    const upstream = makeUpstream({
      extraCore: { "escape.ts": 'import { x } from "../cline";\nexport const probe = x;\n' },
    });
    const before = snapshotVendor(project);

    const result = run(project, ["--from", upstream]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("nothing was written");

    // Byte-for-byte identical, and the lock still valid: the tree is exactly as it was.
    expect(snapshotVendor(project)).toEqual(before);
    expect(run(project, ["--check"]).code).toBe(0);
  });

  /**
   * Regression: `syncedAt` was rewritten on every run, so re-syncing an unchanged upstream always
   * produced a diff. A no-op sync has to be a no-op.
   */
  it("leaves the lock byte-identical when upstream has not changed", () => {
    const project = makeProject();
    const upstream = makeUpstream();

    expect(run(project, ["--from", upstream]).code).toBe(0);
    const first = readFileSync(join(project, "vendor", "VENDOR.json"), "utf8");

    expect(run(project, ["--from", upstream]).code).toBe(0);
    const second = readFileSync(join(project, "vendor", "VENDOR.json"), "utf8");

    expect(second).toBe(first);
    expect(JSON.parse(second).syncedAt).toBe(JSON.parse(first).syncedAt);
  });

  it("refuses a checkout that is not a hindsight checkout", () => {
    const project = makeProject();
    const result = run(project, ["--from", tempDir("empty")]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("could not find a hindsight checkout");
  });

  /**
   * Regression: a checkout with the entry file but no manifest used to be accepted, and the sync
   * then died on an ENOENT from the copy loop instead of saying the checkout was incomplete.
   */
  it("refuses a checkout with no upstream package.json", () => {
    const project = makeProject();
    const upstream = makeUpstream();
    rmSync(join(upstream, "hindsight-integrations", "coding-agents", "package.json"));

    const result = run(project, ["--from", upstream]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("the checkout is incomplete");
    expect(result.output).not.toContain("ENOENT");
  });
});

describe("comparing the copy against upstream", () => {
  /**
   * Regression: `--check --from` iterated the VENDORED tree, so it only ever noticed files we
   * already had. A copy that was merely behind — upstream added a file this package never took —
   * reported OK, which is the one thing `--from` is for.
   */
  it("notices a file upstream added that was never vendored", () => {
    const project = makeProject();
    const upstream = makeUpstream({ extraCore: { "brand-new.ts": "export const added = 1;\n" } });

    const result = run(project, ["--check", "--from", upstream]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("exists upstream but is NOT vendored");
  });

  it("notices a file that differs from upstream", () => {
    const project = makeProject();
    const upstream = makeUpstream();
    writeFileSync(join(upstream, "hindsight-integrations", "coding-agents", "src", "core", "log.ts"), "// moved on\n");

    const result = run(project, ["--check", "--from", upstream]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("differs from upstream");
  });

  it("notices a vendored package.json that lost the upstream version", () => {
    const project = makeProject();
    const upstream = makeUpstream();
    expect(run(project, ["--from", upstream]).code).toBe(0);
    writeFileSync(
      join(project, "vendor", "coding-agents", "package.json"),
      `${JSON.stringify({ name: "@vectorize-io/hindsight-coding-agents", version: "0.0.1" }, null, 2)}\n`,
    );

    const result = run(project, ["--check", "--from", upstream]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("does not carry the upstream version");
  });
});

describe("the generated package.json", () => {
  /**
   * Regression: the boundary matched the generated manifest by NAME after normalising the path,
   * and `join` collapses `core/../package.json` to `package.json` — so a specifier that actually
   * pointed at the non-existent `src/package.json` was accepted as the real one. esbuild only
   * catches that if the import is USED; unused, it is elided and this is the only guard.
   */
  it("rejects an import that resolves to the wrong depth", () => {
    const project = makeProject();
    const victim = join(project, "vendor", "coding-agents", "src", "core", "log.ts");
    writeFileSync(victim, `import probe from "../package.json";\nexport const P = probe;\n`);

    const result = run(project, ["--check"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("is not vendored");
  });

  it("accepts the real ../../package.json import", () => {
    const project = makeProject();
    const victim = join(project, "vendor", "coding-agents", "src", "core", "log.ts");
    writeFileSync(victim, `import { version } from "../../package.json";\nexport const V = version;\n`);

    const result = run(project, ["--check"]);
    // The inventory still covers the edit, so re-pin it and check the boundary is happy.
    expect(result.output).not.toContain("is not vendored");
    expect(result.output).not.toContain("COPY_DIRS");
  });

  /**
   * Regression: with the generated file gone, the boundary fell through to its generic advice and
   * told the reader to add `../../package.json` to COPY_FILES — which is wrong, it is generated.
   */
  it("says the generated file is missing rather than blaming COPY_FILES", () => {
    const project = makeProject();
    rmSync(join(project, "vendor", "coding-agents", "package.json"));

    const result = run(project, ["--check"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("is MISSING");
    expect(result.output).not.toContain("add it to COPY_DIRS/COPY_FILES so the boundary stays closed");
  });

  it("reports a clean problem instead of throwing when the manifest is gone", () => {
    const project = makeProject();
    const upstream = makeUpstream();
    rmSync(join(project, "vendor", "coding-agents", "package.json"));

    const result = run(project, ["--check", "--from", upstream]);
    expect(result.code).toBe(1);
    // The already-collected inventory problem must still be reported, not lost behind a stack.
    expect(result.output).toContain("does not match vendor/VENDOR.json");
    expect(result.output).not.toContain("ENOENT");
    expect(result.output).not.toContain("at Object.readFileSync");
  });
});
