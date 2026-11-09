/**
 * 定时任务闸门（schedule gate）：把「主动开口判定器」从**被动工具**升级成
 * **schedule 投递的服务端准入层**。
 *
 * 为什么需要这一层：`automation_proactive_gate` 是「真开口之前先问一次门」，问不问
 * 全靠调用方自觉——一个到点就自己跑起来的定时任务根本不会来问。于是节流曲线对一个
 * "每天 9 点自动发日报"的任务完全不生效：它会照常跑、照常产出。
 *
 * 本模块做的事：在**服务端**认出「这一轮是定时任务投递进来的」，按同一条掷骰曲线判定，
 * 并把判定结论作为一行提示注入到该轮的系统提示里（走 `systemPrompt.context`，
 * 不改 messages、不伪造历史）。
 *
 * ⚠ 诚实边界（必须在 CONTRACT/README 里与这里一致）：
 *   门**只能判定 + 注入 + 记账**，它**挡不住内核到点启动这一轮**。省下的是这一轮之后的
 *   动作（工具调用、产出、对外发送），不是那个 tick 本身。拦下时靠模型读注入指令
 *   静默收尾——它是有概率不听的，所以这不是硬隔离，是**软闸门**。
 *
 * 本文件的三条设计约束：
 *   1. **纯函数优先**：`parseScheduleOrigin` / `minutesSinceLastHumanMessage` /
 *      `renderGateNote` 都不碰 ctx、不读盘、不读真实时钟（时钟一律作参数传入）。
 *   2. **依赖全部注入**：`createGateInjector` 只接受 `{loadState, saveState, throttle,
 *      log, now, random}`，所以整条判定链可以脱离 DSH 单测。
 *   3. **默认零行为变化**：没有任何任务被登记（`state.tasks` 为空）时，`render()`
 *      永远返回空串——注册一个 context 的代价是每轮多一次空函数调用，不是多一段提示。
 */

import { neutralizeBraces } from "./prompt.js";
import { clamp, decide, nextStreak, normalizeThrottle } from "./throttle.js";
import { stateReadError, taskEntryOf, upsertTask } from "./storage.js";

/** schedule 投递消息的来源标记（`@deepseek-ai/dsh-schedule` 写的就是这个值）。 */
export const SCHEDULE_SOURCE_KIND = "schedule";

/** 单条提醒的 framing 首行。 */
export const FRAMING_SINGLE = "[SCHEDULE REMINDER]";

/** 批量提醒的 framing 首行。 */
export const FRAMING_BATCH = "[SCHEDULE REMINDER BATCH]";

/** 判定结论注入块的固定前缀（用户靠它一眼看出「这不是人说的话」）。 */
export const GATE_NOTE_TAG = "[自动化闸门]";

/** 注入管道的名字与 order。order 必须**大于** INJECT_SECTION_ORDER(2950)，排在那条静态规则之后。 */
export const GATE_CONTEXT_NAME = "automation-zone:schedule-gate";
export const GATE_CONTEXT_ORDER = 2960;

/**
 * 「这条 user 消息是子系统灌进来的」判据里的来源名单。
 *
 * 与 `src/tools.js` 的 `isInjectedUserMessage` 同一个判据（kind 非空且不是 'user'），
 * 这里只把**已知会出现在会话里的**几种列出来当文档，判定本身按「非 user 即注入」做，
 * 名单漏了也不会误判真人。
 */
export const HOST_INJECTED_SOURCE_KINDS = Object.freeze([
  "runtime-context",
  "time-context",
  "system-reminder",
  "system",
  "time-sampled",
  "compaction",
  "goal",
]);

/** 会话观察表的默认上限（条）。超了按插入顺序淘汰，保证不无界增长。 */
const SESSION_CACHE_MAX = 64;

/** 「本轮已判定过」备忘表的默认上限（条）。同一轮多个 step 复用同一个结论，绝不重掷。 */
const DECISION_CACHE_MAX = 256;

/** 消息 id 索引的上限（条）。 */
const MESSAGE_INDEX_MAX = 512;

/** 单条注入里 scheduleId 的最大展示长度（防止一条脏数据把提示撑爆）。 */
const MAX_ID_TEXT = 80;

// ---------------------------------------------------------------------------
// 消息形状的读取（全部容错：拿不到就返回空，绝不抛）
// ---------------------------------------------------------------------------

/**
 * 取消息的来源对象。会话事件里消息在 `event.data`，有时外面还会再包一层。
 * @param {unknown} message
 * @returns {object|undefined}
 */
function sourceOf(message) {
  if (message === null || typeof message !== "object") return undefined;
  const own = /** @type {{source?: unknown}} */ (message).source;
  if (own !== null && typeof own === "object") return /** @type {object} */ (own);
  const nested = /** @type {{data?: {source?: unknown}}} */ (message).data;
  if (nested !== null && typeof nested === "object" && nested.source !== null && typeof nested.source === "object") {
    return /** @type {object} */ (nested.source);
  }
  return undefined;
}

/**
 * 消息来源的 kind（`user` / `schedule` / `runtime-context` …）。取不到就是空串。
 * @param {unknown} message
 * @returns {string}
 */
export function sourceKindOf(message) {
  const source = sourceOf(message);
  if (source === undefined) return "";
  const kind = /** @type {{kind?: unknown}} */ (source).kind;
  return typeof kind === "string" ? kind : "";
}

/**
 * 把一条消息里的文本块拼起来。
 * @param {unknown} message
 * @returns {string}
 */
export function messageTextOf(message) {
  if (message === null || typeof message !== "object") return "";
  const direct = /** @type {{text?: unknown}} */ (message).text;
  if (typeof direct === "string") return direct;
  const content = /** @type {{content?: unknown}} */ (message).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * 这条 user 消息是不是**子系统自己灌进去的**（不算"人说了话"）。
 *
 * 判据与 tools.js 完全一致（保守：拿不到 source 就当真人），但这里额外**认 schedule**——
 * schedule 消息也是注入的，可它恰恰是本模块要认的那一种，所以调用方要自己先判 schedule。
 * @param {unknown} message
 * @returns {boolean}
 */
export function isHostInjectedUserMessage(message) {
  const source = sourceOf(message);
  if (source === undefined) return false;
  const kind = typeof /** @type {{kind?: unknown}} */ (source).kind === "string"
    ? /** @type {{kind: string}} */ (source).kind
    : "";
  if (kind.length > 0 && kind !== "user") return true;
  for (const key of ["plugin", "pluginId", "pluginName", "injectedBy"]) {
    const value = /** @type {Record<string, unknown>} */ (source)[key];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

/**
 * 取消息时间戳（毫秒）。拿不到就是 null。
 * @param {unknown} message
 * @returns {number|null}
 */
function timestampOf(message) {
  if (message === null || typeof message !== "object") return null;
  for (const key of ["time", "atMs", "ts", "createdAt"]) {
    const value = Number(/** @type {Record<string, unknown>} */ (message)[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// framing 解析
// ---------------------------------------------------------------------------

/**
 * 宽容地把一段 JSON 文本解析出来。
 *
 * 两层容错都是必需的：`JSON.stringify` 出来的串在一次以上的转发里会被再转义一遍
 * （`\"abc\"`），此时严格 `JSON.parse` 直接抛；而这里宁可多解一次也不返回 undefined，
 * 因为「解析失败」在下游等价于「取不到 scheduleId」，那会让闸门静默失效。
 * @param {string} raw
 * @returns {unknown}
 */
function parseLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // 第二层：把被二次转义的引号还原一次再试。
    try {
      return JSON.parse(raw.replace(/\\"/g, '"'));
    } catch {
      return undefined;
    }
  }
}

/**
 * 从 `key` 后面把那个 JSON 值（字符串或数组）原样切出来再解析。
 *
 * 为什么不用正则一把梭：批量 framing 的 `reminders_json` 是**多行 pretty-print 的数组**，
 * 正则里的 `.*` 跨不了行、`[\s\S]*` 又会贪婪到把后面的正文也吞掉。按括号配对切才稳。
 * @param {string} text
 * @param {string} key
 * @returns {unknown}
 */
function extractJsonAfter(text, key) {
  const at = text.indexOf(key);
  if (at < 0) return undefined;
  let i = at + key.length;
  while (i < text.length && (text[i] === ":" || text[i] === " " || text[i] === "\t")) i += 1;
  if (i >= text.length) return undefined;
  const open = text[i];
  // 被二次转义过的形态：\"abc\"
  if (open === "\\" && text[i + 1] === '"') {
    const rest = text.slice(i);
    const matched = /^\\"((?:[^\\]|\\.)*?)\\"/.exec(rest);
    if (matched === null) return undefined;
    return matched[1].replace(/\\"/g, '"');
  }
  if (open === '"') {
    let out = '"';
    i += 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        out += ch + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      if (ch === '"') break;
    }
    return parseLoose(out);
  }
  if (open === "[") {
    let depth = 0;
    let inString = false;
    let out = "";
    while (i < text.length) {
      const ch = text[i];
      out += ch;
      if (inString) {
        if (ch === "\\") {
          out += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (ch === '"') inString = false;
        i += 1;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    return parseLoose(out);
  }
  return undefined;
}

/**
 * 从一个解析出来的 JSON 值里收集 scheduleId。
 * @param {unknown} value
 * @returns {string[]}
 */
function idsOfValue(value) {
  const ids = [];
  const push = (candidate) => {
    if (typeof candidate !== "string") return;
    let text = candidate.trim();
    // 再被包一层的形态：值是「一个 JSON 字符串」本身（`"\"abc\""` 解出来的 `"abc"`）。
    // 不剥这一层，拿到的 scheduleId 会带引号、与状态表里的 key 对不上，
    // 而失败表现是「闸门静默不注入」——没有报错，最难查。
    if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
      try {
        const inner = JSON.parse(text);
        if (typeof inner === "string" && inner.trim().length > 0) text = inner.trim();
      } catch {
        /* 不是合法 JSON 串就原样用，别把好数据丢掉 */
      }
    }
    if (text.length === 0) return;
    if (!ids.includes(text)) ids.push(text);
  };
  if (typeof value === "string") push(value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") push(item);
      else if (item !== null && typeof item === "object") {
        const record = /** @type {Record<string, unknown>} */ (item);
        push(record.schedule_id ?? record.scheduleId ?? record.id);
      }
    }
  } else if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    push(record.schedule_id ?? record.scheduleId ?? record.id);
  }
  return ids;
}

/**
 * 判定「本轮最后一条 user 消息」是不是定时任务投递的，并取出它的 scheduleId。
 *
 * 两条路：结构化 `source.kind === 'schedule'`（权威）与 framing 文本匹配（兜底）。
 * 为什么还要文本兜底：kind 是上游实现细节，一旦它改名/换值，只认 kind 的闸门会**静默失效**
 * ——那是最难发现的失效形态（没有任何日志）。framing 首行在 `dsh-schedule` 的渲染层里
 * 是稳定的字面量，两边都认才不容易一起坏。
 *
 * 取不到 ids 时仍然 `isScheduled: true`、`scheduleIds: []`：判定「是不是定时任务」
 * 与「能不能做准入」是两件事，前者照样要如实回答。
 * @param {unknown} lastUserMessage
 * @returns {{isScheduled: boolean, scheduleIds: string[]}}
 */
export function parseScheduleOrigin(lastUserMessage) {
  const structured = sourceKindOf(lastUserMessage) === SCHEDULE_SOURCE_KIND;
  const text = messageTextOf(lastUserMessage);
  const isScheduled = structured || text.includes(FRAMING_SINGLE) || text.includes(FRAMING_BATCH);
  const scheduleIds = [];
  if (isScheduled) {
    for (const key of ["schedule_id_json", "reminders_json"]) {
      for (const id of idsOfValue(extractJsonAfter(text, key))) {
        if (!scheduleIds.includes(id)) scheduleIds.push(id);
      }
    }
  }
  return { isScheduled, scheduleIds };
}

// ---------------------------------------------------------------------------
// 「距上次真人说话」
// ---------------------------------------------------------------------------

/**
 * 距最后一条**真人**消息多少分钟。取不到返回 `null`（**不返回 0**）。
 *
 * 为什么必须是 null 而不是 0：0 分钟会让时机因子落到近因子（0.15），命中线被压到极低，
 * 于是判定几乎必然"可以开口"——把「读不到」当成「刚说完话」是往激进侧偏。
 * null 在 `decide()` 里走中性因子 1，是已知偏保守的降级。
 *
 * 排掉的两类：
 *   - 来源 kind 非空且不是 'user' 的（schedule 自己、runtime-context、system-reminder…）；
 *   - 时间戳取不到的（宁可跳过也不猜）。
 * @param {unknown} messages
 * @param {number} nowMs
 * @returns {number|null}
 */
export function minutesSinceLastHumanMessage(messages, nowMs) {
  if (!Array.isArray(messages)) return null;
  if (!Number.isFinite(Number(nowMs))) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === null || typeof message !== "object") continue;
    const role = typeof /** @type {{role?: unknown}} */ (message).role === "string"
      ? /** @type {{role: string}} */ (message).role
      : "user";
    if (role !== "user") continue;
    if (isHostInjectedUserMessage(message)) continue;
    const at = timestampOf(message);
    if (at === null) continue;
    // 时钟倒流（注入时钟比消息时间还早）时夹到 0，别把负数喂给时机因子。
    return clamp((Number(nowMs) - at) / 60000, 0, Number.MAX_SAFE_INTEGER);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 注入文本
// ---------------------------------------------------------------------------

/**
 * code 的中文直译。模型看不懂 `cooldown` 这类词，但它看得懂"开口冷却中"。
 * @param {unknown} code
 * @returns {string}
 */
export function describeGateCode(code) {
  const text = typeof code === "string" ? code : "";
  if (text === "disabled") return "判定器关闭";
  if (text === "quiet-hours") return "安静时段";
  if (text === "cooldown") return "开口冷却中";
  if (text === "miss") return "掷骰没中（命中线未到）";
  if (text === "hit") return "掷骰命中";
  return text.length > 0 ? text : "未给出";
}

/** 取整数形态（NaN / undefined → null）。 */
function intOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** 一份短文本：压成单行 + 截断 + 中和花括号。 */
function shortText(value) {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[\r\n\t]+/g, " ").trim();
  if (flat.length === 0) return "";
  const cut = flat.length > MAX_ID_TEXT ? `${flat.slice(0, MAX_ID_TEXT)}…` : flat;
  // 这里**不**中和花括号：中和只在 `renderGateNote` 的出口做一次。
  // 两处都做会造出一个「删掉任何一处测试都不红」的死角（实测：出口那处删了 26 例全绿，
  // 因为字段早就被这里中和过）。一个语义只能有一个收敛点，才拦得住变异。
  return cut;
}

/**
 * 渲染注入的判定结论（**一行**，永远单行）。
 *
 * 三种形态：
 *   - 放行：命中线 / 掷值 / 连续没中 + 「按原任务正常执行」；
 *   - 拦下（hold / blocked）：code 直译中文 + 「本轮静默收尾」的具体要求。
 *
 * 为什么必须显式写「静默收尾」的**动作清单**：只说"被拦下"时模型最常见的反应是
 * "那我就简短汇报一下"——那照样是一次对外产出，等于闸门白拦。
 *
 * 输出统一过 `neutralizeBraces`：本串会进 `systemPrompt.context`，而 context 文本**会经插值**
 * （连续的 `{{` 才会炸，但 scheduleId / 备注是外部数据，不能赌它没有）。
 * @param {unknown} decision 'speak' | 'hold' | 'blocked'
 * @param {{scheduleId?: unknown, line?: unknown, roll?: unknown, streak?: unknown, code?: unknown, note?: unknown}} [ctxInfo]
 * @returns {string}
 */
export function renderGateNote(decision, ctxInfo = {}) {
  const info = ctxInfo !== null && typeof ctxInfo === "object" ? ctxInfo : {};
  const kind = typeof decision === "string" ? decision : "";
  const id = shortText(info.scheduleId);
  const note = shortText(info.note);
  const line = intOf(info.line);
  const roll = intOf(typeof info.roll === "number" ? info.roll * 100 : null);
  const streak = intOf(info.streak) ?? 0;

  const facts = [];
  if (id !== "") facts.push(`scheduleId=${id}`);
  if (note !== "") facts.push(`备注：${note}`);

  const dice = [];
  if (line !== null) dice.push(`命中线 ${line}`);
  if (roll !== null) dice.push(`掷值 ${roll}`);
  dice.push(`连续没中 ${streak} 次`);

  let body;
  if (kind === "speak") {
    body = `${GATE_NOTE_TAG} 本次定时任务通过门（${dice.join(" / ")}）：按原任务正常执行，该产出就产出。`;
  } else {
    // 非 speak 一律按「拦下」写（保守方向：判不准时不放行）。
    const reason = describeGateCode(info.code);
    const codeText = typeof info.code === "string" && info.code.length > 0 && info.code !== reason ? ` ${info.code}` : "";
    body = `${GATE_NOTE_TAG} 本次定时任务被拦下（原因：${reason}${codeText}；${dice.join(" / ")}）`
      + "：本轮静默收尾——不要产出任何对外内容、不要发通知、不要写业务文件、不要调用其它工具，说完一句结束语就结束。";
  }
  const composed = facts.length === 0 ? body : `${body}（${facts.join("；")}）`;
  return neutralizeBraces(composed.replace(/[\r\n\t]+/g, " "));
}

// ---------------------------------------------------------------------------
// 注入器（依赖全注入，可脱 DSH 单测）
// ---------------------------------------------------------------------------

/**
 * 从 `systemPrompt.context` 的 text 回调入参里取会话 id。
 *
 * 依据：`dsh-agent/lib/index.js:291-297` 的 `assembleContextFor(agent, signal)`
 * 返回 `{ agent, scope: agent, ...signal }`，而 agent 的 `id` 就是会话 id
 * （`dsh-agent-loop` 的报错原文里写过 `agent "session-xxxx"`）。
 * 拿不到就返回 undefined —— 调用方据此「这一轮什么都不注入」，绝不猜。
 * @param {unknown} context
 * @returns {string|undefined}
 */
export function sessionIdOfContext(context) {
  if (context === null || typeof context !== "object") return undefined;
  const agent = /** @type {{agent?: unknown}} */ (context).agent;
  const session = /** @type {{session?: unknown}} */ (context).session;
  const scope = /** @type {{scope?: unknown}} */ (context).scope;
  const candidates = [
    agent !== null && typeof agent === "object" ? /** @type {{id?: unknown}} */ (agent).id : undefined,
    agent !== null && typeof agent === "object" ? /** @type {{session?: {id?: unknown}}} */ (agent).session?.id : undefined,
    scope !== null && typeof scope === "object" ? /** @type {{id?: unknown}} */ (scope).id : undefined,
    session !== null && typeof session === "object" ? /** @type {{id?: unknown}} */ (session).id : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * 简单 hash（只用来给"没有 id 的消息"造一个稳定身份，不做安全用途）。
function hashText(text) {
  let hash = 5381;
  const source = typeof text === "string" ? text : "";
  for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}

/**
 * 造一个定时任务闸门注入器。
 *
 * 数据来源（按优先级）：
 *   1. **`session/event` 观察表**（主）：schedule 投递会把消息以 `agent/inbox/spliced`
 *      写进会话日志，随后 step 1 才 append `user/message`——两条都在观察范围内，
 *      而且都发生在 prompt 组装**之前**，所以 step 1 就能拿到结论。
 *   2. **`agent/pre-step` 的本批 messages**（次）：它拿到的是"本轮新增消息"，
 *      但**在 prompt 组装之后**才触发（`dsh-agent-loop/lib/index.js:906-918`：
 *      claim → assemble → pre-step waterfall），所以它只能用来**补认领**，不能当成
 *      主来源——只靠它会让结论晚一个 step 到达，一轮只有一步时等于永远不到。
 *   3. `sessionController.inspect` 兜底：需要 await，而 `systemPrompt.context` 的
 *      `text(context)` 是**同步调用**（同文件 `:359` 直接取返回值、不 await），
 *      所以本模块**不做** inspect 兜底——宁可如实少注入一行，也不把异步塞进同步路径。
 *      代价写在 CONTRACT：插件热载/DSH 重启后，**投递发生在插件激活之前**的那条提醒
 *      取不到来源，那一轮不注入（fail-open，原任务照常执行）。
 *
 * @param {{
 *   loadState?: Function,
 *   saveState?: Function,
 *   throttle?: unknown,
 *   log?: {warn?: Function, info?: Function},
 *   now?: () => number,
 *   random?: () => number,
 * }} services
 */
export function createGateInjector(services = {}) {
  const settings = services !== null && typeof services === "object" ? services : {};
  const loadState = typeof settings.loadState === "function" ? settings.loadState : undefined;
  const saveState = typeof settings.saveState === "function" ? settings.saveState : undefined;
  const cfg = normalizeThrottle(settings.throttle);
  const log = settings.log;
  const nowFn = typeof settings.now === "function" ? settings.now : Date.now;
  const randomFn = typeof settings.random === "function" ? settings.random : Math.random;

  /** sessionId → { lastUser, lastHumanAtMs }。 */
  const sessions = new Map();
  /** `${sessionId}::${messageKey}` → 注入文本（含空串：同一轮绝不重掷）。 */
  const decisions = new Map();
  /** messageId → sessionId（给 pre-step 那批 messages 反查会话用）。 */
  const messageIndex = new Map();
  /** 告警去重集合（同一条只喊一次，避免每轮刷屏）。 */
  const warned = new Set();

  /**
   * 告警出口（同一条只喊一次）。
   *
   * ⚠ 这里**不要**图省事写成 `warn(...)`：本模块刻意零内部依赖（不 import storage），
   * 直接调 `log.warn` 是唯一不会踩「未定义函数」的写法。踩过一次：
   * 那行在 `render` 的 try/catch 里，异常被 fail-open 吞成空串，
   * 表现是「闸门静默不注入」，而不是报错。
   */
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    if (warned.size > 256) warned.clear();
    if (log !== undefined && log !== null && typeof log.warn === "function") {
      log.warn(`automation-zone: ${message}`);
    }
  }

  /** 淘汰策略：Map 插入顺序 = 最旧，删第一个即可（O(1)，不需要双向链表）。 */
  function boundMap(map, max) {
    while (map.size > max) {
      const oldest = map.keys().next();
      if (oldest.done === true) return;
      map.delete(oldest.value);
    }
  }

  function sessionRecord(sessionId) {
    let record = sessions.get(sessionId);
    if (record === undefined) {
      record = { lastUser: undefined, lastHumanAtMs: undefined };
      sessions.set(sessionId, record);
      boundMap(sessions, SESSION_CACHE_MAX);
    } else {
      // 命中即移到队尾（LRU 而不是 FIFO）：热点会话不该被偶发的一次访问挤掉。
      sessions.delete(sessionId);
      sessions.set(sessionId, record);
    }
    return record;
  }

  /**
   * 记一条 user 消息。
   *
   * 关键取舍：**只让「真人」与「schedule」两种来源更新 lastUser**。
   * 其它注入来源（runtime-context / system-reminder / goal 轮次…）如果也更新，
   * 就会把刚记下的 schedule 标记冲掉——于是同一个 turn 的后几个 step 突然"不是定时任务了"，
   * 闸门只在前一步生效。
   */
  function recordUserMessage(sessionId, message, atMs) {
    if (message === null || typeof message !== "object") return;
    const role = typeof /** @type {{role?: unknown}} */ (message).role === "string"
      ? /** @type {{role: string}} */ (message).role
      : "user";
    if (role !== "user") return;
    const kind = sourceKindOf(message);
    const scheduled = kind === SCHEDULE_SOURCE_KIND;
    if (!scheduled && isHostInjectedUserMessage(message)) return;

    const id = typeof /** @type {{id?: unknown}} */ (message).id === "string"
      ? /** @type {{id: string}} */ (message).id
      : "";
    const key = id.length > 0 ? id : `${Math.trunc(atMs ?? 0)}:${hashText(messageTextOf(message))}`;
    if (id.length > 0) {
      messageIndex.set(id, sessionId);
      boundMap(messageIndex, MESSAGE_INDEX_MAX);
    }

    const record = sessionRecord(sessionId);
    if (record.lastUser !== undefined && record.lastUser.key === key) return;
    const origin = scheduled
      ? { isScheduled: true, scheduleIds: parseScheduleOrigin(message).scheduleIds }
      : parseScheduleOrigin(message);
    record.lastUser = { key, isScheduled: origin.isScheduled, scheduleIds: origin.scheduleIds, kind, atMs };
    if (!scheduled && (kind === "" || kind === "user")) record.lastHumanAtMs = atMs;
  }

  /**
   * 观察一条会话事件（挂 `session/event`）。
   * @param {unknown} sessionId
   * @param {unknown} event
   */
  function observe(sessionId, event) {
    try {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      if (event === null || typeof event !== "object") return;
      const type = /** @type {{type?: unknown}} */ (event).type;
      const time = Number(/** @type {{time?: unknown}} */ (event).time);
      const at = Number.isFinite(time) && time > 0 ? time : nowFn();
      const data = /** @type {{data?: unknown}} */ (event).data;
      if (type === "user/message") {
        recordUserMessage(sessionId, data, at);
        return;
      }
      if (type === "agent/inbox/spliced") {
        const inserted = /** @type {{inserted?: unknown}} */ (data !== null && typeof data === "object" ? data : {}).inserted;
        if (!Array.isArray(inserted)) return;
        for (const message of inserted) recordUserMessage(sessionId, message, at);
      }
    } catch (error) {
      warnOnce("observe", `观察会话事件失败（不影响原任务）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 记下 `agent/pre-step` 拿到的那一批消息（本轮新增）。
   *
   * 只做"补认领"：这批消息通常在 `agent/inbox/spliced` 时已经被观察到了，这里再看一遍
   * 是为了覆盖"插件激活晚于投递、但投递还没被 step 消费"的一小段窗口。反查不到的
   * （从未见过的 messageId）如实跳过并记一条 warn——**没有会话 id 就不能判断是谁的消息**，
   * 猜错会把闸门结论注入到别的会话里。
   * @param {unknown} messages
   */
  function rememberBatch(messages) {
    try {
      if (!Array.isArray(messages)) return;
      for (const message of messages) {
        if (message === null || typeof message !== "object") continue;
        const id = /** @type {{id?: unknown}} */ (message).id;
        if (typeof id !== "string" || id.length === 0) continue;
        const sessionId = messageIndex.get(id);
        if (sessionId === undefined) {
          if (parseScheduleOrigin(message).isScheduled) {
            warnOnce(
              `unclaimed:${id}`,
              "pre-step 收到一条定时任务消息但认不出它属于哪个会话（插件可能在投递之后才激活）；这一轮不注入闸门结论，原任务照常执行",
            );
          }
          continue;
        }
        recordUserMessage(sessionId, message, nowFn());
      }
    } catch (error) {
      warnOnce("batch", `记录 pre-step 消息失败（不影响原任务）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 判定 + 记账 + 渲染。任何异常都 fail-open（返回空串）。 */
  function decideAndRender(sessionId, record, lastUser) {
    if (typeof loadState !== "function") {
      warnOnce("no-load", "闸门缺少 loadState 依赖（插件装配有问题）；不注入、不判定");
      return "";
    }
    const state = loadState();
    const readError = stateReadError(state);
    if (readError !== undefined) {
      // 读不出来 ≠ 空表：既不判定也不写盘（照 storage.js 的 readError 规矩）。
      warnOnce(`read-error:${sessionId}`, `状态文件读不出来（${readError}）：本轮不判定闸门、不改任何记账，原任务照常执行`);
      return "";
    }
    const scheduleId = lastUser.scheduleIds.find((id) => taskEntryOf(state, id)?.enabled === true);
    if (scheduleId === undefined) {
      // 没登记 = 零行为变化（不是错误，不喊）。
      return "";
    }
    if (cfg.enabled !== true) {
      warnOnce(
        `disabled:${scheduleId}`,
        `任务 ${scheduleId} 已登记为闸门对象，但 throttle.enabled=false：闸门不生效（不注入、不记账）`,
      );
      return "";
    }

    const previous = taskEntryOf(state, scheduleId) ?? { enabled: true, streak: 0, lastSpokeAt: null };
    const nowMs = nowFn();
    const minutes = record.lastHumanAtMs !== undefined
      ? clamp((nowMs - record.lastHumanAtMs) / 60000, 0, Number.MAX_SAFE_INTEGER)
      : null;
    const result = decide({
      cfg,
      now: nowMs,
      streak: previous.streak,
      lastSpokeAt: previous.lastSpokeAt,
      minutesSinceLastUserMessage: minutes === null ? undefined : minutes,
      roll: randomFn(),
    });

    // 硬闸（blocked）不动计数器；掷中清零、没中 +1 —— 规则只在 throttle.nextStreak 写一次。
    if (result.decision !== "blocked") {
      const streak = nextStreak(result.decision, previous.streak);
      if (typeof saveState === "function") {
        const next = upsertTask(state, scheduleId, {
          enabled: previous.enabled,
          streak,
          // 冷却起点只在 `action=record`（真开口）时推进；闸门放行 ≠ 已经开口。
          lastSpokeAt: previous.lastSpokeAt,
          ...(typeof previous.note === "string" ? { note: previous.note } : {}),
        });
        saveState(next);
      }
    }

    return renderGateNote(result.decision, {
      scheduleId,
      line: result.line,
      roll: result.roll,
      streak: previous.streak,
      code: result.code,
      ...(typeof previous.note === "string" ? { note: previous.note } : {}),
    });
  }

  /**
   * 渲染本轮要注入的判定结论（**同步**，给 `systemPrompt.context` 的 text 函数用）。
   *
   * 同步是硬约束：`text(context)` 的返回值被直接使用、不 await。任何异步兜底都必须
   * 挪到 `observe` / `rememberBatch` 这两条异步路径上，不能出现在这里。
   * @param {unknown} sessionId
   * @returns {string} 空串表示"这一轮什么都不注入"
   */
  function render(sessionId) {
    try {
      if (typeof sessionId !== "string" || sessionId.length === 0) return "";
      const record = sessions.get(sessionId);
      if (record === undefined || record.lastUser === undefined) return "";
      const lastUser = record.lastUser;
      if (lastUser.isScheduled !== true) return "";
      if (!Array.isArray(lastUser.scheduleIds) || lastUser.scheduleIds.length === 0) {
        warnOnce(
          `no-id:${sessionId}`,
          "认出了定时任务投递，但从 framing 里取不到 scheduleId：无法判断它是否已登记为闸门对象，本轮不注入",
        );
        return "";
      }
      const memoKey = `${sessionId}::${lastUser.key}`;
      const cached = decisions.get(memoKey);
      if (cached !== undefined) {
        // 命中也要刷新顺序（同一轮多个 step 会反复问同一个 key）。
        decisions.delete(memoKey);
        decisions.set(memoKey, cached);
        return cached;
      }
      const note = decideAndRender(sessionId, record, lastUser);
      decisions.set(memoKey, note);
      boundMap(decisions, DECISION_CACHE_MAX);
      return note;
    } catch (error) {
      // 契约：判定失败必须 fail-open（原任务照常），但**必须留一行 warn**。
      warnOnce(
        `render:${typeof sessionId === "string" ? sessionId : "?"}`,
        `闸门判定异常，已放行原任务：${error instanceof Error ? error.message : String(error)}`,
      );
      return "";
    }
  }

  return {
    observe,
    rememberBatch,
    render,
    /** 测试专用：当前观察到的会话数。 */
    __sessionCount: () => sessions.size,
    /** 测试专用：当前备忘条数。 */
    __decisionCount: () => decisions.size,
    /** 测试专用：某个会话观察到的事实（不可变副本）。 */
    __peek: (sessionId) => {
      const record = sessions.get(sessionId);
      if (record === undefined) return undefined;
      return { lastUser: record.lastUser, lastHumanAtMs: record.lastHumanAtMs };
    },
  };
}
