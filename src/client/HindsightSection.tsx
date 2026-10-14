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
 * TWO KINDS OF CONTROL MEET HERE, and keeping them ONE family is most of the layout work:
 *
 *  - Text, number and secret fields go straight to the library's own field primitives, which already
 *    render the label, the control, the hint, the override badge and the hairline between two
 *    neighbouring fields. They are never wrapped: a second label beside one of them is a second
 *    label, not a layout.
 *  - Switches and selects have no field descriptor in the shipped library — there is no
 *    `settingsSwitchField` and no `settingsSelectField` — so this page renders those rows itself,
 *    copying the field primitives' metrics exactly (13px/500 label, 12px/1.5 tertiary hint, 12px
 *    vertical padding, `.5px` hairline) and the input styling the Models page uses for its own
 *    selects. A row built here must be indistinguishable from a row the library built.
 *
 * The panel is 800px wide with a 188px navigation column and 24px of side padding, so this page
 * lives in roughly 564px of content: one column, full-width controls, nothing that needs a second
 * column to exist.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  type FieldState,
  SettingsForm,
  SettingsSecretField,
  SettingsValueField,
  Switch,
} from "@deepseek-ai/dsh-client-ui-primitives";

import { SECRET_FIELD, appliedChoice, llmChoiceKey } from "../fields";
import type { CardState } from "./controller";

/** The free-text and numeric settings fields this page renders through the library's field control. */
type ValueFieldName = "apiUrl" | "apiPort" | "uvDir" | "bankId" | "bankIdTemplate";

/** The props the slot renderer hands this section: injected actions, the store hook, and `t`. */
export interface SectionProps {
  t: (key: string) => string;
  useHindsightCard: <S>(selector: (state: CardState) => S) => S;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  discard: () => void;
  stage: (field: string, value: unknown) => void;
  runSetup: () => void;
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
/** The primary action, styled like the Models page's own primary button. */
const primaryButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "var(--dsw-alias-button-primary-fill)",
  border: "none",
  borderRadius: "var(--dsw-radius-md)",
  boxSizing: "border-box",
  color: "var(--dsw-alias-label-primary-foreground)",
  cursor: "pointer",
  display: "inline-flex",
  font: "inherit",
  fontSize: 13,
  height: 32,
  justifyContent: "center",
  padding: "0 14px",
};
const disabledButtonStyle: CSSProperties = { opacity: 0.4, cursor: "default" };
const statusHeadStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 8, paddingTop: 12 };
const statusTitleStyle: CSSProperties = { color: "var(--dsw-alias-label-primary)", fontSize: 14, fontWeight: 500, lineHeight: "20px" };
const dotStyle: CSSProperties = { borderRadius: "50%", flex: "none", height: 8, width: 8 };
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
/** The chevron the Models page draws on its own selects, so a select here is the same control. */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

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

/** One group of rows, outlined the way the Models page outlines its cards. */
function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section style={cardStyle}>
      {title ? <h3 style={cardTitleStyle}>{title}</h3> : null}
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

/** How the status card reads right now. */
interface SetupView {
  tone: string;
  title: string;
  /** The one line under the title: where it is, why it failed, or what it is using. */
  detail?: string;
  /** A second line for the actionable part of a failure. */
  remedy?: string;
  button: string;
  running: boolean;
}

/** Turn the host's status into the four things the card shows. */
function setupView(options: {
  t: (key: string) => string;
  state: CardState;
  daemon: boolean;
  elapsedSeconds: number;
}): SetupView {
  const { t, state, daemon, elapsedSeconds } = options;
  const setup = state.setup;
  if (state.setupUnavailable) {
    // The request itself was refused: an older host half, still running the schema from before this
    // feature existed. Nothing is pending and nothing will answer, so the message names the one fix.
    return {
      tone: "var(--dsw-alias-state-warn-primary)",
      title: t("setupOutdated"),
      detail: t("setupOutdatedHint"),
      button: t("setupRetry"),
      running: false,
    };
  }
  if (state.setupUnanswered) {
    return {
      tone: "var(--dsw-alias-state-error-primary)",
      title: t("setupUnanswered"),
      detail: t("setupUnansweredHint"),
      button: t("setupRetry"),
      running: false,
    };
  }
  if (state.setupPending) {
    return {
      tone: "var(--dsw-alias-state-business-primary)",
      title: t("setupRunning"),
      detail: t("setupRunningHint"),
      button: t("setupRunningButton"),
      running: true,
    };
  }
  if (setup?.phase === "running") {
    return {
      tone: "var(--dsw-alias-state-business-primary)",
      title: t("setupRunning"),
      detail: setup.step ? t(`setupStep.${setup.step}`) : t("setupRunningHint"),
      button: t("setupRunningButton"),
      running: true,
    };
  }
  if (setup?.phase === "ok") {
    const service = setup.service;
    const model = [service?.model ?? service?.provider, service?.source].filter(Boolean).join(" · ");
    // The status describes the service that is RUNNING, so a model picked since it started is not in
    // it. Saying so is the point: without this the card presents the old model as the current choice
    // and the user has no way to tell that their change has not taken effect. The button it offers
    // is the one that applies it — the host restarts the daemon when the model differs.
    const applied = appliedChoice(service?.source);
    const picked = state.llmChoice.trim();
    const pending = picked !== "" && applied !== undefined && applied !== picked;
    return {
      tone: "var(--dsw-alias-state-success-primary)",
      title: t("setupReady"),
      detail: [service?.url, model].filter(Boolean).join("   "),
      ...(pending ? { remedy: t("setupModelNotApplied") } : {}),
      button: t("setupRestart"),
      running: false,
    };
  }
  if (setup?.phase === "failed") {
    const code = setup.code ?? "error";
    return {
      tone: "var(--dsw-alias-state-error-primary)",
      title: t("setupFailed"),
      detail: [t(`setupReason.${code}`), setup.detail].filter(Boolean).join("："),
      remedy: code === "model-missing" ? t("setupModelRemedy") : code === "uv-missing" ? t("setupUvRemedy") : undefined,
      button: t("setupRetry"),
      running: false,
    };
  }
  if (!daemon) {
    return {
      tone: "var(--dsw-alias-state-idle-primary)",
      title: t("setupExternal"),
      detail: t("setupExternalHint"),
      button: t("setupSwitchToLocal"),
      running: false,
    };
  }
  return {
    tone: "var(--dsw-alias-state-idle-primary)",
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
  t: (key: string) => string;
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
  const view = setupView({ t, state, daemon, elapsedSeconds });
  const shown = (state.setup?.steps ?? []).filter((step) => step.ok);
  return (
    <Card>
      <div style={statusHeadStyle}>
        <span style={{ ...dotStyle, background: view.tone }} aria-hidden="true" />
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
        <button
          type="button"
          style={view.running || disabled ? { ...primaryButtonStyle, ...disabledButtonStyle } : primaryButtonStyle}
          disabled={view.running || disabled}
          onClick={onRun}
        >
          {view.button}
        </button>
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

      <Card title={t("daemonLlm")}>
        <p style={{ ...hintStyle, margin: "2px 0 0" }}>{t("daemonLlmHint")}</p>
        <SelectRow
          id="hindsight-llm-choice"
          label={t("llmChoice")}
          hint={state.llmChoiceStale ? t("llmChoiceStaleHint") : state.llmChoices.length === 0 ? t("llmChoiceNone") : t("llmChoiceHint")}
          value={state.llmChoice}
          options={["", ...state.llmChoices.map((choice) => llmChoiceKey(choice)), ...(state.llmChoice && !state.llmChoices.some((choice) => llmChoiceKey(choice) === state.llmChoice) ? [state.llmChoice] : [])]}
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
          label={t("codeFactEnabled")}
          hint={t("codeFactEnabledHint")}
          checked={state.codeFactEnabled}
          disabled={disabled}
          onChange={(next) => {
            props.stage("codeFactEnabled", next);
          }}
        />
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
        <Card title={t("connection")}>
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
        </Card>
        <Card title={t("banks")}>
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
