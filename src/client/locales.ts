/**
 * The settings page's copy, in both languages the harness ships.
 *
 * Registered under one dictionary namespace through `ctx.locale.register`, and bound by the slot
 * registration's `locale` field, which is what hands the component its `t`.
 */
export const NS = "settings.hindsight";

const en = {
  title: "Hindsight",
  description: "Long-term project memory: what this repository did, decided, and learned.",
  connection: "Connection",
  behaviour: "Memory in a conversation",
  seeding: "Project seeding and scope",
  banks: "Banks and diagnostics",
  advancedSettings: "Advanced settings",
  advancedSettingsHint:
    "Normally nothing to touch here: where memory lives, the port, the model the local server extracts facts with, bank naming and logging.",

  libraries: "Project libraries",
  librariesHint:
    "Every project this server keeps memory for. Deleting one removes its facts, knowledge pages and recorded conversations — the repository itself is untouched.",
  librariesLoading: "Reading the server…",
  librariesEmpty: "No project library yet.",
  librariesEmptyHint: "The first session in a repository creates one.",
  librariesFailed: "The server did not answer",
  librariesRetry: "Try again",
  librariesUnavailable: "This dsh process does not serve the library list yet",
  librariesUnavailableHint:
    "The plugin's host half is still the build from before this page. Restart dsh, then reopen this page.",
  librariesRefresh: "Refresh",
  librariesShowAll: "Show every library on this server",
  librariesShowMine: "Only this plugin's libraries",
  librariesHidden: "{n} more on this server belong to something else",
  librariesEndpoint: "Server",
  librarySessions: "{n} sessions",
  librarySessionsOne: "1 session",
  librarySessionsUnknown: "sessions —",
  libraryFacts: "{n} facts",
  libraryFactsOne: "1 fact",
  libraryLastWrite: "last write",
  libraryNeverWritten: "never written",
  libraryRemove: "Delete this library",
  libraryRemoveTitle: "Delete this library?",
  libraryRemoveBody:
    "“{name}” and everything in it will be permanently deleted: {facts}, {sessions}, its knowledge pages and the recorded conversations. This cannot be undone.",
  libraryRemoveAcknowledge: "I understand this permanently deletes the library and everything in it.",
  libraryRemoveCancel: "Cancel",
  libraryRemoveConfirm: "Delete permanently",
  libraryRemoved: "Deleted “{name}”.",

  setupReady: "Memory is ready",
  setupNotReady: "Memory is not set up yet",
  setupDisabled: "Memory is switched off",
  setupDisabledHint: "Switch it back on to use memory in this repository.",
  setupRunning: "Setting up…",
  setupRunningHint: "The plugin is preparing the local service. This can take a few minutes the first time.",
  setupRunningButton: "Setting up…",
  setupFailed: "Setup failed",
  setupOutdated: "dsh needs a restart",
  setupOutdatedHint:
    "The plugin's host half refused the request — it is still the process from before this update. Restart dsh and try again.",
  setupUnanswered: "The plugin's host half did not answer",
  setupUnansweredHint: "The settings page asked it to prepare the local service and nothing came back. Restart dsh and try again.",
  setupExternal: "This profile is not using a local service",
  setupExternalHint: "Memory is pointed at another server. The button switches to the local one and sets it up.",
  setupIntro: "One button: the plugin installs what is missing, picks a model, starts the local service and checks that it answers.",
  setupElapsed: "Waiting",
  setupStart: "Set up memory",
  setupRetry: "Try again",
  setupRestart: "Set up again",
  setupSwitchToLocal: "Use the local service",
  "setupStep.uv": "Runtime (uv)",
  "setupStep.model": "Model",
  "setupStep.service": "Local service",
  "setupReason.ok": "Ready.",
  "setupReason.uv-missing": "uv could not be found and could not be installed automatically",
  "setupReason.model-missing": "No model is available for local fact extraction",
  "setupReason.unhealthy": "The local service started but never answered its health check",
  "setupReason.not-daemon": "This profile is not in local service mode",
  "setupReason.error": "Setup stopped with an error",
  setupModelRemedy: "Configure a model under Settings → Models first, then try again.",
  setupUvRemedy: "Install uv, or name the directory holding it under Advanced settings below.",
  setupModelNotApplied:
    "The local service is still running the model it was started with. Use “Set up again” to apply the model selected above.",

  enabled: "Memory enabled",
  enabledHint: "Off leaves every session unmemoried and registers no hindsight_* tools.",

  serverMode: "Where memory lives",
  serverModeHint:
    "daemon starts a local Hindsight on demand (needs uv/uvx on PATH). self-hosted talks to a server you run. cloud talks to Hindsight Cloud.",
  "serverMode.daemon": "Local daemon",
  "serverMode.self-hosted": "Self-hosted server",
  "serverMode.cloud": "Hindsight Cloud",

  apiUrl: "API URL",
  apiUrlHint: "Leave blank to use this mode's default endpoint.",

  apiToken: "API token",
  apiTokenHint: "Leave blank to keep the stored token. Stored in this profile's configuration.",
  apiTokenSet: "Configured",
  apiTokenUnset: "Not configured",
  apiTokenUnknown: "Unknown",

  apiPort: "Daemon port",
  apiPortHint: "The port the local daemon listens on. A healthy server already there is adopted.",

  daemonLlm: "The local service's model",
  daemonLlmHint:
    "The local Hindsight service extracts facts with its own model, chosen from the models dsh itself is configured with — no separate provider or key to manage.",
  llmChoice: "Model",
  llmChoiceHint: "Which of dsh's configured models the local service extracts facts with. It reuses that model's endpoint and key.",
  llmChoiceFollow: "Follow dsh (whatever it is using now)",
  llmChoiceStaleHint: "This pick is no longer one of dsh's configured models. Choose another, or follow dsh.",
  llmChoiceNone: "No models found in dsh's configuration yet. Configure one under Settings → Models first.",

  uvDir: "uv directory",
  uvDirHint:
    "Where uv/uvx live, when dsh cannot find them. Leave blank to search the usual install locations (~/.local/bin, ~/.cargo/bin).",

  autoInject: "First prompt receives",
  autoInjectHint: "What a session's opening prompt is given, before the model's first step.",
  "autoInject.reflect": "A reflect synthesis",
  "autoInject.pages": "Matching knowledge pages",
  "autoInject.recall": "Recalled memories",
  "autoInject.none": "Nothing",

  retainSessions: "Write sessions back",
  retainSessionsHint: "Store each completed exchange. Off keeps recall, seeding and the tools working.",

  compactionAware: "Survive context compaction",
  compactionAwareHint: "Keep what compaction removes from the window recoverable, in-session and in the bank.",

  rehydrateMode: "Offer removed detail back as",
  rehydrateModeHint: "How a compacted span is offered again when a later step may need it.",
  "rehydrateMode.off": "Nothing",
  "rehydrateMode.handle": "A short pointer",
  "rehydrateMode.auto": "The recovered text",

  codeFactEnabled: "Retain code changes",
  codeFactEnabledHint: "One code-grounded fact per turn that changed files, read from the working tree. Costs an extraction per changed turn.",

  autoSeed: "Seed cold repositories",
  autoSeedHint: "On a repository's first session, seed its bank from git history.",

  optInOnly: "Only opted-in repositories",
  optInOnlyHint: "Remember nothing unless the config file opts the directory in.",

  bankId: "Shared bank id",
  bankIdHint: "One bank for every repository. Leave blank for one bank per repository.",

  bankIdTemplate: "Per-repository bank name",
  bankIdTemplateHint: "Placeholders: {gitProject} {project} {harness} {channel} {user}.",

  logLevel: "Log level",
  logLevelHint: "Plugin log verbosity, in ~/.hindsight/coding-agents-logs.",
  "logLevel.debug": "Debug",
  "logLevel.info": "Info",
  "logLevel.warn": "Warning",
  "logLevel.error": "Error",

  daemonNeedsUv: "Local daemon mode runs hindsight-embed through uv. Install it with:",
  daemonNeedsUvCommand: "curl -LsSf https://astral.sh/uv/install.sh | sh",

  overridden: "Overridden",
  reset: "Reset",
  invalidNumber: "Enter a number, or leave blank for the default.",
  readOnly: "This deployment stores settings read-only.",
  unavailable: "This plugin is not loaded, so it cannot be configured right now.",
  save: "Save",
  saving: "Saving…",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
};

const zh: typeof en = {
  title: "Hindsight 记忆",
  description: "项目长期记忆：这个仓库做过什么、决定过什么、学到过什么。",
  connection: "连接",
  behaviour: "对话中的记忆",
  seeding: "项目播种与范围",
  banks: "记忆库与诊断",
  advancedSettings: "高级设置",
  advancedSettingsHint: "平时不需要动：记忆放在哪里、端口、本地服务用哪个模型、记忆库命名和日志。",

  libraries: "项目记忆库",
  librariesHint:
    "这个服务器为每个项目保存的记忆库。删除会连同它的事实、知识页和已记录的会话一起移除——不会动到项目本身。",
  librariesLoading: "正在读取服务器…",
  librariesEmpty: "还没有任何项目记忆库。",
  librariesEmptyHint: "在某个仓库里开始第一次会话就会建一个。",
  librariesFailed: "服务器没有响应",
  librariesRetry: "重试",
  librariesUnavailable: "当前 dsh 进程还没有提供记忆库列表",
  librariesUnavailableHint: "插件主进程还是升级前的版本。重启 dsh 后重新打开这个页面。",
  librariesRefresh: "刷新",
  librariesShowAll: "显示这个服务器上的全部记忆库",
  librariesShowMine: "只看本插件创建的记忆库",
  librariesHidden: "这个服务器上还有 {n} 个属于其他来源",
  librariesEndpoint: "服务器",
  librarySessions: "{n} 个历史会话",
  librarySessionsOne: "1 个历史会话",
  librarySessionsUnknown: "会话数 —",
  libraryFacts: "{n} 条事实",
  libraryFactsOne: "1 条事实",
  libraryLastWrite: "最后更新",
  libraryNeverWritten: "尚未写入",
  libraryRemove: "删除这个记忆库",
  libraryRemoveTitle: "确认删除这个记忆库？",
  libraryRemoveBody:
    "「{name}」及其全部内容将被永久删除：{facts}、{sessions}，以及它的知识页和已记录的会话。此操作无法撤销。",
  libraryRemoveAcknowledge: "我了解这会永久删除该记忆库及其全部内容。",
  libraryRemoveCancel: "取消",
  libraryRemoveConfirm: "永久删除",
  libraryRemoved: "已删除「{name}」。",

  setupReady: "记忆已就绪",
  setupNotReady: "还没初始化",
  setupDisabled: "记忆已关闭",
  setupDisabledHint: "重新打开后，这个仓库才会使用记忆。",
  setupRunning: "正在初始化…",
  setupRunningHint: "插件正在准备本机服务，首次可能需要几分钟。",
  setupRunningButton: "正在初始化…",
  setupFailed: "初始化失败",
  setupOutdated: "需要重启 dsh",
  setupOutdatedHint: "初始化请求被插件主进程拒绝了——它还是升级前启动的那个进程。重启 dsh 后重试。",
  setupUnanswered: "插件主进程没有回应",
  setupUnansweredHint: "设置页请求准备本机服务，但没有收到任何回应。请重启 dsh 后重试。",
  setupExternal: "当前 profile 没有使用本机服务",
  setupExternalHint: "记忆指向了别的服务器。点按钮会切回本机服务并完成初始化。",
  setupIntro: "点一下就行：插件会把缺的装上、挑一个模型、启动本机服务，并确认它能正常响应。",
  setupElapsed: "已等待",
  setupStart: "一键初始化",
  setupRetry: "重试",
  setupRestart: "重新初始化",
  setupSwitchToLocal: "改用本机服务",
  "setupStep.uv": "运行环境（uv）",
  "setupStep.model": "选择模型",
  "setupStep.service": "启动本机服务",
  "setupReason.ok": "已就绪。",
  "setupReason.uv-missing": "找不到 uv，自动安装也没有成功",
  "setupReason.model-missing": "没有可用于本地事实抽取的模型",
  "setupReason.unhealthy": "本机服务启动了，但健康检查一直没有响应",
  "setupReason.not-daemon": "当前不是本机服务模式",
  "setupReason.error": "初始化过程中出错了",
  setupModelRemedy: "请先在 设置 → 模型 里配好一个模型，然后重试。",
  setupUvRemedy: "先安装 uv，或者在下面的高级设置里指定它所在的目录。",
  setupModelNotApplied: "本地服务仍在用启动时的模型。点「重新初始化」即可应用上面选择的模型。",

  enabled: "启用记忆",
  enabledHint: "关闭后所有会话都不再使用记忆，也不再注册 hindsight_* 工具。",

  serverMode: "记忆存放在哪里",
  serverModeHint:
    "本地守护进程：按需启动本机 Hindsight（需要 PATH 上有 uv/uvx）。自建服务：连接你自己运行的服务器。云端：连接 Hindsight Cloud。",
  "serverMode.daemon": "本地守护进程",
  "serverMode.self-hosted": "自建服务",
  "serverMode.cloud": "Hindsight Cloud",

  apiUrl: "API 地址",
  apiUrlHint: "留空使用该模式的默认地址。",

  apiToken: "API Token",
  apiTokenHint: "留空表示保持已保存的 Token。保存在本 profile 的配置里。",
  apiTokenSet: "已配置",
  apiTokenUnset: "未配置",
  apiTokenUnknown: "未知",

  apiPort: "守护进程端口",
  apiPortHint: "本地守护进程监听的端口；该端口上已有健康的服务时会直接采用。",

  daemonLlm: "本地服务使用的模型",
  daemonLlmHint:
    "本地 Hindsight 服务用自己的模型做事实抽取，模型直接从 dsh 已配置的模型里选，复用它的接口和密钥，不需要单独配置。",
  llmChoice: "模型",
  llmChoiceHint: "本地服务用哪个 dsh 已配置的模型做事实抽取。它会复用该模型的接口地址和密钥。",
  llmChoiceFollow: "跟随 dsh（当前正在用的模型）",
  llmChoiceStaleHint: "所选的模型已不在 dsh 的配置里。请重新选择，或改回跟随 dsh。",
  llmChoiceNone: "还没有在 dsh 的配置里找到模型。请先在 设置 → 模型 里配置一个。",

  uvDir: "uv 所在目录",
  uvDirHint:
    "dsh 找不到 uv/uvx 时在这里指定。留空则按常见安装位置自动查找（~/.local/bin、~/.cargo/bin）。",

  autoInject: "首个提问注入",
  autoInjectHint: "会话第一次提问时，在模型开始推理前提供什么。",
  "autoInject.reflect": "一次 reflect 归纳",
  "autoInject.pages": "匹配的知识页",
  "autoInject.recall": "召回的记忆",
  "autoInject.none": "什么都不注入",

  retainSessions: "回写会话",
  retainSessionsHint: "把每轮完整对话写入记忆库。关闭后召回、播种和工具仍然可用。",

  compactionAware: "抵抗上下文压缩",
  compactionAwareHint: "压缩把内容挤出上下文窗口时，保留其可恢复性（会话内 + 记忆库）。",

  rehydrateMode: "被移除内容以什么形式提供",
  rehydrateModeHint: "后续步骤可能需要某个被压缩的片段时，如何把它给回来。",
  "rehydrateMode.off": "不提供",
  "rehydrateMode.handle": "一个简短指引",
  "rehydrateMode.auto": "直接给出原文",

  codeFactEnabled: "记录代码改动",
  codeFactEnabledHint: "每轮有文件改动时，从工作区读取并记录一条代码事实。每个改动轮次都会多一次抽取开销。",

  autoSeed: "冷启动播种",
  autoSeedHint: "仓库的第一次会话时，用 git 历史给它的记忆库播种。",

  optInOnly: "仅限已加入的仓库",
  optInOnlyHint: "只有配置文件里明确加入的目录才使用记忆，其余目录完全不写入。",

  bankId: "共用记忆库 ID",
  bankIdHint: "所有仓库共用一个记忆库。留空则按仓库各自建库。",

  bankIdTemplate: "按仓库的记忆库命名",
  bankIdTemplateHint: "占位符：{gitProject} {project} {harness} {channel} {user}。",

  logLevel: "日志级别",
  logLevelHint: "插件日志详细程度，输出在 ~/.hindsight/coding-agents-logs。",
  "logLevel.debug": "调试",
  "logLevel.info": "信息",
  "logLevel.warn": "警告",
  "logLevel.error": "错误",

  daemonNeedsUv: "本地守护进程模式通过 uv 运行 hindsight-embed。安装命令：",
  daemonNeedsUvCommand: "curl -LsSf https://astral.sh/uv/install.sh | sh",

  overridden: "已覆盖",
  reset: "恢复默认",
  invalidNumber: "请填数字；留空表示使用默认值。",
  readOnly: "本部署的设置为只读。",
  unavailable: "该插件当前未加载，暂时无法配置。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "本部署没有接受这些值，已保留供你修改。",
};

/** The dictionaries handed to `ctx.locale.register`. */
export const DICTIONARIES = { en, zh };
