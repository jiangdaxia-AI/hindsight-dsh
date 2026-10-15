/**
 * Build both halves of the plugin.
 *
 * HOST (`dist/*.js`) — self-contained ESM, no runtime dependencies. The host half inlines the shared
 * memory runtime from `vendor/coding-agents` (a pinned copy of
 * `hindsight-integrations/coding-agents`, kept in step by `scripts/sync-runtime.mjs`), its
 * dependencies (`zod`, `@vectorize-io/hindsight-all`, `jsonc-parser`, `smol-toml`) and Schemastery,
 * so no resolution step can fail inside a profile and no version can drift.
 *
 * Four of those files exist because the runtime reaches for them BY PATH, as siblings of whatever
 * module it is running from: `dirname(import.meta.url)`. In the runtime's own package they sit
 * beside its entry; in ours they must too, or the host half spawns a file that does not exist —
 * with `stdio: "ignore"`, so the failure is a feature that silently never happens:
 *
 *   daemon-start.js       daemon mode: the detached process that starts the local server
 *   deepen.js             auto-seed: the background git backfill
 *   mcp-server.js         the codebase survey's memory bridge
 *   survey-supervisor.js  the codebase survey's detached lease holder
 *
 * CLIENT (`lib/client.js`) — one file in the shape the browser kernel loads: an ESM module that
 * calls `window.__ModuleLoader__.load({ id, factory })`. React and the UI primitive library stay
 * external `require` calls because the kernel already serves them; bundling a second React would
 * break hooks in ways that are miserable to debug.
 */
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** This package's own manifest, read for the dependency assertion below. */
function readPackageJson() {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
}

/** The shared runtime this package bundles rather than reimplements — see scripts/sync-runtime.mjs. */
const RUNTIME = resolve(root, "vendor", "coding-agents", "src");

/** The package name, which is also the browser module id the kernel registers. */
const PACKAGE_NAME = "hindsight-dsh";

/** Modules the browser kernel serves itself; requiring them resolves against its module table. */
const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-store",
];

/** The module-loader envelope every browser plugin bundle is written in. */
const CLIENT_BANNER = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`;
const CLIENT_FOOTER = `
    return module.exports;
  }
});
`;

mkdirSync(resolve(root, "dist"), { recursive: true });
mkdirSync(resolve(root, "lib"), { recursive: true });

const shared = { bundle: true, logLevel: "info", sourcemap: false };

const hostBuild = await build({
  ...shared,
  entryPoints: {
    host: resolve(root, "src/host.ts"),
    // Siblings the runtime spawns by path; see the module comment.
    "daemon-start": resolve(RUNTIME, "daemon-start.ts"),
    deepen: resolve(RUNTIME, "deepen.ts"),
    "mcp-server": resolve(RUNTIME, "mcp-server.ts"),
    "survey-supervisor": resolve(RUNTIME, "survey-supervisor.ts"),
  },
  outdir: resolve(root, "dist"),
  format: "esm",
  platform: "node",
  target: "node20",
  entryNames: "[name]",
  // Only for the dependency assertion below; nothing else consumes this.
  metafile: true,
});

/**
 * The shell front door of the reports `/hindsight` shows.
 *
 * Its own pass rather than another entry above, because a `bin` entry needs a shebang and the
 * banner belongs to that file alone — the host half and the spawned siblings are imported or
 * spawned BY a Node that is already running, so a shebang there is noise. Everything it imports
 * (the CLI, the reports, the vendored runtime) is bundled in, so it needs no resolution step and no
 * dependency of its own.
 */
await build({
  ...shared,
  entryPoints: [resolve(root, "src/cli.ts")],
  outfile: resolve(root, "dist", "cli.js"),
  format: "esm",
  platform: "node",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
});

// npm and pnpm shims cope without the executable bit and so does `node dist/cli.js`, but a copied
// or directly-linked file that lost it fails with a bare EACCES instead of anything readable.
chmodSync(resolve(root, "dist", "cli.js"), 0o755);

/**
 * The package a resolved path belongs to.
 *
 * Under pnpm a path looks like `node_modules/.pnpm/zod@4.6.7/node_modules/zod/lib/...`, so the LAST
 * `node_modules/` segment is the one that names the package.
 */
function packageOf(resolvedPath) {
  const marker = resolvedPath.lastIndexOf("node_modules/");
  if (marker === -1) return undefined;
  const parts = resolvedPath.slice(marker + "node_modules/".length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Every npm package this package's OWN source imports directly.
 *
 * The distinction that matters is direct vs. transitive. `@modelcontextprotocol/sdk` is imported by
 * the runtime's source, so it must be declared here; `ajv` is imported by that SDK's own files, so
 * the package manager owns it and declaring it would be a lie about what we depend on.
 *
 * Taken from the build's resolved import graph rather than from a regex over the source, so a
 * specifier that only appears in a comment or a string cannot invent a dependency, and one the
 * bundler actually followed cannot hide.
 */
function directlyImportedPackages(metafile) {
  const { inputs } = metafile;
  const names = new Set();
  for (const [path, info] of Object.entries(inputs)) {
    // Only our own and the vendored source; a node_modules file's imports are transitive.
    if (path.includes("node_modules/")) continue;
    for (const imported of info.imports ?? []) {
      const name = packageOf(imported.path);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/**
 * Fail if a package the bundle needs is not declared in `package.json`.
 *
 * This is the check that makes the vendored runtime safe to re-sync. The runtime's dependencies are
 * declared upstream, in `hindsight-integrations/coding-agents/package.json` — a file this package
 * never sees at build time. So when upstream reaches for a new package, this copy keeps building
 * right up until it doesn't, and the failure reads like a bug in this package. Declaring them here
 * and asserting it makes a re-sync tell you exactly what to add.
 */
const declared = new Set(Object.keys(readPackageJson().devDependencies ?? {}));
const undeclared = [...directlyImportedPackages(hostBuild.metafile)]
  .filter((name) => !declared.has(name))
  .sort();
if (undeclared.length > 0) {
  console.error(
    `\nbuild: the host bundle needs ${undeclared.length} package(s) that package.json does not ` +
      `declare:\n${undeclared.map((name) => `  ${name}`).join("\n")}\n\n` +
      `Add them to devDependencies — mirroring hindsight-integrations/coding-agents/package.json, ` +
      `where the runtime declares them — then reinstall.`,
  );
  process.exit(1);
}

await build({
  ...shared,
  entryPoints: [resolve(root, "src/client/index.tsx")],
  outfile: resolve(root, "lib/client.js"),
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  external: CLIENT_EXTERNALS,
  banner: { js: CLIENT_BANNER },
  footer: { js: CLIENT_FOOTER },
});

console.log(
  `built dist/{host,cli,daemon-start,deepen,mcp-server,survey-supervisor}.js and lib/client.js`,
);
