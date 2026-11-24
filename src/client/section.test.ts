/**
 * The settings page as a rendered tree.
 *
 * WHY THIS EXISTS NEXT TO `controller.test.ts`. That file pins the state machine, which is the half
 * a bug is easiest to reason about; it says nothing about whether the page can actually BE DRAWN.
 * The failure this guards is specific and expensive: the settings panel renders one slot entry, and
 * an exception thrown while rendering it takes that entry down with a console line and an empty
 * page — so "the controller said `ready`" is not the same claim as "the user can see the library".
 *
 * It renders with a minimal walker rather than a DOM, because neither `react-dom` nor a test
 * renderer is installed and this package keeps its dependency list short. What a test needs from a
 * render is the tree the page BUILDS — labels, children, the props handed to each library control,
 * and the handlers to invoke — and React's elements carry all of that without a reconciler. Hooks
 * are the one thing they do not, so a small runtime stands in for React's dispatcher below; it is a
 * double, and it does not test React.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { HindsightSection, type SectionProps } from "./HindsightSection";
import type { CardState, LibrariesState } from "./controller";

/**
 * The hooks runtime the page's components read instead of React's.
 *
 * Hoisted so the `react` mock below can close over it: module imports are evaluated before this
 * file's body, so anything declared later would still be in its temporal dead zone when the mock
 * factory runs. State is kept per component TYPE, which is all this page needs — each of its
 * components appears once — and `useEffect` runs its callback immediately, which is what makes an
 * effect-triggered load observable here at all.
 */
const hooks = vi.hoisted(() => {
  const byType = new Map<unknown, unknown[]>();
  const stack: Array<[unknown[], number]> = [];
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    enter(type: unknown) {
      stack.push([slots, cursor]);
      slots = byType.get(type) ?? [];
      byType.set(type, slots);
      cursor = 0;
    },
    exit() {
      const previous = stack.pop();
      if (previous !== undefined) [slots, cursor] = previous;
    },
    reset() {
      byType.clear();
      stack.length = 0;
      slots = [];
      cursor = 0;
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [
        slots[index],
        (next: unknown) => {
          slots[index] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[index]) : next;
        },
      ];
    },
    useEffect(effect: () => void | (() => void)) {
      cursor++;
      effect();
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
    useEffect: hooks.useEffect,
    useLayoutEffect: hooks.useEffect,
  };
});

/** One element the walker visited, kept so a test can read its props or press it. */
interface Seen {
  type: unknown;
  props: Record<string, unknown>;
}

/**
 * Render one tree.
 *
 * @param element - the root element.
 * @returns the flattened markup, and every host element visited in render order.
 */
function renderTree(element: ReactNode): { html: string; seen: Seen[] } {
  const seen: Seen[] = [];
  hooks.reset();

  const walk = (node: ReactNode): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(walk).join("");
    if (typeof node !== "object") return String(node);
    const { type, props } = node as ReactElement<Record<string, unknown>>;
    if (typeof type === "function") {
      hooks.enter(type);
      let produced: ReactNode;
      try {
        produced = (type as (p: Record<string, unknown>) => ReactNode)(props ?? {});
      } finally {
        hooks.exit();
      }
      return walk(produced);
    }
    const { children, ...rest } = props ?? {};
    // The FULL props, children included: a test finds a control by its text as often as by its
    // accessible name, and the attributes below are only what gets written into the markup.
    seen.push({ type, props: props ?? {} });
    const attributes = Object.entries(rest)
      .filter(([key]) => key.startsWith("data-") || key === "aria-label" || key === "role" || key === "style")
      .map(([key, value]) =>
        // `style` is an object; stringifying it keeps the token names a test asserts on visible.
        ` ${key}="${key === "style" ? JSON.stringify(value).replace(/"/g, "'") : String(value)}"`,
      )
      .join("");
    const tag = String(type);
    return `<${tag}${attributes}>${walk(children as ReactNode)}</${tag}>`;
  };

  return { html: walk(element), seen };
}

/** The page's copy reader, as the locale service answers it: the KEY, then its parameters. */
const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}(${JSON.stringify(params)})` : key);

/** A library row, as the host sends one. */
const ROW = {
  bankId: "coding-agent::hindsight-dsh",
  label: "hindsight-dsh",
  factCount: 65,
  sessions: 2,
  lastWriteAt: "2026-10-15T10:01:40.000Z",
};

/** Everything the page renders, with only the library list varied by a test. */
function cardState(libraries: Partial<LibrariesState> = {}): CardState {
  const field = () => ({ text: "", overridden: false, invalid: false });
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    serverMode: "daemon",
    autoInject: "reflect",
    rehydrateMode: "handle",
    logLevel: "info",
    enabled: true,
    retainSessions: true,
    compactionAware: true,
    codeFactEnabled: false,
    autoSeed: true,
    optInOnly: false,
    apiUrl: field(),
    apiPort: field(),
    uvDir: field(),
    bankId: field(),
    bankIdTemplate: field(),
    apiToken: field(),
    llmChoice: "",
    llmChoices: [],
    llmChoiceStale: false,
    setup: { at: Date.now(), phase: "ok", code: "ok", steps: [] },
    setupPending: false,
    setupUnanswered: false,
    setupUnavailable: false,
    setupStartedAt: undefined,
    apiTokenConfigured: false,
    apiTokenKnown: true,
    libraries: {
      status: "ready",
      rows: [],
      error: undefined,
      endpoint: undefined,
      all: false,
      hidden: 0,
      confirming: undefined,
      deleting: undefined,
      removedLabel: undefined,
      ...libraries,
    },
  };
}

/** Render the section with one state, returning the markup, the tree and the injected spies. */
function page(state: CardState, overrides: Partial<SectionProps> = {}) {
  const props = {
    t,
    useHindsightCard: <S,>(selector: (snapshot: CardState) => S) => selector(state),
    edit: vi.fn(),
    resetField: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    stage: vi.fn(),
    runSetup: vi.fn(),
    refreshLibraries: vi.fn(),
    askRemove: vi.fn(),
    cancelRemove: vi.fn(),
    confirmRemove: vi.fn(),
    ...overrides,
  } as unknown as SectionProps;
  return { props, ...renderTree(HindsightSection(props)) };
}

/** The props handed to the one `RiskConfirmation` the page mounts. */
function confirmation(seen: Seen[]): Record<string, unknown> {
  const found = seen.find((element) => "acknowledgeLabel" in element.props);
  if (found === undefined) throw new Error("the page rendered no risk confirmation");
  return found.props;
}

/** Every element carrying a delete control's accessible name, in render order. */
function deleteControls(seen: Seen[]): Seen[] {
  return seen.filter((element) => String(element.props["aria-label"] ?? "").startsWith("libraryRemove"));
}

/** The text an element's children carry, ignoring any nested artwork they also contain. */
function textOf(children: unknown): string {
  if (children === null || children === undefined || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (typeof children === "object") {
    const element = children as ReactElement<Record<string, unknown>>;
    return typeof element.type === "function" ? "" : textOf(element.props?.children);
  }
  return String(children);
}

/** The first button whose visible text is `label`, so a test can press it. */
function button(seen: Seen[], label: string): Record<string, unknown> | undefined {
  for (const element of seen) {
    if (element.type !== "button") continue;
    if (textOf(element.props.children) === label) return element.props;
  }
  return undefined;
}

describe("the settings page, rendered", () => {
  it("draws the whole page without a React or library failure", () => {
    const { html } = page(cardState({ rows: [ROW], endpoint: "http://127.0.0.1:9077" }));
    expect(html).toContain("title");
    expect(html).toContain("libraries");
    // The other sections are still there: this is one form, not a library list.
    expect(html).toContain("behaviour");
    expect(html).toContain("seeding");
    expect(html).toContain("advancedSettings");
    expect(html).toContain("setupReady");
  });

  it("shows the server, the bank's own name, and both counts", () => {
    const { html } = page(cardState({ rows: [ROW], endpoint: "http://127.0.0.1:9077" }));
    expect(html).toContain("http://127.0.0.1:9077");
    expect(html).toContain("hindsight-dsh");
    // The id too, so a row can be matched against `/hindsight banks`.
    expect(html).toContain("coding-agent::hindsight-dsh");
    expect(html).toContain('librarySessions({"n":2})');
    expect(html).toContain('libraryFacts({"n":65})');
    expect(html).toContain("libraryLastWrite");
  });

  it("speaks of one session as one, and of an unreadable count as unknown", () => {
    expect(page(cardState({ rows: [{ ...ROW, sessions: 1 }] })).html).toContain("librarySessionsOne");
    expect(page(cardState({ rows: [{ ...ROW, sessions: null }] })).html).toContain("librarySessionsUnknown");
    // A bank that never moved says so, rather than printing an epoch or an empty stamp.
    expect(page(cardState({ rows: [{ ...ROW, lastWriteAt: undefined }] })).html).toContain("libraryNeverWritten");
  });

  it("renders placeholder rows while the first listing is in flight", () => {
    const { html } = page(cardState({ status: "loading" }));
    expect(html).toContain("librariesLoading");
    // Three rows, two bars each.
    expect((html.match(/dsw-alias-bg-skeleton/g) ?? []).length).toBe(6);
  });

  it("offers a retry, and names the reason, when there is no list at all", () => {
    const { html, seen, props } = page(cardState({ status: "error", error: "ECONNREFUSED" }));
    expect(html).toContain("librariesFailed");
    expect(html).toContain("ECONNREFUSED");
    (button(seen, "librariesRetry")?.onClick as () => void)();
    expect(props.refreshLibraries).toHaveBeenCalledWith(false);
  });

  it("keeps a list that survived a failed action, with the reason above it", () => {
    // The refused delete — or a refresh that failed after a good listing — must not blank the rows:
    // a row that vanishes reads as "the delete worked".
    const { html } = page(cardState({ status: "error", error: "no such bank on this server: gone", rows: [ROW] }));
    expect(html).toContain("coding-agent::hindsight-dsh");
    expect(html).toContain("no such bank on this server: gone");
    expect(html).toContain("librariesRetry");
  });

  it("says the running process cannot answer, which is a restart rather than a retry", () => {
    const { html } = page(cardState({ status: "unavailable" }));
    expect(html).toContain("librariesUnavailable");
    expect(html).toContain("librariesUnavailableHint");
  });

  it("guides an empty server to its first session", () => {
    const { html } = page(cardState({ rows: [] }));
    expect(html).toContain("librariesEmpty");
    expect(html).toContain("librariesEmptyHint");
  });

  it("offers to widen the list only when there is something left out", () => {
    const hidden = page(cardState({ rows: [ROW], hidden: 3 }));
    expect(hidden.html).toContain("librariesShowAll");
    expect(hidden.html).toContain('librariesHidden({"n":3})');
    // Nothing hidden: an offer to show more would be a control that does nothing.
    expect(page(cardState({ rows: [ROW], hidden: 0 })).html).not.toContain("librariesShowAll");
    // Already widened: the way back is the narrower list.
    expect(page(cardState({ rows: [ROW], all: true, hidden: 0 })).html).toContain("librariesShowMine");
  });

  it("asks the server to widen, so the narrower default is not just a label", () => {
    const { seen, props } = page(cardState({ rows: [ROW], hidden: 3 }));
    (button(seen, "librariesShowAll")?.onClick as () => void)();
    expect(props.refreshLibraries).toHaveBeenCalledWith(true);
  });

  it("labels each delete control with the library it removes", () => {
    const { html } = page(cardState({ rows: [ROW, { ...ROW, bankId: "coding-agent::other", label: "other" }] }));
    expect((html.match(/data-icon="trash"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="libraryRemove: hindsight-dsh"');
    expect(html).toContain('aria-label="libraryRemove: other"');
  });

  it("asks to remove the row's own bank, and nothing else", () => {
    const { seen, props } = page(cardState({ rows: [ROW, { ...ROW, bankId: "coding-agent::other", label: "other" }] }));
    const target = deleteControls(seen).find((element) => element.props["aria-label"] === "libraryRemove: other");
    (target?.props.onClick as () => void)();
    expect(props.askRemove).toHaveBeenCalledWith("coding-agent::other");
  });

  it("locks only the row being deleted, never the rest of the list or the dialog's Cancel", () => {
    // A delete in flight must not block the rest of the list (the controller no-ops a second
    // click), and it must never disable the confirmation dialog as a whole — `disabled` locks
    // Cancel too, and a dialog the user cannot dismiss mid-delete is a trap.
    const other = { ...ROW, bankId: "coding-agent::other", label: "other" };
    const { seen } = page(cardState({ rows: [ROW, other], deleting: ROW.bankId }));
    const controls = deleteControls(seen);
    const locked = controls.filter((element) => element.props.disabled === true);
    const free = controls.filter((element) => element.props.disabled !== true);
    expect(locked.length).toBe(1); // the row being deleted
    expect(free.length).toBe(1); // the rest of the list stays usable
    const prompt = confirmation(seen);
    expect(prompt.disabled).toBeUndefined(); // Cancel stays clickable
  });

  it("confirms a delete with what is lost, and starts unticked", () => {
    const prompt = confirmation(page(cardState({ rows: [ROW], confirming: ROW.bankId })).seen);
    expect(prompt.open).toBe(true);
    expect(String(prompt.title)).toBe("libraryRemoveTitle");
    // The warning has to name the library AND what goes with it, or "delete" is an unquantified bet.
    expect(String(prompt.description)).toContain("hindsight-dsh");
    expect(String(prompt.description)).toContain("libraryFacts");
    expect(String(prompt.description)).toContain("librarySessions");
    expect(String(prompt.description)).toContain("65");
    expect(String(prompt.acknowledgeLabel)).toBe("libraryRemoveAcknowledge");
    expect(String(prompt.confirmLabel)).toBe("libraryRemoveConfirm");
    expect(prompt.acknowledged).toBe(false);
  });

  it("mounts the confirmation closed until one is asked for", () => {
    expect(confirmation(page(cardState({ rows: [ROW] })).seen).open).toBe(false);
  });

  it("reports a finished delete by name, not by a row quietly vanishing", () => {
    const { html } = page(cardState({ rows: [], removedLabel: "hindsight-dsh" }));
    expect(html).toContain('libraryRemoved({"name":"hindsight-dsh"})');
  });

  it("loads the list once, on first look only", () => {
    // A page that re-asked the server on every render, or on every return to the tab, would hammer
    // the daemon for a list the user is not looking at.
    expect(page(cardState({ status: "idle" })).props.refreshLibraries).toHaveBeenCalledTimes(1);
    expect(page(cardState({ status: "ready", rows: [ROW] })).props.refreshLibraries).not.toHaveBeenCalled();
  });

  it("hides the local service's model pick when the profile is not using one", () => {
    // The pick configures the LOCAL server; showing it against a self-hosted endpoint invites the
    // user to set something nothing reads.
    expect(page(cardState()).html).toContain("daemonLlm");
    expect(page({ ...cardState(), serverMode: "self-hosted" }).html).not.toContain("daemonLlm");
  });

  it("survives a profile whose settings have not loaded yet", () => {
    // The namespace is served but empty: every field falls back to its default, and the page still
    // has to draw. This is the state a fresh profile is in on the first frame.
    const empty = { ...cardState(), writable: false, available: false };
    expect(() => page(empty)).not.toThrow();
    expect(page(empty).html).toContain("libraries");
  });
});
