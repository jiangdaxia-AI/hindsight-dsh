/**
 * Tests for `scripts/check-contract.mjs`.
 *
 * WHY THESE EXIST. The check is what stands between a manifest that looks right and a plugin that
 * loads, and most of what it asserts is invisible at build time: `files` omitting a bundle, an
 * `exports` key repointed by a careless edit, a spawn-by-path sibling nothing builds. A guard whose
 * own logic is wrong is worse than none, because CI then certifies the wrong thing — so the failure
 * modes are pinned here rather than trusted.
 *
 * HERMETIC: each test assembles a throwaway project (the real script, a synthetic manifest, fake
 * artifacts) so a test can break the contract on purpose without touching this repository.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const HOST_ENTRIES = ["host", "daemon-start", "deepen", "mcp-server", "survey-supervisor"];

const cleanups = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A manifest that satisfies every assertion, so a test can change exactly one thing. */
function manifest(overrides = {}) {
  return {
    name: "hindsight-dsh",
    version: "0.1.0",
    type: "module",
    exports: { ".": "./dist/host.js", "./dsh": "./dist/host.js", "./client": "./lib/client.js" },
    files: ["dist", "lib", "cordis.patch.yml", "README.md"],
    dsh: {
      manifestVersion: 1,
      bundle: { patch: "./cordis.patch.yml" },
      client: { platform: "web", inject: ["@deepseek-ai/dsh-client-locale"] },
    },
    ...overrides,
  };
}

/**
 * A throwaway project holding the real script plus whatever the test needs to be true.
 *
 * @param options.pkg - manifest overrides.
 * @param options.coreSource - contents of the one vendored source file, for spawn-target tests.
 */
function makeProject({ pkg = {}, coreSource = "export const log = () => {};\n", skip = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "check-contract-"));
  cleanups.push(root);

  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(HERE, "check-contract.mjs"), join(root, "scripts", "check-contract.mjs"));

  const written = (rel) => !skip.includes(rel);
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  for (const name of HOST_ENTRIES) {
    if (written(`dist/${name}.js`)) writeFileSync(join(root, "dist", `${name}.js`), "export {};\n");
  }
  if (written("lib/client.js")) writeFileSync(join(root, "lib", "client.js"), "module.exports = {};\n");
  if (written("cordis.patch.yml")) writeFileSync(join(root, "cordis.patch.yml"), "- insert: []\n");

  const core = join(root, "vendor", "coding-agents", "src", "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "log.ts"), coreSource);

  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest(pkg), null, 2)}\n`);
  return root;
}

function run(project) {
  try {
    const output = execFileSync(process.execPath, [join(project, "scripts", "check-contract.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

describe("the packaging contract", () => {
  it("passes on a project that satisfies it", () => {
    const result = run(makeProject());
    expect(result.code).toBe(0);
    expect(result.output).toContain("contract OK");
  });

  it("fails when a host entry was never built", () => {
    const result = run(makeProject({ skip: ["dist/survey-supervisor.js"] }));
    expect(result.code).toBe(1);
    expect(result.output).toContain("dist/survey-supervisor.js");
  });

  it("fails when an exports key is repointed", () => {
    const result = run(makeProject({ pkg: { exports: { "./client": "./lib/other.js" } } }));
    expect(result.code).toBe(1);
    expect(result.output).toContain('exports["./client"]');
  });

  it("fails when dsh.bundle.patch is missing", () => {
    const result = run(makeProject({ pkg: { dsh: { client: { platform: "web", inject: ["x"] } } } }));
    expect(result.code).toBe(1);
    expect(result.output).toContain("dsh.bundle.patch");
  });

  it("fails when the browser half is not declared", () => {
    const result = run(makeProject({ pkg: { dsh: { bundle: { patch: "./cordis.patch.yml" } } } }));
    expect(result.code).toBe(1);
    expect(result.output).toContain("dsh.client.platform");
  });

  it("fails when `files` would not ship a required artifact", () => {
    const result = run(makeProject({ pkg: { files: ["cordis.patch.yml"] } }));
    expect(result.code).toBe(1);
    expect(result.output).toContain('files does not ship "dist"');
  });

  it("fails when `files` would ship a build input", () => {
    const result = run(makeProject({ pkg: { files: ["dist", "lib", "cordis.patch.yml", "vendor"] } }));
    expect(result.code).toBe(1);
    expect(result.output).toContain('files ships "vendor"');
  });

  /**
   * The one check no import graph can make. Four entries are reached by `dirname(import.meta.url)`
   * plus a filename rather than by importing, so an upstream addition here builds cleanly and then
   * silently never runs. This is the assertion that notices.
   */
  it("fails when a vendored file spawns a path nothing builds", () => {
    const result = run(
      makeProject({
        coreSource:
          'import { join } from "node:path";\n' +
          'import { fileURLToPath } from "node:url";\n' +
          "export const starter = join(dirname(fileURLToPath(import.meta.url)), \"brand-new.js\");\n",
      }),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("brand-new.js");
    expect(result.output).toContain("silently never run");
  });

  it("accepts a vendored spawn target that IS built", () => {
    const result = run(
      makeProject({
        coreSource:
          'import { join } from "node:path";\n' +
          'import { fileURLToPath } from "node:url";\n' +
          "export const starter = join(dirname(fileURLToPath(import.meta.url)), \"daemon-start.js\");\n",
      }),
    );
    expect(result.code).toBe(0);
  });
});
