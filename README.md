# dsh-automation-zone

> Route scheduled tasks to a per-project automation Session (cwd = project dir); keep the human work Session archivable.

## 这是什么

DSH 里「定时任务」和「会话归档」天生打架：

- 工作区是**按 cwd 派生的视图**（会话按 `sessionPath(id) === record.path` 过滤），已存在的会话**无法迁移**到别的工作区；
- 而 `schedule.create` 只能把任务绑到**当前会话**上。任务一旦挂上去，那个会话就被判定为「有活动」，
  归档时直接抛 `WorkspaceActiveSessionError` —— 于是为了留着几条提醒，人被迫留着整个会话。

这个插件把定时任务从真人工作会话里**摘出来**：按项目懒创建一个 `cwd = 项目目录` 的专用会话
（默认标题「⚙ 自动化任务」），任务全部建在那里。它的工作区归属、记忆轨（`sha1(cwd)[0:12]`）都与项目一致，
所以 `memory.consolidate` 这类按项目跑的任务照常工作；真人工作会话从此可以随时归档。

顺带补上三个缺口：**看得见**（哪些任务寄生在普通会话上）、**修得回**（一键把孤儿任务迁回去）、
**说得出为什么**（要不要真开口，先问一次门）。

## 前置条件

**这是 DeepSeek Harness Desktop 的插件，不是独立 npm 库。** 它需要宿主注入这几个服务：

| 服务 | 用来做什么 |
|---|---|
| `tools` | 注册四个工具 |
| `schedule` | `create` / `catalog` / `delete`，读写定时任务 |
| `sessionController` | `inspect()` 读会话、`create({cwd})` 懒建自动化会话 |
| `workspaceRegistry` | 判断会话是否已被归档（缺它就**不注册任何工具**并喊出来，不带着半可用状态上线） |
| `systemPrompt` / `agent` 事件 | 定时任务闸门的注入点（`session/event` + `agent/pre-step` + `systemPrompt.context`） |

Node.js ≥ 22。

## 安装

本机 pnpm 对 `file:` 是**复制**安装，所以插件目录与运行态副本是两份；`install_bundle` 对已存在的包还会返回
`ambiguous-install`。第一次安装与后续更新是两条路：

```powershell
# 首次安装：把目录放进 profile 的 node_modules（junction 或复制）
#   <dsh-home>\profiles\desktop\node_modules\@local\dsh-automation-zone
#   然后在 profile 的 cordis.patch.yml 里加下面这一条
```

```yaml
- insert:
    - id: automation-zone
      name: '@local/dsh-automation-zone'
      config:
        enabled: true
        stateFile: ''                      # '' → <homedir>/.dsh-beta/automation-zone.json
        zoneSessionTitle: '⚙ 自动化任务'   # 只写进 sidecar 记录，不改会话本身的标题
        injectRule: true                   # 注入「定时任务请用 automation_task_create」的静态提示
        patrol:
          enabled: true                    # 巡检只读：只在日志里报告孤儿任务，绝不自动迁移
```

生效判据：`Tool.listTools` 里出现 `automation_task_create`。**host 半边不热载**，改完要重启 DSH。

## 配置

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关（关掉 = 一个工具都不注册） |
| `stateFile` | string | `''` → `<homedir>/.dsh-beta/automation-zone.json` | sidecar 状态文件 |
| `zoneSessionTitle` | string | `'⚙ 自动化任务'` | 写进 sidecar 的会话标题（不改真实会话标题） |
| `injectRule` | boolean | `true` | 是否注入静态系统提示（`interpolate:false`，不做插值） |
| `patrol.enabled` | boolean | `true` | 是否监听 `schedule/changed` 报孤儿（只记日志） |
| `throttle.*` | object | 见下 | 主动开口判定器的参数（**默认 `enabled:false`**） |

`throttle` 的唯一真源是 `src/throttle.js` 的 `THROTTLE_DEFAULTS`，patch 里**只写要覆盖的项**：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 关着时判定器照样注册，`check` 会如实回答 `blocked / disabled` |
| `peakLine` / `valleyLine` | `20` / `60` | 峰时 / 谷时的命中线 |
| `missBonus` / `bonusCap` | `10` / `40` | 每没掷中一次加多少、最多攒到多少 |
| `quietFrom` / `quietTo` | `1` / `8` | 安静时段（小时，含起不含止；起 === 止 = 不启用，支持跨午夜） |
| `nearThresholdMinutes` / `nearFactor` | `20` / `0.15` | 距上次说话很近 → 命中线压到 15% |
| `farThresholdMinutes` / `farFactor` | `360` / `1.5` | 隔得久 → 命中线抬高 |
| `cooldownMinutes` | `20` | 自己开口之后的冷却（0 = 不冷却） |
| `intervalMinutes` / `dryRun` | `30` / `true` | **只作记账/给调用方参考**：本插件不自带定时器，也不负责开口 |

## 对外能力

| 工具 | 入参 | 行为 |
|---|---|---|
| `automation_task_create` | `title`、`prompt`、六选一的定时方式（`daily` / `weekly` / `every_seconds` / `after_seconds` / `at` / `cron`）、可选 `cwd` | 校验 selector（六个恰好一个）→ 取 cwd → 确保自动化会话 → `schedule.create`。日常首选它而不是 `schedule_create` |
| `automation_zone_status` | 无 | 每个项目的自动化会话是否还在、挂了哪些任务；列出寄生在普通会话上的孤儿任务。每条 zone 带 `cwdMatches` / `archived` / `tasksError` |
| `automation_zone_repair_tasks` | 可选 `fromSessionId`、`cwd`、`dryRun` | 把孤儿任务迁回它所属项目的自动化会话。不给 `fromSessionId` 就按同一套孤儿口径自动找全部；`dryRun:true` 只列计划 |
| `automation_proactive_gate` | `action`（`check` / `record` / `gated`）、可选 `cwd` / `sessionId` / `scheduleId` / `gated` / `note` | 主动开口判定器：`check` 回答 `speak` / `hold` / `blocked`；`record` 记冷却起点；`gated` 把某条定时任务登记为闸门对象 |

此外还有两个**非工具**的行为：

- **系统提示注入**：一条静态 section，告诉模型「定时任务请用 `automation_task_create`」；
- **定时任务闸门**：已登记的定时任务到点时，服务端在那一轮的提示里注入一行「通过门 / 被拦下 + 静默收尾清单」。

## 状态文件

sidecar：`<homedir>/.dsh-beta/automation-zone.json`（可配 `stateFile`），原子写（`<file>.tmp` + `rename`）：

```jsonc
{
  "version": 1,
  "zones":   { "<workspace>": { "sessionId": "session-…", "createdAt": "2026-10-19T13:00:00.000Z", "title": "⚙ 自动化任务" } },
  "throttle":{ "<workspace>": { "streak": 2, "lastSpokeAt": 1690000000000 } },
  "tasks":   { "sched-每日早报-0001": { "enabled": true, "streak": 2, "lastSpokeAt": 1690000000000, "note": "周一早报" } }
}
```

两条硬规矩：

- **cwd 用原始字符串当 key，不做任何路径规范化**（`zones` / `throttle` 两节；`tasks` 的 key 是 scheduleId）——
  DSH 的记忆轨就是按原串哈希的，规范化会造出两套数据；
- **「读不到」≠「空表」**。`loadState` 读失败（EACCES / EBUSY / 半截 JSON）会带 `readError`，写盘方见到它就**放弃写入**，
  只在返回值里给 `warning` / `code: "state-unreadable"`。只有 **ENOENT** 才当空表。
  代价是坏文件期间不会自愈、需要人修一次；换来的是「一次坏文件不会把其它项目的 zones + throttle 整表覆盖掉」。

## 主动开口判定器

三件事先说清楚：

1. **它是判定器，不是触发器。** DSH 的 schedule 由内核到点触发，插件**拦不住**「这一轮该不该真跑」，
   所以「节流」只能做成「真开口之前先问一次门」：工具回答 `speak` / `hold` / `blocked`，
   它**不自己发消息、不自己 followup、不建会话**。调用方拿到 `speak` 后自己开口，开口成功再 `action=record`。
2. **默认关闭，且不改变任何既有行为。** 关着时两个老工具、巡检、注入文本全部照旧。
   唯一例外要说清：`action="record"` 在关着时**仍会写** `throttle` 节里本 cwd 的 `lastSpokeAt`（`streak` 原样带过），
   不碰 `zones`。真正一行都不写盘的是 `check` 被硬闸拦下的情形。
3. **只迁机制，不装上游插件。** 迁过来的是掷骰节流内核（峰谷判档、命中线公式、时机因子、安静时段），
   自带的触发器、设置页、日志本、`agent.followup` 一律没有跟过来。

判定口径：

```
tier   = 峰时（周一~周五 09:00–12:00 / 14:00–18:00，含起不含止；周末全天谷）/ 谷时
base   = 峰时 → peakLine(20)，谷时 → valleyLine(60)
factor = 距上次说话 < 20 分钟 → 0.15 | > 360 分钟 → 1.5 | 其它（含拿不到）→ 1
line   = clamp(base × factor + min(bonusCap, streak × missBonus), 0, 100)   // 先乘因子、再加加成
掷值   = random() × 100；掷值 >= line → 没中（streak+1）；否则掷中（streak=0）
```

硬闸顺序（不可换）：`enabled` → 安静时段（支持跨午夜）→ 冷却 → 才掷骰。
**三种 blocked 都不动 `streak`，也一行都不写盘。**

`check` 读会话历史带一层进程内缓存：同一会话 60 秒内复用上次的读数。缓存**只会让结论更保守** ——
命中时原样返回缓存时刻算出的分钟数、不按 now 重算（重算会让分钟数变大 → 因子变大 → 更容易开口）。

## 定时任务闸门

判定器原来是「被动工具」：模型完全可以不调它、直接照原任务开工。所以还有一层把它接到内核**必经**的路径上：
`systemPrompt.context`（每轮组装 prompt 都会跑）。用法只有一步 —— 把某个定时任务登记进来：

```jsonc
{ "action": "gated", "scheduleId": "sched-每日早报-0001", "note": "周一早报" }
{ "action": "gated", "scheduleId": "sched-每日早报-0001", "gated": false }   // 取消（删键）
```

登记之后，那个任务每次到点被投递进来时，提示里会多**一行**结论：

- 通过门：`[自动化闸门] 本次定时任务通过门（命中线 20 / 掷值 13 / 连续没中 0 次）：按原任务正常执行，该产出就产出。`
- 被拦下：`[自动化闸门] 本次定时任务被拦下（…）：本轮静默收尾——不要产出任何对外内容、不要发通知、不要写业务文件、不要调用其它工具，说完一句结束语就结束。`

**没登记的任务完全不受影响**（不判定、不注入、不写盘、不记日志）。`tasks` 一节按 `scheduleId` 记账，
所以同一项目下多个任务各有各的连没中曲线。

### 它到底能拦到什么程度（诚实边界，别高估）

- **它是软门。** 插件**没有**「拦下这一轮」的钩子，能做的是在提示里写清「你被拦下了，请静默收尾」，
  真正照做靠模型遵守。所以清单必须列**动作**（不产出、不发通知、不写业务文件、不调工具）——
  只说「被拦下」时，模型最常见的反应是「那我简短汇报一下」，那照样是一次对外产出，等于白拦。
- **插件比投递晚激活时，那一步没有注入**：认不出消息属于哪个会话就如实跳过并记一行 warn，**不猜**
  （猜错会把结论注入到别的会话里）。这是 fail-open，原任务照常执行。
- **不做异步预热兜底**：`context.text` 是同步调用的，Promise 救不了当前这一步。
- 判定器关着时，**已登记的任务也不注入**，只喊一次 warn。登记完发现「没反应」，第一件事看返回里的 `throttleEnabled`。

## 已知限制

- **自动化会话无轮换会膨胀到爆上下文，致任务静默失败。** 修的时候必须**同时改 `schedule.json` 的 sessionId** ——
  只改 `automation-zone.json` 无效。
- **没有「改绑 sessionId」的 API**：会话轮换与「记录的会话坏掉 → 新建并迁移任务」都走
  `create 新任务 + delete 旧任务`，所以**迁移后任务 id 全换**。
- **`repair_tasks` 读不到 cwd 时会全部跳过**：不给 `fromSessionId` 时按任务所属会话的 `meta.cwd` 决定迁去哪；
  该会话已 corrupt、读不到 `meta.cwd` 就不猜 —— 这时要显式给 `fromSessionId` + `cwd`。
- **孤儿判据只把明确 `inactive` / `disabled` 的任务排除在外**，缺失 `status` 一律视为 active。
  （`schedule.json` 把 `status` 存在 table entry 上、不在 `record` 里；用 `record.status === "active"` 判会让
  孤儿列表恒为空，工具与巡检静默给出「无孤儿」的假结论 —— 已修，测试锁死。）
- **`cwd` 兜底参数要求「已存在的目录」**：`sessionController.create({cwd})` 内部会 `mkdir -p`，
  模型编一个路径就会凭空建目录、还多出一条记忆轨。不通过时返回 `cwd_not_found`。
- **复用判据比直觉更严**：`meta.cwd === cwd` 之外，会话还必须**没被归档**。指向已归档会话时会 warn 并新建可见会话 ——
  否则任务会静默落进用户看不见的会话里，而这正是本插件要消灭的失效方式。
- **`tasksError` 存在时 `tasks: []` 不代表没有任务**：会话读不到与任务列表读不到是两段独立失败，渲染会分开说。
- **巡检不调 `collectZoneStatus`**：`schedule/changed` 是热路径，`inspect()` 会返回该会话全部事件。
  巡检只用 `schedule.catalog()` 算孤儿，代价是巡检日志里的孤儿条目不带 cwd。
- **先到先得，不做事务**：两个调用同时为同一个 cwd 建会话时按 cwd 去重串行，但跨进程没有锁。
- **判定器的随机数与时钟都从外面注入**（`createProactiveGateTool({ random, now })`）：生产走默认，
  测试靠它把结果钉死 —— 这也是为什么断言「命中线是多少」的用例必须传 `now`（峰时 20 / 谷时 60 会让同一用例上下午两个答案）。

## 开发

```bash
node --test "test/*.test.mjs"    # 12 个文件、135 例，全部离线、零外部依赖
node test/run-all.mjs            # 同一套用例的汇总入口（打印每文件通过数）
node test/mutation-check.mjs     # dry-run：只校验每条变异的 from 仍恰好命中一次
node test/mutation-check.mjs --apply   # 真跑：把实现逐处改坏 → 测试必须变红 → 逐字节恢复（副本运行，仓库只读）
```

测试夹具都在 `os.tmpdir()` 下建临时目录；`test/_harness.mjs` 里有一条守卫专门断言**真实状态文件没被碰**。

```
index.js           入口：读 config → 注册工具 → 注入提示 → 挂巡检
src/storage.js     sidecar 读写（原子写、损坏容错、zones/throttle/tasks 三节纯 upsert）
src/selector.js    定时方式校验与归一化（纯函数，无 IO）
src/prompt.js      注入文本 + neutralizeBraces（防插值把文本当模板）
src/zone.js        ensureZoneSession（注入式，按 cwd 去重串行）
src/throttle.js    判定器纯函数内核（峰谷 / 因子 / 命中线 / 安静时段 / 掷骰）
src/tools.js       四个工具定义工厂 + 状态收集
src/rotation.js    会话轮换与任务迁移（create 新 + delete 旧）
src/gateinject.js  定时任务闸门：framing 解析 + 结论渲染 + 注入器（host 半边）
docs/CONTRACT.md   设计契约（逐条行为约定与边界，代码与它不一致时以 README 的「已知限制」为准）
docs/PROACTIVE-SPEAK-THROTTLE.md   判定器口径的推导与来源
```

## 许可

MIT，见 [LICENSE](LICENSE)。本仓库不含第三方代码，因此没有 ATTRIBUTION.md。
