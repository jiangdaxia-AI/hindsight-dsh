/**
 * Making the local daemon able to find `uv`.
 *
 * Daemon mode runs `hindsight-embed` through `uvx`, and the runtime spawns it by bare name, so it
 * resolves through `PATH`. On macOS the official uv installer puts `uv` and `uvx` in `~/.local/bin`
 * and edits nothing that a GUI-launched app reads: an app started from Finder or the Dock inherits
 * launchd's `PATH`, not the login shell's. "Install uv and it works" is therefore false by default,
 * for the single most common way of installing it.
 *
 * So this module looks for `uvx` the way the user's shell WOULD have: the directories uv's own
 * installer uses, plus an explicitly configured one. When it finds a directory that `PATH` is
 * missing, it adds exactly that directory — nothing is downloaded, no shell file is edited, and when
 * `uvx` already resolves nothing changes at all.
 */
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";

/** The runner the daemon spawns; `uv` ships both, and only this one is required. */
export function uvBinary(platform: string = process.platform): string {
  return platform === "win32" ? "uvx.exe" : "uvx";
}

/**
 * Directories worth checking, most specific first.
 *
 * `~/.local/bin` is where uv's installer lands by default (and on Windows the user's `Scripts`
 * directory, which `%USERPROFILE%\.local\bin` stands in for here); `~/.cargo/bin` catches the
 * older Rust-style layout; the two absolute ones catch Homebrew and a system-wide install.
 *
 * @param options - the home directory and platform to resolve against.
 * @returns candidate directories, in the order to try them.
 */
export function uvCandidateDirs(options: { home?: string; platform?: string } = {}): string[] {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  return [
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
  ];
}

/** Whether `dir` holds the runner. */
function hasUvx(dir: string, binary: string, exists: (path: string) => boolean): boolean {
  try {
    return exists(join(dir, binary));
  } catch {
    return false;
  }
}

/** Whether any `PATH` entry holds the runner. */
function pathHasUvx(pathValue: string | undefined, binary: string, exists: (path: string) => boolean): boolean {
  for (const entry of (pathValue ?? "").split(delimiter)) {
    if (entry && hasUvx(entry, binary, exists)) return true;
  }
  return false;
}

/** What the search found, for the one log line that explains the daemon's environment. */
export interface UvPathResult {
  /** The directory added to `PATH`, when one was. */
  added?: string;
  /** True when the runner was already resolvable and nothing was touched. */
  alreadyOnPath: boolean;
}

/**
 * Make `uvx` resolvable for this process, and therefore for the daemon it spawns.
 *
 * The configured directory wins when it holds the runner; otherwise the standard install locations
 * are tried in order. Only the FIRST directory that holds `uvx` is added, and only when `PATH` does
 * not already resolve it — a process whose `PATH` is already correct is left exactly as it was.
 *
 * @param options - the configured directory, and injectable process facts for tests.
 * @returns what the search did, never an error: a missing uv is the runtime's warning to give.
 */
export function ensureUvOnPath(
  options: {
    /** A directory the user configured, if any. */
    configuredDir?: string | undefined;
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: string;
    exists?: (path: string) => boolean;
  } = {}
): UvPathResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const binary = uvBinary(platform);
  if (pathHasUvx(env.PATH, binary, exists)) return { alreadyOnPath: true };

  const configured = options.configuredDir?.trim();
  const candidates = [...(configured ? [configured] : []), ...uvCandidateDirs({ home: options.home, platform })];
  const found = candidates.find((dir) => hasUvx(dir, binary, exists));
  if (found === undefined) return { alreadyOnPath: false };

  env.PATH = env.PATH ? `${found}${delimiter}${env.PATH}` : found;
  return { added: found, alreadyOnPath: false };
}
