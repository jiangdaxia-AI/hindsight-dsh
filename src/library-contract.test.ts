import { describe, expect, it } from "vitest";
import { LIBRARY_CLIENT_ROUTE, LIBRARY_ROUTE, parseLibrariesResponse } from "./library-contract";

/**
 * The wire between the page and its host half.
 *
 * Both halves read this module, so what it must never do is GUESS: a payload it does not understand
 * has to become a failure the page can render, because the alternative — a coercion that happens to
 * produce an empty list — reads as "your memory is gone" at exactly the moment something is broken.
 */
describe("the library wire", () => {
  it("spells the browser's route as the document-relative form of the host's", () => {
    // App routes resolve against the document base, so the leading slash is what breaks a
    // deployment mounted under a prefix. Every browser-side caller derives it this way.
    expect(LIBRARY_ROUTE.startsWith("/api/")).toBe(true);
    expect(LIBRARY_CLIENT_ROUTE).toBe(LIBRARY_ROUTE.slice(1));
    expect(LIBRARY_CLIENT_ROUTE.startsWith("/")).toBe(false);
  });

  it("reads a listing, defaulting the counts it does not have", () => {
    const parsed = parseLibrariesResponse({
      ok: true,
      endpoint: "http://127.0.0.1:9077",
      serverMode: "daemon",
      disabled: false,
      all: false,
      total: 1,
      hidden: 0,
      fetchedAt: "2026-10-15T10:02:00.000Z",
      libraries: [{ bankId: "coding-agent::a", label: "a", factCount: 2, sessions: 1 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.libraries[0]).toEqual({ bankId: "coding-agent::a", label: "a", factCount: 2, sessions: 1 });
  });

  it("drops a malformed row instead of failing the whole listing", () => {
    const parsed = parseLibrariesResponse({
      ok: true,
      libraries: [{ bankId: "coding-agent::a" }, { label: "no id" }, null, "nope"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.libraries).toHaveLength(1);
    // A row that arrives without a name is titled with the id, and its absent counts are zero facts
    // (the host always sends one) and an UNKNOWN session count rather than a confident zero.
    expect(parsed.libraries[0]).toEqual({
      bankId: "coding-agent::a",
      label: "coding-agent::a",
      factCount: 0,
      sessions: null,
    });
  });

  it("treats a missing session count as unknown, never as zero", () => {
    const parsed = parseLibrariesResponse({ ok: true, libraries: [{ bankId: "b", sessions: null }] });
    if (!parsed.ok) throw new Error("expected a listing");
    expect(parsed.libraries[0]?.sessions).toBeNull();
  });

  it("carries the host's own refusals through with their code", () => {
    expect(parseLibrariesResponse({ ok: false, code: "refused", error: "no such bank" })).toEqual({
      ok: false,
      code: "refused",
      error: "no such bank",
    });
    // An unknown code is not a licence to invent one: it degrades to the catch-all.
    expect(parseLibrariesResponse({ ok: false, code: "wat", error: "x" })).toMatchObject({ code: "unreachable" });
  });

  it("turns anything it cannot read into a failure rather than an empty list", () => {
    for (const raw of [undefined, null, "nonsense", 42, {}, { ok: true }, { libraries: "no" }]) {
      const parsed = parseLibrariesResponse(raw);
      expect(parsed.ok, JSON.stringify(raw)).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).not.toBe("");
    }
  });
});
