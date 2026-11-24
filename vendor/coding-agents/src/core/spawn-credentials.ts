/**
 * The one place a Hindsight child gets the credential the host resolved for it.
 *
 * WHY A FILE, NOT THE ENVIRONMENT. The host half resolves its config from an in-app settings page,
 * and its children (the daemon starter, the deepen engine, the survey supervisor, the MCP server)
 * re-read configuration from scratch in their own process — they need what the page resolved,
 * token included, or every background ingest 401s while the interactive turns keep working. The
 * old route was to export the whole resolved layer through `HINDSIGHT_HOST_OVERRIDES`, which
 * travels by INHERITANCE: every descendant of the host process sees it, and a host like dsh spawns
 * arbitrary processes for the agent — a test runner, a script — any of which could read the
 * token straight out of its own environment.
 *
 * So the overrides layer this file's users export carries NO credential, and the token travels by
 * a 0600 file under `~/.hindsight/` instead — the same directory that holds the config file every
 * Hindsight harness already treats as the user's private configuration. `nodeLaunch` (the one
 * constructor every Hindsight child spawn goes through) injects it into THAT child's environment
 * alone: descendants of the child see it only if the child passes its own environment on, which is
 * the same trust boundary the config file already draws.
 *
 * The file is written by the host half (see `publishSpawnCredentials` in `src/host.ts`) on every
 * configuration refresh, and a missing or unreadable file contributes nothing — the child then
 * resolves its token from the shared config file or the environment exactly as before.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the host half records the credential its children should carry. ~/.hindsight by default. */
export const SPAWN_CREDENTIALS_PATH =
  process.env.HINDSIGHT_SPAWN_CREDENTIALS || join(homedir(), ".hindsight", ".spawn-credentials");

/** The environment variable the token rides in, for the one child being spawned. */
export const SPAWN_TOKEN_ENV = "HINDSIGHT_API_TOKEN";

/**
 * The credential entries `spawnCredentialEnv` adds to a child's environment.
 * Read per call, not cached: the host refreshes the file on every settings write, and a value
 * captured once at plugin load would answer a rotation with the retired token.
 */
export function spawnCredentialEnv(
  exists: (path: string) => boolean = () => true,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Record<string, string> {
  if (!exists(SPAWN_CREDENTIALS_PATH)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(read(SPAWN_CREDENTIALS_PATH));
  } catch {
    return {}; // unreadable is "no credential": the child falls back to its own config sources
  }
  const token =
    typeof raw === "object" && raw !== null && typeof (raw as { apiToken?: unknown }).apiToken === "string"
      ? (raw as { apiToken: string }).apiToken.trim()
      : "";
  if (!token) return {};
  // Below an explicit entry in the base environment: the child's own config file, or anything it
  // inherited, is a more specific statement than the host's page was.
  return { [SPAWN_TOKEN_ENV]: token };
}
