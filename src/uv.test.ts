import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureUvOnPath, uvBinary, uvCandidateDirs } from "./uv";

/** An `exists` that answers only for the paths a test names. */
function only(...paths: string[]) {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

describe("uv discovery", () => {
  it("adds the directory uv's own installer uses when PATH does not have it", () => {
    // The case this exists for: macOS GUI apps inherit launchd's PATH, so `~/.local/bin` — where the
    // uv installer puts uvx — is invisible even though the user did everything right.
    const env = { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;
    const result = ensureUvOnPath({
      env,
      home: "/Users/me",
      platform: "darwin",
      exists: only("/Users/me/.local/bin/uvx"),
    });
    expect(result).toEqual({ added: "/Users/me/.local/bin/uvx".replace("/uvx", ""), alreadyOnPath: false });
    expect(env.PATH).toBe(`/Users/me/.local/bin${delimiter}/usr/bin:/bin`);
  });

  it("changes nothing when uvx already resolves", () => {
    const env = { PATH: "/custom/bin:/usr/bin" } as NodeJS.ProcessEnv;
    const result = ensureUvOnPath({ env, exists: only("/custom/bin/uvx") });
    expect(result.alreadyOnPath).toBe(true);
    expect(env.PATH).toBe("/custom/bin:/usr/bin");
  });

  it("prefers a configured directory over the standard ones", () => {
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const result = ensureUvOnPath({
      configuredDir: "/opt/tools/bin",
      env,
      home: "/Users/me",
      platform: "darwin",
      exists: only("/opt/tools/bin/uvx", "/Users/me/.local/bin/uvx"),
    });
    expect(result.added).toBe("/opt/tools/bin");
    expect(env.PATH).toBe(`/opt/tools/bin${delimiter}/usr/bin`);
  });

  it("keeps looking past a configured directory that does not hold the runner", () => {
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const result = ensureUvOnPath({
      configuredDir: "/wrong/place",
      env,
      home: "/Users/me",
      platform: "darwin",
      exists: only("/Users/me/.cargo/bin/uvx"),
    });
    expect(result.added).toBe("/Users/me/.cargo/bin");
  });

  it("reports nothing found rather than throwing, so the runtime's own warning can speak", () => {
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const result = ensureUvOnPath({ env, home: "/Users/me", platform: "darwin", exists: () => false });
    expect(result).toEqual({ alreadyOnPath: false });
    expect(env.PATH).toBe("/usr/bin");
  });

  it("handles an empty PATH", () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = ensureUvOnPath({
      env,
      home: "/home/me",
      platform: "linux",
      exists: only("/home/me/.local/bin/uvx"),
    });
    expect(result.added).toBe("/home/me/.local/bin");
    expect(env.PATH).toBe("/home/me/.local/bin");
  });

  it("looks for the platform's own binary name", () => {
    expect(uvBinary("win32")).toBe("uvx.exe");
    expect(uvBinary("darwin")).toBe("uvx");
    expect(uvCandidateDirs({ home: "/Users/me", platform: "darwin" })).toContain("/opt/homebrew/bin");
  });
});
