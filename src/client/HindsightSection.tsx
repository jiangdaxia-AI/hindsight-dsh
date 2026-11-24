/**
 * The Settings → Hindsight page.
 *
 * THE PAGE HAS ONE JOB. Local memory either works or it does not, and the user should be able to
 * find that out and fix it without learning what a daemon, a port, a `uvx` or an extraction model
 * is. So the page opens with a state line and one button: press it and the plugin prepares the
 * runtime, picks a model, starts the local service and verifies that it answers — then says so, or
 * says exactly what went wrong and offers a retry. Everything a curious user might want to set by
 * hand still exists, in one collapsed section at the bottom.
 *
 * THE SECOND QUESTION is "what does it actually remember?", and that is the library card: every
 * project the server holds a memory for, with its session and fact counts, when it last moved, and
 * one button to remove it. It is deliberately ABOVE the settings cards, because it is the only part
 * of the page that answers a question rather than asking one.
 *
 * THREE KINDS OF CONTROL MEET HERE, and keeping them ONE family is most of the layout work:
 *
 *  - Text, number and secret fields go straight to the library's own field primitives, which already
 *    render the label, the control, the hint, the override badge and the hairline between two
 *    neighbouring fields. They are never wrapped: a second label beside one of them is a second
 *    label, not a layout.
 *  - Switches and selects have no field descriptor in the shipped library — there is no
 *    `settingsSwitchField` and no `settingsSelectField` — so the rows themselves are built here,
 *    copying the field primitives' metrics exactly (13px/500 label, 12px/1.5 tertiary hint, 12px
 *    vertical padding, `.5px` hairline) and the input styling the Models page uses for its own
 *    selects. The CONTROLS, though, are the library's: `Switch` for a switch and `Button` for an
 *    action, so pressed, hover, focus and disabled states are the host's and not a copy.
 *  - The library card is a list, and the library has no list primitive, so its rows are markup —
 *    but its badges are `Tag`, its action is `Button` inside the library's `Tooltip`, and its
 *    destructive confirmation is the library's own `RiskConfirmation`, which brings the warning
 *    treatment, the acknowledgement checkbox, focus containment and Escape with it.
 *
 * The panel is 800px wide with a 188px navigation column and 24px of side padding, so this page
 * lives in roughly 564px of content: one column, full-width controls, nothing that needs a second
 * column to exist.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  Button,
  type FieldState,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  RiskConfirmation,
  SettingsForm,
  SettingsSecretField,
  SettingsValueField,
  StateDot,
  Switch,
  Tag,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";

import { SECRET_FIELD, appliedChoice, llmChoiceKey } from "../fields";
import type { LibraryRow } from "../library-contract";
import type { CardState, LibrariesState } from "./controller";

/** The free-text and numeric settings fields this page renders through the library's field control. */
type ValueFieldName = "apiUrl" | "apiPort" | "uvDir" | "bankId" | "bankIdTemplate";

/** The page's copy reader, which substitutes `{name}` placeholders. */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** The props the slot renderer hands this section: injected actions, the store hook, and `t`. */
export interface SectionProps {
  t: Translate;
  useHindsightCard: <S>(selector: (state: CardState) => S) => S;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  discard: () => void;
  stage: (field: string, value: unknown) => void;
  runSetup: () => void;
  refreshLibraries: (all?: boolean) => void;
  askRemove: (bankId: string) => void;
  cancelRemove: () => void;
  confirmRemove: () => void;
}

const labelStyle: CSSProperties = { color: "var(--dsw-alias-label-primary)", fontSize: 13, fontWeight: 500, lineHeight: 1.5 };
const hintStyle: CSSProperties = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: 1.5, margin: 0 };
const titleStyle: CSSProperties = {
  color: "var(--dsw-alias-label-primary)",
  fontSize: 16,
  fontWeight: 500,
  lineHeight: "24px",
  margin: "0 0 4px",
};
const introStyle: CSSProperties = { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.6, margin: "0 0 16px" };
const cardStyle: CSSProperties = {
  border: "0.5px solid var(--dsw-alias-settings-card-stroke)",
  background: "var(--dsw-alias-settings-card-fill)",
  borderRadius: "var(--dsw-radius-xl)",
  padding: "2px 16px 6px",
  margin: "0 0 12px",
};
const cardTitleStyle: CSSProperties = {
  color: "var(--dsw-alias-label-primary)",
  fontSize: 13,
  fontWeight: 600,
  lineHeight: "20px",
  margin: 0,
  padding: "12px 0 2px",
};
/** The card's first line: its title on the left, one trailing action on the right. */
const cardHeadStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between" };
const rowStyle: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 16, padding: "12px 0" };
const controlRowStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" };
const textRowStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 };
const subsectionStyle: CSSProperties = {
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  marginTop: 8,
  paddingTop: 12,
};
const subsectionTitleStyle: CSSProperties = { ...cardTitleStyle, padding: 0 };
const noticeStyle: CSSProperties = {
  background: "var(--dsw-alias-interactive-bg-hover)",
  borderLeft: "2px solid var(--dsw-alias-state-warn-primary)",
  borderRadius: "0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0",
  color: "var(--dsw-alias-label-secondary)",
  fontSize: 12,
  lineHeight: 1.6,
  margin: "4px 0 12px",
  padding: "10px 12px",
};
const commandStyle: CSSProperties = {
  color: "var(--dsw-alias-label-primary)",
  display: "block",
  fontFamily: "var(--ds-font-family-code)",
  fontSize: 12,
  marginTop: 6,
  overflowWrap: "anywhere",
  // One click selects the whole command, which is the only thing anyone does with it.
  userSelect: "all",
  WebkitUserSelect: "all",
};
const statusHeadStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, paddingTop: 12 };
const statusTitleStyle: CSSProperties = { color: "var(--dsw-alias-label-primary)", fontSize: 14, fontWeight: 500, lineHeight: "20px" };
const stepRowStyle: CSSProperties = { alignItems: "flex-start", display: "flex", gap: 8, margin: "6px 0 0" };
const stepMarkStyle: CSSProperties = { flex: "none", fontSize: 11, lineHeight: "18px", width: 10 };
const advancedStyle: CSSProperties = { margin: "4px 0 0" };
const advancedSummaryStyle: CSSProperties = {
  color: "var(--dsw-alias-label-secondary)",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "20px",
  padding: "10px 0",
};
/** Visually hidden but announced: the loading line, which the skeletons cannot say themselves. */
const srOnlyStyle: CSSProperties = {
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  height: 1,
  overflow: "hidden",
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
};

/** The library list's own chrome: rows, their two lines, and the skeletons that stand in for them. */
const libraryListStyle: CSSProperties = { listStyle: "none", margin: "10px 0 0", padding: 0 };
const libraryRowStyle: CSSProperties = {
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "12px 0",
};
const libraryHeadStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, minWidth: 0 };
const libraryNameStyle: CSSProperties = {
  ...labelStyle,
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const libraryBadgesStyle: CSSProperties = { alignItems: "center", display: "inline-flex", flex: "none", gap: 6 };
const libraryMetaStyle: CSSProperties = { alignItems: "baseline", display: "flex", gap: 8, minWidth: 0 };
const libraryIdStyle: CSSProperties = {
  color: "var(--dsw-alias-label-tertiary)",
  flex: 1,
  fontFamily: "var(--ds-font-family-code)",
  fontSize: 11,
  lineHeight: "17px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const libraryStampStyle: CSSProperties = {
  color: "var(--dsw-alias-label-tertiary)",
  flex: "none",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  lineHeight: "17px",
};
/**
 * The one-line failure shown ABOVE a list that is still on screen.
 *
 * Distinct from the block below because the two mean different things: no list at all needs the
 * reason and a retry, while a list that survived a failed action only needs the reason — replacing
 * it would read as "the delete worked".
 */
const libraryErrorLineStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, padding: "10px 0 0" };
const skeletonBarStyle: CSSProperties = {
  background: "var(--dsw-alias-bg-skeleton)",
  borderRadius: "var(--dsw-radius-xs)",
  height: 14,
  width: "46%",
};
const skeletonBarShortStyle: CSSProperties = { ...skeletonBarStyle, height: 10, width: "64%" };

/**
 * The styling of a select, chosen to land on the same pixels the library's own inputs occupy — same
 * height, radius, border token, fill and font — because a select sitting among them is the same
 * control and should not read as a different kit. Disabled copies the library's treatment too:
 * tertiary label, no pointer.
 */
function selectStyleOf(disabled: boolean): CSSProperties {
  return {
    appearance: "none",
    backgroundImage: CHEVRON,
    backgroundPosition: "right 12px center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "12px 12px",
    backgroundColor: "var(--dsw-alias-bg-layer-3)",
    border: "0.5px solid var(--dsw-alias-border-l4)",
    borderRadius: "var(--dsw-radius-md)",
    boxSizing: "border-box",
    color: disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)",
    cursor: disabled ? "default" : "pointer",
    font: "inherit",
    fontSize: 13,
    // Matches the height the library's inputs measure in this theme, borders included.
    height: 36,
    padding: "0 32px 0 12px",
    width: "100%",
  };
}
/** The chevron the Models page draws on its own selects, so a select here is the same control. */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

/** One group of rows, outlined the way the Models page outlines its cards. */
function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={cardStyle}>
      {title === undefined ? null : action === undefined ? (
        <h3 style={cardTitleStyle}>{title}</h3>
      ) : (
        <div style={cardHeadStyle}>
          <h3 style={cardTitleStyle}>{title}</h3>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A switch row: what it does on the left, the control on the right, top-aligned. */
function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div style={rowStyle}>
      <div style={textRowStyle}>
        <div style={labelStyle}>{label}</div>
        <p style={hintStyle}>{hint}</p>
      </div>
      <Switch checked={checked} label={label} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** A select row, built to the metrics of a value field so the two interleave as one list. */
function SelectRow({
  id,
  label,
  hint,
  value,
  options,
  optionLabel,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  options: readonly string[];
  optionLabel: (option: string) => string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div style={controlRowStyle}>
      <label style={labelStyle} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        style={selectStyleOf(disabled)}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
      <p style={hintStyle}>{hint}</p>
    </div>
  );
}

/**
 * `2026-10-15T10:01:40.146826+00:00` → `2026-10-15 18:01`, in the reader's own timezone.
 *
 * The same rendering the `/hindsight` report uses, minus the column padding: an server-side
 * timestamp the user cannot place is worse than no timestamp at all.
 */
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * How the status card reads right now.
 *
 * `state` is the library's own `StateDot` vocabulary rather than a colour: the dot for "working"
 * is a spinner there, and a copied hex value would not animate, would not follow the theme, and
 * would not respect reduced motion.
 */
interface SetupView {
  state: "done" | "ongoing" | "warning" | "error" | "idle";
  title: string;
  /** The one line under the title: where it is, why it failed, or what it is using. */
  detail?: string;
  /** A second line for the actionable part of a failure. */
  remedy?: string;
  button: string;
  running: boolean;
}

/** Turn the host's status into the four things the card shows. */
function setupView(t: Translate, state: CardState, daemon: boolean): SetupView {
  const setup = state.setup;
  if (state.setupUnavailable) {
    // The request itself was refused: an older host half, still running the schema from before this
    // feature existed. Nothing is pending and nothing will answer, so the message names the one fix.
    return {
      state: "warning",
      title: t("setupOutdated"),
      detail: t("setupOutdatedHint"),
      button: t("setupRetry"),
      running: false,
    };
  }
  if (state.setupUnanswered) {
    return {
      state: "error",
      title: t("setupUnanswered"),
      detail: t("setupUnansweredHint"),
      button: t("setupRetry"),
      running: false,
    };
  }
  if (state.setupPending) {
    return { state: "ongoing", title: t("setupRunning"), detail: t("setupRunningHint"), button: t("setupRunningButton"), running: true };
  }
  if (setup?.phase === "running") {
    return {
      state: "ongoing",
      title: t("setupRunning"),
      detail: setup.step ? t(`setupStep.${setup.step}`) : t("setupRunningHint"),
      button: t("setupRunningButton"),
      running: true,
    };
  }
  if (setup?.phase === "ok") {
    const service = setup.service;
    // `||`, not `??`: an empty-string model must fall back to the provider, or the "which model is
    // the daemon on" fact silently disappears from the card.
    const model = [service?.model || service?.provider, service?.source].filter(Boolean).join(" · ");
    // The status describes the service that is RUNNING, so a model picked since it started is not in
    // it. Saying so is the point: without this the card presents the old model as the current choice
    // and the user has no way to tell that their change has not taken effect. The button it offers
    // is the one that applies it — the host restarts the daemon when the model differs.
    const applied = appliedChoice(service?.source);
    const picked = state.llmChoice.trim();
    const pending = picked !== "" && applied !== undefined && applied !== picked;
    return {
      state: "done",
      title: t("setupReady"),
      detail: [service?.url, model].filter(Boolean).join(" · "),
      ...(pending ? { remedy: t("setupModelNotApplied") } : {}),
      button: t("setupRestart"),
      running: false,
    };
  }
  if (setup?.phase === "failed") {
    const code = setup.code ?? "error";
    return {
      state: "error",
      title: t("setupFailed"),
      detail: [t(`setupReason.${code}`), setup.detail].filter(Boolean).join("："),
      remedy: code === "model-missing" ? t("setupModelRemedy") : code === "uv-missing" ? t("setupUvRemedy") : undefined,
      button: t("setupRetry"),
      running: false,
    };
  }
  if (!daemon) {
    return {
      state: "idle",
      title: t("setupExternal"),
      detail: t("setupExternalHint"),
      button: t("setupSwitchToLocal"),
      running: false,
    };
  }
  return {
    state: "idle",
    title: state.enabled ? t("setupNotReady") : t("setupDisabled"),
    detail: state.enabled ? t("setupIntro") : t("setupDisabledHint"),
    button: t("setupStart"),
    running: false,
  };
}

/**
 * The status card: what memory is doing, the one button that fixes it, and the master switch.
 *
 * The elapsed counter ticks in the browser rather than being written by the host: a status write
 * edits the profile file, and a progress bar is not worth a file write per second.
 */
function SetupCard({
  t,
  state,
  daemon,
  disabled,
  onRun,
  onToggleEnabled,
}: {
  t: Translate;
  state: CardState;
  daemon: boolean;
  disabled: boolean;
  onRun: () => void;
  onToggleEnabled: (next: boolean) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = state.setupPending || state.setup?.phase === "running";
  useEffect(() => {
    if (!running && !state.setupUnanswered) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [running, state.setupUnanswered]);
  const elapsedSeconds =
    state.setupStartedAt === undefined ? 0 : Math.max(0, Math.round((now - state.setupStartedAt) / 1_000));
  const view = setupView(t, state, daemon);
  const shown = (state.setup?.steps ?? []).filter((step) => step.ok);
  return (
    <Card>
      <div style={statusHeadStyle}>
        <StateDot state={view.state} />
        {/* `role="status"` is already a polite live region; the dot is decorative and says so. */}
        <span style={statusTitleStyle} role="status">
          {view.title}
        </span>
      </div>
      {view.detail ? <p style={{ ...hintStyle, marginTop: 6 }}>{view.detail}</p> : null}
      {view.running && elapsedSeconds > 0 ? (
        <p style={{ ...hintStyle, marginTop: 6 }}>{`${t("setupElapsed")} ${elapsedSeconds}s`}</p>
      ) : null}
      {view.running
        ? shown.map((step) => (
            <div key={step.id} style={stepRowStyle}>
              <span style={{ ...stepMarkStyle, color: "var(--dsw-alias-state-success-primary)" }}>✓</span>
              <p style={hintStyle}>
                {t(`setupStep.${step.id}`)}
                {step.detail ? ` — ${step.detail}` : ""}
              </p>
            </div>
          ))
        : null}
      {view.remedy ? <p style={{ ...hintStyle, marginTop: 6 }}>{view.remedy}</p> : null}
      <div style={{ ...rowStyle, paddingBottom: 4 }}>
        <Button variant="primary" disabled={view.running || disabled} onClick={onRun}>
          {view.button}
        </Button>
      </div>
      <SwitchRow
        label={t("enabled")}
        hint={t("enabledHint")}
        checked={state.enabled}
        disabled={disabled}
        onChange={onToggleEnabled}
      />
    </Card>
  );
}

/** `12` → "12 sessions", `1` → "1 session"; no count is its own phrase rather than a wrong zero. */
function sessionLabel(t: Translate, sessions: number | null): string {
  if (sessions === null) return t("librarySessionsUnknown");
  return sessions === 1 ? t("librarySessionsOne") : t("librarySessions", { n: sessions });
}

/** The fact count, pluralised the same way the session count is. */
function factLabel(t: Translate, facts: number): string {
  return facts === 1 ? t("libraryFactsOne") : t("libraryFacts", { n: facts });
}

/** One library: what it is, how much is in it, when it last moved, and the way out. */
function LibraryListItem({
  t,
  row,
  disabled,
  onRemove,
}: {
  t: Translate;
  row: LibraryRow;
  disabled: boolean;
  onRemove: () => void;
}) {
  const removeLabel = `${t("libraryRemove")}: ${row.label}`;
  return (
    <li style={libraryRowStyle}>
      <div style={libraryHeadStyle}>
        <span style={libraryNameStyle} title={row.label}>
          {row.label}
        </span>
        <span style={libraryBadgesStyle}>
          <Tag tone={row.sessions === null ? "quiet" : "neutral"}>{sessionLabel(t, row.sessions)}</Tag>
          <Tag tone="quiet">{factLabel(t, row.factCount)}</Tag>
        </span>
        <Tooltip label={t("libraryRemove")} side="left">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconTrashOutlineRegular size={14} />}
            aria-label={removeLabel}
            disabled={disabled}
            onClick={onRemove}
          />
        </Tooltip>
      </div>
      <div style={libraryMetaStyle}>
        {/* The id is what a user needs to match this against `/hindsight banks` or the CLI. */}
        <code style={libraryIdStyle} title={row.bankId}>
          {row.bankId}
        </code>
        <span style={libraryStampStyle}>
          {row.lastWriteAt === undefined
            ? t("libraryNeverWritten")
            : `${t("libraryLastWrite")} ${stamp(row.lastWriteAt)}`}
        </span>
      </div>
    </li>
  );
}

/** Three placeholder rows, in the shape of a real one, while the first listing is in flight. */
function LibrarySkeletons() {
  return (
    <ul style={libraryListStyle} aria-hidden="true">
      {[0, 1, 2].map((key) => (
        <li key={key} style={libraryRowStyle}>
          <div style={skeletonBarStyle} />
          <div style={skeletonBarShortStyle} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The library card: what this server remembers, and the one destructive action on the page.
 *
 * The confirmation is the library's own `RiskConfirmation` rather than a copied dialog: it renders
 * the warning treatment, requires the acknowledgement checkbox before its confirm button can even
 * be pressed, traps focus and closes on Escape. That is the platform's answer to "ask twice", so
 * this page asks twice the same way every other destructive action in the host does.
 */
function LibrariesCard({
  t,
  state,
  onRefresh,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  t: Translate;
  state: LibrariesState;
  onRefresh: (all?: boolean) => void;
  onAskRemove: (bankId: string) => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  // The acknowledgement belongs to ONE opening of the dialog: reopening it for another library must
  // not inherit a tick the user gave for the previous one.
  const [acknowledged, setAcknowledged] = useState(false);
  const confirming = state.confirming;
  useEffect(() => {
    setAcknowledged(false);
  }, [confirming]);
  // First look only. Re-mounting the page (a trip to another settings tab and back) keeps the list
  // it already has; the refresh button is there for staleness, so the page does not re-ask the
  // server every time it is looked at.
  useEffect(() => {
    if (state.status === "idle") onRefresh(state.all);
  }, [state.status, state.all, onRefresh]);

  const loading = state.status === "loading" || state.status === "idle";
  // The row being deleted is locked by the controller's one-in-flight guarantee; the REST of the
  // list stays usable (its delete clicks are no-ops while one runs, so a lock would only punish
  // browsing), and the confirmation dialog's Cancel stays clickable — a dialog that cannot be
  // dismissed mid-delete is a trap, not a guard.
  const busy = state.deleting !== undefined;
  const confirmingRow = confirming === undefined ? undefined : state.rows.find((row) => row.bankId === confirming);
  const retry = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        onRefresh(state.all);
      }}
    >
      {t("librariesRetry")}
    </Button>
  );
  return (
    <Card
      title={t("libraries")}
      action={
        <Tooltip label={t("librariesRefresh")} side="left">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutlineRegular size={14} />}
            aria-label={t("librariesRefresh")}
            disabled={loading}
            onClick={() => {
              onRefresh(state.all);
            }}
          />
        </Tooltip>
      }
    >
      <p style={{ ...hintStyle, margin: "2px 0 0" }}>{t("librariesHint")}</p>
      {state.endpoint ? (
        <p style={{ ...hintStyle, margin: "6px 0 0" }}>
          {`${t("librariesEndpoint")} · `}
          <code style={{ fontFamily: "var(--ds-font-family-code)" }}>{state.endpoint}</code>
        </p>
      ) : null}
      {state.removedLabel === undefined ? null : (
        <p style={{ ...hintStyle, color: "var(--dsw-alias-state-success-primary)", margin: "6px 0 0" }} role="status">
          {t("libraryRemoved", { name: state.removedLabel })}
        </p>
      )}

      {/* A failure that kept its rows reports itself as a LINE, so the list stays where it was. */}
      {state.error === undefined || state.rows.length === 0 ? null : (
        <div style={libraryErrorLineStyle}>
          <StateDot state="error" />
          <p style={{ ...hintStyle, color: "var(--dsw-alias-label-error)", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            {`${t("librariesFailed")} — ${state.error}`}
          </p>
          {retry}
        </div>
      )}

      {loading ? (
        <>
          <p style={srOnlyStyle} role="status">
            {t("librariesLoading")}
          </p>
          <LibrarySkeletons />
        </>
      ) : state.status === "unavailable" ? (
        <p style={noticeStyle}>
          <strong>{t("librariesUnavailable")}</strong>
          {" — "}
          {t("librariesUnavailableHint")}
        </p>
      ) : state.rows.length === 0 ? (
        state.status === "error" ? (
          <div style={{ ...rowStyle, alignItems: "center" }}>
            <StateDot state="error" />
            <div style={textRowStyle}>
              <div style={labelStyle}>{t("librariesFailed")}</div>
              <p style={{ ...hintStyle, overflowWrap: "anywhere" }}>{state.error}</p>
            </div>
            {retry}
          </div>
        ) : (
          <div style={{ ...rowStyle, alignItems: "center" }}>
            <StateDot state="idle" />
            <div style={textRowStyle}>
              <div style={labelStyle}>{t("librariesEmpty")}</div>
              <p style={hintStyle}>{t("librariesEmptyHint")}</p>
            </div>
          </div>
        )
      ) : (
        <ul style={libraryListStyle}>
          {state.rows.map((row) => (
            <LibraryListItem
              key={row.bankId}
              t={t}
              row={row}
              // Locked per row: the bank being deleted (whose confirm button became the in-flight
              // delete) and nothing else — a delete in flight must not block the rest of the list,
              // and the controller's one-in-flight guarantee already no-ops a second click.
              disabled={busy && row.bankId === state.deleting}
              onRemove={() => {
                onAskRemove(row.bankId);
              }}
            />
          ))}
        </ul>
      )}

      {loading || state.status === "unavailable" ? null : (
        <div style={{ ...rowStyle, paddingBottom: 8 }}>
          {state.all ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onRefresh(false);
              }}
            >
              {t("librariesShowMine")}
            </Button>
          ) : state.hidden > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onRefresh(true);
              }}
            >
              {t("librariesShowAll")}
            </Button>
          ) : null}
          {!state.all && state.hidden > 0 ? (
            <p style={{ ...hintStyle, alignSelf: "center" }}>{t("librariesHidden", { n: state.hidden })}</p>
          ) : null}
        </div>
      )}

      <RiskConfirmation
        open={confirming !== undefined}
        title={t("libraryRemoveTitle")}
        description={t("libraryRemoveBody", {
          name: confirmingRow?.label ?? confirming ?? "",
          facts: confirmingRow ? factLabel(t, confirmingRow.factCount) : "—",
          sessions: confirmingRow ? sessionLabel(t, confirmingRow.sessions) : "—",
        })}
        acknowledgeLabel={t("libraryRemoveAcknowledge")}
        cancelLabel={t("libraryRemoveCancel")}
        closeLabel={t("libraryRemoveCancel")}
        confirmLabel={t("libraryRemoveConfirm")}
        acknowledged={acknowledged}
        // Never disabled: the dialog's `disabled` locks Cancel too, and a mid-delete dialog the
        // user cannot dismiss is a trap — the old `disabled={busy}` here is what turned a slow
        // delete into a stuck page. A second confirm while one runs is already a controller-side
        // no-op (`removeConfirmed` returns on `deleting !== undefined`), so the guard needs no
        // visual lock.
        onAcknowledgedChange={setAcknowledged}
        onCancel={onCancelRemove}
        onConfirm={onConfirmRemove}
      />
    </Card>
  );
}

/**
 * The page body.
 *
 * @param props - the slot renderer's props, including the injected store hook and actions.
 * @returns the settings form for this plugin's namespace.
 */
export function HindsightSection(props: SectionProps) {
  const { t } = props;
  const state = props.useHindsightCard((snapshot) => snapshot);
  const disabled = !state.writable || state.saving;
  const daemon = state.serverMode === "daemon";
  const tokenLabel = state.apiTokenKnown
    ? state.apiTokenConfigured
      ? t("apiTokenSet")
      : t("apiTokenUnset")
    : t("apiTokenUnknown");
  /**
   * One value field, since all eight take the same five props: the copy is keyed off the settings
   * field name (`bankId` → `bankId` + `bankIdHint`), and only the id and the numeric
   * hint differ between them.
   */
  const valueField = (id: string, name: ValueFieldName, value: FieldState, numeric = false) => (
    <SettingsValueField
      id={`hindsight-${id}`}
      label={t(name)}
      hint={t(`${name}Hint`)}
      overriddenLabel={t("overridden")}
      resetLabel={t("reset")}
      invalidLabel={t("invalidNumber")}
      disabled={disabled}
      numeric={numeric}
      {...value}
      onEdit={(text: string) => {
        props.edit(name, text);
      }}
      onReset={() => {
        props.resetField(name);
      }}
    />
  );
  return (
    <SettingsForm
      labels={{
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving"),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <h2 style={titleStyle}>{t("title")}</h2>
      <p style={introStyle}>{t("description")}</p>

      <SetupCard
        t={t}
        state={state}
        daemon={daemon}
        disabled={disabled}
        onRun={props.runSetup}
        onToggleEnabled={(next) => {
          props.stage("enabled", next);
        }}
      />

      <LibrariesCard
        t={t}
        state={state.libraries}
        onRefresh={props.refreshLibraries}
        onAskRemove={props.askRemove}
        onCancelRemove={props.cancelRemove}
        onConfirmRemove={props.confirmRemove}
      />

      {/* The model pick only means anything where a local service exists: showing it in cloud mode
          invites the user to configure something nothing reads. */}
      {daemon ? (
        <Card title={t("daemonLlm")}>
          <p style={{ ...hintStyle, margin: "2px 0 0" }}>{t("daemonLlmHint")}</p>
          <SelectRow
            id="hindsight-llm-choice"
            label={t("llmChoice")}
            hint={
              state.llmChoiceStale
                ? t("llmChoiceStaleHint")
                : state.llmChoices.length === 0
                  ? t("llmChoiceNone")
                  : t("llmChoiceHint")
            }
            value={state.llmChoice}
            options={[
              "",
              ...state.llmChoices.map((choice) => llmChoiceKey(choice)),
              ...(state.llmChoice && !state.llmChoices.some((choice) => llmChoiceKey(choice) === state.llmChoice)
                ? [state.llmChoice]
                : []),
            ]}
            optionLabel={(option) =>
              option === ""
                ? t("llmChoiceFollow")
                : `${state.llmChoices.find((choice) => llmChoiceKey(choice) === option)?.route ?? option.split("::")[0] ?? option} · ${option.split("::")[1] ?? ""}`
            }
            disabled={disabled}
            onChange={(next) => {
              props.stage("llmChoice", next);
            }}
          />
        </Card>
      ) : null}

      <Card title={t("behaviour")}>
        <SelectRow
          id="hindsight-auto-inject"
          label={t("autoInject")}
          hint={t("autoInjectHint")}
          value={state.autoInject}
          options={AUTO_INJECT_OPTIONS}
          optionLabel={(option) => t(`autoInject.${option}`)}
          disabled={disabled}
          onChange={(next) => {
            props.stage("autoInject", next);
          }}
        />
        <SelectRow
          id="hindsight-rehydrate-mode"
          label={t("rehydrateMode")}
          hint={t("rehydrateModeHint")}
          value={state.rehydrateMode}
          options={REHYDRATE_OPTIONS}
          optionLabel={(option) => t(`rehydrateMode.${option}`)}
          disabled={disabled}
          onChange={(next) => {
            props.stage("rehydrateMode", next);
          }}
        />
        <SwitchRow
          label={t("retainSessions")}
          hint={t("retainSessionsHint")}
          checked={state.retainSessions}
          disabled={disabled}
          onChange={(next) => {
            props.stage("retainSessions", next);
          }}
        />
        <SwitchRow
          label={t("compactionAware")}
          hint={t("compactionAwareHint")}
          checked={state.compactionAware}
          disabled={disabled}
          onChange={(next) => {
            props.stage("compactionAware", next);
          }}
        />
      </Card>

      <Card title={t("seeding")}>
        <SwitchRow
          label={t("autoSeed")}
          hint={t("autoSeedHint")}
          checked={state.autoSeed}
          disabled={disabled}
          onChange={(next) => {
            props.stage("autoSeed", next);
          }}
        />
        <SwitchRow
          label={t("codeFactEnabled")}
          hint={t("codeFactEnabledHint")}
          checked={state.codeFactEnabled}
          disabled={disabled}
          onChange={(next) => {
            props.stage("codeFactEnabled", next);
          }}
        />
        <SwitchRow
          label={t("optInOnly")}
          hint={t("optInOnlyHint")}
          checked={state.optInOnly}
          disabled={disabled}
          onChange={(next) => {
            props.stage("optInOnly", next);
          }}
        />
      </Card>

      <details style={advancedStyle}>
        <summary style={advancedSummaryStyle}>{t("advancedSettings")}</summary>
        <p style={{ ...hintStyle, margin: "0 0 12px" }}>{t("advancedSettingsHint")}</p>
        {/* ONE card holding two labelled groups, rather than a card per group: a bordered card
            inside `<details>` frames the disclosure's own content twice and makes the nesting read
            as depth that is not there. */}
        <Card>
          <h4 style={subsectionTitleStyle}>{t("connection")}</h4>
          <SelectRow
            id="hindsight-server-mode"
            label={t("serverMode")}
            hint={t("serverModeHint")}
            value={state.serverMode}
            options={SERVER_MODE_OPTIONS}
            optionLabel={(option) => t(`serverMode.${option}`)}
            disabled={disabled}
            onChange={(next) => {
              props.stage("serverMode", next);
            }}
          />
          {daemon ? null : valueField("api-url", "apiUrl", state.apiUrl)}
          <SettingsSecretField
            id="hindsight-api-token"
            label={t("apiToken")}
            hint={t("apiTokenHint")}
            disabled={disabled}
            text={state.apiToken.text}
            configured={state.apiTokenConfigured}
            stateLabel={tokenLabel}
            onEdit={(text) => {
              props.edit(SECRET_FIELD, text);
            }}
          />
          {daemon ? valueField("uv-dir", "uvDir", state.uvDir) : null}
          {daemon ? valueField("api-port", "apiPort", state.apiPort, true) : null}
          {daemon ? (
            <p style={noticeStyle}>
              {t("daemonNeedsUv")}
              <code style={commandStyle}>{t("daemonNeedsUvCommand")}</code>
            </p>
          ) : null}

          <div style={subsectionStyle}>
            <h4 style={subsectionTitleStyle}>{t("banks")}</h4>
            {valueField("bank-id", "bankId", state.bankId)}
            {valueField("bank-template", "bankIdTemplate", state.bankIdTemplate)}
            <SelectRow
              id="hindsight-log-level"
              label={t("logLevel")}
              hint={t("logLevelHint")}
              value={state.logLevel}
              options={LOG_LEVEL_OPTIONS}
              optionLabel={(option) => t(`logLevel.${option}`)}
              disabled={disabled}
              onChange={(next) => {
                props.stage("logLevel", next);
              }}
            />
          </div>
        </Card>
      </details>
    </SettingsForm>
  );
}

/** Enum members, spelled here rather than imported from the host half: a client bundle must not
 *  pull the host's Schemastery schema, and the values are a wire contract either way. */
const SERVER_MODE_OPTIONS = ["daemon", "self-hosted", "cloud"] as const;
const AUTO_INJECT_OPTIONS = ["reflect", "pages", "recall", "none"] as const;
const REHYDRATE_OPTIONS = ["off", "handle", "auto"] as const;
const LOG_LEVEL_OPTIONS = ["debug", "info", "warn", "error"] as const;
