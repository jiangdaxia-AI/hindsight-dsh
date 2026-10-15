/**
 * Which harness this plugin is.
 *
 * Must match the runtime's own id: the local service resolves per-harness overrides, the bank
 * template and the log files under this name, and a mismatch makes two halves of one install
 * describe different things. `dist/cli.js` resolves config under the same id, so the CLI answers
 * about the same memory the plugin writes.
 */
export const HARNESS = "dsh";
