/**
 * 会话轮换 + 定时任务自动迁移。
 *
 * 为什么需要这一层：`zone.js` 的复用判据只有「会话在 + cwd 相符 + 未归档」，没有任何体积上限。
 * 自动化专用会话因此被无限复用，涨到十几 MB / 近百轮之后 compaction 压不动了——定时任务照样
 * 投递，回合却跑不出结果，而且**连一行错误都没有**（没有 `agent.failed`，只能靠外部现象推断）。
 * 「什么时候该换一个会话」必须变成显式判据；而换会话就必须把绑在旧会话上的任务搬过去，
 * 否则任务留在旧会话里，等于把这台机器上最难查的那种静默失效留在原地。
 *
 * 迁移为什么是 delete + create，不是改绑：dsh-schedule **没有改绑 sessionId 的 API**。
 * 它的 `update()` 只接受 record，`sessionId` 是**查询键**
 * （`@deepseek-ai/dsh-schedule/lib/index.js:2198`）。所以只能：catalog 取 record →
 * 重建 selector → 在新会话上 create → 再 delete 旧的。
 *
 * 这个文件是纯 DI 的：schedule / loadState / saveState / log / now 全部由调用方注入，
 * 所以整条迁移链路可以脱离 DSH 单测（测试里注入临时目录 + mock schedule）。
 */

import { LOG_PREFIX, stateReadError } from "./storage.js";

/**
 * 把一条 schedule record 重建回 create() 需要的 selector（六个里恰好一个）。
 *
 * 为什么要「重建」而不是照搬：record 与 create 的入参形状不同（`timeZone` vs `time_zone`、
 * `everySeconds` vs `every_seconds`），而且 `at` 是**绝对时刻**——照搬过去多半已经过期。
 * 一次性任务按「距原定时刻还剩几秒」转成 `after_seconds`：任务在新会话上仍在同一时刻触发。
 *
 * **已过期的一次性任务一律拒迁（overdue_oneshot），绝不夹成「1 秒后立刻触发」**：
 * 这条 record 在 delete 之前可能已经被 schedule drive 投递过一次——夹成 1 秒等于把同一件事
 * 在新会话上再外发一遍（对「发消息 / 调外部接口」这类任务就是重复打扰用户）。
 * 迁移能保证的是「别丢、别重」；一条已经错过的任务该不该补发是人的判断，不是迁移的。
 * 所以这里只把「已过期」这个事实如实返回，由 migrator 走既有的 failed 分支记下来。
 *
 * 任何不认识 / 缺字段 / 类型不对的情况都返回 `{ok:false}`，**不抛**：单条任务的形状
 * 问题不该炸掉整批迁移，由调用方逐条记 failed。
 * @param {unknown} record schedule record
 * @param {number} [nowMs] 判「还剩几秒」用的当前时刻（可注入，测试才能稳定）
 * @returns {{ok: true, selector: object} | {ok: false, code: string, reason: string}}
 */
export function selectorFromRecord(record, nowMs = Date.now()) {
  const bad = (reason) => ({ ok: false, code: "unsupported_record", reason });
  if (record === null || typeof record !== "object") return bad("record 不是对象");
  const source = /** @type {Record<string, unknown>} */ (record);

  const needString = (field) => {
    const value = source[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  switch (source.kind) {
    case "daily": {
      const time = needString("time");
      const timeZone = needString("timeZone");
      if (time === undefined) return bad("daily 记录缺少 time");
      if (timeZone === undefined) return bad("daily 记录缺少 timeZone");
      return { ok: true, selector: { daily: { time, time_zone: timeZone } } };
    }
    case "weekly": {
      const time = needString("time");
      const timeZone = needString("timeZone");
      const weekdays = source.weekdays;
      if (time === undefined) return bad("weekly 记录缺少 time");
      if (timeZone === undefined) return bad("weekly 记录缺少 timeZone");
      // weekdays 必须是正整数数组：空数组/脏数组会让 create 直接 invalid，并静默丢一天
      if (!Array.isArray(weekdays) || weekdays.length === 0 || !weekdays.every((d) => Number.isInteger(d))) {
        return bad("weekly 记录的 weekdays 不是整数数组");
      }
      return { ok: true, selector: { weekly: { time, time_zone: timeZone, weekdays: [...weekdays] } } };
    }
    case "cron": {
      const expression = needString("expression");
      const timeZone = needString("timeZone");
      if (expression === undefined) return bad("cron 记录缺少 expression");
      if (timeZone === undefined) return bad("cron 记录缺少 timeZone");
      return { ok: true, selector: { cron: { expression, time_zone: timeZone } } };
    }
    case "every": {
      const seconds = source.everySeconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
        return bad("every 记录的 everySeconds 不是正数");
      }
      return { ok: true, selector: { every_seconds: seconds } };
    }
    case "at":
    case "after": {
      const scheduledAt = source.scheduledAt;
      const target = typeof scheduledAt === "string" ? Date.parse(scheduledAt) : Number.NaN;
      if (!Number.isFinite(target)) return bad(`${String(source.kind)} 记录的 scheduledAt 无法解析`);
      const remaining = Math.ceil((target - nowMs) / 1000);
      if (remaining <= 0) {
        // 已过期：迁过去就只能夹成 1 秒立刻触发，而旧任务在 delete 前可能已经投递过。
        // 宁可让它留在旧会话上等人工判断要不要补发，也不制造一次重复外发。
        return {
          ok: false,
          code: "overdue_oneshot",
          reason: `${String(source.kind)} 任务原定时刻 ${String(scheduledAt)} 已过期，迁移会在新会话上立刻补发一次（旧任务可能已投递过），需要人工决定是否重建`,
        };
      }
      return { ok: true, selector: { after_seconds: remaining } };
    }
    default:
      return bad(`不认识的 kind ${JSON.stringify(source.kind)}`);
  }
}

/**
 * 造一个「把绑在旧会话上的 active 任务整体迁到新会话」的迁移器。
 *
 * @param {object} deps
 * @param {{catalog: Function, create: Function, delete: Function}} deps.schedule
 * @param {() => object} deps.loadState 同步读状态（与 zone.js 同一套注入）
 * @param {(state: object) => void} deps.saveState 同步写状态
 * @param {{warn?: Function, info?: Function}} [deps.log]
 * @param {() => number} [deps.now]
 * @returns {{migrate: (info: {fromSessionId: string, toSessionId: string, cwd: string}) => Promise<object>}}
 */
export function createTaskMigrator(deps) {
  const settings = deps !== null && typeof deps === "object" ? deps : {};
  const schedule = settings.schedule;
  if (schedule === null || typeof schedule !== "object") {
    throw new TypeError("createTaskMigrator: schedule 必须是对象");
  }
  const loadState = typeof settings.loadState === "function" ? settings.loadState : () => ({ zones: {}, tasks: {} });
  const saveState = typeof settings.saveState === "function" ? settings.saveState : undefined;
  const log = settings.log;
  const nowMs = typeof settings.now === "function" ? settings.now : Date.now;

  const warn = (message) => {
    if (log !== undefined && log !== null && typeof log.warn === "function") log.warn(`${LOG_PREFIX} ${message}`);
  };
  const info = (message) => {
    if (log !== undefined && log !== null && typeof log.info === "function") log.info(`${LOG_PREFIX} ${message}`);
  };

  /**
   * 把闸门登记从旧 scheduleId 改到新 scheduleId（整批只写一次盘）。
   *
   * 为什么不改键就等于「闸门悄悄失效」：`state.tasks` 的 key 是 scheduleId，任务重建后
   * 新 id 在表里没有登记 —— 于是那条任务从「登记了、按掷骰节流」退回「没登记、零行为变化」，
   * 而这两者在日志里长得几乎一样。所以只要真迁过一条，就必须同步改键。
   *
   * 读不出状态时**放弃写盘**（契约 §3.1 的 fail-closed）：此时 `tasks` 只是「没读出来」的
   * 空表，照着它写回会把其它项目的 zones + throttle 整表删掉。
   * @param {Array<{from: string, to: string}>} mapping
   * @returns {number}
   */
  function remapGateEntries(mapping) {
    if (mapping.length === 0) return 0;
    const state = loadState();
    const readError = stateReadError(state);
    if (readError !== undefined) {
      warn(`状态文件读不出来（${readError}），闸门登记未改键：新任务需要重新登记才会被闸门管到`);
      return 0;
    }
    const tasks = state !== null && typeof state === "object" && state.tasks !== null && typeof state.tasks === "object"
      ? state.tasks
      : {};
    const next = { ...tasks };
    let remapped = 0;
    for (const pair of mapping) {
      if (!Object.prototype.hasOwnProperty.call(next, pair.from)) continue;
      // 整条记录原样搬过去：enabled / streak / lastSpokeAt / note 都是「这条任务的历史」，
      // 重置它们等于让用户已经攒下的节流曲线凭空归零。
      next[pair.to] = next[pair.from];
      delete next[pair.from];
      remapped += 1;
    }
    if (remapped === 0) return 0;
    if (saveState === undefined) {
      warn(`没有可用的 saveState，闸门登记未改键（${remapped} 条新任务需要重新登记）`);
      return 0;
    }
    try {
      saveState({ ...state, tasks: next });
    } catch (error) {
      warn(`闸门登记改键写盘失败（${error instanceof Error ? error.message : String(error)}）：新任务需要重新登记`);
      return 0;
    }
    return remapped;
  }

  /**
   * 迁一批任务。**任何单条失败都只进 failed，绝不中断其余任务、绝不抛**：
   * 迁移是轮换的顺手动作，它失败不该让「换掉那个跑不动的会话」这件事一起失败。
   * @param {{fromSessionId: string, toSessionId: string, cwd?: string}} request
   * @returns {Promise<{ok: boolean, migrated: Array<{from: string, to: string, title: string}>, failed: Array<{id: string, title: string, code: string, message: string}>, gateRemapped: number}>}
   */
  async function migrate(request) {
    const args = request !== null && typeof request === "object" ? request : {};
    const fromSessionId = args.fromSessionId;
    const toSessionId = args.toSessionId;
    const result = { ok: true, migrated: [], failed: [], gateRemapped: 0 };

    let catalog = [];
    try {
      catalog = await schedule.catalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`枚举定时任务失败（${message}）：绑在 ${fromSessionId} 上的任务没能迁移，需要人工处理`);
      result.ok = false;
      result.failed.push({ id: "", title: "(catalog)", code: "catalog_failed", message });
      return result;
    }

    const targets = (Array.isArray(catalog) ? catalog : []).filter(
      (record) => record !== null && typeof record === "object" && record.status === "active" && record.sessionId === fromSessionId,
    );
    if (targets.length === 0) {
      // 没有任务也是成功：轮换照样要做，只是没什么可搬的。
      info(`旧会话 ${fromSessionId} 上没有 active 定时任务，无需迁移`);
      return result;
    }

    const mapping = [];
    for (const record of targets) {
      const title = typeof record.title === "string" ? record.title : "";
      const picked = selectorFromRecord(record, nowMs());
      if (picked.ok !== true) {
        warn(`定时任务 ${record.id}（${title}）无法重建触发方式（${picked.reason}）：留在旧会话 ${fromSessionId} 上，需要人工重建`);
        result.failed.push({ id: String(record.id), title, code: picked.code, message: picked.reason });
        continue;
      }

      // **先建后删**：建失败 = 任务没迁走但一条都没丢（旧任务还在原地照常触发）；
      // 反过来先删后建，中途一炸就是任务彻底消失。
      let created;
      try {
        created = await schedule.create(toSessionId, { title: record.title, prompt: record.prompt, ...picked.selector });
      } catch (error) {
        const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "create_failed";
        const message = error instanceof Error ? error.message : String(error);
        warn(`把定时任务 ${record.id}（${title}）建到新会话 ${toSessionId} 失败（${code}）：旧任务仍在 ${fromSessionId} 上，未迁移`);
        result.failed.push({ id: String(record.id), title, code, message });
        continue;
      }

      const newId = created !== null && typeof created === "object" ? created.id : undefined;
      let deleted;
      try {
        deleted = await schedule.delete({ sessionId: fromSessionId, id: record.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 新任务已建、旧的删不掉 = 同一件事会在两个会话上各触发一次。这不能静默：
        // 用户会看到「任务重复执行」，而日志里必须能查到是哪两条 id。
        warn(`定时任务 ${title} 已建到新会话（${String(newId)}），但删除旧任务 ${record.id} 失败（${message}）：新旧两条会同时投递，需要人工删掉旧那条`);
        result.failed.push({ id: String(record.id), title, code: "delete_failed", message });
        continue;
      }
      if (deleted !== null && typeof deleted === "object" && deleted.deleted === false) {
        const code = typeof deleted.code === "string" ? deleted.code : "delete_failed";
        warn(`定时任务 ${title} 已建到新会话（${String(newId)}），但旧任务 ${record.id} 未被删除（${code}）：新旧两条会同时投递，需要人工删掉旧那条`);
        result.failed.push({ id: String(record.id), title, code, message: `旧任务未被删除（${code}）` });
        continue;
      }

      info(`定时任务 ${title}：${record.id}@${fromSessionId} → ${String(newId)}@${toSessionId}`);
      result.migrated.push({ from: String(record.id), to: String(newId), title });
      mapping.push({ from: String(record.id), to: String(newId) });
    }

    result.gateRemapped = remapGateEntries(mapping);
    if (result.failed.length > 0) result.ok = false;
    return result;
  }

  return { migrate };
}
