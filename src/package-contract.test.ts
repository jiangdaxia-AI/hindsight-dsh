import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAMESPACE } from "./fields";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, string | { default?: string }>;
  files: string[];
  dsh: {
    manifestVersion?: number;
    bundle?: { patch?: string };
    client?: { platform?: string; inject?: string[] };
  };
};
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");

/** Resolve an exports entry that may be a plain string or a conditions object. */
function target(entry: string | { default?: string } | undefined): string | undefined {
  if (typeof entry === "string") return entry;
  return entry?.default;
}

/**
 * Whether npm would pack this export target — it must sit inside one of the `files` entries.
 *
 * Deliberately a wiring question, not an existence one: a fresh checkout has no build artifacts,
 * and `pnpm test` must pass there. That the artifact a build produces really exists is
 * `scripts/check-contract.mjs`'s job, which runs after `pnpm run build`.
 */
function shipped(file: string): boolean {
  const relative = file.replace(/^\.\//, "");
  return pkg.files.some((entry) => {
    const dir = entry.replace(/\/$/, "");
    return relative === dir || relative.startsWith(`${dir}/`);
  });
}

describe("package contract", () => {
  it("declares the browser half the client module system looks for", () => {
    expect(pkg.dsh?.client?.platform).toBe("web");
    const client = target(pkg.exports["./client"]);
    expect(client).toBe("./lib/client.js");
    expect(shipped(client!)).toBe(true);
  });

  it("ships both halves in the published files", () => {
    // `files` is what npm packs: a bundle that exists locally but is not listed never reaches an
    // installed profile, and the failure looks exactly like a plugin that loaded and did nothing.
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("lib");
    expect(pkg.files).toContain("cordis.patch.yml");
    expect(target(pkg.exports["."])).toBe("./dist/host.js");
    expect(shipped("./dist/host.js")).toBe(true);
  });

  it("routes every profile through the manifest-declared patch", () => {
    expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(pkg.dsh?.manifestVersion).toBe(1);
    expect(existsSync(join(root, "cordis.patch.yml"))).toBe(true);
  });

  it("inserts the row under the bare package name, which is what discovery requires", () => {
    // The client module system resolves a row's specifier and reads the nearest package.json whose
    // `name` matches; its parser accepts only `<pkg>` or `@scope/<pkg>`, so a subpath row (the
    // `pkg/dsh` shape the other integrations use for a host-only plugin) resolves the host half and
    // then yields NO package name. The browser half is then never served, silently: no error, no
    // page, a plugin that looks loaded. This is that regression's guard.
    const rows = [...patch.matchAll(/^\s*name:\s*"([^"]+)"\s*$/gm)].map((match) => match[1]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toBe(pkg.name);
      expect(row).not.toContain("/");
    }
    expect(patch).toContain(`- id: ${NAMESPACE}`);
  });

  it("keeps the settings namespace equal to the Loader entry id", () => {
    // The page writes `ctx.configForms.get(NAMESPACE)`; the Host serves forms under the entry id,
    // which the patch row above declares. If one is renamed the other must follow.
    expect(patch).toContain(`- id: ${NAMESPACE}`);
    expect(NAMESPACE).toBe("hindsight");
  });
});
