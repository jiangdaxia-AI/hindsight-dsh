# hindsight-dsh

[![test](https://github.com/jiangdaxia-AI/hindsight-dsh/actions/workflows/test.yml/badge.svg)](https://github.com/jiangdaxia-AI/hindsight-dsh/actions/workflows/test.yml)

**DeepSeek Harness（`dsh`）的长期项目记忆** —— 一个自带设置页、零运行时依赖的 Cordis 插件。

[English](README.md) · [简体中文](README.zh-CN.md)

一个仓库是有记忆的：它做过什么、决定过什么、在哪些地方踩过坑。`hindsight-dsh` 把这份记忆交给编码智能体——作为会话第一个提问时的召回、作为知识前情，以及一组 `hindsight_*` 工具。记忆引擎是
[Hindsight](https://github.com/vectorize-io/hindsight)，本包是它在 dsh 上的门面，并自带它所运行的 coding-agent 运行时。

## 为什么需要它

智能体每个会话开始时，对它即将改动的仓库一无所知。常见做法有两条：手写一份 `AGENTS.md`（到周四就过期），或者翻一长串 `git log`（规模一大就没人读）。记忆应该是一项服务：每一轮都写入、由模型抽取成事实与知识页、按需检索——用户不需要为此维护任何记忆文件。

- **一次安装，不碰配置文件。** 插件自带设置页（**设置 → Hindsight 记忆**），端点、模式和记忆行为都在 dsh 里设置，而不是去改 `~/.hindsight/coding-agent.json`。
- **自包含。** `dist/host.js` 把整个记忆运行时（含 Schemastery 和 Hindsight 客户端）内联进去；**零运行时依赖**，profile 里不存在需要解析的模块。
- **永不阻塞宿主。** 所有生命周期监听器、以及插件绑定本身都是 fail-open 的：失败只会关闭记忆并往插件日志写一行，不会让应用启动失败。召回受 `reflectPatienceMs` 约束，慢的归纳会放到后续步骤投递，而不是卡在关键路径上。
- **默认本地。** 新 profile 默认 `daemon` 模式，在本机按需启动 Hindsight 服务，不需要任何账号。
- **可观察。** `/hindsight` 和 `hindsight-dsh` 会报告当前目录解析到哪个记忆库、里面有什么、是否健康——只读，且不消耗模型轮次。

## 截图

### 设置页

| | |
|---|---|
| ![设置页：每个项目单独的记忆库](docs/images/settings-per-project-memory.png) | ![本地服务直接跟随 dsh 的模型](docs/images/settings-reuse-dsh-model.png) |
| 每个项目单独的记忆库——事实数、会话数、最后写入时间，以及唯一的破坏性操作。 | 本地服务可以直接跟随 dsh 正在用的模型，不用再配第二份 key。 |

![连接：本地守护进程、自建服务或 Hindsight Cloud](docs/images/settings-cloud.png)

### 会话中

![会话开始时异步检索历史上下文](docs/images/session-async-retrieval.png)

会话打开时异步检索历史上下文，匹配当前目标的知识页在第一个提问之前就到位。

| | |
|---|---|
| ![记忆块注入到这一轮](docs/images/auto-use-during-turn.png) | ![按需加载 hindsight 工具](docs/images/tools-on-demand.png) |
| 记忆块注入到这一轮里，并在一开始就说明相关性判断规则。 | 智能体工作时按需加载 `hindsight_*` 工具。 |

![工作推进时写入并更新事实](docs/images/facts-updated-over-time.png)

工作推进的同时写入、更新事实——工具结果里会带回文档 id。

### 结果与交接

![回答引用过去的决策与日期](docs/images/past-decisions-in-results.png)

回答会引用过去的决策和根因，并带上当时的日期。

![用记忆生成的交接文档](docs/images/project-handover.png)

用记忆做项目交接：6 次事实检索合并成一份报告，479 行扩到 529 行。

## 环境要求

| | |
|---|---|
| `dsh` | 0.2.0-rc.2 或更新（`engines.dsh`） |
| Node | 20+ |
| `uv` / `uvx` | 仅默认的 `daemon` 模式需要——它通过 `hindsight-embed` 启动。用 `curl -LsSf https://astral.sh/uv/install.sh \| sh` 安装，或把插件指向你自己运行的服务。 |
| Homebrew 的 `openssl@3` | 仅 macOS 上的 `daemon` 模式需要：内嵌的 PostgreSQL 链接 `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`。`brew install openssl@3`（[brew.sh](https://brew.sh)）。 |

## 安装

**从 GitHub 安装**（源码安装，不需要 NPM 包；`prepare` 会构建两半）：

```sh
dsh plugin --profile web add github:jiangdaxia-AI/hindsight-dsh
```

**从 npm 安装**（发布之后）：

```sh
dsh plugin --profile web add hindsight-dsh
```

包内声明了 `dsh.bundle.patch`，profile 会自动拾取 Loader 行，不需要改别的。重启 dsh，或让运行中的实例通过配置监听器应用改动。

**从本地 checkout 安装**（开发用）：

```sh
pnpm install && pnpm run build
dsh plugin --profile <profile> add "$PWD"
```

**手动**（任意 profile，不用包管理器）——把这一行加进该 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: hindsight
      name: "hindsight-dsh"
```

`name` 必须是**裸包名**。写成 `hindsight-dsh/dsh` 时，宿主半能加载，浏览器半却会被静默丢弃，设置页因此不会出现。

## 快速开始

打开 **设置 → Hindsight 记忆**。第一张卡片用一个按钮完成本地记忆的全部初始化：

1. **运行时** —— 按 shell 的方式定位 `uv`；完全缺失时用官方安装脚本装上。
2. **模型** —— 依次从页面字段、环境变量、**dsh 已经在用的 provider** 解析，最后回退到 Claude Code CLI（无需 key）。key 只进入本地服务进程的环境变量——不会进浏览器、设置文档、状态或日志。
3. **服务** —— 启动分离的守护进程，并轮询 `/health` 直到它应答。

随后卡片会报告结果：就绪（给出服务地址和选中的模型），或失败（给出原因和重试）。指向 `self-hosted` 或 `cloud` 的 profile 会看到同一张卡片，按钮会切回本地服务并完成初始化。

> **建议用 flash 模型。** 事实抽取与整合是高频、短上下文的调用，用便宜、快的 **flash 系列**模型就够——例如 `qwen3.8-flash`、`hy4-flash` 等。可以在本地服务的模型字段里直接指定，也可以留空让它跟随 dsh 正在用的模型。旗舰模型每轮成本更高，但在抽取这件事上收益很小。

## 配置

所有设置都通过 profile 自己的配置补丁保存，因此能跨重启生效，并作用于该 profile 的每个会话。

| 字段 | 默认值 | 含义 |
|---|---|---|
| 启用记忆 | 开 | 关闭后所有会话都不使用记忆，也不再注册工具。 |
| 记忆存放在哪里 | 本地守护进程 | `daemon` 按需启动本机服务；`self-hosted` 连接你自己运行的服务；`cloud` 连接 Hindsight Cloud。 |
| API 地址 | — | daemon 模式下忽略；留空使用该模式的默认地址。 |
| API Token | — | 服务端要求时的 Bearer token。保存在 profile 配置里，不会回传给浏览器；留空保持已保存的值。 |
| 守护进程端口 | 9077 | 本地守护进程的端口；该端口上已有健康服务时直接采用。 |
| uv 所在目录 | — | dsh 找不到 `uv`/`uvx` 时在这里指定；留空则搜索常见安装位置。 |
| 提供方 / 接口地址 / 模型 / API key | — | **本地**服务抽取事实所用的模型。想手动指定而不让一键初始化解析时填这里。 |
| 首个提问注入 | 一次 reflect 归纳 | `reflect`、`pages`、`recall` 或 `nothing`。 |
| 把每轮对话写入记忆库 | 开 | 存储每个完成的对话轮次。 |
| 抵抗上下文压缩 | 开 | 让压缩移除的内容仍可恢复。 |
| 记录代码改动 | 关 | 每轮对改动文件产出一条基于代码的事实。 |
| 冷启动播种 | 开 | 仓库的第一次会话时，用 git 历史给它的记忆库播种。 |
| 仅限已加入的仓库 | 关 | 开启后，未列入配置的目录完全不写入。 |
| 共用记忆库 ID | — | 所有仓库共用一个记忆库；留空则按仓库各自建库。 |
| 按仓库的记忆库命名 | `coding-agent::{gitProject}` | 占位符：`{gitProject} {project} {harness} {channel} {user}`。 |
| 日志级别 | info | 详细程度，日志在 `~/.hindsight/coding-agents-logs`。 |

**优先级。** 设置页是最高层，高于 `HINDSIGHT_*` 环境变量，也高于 `~/.hindsight/coding-agent.json`——但**从第一次保存起**才生效。第一次保存之前，页面不投影任何值：手工配置的共享文件原样生效。第一次保存之后，留空的文本字段会被*省略*而不是写成空值，所以共享文件仍然提供页面没有点名的端点、token 和记忆库 ID。

**两个反射预算**刻意不放在页面上——它们是对你模型线路的测量，而不是偏好。两者都在 `~/.hindsight/coding-agent.json` 里（或用 `HINDSIGHT_REFLECT_PATIENCE_MS` / `HINDSIGHT_REFLECT_TIMEOUT_MS` 覆盖）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `reflectPatienceMs` | 5000 | 单个步骤最多等这次归纳多久。超时后该步骤改用知识页搜索作答，归纳继续在后台跑。`0` 表示从不等。 |
| `reflectTimeoutMs` | 20000 | 归纳允许花多长时间*成功*。模型线路慢时需要调到分钟级。 |

## 工作原理

```
dsh 宿主                                    浏览器
┌───────────────────────────────┐          ┌──────────────────────────────┐
│ hindsight-dsh  (dist/host.js) │          │ hindsight-dsh (lib/client.js) │
│  Config  ← Schemastery schema │          │  设置 → Hindsight 记忆        │
│  apply(ctx, config)           │          │  ctx.configForms.get(…)       │
│      │ overrides 层           │          │  ctx.slots → settings.section │
│      ▼                        │          └──────────────┬───────────────┘
│  记忆运行时（内联）            │◄────── 设置文档 ────────┘
│  召回 · 写入 · 工具            │      (profile cordis.patch.yml)
└───────────────────────────────┘
```

一个会话按事件流过记忆——每个处理器都是 fail-open 的，守护进程挂了只会少一个效果，不会毁掉这一轮：

```
会话打开 ── agent/created ─▶ 解析记忆库 · 恢复压缩账本 · 冷启动时播种
你发出提问 ── agent/pre-step ─▶ 在 reflectPatienceMs 内召回 → 注入（去重）
慢归纳完成 ── agent/pre-step（后续任一步）─▶ 此时注入一次
模型工作（可能调用 hindsight_* 工具）── session/event ─▶ 折叠账本（每次追加 O(1)）
轮次结束 ── agent/turn-stopping ─▶ 保留对话记录 · 代码事实（可选）
dsh 压缩上下文 ── session/event ─▶ 被丢弃的片段保留为 compaction:<session>:<id>
会话关闭 ── agent/disposed ─▶ 排空在途写入 · 丢弃每会话状态
```

运行时本身位于 `vendor/coding-agents/`，从
[`hindsight-integrations/coding-agents`](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents)
分叉而来，现在**就是这个包自己的源码**：改它是本仓库的普通改动，由 `scripts/pin-runtime.mjs` 守护并重新钉住（`--record`），而不是从别处同步。
## 查看记忆

记忆从外部本来是看不见的：插件往服务器上的记忆库写，智能体自己的 `hindsight_*` 工具是唯一的窗口——必须模型主动去问。另有两个入口把这些只读报告直接交给你：

- **`/hindsight`**（dsh 的 Web 客户端和 CLI 内）。它直接对智能体运行，不产生模型消息，因此查询不消耗轮次，也从不进入模型推理的上下文。
- **`hindsight-dsh`**（shell 里）。同一份代码，用于调试 dsh 本身。`dist/cli.js` 是包的 `bin` 入口，所以 `npx hindsight-dsh doctor` 也能用。

```text
/hindsight                        当前仓库：解析到的记忆库、记录、同步状态、日志路径
/hindsight banks [--all]          服务器上所有记忆库，按最近写入排序
/hindsight bank <bank_id>         单个记忆库：文档、知识页、进行中的抽取
/hindsight documents <bank_id>    文档本身：id、最后写入、来源标签
/hindsight doctor                 插件自检：绑定行、守护进程、配置、日志
```

```console
$ /hindsight
hindsight · dsh memory
  plugin    daemon · http://127.0.0.1:9077 · daemon healthy
  repo      /Users/me/work/api → coding-agent::api
  records   686 facts · 7 documents · 5 knowledge pages · last write 2026-10-14 15:01
  sync      synced · gitlog yes · deepen 12/36 · chats 4 · pages 5 · survey 2 behind · ops 0
  projects  2 bank(s) from this integration, 2 total — /hindsight banks
  config    ~/.hindsight/coding-agent.json
  logs      ~/.hindsight/coding-agents-logs
```

同样的列表也在设置页——**设置 → Hindsight 记忆 → 记忆库与诊断**——并额外提供报告刻意不做的唯一破坏性操作：删除记忆库。默认只列出本插件创建的库（`coding-agent::*`）；*显示此服务器上的所有库* 会放宽列表。服务器答不出的计数显示为 `—`，不会显示成 `0`。

有些机器 `PATH` 上没有 `node`，而 dsh 自带一个——这恰好是本插件最常调试的机器。`scripts/hindsight-dsh` 就是为此存在的：它用应用的二进制以 Node 模式跑同一套 CLI，有真实 `node` 时优先用它。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/` | 插件本体：宿主半（`host.ts`、`settings.ts`）、浏览器半（`client/`）、CLI（`cli.ts`）、初始化（`uv.ts`、`daemon-llm.ts`）。 |
| `vendor/coding-agents/` | coding-agent 记忆运行时，随树携带，构建时内联。 |
| `scripts/` | 构建、运行时钉住、打包契约检查。 |

## 开发

```sh
pnpm install
pnpm run build           # dist/host.js（宿主）+ dist/cli.js（shell 报告）+ lib/client.js（浏览器）
pnpm test                # 单元测试；不需要 dsh
pnpm run typecheck
pnpm run check-runtime   # 运行时仍与 vendor/VENDOR.json 一致，且 import 边界闭合
pnpm run record-runtime  # 有意改动 vendor/coding-agents 之后：重新钉住
pnpm run check-contract  # 构建后：manifest、产物与 `files` 一致
```

如果构建需要一个 `package.json` 里没声明的包，会在这里失败，而不是在用户第一次提问时失败。随树的运行时是*打包*而非*解析*的：安装是一次链接加一次复制，profile 的模块系统里没有需要查找的东西。

**发布**是 `pnpm run build && npm publish`。`files` 只发布 `dist`、`lib`、`cordis.patch.yml` 和本 README——不发布 `vendor/` 或 `src/`，它们是构建期产物。

## 故障排查

| 现象 | 原因 |
|---|---|
| 看不到 **设置 → Hindsight 记忆** 页面 | 浏览器半没有被提供。检查 Loader 行是否为裸包名，以及安装后的包里是否有 `lib/client.js`。 |
| 日志出现 `hindsight: memory disabled — the plugin failed to bind` | 宿主半在绑定时抛错；这是插件 bug，被报告出来而不是让应用启动失败。 |
| daemon 模式一直不应答 | `uv`/`uvx` 不在 `PATH` 上，或其内嵌 PostgreSQL 在 macOS 上加载不了 Homebrew 的 OpenSSL（`brew install openssl@3`），或本地服务没配模型。守护进程自己的日志在 `~/.hindsight/profiles/<profile>.log`。 |
| 某个会话没有记忆，但日志看起来干净 | 用 `hindsight-dsh doctor`：绑定行只在绑定**完成**时写入，它缺失（或显示 `FAILED`）本身就是故障。 |
| 首个提问卡一两分钟后才回答 | 被等待的 `agent/pre-step` 在等一个模型线路很慢的 reflect 归纳。单个步骤最多等 `reflectPatienceMs`；除非你接受这份延迟，否则不要调大。 |

插件日志是 `~/.hindsight/coding-agents-logs/plugin.log`（用 `HINDSIGHT_LOG_FILE` 覆盖），每个进程开头有一行说明生效的模式。`node dist/cli.js doctor` 不需要 dsh 在跑也能打印同样的信息。

## 许可证

MIT——见 [LICENSE](LICENSE)。记忆引擎与随树的 coding-agent 运行时来自
[Hindsight](https://github.com/vectorize-io/hindsight)（© Vectorize AI, Inc.，MIT）；dsh 插件部分 © jiangdaxia。
