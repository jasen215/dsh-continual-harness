# dsh-continual-harness

[English](../../README.md) | 中文

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/dsh-continual-harness"><img src="https://img.shields.io/npm/v/dsh-continual-harness?cacheSeconds=86400" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-22+-339933.svg" alt="Node Version">
  <img src="https://img.shields.io/badge/typescript-6.0+-3178C6.svg" alt="TypeScript">
  <a href="https://github.com/jasen215/dsh-continual-harness/actions/workflows/ci.yml"><img src="https://github.com/jasen215/dsh-continual-harness/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/dsh-continual-harness"><img src="https://img.shields.io/npm/dm/dsh-continual-harness?cacheSeconds=86400" alt="npm downloads"></a>
</p>

DeepSeek Harness 的**自进化（continual self-refinement）插件**：单个插件为 agent 提供「持久记忆 + 定期复盘精修 + 全局共享知识 + 失败自动回滚」闭环（plan → validate → apply → rollback）。

设计灵感来自 Prime Intellect 开源的 [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)，一个自改进的编码 harness。

## 核心能力

一个独立 npm 包（`dsh-continual-harness`），挂载后通过以下扩展点生效：

| 能力 | 机制 |
| --- | --- |
| 状态投影（每步注入 harness 上下文） | `agent/pre-step` 瀑布监听，按内容摘要变化增量注入 |
| 复盘与自动精修 | `session/event` 监听 turn 间隔 / 压缩结束，自动跑 LLM 评审 → 规划 → 应用 |
| 手动精修工具 | 注册 `harness_refine` 工具（LLM 可直接调用，支持回滚） |
| 手动精修命令 | 可选的 `/refine` 斜杠命令，宿主提供 `commands` 能力（`@deepseek-ai/dsh-commands`）时注册 |
| 记忆生命周期 | 通过精修元数据手动 archive/unarchive/pin；已归档条目不会注入，也不会物化为 skill |
| 排序注入 | 从最近一条有效 direct-user 消息取查询（最多 400 字符），标题命中优先于内容命中，再按更新时间和 id 稳定排序，并按 kind 限额 |
| 会话收尾 | 可选 `harness_wrapup` 工具机械给出 keep/promote/archive 建议；promote 只复制，冲突返回确定性错误 |
| 会话内复盘轨迹 | 从 session 日志重建（tail-biased 截断） |
| 不变量守护 | `harness/refinement` 事件校验 + 批量 fail 上报 |

## 架构

```
src/
  domain.ts      事件声明合并（SessionEventMap / MessageSourceMap / cordis Events）
  types.ts       HarnessState / RefinementProposal / RefinementResult 等类型
  storage.ts     状态与历史的磁盘读写（原子写、损坏降级、local/global 合并、jsonl 历史）
  refine.ts      校验、应用、回滚（基线冲突检测、版本递增、增长率上限）
  skills.ts      SKILL.md 渲染 + 文件协调（生成的 skill 是真正的 dsh skill）
  render.ts      面向模型的概览 / 摘要 / 历史渲染（排序注入）
  usage.ts       注入遥测 key 与内存中的使用统计聚合
  wrapup.ts      确定性的会话收尾建议（keep/promote/archive）
  planner.ts     LLM 规划提示词与 JSON 解析（plan / auto-refine review 两条提示词）
  store.ts       HarnessStore：组合存储 + 事件发布（session 事件 + agent 作用域事件）
  complete.ts    completeViaAgent：经 ctx.get('llm') 调用补全
  benchmark.ts   基准用例/快照 + 基准 store 原子持久化
  evaluate.ts    隔离的逐 cell 执行器/评审器评估（evidence + score）
  score.ts       代码拥有的聚合与 ACCEPTED/REJECTED 决策
  tool.ts        harness_refine / harness_wrapup / harness_benchmark 工具
  projection.ts  pre-step 投影（digest 去重、<harness_state> 注入）
  driver.ts      自动精修驱动器（turn 间隔门 / 压缩门 / 冷却 / 防重入）
  invariant.ts   运行时不变量校验插件
  index.ts       插件入口与 Config
tests/           23 个测试文件，287 个用例（storage / store / refine / rules / planner / driver / approval / audit / logfile / skills / invariant / plugin 集成 / rank / projection / archive / usage / wrapup / benchmark / evaluate / score / isolation / tool / benchmark 集成）
```

### 数据布局

```
<harnessRoot>/                      ESP 共享经验根目录，默认 ~/.dsh/harness/
  harness_state.json                全局共享状态（ESP）
  refinements.jsonl                 全局精修历史（追加式，ESP）
  reviews.jsonl                     跨批次 gate/审计历史（ESP 扩展）
  continual-harness.log             continual-harness 实现日志（JSONL、0600）
  continual-harness.log.1           continual-harness 日志轮转文件
  usage.events.jsonl                追加式注入遥测（首次访问时惰性加载到内存）
  sessions/<sessionKey>/
    harness_state.json              会话本地状态（遮蔽同 id 全局条目）
    refinements.jsonl               会话精修历史
```

- **skill 是真正的 dsh skill**：应用的 skill 编辑会物化为 `<name>/SKILL.md` 目录束（含溯源 metadata）写入 `Config.skillsDir`，删除/回滚保持同步，不会碰同目录用户自有的 skill。

### 经验固化协议 (ESP)

经验固化协议（Experience Solidification Protocol, ESP）是这套能力的**协议面**，与本包的实现解耦：

| 协议元素 | 载体 | 说明 |
| --- | --- | --- |
| 经验状态 schema | `harness_state.json`（`schemaVersion: 1`） | `prompt / memory / skill / subagent` 四类条目，每条含 `id / kind / version / content / updatedAt` |
| 经验历史 | `refinements.jsonl`（追加式） | 每次应用/回滚一条 `RefinementResult` 记录，按 id 可回滚 |
| 精修事件 | session 事件 `harness/refinement` | 应用/回滚时写入会话日志（model-visible ⟺ logged） |
| 精修通知 | agent 事件 `harness/refined` | payload `{agent, result}`，供不变量等插件订阅 |
| 经验注入 | 消息源 `harness-state`（携带 `digest`） | 预注入模型上下文，按摘要变化去重 |

任何 dsh 插件都可以按这套协议读写经验（写状态文件、追加历史、发布事件、注入消息）；本包是协议的**参考实现与主要消费方**（规划/精修/投影/自动门）。

## 挂载（dsh profile）

发布到 npm，一行安装到 profile：

```sh
dsh plugin --profile <name> add dsh-continual-harness
```

包声明了 `dsh.bundle`，因此 `dsh plugin` 会把它作为 profile 层安装并应用其 `cordis.patch.yml`。升级用 `dsh plugin --profile <name> update dsh-continual-harness@latest`。

手动叠加（发布前，或固定本地检出）：把 [cordis.patch.yml](../../cordis.patch.yml) 应用到 profile，如 `~/.dsh/profiles/<name>/cordis.patch.yml`；patch 层必须是**顶层 YAML 数组**（`insert` 行追加插件条目，id 定向行覆盖已有条目）：

```yaml
- insert:
    - id: continual-harness
      name: dsh-continual-harness
      config:
        defaultGlobal: true
```

前置要求：`tools`、`agents`、`session`、`llm`、`systemPrompt` 等能力插件先于本插件加载（插件的 `inject` 声明了依赖，未加载时挂载会延迟）。

## Config

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `harnessRoot` | dsh 数据目录 `harness/` | 状态根目录（测试用临时目录） |
| `skillsDir` | `$DSH_HOME/skills` | skill 条目物化为 dsh SKILL.md 目录束的目录（dsh 用户 skill 根） |
| `defaultGlobal` | 必填 | 工具未显式指定 `global` 时的目标作用域 |
| `maxTrajectoryChars` | 80000 | 复盘轨迹的最大字符数（tail-biased 截断） |
| `plannerMaxTokens` | 32000 | 规划器 LLM 调用的最大 token 数 |
| `autoRefine` | `{turnInterval: 25, compact: true, cooldownMs: 1200000}` | 自动精修：turn 间隔门、压缩结束门、冷却时间、禁用开关 |
| `requireGlobalApproval` | `false` | 全局写入提交前是否要求显式人工审批（保守模式） |
| `maxInjectedEntriesPerKind` | `6` | 每个 kind 排序注入的正整数上限（步长 1，最小值 1） |
| `wrapupEnabled` | `true` | 是否注册可选的 `harness_wrapup` 会话收尾工具 |
| `diagnosticsEnabled` | `true` | 每次精修提交后是否运行结构化（L2）诊断 |
| `securityEnabled` | `false` | 是否启用本地安全（凭据模式）诊断提供方 |
| `auditReviews` | `true` | 每个 gate 裁决追加到 harness 根目录 `reviews.jsonl` |
| `logToFile` | `true` | 把 harness 日志持久化到 `continual-harness.log`（JSONL、`0600`、轮转） |
| `logMaxBytes` | `5242880`（5 MB） | harness 日志文件轮转上限 |
| `maxEntryGrowth` | `0.5` | 单次提交条目增长率上限；`0` 关闭检查 |
| `protectedKinds` | `['skill']` | 自动路径不可修改的 kind（预留；实际生效的是条目级 `protection`） |
| `benchmark` | `{enabled: true, defaultRuns: 1, maxRuns: 3, passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0}` | 显式 `harness_benchmark` 工具：每例每侧迭代次数、运行上限、仅报告的通过线、非回归容差、候选失败 cell 上限 |

## 精修（Refining）

两个入口：`harness_refine` 工具（LLM 调用）与 `/refine` 斜杠命令（宿主提供 `commands` 能力时可用）。

**`harness_refine`** —— `mode: 'plan'`（默认）按指令规划并原子提交；`mode: 'rollback'` 传入 `rollbackId` 并显式指定 `--local` / `--global` 作用域，回滚已提交的精修。`requireGlobalApproval: true` 时全局写入需人工审批。

**`/refine`** —— 与工具同语义，面向人工输入：

```sh
/refine --local 聚焦未决问题
/refine --global <指令>
/refine rollback <id> --local
/refine rollback <id> --global
```

裸 `/refine` 以默认作用域规划。输出：`status`、`scope`、`refinement`、`applied`、`rejected`、`summary`，启用时附 `diagnostics:` 行。

## 治理（Governance）

所有写入路径都经过三道把关：**影响面最小化**（固定契约校验；`update`/`delete` 必须携带一行 `reason`；`maxEntryGrowth` 限制单次提交增长）、**合法性硬拒**（`base_system_prompt` 与受保护条目不可变；`local` 精修期间全局条目只读）、**必要性软把关**（被否决的评审不会进入 store）。每个已提交的精修都可按 id 回滚。

全局写入**默认零审批**；设置 `requireGlobalApproval: true` 则先询问用户。实时查看插件日志：

```sh
tail -f ~/.dsh/harness/continual-harness.log
```

## Benchmark

验证层**显式且单一入口**：一个 `harness_benchmark` action 工具驱动整个流程，且绝不会自动触发精修——benchmark 路径上没有任何东西会发起 `harness_refine` 或自动 gate，`REJECTED` 决策也只报告与记录，永不回滚。store 位于 `<harnessRoot>/benchmark/`（见上文数据布局）。

最小流程是 `new → add-case → freeze → capture-reference → apply refinement → run → status`（冻结用例不可变且有哈希；`status` 列出用例、快照与近期运行）。其中两步有真正的细节：

- `capture-reference` 必须**先于**你要验证的精修执行：候选态之后由*捕获的参考快照 + 恰好该精修*推导，改动后再捕获会让增量无法证明。
- `run` 针对参考快照做指定精修的 A/B 评估（`reference_snapshot_id` + `refinement_id`）。候选必须是**单一指定增量**——由参考快照加该精修记录的应用编辑推导，并在评估前于代码中证明；漂移或多次变更的候选会被拒绝（`benchmark:run:candidate-delta`）。两侧以相同顺序运行同一批冻结用例，使用相同的 `runs`/`provider`/`model`。

`run` 返回代码拥有的决策（`src/score.ts`），而非模型裁决：

```json
{
  "action": "run",
  "ok": true,
  "run_id": "run-...",
  "refinement_id": "refine-1",
  "status": "ACCEPTED",
  "reference_overall": 70,
  "candidate_overall": 90,
  "regression_cases": [],
  "failed_cells": 0,
  "feedback": ["reference ok", "candidate better"],
  "auto_rollback": false,
  "runs": 1,
  "cells": 2
}
```

- 每个 cell 的分数为 `0..100`；失败的 cell 记 `score: null`——失败永不计为 `0`——并从总体均值中排除。
- `passThreshold`（默认 `60`）**仅作报告**：它从不决定是否接受。只有当两侧都有可用 cell、候选失败 cell 数在 `maxFailedCells` 内、且总体与逐用例回归都不超过 `regressionTolerance`（默认 `0`）时，run 才是 `ACCEPTED`。
- 每次 run 都会把完整记录（含执行器 evidence 的 cells + 决策）追加到 `benchmark/runs.jsonl`；评估只读捕获的快照、只写这一条记录，绝不触碰 `reviews.jsonl`、harness 状态、注入遥测或 skill 文件。

## 开发

插件自包含：`devDependencies` 锁定已发布的 `@deepseek-ai/*` 各包（rc 版本），因此 `pnpm install`、`pnpm run typecheck`、`pnpm test`、`pnpm run build`（tsc 产出 `lib/types/*.js + *.d.ts`，`exports` 的 `"."` 与 `"./invariant"` 指向产物）都能在干净检出下直接运行——CI 与 OIDC 发布 workflow 执行的是同一套步骤。`peerDependencies` 声明消费者（宿主 dsh 安装）必须满足的语义化版本范围。

## Known Limitations and Deferred Work

- 无真实 LLM 的端到端测试：`completeViaAgent` 依赖已加载的 `llm` 能力与 provider/model 配置，测试以 stub `Complete` 覆盖规划/评审路径；真实 e2e 需要 `DEEPSEEK_API_KEY`。
- `compaction/end` 事件不在插件类型联合内，driver 以类型收窄后的字符串比较触发；compaction 能力未加载时该门静默跳过。
- 投影去重是进程内 `WeakMap<Agent, digest>`：会话重启后首步会重新注入（无状态、幂等，但多一次注入）。
- 并发写入是 last-writer-wins：同目录多进程同时精修可能互相覆盖，规划期的基线冲突检测只能拦截「读后写」竞争，不能串行化。
- 自动精修失败静默降级（只记日志），不打断会话。
- 内容收缩守卫（限制单次 update 把条目收缩到阈值以下）是待办跟进项，尚未实现；当前只有 `maxEntryGrowth` 限制条目增长。
- 专门的治理工具入口推迟实现。
