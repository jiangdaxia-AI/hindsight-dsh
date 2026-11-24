/**
 * `hindsight-dsh` — the same reports as `/hindsight`, from a shell.
 *
 * Why it exists next to the command: the questions this answers get asked when something is WRONG,
 * and the dsh that would run the command is sometimes the thing that's wrong (a plugin that
 * failed to bind, a client half that never loaded). A CLI resolves the config from the same files
 * the plugin reads and talks to the same daemon, so it can be run when dsh cannot.
 *
 * It reads config exactly like the plugin does — `loadConfig` under the `dsh` harness id, plus the
 * `HINDSIGHT_HOST_OVERRIDES` layer a running host exports — and nothing here writes: every call is
 * a GET, and a token is never printed.
 *
 * THE TOKEN. The plugin's host keeps its settings-page token OUT of the inherited environment (it
 * travels by the 0600 spawn-credentials file instead — see core/spawn-credentials.ts), so a shell
 * does not have it either. But the CLI runs as the SAME USER the host does, and the same file is
 * the plugin's own answer to "which credential do my children use": reading it here closes the one
 * gap that would otherwise make the CLI answer 401 against an endpoint the plugin talks to freely
 * (the CLI and the plugin resolve the same file; only the page's live layer is missing, and that
 * layer's token is in the file). The file is read through the runtime's own helper, so an absent
 * or cleared file contributes exactly nothing, and an exported HINDSIGHT_API_TOKEN still wins.
 */
import { resolve } from "node:path";
import { resolveHostMemory } from "../vendor/coding-agents/src/core/host-client";
import { spawnCredentialEnv } from "../vendor/coding-agents/src/core/spawn-credentials";
import { HARNESS } from "./harness";
import {
  HELP_TEXT,
  collectInspect,
  describeInvalid,
  formatInspect,
  inspectDepsOf,
  parseInspectInput,
} from "./inspect";

interface Args {
  json: boolean;
  help: boolean;
  cwd: string;
  request: ReturnType<typeof parseInspectInput>;
}

/** Read the argv. Positional words are the command; the flags surround them. */
function parseArgs(argv: string[]): Args {
  let json = false;
  let help = false;
  let cwd = process.cwd();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--cwd") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--cwd needs a directory");
      cwd = next;
    } else if (arg !== undefined) words.push(arg);
  }
  return { json, help, cwd, request: parseInspectInput(words.join(" ")) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.request.kind === "help") {
    console.log(HELP_TEXT);
    return 0;
  }
  if (args.request.kind === "invalid") {
    // The shared wording — the command says exactly this for the same input.
    console.error(`hindsight-dsh: ${describeInvalid(args.request)}\n\n${HELP_TEXT}`);
    return 2;
  }

  const directory = resolve(args.cwd);
  // Config, bank and client come from the runtime's own resolver, so the CLI answers about the same
  // bank a session in that directory would write to — including `paths.<prefix>`, `banks.<id>` and
  // the `optInOnly` rules. Building it sends nothing. The spawn-credentials file supplies the
  // page's token the same way it supplies it to the plugin's own children (see the module comment);
  // `loadConfig` ranks an exported variable above it, so a user's own export still wins.
  const credentials = spawnCredentialEnv();
  const saved: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(credentials)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  try {
    const memory = resolveHostMemory(HARNESS, directory);
    const deps = inspectDepsOf(memory, directory);
    const data = await collectInspect(deps, args.request);
    if (data === null) {
      console.log(HELP_TEXT);
      return 0;
    }
    console.log(args.json ? JSON.stringify(data, null, 2) : formatInspect(data));
    return 0;
  } finally {
    // The borrowed credential leaves with this process; nothing here writes it anywhere else.
    process.env = saved;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // The endpoint is worth naming on a refusal: a 401 means the token, an ECONNREFUSED means the
    // local service is not up (`~/.hindsight/profiles/coding-agent.log` says why).
    console.error(`hindsight-dsh: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
