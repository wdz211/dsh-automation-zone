# dsh-automation-zone 设计契约

> 目标：让「自动化任务」不再寄生在真人工作会话里。
> 决策：B 方案（每项目一个自动化会话，cwd 保持项目目录，记忆轨不变）。
> 作者：Vera · 2026-10-19 · 状态：待实现

---

## 1. 背景与硬约束（已源码实证，不可推翻）

| 事实 | 证据 |
| --- | --- |
| 工作区是**按 cwd 派生的视图**，不是可自由分组的容器 | `dsh-workspace/lib/index.js:103` `sessionIds` getter 按 `sessionPath(id) === record.path` 过滤 |
| 已存在会话**无法迁移**到另一个工作区 | `Workspace.attachSession` 在 `cwd !== this.record.path` 时直接 throw（同文件 114–128 行） |
| 归档与 active 任务互斥 | `dsh-schedule` 的 `workspace/session-activity` 把「挂 active 任务」上报为活动；`archiveSession` 非 `stopActivity` 时抛 `WorkspaceActiveSessionError` |
| 带 `stopActivity` 的归档会**停掉该会话全部任务** | `workspace/session-stop` → `stopSessionTasks(sessionId)` |
| cwd 决定记忆轨 | `projectHash(cwd) = sha1(cwd).slice(0,12)` |

**结论**：只能「新建一个 cwd = 项目目录的专用会话」，把任务建在它上面。这样：
- 它天然属于该项目的工作区（cwd 一致）；
- 记忆轨与项目一致，`memory.consolidate` / 蒸馏类任务照常工作；
- 真人工作会话不再被任务钉住，可自由归档。

---

## 2. 服务契约（来自运行时 Service 目录，逐字核对过）

### 2.1 sessionController

```ts
create(request: {
  workspaceId?: WorkspaceId   // 与 cwd 互斥
  cwd?: string
  sessionId?: SessionId       // 省略则自动生成（且不做持久化身份校验）
  agentPreset?: string
}): Promise<{ sessionId: SessionId; agentPreset?: string }>

inspect(sessionId, signal?): Promise<{
  meta: SessionHeader           // 含 id / cwd / createdAt / agentPreset
  inheritedEventCount: number
  events: SessionEvent[]
}>
```

- `inspect` **不会激活 Agent**，适合做存在性探测。
- 会话不存在时 `inspect` 会 reject —— 用它判断"记录里的会话还在不在"。

### 2.2 schedule

```ts
create(sessionId, request: {
  title: string                        // 必填，空白/超长 → invalid_prompt
  prompt: string
  after_seconds?: number
  at?: string | { date: string; time: string; time_zone: string }
  every_seconds?: number
  daily?: { time: string; time_zone: string }
  weekly?: { time: string; time_zone: string; weekdays: number[] }
  cron?: { expression: string; time_zone: string }
}, signal?): Promise<ScheduleRecord>

list({ sessionId }): Promise<ScheduleRecord[]>        // 只返回 active
catalog(): Promise<Array<ScheduleRecord & {
  sessionId: SessionId
  status: 'active' | 'inactive'
  lastDelivery?: { scheduledAt, deliveredAt, messageId }
}>>                                                    // 全量，含 inactive
delete({ sessionId, id }, signal?): Promise<{ id, deleted: boolean, code? }>
```

- **selector 必须恰好给一个**，给两个抛 `invalid_selector`。
- `create` 不会激活会话。

### 2.3 tools.register

```ts
register(definition: {
  name: string
  description: string
  parameters: Record<string, unknown>       // JSON Schema
  output: {
    schema: JsonSchemaNode
    render(args, value): ContentBlock[]     // 必填，缺了直接抛
  }
  execute(args, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args): boolean
}): () => void
```

- 同名冲突（同层）会抛 —— 工具名不得与现有工具重名。
- `render` 返回 `ContentBlock[]`，最简形态 `[{ type: 'text', text: '...' }]`。

### 2.4 systemPrompt

```ts
section({ name, order, text, interpolate? }): () => void   // text 必须是静态字符串
context({ name, order, text }): () => void                 // text 可为函数，但会经插值
```

- 注入**静态文本**用 `section({ interpolate: false })` 最安全（框架级免插值）。
- **插值扫描器的起点是 `text.indexOf("{{")`**（`dsh-system-prompt/lib/index.js:157`），只认完整的 `{{name}}` 组
  （`GROUP_AT = /^\{\{([^{}]*)\}\}/`）。**只有单个 `{`、或者写 `{name}`，都是纯字面文本**，原样保留、不抛。
  会抛的只有三类：`{{` 之后找不到 `}}`（malformed）、组名不合法、组名合法但未注册或值为 undefined。
- 所以中和要针对 **`{{`**，不是针对 `{`：`neutralizeBraces` 把连续的 `{` 拆成 `{ {`，
  扫描器再也找不到 `{{` 起点，整段原样返回。任何动态/数据驱动文本走 `context` 时必须过这一步
  （否则会话在组装期直接 throw 致死）。

### 2.5 事件

- `schedule/changed`：任务被创建/删除/更新时触发。用于巡检。

---

## 3. 插件行为规范

### 3.1 状态文件

路径（可配置 `stateFile`）：`<os.homedir()>/.dsh-beta/automation-zone.json`

```json
{
  "version": 1,
  "zones": {
    "<cwd 原样字符串>": {
      "sessionId": "session-...",
      "createdAt": "2026-10-19T13:00:00.000Z",
      "title": "⚙ 自动化任务"
    }
  },
  "throttle": {
    "<cwd 原样字符串>": { "streak": 2, "lastSpokeAt": 1690000000000 }
  },
  "tasks": {
    "<scheduleId>": { "enabled": true, "streak": 2, "lastSpokeAt": 1690000000000, "note": "可选" }
  }
}
```

- **cwd 用原始字符串做 key**（不做路径规范化：DSH 的记忆轨就是按原串哈希的，规范化会造成两套数据）。`zones` 与 `throttle` **两节都是**。
- **`tasks` 的 key 是 `scheduleId`，不是 cwd**（刻意的）：一条 cwd 上可以挂多个定时任务，而闸门的连没中曲线是**每个任务一条**——
  拿 cwd 做键会让同一项目下的两个任务共享同一条曲线，掷骰结果互相污染。
- `tasks` 的每条记录只认四个字段：`enabled`（**严格 `=== true` 才算开**，脏值一律按关）、`streak`（安全整数 ≥ 0）、
  `lastSpokeAt`（正数毫秒或 null）、可选 `note`（非空字符串）。`taskEntryOf()` 对**没有记录**的 key 返回 `undefined`，
  **不造默认值**——调用方靠「有没有这条记录」区分「没登记」（零行为变化）与「登记了但关着」（要告警）。
- 写入必须原子：写 `<file>.tmp` → `fs.rename`。
- 读状态文件分**三档**，与 `loadState()` 的实现逐字对应（不要把它简化成「只有 ENOENT 才当空表，其余一切都不写」——
  中间那一档是自愈，允许写回）：

  | 档 | 情形 | `loadState()` 行为 | 带 `readError`？ | 写盘方 |
  | --- | --- | --- | --- | --- |
  | ① | **ENOENT**（文件不存在） | 退空表，**不记 warn** | 否 | **可以**写回（首次运行 / 有意重建） |
  | ② | **能解析、但结构异常**（`zones` 不是表、条目缺 `sessionId`…） | 走 `normalizeState` **自愈**：坏条目丢弃、`zones` 非表则当空表，`throttle` 不连带丢 | 否 | **可以**写回（这是自愈路径，不是「盘上内容未知」） |
  | ③ | **读不到**（EACCES / EBUSY / EISDIR / EIO…）**或 JSON 解析失败**（半截文件、手改坏） | 退空表，记 warn | **是** | **必须 fail-closed**：放弃写入，**不得崩溃、也不得拿空表写回去覆盖**（那会把别的项目的 zones + throttle 整表删掉） |

- ③ 的 `readError` 要能定位：**含文件路径 + 真实原因**；解析失败另加**出错位置附近的一小段原文**（不要整份打出来）。
  读失败档曾经只透出 `error.message`（形如 `EISDIR: illegal operation on a directory, read`，**不带路径**），
  用户拿着它不知道该修哪个文件，所以现在两档统一成 `cannot read|parse state file <path>: <reason>` 的骨架。
- `serialize()` 是**白名单重建**：新增任何一节都必须在 `emptyState` / `normalizeState` / `serialize` 三处同时出现，
  以及任何重建整份 state 的 upsert（`upsertZone` / `upsertThrottle` / `upsertTask`）都必须把**其它**几节原样带过去。
  漏一处不会报错，只会表现为「写一次之后那一节静默消失」。

### 3.2 确保自动化会话（ensureZoneSession）

输入：`cwd: string`
输出：`{ sessionId, created: boolean, title }`

流程：
1. 读 stateFile，取 `zones[cwd]`。
2. 有记录 → `sessionController.inspect(record.sessionId)`：
   - 成功且 `meta.cwd === cwd` → 复用，`created: false`
   - 失败或 cwd 不符 → 视为失效，走步骤 3
3. `sessionController.create({ cwd })`（**不传 sessionId**，让系统生成；不传 agentPreset，走默认）→ 得到新 id
4. 写回 stateFile
5. **幂等**：并发调用同一 cwd 时必须串行（内存 Promise 队列按 cwd 去重）

> 为什么不用「按标题找会话」：标题由 LLM 生成，不可靠且可能被用户改。sidecar 记录是唯一真源。

### 3.3 工具：automation_task_create

参数（JSON Schema）：

```jsonc
{
  "type": "object",
  "properties": {
    "title":        { "type": "string", "description": "任务名称，必填" },
    "prompt":       { "type": "string", "description": "到点要执行的指令" },
    "daily":        { "type": "object", "properties": { "time": {"type":"string"}, "time_zone": {"type":"string"} }, "required": ["time","time_zone"] },
    "weekly":       { "type": "object", "properties": { "time": {"type":"string"}, "time_zone": {"type":"string"}, "weekdays": {"type":"array","items":{"type":"integer"}} }, "required": ["time","time_zone","weekdays"] },
    "every_seconds":{ "type": "integer" },
    "after_seconds":{ "type": "integer" },
    "at":           { "type": "string" },
    "cron":         { "type": "object", "properties": { "expression": {"type":"string"}, "time_zone": {"type":"string"} }, "required": ["expression","time_zone"] }
  },
  "required": ["title", "prompt"]
}
```

执行：
1. 校验 selector：六个里**恰好一个**，否则返回 `{ ok:false, code:'invalid_selector' }`
2. `cwd` 取自调用者会话：`exec.agent.id` → `sessionController.inspect(...).meta.cwd`；取不到 → `cwd` 参数兜底；仍没有 → 报错 `no_cwd`
3. `ensureZoneSession(cwd)`
4. `schedule.create(zoneSessionId, { title, prompt, ...selector })`
5. 返回 `{ ok:true, taskId, sessionId, created, title }`

错误处理：`schedule.create` 抛出的 `ScheduleToolError` 必须原样透出 `code` 与 `message`，不得吞掉。

### 3.4 工具：automation_zone_status

无参数。返回：

```jsonc
{
  "ok": true,
  "zones": [
    { "cwd": "...", "sessionId": "...", "exists": true,
      "tasks": [ { "id": "...", "title": "...", "kind": "daily", "status": "active" } ] }
  ],
  "orphans": [                       // 落在非自动化会话上的 active 任务
    { "taskId": "...", "title": "...", "sessionId": "...", "cwd": "..." }
  ]
}
```

`orphans` 用于一眼看出"还有哪些自动化任务寄生在别处"。

**状态文件读不出来时（读失败 / JSON 解析失败）不给结论**：此时 `zones: []` 与 `orphans: []`
只是「没读出来」的副产物，**不等于**「没有自动化会话 / 没有孤儿任务」——孤儿判据的输入正是
zone 清单，清单空了会把本该在 zone 会话里的任务反过来指成寄生。所以这一档返回值另带

```jsonc
{ "ok": true, "zones": [], "orphans": [], "stateUnreadable": { "error": "cannot parse state file <path>: …" } }
```

渲染层见到 `stateUnreadable` 只输出诊断（明说清单与孤儿判定都不可信、不要据此判断会话是否消失），
**不再输出**「还没有任何自动化会话」。没有这个字段时（ENOENT / 合法文件）渲染输出与以前逐字相同。

### 3.5 系统提示注入（injectRule，默认 true）

静态 section，`interpolate: false`，内容：

```
### 自动化任务（定时任务）

创建周期性/定时任务的**唯一正确入口是 `automation_task_create` 工具**，不要用 `schedule_create`。

原因：`schedule_create` 会把任务绑到当前会话上，导致该会话被判定为「有活动」而无法归档，
并且任务会和真人对话历史混在一起。`automation_task_create` 会自动定位/创建本项目的
「⚙ 自动化任务」专用会话，把任务建在那里——工作会话因此可以随时归档。

例外：用户明确要求「就在这个会话里提醒我」时才用 `schedule_create`。
```

### 3.6 巡检（可选，默认开启只读）

监听 `schedule/changed` → 计算 orphans → 有变化时**只记日志**（不自动迁移）。
自动迁移会改变用户语义（任务被搬走、旧任务被停），必须是人拍板的动作。

### 3.7 日志

统一前缀 `automation-zone:`。激活期日志**不要**藏在 debug 开关后面（否则失败全程静默）。

### 3.8 工具：automation_proactive_gate（主动开口判定器，**默认关闭**）

**它是判定器，不是触发器。** DSH 的 schedule 由内核到点触发，插件**拦不住**「这一轮该不该真跑」——
所以「掷骰节流」在这台机器上只能做成「真开口之前先问一次门」：工具回答 `speak` / `hold` / `blocked`，
**不自己发消息、不自己 followup、不动任何会话**。调用方（模型或别的插件）拿到 `speak` 后自己开口，
开口成功再调一次 `action=record` 把冷却起点记下来。

**默认关闭**（`throttle.enabled: false`）。开启之后**不改变任何既有任务行为**：`automation_task_create` /
`automation_zone_status` / 巡检 / 注入文本全部照旧，判定器只是多出来的一道可选闸门。

**与上游 `dsh-speak-up` 的关系：只迁机制，不装那个插件。** 迁过来的是它的判定内核
（峰谷判档、命中线公式、时机因子、安静时段、掷骰口径），代码在本插件 `src/throttle.js`；
那个插件自带的触发器、设置页、日志本、`agent.followup` 调用一律没有跟过来。

参数：

```jsonc
{
  "type": "object",
  "properties": {
    "action":     { "type": "string", "enum": ["check", "record", "gated"], "description": "check=问门；record=真开口之后记一笔；gated=把某个定时任务登记为闸门对象" },
    "cwd":        { "type": "string", "description": "可选：项目目录（缺省按调用者会话解析）" },
    "sessionId":  { "type": "string", "description": "可选：用哪个会话算「距上次说话」" },
    "scheduleId": { "type": "string", "description": "gated 必填：要登记/取消登记的定时任务 id" },
    "gated":      { "type": "boolean", "description": "gated 用：true（缺省）=登记；false=取消登记（删键）" },
    "note":       { "type": "string", "description": "gated 用：可选备注，写进注入文本帮助模型认出这条任务" }
  },
  "required": ["action"]
}
```

`check` 的执行顺序（**硬闸顺序与上游一致，不可换**）：

1. `enabled !== true` → `blocked / disabled`
2. 安静时段（`quietFrom` ~ `quietTo`，**支持跨午夜**；起 === 止 表示不启用）→ `blocked / quiet-hours`
3. 冷却（`lastSpokeAt` 存在且 `now - lastSpokeAt < cooldownMinutes`）→ `blocked / cooldown`
4. 才掷骰：`roll = Math.random()`（0~1），`掷值 = roll × 100`；`掷值 >= 线` → `hold / miss`，否则 `speak / hit`

**三种 `blocked` 都不得改动 `streak`，而且一行都不写盘。**

判定口径（与上游逐条对齐）：

```
tier   = 峰时（周一~周五 09:00–12:00 / 14:00–18:00，含起不含止；周末全天谷）/ 谷时
base   = tier === peak ? peakLine : valleyLine
factor = 距上次说话 < nearThresholdMinutes → nearFactor
       | 距上次说话 > farThresholdMinutes  → farFactor
       | 其它（含"拿不到时间"）            → 1
line   = clamp(base × factor + min(bonusCap, streak × missBonus), 0, 100)   // 先乘因子、再加加成
```

- `speak` → 写回 `streak = 0`（掷中清零）
- `hold` → 写回 `streak = streak + 1`（没中攒加成）
- `record` → 只把 `lastSpokeAt = now` 写回，`streak` 不动

返回（节选）：`{ ok, action, decision, code, cwd, tier, base, factor, bonus, line, nextLine, roll, streak,
lastSpokeAt, minutesSinceLastUserMessage, equation, reason, wrote }`。`blocked` 时没有 `roll`，`wrote: false`。

失败一律 `{ ok:false, code, message }`，不抛：

| code | 含义 |
| --- | --- |
| `invalid_action` | `action` 不是 check / record / gated |
| `invalid_schedule_id` | `gated` 时 `scheduleId` 为空 |
| `no_cwd` / `cwd_not_found` | 与 `automation_task_create` 同一套 cwd 解析口径（**`gated` 不需要 cwd**，它按 scheduleId 记账） |
| `state-unreadable` | 状态文件读不出来**或解析失败** → **拒绝写入**（否则会把别的项目的记录整表覆盖掉） |
| `gate_failed` | 其它内部错误 |

`gated` 的语义（**这是把判定器从"被动工具"变成"服务端准入层"的那一步**）：

- `gated: true`（缺省）→ 在 `state.tasks[scheduleId]` 写一条 `{ enabled: true, ... }`；
- `gated: false` → **删键**，不是写一条 `enabled:false`（「没登记」与「登记了但关着」是两种语义，见 3.10）；
- 重复登记**不清零** `streak` / `lastSpokeAt`（沿用已有值；`note` 缺省也保留原值）；
- 返回 `{ ok, action:"gated", scheduleId, gated, throttleEnabled, gatedTaskCount, wrote }`。
  `throttleEnabled=false` 时 `render` 会额外警示「判定器当前是关的」——登记了却不生效是最容易踩的空转。

配置（`throttle` 节，默认值唯一真源在 `src/throttle.js` 的 `THROTTLE_DEFAULTS`，patch 里不重复写）：
`enabled=false` / `peakLine=20` / `valleyLine=60` / `missBonus=10` / `bonusCap=40` / `quietFrom=1` /
`quietTo=8` / `nearThresholdMinutes=20` / `nearFactor=0.15` / `farThresholdMinutes=360` / `farFactor=1.5` /
`cooldownMinutes=20` / `intervalMinutes=30`（只作记录——本插件不自带定时器）/ `dryRun=true`（只作记录——
判定器不负责开口）。

### 3.9 会话历史读缓存（`minutesSinceLastUserMessageOf`，**不加配置项**）

`check` 每次都会 `sessionController.inspect(sessionId)`，而 `inspect` 会把该会话的**全部历史事件
物化一遍**。按「每轮问一次门」的用法，那就是每轮一次 O(全会话事件)。所以这一层加了**进程内读缓存**，
同一会话在 TTL 内只读一次。

| 项 | 取值 / 规则 |
| --- | --- |
| TTL 默认值 | **60 秒**，导出常量 `INSPECT_CACHE_TTL_MS = 60_000`（`src/tools.js`） |
| 键 | **`sessionId`**，不是 cwd（一个 cwd 可能对应多个会话，切换会错配且没有任何报错） |
| 上限 | **64 条**，超出按 Map 插入顺序淘汰最旧一条；命中也刷新顺序（**LRU 而不是 FIFO**） |
| 新鲜度判据 | **只用调用方传入的 `nowMs`**（`nowMs - atMs < ttlMs`），不读裸 `Date.now()` |
| 配置项 | **不提供**。TTL 不做成 `throttle` 里的字段——那会新增一个配置面（校验、默认值、文档），而 60 秒这个量级对分钟级判据几乎没有信息损失 |

**为什么命中时返回的是「缓存时刻算出的分钟数」，而不是按 now 重算**（这是这层唯一一处会改变结论的地方）：

```
分钟数变大 → 时机因子变大（≤20 分钟 0.15 … ≥360 分钟 1.5）
           → 命中线 base × factor + bonus 变高
           → point >= line 判「没中」越难 → 更容易开口
```

所以缓存陈旧时若按 now 重算，就会出现「用户刚说完话、却以为很久没说话」——**往危险方向偏**。
原值返回则它永远是**下界**（真实间隔只会更长不会更短），方向恒为保守（宁可少开口），误差上限 = TTL。

**两种 `undefined` 都不写缓存**（否则一次失败会被记住整整一个 TTL）：

- `inspect` 抛异常 → 返回 `undefined`，不缓存；
- `inspect` 成功但会话里找不到真人消息 → 返回 `undefined`，不缓存。

理由：`undefined` 会让时机因子按 1（中性）算，而真实值可能极小（刚说过话 → 0.15）——
把 undefined 记下来等于在这一段时间里持续把结论推向激进侧。

对外导出（后两个只给测试用，命名带 `__` 前缀表明是内部形态）：`minutesSinceLastUserMessageOf`、
`INSPECT_CACHE_TTL_MS`、`__resetInspectCache`、`__inspectCacheSize`。`check` 的调用点**不带 opts**，
走默认 TTL；`opts.ttlMs` 只给测试注入用（`0` 或负数 = 每次都真的 inspect）。

### 3.10 定时任务闸门注入（`src/gateinject.js`，**服务端准入层**）

`automation_proactive_gate` 原本是**被动工具**：只有模型主动调它才会被问一次门。而定时任务恰恰是
「没人盯着、到点自己醒」的那一类，模型完全可以不调、直接照原任务开工——于是「闸门」形同虚设。

这一层把同样的判定内核接到**内核必经的一条路径**上：`systemPrompt.context`。

```
dsh-schedule 到点 → agent.followup(framing) → session.append("agent/inbox/spliced")
   → pre-step → step 里 append user/message → 组装 prompt（systemPrompt.context 每轮都跑）
   → 若那条 user 消息是 schedule 投递 且 该 scheduleId 已登记 → 注入一行「通过门 / 被拦下」结论
```

**接线（全部在 `index.js`，三处）**：

| 位置 | 干什么 |
| --- | --- |
| `ctx.on("session/event", (session, event) => injector.observe(session?.id, event))` | 记「本会话最后一条 user 消息是什么来源」（`user/message` 与 `agent/inbox/spliced` 两条都认） |
| `ctx.on("agent/pre-step", (payload) => injector.rememberBatch(payload?.messages))` | 补认领：覆盖「插件激活晚于投递」的小窗口。**只读，返回 undefined**（返回值会被持久化进会话日志 = 伪造历史） |
| `systemPrompt.context({ name: "automation-zone:schedule-gate", order: 2960, text })` | 真正注入。`text` **必须同步**（框架不 await），所以判定只能做在内存态上 |

**判据链（每一步取不到就 fail-open 返回空串，绝不让原任务变哑）**：

1. 本会话最后一条 user 消息的 `source.kind === "schedule"`，或它的正文里出现 `[SCHEDULE REMINDER]` /
   `[SCHEDULE REMINDER BATCH]` 首行（**双路**：kind 是上游实现细节，改个名字只认 kind 的闸门就会静默失效）；
2. 从 framing 里取出 `schedule_id_json` / `reminders_json`（按括号配对切，兼容二次转义）；
3. `state.tasks[id].enabled === true`（**没登记 = 零行为变化**，不判定也不告警）；
4. `throttle.enabled === true`（否则只喊一次 warn，不注入、不记账）；
5. `readError` 存在 → 不判定、**不写盘**、喊一次 warn；
6. 距上次**真人**消息的分钟数（**取不到返回 `null` 而不是 0**，0 会把命中线压到极低 → 几乎必然放行）；
7. `decide()` → 同一轮同一条消息只掷一次（`decisions` 备忘，上限 256，同轮绝不重掷）；
8. 非 `blocked` 时写回 `streak`；**`lastSpokeAt` 只在 `action=record`（真开口）时推进**——闸门放行 ≠ 已经开口；
9. 渲染**一行**文本：放行写「命中线 / 掷值 / 连续没中 + 按原任务正常执行」；拦下写中文原因 +
   「本轮静默收尾」的**动作清单**（不产出对外内容、不发通知、不写业务文件、不调工具）。

**诚实边界（必须一起读，否则会高估它）**：

- **它是软门，拦不住内核到点启动这一轮。** DSH 的 schedule 由内核触发，插件没有「拦下这一轮」的钩子。
  它能做的只是**在这一轮的提示里写清「你被拦下了，请静默收尾」**，真正照做靠模型遵守。
  「静默收尾」的清单必须显式列出动作，因为只说"被拦下"时模型最常见的反应是"那我简短汇报一下"——那照样是一次对外产出。
- **插件激活晚于投递时，那一步缺注**（`pre-step` 已经在跑、`session/event` 没看到过这条消息）→ 记为 fail-open，
  **不猜**它属于哪个会话（猜错会把结论注入到别的会话里）。
- **不做 inspect 异步预热兜底**：`context.text` 是同步调用的，任何 Promise 都救不了这一步。
  唯一能缓存的异步读（`sessionController.inspect`）已经在 3.9 那一层了，且只服务 `check`。
- `throttle.enabled=false` 时**已登记的任务也不注入**（只喊一次 warn）：默认装上去零行为变化是硬约束。
- 注入文本**必须**过 `neutralizeBraces`（context 文本会经插值，`{{` 会让会话直接废掉），
  且**只在出口中和一次**——两处都做会造出「删掉任何一处测试都不红」的死角（实测过）。

对外导出（给测试与复用）：`parseScheduleOrigin`、`minutesSinceLastHumanMessage`、`renderGateNote`、
`describeGateCode`、`isHostInjectedUserMessage`、`sourceKindOf`、`messageTextOf`、`sessionIdOfContext`、
`createGateInjector`、`GATE_CONTEXT_NAME`、`GATE_CONTEXT_ORDER`、`GATE_NOTE_TAG`、`SCHEDULE_SOURCE_KIND`、
`FRAMING_SINGLE`、`FRAMING_BATCH`、`HOST_INJECTED_SOURCE_KINDS`。

### 3.11 会话轮换与任务迁移（`src/rotation.js` + `src/zone.js`）

**要治的病**：§3.2 的复用判据只有「会话在 + cwd 相符 + 未归档」，**没有体积上限**。于是自动化会话被
无限复用，涨到十几 MB / 近百轮后 compaction 压不动——定时任务**投递成功，回合却跑不出结果**，
连一个 `agent.failed` 都没有（实测：12.4 MB / 91 轮，日志里只剩投递那一行）。这类静默失效
不治本，就只能靠人隔几个月去翻会话文件大小。

**触发判据（`zone.js` 的 `resolve()`，按顺序）**：

| # | 情形 | 行为 |
| --- | --- | --- |
| 1 | 会话不存在 / `cwd` 不符 / `inspect` 抛 | 新建，**不迁移**（没有可信的旧会话） |
| 2 | `isArchived(会话)` 为真 | 换新会话 **+ 迁移**（归档会话里的任务用户已经看不见了，迁走才是修复） |
| 3 | `shouldRotate(会话)` 抛错 / 返回非对象 | **fail-open 复用**，记 warn（一条度量读不出来不许让会话凭空重建） |
| 4 | `shouldRotate` 返回 `rotate !== true` | 复用（§3.2 原路径不变） |
| 5 | `shouldRotate` 返回 `rotate === true` | 换新会话 **+ 迁移** |

返回值在 §3.2 的 `{sessionId, created, title, warning?}` 上**增加**（不轮换时不带这两个键）：
`{ rotated: true, rotation: { from, to, reason, bytes?, migrated: number, failed: [...], gateRemapped: number } }`。

**为什么按字节，不按轮数**：轮数要么现数——`sessionController.inspect()` 会把整个会话日志
**物化一遍**（正是想避开的那笔开销，对 12 MB 会话尤其致命）；要么自己维护计数器——重启即丢，
而且和真实体积差着数量级（一条投递带几千字 prompt，轮数涨得比字节慢得多）。
字节是同一件事的直接度量，`sessionPersistence.stat(id).sizeBytes` 只读 `.zstd` 物理尺寸，近乎免费。

配置（`rotation` 节，默认值唯一真源在 `index.js` 的 `ROTATION_DEFAULTS`，patch 里不重复写）：

| 键 | 默认 | 语义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（只有字面 `false` 才关） |
| `maxSessionBytes` | `4_000_000` | 超过就换档（只认有限正数） |
| `checkIntervalMinutes` | `360` | 周期体检；**`0` = 关**（所以这一项接受 0） |
| `onBoot` | `true` | 激活时先体检一次（`void` 起，不阻塞 apply） |

体检 = 对每个已知 cwd 主动跑一次 `zone.ensure(cwd)`（串行，单个失败只 warn）。它**不需要第二套判据**：
判据全在 `ensure` 里；不主动跑，判据就永远等到「下次有人建任务」才生效，而已经哑火的会话可能几天都没人来建任务。

**迁移为什么是 delete + create，不是改绑**：`dsh-schedule` **没有改绑 `sessionId` 的 API**——
`update()` 只接受 record，`sessionId` 是**查询键**（`@deepseek-ai/dsh-schedule/lib/index.js:2198`）。
所以只能：`catalog()` 取 record → `selectorFromRecord()` 重建 selector → `create(新sessionId, …)` → `delete({旧sessionId, id})`。

`selectorFromRecord` 的映射（`timeZone`→`time_zone`、`everySeconds`→`every_seconds`）与
**一次性任务的处理**：`at` / `after` 不照搬绝对时刻（多半已过期），转成
`after_seconds = ceil((scheduledAt - now)/1000)`——任务在新会话上仍在同一时刻触发。
**剩余 ≤ 0（已过期）一律不迁移**，返回 `{ok:false, code:'overdue_oneshot'}` 记进 `failed`：
旧任务可能已被 drive 投递过，按「剩 1 秒」重建就是同一件事重复外发，宁可由人看一眼。
不认识的 kind / 缺字段 / 坏时间 → `{ok:false, code:'unsupported_record'}`，**不抛**。

**闸门登记改键**：`state.tasks` 的 key 是 **scheduleId**（§3.1）。任务重建后新 id 在表里没有登记，
那条任务就从「登记了、按掷骰节流」静默退回「没登记、零行为变化」。所以真迁过一条就必须把整条
记录（`enabled` / `streak` / `lastSpokeAt` / `note`）原样搬到新键并删旧键，**整批只写一次盘**；
`stateReadError(state)` 有值（读失败）时**放弃写盘**，`gateRemapped` 如实为 0 并 warn。

**失败语义（每一条都是「不许静默」）**：

- **先建后删**：建失败 = 任务没迁走但一条都没丢（旧任务照常触发）；反过来先删后建，中途一炸就是任务消失。
- **单条失败只进 `failed`**，绝不中断其余任务、绝不抛（含 `catalog()` 抛错 → `ok:false` + `catalog_failed`）。
- **删失败 / 删被拒**：新任务已建、旧的还在 → 同一件事会在两个会话上各触发一次。这条**必须 warn 并写明新旧两条 id**，
  并进 `failed`（用户会看到任务重复执行，日志里必须查得到是哪两条）。
- **`migrate` 整个抛错**：仍然切到新会话，只把原因放进返回值 `warning`。新会话是健康的，
  留在超大会话里等于必然再炸一次。
- **量不到体积**（`sessionPersistence` 缺失 / `stat` 抛错 / 没有 `sizeBytes`）→ `{rotate:false}`，**只 warn 一次**。
  拿猜出来的体积去换会话，比完全不换更糟。

**旧会话不归档、不删除**：它可能还装着用户要翻的历史，归档/删除是用户的动作（§6）。
轮换只留一行 info（旧 id → 新 id、reason、字节数、迁了几条、闸门改键几条）+ 一句「任务已迁走，可自行归档」。

---

## 4. 验收标准

| # | 断言 | 判据 |
| --- | --- | --- |
| A1 | 首次调用 `automation_task_create` 会新建一个 cwd = 调用者 cwd 的会话 | 返回的 `sessionId` 能在 `inspect` 里查到且 `meta.cwd` 一致 |
| A2 | 第二次调用复用同一个会话 | 两次返回 `sessionId` 相同，`created` 分别为 true/false |
| A3 | 任务确实绑定在自动化会话上 | `schedule.catalog()` 里该任务 `sessionId === zoneSessionId` |
| A4 | 原会话不被污染 | 原会话上 `schedule.list` 为空 |
| A5 | selector 恰好一个 | 传两个返回 `invalid_selector`，不落库 |
| A6 | 状态文件原子写 + 可恢复 | 删除 stateFile 后再调用会新建会话，不报错 |
| A7 | 状态文件损坏不崩 | 写入非法 JSON 后调用不抛错；记 warn 且 **放弃写入**（不给别的项目整表覆盖），返回值里带 `warning`/`state-unreadable` |
| A8 | 注入文本不触发插值致死 | 注入内容含 `{` 时，会话仍能正常组装 prompt |
| A9 | 并发同 cwd 只建一个 | 同时 5 个调用，最终 stateFile 里只有一个 sessionId |
| A10 | 巡检能识别 orphan | 手工在别的会话建一个任务，status 里出现在 orphans |
| A11 | 判定器默认关闭 | 未配 `throttle.enabled` 时 `check` 返回 `blocked / disabled`，且状态文件不被写 |
| A12 | 三种硬闸都不动记账 | `disabled` / `quiet-hours` / `cooldown` 后 `streak` 与 `lastSpokeAt` 与调用前逐字相同 |
| A13 | 掷骰记账正确 | 注入 roll=0.2（掷中）→ streak 清零；roll=0.99（没中）→ streak +1 |
| A14 | throttle 节不会被写丢 | `saveState` → `loadState` 之后 `throttle` 节仍在（`serialize` 漏字段必红） |
| A15 | 会话历史读缓存只在 TTL 内复用 | 同一 `sessionId` 在 60 秒内连续 3 次（now 每次 +1s）只 `inspect` 1 次且三次返回值逐字相同；`ttlMs: 0` 时 3 次 → 3 次 inspect；两种 `undefined`（异常 / 无真人消息）都不缓存，下次仍会 inspect |
| A16 | 消息来源双路识别 | `kind=schedule` 的消息与「没有任何 kind、只有 framing 文本」的消息都判为定时任务，且都能取出 `scheduleId`（只认 kind 会在上游改值时静默失效） |
| A17 | 没登记 = 零行为变化 | 未登记 `scheduleId` 时 `render()` 返回空串、`saveState` 调用 0 次、日志 0 行 |
| A18 | 登记但判定器关着 | 返回空串、不写盘，但**必须有**一行 warn（登记了却不生效不能静默） |
| A19 | 状态读不出来 | `render()` 返回空串、`saveState` 调用 0 次、有 warn（写回空表 = 删别人的记录） |
| A20 | 同一轮绝不重掷 | 同一 `sessionId` 同一条消息连续两次 `render()` 返回逐字相同的结果，且第二次不写盘 |
| A21 | `tasks` 节不会被写丢 | `saveState` → `loadState` 之后 `tasks` 一节仍在，`note` 也保留（`serialize` 白名单漏一节必红） |
| A22 | 脏数据 fail-closed | `enabled` 为 `"true"` / `1` / `{}` / `[]` 时一律按关：不注入、不写盘；`normalizeTaskEntry` 把它们洗成 `enabled:false` |
| A23 | 注入文本永不废掉会话 | 输出单行、**不含连续 `{{`**；`scheduleId` / `note` 里的花括号被拆开但内容保留 |
| A24 | 判定时钟可注入 | 同一套用例换任意时刻（峰时 / 谷时 / 跨午夜）结论一致（`now` 与 `random` 都必须可注入，只注入一个是按小时引爆的雷） |

---

## 5. 安装与生效（运维须知）

1. 源码目录：`plugins/dsh-automation-zone`
2. `plugin_manager install_bundle target="file:<绝对路径>"`（本机 pnpm 对 file: 是**复制**安装，改源码不影响运行态）
3. `plugin_manager install_bundle` 对已存在包返回 `ambiguous-install`，**不能用它刷新**
4. 改代码后必须：备份运行态副本 → 覆盖 `.dsh-beta/profiles/desktop/node_modules/@local/dsh-automation-zone/` → **重启 DSH**（host 半边不热载）
5. 判断是否生效：`cordis_inspect_query` 的 Tool.listTools 里出现 `automation_task_create`

---

## 6. 已知不做的事

- 不自动迁移**别人的**任务（巡检发现孤儿只记日志）；自动化会话内因轮换而迁移见 §3.11（那是唯一例外，且必须先建后删）
- 不修改 `dsh-schedule` / `dsh-workspace` 的源码（升级即丢）
- 不改会话头的 cwd（会连带换掉记忆轨与历史路径）
- 不碰 `archivedSessionIds`（归档动作留给用户/`workspaceRegistry`）
- **不装 `dsh-speak-up`**：只把它的判定内核（`src/throttle.js`）迁进来，不要它的触发器/设置页/日志本
- **判定器不自己开口**：不发消息、不 followup、不建会话。它只回答"这次该不该开口"，
  真开口是调用方的事——插件在 DSH 里拦不住 schedule 到点触发，假装能拦就是自欺
