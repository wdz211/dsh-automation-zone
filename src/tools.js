/**
 * 两个工具的工厂（依赖注入式）。
 *
 * 为什么工厂化而不是在 index.js 里写死：这两个工具最容易被写错的是
 * 「取哪个 cwd」「selector 怎么判」「错误怎么透出」，而它们全部可以靠假服务验证。
 * 把服务当参数传进来，冒烟脚本就能在没有 DSH 的机器上跑完 A1–A10。
 *
 * 硬约束（接口层）：
 *   - `output.render` 必填，缺了 `tools.register()` 直接抛 TypeError；
 *   - 返回值必须能过 `output.schema` 校验（所以每个字段都显式构造，不留 undefined）；
 *   - 失败一律返回 `{ ok:false, code, message }`，不把异常文本甩给模型。
 */

import fs from "node:fs";

import {
  LOG_PREFIX,
  defaultStateFile,
  saveState as defaultSaveState,
  stateReadError,
  taskEntryOf,
  upsertTask,
  upsertThrottle,
} from "./storage.js";
import { pickSelector } from "./selector.js";
import { decide, lineEquation, nextStreak, normalizeThrottle, normalizeThrottleState } from "./throttle.js";

/** 建任务工具名。 */
export const CREATE_TOOL_NAME = "automation_task_create";

/** 状态工具名。 */
export const STATUS_TOOL_NAME = "automation_zone_status";

/** 主动开口判定器工具名。 */
export const GATE_TOOL_NAME = "automation_proactive_gate";

/** 孤儿任务修复工具名。 */
export const REPAIR_TOOL_NAME = "automation_zone_repair_tasks";

/**
 * 只给 fromSessionId 而不给 cwd 时的缺省项目目录。
 *
 * 为什么写死一个：`fromSessionId` 这条用法是「我知道任务钉在哪个会话上，帮我搬走」，
 * 它天然不知道目标项目；此时按 `DSH_ROOT`（未设置时取进程 cwd）兜底，比报错更可用。
 * 调用方随时可以用 `cwd` 覆盖它。
 */
export const DEFAULT_REPAIR_CWD = process.env.DSH_ROOT || process.cwd();

/** 建任务的返回结构（契约 §3.3 + 状态写盘失败的 warning）。 */
const CREATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    taskId: { type: "string" },
    sessionId: { type: "string" },
    created: { type: "boolean" },
    title: { type: "string" },
    code: { type: "string" },
    message: { type: "string" },
    provided: { type: "array", items: { type: "string" } },
    warning: { type: "string" },
  },
  required: ["ok"],
};

/** 状态工具的返回结构（契约 §3.4 + 每条 zone 的 cwdMatches / archived / tasksError）。 */
const STATUS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    zones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          sessionId: { type: "string" },
          exists: { type: "boolean" },
          cwdMatches: { type: "boolean" },
          // 已归档的会话下次调用会被弃用重建（见 zone.js 的复用判据）。
          archived: { type: "boolean" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                kind: { type: "string" },
                status: { type: "string" },
              },
              required: ["id", "title", "kind", "status"],
            },
          },
          // 会话在线但任务列表读不到时的原因。有它的时候 `tasks: []` 不代表“没有任务”。
          tasksError: { type: "string" },
        },
        required: ["cwd", "sessionId", "exists", "cwdMatches", "archived", "tasks"],
      },
    },
    orphans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          sessionId: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["taskId", "title", "sessionId"],
      },
    },
    code: { type: "string" },
    message: { type: "string" },
    // 状态文件读不出来（读失败 / JSON 解析失败）时的诊断标记。
    // 有它的时候 `zones: []` / `orphans: []` **不是结论**，只是「没读出来，所以不给结论」。
    stateUnreadable: {
      type: "object",
      properties: { error: { type: "string" } },
      required: ["error"],
    },
  },
  required: ["ok"],
};

/** 建任务的参数表（契约 §3.3，另加 cwd 兜底参数 —— 契约正文第 2 步要求它存在）。 */
const CREATE_PARAMETERS = {
  type: "object",
  properties: {
    title: { type: "string", description: "任务名称，必填（空白或过长会被 schedule 拒绝）" },
    prompt: { type: "string", description: "到点要执行的指令（触发时发给自动化会话的正文）" },
    daily: {
      type: "object",
      properties: { time: { type: "string" }, time_zone: { type: "string" } },
      required: ["time", "time_zone"],
    },
    weekly: {
      type: "object",
      properties: {
        time: { type: "string" },
        time_zone: { type: "string" },
        weekdays: { type: "array", items: { type: "integer" } },
      },
      required: ["time", "time_zone", "weekdays"],
    },
    every_seconds: { type: "integer" },
    after_seconds: { type: "integer" },
    at: { type: "string" },
    cron: {
      type: "object",
      properties: { expression: { type: "string" }, time_zone: { type: "string" } },
      required: ["expression", "time_zone"],
    },
    cwd: {
      type: "string",
      description:
        "可选兜底：仅当无法从调用者会话取到 cwd 时才用它（必须是**已存在的目录**，原样字符串，不做路径规范化）",
    },
  },
  required: ["title", "prompt"],
};

/** 状态工具没有参数（但 schema 必须存在且是对象根）。 */
const STATUS_PARAMETERS = { type: "object", properties: {} };

/**
 * 修复工具的返回结构。
 *
 * ⚠ `output.schema` 是 `additionalProperties:false`，**四个键必须全登记**：漏一个
 * = 工具跑成功、结果却被整个拒收，从现象上看起来像“工具坏了”。
 * 所以连 `migrated` / `failed` / `skipped` 这三个数组也写进 required —— 永远是三个真数组，
 * 不要留 undefined 让校验器和渲染层各自猜。
 */
const REPAIR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    migrated: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          title: { type: "string" },
        },
        required: ["from", "to", "title"],
      },
    },
    failed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["id", "title", "code", "message"],
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "title", "reason"],
      },
    },
    code: { type: "string" },
    message: { type: "string" },
  },
  required: ["ok", "migrated", "failed", "skipped"],
};

/** 修复工具的参数表（标准 JSON Schema：简写参数表会被工具注册静默拒掉）。 */
const REPAIR_PARAMETERS = {
  type: "object",
  properties: {
    fromSessionId: {
      type: "string",
      description: "可选：只迁这一个会话上的 active 任务；不给就按孤儿判据自动找出全部孤儿",
    },
    cwd: { type: "string", description: "可选：目标项目目录（必须是已存在的目录；给了 fromSessionId 时缺省为 DSH_ROOT，未设置则取进程 cwd）" },
    dryRun: { type: "boolean", description: "true = 只列计划，不建会话、不建任务、不删任务" },
  },
  required: [],
};

/** 统一取错误文案。 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 取错误码：优先用错误自己带的 `code`（`ScheduleInputError` 的 code 是稳定判别符，
 * 契约要求原样透出），没有才用调用方给的兜底值。
 * @param {unknown} error
 * @param {string} fallback
 */
function codeOf(error, fallback) {
  if (error !== null && typeof error === "object" && typeof error.code === "string" && error.code.length > 0) {
    return error.code;
  }
  return fallback;
}

/** 内部日志出口（logger 在测试里也可以不给）。 */
function warnLog(log, message) {
  if (log !== undefined && log !== null && typeof log.warn === "function") {
    log.warn(`${LOG_PREFIX} ${message}`);
  }
}

/**
 * 参数兜底 cwd 的落盘前检查：必须是**已经存在的目录**。
 *
 * 为什么必须查：`sessionController.create({cwd})` 内部会 `mkdir -p`。模型编一个
 * 看起来合理的路径（比如把项目名拼错一位）就会凭空建出一个空目录，还顺手多出
 * 一条记忆轨（`sha1(cwd)[0:12]`）——都是用户从没要求过的磁盘副作用。
 * 任何异常（不存在、权限不足、路径是文件）一律算不通过。
 * @param {string} candidate
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function isExistingDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory() ? { ok: true } : { ok: false, reason: "路径存在但不是目录" };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

/**
 * 算出“这次调用属于哪个项目的 cwd”。
 *
 * 顺序是契约写死的：先问调用者会话（`exec.agent.id` → `inspect().meta.cwd`），
 * 拿不到才用参数兜底。**不做任何路径规范化**——cwd 同时是记忆轨的键，
 * 一改就串轨。
 * @param {{agent?: {id?: string}}|undefined} exec
 * @param {unknown} argumentCwd 参数里的 cwd
 * @param {{inspect: Function}} sessionController
 * @param {{warn?: Function}|undefined} log
 * @returns {Promise<{ok: true, cwd: string, source: 'agent'|'argument'}
 *   | {ok: false, code: 'no_cwd'|'cwd_not_found', message: string}>}
 */
export async function resolveCallerCwd(exec, argumentCwd, sessionController, log) {
  const agentId = exec !== null && typeof exec === "object" && exec.agent !== null && typeof exec.agent === "object"
    ? exec.agent.id
    : undefined;
  if (typeof agentId === "string" && agentId.length > 0) {
    try {
      const observed = await sessionController.inspect(agentId);
      const cwd = observed !== null && typeof observed === "object" && observed.meta !== null && typeof observed.meta === "object"
        ? observed.meta.cwd
        : undefined;
      if (typeof cwd === "string" && cwd.length > 0) return { ok: true, cwd, source: "agent" };
      warnLog(log, `调用者会话 ${agentId} 的 meta.cwd 为空，改看参数 cwd`);
    } catch (error) {
      warnLog(log, `读取调用者会话 ${agentId} 的 cwd 失败（${messageOf(error)}），改看参数 cwd`);
    }
  }
  if (typeof argumentCwd === "string" && argumentCwd.trim().length > 0) {
    const check = isExistingDirectory(argumentCwd);
    if (check.ok !== true) {
      warnLog(log, `参数 cwd ${JSON.stringify(argumentCwd)} 不是已存在的目录（${check.reason}），拒绝使用`);
      return {
        ok: false,
        code: "cwd_not_found",
        message:
          `cwd 参数必须是已存在的目录：${JSON.stringify(argumentCwd)}（${check.reason}）。` +
          "请改成真实存在的项目目录后重试；能取到调用者会话的 cwd 时不必传这个参数",
      };
    }
    // 原样返回：连尾斜杠都不动，见 storage.js 顶部的理由。
    return { ok: true, cwd: argumentCwd, source: "argument" };
  }
  return {
    ok: false,
    code: "no_cwd",
    message: "无法确定项目目录：调用者会话没有可用 cwd，也没有提供 cwd 参数",
  };
}

/** 从一份状态表里取出所有已记录的自动化会话 id。 */
export function zoneSessionIdsOf(state) {
  const zonesTable = state !== null && typeof state === "object" && state.zones !== null && typeof state.zones === "object"
    ? state.zones
    : {};
  const ids = new Set();
  for (const record of Object.values(zonesTable)) {
    if (record !== null && typeof record === "object" && typeof record.sessionId === "string" && record.sessionId.length > 0) {
      ids.add(record.sessionId);
    }
  }
  return ids;
}

/** 问一句“这个会话是否已归档”；没注入 isArchived 就是 false（不猜）。 */
async function archivedOf(isArchived, sessionId, log) {
  if (typeof isArchived !== "function" || typeof sessionId !== "string" || sessionId.length === 0) return false;
  try {
    return (await isArchived(sessionId)) === true;
  } catch (error) {
    warnLog(log, `无法确认会话 ${sessionId} 的归档状态（${messageOf(error)}），按未归档展示`);
    return false;
  }
}

/**
 * 收集“寄生在非自动化会话上的 active 任务”。
 *
 * 这是**唯一**一份孤儿判据，工具（automation_zone_status）与巡检都调它，避免两边
 * 对“什么算孤儿”理解不一致。
 *
 * 判据只需要 `schedule.catalog()` 与 zone 会话 id 集合 —— 巡检跑在
 * `schedule/changed` 热路径上（每次任务增删都触发），而 `sessionController.inspect()`
 * 会把该会话**全部事件**读出来（长期存活的自动化会话日志只会越长越大）。
 * 所以 cwd 是**可选**信息：不传 `sessionController` 就一次 inspect 都不做，孤儿记录
 * 里干脆没有 `cwd` 字段。
 *
 * 关于 status：`schedule.catalog()` 的记录里**经常没有** `status` 字段（status 存在
 * schedule.json 的 table entry 上），缺失是常态不是异常。所以判据是「只有明确标成
 * inactive / disabled 才排除」，缺失一律当 active —— 否则孤儿检测会静默给出「无」。
 * @param {{schedule: object, zoneSessionIds?: Set<string>|string[], sessionController?: object, log?: object}} services
 */
export async function collectOrphans({ schedule, zoneSessionIds, sessionController, log }) {
  const zoneIds = zoneSessionIds instanceof Set
    ? zoneSessionIds
    : new Set(Array.isArray(zoneSessionIds) ? zoneSessionIds.filter((id) => typeof id === "string") : []);

  let catalog;
  try {
    catalog = await schedule.catalog();
  } catch (error) {
    // 拿不到全量清单就无法判断“有没有寄生任务”。这里宁可整体报错，也不要给出
    // 一个“看起来没孤儿”的假结论。
    return { ok: false, code: codeOf(error, "catalog_failed"), message: messageOf(error) };
  }

  // schedule.json 把 status 存在 table entry 上，catalog 的 record 里常常没有这个字段；
  // 缺失 ≠ 已停用 —— 用 === "active" 判会把所有任务过滤掉，让孤儿检测静默失效。
  const isActiveRecord = (record) => record.status !== "inactive" && record.status !== "disabled";
  const activeRecords = (Array.isArray(catalog) ? catalog : []).filter(
    (record) => record !== null && typeof record === "object" && isActiveRecord(record) && !zoneIds.has(record.sessionId),
  );

  const cwdBySession = new Map();
  const canInspect = sessionController !== undefined && sessionController !== null && typeof sessionController.inspect === "function";
  if (canInspect) {
    // 同一个会话可能挂着多个孤儿任务，cwd 只查一次。
    const orphanSessionIds = [...new Set(activeRecords.map((record) => record.sessionId))].filter((id) => typeof id === "string");
    await Promise.all(orphanSessionIds.map(async (sessionId) => {
      try {
        const observed = await sessionController.inspect(sessionId);
        const cwd = observed !== null && typeof observed === "object" && observed.meta !== null && typeof observed.meta === "object"
          ? observed.meta.cwd
          : undefined;
        cwdBySession.set(sessionId, typeof cwd === "string" ? cwd : undefined);
      } catch (error) {
        warnLog(log, `无法读取孤儿任务所在会话 ${sessionId} 的 cwd（${messageOf(error)}）`);
        cwdBySession.set(sessionId, undefined);
      }
    }));
  }

  const orphans = activeRecords.map((record) => {
    const cwd = cwdBySession.get(record.sessionId);
    return {
      taskId: String(record.id),
      title: String(record.title ?? ""),
      sessionId: String(record.sessionId ?? ""),
      // cwd 读不到就整个字段省略——宁可字段缺失，也不给空字符串让人误读成“根目录”。
      ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {}),
    };
  });

  return { ok: true, orphans };
}

/**
 * 收集状态（`automation_zone_status` 用）。
 *
 * 与巡检共享的是**孤儿判据**（`collectOrphans`），不是整个函数：巡检跑在热路径上，
 * 这里会为每个 zone 各 inspect 一次（返回该会话全部事件），不适合每次任务增删都跑。
 *
 * ⚠ **状态文件读不出来时不给结论**。读失败（EACCES/EBUSY/EISDIR…）或 JSON 解析失败时
 * `loadState()` 返回的是「空表 + readError」，照空表往下推演会得出两个**方向相反**的错误结论：
 *   1. 「0 个自动化会话」——用户排查「我的自动化会话去哪了」时唯一的诊断面，这是假的；
 *   2. 「所有任务都是孤儿任务（寄生在非自动化会话上）」——因为孤儿判据的输入正是 zone 清单，
 *      清单空了，本来好好待在 zone 会话里的任务就全被反过来指成寄生。
 * 所以这一档只透出诊断字段 `stateUnreadable`，`zones`/`orphans` 留空数组且**不代表任何结论**
 * （消费方必须先看 `stateUnreadable` 在不在，渲染层也是这么做的）。
 * @param {{schedule: object, sessionController: object, loadState: Function, isArchived?: Function, log?: object}} services
 */
export async function collectZoneStatus({ schedule, sessionController, loadState, isArchived, log }) {
  const state = loadState();
  const unreadable = stateReadError(state);
  if (unreadable !== undefined) {
    // 不能在这里调 collectOrphans：它拿空 zone 清单去问 schedule.catalog，必然把全部任务判成孤儿。
    warnLog(log, `状态文件读不出来（${unreadable}）——本次不给出 zone 清单与孤儿判定`);
    return { ok: true, zones: [], orphans: [], stateUnreadable: { error: unreadable } };
  }
  const zonesTable = state !== null && typeof state === "object" && state.zones !== null && typeof state.zones === "object"
    ? state.zones
    : {};
  const entries = Object.entries(zonesTable);

  const zones = await Promise.all(entries.map(async ([cwd, record]) => {
    const sessionId = record !== null && typeof record === "object" && typeof record.sessionId === "string" ? record.sessionId : "";
    const archived = await archivedOf(isArchived, sessionId, log);

    // 第一段：会话本身还在不在。**这里失败才是「会话不存在」**。
    let observed;
    try {
      observed = await sessionController.inspect(sessionId);
    } catch (error) {
      // 会话被删或读不到：exists=false 是**结论**，不是错误；但原因要留痕。
      warnLog(log, `无法读取 zone ${JSON.stringify(cwd)} 的会话 ${sessionId}（${messageOf(error)}）`);
      return { cwd, sessionId, exists: false, cwdMatches: false, archived, tasks: [] };
    }

    const observedCwd = observed !== null && typeof observed === "object" && observed.meta !== null && typeof observed.meta === "object"
      ? observed.meta.cwd
      : undefined;
    const cwdMatches = observedCwd === cwd;
    if (!cwdMatches) {
      warnLog(log, `zone ${JSON.stringify(cwd)} 的会话 ${sessionId} cwd 已不符（实际 ${JSON.stringify(observedCwd)}）`);
    }

    // 第二段：任务列表。它失败**不代表会话不存在**——会话刚刚被 inspect 成功过。
    // 以前两段共用一个 catch，于是 schedule.list 一抛错就报「会话不存在（下次会重建）」，
    // 那是事实错误，还会让用户以为会话真的没了。
    let tasks = [];
    let tasksError;
    try {
      const records = await schedule.list({ sessionId });
      tasks = (Array.isArray(records) ? records : []).map((item) => ({
        id: String(item.id),
        title: String(item.title ?? ""),
        kind: String(item.kind ?? ""),
        status: "active",
      }));
    } catch (error) {
      tasksError = messageOf(error);
      warnLog(log, `zone ${JSON.stringify(cwd)} 的会话 ${sessionId} 在线，但任务列表读取失败（${tasksError}）`);
    }

    return {
      cwd,
      sessionId,
      exists: true,
      cwdMatches,
      archived,
      tasks,
      ...(tasksError !== undefined ? { tasksError } : {}),
    };
  }));

  const orphanResult = await collectOrphans({
    schedule,
    zoneSessionIds: zoneSessionIdsOf(state),
    sessionController,
    log,
  });
  if (orphanResult.ok !== true) {
    return { ok: false, code: orphanResult.code, message: orphanResult.message };
  }

  return { ok: true, zones, orphans: orphanResult.orphans };
}

/**
 * `automation_task_create` 渲染器。
 * @param {unknown} _args
 * @param {{ok: boolean, taskId?: string, sessionId?: string, created?: boolean, title?: string, code?: string, message?: string, provided?: string[], warning?: string}} value
 */
export function renderTaskCreate(_args, value) {
  if (value !== null && typeof value === "object" && value.ok === true) {
    const lines = [
      `已创建定时任务「${value.title ?? ""}」（${value.created === true ? "新建了本项目的自动化会话" : "复用了本项目的自动化会话"}）`,
      `- 任务 id：${value.taskId ?? ""}`,
      `- 自动化会话：${value.sessionId ?? ""}`,
    ];
    if (typeof value.warning === "string" && value.warning.length > 0) {
      lines.push(`- 注意：任务已建好，但状态文件没写入（${value.warning}）；下次调用可能会再建一个自动化会话`);
    }
    return [{ type: "text", text: lines.join("\n") }];
  }
  const provided = Array.isArray(value?.provided) && value.provided.length > 0 ? `（本次给了 ${value.provided.join(" / ")}）` : "";
  const code = value?.code ?? "unknown_error";
  const message = typeof value?.message === "string" && value.message.length > 0 ? ` — ${value.message}` : "";
  return [{ type: "text", text: `创建定时任务失败：${code}${message}${provided}` }];
}

/**
 * `automation_zone_status` 渲染器。
 * @param {unknown} _args
 * @param {object} value
 */
export function renderZoneStatus(_args, value) {
  if (value === null || typeof value !== "object" || value.ok !== true) {
    const code = value?.code ?? "unknown_error";
    const message = typeof value?.message === "string" && value.message.length > 0 ? ` — ${value.message}` : "";
    return [{ type: "text", text: `读取自动化区状态失败：${code}${message}` }];
  }
  // 状态文件读不出来：**必须先于**「空表 → 还没有任何自动化会话」那段输出。
  // 这一档下 zones 一定是空表（loadState 退化成空表），照常往下渲染就会把
  // 「没读出来」说成「确实没有」，并把孤儿判定当成可信结论——那正是用户在排查
  // 「我的自动化会话去哪了」时最容易被误导的地方。
  const stateUnreadable = value.stateUnreadable !== null && typeof value.stateUnreadable === "object"
    ? value.stateUnreadable
    : undefined;
  if (stateUnreadable !== undefined) {
    const error = typeof stateUnreadable.error === "string" && stateUnreadable.error.length > 0
      ? `：${stateUnreadable.error}`
      : "";
    return [{
      type: "text",
      text: [
        `状态文件读不出来${error}`,
        "所以这次不给结论：下面没有会话清单、也没有孤儿任务判定——两者都以状态文件里那份 zone 映射为唯一真源，读不出来就都不可信。",
        "具体说：看不到自动化会话**不代表它不存在**；同理，这次也没有任何证据说明有任务寄生在别的会话上。",
        "先修好（或删掉）状态文件再调本工具；在修好之前，不要拿这份输出当「自动化会话已经没了」或「有孤儿任务」的依据。",
      ].join("\n"),
    }];
  }
  const lines = [];
  const zones = Array.isArray(value.zones) ? value.zones : [];
  if (zones.length === 0) {
    lines.push("还没有任何自动化会话（第一次调用 automation_task_create 时会创建）。");
  } else {
    lines.push(`自动化会话 ${zones.length} 个：`);
    for (const zone of zones) {
      const tasksError = typeof zone.tasksError === "string" && zone.tasksError.length > 0 ? zone.tasksError : undefined;
      // 判定顺序即“结论的顺序”：会话不存在 > 已归档 > cwd 不符 > 列表读不到 > 在线。
      // tasksError 单独成档，不能落进「无活动任务」——那是把“读不到”说成“没有”。
      const health = zone.exists !== true
        ? "会话不存在（下次调用会重建）"
        : zone.archived === true
          ? "已归档（下次调用会重建）"
          : zone.cwdMatches === false
            ? "会话存在但 cwd 已不符（下次调用会重建）"
            : tasksError !== undefined
              ? "会话在线，但任务列表读不到"
              : "在线";
      const tasks = Array.isArray(zone.tasks) ? zone.tasks : [];
      const summary = tasksError !== undefined
        ? "任务数量未知"
        : tasks.length === 0
          ? "无活动任务"
          : `${tasks.length} 个活动任务`;
      lines.push(`- ${zone.cwd}`);
      lines.push(`  ${zone.sessionId} · ${health} · ${summary}`);
      if (tasksError !== undefined) {
        lines.push(`  会话在线，但任务列表读不到（${tasksError}）`);
      }
      for (const task of tasks) {
        lines.push(`    · [${task.kind}] ${task.title}（${task.id}）`);
      }
    }
  }
  const orphans = Array.isArray(value.orphans) ? value.orphans : [];
  if (orphans.length === 0) {
    lines.push("孤儿任务：无（没有定时任务寄生在非自动化会话上）。");
  } else {
    lines.push(`孤儿任务 ${orphans.length} 个（寄生在非自动化会话上，会把那个会话钉住不让归档）：`);
    for (const orphan of orphans) {
      lines.push(`- [${orphan.cwd ?? "cwd 未知"}] ${orphan.title}（${orphan.taskId} · ${orphan.sessionId}）`);
    }
  }
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * 建 `automation_task_create` 工具定义。
 * @param {{schedule: object, sessionController: object, ensureZoneSession: Function, log?: object}} services
 */
export function createTaskCreateTool({ schedule, sessionController, ensureZoneSession, log }) {
  return {
    name: CREATE_TOOL_NAME,
    description: [
      "创建周期性/定时任务（提醒），并把任务绑到本项目的「⚙ 自动化任务」专用会话上，",
      "不会把当前会话钉住。日常应始终用它而不是 schedule_create；",
      "只有用户明确要求「就在这个会话里提醒我」时才用 schedule_create。",
      "定时方式六选一：at / after_seconds / every_seconds / daily / weekly / cron。",
    ].join(""),
    parameters: CREATE_PARAMETERS,
    output: { schema: CREATE_OUTPUT_SCHEMA, render: renderTaskCreate },
    async execute(args, exec) {
      const picked = pickSelector(args);
      if (picked.ok !== true) {
        return { ok: false, code: picked.code, message: picked.message, provided: picked.provided };
      }

      const resolved = await resolveCallerCwd(exec, args.cwd, sessionController, log);
      if (resolved.ok !== true) {
        return { ok: false, code: resolved.code, message: resolved.message };
      }

      let zone;
      try {
        zone = await ensureZoneSession(resolved.cwd);
      } catch (error) {
        const code = codeOf(error, "ensure_zone_session_failed");
        const message = messageOf(error);
        // 这条路径是**正常返回** `{ok:false}`，工具管线不会当成错误记日志。
        // 不在这里留一行 warn，事后就完全没法归因（只能看到一个“用户说没生效”）。
        warnLog(log, `创建定时任务失败于“确保自动化会话”（cwd=${JSON.stringify(resolved.cwd)}，selector=${picked.kind}，code=${code}）：${message}`);
        return { ok: false, code, message };
      }

      try {
        const record = await schedule.create(zone.sessionId, {
          title: args.title,
          prompt: args.prompt,
          ...picked.selector,
        });
        const title = record !== null && typeof record === "object" && typeof record.title === "string"
          ? record.title
          : String(args.title);
        return {
          ok: true,
          taskId: String(record.id),
          sessionId: zone.sessionId,
          created: zone.created === true,
          title,
          ...(typeof zone.warning === "string" && zone.warning.length > 0 ? { warning: zone.warning } : {}),
        };
      } catch (error) {
        // 契约要求：ScheduleToolError 的 code / message 原样透出，不得吞掉。
        // 任务没建成功时把会话 id 也留着——排查“是不是建错会话了”全靠它。
        const code = codeOf(error, "schedule_create_failed");
        const message = messageOf(error);
        // 同上：正常返回的失败，必须自己落一行 host 日志，否则零归因。
        warnLog(
          log,
          `创建定时任务失败于 schedule.create（cwd=${JSON.stringify(resolved.cwd)}，zone=${zone.sessionId}，selector=${picked.kind}，code=${code}）：${message}`,
        );
        return {
          ok: false,
          code,
          message,
          sessionId: zone.sessionId,
        };
      }
    },
  };
}

/**
 * 建 `automation_zone_status` 工具定义。
 * @param {{schedule: object, sessionController: object, loadState: Function, isArchived?: Function, log?: object}} services
 */
export function createZoneStatusTool({ schedule, sessionController, loadState, isArchived, log }) {
  return {
    name: STATUS_TOOL_NAME,
    description:
      "查看自动化会话与定时任务的全貌：每个项目的自动化会话是否还在、上面挂了哪些任务，以及有没有定时任务寄生在普通会话上（孤儿任务）。无参数。",
    parameters: STATUS_PARAMETERS,
    output: { schema: STATUS_OUTPUT_SCHEMA, render: renderZoneStatus },
    async execute() {
      return collectZoneStatus({ schedule, sessionController, loadState, isArchived, log });
    },
  };
}

// ---------------------------------------------------------------------------
// 孤儿任务修复（automation_zone_repair_tasks）
//
// 为什么要有它：`zone.js` 换掉一个不可用 / 超大的会话时是自动迁移的，但历史上漏迁出来的
// 任务（旧版本留下的、迁移中途失败的）只能人工一条条重建 —— 而它们正是本插件要消灭的
// 静默失效：到点往一个物化失败的会话投递，投递成功、回合跑不出结果、一行错误都没有。
// 所以这里把「发现（沿用 collectOrphans，与 automation_zone_status 同一套口径）+ 处置
// （沿用 rotation.js 的 migrate：catalog → 新会话 create → 删旧的）+ 如实报账」做成一次调用。
// ---------------------------------------------------------------------------

/**
 * 把孤儿任务迁回它所属项目的自动化会话。
 *
 * 分组是按**源会话**（一个会话上的任务整批迁一次），目标是按 **cwd** 定的：
 * 任务搬去的必须是它自己项目的自动化会话，不能一律搬去调用者的 cwd（那是串轨）。
 * @param {{schedule: object, sessionController?: object, loadState: Function,
 *   ensureZoneSession?: Function, migrate?: Function, log?: object, args?: object}} services
 * @returns {Promise<{ok: boolean, migrated: Array<object>, failed: Array<object>, skipped: Array<object>, code?: string, message?: string}>}
 */
export async function repairTasks(services) {
  const settings = services !== null && typeof services === "object" ? services : {};
  const { schedule, sessionController, loadState, log } = settings;
  const ensureZoneSession = settings.ensureZoneSession;
  const migrate = settings.migrate;
  const request = settings.args !== null && typeof settings.args === "object" ? settings.args : {};
  const dryRun = request.dryRun === true;

  const result = { ok: true, migrated: [], failed: [], skipped: [] };
  const refuse = (code, message) => ({ ok: false, code, message, migrated: [], failed: [], skipped: [] });

  if (typeof migrate !== "function" || typeof ensureZoneSession !== "function" || typeof loadState !== "function") {
    return refuse("repair_misconfigured", "修复工具缺少 migrate / ensureZoneSession / loadState 依赖（插件装配有问题）");
  }

  const state = loadState();
  const unreadable = stateReadError(state);
  if (unreadable !== undefined) {
    // 读不出来时 zones 是空表，而孤儿判据的输入正是 zone 清单：空表会把**所有**任务都
    // 指成孤儿，再逐个搬走 —— 那是一次静默的大规模错迁。宁可一条都不动。
    return refuse(
      "state-unreadable",
      `状态文件读不出来（${unreadable}）：这时算出来的“孤儿”不可信（空表会把所有任务都算成孤儿），本次一条任务都不动；先修好状态文件再试`,
    );
  }
  const zonesTable = state !== null && typeof state === "object" && state.zones !== null && typeof state.zones === "object"
    ? state.zones
    : {};

  const explicitCwd = typeof request.cwd === "string" && request.cwd.trim().length > 0 ? request.cwd : undefined;
  if (explicitCwd !== undefined) {
    const check = isExistingDirectory(explicitCwd);
    if (check.ok !== true) {
      return refuse(
        "cwd_not_found",
        `cwd 必须是已存在的目录：${JSON.stringify(explicitCwd)}（${check.reason}）。搬错目录会把任务建到别人的记忆轨上，所以这里拒绝`,
      );
    }
  }
  const fromSessionId = typeof request.fromSessionId === "string" && request.fromSessionId.trim().length > 0
    ? request.fromSessionId
    : undefined;

  /** 源会话 → { cwd, tasks }。同一会话的任务必须整批迁（迁移是按会话建删的）。 */
  const groups = new Map();

  if (fromSessionId !== undefined) {
    let records;
    try {
      records = await schedule.list({ sessionId: fromSessionId });
    } catch (error) {
      return refuse(codeOf(error, "list_failed"), messageOf(error));
    }
    groups.set(fromSessionId, {
      cwd: explicitCwd ?? DEFAULT_REPAIR_CWD,
      tasks: (Array.isArray(records) ? records : []).map((item) => ({ id: String(item.id), title: String(item.title ?? "") })),
    });
  } else {
    // 孤儿口径**只有一份**（collectOrphans），与 automation_zone_status 完全一致；
    // 在这里另写一套判据，两边迟早会对「什么算孤儿」给出不同答案。
    const snapshot = await collectOrphans({ schedule, zoneSessionIds: zoneSessionIdsOf(state), sessionController, log });
    if (snapshot.ok !== true) return refuse(snapshot.code, snapshot.message);
    for (const orphan of snapshot.orphans) {
      const group = groups.get(orphan.sessionId) ?? { cwd: undefined, tasks: [] };
      if (typeof orphan.cwd === "string" && orphan.cwd.length > 0) group.cwd = orphan.cwd;
      group.tasks.push({ id: orphan.taskId, title: orphan.title });
      groups.set(orphan.sessionId, group);
    }
  }

  // 同一个 cwd 只 ensure 一次：ensure 是幂等的，但重复调用没必要（且每多一次都多一次
  // 状态文件写入）。
  const targetByCwd = new Map();

  for (const [groupSessionId, group] of groups) {
    if (group.tasks.length === 0) continue;
    if (group.cwd === undefined) {
      for (const task of group.tasks) {
        result.skipped.push({
          id: task.id,
          title: task.title,
          reason: "cwd 未知（读不到该任务所在会话的 meta.cwd），无法确定该迁到哪个项目的自动化会话",
        });
      }
      continue;
    }

    let target;
    try {
      if (dryRun) {
        const record = zonesTable[group.cwd];
        target = record !== null && typeof record === "object" && typeof record.sessionId === "string"
          ? record.sessionId
          : undefined;
      } else {
        if (!targetByCwd.has(group.cwd)) {
          const zone = await ensureZoneSession(group.cwd);
          targetByCwd.set(group.cwd, zone !== null && typeof zone === "object" ? zone.sessionId : undefined);
        }
        target = targetByCwd.get(group.cwd);
      }
    } catch (error) {
      const message = messageOf(error);
      warnLog(log, `修复任务：为 ${JSON.stringify(group.cwd)} 准备自动化会话失败（${message}），这一组任务未迁移`);
      for (const task of group.tasks) {
        result.failed.push({ id: task.id, title: task.title, code: codeOf(error, "ensure_zone_session_failed"), message });
      }
      continue;
    }

    if (typeof target !== "string" || target.length === 0) {
      for (const task of group.tasks) {
        result.skipped.push({
          id: task.id,
          title: task.title,
          reason: `项目 ${JSON.stringify(group.cwd)} 还没有自动化会话（dryRun 不建会话；去掉 dryRun 会先创建再迁移）`,
        });
      }
      continue;
    }
    if (target === groupSessionId) {
      for (const task of group.tasks) {
        result.skipped.push({ id: task.id, title: task.title, reason: "任务已经在目标自动化会话上，无需迁移" });
      }
      continue;
    }
    if (dryRun) {
      // dryRun 只列计划：`to` 留空（新任务还没建），行数/标题已经足够判断要不要真跑。
      for (const task of group.tasks) result.migrated.push({ from: task.id, to: "", title: task.title });
      continue;
    }

    try {
      const outcome = await migrate({ cwd: group.cwd, fromSessionId: groupSessionId, toSessionId: target });
      const migrated = outcome !== null && typeof outcome === "object" && Array.isArray(outcome.migrated) ? outcome.migrated : [];
      const failed = outcome !== null && typeof outcome === "object" && Array.isArray(outcome.failed) ? outcome.failed : [];
      for (const item of migrated) {
        result.migrated.push({ from: String(item.from ?? ""), to: String(item.to ?? ""), title: String(item.title ?? "") });
      }
      for (const item of failed) {
        result.failed.push({
          id: String(item.id ?? ""),
          title: String(item.title ?? ""),
          code: String(item.code ?? ""),
          message: String(item.message ?? ""),
        });
      }
    } catch (error) {
      // 迁移器抛错：这一组整体算失败，但**不中断其它组**，也不把异常甩给模型。
      const message = messageOf(error);
      warnLog(log, `修复任务：迁移会话 ${groupSessionId} 上的任务失败（${message}），其余组继续`);
      result.failed.push({
        id: "",
        title: group.tasks.map((task) => task.title).join(" / "),
        code: codeOf(error, "migrate_failed"),
        message,
      });
    }
  }

  if (result.failed.length > 0) result.ok = false;
  return result;
}

/**
 * `automation_zone_repair_tasks` 渲染器。
 * @param {unknown} args
 * @param {object} value
 */
export function renderRepairTasks(args, value) {
  const dryRun = args !== null && typeof args === "object" && args.dryRun === true;
  const migrated = Array.isArray(value?.migrated) ? value.migrated : [];
  const failed = Array.isArray(value?.failed) ? value.failed : [];
  const skipped = Array.isArray(value?.skipped) ? value.skipped : [];
  const lines = [];

  if (value === null || typeof value !== "object" || value.ok !== true) {
    lines.push("修复孤儿任务失败：" + (value?.code ?? "unknown_error"));
    if (typeof value?.message === "string" && value.message.length > 0) lines.push(`- ${value.message}`);
  } else if (dryRun) {
    lines.push(`孤儿任务修复计划（dryRun：一条都没动）：待迁移 ${migrated.length} 条`);
  } else {
    lines.push(migrated.length === 0 ? "孤儿任务修复：没有需要迁移的任务" : `孤儿任务修复：已迁移 ${migrated.length} 条任务`);
  }

  for (const item of migrated) {
    lines.push(dryRun ? `- 计划迁移：${item.title}（${item.from}）` : `- ${item.title}：${item.from} → ${item.to}`);
  }
  if (dryRun && migrated.length > 0) {
    lines.push("（dryRun 下 from 是任务 id、to 为空——新任务还没建；去掉 dryRun 才会真的建+删）");
  }
  for (const item of skipped) lines.push(`- 跳过 ${item.title}（${item.id}）：${item.reason}`);
  for (const item of failed) lines.push(`- 失败 ${item.title}（${item.id}）：${item.code} ${item.message}`);

  if (failed.length > 0) {
    lines.push("失败的条目留在原会话上照常触发（先建后删，所以没有丢任务），但没搬到自动化会话；按 code/message 处理后再跑一次。");
  }
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * 建 `automation_zone_repair_tasks` 工具定义。
 * @param {{schedule: object, sessionController?: object, loadState: Function,
 *   ensureZoneSession: Function, migrate: Function, log?: object}} services
 */
export function createRepairTasksTool(services) {
  return {
    name: REPAIR_TOOL_NAME,
    description: [
      "修复孤儿任务：把寄生在普通会话上的 active 定时任务迁回它所属项目的「⚙ 自动化任务」会话。",
      "不给 fromSessionId：按 automation_zone_status 的同一套孤儿口径自动找出全部孤儿，逐个迁到该任务 cwd 对应的自动化会话；cwd 读不出来就跳过并报「cwd 未知」。",
      "给了 fromSessionId：只迁这一个会话上的 active 任务，目标 cwd 缺省为 DSH_ROOT（未设置则取进程 cwd），可用 cwd 覆盖。",
      "dryRun=true 只列计划，不建会话、不建任务、不删任务。",
      "迁移做法是「在新会话建 + 删旧的」（dsh-schedule 没有改绑 sessionId 的 API），所以 migrated 里 from/to 是**任务 id**。",
    ].join(""),
    parameters: REPAIR_PARAMETERS,
    output: { schema: REPAIR_OUTPUT_SCHEMA, render: renderRepairTasks },
    async execute(args) {
      return repairTasks({ ...services, args });
    },
  };
}

// ---------------------------------------------------------------------------
// 主动开口判定器（automation_proactive_gate）
//
// 这是 speak-up 的「掷骰节流曲线」迁过来之后的样子，但**只保留判定、不承担开口**：
// DSH 的 schedule 由内核到点触发，插件拦不住"这一轮该不该真跑"，所以节流只能做成
// 「真开口之前先问一次门」。调用方（模型/别的插件）拿到 speak 之后自己去开口，
// 开口成功再调一次 action=record 记下时间——冷却才有依据。
// ---------------------------------------------------------------------------

/** 判定器的返回结构。字段全部显式构造（不留 undefined，否则过不了 output.schema）。 */
const GATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    action: { type: "string" },
    decision: { type: "string" },
    code: { type: "string" },
    cwd: { type: "string" },
    sessionId: { type: "string" },
    tier: { type: "string" },
    base: { type: "number" },
    factor: { type: "number" },
    bonus: { type: "number" },
    line: { type: "number" },
    nextLine: { type: "number" },
    // 0~1 的原始随机数（上游 Math.random() 的原样），比较时乘 100。硬闸拦下时没有这个字段。
    roll: { type: "number" },
    streak: { type: "number" },
    lastSpokeAt: { type: "number" },
    minutesSinceLastUserMessage: { type: "number" },
    equation: { type: "string" },
    reason: { type: "string" },
    // gated（登记/取消登记定时任务闸门）用的字段。
    scheduleId: { type: "string" },
    gated: { type: "boolean" },
    throttleEnabled: { type: "boolean" },
    gatedTaskCount: { type: "number" },
    wrote: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["ok"],
};

/** 判定器的参数表。 */
const GATE_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["check", "record", "gated"],
      description:
        "check = 问一次门（该不该开口）；record = 真开口之后记一笔（把冷却起点记为现在）；"
        + "gated = 把某条定时任务登记为闸门对象（或取消登记），让它每次到点投递进来的那一轮都自动被判定并注入结论",
    },
    cwd: {
      type: "string",
      description: "可选：项目目录（缺省按调用者会话的 cwd 解析；传了必须是已存在的目录）",
    },
    sessionId: {
      type: "string",
      description: "可选：用哪个会话来算「距上次说话」（缺省用该 cwd 对应的自动化会话）",
    },
    scheduleId: {
      type: "string",
      description: "gated 必填：要登记/取消登记的定时任务 id（就是 schedule_id_json 里的那个 id）",
    },
    gated: {
      type: "boolean",
      description: "gated 用：true = 登记为闸门对象；false = 取消登记（缺省 true）",
    },
    note: {
      type: "string",
      description: "gated 可选：给这条任务留一句备注，判定结论会带在注入里（例如「周一早报，别提前」）",
    },
  },
  required: ["action"],
};

/**
 * 这条 `user/message` 是不是**本插件/子系统自己灌进去的**（不算"人说了话"）。
 *
 * 为什么必须排掉：DSH 会把运行时上下文快照、system-reminder 这类东西当作
 * user 角色消息塞进 messages。把它们当成"用户刚说话"会让时机因子落到近因子
 * （0.15），命中线被压到极低——于是每轮都判定"可以开口"，这恰好是最该避免的失效。
 *
 * ⚠ 判据只能保守：拿不到 source 就当成真人（宁可少排，不要误排掉真人的话）。
 *   排错了的代价只是"因子按 1 算"，比"因为一条系统提示就永久闭嘴/狂开口"都轻。
 * @param {unknown} event session 事件
 * @returns {boolean}
 */
function isInjectedUserMessage(event) {
  const data = event !== null && typeof event === "object" ? event.data : undefined;
  const source = data !== null && typeof data === "object" ? data.source : undefined;
  if (source === null || typeof source !== "object") return false;
  const kind = typeof source.kind === "string" ? source.kind : "";
  if (kind.length > 0 && kind !== "user") return true;
  for (const key of ["plugin", "pluginId", "pluginName", "injectedBy"]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

/**
 * 会话历史读缓存的存活时间（毫秒）。
 *
 * 为什么要有这一层：`action=check` 每次都会 `inspect(sessionId)`，而 inspect 会把该会话的
 * **全部历史事件物化一遍**（本机 >1MB 的会话文件 104 个，最大 23MB / 2305 frame）。按
 * 「每轮问一次门」的用法，那就是每轮一次 O(全会话事件)。加缓存后同一会话在 TTL 内只读一次。
 *
 * 为什么 TTL 不做成配置项：那会引入一个新的配置面（要校验、要写文档、要写默认值），而
 * 60 秒这个量级对「距上次说话」的判据几乎没有信息损失——它本来就是分钟级刻度。
 */
export const INSPECT_CACHE_TTL_MS = 60_000;

/** 缓存上限（条）。超出按 Map 插入顺序淘汰最旧的一条，保证不会无界增长。 */
const INSPECT_CACHE_MAX = 64;

/**
 * sessionId → { minutes, atMs }。
 *
 * 键必须是 **sessionId** 而不是 cwd：一个 cwd 可能对应多个会话（换过、重建过），拿 cwd 做键
 * 会在切换时把 A 会话的读数当成 B 会话的，错配没有任何报错。
 */
const inspectCache = new Map();

/** 测试专用：清空缓存（生产路径不需要它）。 */
export function __resetInspectCache() {
  inspectCache.clear();
}

/** 测试专用：只读的条目数（用来断言上限生效，不能让 Map 无界长）。 */
export function __inspectCacheSize() {
  return inspectCache.size;
}

/**
 * 写缓存（含上限淘汰）。
 *
 * 淘汰用 Map 的插入顺序（删第一个键）：写入顺序天然就是「最久没被写/读」的顺序。命中时会
 * 先把键删掉再写回（见下面 hit 分支），所以这里得到的是 **LRU 而不是 FIFO**——理由是
 * 「每轮问一次门」的用法里，被反复问到的那几个会话才是热点；FIFO 会把仍在用的条目淘汰掉，
 * 让最常用的会话反而反复 inspect，恰好抵消这层缓存的意义。刷新顺序的成本是 O(1)，不需要
 * 额外的双向链表。
 * @param {string} sessionId
 * @param {{minutes: number, atMs: number}} entry
 */
function writeInspectCache(sessionId, entry) {
  if (inspectCache.size >= INSPECT_CACHE_MAX) {
    const oldest = inspectCache.keys().next();
    if (oldest.done !== true) inspectCache.delete(oldest.value);
  }
  inspectCache.set(sessionId, entry);
}

/**
 * 距上次（真人）说话多少分钟。**拿不到一律 undefined → 时机因子按 1 算**。
 *
 * 为什么降级而不是报错：inspect 会把这个会话的**全部事件**读出来，长期存活的会话
 * 日志只会越来越大；一次读失败或读慢不该让"该不该开口"这个判断失效——按中性因子算
 * 仍然是有意义的结论。
 *
 * 缓存语义（三条都是刻意的，改之前请先读 throttle.timingFactor）：
 *
 * ① **缓存的是「缓存时刻算出的分钟数」，命中时原样返回，绝不随 now 增长。**
 *    因为分钟数变大 → 时机因子变大（≤20 分钟 0.15 … ≥360 分钟 1.5）→ 命中线
 *    `base × factor + bonus` 变高 → `point >= line` 判「没中」越难 → **更容易开口**。
 *    所以缓存陈旧时如果按 now 重算，就会出现「用户刚说完话、却以为很久没说话」，
 *    那是往危险方向偏。原值返回则它永远是**下界**（真实间隔只会更长不会更短），
 *    方向恒为保守（宁可少开口），误差上限 = TTL。
 *
 * ② **两种 undefined 都不许写缓存**：inspect 抛异常、inspect 成功但会话里找不到真人消息。
 *    `undefined` 会让时机因子按 1（中性）算，而真实值可能极小（刚说过话 → 0.15）；
 *    把 undefined 记住整整一个 TTL，等于在这段时间里持续把结论推向激进侧。
 *
 * ③ **新鲜度判断只用传入的 nowMs，不读裸 Date.now()**：时钟必须和随机数一样可注入，
 *    否则断言会随真实时间漂移（本项目已经踩过「按小时引爆的假红」）。
 * @param {object|undefined} sessionController
 * @param {string} sessionId
 * @param {{warn?: Function}|undefined} log
 * @param {number} [nowMs] 当前时刻（毫秒）；不传就是 Date.now（注入时钟时必须一起传，
 *   否则「距上次说话」用真实时间、档位用注入时间，两把尺子会算出负的间隔）
 * @param {{ttlMs?: number}} [opts] 仅供测试注入 TTL（0 或负数 = 每次都真的 inspect）
 * @returns {Promise<number|undefined>}
 */
export async function minutesSinceLastUserMessageOf(
  sessionController,
  sessionId,
  log,
  nowMs = Date.now(),
  opts = {},
) {
  if (sessionController === null || typeof sessionController !== "object") return undefined;
  if (typeof sessionController.inspect !== "function") return undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;

  const ttlMs = opts !== null && typeof opts === "object" && Number.isFinite(opts.ttlMs)
    ? Number(opts.ttlMs)
    : INSPECT_CACHE_TTL_MS;

  // 判定陈旧时先删掉旧条目：读失败或读不到真人消息时缓存里不该留着上一轮的值。
  const cached = inspectCache.get(sessionId);
  if (cached !== undefined) {
    if (nowMs - cached.atMs < ttlMs) {
      // 刷新插入顺序（删了再写回 = 移到队尾），让它是 LRU 而不是 FIFO。
      inspectCache.delete(sessionId);
      inspectCache.set(sessionId, cached);
      return cached.minutes;
    }
    inspectCache.delete(sessionId);
  }

  let report;
  try {
    report = await sessionController.inspect(sessionId);
  } catch (error) {
    warnLog(log, `判定器读会话 ${sessionId} 的历史失败（时机因子按 1 算）：${messageOf(error)}`);
    return undefined;
  }
  const events = report !== null && typeof report === "object" && Array.isArray(report.events) ? report.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === null || typeof event !== "object" || event.type !== "user/message") continue;
    if (isInjectedUserMessage(event)) continue;
    const time = Number(event.time);
    if (!Number.isFinite(time) || time <= 0) continue;
    const minutes = (nowMs - time) / 60000;
    writeInspectCache(sessionId, { minutes, atMs: nowMs });
    return minutes;
  }
  return undefined;
}

/** 一位小数（渲染层不许出现 NaN / undefined）。 */
function oneDecimal(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(1);
}

/**
 * `automation_proactive_gate` 的渲染器。
 *
 * 文字形态给模型看的三段：**判定结果 → 人话等式 → 下一步该做什么**。
 * 少任何一段都不行：只有结果时模型不知道这个数怎么来的（会把"命中线 20%"
 * 误读成"在骰子点数上加 20%"）；没有下一步时它不知道该记账还是该闭嘴。
 * @param {unknown} _args
 * @param {object} value
 * @returns {Array<{type: 'text', text: string}>}
 */
export function renderGateResult(_args, value) {
  if (value === null || typeof value !== "object" || value.ok !== true) {
    const code = value?.code ?? "unknown_error";
    const message = typeof value?.message === "string" && value.message.length > 0 ? ` — ${value.message}` : "";
    return [{ type: "text", text: `主动开口判定失败：${code}${message}` }];
  }
  if (value.action === "record") {
    const lines = [
      `已记下「刚开过口」（${value.cwd ?? ""}）`,
      `- 时间戳：${value.lastSpokeAt ?? 0}`,
      `- 连没中：${value.streak ?? 0}（record 不动这个计数器）`,
    ];
    return [{ type: "text", text: lines.join("\n") }];
  }
  if (value.action === "gated") {
    const lines = [];
    if (value.gated === true) {
      lines.push(`已把定时任务 ${value.scheduleId ?? ""} 登记为闸门对象`);
      lines.push("- 之后它每次到点投递进来的那一轮，都会按掷骰曲线判定一次，并把结论注入该轮提示");
      lines.push("- 拦下时**挡不住这一轮启动**，只是让模型收到「本轮静默收尾」的指令——门是软的");
    } else {
      lines.push(`已取消登记 ${value.scheduleId ?? ""}`);
      lines.push("- 之后它回到原样：不判定、不注入（零行为变化）");
    }
    if (typeof value.throttleEnabled === "boolean") {
      lines.push(
        value.throttleEnabled
          ? "- 判定器当前是开的 ✓"
          : "- ⚠ 判定器当前是关的（throttle.enabled=false）：登记已写盘，但闸门不会生效；"
            + "要启用请在 cordis.patch.yml 的 automation-zone 行加 throttle.enabled: true 并重启 DSH",
      );
    }
    if (Number.isFinite(value.gatedTaskCount)) lines.push(`- 已登记任务数：${value.gatedTaskCount}`);
    if (value.wrote !== true) lines.push("- ⚠ 本次没有写盘（状态文件读不出来），登记未生效");
    return [{ type: "text", text: lines.join("\n") }];
  }
  const lines = [];
  if (value.decision === "speak") lines.push("判定：可以开口 ✓");
  else if (value.decision === "hold") lines.push("判定：这轮先别说 ✗");
  else lines.push("判定：被硬闸拦下（这轮没掷骰子）⛔");
  if (typeof value.reason === "string" && value.reason.length > 0) lines.push(`- 原因：${value.reason}`);
  if (typeof value.equation === "string" && value.equation.length > 0) lines.push(`- ${value.equation}`);
  if (Number.isFinite(value.minutesSinceLastUserMessage)) {
    lines.push(`- 距上次说话：${oneDecimal(value.minutesSinceLastUserMessage)} 分钟`);
  } else {
    lines.push("- 距上次说话：不明（时机因子按 1 算）");
  }
  lines.push(`- 记账：连没中 ${value.streak ?? 0}${value.wrote === true ? "（已写回状态文件）" : ""}`);

  if (value.decision === "speak") {
    lines.push("下一步：真开口之后用 action=record 记一笔，否则冷却不生效、下一轮还会判定可以开口。");
  } else if (value.decision === "hold") {
    lines.push(
      `下一步：这轮别开口。如果下一轮还是没中，命中线会变成 ${oneDecimal(value.nextLine)}（越攒越好掷中）。`,
    );
  } else if (value.code === "disabled") {
    lines.push("下一步：判定器默认是关的。要启用请在 cordis.patch.yml 的 automation-zone 行加 throttle.enabled: true 并重启 DSH。");
  } else if (value.code === "quiet-hours") {
    lines.push("下一步：安静时段内不开口，等窗口过去再问一次。");
  } else if (value.code === "cooldown") {
    lines.push("下一步：自己刚开过口，等冷却过去再问一次（冷却时长见配置 cooldownMinutes）。");
  }
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * 建 `automation_proactive_gate` 工具定义。
 *
 * 依赖注入：`loadState` / `saveState` / `random` 都能换（生产里就是 storage 的两个函数
 * 与 Math.random），所以整段判定 + 记账逻辑不需要真起 DSH 就能验。
 * @param {{
 *   sessionController?: object,
 *   loadState: Function,
 *   stateFile?: string,
 *   log?: object,
 *   throttle?: object,
 *   saveState?: Function,
 *   random?: () => number,
 *   now?: () => number,
 * }} services
 */
export function createProactiveGateTool(services) {
  const settings = services !== null && typeof services === "object" ? services : {};
  const { sessionController, loadState, log } = settings;
  const throttleCfg = normalizeThrottle(settings.throttle);
  const saveState = typeof settings.saveState === "function" ? settings.saveState : defaultSaveState;
  const random = typeof settings.random === "function" ? settings.random : Math.random;
  // 时钟与随机数一样从外面注入：生产就是 Date.now。**不注入的话「命中线是多少」这类
  // 断言会随真实时间漂移**——09-12 / 14-18 是峰时（基准线 20），其余是谷时（60），
  // 同一个用例上午跑 50、晚上跑 90，看起来像实现坏了，实际是测试没钉死时间。
  const nowFn = typeof settings.now === "function" ? settings.now : Date.now;
  const stateFile = typeof settings.stateFile === "string" && settings.stateFile.length > 0
    ? settings.stateFile
    : defaultStateFile();

  /** 取出某 cwd 的判定记账（缺省 → streak 0、从没开口过）。 */
  function entryOf(state, cwd) {
    const table = state !== null && typeof state === "object"
      && state.throttle !== null && typeof state.throttle === "object"
      ? state.throttle
      : {};
    return normalizeThrottleState(table[cwd]);
  }

  /** 该 cwd 对应的自动化会话 id（只用来算「距上次说话」，拿不到就是 undefined）。 */
  function zoneSessionIdOf(state, cwd) {
    const zones = state !== null && typeof state === "object"
      && state.zones !== null && typeof state.zones === "object"
      ? state.zones
      : {};
    const record = zones[cwd];
    if (record === null || typeof record !== "object") return undefined;
    return typeof record.sessionId === "string" && record.sessionId.length > 0 ? record.sessionId : undefined;
  }

  return {
    name: GATE_TOOL_NAME,
    description: [
      "主动开口判定器（默认关闭）：真开口之前先问一次门。",
      "check = 按 speak-up 的掷骰节流曲线算这次该不该开口，返回 speak / hold / blocked；",
      "record = 真开口之后记一笔（冷却起点），streak 不变。",
      "gated = 把某条定时任务登记为「闸门对象」（或取消登记）：登记后它每次到点投递进来的那一轮，",
      "服务端会自动判定并把结论注入该轮提示，不需要任务自己来问门。",
      "节流只是判定 + 注入，不会阻止内核到点启动那一轮——拦下时靠模型遵守注入指令静默收尾。",
    ].join(""),
    parameters: GATE_PARAMETERS,
    output: { schema: GATE_OUTPUT_SCHEMA, render: renderGateResult },
    async execute(args, exec) {
      try {
        if (typeof loadState !== "function") {
          return { ok: false, code: "gate_misconfigured", message: "判定器缺少 loadState 依赖（插件装配有问题）" };
        }
        const action = args !== null && typeof args === "object" && typeof args.action === "string" ? args.action : "";
        if (action !== "check" && action !== "record" && action !== "gated") {
          return {
            ok: false,
            code: "invalid_action",
            message: `action 必须是 "check" / "record" / "gated"（收到 ${JSON.stringify(action || null)}）`,
          };
        }

        // gated 走**自己的**那条路：它按 scheduleId 记账，与 cwd 无关，
        // 所以不需要先解析调用者 cwd（那一步要求目录真实存在，会把登记弄成"必须先 cd 到某处"）。
        if (action === "gated") {
          const raw = args !== null && typeof args === "object" ? args : {};
          const scheduleId = typeof raw.scheduleId === "string" ? raw.scheduleId.trim() : "";
          if (scheduleId.length === 0) {
            return {
              ok: false,
              code: "invalid_schedule_id",
              message: "action=gated 需要 scheduleId（就是该定时任务 schedule_id_json 里的那个 id）",
            };
          }
          const state = loadState();
          const gateReadError = stateReadError(state);
          if (gateReadError !== undefined) {
            warnLog(log, `拒绝写登记：状态文件读不出来（${gateReadError}）；本次不改任何登记`);
            return {
              ok: false,
              code: "state-unreadable",
              message:
                `状态文件读不出来（${gateReadError}）。为避免覆盖其它项目的记录，这次不写盘，登记未生效；`
                + "请先修好状态文件（或删掉它重建）再试",
            };
          }
          const on = raw.gated !== false;
          const existing = taskEntryOf(state, scheduleId);
          const note = typeof raw.note === "string" && raw.note.length > 0 ? raw.note : undefined;
          // 记账沿用已有值：**重新登记不该把「连没中」清零**（那是用户攒出来的加成）。
          const entry = on
            ? {
              enabled: true,
              streak: existing !== undefined ? existing.streak : 0,
              lastSpokeAt: existing !== undefined ? existing.lastSpokeAt : null,
              ...(note !== undefined ? { note } : existing !== undefined && typeof existing.note === "string" ? { note: existing.note } : {}),
            }
            : null;
          const next = upsertTask(state, scheduleId, entry);
          saveState(stateFile, next);
          const registered = Object.keys(next.tasks).filter((id) => next.tasks[id] !== null
            && typeof next.tasks[id] === "object" && next.tasks[id].enabled === true).length;
          return {
            ok: true,
            action: "gated",
            scheduleId,
            gated: on,
            throttleEnabled: throttleCfg.enabled === true,
            gatedTaskCount: registered,
            wrote: true,
          };
        }

        // cwd 走既有口径：先问调用者会话，再退回参数。**不做任何路径规范化**。
        const resolved = await resolveCallerCwd(exec, args !== null && typeof args === "object" ? args.cwd : undefined, sessionController, log);
        if (resolved.ok !== true) return { ok: false, code: resolved.code, message: resolved.message };
        const cwd = resolved.cwd;

        const state = loadState();
        // 读到「读不出来」时**绝不写盘**：盘上可能有一整份别人的记录，照着空表写回
        // 等于把别的项目的 zones 与 throttle 一起删掉（照 zone.js 的 persist 规矩）。
        const readError = stateReadError(state);
        if (readError !== undefined) {
          warnLog(log, `判定器拒绝写入：状态文件读不出来（${readError}）；本次只返回判定、不改任何记账`);
          return {
            ok: false,
            code: "state-unreadable",
            message:
              `状态文件读不出来（${readError}）。为避免覆盖其它项目的记录，这次不写盘、也不动连没中计数；` +
              "请先修好状态文件（或删掉它重建）再试",
          };
        }

        const previous = entryOf(state, cwd);
        const nowMs = nowFn();
        const explicitSessionId = args !== null && typeof args === "object" && typeof args.sessionId === "string" && args.sessionId.length > 0
          ? args.sessionId
          : undefined;
        const sessionId = explicitSessionId ?? zoneSessionIdOf(state, cwd);

        if (action === "record") {
          const entry = { streak: previous.streak, lastSpokeAt: nowMs };
          saveState(stateFile, upsertThrottle(state, cwd, entry));
          return {
            ok: true,
            action: "record",
            cwd,
            ...(sessionId !== undefined ? { sessionId } : {}),
            streak: entry.streak,
            lastSpokeAt: entry.lastSpokeAt,
            wrote: true,
          };
        }

        const minutes = await minutesSinceLastUserMessageOf(sessionController, sessionId, log, nowMs);
        const result = decide({
          cfg: throttleCfg,
          now: nowMs,
          streak: previous.streak,
          lastSpokeAt: previous.lastSpokeAt,
          minutesSinceLastUserMessage: minutes,
          // 随机数从外面注入：生产就是 Math.random，测试钉死结果用。
          roll: random(),
        });

        // 掷中清零 / 没中 +1 / 硬闸不动 —— 规则只在 throttle.js 的 nextStreak 里写一次。
        const streak = nextStreak(result.decision, previous.streak);
        const wrote = result.decision !== "blocked";
        if (wrote) saveState(stateFile, upsertThrottle(state, cwd, { streak, lastSpokeAt: previous.lastSpokeAt }));

        const equation = lineEquation({
          line: result.line,
          tier: result.tier,
          base: result.base,
          factor: result.factor,
          minutes,
          bonus: result.bonus,
        });
        return {
          ok: true,
          action: "check",
          decision: result.decision,
          code: result.code,
          cwd,
          ...(sessionId !== undefined ? { sessionId } : {}),
          tier: result.tier,
          base: result.base,
          factor: result.factor,
          bonus: result.bonus,
          line: result.line,
          nextLine: result.nextLine,
          ...(result.roll !== null && result.roll !== undefined ? { roll: result.roll } : {}),
          streak,
          ...(previous.lastSpokeAt !== null ? { lastSpokeAt: previous.lastSpokeAt } : {}),
          ...(minutes !== undefined ? { minutesSinceLastUserMessage: minutes } : {}),
          equation,
          reason: result.reason,
          wrote,
        };
      } catch (error) {
        // 契约：任何异常都必须是 `{ok:false, code, message}`，绝不把异常甩给模型。
        const code = codeOf(error, "gate_failed");
        const message = messageOf(error);
        warnLog(log, `判定器内部错误（${code}）：${message}`);
        return { ok: false, code, message };
      }
    },
  };
}
