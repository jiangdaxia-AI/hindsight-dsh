/**
 * How to launch a sibling script under the SAME Node that is running this plugin.
 *
 * Every detached worker here used to spawn the bare name `node`. That works for a harness started
 * from a terminal, and fails everywhere else: a GUI application inherits launchd's `PATH`, which has
 * no `node` in it, and this plugin runs inside one. The spawn reports `ENOENT` asynchronously, the
 * call site swallows it on purpose (a failed spawn must not crash a hook), and the feature is simply
 * absent — the local daemon never starts, the background seed never runs, the survey never launches.
 *
 * `process.execPath` is the executable already running this code, so it needs no lookup. When that
 * executable is Electron, the child must be told to behave as Node (`ELECTRON_RUN_AS_NODE`),
 * otherwise it would open another copy of the application instead of running the script.
 *
 * This is also the one place a Hindsight child's environment gets the credential the host resolved
 * for it: `spawnCredentialEnv` reads a 0600 file (never `process.env`, which every descendant of
 * the host would inherit) and adds it to THIS child alone — see core/spawn-credentials.ts.
 */
import { spawnCredentialEnv } from "./spawn-credentials";

/** What to spawn a sibling script with, and the environment that makes it behave as Node. */
export interface NodeLaunch {
  /** The executable: the one running this process. */
  command: string;
  /** Environment for the child: the current one, plus Electron's Node flag when it applies. */
  env: NodeJS.ProcessEnv;
}

/**
 * Build the launch facts for a detached sibling script.
 *
 * @param env - base environment; the process's own by default.
 * @returns the executable and environment to spawn with.
 */
export function nodeLaunch(env: NodeJS.ProcessEnv = process.env): NodeLaunch {
  const command = process.execPath;
  // Electron sets `process.versions.electron`; under plain Node the flag is unnecessary, and
  // harmless when inherited from a parent that had it.
  const electron = Boolean(process.versions.electron) || env.ELECTRON_RUN_AS_NODE === "1";
  const withCredential = { ...spawnCredentialEnv(), ...env } as NodeJS.ProcessEnv;
  return {
    command,
    env: electron ? { ...withCredential, ELECTRON_RUN_AS_NODE: "1" } : withCredential,
  };
}
