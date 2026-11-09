/**
 * @local/dsh-automation-zone — Host 插件入口（只做接线）。
 *
 * 解决的问题（契约 §1，源码实证）：工作区是按 cwd 派生的视图，已存在会话无法迁移；
 * 而 `schedule.create` 会把任务绑到**当前会话**上，于是那个会话被
 * `workspace/session-activity` 判为“有活动”，不能归档。真人工作会话因此被
 * 定时任务钉死。
 *
 * 解法（B 方案）：给每个项目懒创建一个 cwd = 项目目录的「⚙ 自动化任务」专用会话，
 * 任务全部建在那里。工作区的归属、记忆轨（sha1(cwd)）都因此保持不变。
 *
 * 这里只做四件事：读 config → 注册 2 个工具 → 注入静态提示 → 挂 schedule/changed 巡检。
 * 业务逻辑在 src/ 里，全部可脱离 DSH 单元测试。
 */

import { LOG_PREFIX, defaultStateFile, loadState, saveState } from "./src/storage.js";
import { ZONE_SESSION_TITLE, createEnsureZoneSession } from "./src/zone.js";
import {
  collectOrphans,
  createProactiveGateTool,
  createRepairTasksTool,
  createTaskCreateTool,
  createZoneStatusTool,
  zoneSessionIdsOf,
} from "./src/tools.js";
import { normalizeThrottle } from "./src/throttle.js";
import { createTaskMigrator } from "./src/rotation.js";
import {
  GATE_CONTEXT_NAME,
  GATE_CONTEXT_ORDER,
  createGateInjector,
  sessionIdOfContext,
} from "./src/gateinject.js";
import {
  INJECT_RULE_TEXT,
  INJECT_SECTION_NAME,
  INJECT_SECTION_ORDER,
  renderInjectRule,
} from "./src/prompt.js";

/** 插件身份（Loader 用它与 patch 行对应）。 */
export const name = "automation-zone";

/**
 * 硬依赖。
 *
 * 为什么这几个都声明、而 `webServer` 不声明：本插件不用 HTTP，声明一个用不上的服务
 * 只会让“这个 profile 没有它”变成激活失败。反过来，它们只要缺一个，插件就没有
 * 任何有意义的半可用状态（没有 tools 就装不了工具；没有 schedule 建不了任务；
 * 没有 sessionController 定不了 cwd/建不了会话；没有 systemPrompt 就没有路由提示；
 * 没有 workspaceRegistry 就判断不了「记录的会话是不是已被归档」，只能复用一个
 * 用户已经藏起来的会话——那正是本插件要消灭的静默失效），
 * 所以它们必须是硬依赖 —— 让 Loader 保证顺序，而不是在 apply 里赌 ctx.get 非空。
 */
export const inject = ["tools", "schedule", "sessionController", "systemPrompt", "workspaceRegistry"];

/** 巡检去抖窗口：一次操作可能连发多次 schedule/changed。 */
const PATROL_DEBOUNCE_MS = 750;

/**
 * 汇总「已归档会话」集合。
 *
 * 本机 DSH 的归档集合在 **registry 级**：`workspaceRegistry.archivedSessionIds`
 * （dsh-workspace/lib/index.js:504，registry-global，跨工作区共享；WorkspaceEntity
 * 只暴露 path / title / createdAt / updatedAt / sessionIds）。
 * 所以这里先读 registry 级，再把 `list()` 里每个 workspace 自带的
 * `archivedSessionIds`（如果某个版本/实现形态把它挂在 workspace 上）并进来——
 * 两种形态都兼容，不会因为少认一种就静默返回空集（那会让「已归档仍被复用」复活）。
 * @param {unknown} workspaceRegistry
 * @param {{warn?: Function}|undefined} [log]
 * @returns {Set<string>}
 */
export function archivedSessionIdsOf(workspaceRegistry, log) {
  const ids = new Set();
  const add = (value) => {
    if (!Array.isArray(value)) return;
    for (const id of value) if (typeof id === "string" && id.length > 0) ids.add(id);
  };
  if (workspaceRegistry === null || typeof workspaceRegistry !== "object") return ids;
  const warn = (message) => {
    if (log !== undefined && log !== null && typeof log.warn === "function") log.warn(`${LOG_PREFIX} ${message}`);
  };
  try {
    // 这个 getter 在 registry 还没启动时会抛（`workspace registry is not started yet`）。
    // 读不到就退化成“没有已归档会话”，绝不能因此让工具本身失败。
    add(workspaceRegistry.archivedSessionIds);
  } catch (error) {
    warn(`无法读取 registry 级归档集合（${error instanceof Error ? error.message : String(error)}）`);
  }
  let workspaces = [];
  try {
    workspaces = typeof workspaceRegistry.list === "function" ? workspaceRegistry.list() : [];
  } catch (error) {
    warn(`无法枚举工作区（${error instanceof Error ? error.message : String(error)}）：归档判定只能靠 registry 级集合`);
    workspaces = [];
  }
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) add(workspace?.archivedSessionIds);
  return ids;
}

/**
 * 会话轮换的默认值（唯一真源，patch 里不重复写同样的语义）。
 *
 * 4 MB 不是拍的：自动化会话里每条投递都带着完整 prompt（几千字），几十条就能到几 MB，
 * 而实测 12.4 MB / 91 轮之后 compaction 已经压不动、回合跑不出结果。取 4 MB 是在
 * 「换会话有成本（任务要迁、历史被切成两段）」与「太晚换等于已经哑火了」之间的位置。
 */
export const ROTATION_DEFAULTS = {
  enabled: true,
  maxSessionBytes: 4_000_000,
  checkIntervalMinutes: 360,
  onBoot: true,
};

/** 只认有限正数：字符串 "8000000"、NaN、Infinity 一律退回默认（脏值不许把保护关掉）。 */
function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 归一化 `rotation` 节。
 *
 * `checkIntervalMinutes` 单独宽容一格：`0` 是**合法值**（= 关掉周期体检），
 * 所以它只否定「负数/非数」，不像另外两个字段那样只认正数。
 * `enabled` / `onBoot` 只有字面 `false` 才关（与本文件其它开关同一口径：
 * 缺省值必须是「保护开着」，不能让一份脏数据把它关掉）。
 * @param {unknown} raw
 */
export function normalizeRotation(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const interval = source.checkIntervalMinutes;
  return {
    enabled: source.enabled !== false,
    maxSessionBytes: positiveNumber(source.maxSessionBytes, ROTATION_DEFAULTS.maxSessionBytes),
    checkIntervalMinutes:
      typeof interval === "number" && Number.isFinite(interval) && interval >= 0
        ? interval
        : ROTATION_DEFAULTS.checkIntervalMinutes,
    onBoot: source.onBoot !== false,
  };
}

/**
 * 配置归一化。
 *
 * 默认值单点放在这里（不在 cordis.patch.yml 里再写一遍同样的语义），否则
 * “改了代码不生效”与“改了配置没生效”会变成两个都查不出来的问题。
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === "object" ? raw : {};
  const patrol = config.patrol !== null && typeof config.patrol === "object" ? config.patrol : {};
  return {
    enabled: config.enabled !== false,
    stateFile: typeof config.stateFile === "string" ? config.stateFile : "",
    zoneSessionTitle:
      typeof config.zoneSessionTitle === "string" && config.zoneSessionTitle.trim().length > 0
        ? config.zoneSessionTitle
        : ZONE_SESSION_TITLE,
    injectRule: config.injectRule !== false,
    patrol: { enabled: patrol.enabled !== false },
    // 主动开口判定器：**默认关闭**（`throttle.enabled` 的默认值在 src/throttle.js 的
    // THROTTLE_DEFAULTS 里，这里是唯一真源，patch 里不重复写同样的语义）。
    // 关着的时候工具照样注册，`check` 会如实回答 blocked/disabled —— 这样"为什么它不开口"
    // 是一个能查到的结论，而不是"工具压根不存在"。
    throttle: normalizeThrottle(config.throttle),
    // 会话轮换：自动化会话无限复用 → 涨到十几 MB 后 compaction 压不动，定时任务
    // 投递成功却跑不出结果（静默失败）。这一节就是那个体积上限 + 体检节奏。
    rotation: normalizeRotation(config.rotation),
  };
}

/**
 * 插件激活。
 * @param {import('cordis').Context} ctx
 * @param {unknown} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const log = ctx.logger;

  if (!config.enabled) {
    // 关掉也要留一行：否则“为什么工具不出现”会变成猜测。
    log.info(`${LOG_PREFIX} 配置里 enabled=false，跳过注册（不装工具、不注入提示）`);
    return;
  }

  /**
   * 取服务：属性直取优先，**兜底必须用 `ctx.get(name, false)`**。
   *
   * 为什么不能用默认的 `ctx.get(name)`：cordis 的 `ReflectService.get(name, strict = true)`
   * 内部是 `if (strict && impl.fiber.state !== 2) return;`（@deepseek-ai/cordis/lib/index.js:765-767）
   * —— 服务提供者 fiber 尚未激活（启动期正是这个状态）时**直接返回 undefined**。
   *
   * 为什么也不能只靠属性：ctx 的 proxy get trap 在「prop 在 inject 里、但当前上下文不是 active」
   * 时抛 `cannot get required service "<name>" in inactive context`（同文件 :687-689）。
   *
   * 所以在启动期，默认的这两条路都是死的，只有 `strict = false` 这条不看 state 的路能拿到实现。
   * 实测（2026-10-20 冷启动）：五个服务全在 inject 里，前两条路一律拿不到，
   * 插件把自己判成「部署有问题」而放弃注册，日志只有一行「缺少服务 ...」。
   */
  const service = (serviceName) => {
    try {
      const direct = ctx[serviceName];
      if (direct !== undefined && direct !== null) return direct;
    } catch {
      // inactive context：属性访问要求服务已激活，启动期必然抛，属预期，继续往下兜。
    }
    if (typeof ctx.get !== "function") return undefined;
    try {
      const loose = ctx.get(serviceName, false);
      if (loose !== undefined && loose !== null) return loose;
    } catch {
      // get 本身也可能因 isolate 不匹配等原因抛，交给下面返回 undefined。
    }
    return ctx.get(serviceName);
  };

  const tools = service("tools");
  const schedule = service("schedule");
  const sessionController = service("sessionController");
  const systemPrompt = service("systemPrompt");
  const workspaceRegistry = service("workspaceRegistry");

  const missing = [
    ["tools", tools],
    ["schedule", schedule],
    ["sessionController", sessionController],
    ["systemPrompt", systemPrompt],
    ["workspaceRegistry", workspaceRegistry],
  ].filter(([, service]) => service === undefined || service === null).map(([serviceName]) => serviceName);

  if (missing.length > 0) {
    // 不装一半：声明了 inject 还缺服务，说明部署本身有问题，必须显式喊出来。
    log.warn(`${LOG_PREFIX} 激活失败：缺少服务 ${missing.join(", ")}（插件不注册任何工具）`);
    return;
  }

  const stateFile = config.stateFile.length > 0 ? config.stateFile : defaultStateFile();
  const readState = () => loadState(stateFile, log);
  const writeState = (state) => saveState(stateFile, state);

  log.info(`${LOG_PREFIX} 激活：state=${stateFile}，会话标题=${JSON.stringify(config.zoneSessionTitle)}，巡检=${config.patrol.enabled ? "开" : "关"}`);

  // 状态文件首次可用性在这里就探一次：读坏 / 权限不足应该现在暴露，而不是等第一次建任务。
  const initial = readState();
  log.info(`${LOG_PREFIX} 状态表已有 ${Object.keys(initial.zones).length} 个项目`);
  if (typeof initial.readError === "string" && initial.readError.length > 0) {
    // 读不出来 ≠ 空表：这一轮运行会拒绝写状态文件（否则会把别的项目记录整表覆盖掉）。
    log.warn(`${LOG_PREFIX} 状态文件读不出来（${initial.readError}）：本次运行不会写状态文件，已有项目的记录保持原样`);
  }

  /**
   * 「这个会话是否已被归档」。归档意味着用户已经把它从视图里藏起来了——
   * 继续往里灌任务就是静默失效。集合每次现读（registry 状态在内存里，同步且便宜）。
   * @param {string} sessionId
   * @returns {boolean}
   */
  const isArchived = (sessionId) => archivedSessionIdsOf(workspaceRegistry, log).has(sessionId);

  /**
   * 量一个会话的文件体积（字节）。
   *
   * 三个刻意的取舍：
   *  ① **懒取服务**（`ctx.get("sessionPersistence", false)`）：它不在 `inject` 里，
   *     因为「这个 profile 有没有它」不该决定插件能不能激活；而且 apply 期它就绪顺序
   *     不确定，所以每次现取，取不到就算了。
   *  ② **不用 `sessionController.inspect` 数事件**：inspect 会把整个会话日志物化一遍，
   *     那正是轮换要避开的那笔开销（对 12 MB 的会话尤其致命）。
   *  ③ 量不到（服务缺失 / stat 不可用 / 抛错）一律返回 `undefined` = 不轮换。
   *     拿一个猜出来的体积去换会话，比完全不换更糟。
   *  ④ `stat()` 成功但没有 `sizeBytes` **不算故障**：刚建的会话是 pending 态，文件还没落盘，
   *     本来就没有体积可量（几乎每个新会话都要走一遍）。这种正常形态**不许 warn**——
   *     warn 只给一次，被正常情况吃掉之后，真正的故障（服务没了 / stat 抛错）就静默了。
   * @param {string} sessionId
   * @returns {Promise<number|undefined>}
   */
  let measureWarned = false;
  async function measureBytes(sessionId) {
    const warnOnce = (reason) => {
      if (measureWarned) return;
      measureWarned = true;
      log.warn(`${LOG_PREFIX} 无法度量会话体积（${reason}）：轮换判据按「不轮换」处理（这条只提示一次）`);
    };
    let persistence;
    try {
      persistence = typeof ctx.get === "function" ? ctx.get("sessionPersistence", false) : undefined;
    } catch (error) {
      persistence = undefined;
      warnOnce(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    const stat = persistence !== null && typeof persistence === "object" ? persistence.stat : undefined;
    if (typeof stat !== "function") {
      warnOnce("服务 sessionPersistence.stat 不可用");
      return undefined;
    }
    try {
      const info = await stat.call(persistence, sessionId);
      const bytes = info !== null && typeof info === "object" ? info.sizeBytes : undefined;
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) return bytes;
      // 没有 sizeBytes = 新建/pending 会话的正常形态（文件还没落盘）。这里**不 warn**：
      // 每条新会话都会走到这一支，让它吃掉唯一的那次 warn，真故障就永远没人知道了。
      return undefined;
    } catch (error) {
      warnOnce(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /**
   * 轮换判据：会话文件超过阈值就换档。
   *
   * 为什么按字节而不按轮数：轮数要么现数（`inspect`，物化全量事件 = 正是要避开的开销），
   * 要么自己维护计数器（重启即丢，而且和真实体积不是一回事——一条投递带几千字 prompt，
   * 轮数和字节差着数量级）。字节是同一件事的直接度量，而 `stat()` 只读文件元数据。
   * @param {string} sessionId
   */
  const shouldRotate = async (sessionId) => {
    if (!config.rotation.enabled) return { rotate: false };
    const bytes = await measureBytes(sessionId);
    if (bytes === undefined) return { rotate: false };
    if (bytes > config.rotation.maxSessionBytes) {
      return {
        rotate: true,
        bytes,
        reason: `会话文件 ${bytes} 字节 > 阈值 ${config.rotation.maxSessionBytes}`,
      };
    }
    return { rotate: false };
  };

  // 迁移器：轮换时把绑在旧会话上的 active 任务搬到新会话（dsh-schedule 没有改绑 API，
  // 只能 catalog → create 新会话 → delete 旧的，见 src/rotation.js 顶部）。
  const migrator = createTaskMigrator({ schedule, loadState: readState, saveState: writeState, log });

  /**
   * 「记录的会话已不可用（corrupt / 被删）→ 新建」这条路径上的任务迁移。
   *
   * 为什么必须做：那条路径以前只 warn + 新建，旧会话 id 上钉着的 active 任务就成了孤儿——
   * 到点往一个物化失败的会话投递，投递成功、回合跑不出结果、连 agent.failed 都没有。
   * 为什么在这里而不是 zone.js 里自己调：迁移的真源只有 rotation.js 这一份，
   * zone.js 只负责把 `{from, to}` 交出来（注入回调），接哪个实现由这里决定。
   * 为什么不往外抛：新会话此时已经建好了，迁移失败只该留下可查的日志，不该把
   * 「确保自动化会话」这件事一起判失败（zone.js 调用处还有一层 fail-open）。
   * @param {{cwd: string, fromSessionId: string, toSessionId: string}} info
   */
  const migrateReplacedSession = async ({ cwd, fromSessionId, toSessionId }) => {
    const outcome = await migrator.migrate({ cwd, fromSessionId, toSessionId });
    const migrated = outcome !== null && typeof outcome === "object" && Array.isArray(outcome.migrated)
      ? outcome.migrated.length
      : 0;
    const failed = outcome !== null && typeof outcome === "object" && Array.isArray(outcome.failed)
      ? outcome.failed
      : [];
    log.info(`${LOG_PREFIX} 替换不可用会话 ${fromSessionId} → ${toSessionId}：已迁移 ${migrated} 条定时任务`);
    if (failed.length > 0) {
      const detail = failed
        .map((item) => `${item?.title ?? ""}（${item?.code ?? ""}：${item?.message ?? ""}）`)
        .join("；");
      log.warn(`${LOG_PREFIX} 替换不可用会话 ${fromSessionId} → ${toSessionId}：${failed.length} 条任务迁移失败——${detail}`);
    }
    return outcome;
  };

  const zone = createEnsureZoneSession({
    inspect: (sessionId) => sessionController.inspect(sessionId),
    create: (request) => sessionController.create(request),
    isArchived,
    shouldRotate,
    migrate: migrator.migrate,
    onSessionReplaced: migrateReplacedSession,
    loadState: readState,
    saveState: writeState,
    title: config.zoneSessionTitle,
    log,
  });

  tools.register(
    createTaskCreateTool({
      schedule,
      sessionController,
      ensureZoneSession: zone.ensure,
      log,
    }),
  );
  tools.register(
    createZoneStatusTool({
      schedule,
      sessionController,
      loadState: readState,
      isArchived,
      log,
    }),
  );
  tools.register(
    createRepairTasksTool({
      schedule,
      sessionController,
      loadState: readState,
      ensureZoneSession: zone.ensure,
      migrate: migrator.migrate,
      log,
    }),
  );
  log.info(`${LOG_PREFIX} 已注册工具 automation_task_create / automation_zone_status / automation_zone_repair_tasks`);

  tools.register(
    createProactiveGateTool({
      sessionController,
      loadState: readState,
      stateFile,
      log,
      throttle: config.throttle,
    }),
  );
  // 开关状态**无条件**打一行：默认关着的时候，"为什么它不开口"必须能在日志里看到答案，
  // 而不是要人去翻 patch 猜。
  log.info(
    `${LOG_PREFIX} 主动开口判定器：${config.throttle.enabled ? "开" : "关（默认）"}`
      + `（峰/谷命中线 ${config.throttle.peakLine}/${config.throttle.valleyLine}，安静 ${config.throttle.quietFrom}~${config.throttle.quietTo} 点，冷却 ${config.throttle.cooldownMinutes} 分钟）`,
  );

  /**
   * 定时任务闸门：把判定器从「被动工具」升级成 schedule 投递的**服务端准入层**。
   *
   * 为什么要这一层：`automation_proactive_gate` 只在调用方自觉来问的时候才算一次，
   * 而「每天 9 点自动发日报」这类任务从不会来问——它到点就自己跑了。
   *
   * 数据来源的取舍（有源码依据，见 src/gateinject.js 的模块注释）：
   *   ① 主来源 = `session/event` 里的 `agent/inbox/spliced` 与 `user/message`。
   *      投递链路是 followup → splice（append 事件）→ wake → 每步 claim/assemble/pre-step/step，
   *      所以这两个事件都在**第一步 prompt 组装之前**就可见。
   *   ② 辅助源 = `agent/pre-step` 的本批 messages。它拿到的是本轮新增消息，但触发时机在
   *      assemble **之后**（`dsh-agent-loop`：claim → assemble → pre-step waterfall），
   *      只靠它会让结论晚一个 step 到达。而且它的返回值会被持久化，
   *      所以这里**只读不写**——绝不改 messages（那是伪造会话历史）。
   *   ③ 不用 `sessionController.inspect` 兜底：`systemPrompt.context` 的 text 是**同步调用**，
   *      异步读历史没法用。代价如实写在 CONTRACT：插件激活晚于投递时，那一轮不注入（fail-open）。
   */
  const gateInjector = createGateInjector({
    loadState: readState,
    saveState: writeState,
    throttle: config.throttle,
    log,
  });

  const disposeSessionEvent = ctx.on("session/event", (session, event) => {
    gateInjector.observe(session !== null && typeof session === "object" ? session.id : undefined, event);
  });

  // 只读闸门，但必须把 waterfall 链传下去：agent/pre-step 是 cordis waterfall，
  // 不调用 next() 的 handler 会否决整条链（含 terminal），其返回值就成了外层
  // `await next()` 的结果。返回 undefined 会让 dsh-plan-mode / agent-loop 拿到
  // undefined decision，直接 TypeError: Cannot read properties of undefined (reading 'kind')。
  // 只读 payload.messages 与返回值无关——decision 原样透传不会被当成新增消息持久化。
  const disposePreStep = ctx.on("agent/pre-step", (payload, next) => {
    gateInjector.rememberBatch(payload !== null && typeof payload === "object" ? payload.messages : undefined);
    return typeof next === "function" ? next() : undefined;
  });

  // 注入通道只有 context 一条：它每轮动态计算，而 section 要求静态文本。
  // 返回空串 = 这一轮什么都不注入（未登记任务 / 不是定时任务 / 读不出状态时都是空串）。
  systemPrompt.context({
    name: GATE_CONTEXT_NAME,
    order: GATE_CONTEXT_ORDER,
    text: (context) => {
      const sessionId = sessionIdOfContext(context);
      if (sessionId === undefined) return "";
      return gateInjector.render(sessionId);
    },
  });

  ctx.effect(() => () => {
    disposeSessionEvent();
    disposePreStep();
  }, "automation-zone: dispose schedule gate");
  log.info(`${LOG_PREFIX} 定时任务闸门已挂到 session/event + agent/pre-step，注入走 context ${GATE_CONTEXT_NAME}（order ${GATE_CONTEXT_ORDER}）`);

  // 闸门只对**已登记**的任务生效；启动时把登记数打出来，否则「为什么它没管我的任务」
  // 只能靠翻状态文件猜。
  const gatedAtBoot = Object.keys(initial.tasks ?? {}).filter((id) => initial.tasks?.[id]?.enabled === true).length;
  log.info(`${LOG_PREFIX} 定时任务闸门：已登记 ${gatedAtBoot} 条任务${gatedAtBoot === 0 ? "（默认零行为变化）" : ""}`);

  if (config.injectRule) {
    // 静态 section + interpolate:false —— 框架级免插值，比“每轮自己中和”更彻底；
    // 文本仍过一遍 neutralizeBraces 作第二道保险（见 src/prompt.js）。
    systemPrompt.section({
      name: INJECT_SECTION_NAME,
      order: INJECT_SECTION_ORDER,
      text: renderInjectRule(INJECT_RULE_TEXT),
      interpolate: false,
    });
    log.info(`${LOG_PREFIX} 已注入系统提示 section ${INJECT_SECTION_NAME}`);
  } else {
    log.info(`${LOG_PREFIX} injectRule=false，未注入系统提示`);
  }

  if (config.patrol.enabled) {
    // 巡检只读：算孤儿任务，有变化才写日志。**绝不自动迁移** ——
    // 迁移会停掉旧任务、改变用户语义，必须由人拍板（契约 §3.6）。
    let lastSignature = null;
    let timer;
    let running = false;

    const runPatrol = async () => {
      if (running) return;
      running = true;
      try {
        // 只用 `schedule.catalog()` 算孤儿，**不调 collectZoneStatus**：
        // 巡检挂在 schedule/changed（每次任务增删都触发）这条热路径上，而
        // collectZoneStatus 会为每个 zone、每个孤儿会话各 inspect 一次，inspect 返回
        // 该会话**全部事件**——长期存活的自动化会话日志只会越长越大，等于每次增删任务
        // 都把几份越来越大的日志读进内存。孤儿判据本来只需要 catalog + zone 会话 id 集合。
        const state = readState();
        const snapshot = await collectOrphans({ schedule, zoneSessionIds: zoneSessionIdsOf(state) });
        if (snapshot.ok !== true) {
          log.warn(`${LOG_PREFIX} 巡检失败：${snapshot.code} — ${snapshot.message}`);
          return;
        }
        const orphans = snapshot.orphans;
        const signature = orphans.map((orphan) => orphan.taskId).sort().join("|");
        if (signature === lastSignature) return;
        lastSignature = signature;
        if (orphans.length === 0) {
          log.info(`${LOG_PREFIX} 巡检：没有孤儿任务（所有定时任务都在自动化会话上）`);
          return;
        }
        const detail = orphans.map((orphan) => `${orphan.title}(${orphan.taskId}@${orphan.sessionId})`).join("; ");
        log.warn(`${LOG_PREFIX} 巡检：发现 ${orphans.length} 个孤儿任务（寄生在非自动化会话上，未自动迁移）：${detail}`);
      } catch (error) {
        log.warn(`${LOG_PREFIX} 巡检异常：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
      }
    };

    const disposeChanged = ctx.on("schedule/changed", () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void runPatrol();
      }, PATROL_DEBOUNCE_MS);
      // 定时器不该拖住进程退出（DSH 停摆时别让插件变成“关不掉”的那一个）。
      if (typeof timer.unref === "function") timer.unref();
    });

    ctx.effect(() => () => {
      disposeChanged();
      if (timer !== undefined) clearTimeout(timer);
    }, "automation-zone: dispose patrol");
    log.info(`${LOG_PREFIX} 巡检已挂到 schedule/changed（只读，不迁移）`);
  }

  // 轮换配置**无条件**打出来：默认开着的时候「它到底按什么判、多久看一次」必须能在
  // 日志里读到，否则“为什么它没换档”只能靠翻代码猜。
  log.info(
    `${LOG_PREFIX} 会话轮换：${config.rotation.enabled ? "开" : "关"}`
      + `（阈值 ${config.rotation.maxSessionBytes} 字节，周期体检 ${config.rotation.checkIntervalMinutes > 0 ? `每 ${config.rotation.checkIntervalMinutes} 分钟` : "关"}`
      + `，激活时体检 ${config.rotation.onBoot ? "开" : "关"}）`,
  );

  /**
   * 体检：把每个已知项目的自动化会话都 `ensure` 一遍。
   *
   * 不需要第二套判据——`ensure` 里已经有完整的（存在 / cwd / 归档 / 体积），体检只是
   * 主动驱动它：不主动跑，判据就永远等到「下次有人建任务」才生效，而一个已经哑火的
   * 会话可能好几天都不会有人来建任务。
   *
   * 串行而不是并发：并发时多个 cwd 各自重建会话并写状态文件，写盘冲突面变大，而这件事
   * 本来就不在人的等待路径上。单个 cwd 失败只 warn 不中断。
   * @param {string} reason 触发来源（写进日志，便于区分激活体检与周期体检）
   */
  const runRotationCheck = async (reason) => {
    let cwds = [];
    try {
      // 每次现读而不是用激活期的 `initial`：周期体检必须看到最新记录（期间可能已经
      // 轮换过、或者新建了别的项目的会话）。激活期现读到的内容与 `initial` 同源。
      cwds = Object.keys(readState().zones ?? {});
    } catch (error) {
      log.warn(`${LOG_PREFIX} ${reason}会话体检：读状态文件失败（${error instanceof Error ? error.message : String(error)}），跳过本轮`);
      return;
    }
    for (const cwd of cwds) {
      try {
        await zone.ensure(cwd);
      } catch (error) {
        log.warn(`${LOG_PREFIX} ${reason}会话体检：${cwd} 检查失败（${error instanceof Error ? error.message : String(error)}），跳过`);
      }
    }
  };

  if (config.rotation.enabled && config.rotation.onBoot) {
    // 不 await：体检要 stat 每个会话、可能还要建会话 + 迁任务，挡住 apply 等于把插件
    // 激活挂在别的服务的就绪顺序上。
    void runRotationCheck("激活");
  }

  if (config.rotation.enabled && config.rotation.checkIntervalMinutes > 0) {
    let checking = false;
    const timer = setInterval(() => {
      // 上一轮还没跑完就不再叠一轮：体检会让会话真的动（建、迁任务），叠起来就是两份并发写。
      if (checking) return;
      checking = true;
      void runRotationCheck("周期").finally(() => {
        checking = false;
      });
    }, config.rotation.checkIntervalMinutes * 60_000);
    // 定时器不该拖住进程退出（与巡检定时器同一条理由）。
    if (typeof timer.unref === "function") timer.unref();
    ctx.effect(() => () => clearInterval(timer), "automation-zone: dispose rotation check");
  }
}

// 注意：**不要**在这里写 `export default apply`。
//
// `cordis-plugin-loader/lib/index.js:664-668` 的 unwrapExports 是：
//     exports = exports.default ?? exports;
//     return exports.default ?? exports;
// 也就是说 Loader **优先拿 default 当插件本体**。若 default 是一个裸函数，
// 那么具名导出的 `name` / `inject` 会被整个丢掉 —— 实测（2026-10-20）
// `"inject" in unwrapped === false`，于是 Loader 认为这个插件没有依赖声明，
// 立刻 apply，**不等任何服务就绪**，插件随后报「缺少服务 ...」并放弃注册。
// 更迷惑的是 `name` 看似还在（函数自带的 name 属性），所以从现象上很难看出来。
// 本机可对照：@local/dsh-memory-augment 没有 default 导出，工作正常。

