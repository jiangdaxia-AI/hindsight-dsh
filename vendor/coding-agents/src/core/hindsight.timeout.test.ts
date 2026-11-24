/**
 * Tests for this client's DEADLINES — the one number that decides how long a stalled server can hold
 * a caller, and proof that a caller can name its own.
 *
 * WHY THESE EXIST. `req` caps every request at `DEFAULT_REQUEST_TIMEOUT_MS`, and `fetchWithAuth`
 * drops undici's own header/body timeouts so that cap is the sole authority — a combination nobody
 * can see by reading a call site, and one a future refactor can silently undo (`fetch` alone has no
 * deadline at all; undici's default is minutes). `reflect` additionally has to report a deadline as a
 * named, retryable failure rather than a generic abort, because the hook path branches on that.
 *
 * HERMETIC, but with a REAL server: a socket that accepts and never answers is the only way to test a
 * timeout without mocking the very thing under test. It never leaves one open — every case either
 * aborts at its deadline or is closed in `afterAll`.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HindsightClient, ReflectError } from "./hindsight";

let server: Server;
let apiUrl = "";

beforeAll(async () => {
  // Accepts the connection and never writes a byte: exactly the stall these deadlines exist for.
  server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): HindsightClient {
  return new HindsightClient({ apiUrl, bank: "coding-agent::test" });
}

const ms = (t0: number) => Date.now() - t0;

describe("request deadlines", () => {
  it("names reflect's own deadline instead of surfacing a bare abort", async () => {
    const t0 = Date.now();

    await expect(client().reflect("q", { timeoutMs: 150 })).rejects.toThrowError(
      /reflect timed out after 150ms/
    );
    expect(ms(t0)).toBeLessThan(2_000);
  });

  /** The hook path retries or falls back on this flag, so it has to be set on OUR deadline — a bare
   *  abort would read as an unknown error and skip the retrieval fallback. */
  it("marks a timed-out reflect as timed out and fallback-eligible", async () => {
    const error = await client()
      .reflect("q", { timeoutMs: 150 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReflectError);
    expect((error as ReflectError).timedOut).toBe(true);
    expect((error as ReflectError).fallbackEligible).toBe(true);
  });

  /** The roster runs on the awaited pre-step, so it must honour the budget its caller names rather
   *  than the generic one sized for a request nobody is waiting on. */
  it("lets a caller give the page roster a tighter deadline than the default", async () => {
    const t0 = Date.now();

    await expect(client().listPages({ timeoutMs: 150 })).rejects.toThrow();
    expect(ms(t0)).toBeLessThan(2_000);
  });
});
