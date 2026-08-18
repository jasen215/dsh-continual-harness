# dsh-continual-harness

[English](../../README.md) | 中文

DeepSeek Harness 的**自进化（continual self-refinement）插件**：单个插件为 agent 提供「持久记忆 + 定期复盘精修 + 全局共享知识 + 失败自动回滚」闭环（plan → validate → apply → rollback），并以 dsh 的插件机制（session 事件、agent 作用域事件、pre-step 瀑布、tools 服务）实现。

设计灵感来自 Prime Intellect 开源的 [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)，一个自改进的编码 harness。

## 一个插件就够

不需要拆分多个包：本插件是一个独立 npm 包（`dsh-continual-harness`），挂载后通过以下扩展点全部生效：

| 能力 | 机制 |
| --- | --- |
| 状态投影（每步注入 harness 上下文） | `agent/pre-step` 瀑布监听，按内容摘要变化增量注入 |
| 复盘与自动精修 | `session/event` 监听 turn 间隔 / 压缩结束，自动跑 LLM 评审 → 规划 → 应用 |
| 手动精修工具 | 注册 `harness_refine` 工具（LLM 可直接调用，支持回滚） |
| 会话内复盘轨迹 | 从 session 日志重建（tail-biased 截断） |
| 不变量守护 | `harness/refinement` 事件校验 + 批量 fail 上报 |

## 架构

```
src/
  domain.ts      事件声明合并（SessionEventMap / MessageSourceMap / cordis Events）
  types.ts       HarnessState / RefinementProposal / RefinementResult 等类型
  storage.ts     状态与历史的磁盘读写（原子写、损坏降级、local/global 合并、jsonl 历史）
  refine.ts      校验、应用、回滚（基线冲突检测、版本递增、内容收窄守卫）
  render.ts      面向模型的概览 / 摘要 / 历史渲染
  planner.ts     LLM 规划提示词与 JSON 解析（plan / auto-refine review 两条提示词）
  store.ts       HarnessStore：组合存储 + 事件发布（session 事件 + agent 作用域事件）
  complete.ts    completeViaAgent：经 ctx.get('llm') 调用补全
  tool.ts        harness_refine 工具
  projection.ts  pre-step 投影（digest 去重、<harness_state> 注入）
  driver.ts      自动精修驱动器（turn 间隔门 / 压缩门 / 冷却 / 防重入）
  invariant.ts   运行时不变量校验插件
  index.ts       插件入口与 Config
tests/           7 个 spec，46 个用例（storage / refine / planner / store / driver / invariant / plugin 集成）
```

### 数据布局

```
<harnessRoot>/                      默认 dsh 数据目录下 harness/（可通过 Config.harnessRoot 覆盖）
  harness_state.json                全局共享状态（跨会话）
  refinements.jsonl                 全局精修历史（追加式）
  sessions/<sessionKey>/harness/
    harness_state.json              会话本地状态（遮蔽同 id 全局条目）
    refinements.jsonl               会话精修历史
```

- 状态条目按 `prompt / memory / skill / subagent` 四类存放，均带 `version`（每次更新递增）。
- 合并视图：本地条目优先；被遮蔽的全局条目以 `local:<id>` 前缀保留可见。
- 应用时校验基线：规划期间条目被并发修改则拒绝该编辑（`entry changed during refinement planning`）。
- `base_system_prompt` 为受保护 id，任何编辑都会被拒绝。

### 经验固化协议 (ESP)

经验固化协议（Experience Solidification Protocol, ESP）是这套能力的**协议面**，与本包的实现解耦：

| 协议元素 | 载体 | 说明 |
| --- | --- | --- |
| 经验状态 schema | `harness_state.json`（`schemaVersion: 1`） | `prompt / memory / skill / subagent` 四类条目，每条含 `id / kind / version / content / updatedAt` |
| 经验历史 | `refinements.jsonl`（追加式） | 每次应用/回滚一条 `RefinementResult` 记录，按 id 可回滚 |
| 精修事件 | session 事件 `harness/refinement` | 应用/回滚时写入会话日志（model-visible ⟺ logged） |
| 精修通知 | agent 事件 `harness/refined` | payload `{agent, result}`，供不变量等插件订阅 |
| 经验注入 | 消息源 `harness-state`（携带 `digest`） | 预注入模型上下文，按摘要变化去重 |

任何 dsh 插件都可以按这套协议读写经验（写状态文件、追加历史、发布事件、注入消息）；本包是协议的**参考实现与主要消费方**（规划/精修/投影/自动门）。未来若要把经验读写抽成独立可复用协议包，可据此拆出 `dsh-esp`，harness 退化为 ESP 的一个消费方。

### 事件与消息源

- session 事件 `harness/refinement`（RefinementResult）——每次应用/回滚都写入会话日志（model-visible ⟺ logged）。
- agent 作用域事件 `harness/refined`（payload `{agent, result}`）——供不变量等其他插件订阅。
- 预注入消息 `source.kind === 'harness-state'`，携带 `digest` 供去重。

## 挂载（dsh profile）

以 `cordis.patch.yml` 形式叠加到 dsh profile（例如 `~/.dsh/profiles/<name>/cordis.patch.yml`），见仓库内 [cordis.patch.yml](../../cordis.patch.yml) 示例。patch 层必须是**顶层 YAML 数组**（`insert` 行追加插件条目，id 定向行覆盖已有条目）：

```yaml
- insert:
    - id: continual-harness
      name: dsh-continual-harness
      config:
        defaultGlobal: true
```

安装方式：

```sh
pnpm add dsh-continual-harness        # 或 link: 到本仓库源码（见下）
pnpm dsh --profile <name> "…"
```

前置要求：`tools`、`agents`、`session`、`llm`、`systemPrompt` 等能力插件先于本插件加载（插件的 `inject` 声明了依赖，未加载时挂载会延迟）。

## Config

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `harnessRoot` | dsh 数据目录 `harness/` | 状态根目录（测试用临时目录） |
| `defaultGlobal` | 必填 | 工具未显式指定 `global` 时的目标作用域 |
| `maxTrajectoryChars` | 80000 | 复盘轨迹的最大字符数（tail-biased 截断） |
| `plannerMaxTokens` | 32000 | 规划器 LLM 调用的最大 token 数 |
| `autoRefine` | `{turnInterval: 25, compact: true, cooldownMs: 1200000}` | 自动精修：turn 间隔门、压缩结束门、冷却时间、禁用开关 |

## 开发

插件自包含：`devDependencies` 锁定已发布的 `@deepseek-ai/*` 各包（rc 版本），因此 `pnpm install`、`pnpm run typecheck`、`pnpm test`（47 用例）、`pnpm run build`（tsc 产出 `lib/types/*.js + *.d.ts`，`exports` 的 `"."` 与 `"./invariant"` 指向产物）都能在干净检出下直接运行——CI 与 OIDC 发布 workflow 执行的是同一套步骤。`peerDependencies` 声明消费者（宿主 dsh 安装）必须满足的语义化版本范围。

## Known Limitations and Deferred Work

- 无真实 LLM 的端到端测试：`completeViaAgent` 依赖已加载的 `llm` 能力与 provider/model 配置，测试以 stub `Complete` 覆盖规划/评审路径；真实 e2e 需要 `DEEPSEEK_API_KEY`。
- `compaction/end` 事件不在插件类型联合内，driver 以类型收窄后的字符串比较触发；compaction 能力未加载时该门静默跳过。
- 投影去重是进程内 `WeakMap<Agent, digest>`：会话重启后首步会重新注入（无状态、幂等，但多一次注入）。
- 并发写入是 last-writer-wins：同目录多进程同时精修可能互相覆盖，规划期的基线冲突检测只能拦截「读后写」竞争，不能串行化。
- skill 条目目前只是「描述 + 参数」的文本记录，不含可执行代码；要成为可调用技能需后续接入 dsh 的 skill 注册机制。
- 自动精修失败静默降级（只记日志），不打断会话。
