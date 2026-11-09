/**
 * 状态文件（sidecar）读写。
 *
 * 为什么需要这个文件：标题由 LLM 生成、用户还能随手改，拿标题反查“这个是自动化会话”
 * 一定不可靠。「cwd → 自动化会话 id」这条映射必须由插件自己持有，才是唯一真源。
 *
 * 为什么 cwd 不做任何路径规范化：DSH 的记忆轨就是按 cwd 原串 sha1 切分的
 * （`projectHash(cwd) = sha1(cwd).slice(0,12)`）。一旦这里把反斜杠、大小写、
 * 尾斜杠“整理”一遍，就会出现「插件认为同一个项目、记忆轨却是两套」的错位。
 * 宁可两个字符串不同就建两个会话，也不能悄悄改写用户的路径。
 *
 * 文件里现在有**三节**：
 *   - `zones`：cwd → 自动化会话（{ sessionId, createdAt?, title? }），key = cwd 原串
 *   - `throttle`：cwd → 主动开口判定器的记账（{ streak, lastSpokeAt }），key = cwd 原串
 *   - `tasks`：scheduleId → 定时任务闸门的登记 + 记账（{ enabled, streak, lastSpokeAt, note? }）
 * ⚠ 三节必须**各自**在 emptyState / normalizeState / serialize / 两个 upsert 里都出现。
 *   `serialize()` 是白名单重建，漏一节就等于「写一次就把那一节静默丢掉」——
 *   这是本文件最容易犯的错，所以 test/throttle.test.mjs 有一条专门盯它的断言。
 *
 * ⚠ `tasks` 的 key 是 **scheduleId**，不是 cwd，这是刻意的：
 *   `throttle` 的语义是「一个项目一条曲线」，而同一个自动化会话下可以挂十几条任务，
 *   按 cwd 记账会让它们共用一条曲线 —— 一条任务攒下的「连没中」加成会被另一条白拿。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeThrottleState } from "./throttle.js";

/** 日志统一前缀。激活期与运行期都带，方便在 host 日志里一眼定位。 */
export const LOG_PREFIX = "automation-zone:";

/** 状态文件格式版本。 */
export const STATE_VERSION = 1;

/**
 * 默认状态文件位置。
 *
 * 用 `.dsh-beta` 而不是 `.dsh`：本机 DSH Desktop 的真实家目录是 `~/.dsh-beta`，
 * `.dsh` 是迁移前的旧家目录（写进去对运行态无效）。
 * @returns {string} 绝对路径
 */
export function defaultStateFile() {
  return path.join(os.homedir(), ".dsh-beta", "automation-zone.json");
}

/**
 * 空状态。
 *
 * `throttle` / `tasks` 也在这里出现一次：它们默认是空表，但**必须存在**，
 * 否则 `serialize()` 的白名单会认为"这一节本来就没有"。
 * @returns {{version: number, zones: Record<string, object>, throttle: Record<string, object>, tasks: Record<string, object>}}
 */
export function emptyState() {
  return { version: STATE_VERSION, zones: {}, throttle: {}, tasks: {} };
}

/**
 * 归一化一条闸门任务记录。
 *
 * `enabled` 只有字面 `true` 才算开：手改成 `"true"` / `1` / `{}` 一类一律按**关**处理。
 * 理由与「配置解析失败要 fail-closed」同一条——闸门宁可关着（零行为变化），
 * 也不要被一份脏数据打开，因为它的效果是「替用户决定定时任务该不该产出」。
 * @param {unknown} raw
 * @returns {{enabled: boolean, streak: number, lastSpokeAt: number|null, note?: string}}
 */
export function normalizeTaskEntry(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const streak = Number.isSafeInteger(source.streak) && source.streak >= 0 ? source.streak : 0;
  const lastSpokeAt = Number.isFinite(source.lastSpokeAt) && source.lastSpokeAt > 0
    ? Number(source.lastSpokeAt)
    : null;
  const record = { enabled: source.enabled === true, streak, lastSpokeAt };
  if (typeof source.note === "string" && source.note.length > 0) record.note = source.note;
  return record;
}

/**
 * 把磁盘上那一节 `tasks` 洗成内存表（**key 是 scheduleId**）。
 * 判据与 throttle 相同：条目什么字段都没有也合法（= 刚登记、还没掷过骰子），只逐字段归一化。
 * @param {unknown} raw
 * @returns {Record<string, {enabled: boolean, streak: number, lastSpokeAt: number|null, note?: string}>}
 */
function normalizeTaskTable(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const table = {};
  for (const [scheduleId, entry] of Object.entries(raw)) {
    if (typeof scheduleId !== "string" || scheduleId.length === 0) continue;
    table[scheduleId] = normalizeTaskEntry(entry);
  }
  return table;
}

/**
 * 读一条闸门任务记录（没有就是 `undefined`，**不造默认值**）。
 *
 * 为什么不做成「没有就返回 enabled:false 的默认记录」：调用方靠「有没有这条记录」
 * 区分「没登记」（= 零行为变化）与「登记了但关着」（= 该告警），两者行为不同。
 * @param {unknown} state
 * @param {string} scheduleId
 * @returns {{enabled: boolean, streak: number, lastSpokeAt: number|null, note?: string}|undefined}
 */
export function taskEntryOf(state, scheduleId) {
  if (typeof scheduleId !== "string" || scheduleId.length === 0) return undefined;
  if (state === null || typeof state !== "object") return undefined;
  const table = /** @type {{tasks?: unknown}} */ (state).tasks;
  if (table === null || typeof table !== "object") return undefined;
  const entry = /** @type {Record<string, unknown>} */ (table)[scheduleId];
  if (entry === null || typeof entry !== "object") return undefined;
  return normalizeTaskEntry(entry);
}

/**
 * 统一的内部告警出口：没有 logger 时静默（纯函数测试里不会传 logger）。
 * @param {{warn?: Function}|undefined} log
 * @param {string} message
 */
function warn(log, message) {
  if (log !== undefined && log !== null && typeof log.warn === "function") {
    log.warn(`${LOG_PREFIX} ${message}`);
  }
}

/**
 * 把磁盘上那一节 `throttle` 洗成内存表。
 *
 * 判据与 zones 不同：zone 记录**没有 sessionId 就是垃圾**（留着会让 ensureZoneSession
 * 拿一串非字符串去 inspect），而 throttle 记录**什么字段都没有也合法**（等价于
 * "从没攒过加成、从没开过口"）。所以这里不丢条目，只逐字段归一化。
 * @param {unknown} raw
 * @returns {Record<string, {streak: number, lastSpokeAt: number|null}>}
 */
function normalizeThrottleTable(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const table = {};
  for (const [cwd, entry] of Object.entries(raw)) {
    // key 原样保留（同 zones：不做路径规范化）。
    table[cwd] = normalizeThrottleState(entry);
  }
  return table;
}

/**
 * 把磁盘上的 JSON 归一化成内存表。
 *
 * 只保留“能真的用”的条目：没有字符串 sessionId 的记录是垃圾，留着会让
 * ensureZoneSession 拿着一串非字符串去 inspect，报出难懂的错误。
 * @param {unknown} parsed
 * @param {{warn?: Function}|undefined} log
 * @param {string} file
 */
function normalizeState(parsed, log, file) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(log, `state file ${file} does not contain a JSON object; treating as empty`);
    return emptyState();
  }
  // throttle / tasks 先洗：它们**不依赖 zones 是否可用**。若先判 zones 再洗这两节，
  // 一份"zones 被手改坏、但 throttle 还完好"的文件会把记账整节丢掉。
  const throttle = normalizeThrottleTable(parsed.throttle);
  const tasks = normalizeTaskTable(parsed.tasks);
  const zonesRaw = parsed.zones;
  if (zonesRaw === null || typeof zonesRaw !== "object" || Array.isArray(zonesRaw)) {
    warn(log, `state file ${file} has no usable "zones" table; treating as empty`);
    return { ...emptyState(), throttle, tasks };
  }
  const zones = {};
  let dropped = 0;
  for (const [cwd, entry] of Object.entries(zonesRaw)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const sessionId = entry.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      dropped += 1;
      continue;
    }
    const record = { sessionId };
    if (typeof entry.createdAt === "string") record.createdAt = entry.createdAt;
    if (typeof entry.title === "string") record.title = entry.title;
    // key 原样保留：这条是硬约束，不做 normalize。
    zones[cwd] = record;
  }
  if (dropped > 0) {
    warn(log, `state file ${file} had ${dropped} unusable zone entr${dropped === 1 ? "y" : "ies"}; ignored`);
  }
  const version = Number.isSafeInteger(parsed.version) ? parsed.version : STATE_VERSION;
  return { version, zones, throttle, tasks };
}

/**
 * 把「JSON 解析失败」的位置附近那一小段原文摘出来，给错误文案用。
 *
 * 为什么需要：`JSON.parse` 的报错只有 `at position 137` 这种坐标，而状态文件里唯一的长字段
 * 是 cwd 路径——没有这段原文，用户不知道该修哪一处；把整份打出来既会灌满日志，也会把别的
 * 项目的路径刷满屏。所以只取坐标前后各 24 个字符，并把换行/制表压成空格。
 * 解析器不给坐标时（例如 `Unexpected end of JSON input` 这种截断），退回首 48 个字符。
 * @param {string} raw 文件原文
 * @param {string} message 解析器报错文案
 * @returns {string} 形如 `…"zones": { broken…` 的一小段
 */
function jsonErrorNeighborhood(raw, message) {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const matched = /position (\d+)/.exec(message);
  const at = matched === null ? 0 : Number(matched[1]);
  const start = Math.max(0, (Number.isFinite(at) ? at : 0) - 24);
  const slice = raw.slice(start, start + 48).replace(/[\r\n\t]+/g, " ");
  const lead = start > 0 ? "…" : "";
  const tail = start + 48 < raw.length ? "…" : "";
  return `${lead}${slice}${tail}`;
}

/**
 * 读状态文件。
 *
 * 任何损坏（读不了 / 不是 JSON / 结构不对）都退化成空表并记 warn，**不抛**：
 * 这个函数在工具热路径上，抛异常等于把“状态文件写坏”升级成“插件不可用”。
 * 空表也不是死路——ensureZoneSession 会重建并写回。
 *
 * 但「文件不存在」与「文件读不出来」不是同一件事，三种情形必须分开：
 *   - ENOENT：首次运行，空表就是事实，可以放心重建并写回（**不带** readError）。
 *   - EACCES / EBUSY / EISDIR / EIO …：盘上**可能有一整份别人的记录**，只是这次读不到。
 *     此时若照常写回，就会把其它项目的 zone 记录整表覆盖成只剩当前 cwd。
 *   - **JSON 解析失败（半截文件 / 手改坏）**：同样属于「盘上有一份还没被读出来的内容」。
 *     曾经这里按「有意重建」处理（退空表且不报错），后果是判定器照常写盘、把别的项目的
 *     zones + throttle 整表覆盖成只剩本 cwd 一条——**数据丢失**，且从返回值上看完全正常。
 *     所以现在按读失败处理：带 readError，由写盘方停手。
 * @param {string} file
 * @param {{warn?: Function}|undefined} log
 * @returns {{version: number, zones: Record<string, object>, throttle: Record<string, object>, readError?: string}}
 */
export function loadState(file, log) {
  const target = typeof file === "string" && file.length > 0 ? file : defaultStateFile();
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    // ENOENT 是首次运行的正常情况，不是告警。
    if (error === null || typeof error !== "object" || error.code !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error);
      // 文案要能定位：**路径 + 真实原因**。`error.message` 自己只有
      // "EISDIR: illegal operation on a directory, read" 这种、**不带路径**——
      // 用户拿着它不知道该去修哪个文件（契约 §3.1 要求 readError 必须含路径）。
      // 于是「读失败」与「解析失败」两档的 readError 用同一个文案骨架。
      const message = `cannot read state file ${target}: ${reason}`;
      warn(log, `${message}; treating as empty and NOT writing back`);
      // 显式标记：盘上内容未知 ≠ 空表。写盘方见到它必须停手。
      return { ...emptyState(), readError: message };
    }
    return emptyState();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const near = jsonErrorNeighborhood(raw, reason);
    warn(log, `cannot parse state file ${target}: ${reason}${near === "" ? "" : ` (near ${near})`}; treating as empty and NOT writing back`);
    // 文案要能定位：路径 + 真实原因 + 出错位置附近的一小段原文。
    return {
      ...emptyState(),
      readError: `cannot parse state file ${target}: ${reason}${near === "" ? "" : ` (near ${near})`}`,
    };
  }
  return normalizeState(parsed, log, target);
}

/**
 * 取出 `loadState` 打上的读失败标记。
 *
 * 单独成一个函数，是为了让「读到空表」与「没读到」这两件事在**写法上**就不一样：
 * 写盘方必须显式问一句“这次读到的是不是只是空表”，而不是假装 state 一定可信。
 * @param {unknown} state
 * @returns {string|undefined}
 */
export function stateReadError(state) {
  if (state === null || typeof state !== "object") return undefined;
  const marker = /** @type {{readError?: unknown}} */ (state).readError;
  return typeof marker === "string" && marker.length > 0 ? marker : undefined;
}

/**
 * 序列化：三节的 key 都排序，让文件 diff 稳定（并发写不同 cwd 时不会天天全量重排）。
 *
 * ⚠ 这是**白名单重建**，不是 `{...state}`：所以任何新加的一节都必须在这里显式出现。
 *   漏掉 `throttle` / `tasks` 的后果不是报错，而是「第一次写盘之后那一节静默消失」——
 *   记账永远归零，且从任何一行日志里都看不出来。
 * @param {{zones?: Record<string, object>, throttle?: Record<string, object>, tasks?: Record<string, object>}} state
 */
function serialize(state) {
  const source = state !== null && typeof state === "object" && state.zones !== null && typeof state.zones === "object"
    ? state.zones
    : {};
  const zones = {};
  for (const cwd of Object.keys(source).sort()) {
    const entry = source[cwd];
    if (entry === null || typeof entry !== "object") continue;
    const record = { sessionId: entry.sessionId };
    if (typeof entry.createdAt === "string") record.createdAt = entry.createdAt;
    if (typeof entry.title === "string") record.title = entry.title;
    zones[cwd] = record;
  }
  const throttleSource = state !== null && typeof state === "object"
    && state.throttle !== null && typeof state.throttle === "object"
    ? state.throttle
    : {};
  const throttle = {};
  for (const cwd of Object.keys(throttleSource).sort()) {
    // 只写两个字段（白名单），并逐字段归一化：手改坏的 streak / lastSpokeAt 不该被原样写回。
    const entry = normalizeThrottleState(throttleSource[cwd]);
    throttle[cwd] = { streak: entry.streak, lastSpokeAt: entry.lastSpokeAt };
  }
  const tasksSource = state !== null && typeof state === "object"
    && state.tasks !== null && typeof state.tasks === "object"
    ? state.tasks
    : {};
  const tasks = {};
  for (const scheduleId of Object.keys(tasksSource).sort()) {
    const entry = normalizeTaskEntry(tasksSource[scheduleId]);
    tasks[scheduleId] = typeof entry.note === "string"
      ? { enabled: entry.enabled, streak: entry.streak, lastSpokeAt: entry.lastSpokeAt, note: entry.note }
      : { enabled: entry.enabled, streak: entry.streak, lastSpokeAt: entry.lastSpokeAt };
  }
  return { version: STATE_VERSION, zones, throttle, tasks };
}

/**
 * 原子写：先写 `<file>.tmp`，再 rename 覆盖。
 *
 * 为什么必须原子：非原子写在“写到一半进程被杀”时会留下半个 JSON，下次启动
 * 就得靠解析容错兜（能兜住，但记录会全丢）。rename 在 Windows 上走
 * MoveFileEx(MOVEFILE_REPLACE_EXISTING)，是同盘原子的。
 * @param {string} file
 * @param {{zones?: Record<string, object>, throttle?: Record<string, object>}} state
 */
export function saveState(file, state) {
  const target = typeof file === "string" && file.length > 0 ? file : defaultStateFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  const payload = `${JSON.stringify(serialize(state), null, 2)}\n`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, target);
}

/**
 * 纯函数：把一条 cwd 记录合进 `zones`，返回新对象（不改入参）。
 *
 * ⚠ 返回值必须**带上原样的 throttle / tasks 两节**：它是整份 state 的重建，
 *   漏了就是「建一次会话把开口记账清零」。
 * @param {{zones?: Record<string, object>, throttle?: Record<string, object>, tasks?: Record<string, object>}} state
 * @param {string} cwd 原样字符串，语义上就是 map key
 * @param {{sessionId: string, createdAt?: string, title?: string}} entry
 * @returns {{version: number, zones: Record<string, object>, throttle: Record<string, object>, tasks: Record<string, object>}}
 */
export function upsertZone(state, cwd, entry) {
  const base = state !== null && typeof state === "object" && state.zones !== null && typeof state.zones === "object"
    ? state.zones
    : {};
  const throttle = state !== null && typeof state === "object"
    && state.throttle !== null && typeof state.throttle === "object"
    ? state.throttle
    : {};
  const tasks = state !== null && typeof state === "object"
    && state.tasks !== null && typeof state.tasks === "object"
    ? state.tasks
    : {};
  return {
    version: STATE_VERSION,
    zones: { ...base, [cwd]: { ...entry } },
    throttle: { ...throttle },
    tasks: { ...tasks },
  };
}

/**
 * 纯函数：把一条 cwd 的判定记账合进 `throttle` 节，返回新对象（不改入参）。
 *
 * 与 `upsertZone` 对称：每节各有一个 upsert，工具层就不用自己拼 state 形状
 * （拼错的形态是"写回时丢了另一节"，那不是业务逻辑，不该由调用方负责）。
 * @param {{zones?: Record<string, object>, throttle?: Record<string, object>, tasks?: Record<string, object>}} state
 * @param {string} cwd 原样字符串，语义上就是 map key
 * @param {{streak?: number, lastSpokeAt?: number|null}} entry
 * @returns {{version: number, zones: Record<string, object>, throttle: Record<string, object>, tasks: Record<string, object>}}
 */
export function upsertThrottle(state, cwd, entry) {
  const zones = state !== null && typeof state === "object"
    && state.zones !== null && typeof state.zones === "object"
    ? state.zones
    : {};
  const base = state !== null && typeof state === "object"
    && state.throttle !== null && typeof state.throttle === "object"
    ? state.throttle
    : {};
  const tasks = state !== null && typeof state === "object"
    && state.tasks !== null && typeof state.tasks === "object"
    ? state.tasks
    : {};
  const record = normalizeThrottleState({ ...base[cwd], ...entry });
  return {
    version: STATE_VERSION,
    zones: { ...zones },
    throttle: { ...base, [cwd]: record },
    tasks: { ...tasks },
  };
}

/**
 * 纯函数：登记 / 取消登记一条闸门任务，或更新它的记账（返回新对象，不改入参）。
 *
 * `entry === null` = **删掉这条登记**（取消登记）。删除是彻底移除 key，
 * 而不是写一条 `enabled:false`：两者语义不同——「没登记」= 零行为变化、不该告警；
 * 「登记了但关着」= 该在日志里说一句，否则用户会以为闸门在管事。
 * @param {{zones?: Record<string, object>, throttle?: Record<string, object>, tasks?: Record<string, object>}} state
 * @param {string} scheduleId
 * @param {{enabled?: boolean, streak?: number, lastSpokeAt?: number|null, note?: string}|null} entry
 * @returns {{version: number, zones: Record<string, object>, throttle: Record<string, object>, tasks: Record<string, object>}}
 */
export function upsertTask(state, scheduleId, entry) {
  const zones = state !== null && typeof state === "object"
    && state.zones !== null && typeof state.zones === "object"
    ? state.zones
    : {};
  const throttle = state !== null && typeof state === "object"
    && state.throttle !== null && typeof state.throttle === "object"
    ? state.throttle
    : {};
  const base = state !== null && typeof state === "object"
    && state.tasks !== null && typeof state.tasks === "object"
    ? state.tasks
    : {};
  const tasks = { ...base };
  if (entry === null) delete tasks[scheduleId];
  else tasks[scheduleId] = normalizeTaskEntry({ ...base[scheduleId], ...entry });
  return { version: STATE_VERSION, zones: { ...zones }, throttle: { ...throttle }, tasks };
}
