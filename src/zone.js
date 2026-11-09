/**
 * 「确保某个 cwd 有一个自动化会话」的唯一实现。
 *
 * 依赖注入式：`inspect` / `create` 由调用方给（生产里是 sessionController 的两个方法，
 * 测试里是假函数）。这样这段最需要边界验证的逻辑（复用判据、并发去重、状态写回）
 * 不需要真起 DSH 就能跑。
 *
 * 为什么不去“按标题找会话”：标题由 LLM 生成、用户还能改，靠它反查等于把正确性
 * 押在一段不受控的自然语言上。sidecar 记录是唯一真源。
 */

import {
  LOG_PREFIX,
  loadState as defaultLoadState,
  saveState as defaultSaveState,
  stateReadError,
  upsertZone,
} from "./storage.js";

/** 状态记录里写的标题（只作为人类可读标记，不用于反查会话）。 */
export const ZONE_SESSION_TITLE = "⚙ 自动化任务";

/**
 * @typedef {object} EnsureOptions
 * @property {(sessionId: string) => Promise<{meta?: {cwd?: string}}>} inspect
 * @property {(request: {cwd: string}) => Promise<{sessionId: string}>} create
 * @property {(sessionId: string) => boolean|Promise<boolean>} [isArchived] 会话是否已被归档
 * @property {(sessionId: string) => Promise<{rotate: boolean, reason?: string, bytes?: number}|object>|object} [shouldRotate] 会话是否该换掉（体积判据由调用方给）
 * @property {(info: {cwd: string, fromSessionId: string, toSessionId: string, title: string}) => Promise<object>} [migrate] 把旧会话上的任务搬到新会话（轮换 / 归档两条路径）
 * @property {(info: {cwd: string, fromSessionId: string, toSessionId: string}) => Promise<object>} [onSessionReplaced] 记录里那条会话「已不可用」、被迫新建时，把旧会话上的任务搬走
 * @property {() => {zones: Record<string, object>, readError?: string}} [loadState]
 * @property {(state: object) => void} [saveState]
 * @property {string} [title]
 * @property {{warn?: Function, info?: Function}|undefined} [log]
 * @property {() => string} [now]
 */

/**
 * @param {EnsureOptions} options
 * @returns {{ensure: (cwd: string) => Promise<{sessionId: string, created: boolean, title: string, warning?: string, rotated?: boolean, rotation?: object}>, inflightCount: () => number}}
 */
export function createEnsureZoneSession(options) {
  const settings = options !== null && typeof options === "object" ? options : {};
  const inspect = settings.inspect;
  const create = settings.create;
  if (typeof inspect !== "function" || typeof create !== "function") {
    throw new TypeError("createEnsureZoneSession: inspect 与 create 必须是函数");
  }
  const loadState = typeof settings.loadState === "function" ? settings.loadState : defaultLoadState;
  const saveState = typeof settings.saveState === "function" ? settings.saveState : defaultSaveState;
  const isArchived = typeof settings.isArchived === "function" ? settings.isArchived : undefined;
  const shouldRotate = typeof settings.shouldRotate === "function" ? settings.shouldRotate : undefined;
  const migrate = typeof settings.migrate === "function" ? settings.migrate : undefined;
  const onSessionReplaced = typeof settings.onSessionReplaced === "function" ? settings.onSessionReplaced : undefined;
  const title = typeof settings.title === "string" && settings.title.length > 0 ? settings.title : ZONE_SESSION_TITLE;
  const log = settings.log;
  const now = typeof settings.now === "function" ? settings.now : () => new Date().toISOString();

  function logWarn(message) {
    if (log !== undefined && log !== null && typeof log.warn === "function") log.warn(`${LOG_PREFIX} ${message}`);
  }

  /**
   * 问一句“这个会话是不是已被归档”。
   *
   * 可选依赖：没注入就一律当未归档（纯单测里不需要造归档态）。注入时出错也当未归档——
   * 归档态是**附加**判据，查不出来就退回原来那条 cwd 判据，不能因为一次读失败就把
   * 一个本来正常的自动化会话丢掉重建（那会让每次调用都多出一个会话）。
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function archivedNow(sessionId) {
    if (isArchived === undefined) return false;
    try {
      return (await isArchived(sessionId)) === true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`无法确认会话 ${sessionId} 的归档状态（${message}），按未归档处理`);
      return false;
    }
  }

  /**
   * 问一句“这个会话是不是该换掉了”（体积阈值由调用方注入，本文件不认识字节）。
   *
   * 与 `archivedNow` 同一条 fail-open 理由：轮换判据查不出来时**宁可复用旧会话**——
   * 一条度量读不到就让自动化会话凭空重建，会把用户全部任务跟着搬一次，
   * 代价远大于「这次没换成」。
   * @param {string} sessionId
   * @returns {Promise<{rotate: boolean, reason?: string, bytes?: number}>}
   */
  async function rotationNow(sessionId) {
    if (shouldRotate === undefined) return { rotate: false };
    let verdict;
    try {
      verdict = await shouldRotate(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`无法判定会话 ${sessionId} 是否需要轮换（${message}），按不轮换处理`);
      return { rotate: false };
    }
    if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
      logWarn(`轮换判据返回了非对象（${JSON.stringify(verdict)}），按不轮换处理`);
      return { rotate: false };
    }
    return verdict;
  }

  /** 同一 cwd 的在途 Promise：并发调用共享同一次创建（A9 的落点）。 */
  const inflight = new Map();  /**
   * 状态写盘串行化。
   *
   * 不只是同一个 cwd 要去重：**不同 cwd 的两次写也要串行**，否则后写的一方
   * 会拿着自己那份旧快照把别人刚写进去的 zone 覆盖掉。所以临界区里重新读盘。
   */
  let writeChain = Promise.resolve();
  function withStateLock(work) {
    const run = writeChain.then(work, work);
    // 链本身不带毒：一次失败不能让后续写全部跟着挂。
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 把一条记录写回状态文件。
   *
   * 写盘失败不阻断任务创建：会话此时已经真实存在，把它当成“创建失败”丢掉只会
   * 让下一次调用再建一个会话。但这件事必须显式留痕（warn 日志 + 返回值 warning），
   * 不能悄悄吞掉——否则状态文件永远是坏的，而所有人都以为正常。
   *
   * **读失败时绝不写盘**：临界区里重新读到的是“空表 + readError”，那不代表文件里
   * 没有记录，只代表这次读不出来。照着它写回等于把其它项目的 zone 记录整表删掉。
   * @returns {Promise<string|undefined>} 失败原因（undefined = 写成功）
   */
  async function persist(cwd, record) {
    try {
      const skipped = await withStateLock(() => {
        // 重新读：临界区外可能已经有别的 cwd 写过了。
        const fresh = loadState();
        const readError = stateReadError(fresh);
        // 读不到 ≠ 空表。宁可这条记录没记住（下次会再建一个可见会话），
        // 也不能拿一份不可信的“空表”去覆盖别人。
        if (readError !== undefined) return readError;
        saveState(upsertZone(fresh, cwd, record));
        return undefined;
      });
      if (skipped !== undefined) {
        logWarn(`状态文件读取失败，已放弃写入（避免覆盖其它项目的记录）：${skipped}`);
        return `状态文件读取失败，未写入以避免覆盖其它项目记录：${skipped}`;
      }
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`无法写入状态文件（会话已创建但没记住）：${message}`);
      return message;
    }
  }

  /**
   * 建一个新会话并返回它的 id。
   *
   * 契约要求：不传 sessionId（让系统生成，避免与既有会话身份冲突），
   * 也不传 agentPreset（走部署默认预设）。
   * @param {string} cwd
   * @returns {Promise<string>}
   */
  async function spawnSession(cwd) {
    const created = await create({ cwd });
    const sessionId = created !== null && typeof created === "object" ? created.sessionId : undefined;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(`sessionController.create() 没有返回 sessionId（cwd=${JSON.stringify(cwd)}）`);
    }
    return sessionId;
  }

  /**
   * 轮换：把旧会话换成一个新的，并把绑在旧会话上的任务搬过去。
   *
   * 为什么迁移是顺手做的，而不是「给个提示让用户自己处理」：留在那条路径上的任务正是
   * 本插件要消灭的静默失效——会话涨大之后 compaction 压不动，任务照样投递、回合跑不出
   * 结果、连 agent.failed 都没有。只换会话不搬任务，等于把用户的任务留在原地继续哑火。
   *
   * 迁移失败**不改变「必须换」这个结论**：新会话是健康的，而留在超大会话里等于必然再炸
   * 一次。所以照切新会话，只把原因放进返回值 `warning` 并逐条留 warn。
   *
   * 旧会话**不归档、不删除**：它可能还装着用户想翻的历史，归档/删除是用户的动作。
   * @param {string} cwd
   * @param {string} fromSessionId
   * @param {string} reason
   * @param {number|undefined} bytes
   */
  async function rotate(cwd, fromSessionId, reason, bytes) {
    const toSessionId = await spawnSession(cwd);
    const warnings = [];
    let migrated = 0;
    let failed = [];
    let gateRemapped = 0;

    if (migrate !== undefined) {
      try {
        const outcome = await migrate({ cwd, fromSessionId, toSessionId, title });
        if (outcome !== null && typeof outcome === "object") {
          migrated = Array.isArray(outcome.migrated) ? outcome.migrated.length : 0;
          failed = Array.isArray(outcome.failed) ? outcome.failed : [];
          gateRemapped = Number.isSafeInteger(outcome.gateRemapped) ? outcome.gateRemapped : 0;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`把任务从 ${fromSessionId} 迁到 ${toSessionId} 失败（${message}）：任务仍留在旧会话上，需要人工迁移`);
        warnings.push(`任务迁移失败：${message}`);
      }
    }

    const persistWarning = await persist(cwd, { sessionId: toSessionId, createdAt: now(), title });
    if (persistWarning !== undefined) warnings.push(persistWarning);

    if (log !== undefined && log !== null && typeof log.info === "function") {
      log.info(
        `${LOG_PREFIX} 轮换自动化会话 ${fromSessionId} → ${toSessionId}（${reason}${bytes === undefined ? "" : `，旧会话 ${bytes} 字节`}）`
          + `，已迁移 ${migrated} 条任务${gateRemapped > 0 ? `、闸门登记改键 ${gateRemapped} 条` : ""}`
          + `；旧会话未归档未删除，任务已迁走，可自行归档`,
      );
    }

    const rotation = { from: fromSessionId, to: toSessionId, reason, migrated, failed, gateRemapped };
    if (bytes !== undefined) rotation.bytes = bytes;
    return {
      sessionId: toSessionId,
      created: true,
      title,
      rotated: true,
      rotation,
      ...(warnings.length > 0 ? { warning: warnings.join("；") } : {}),
    };
  }

  /**
   * 记录里那条会话**已经不可用**（corrupt / 被删）时，把钉在它上面的任务搬到刚建的新会话。
   *
   * 为什么必须做：只 warn + 新建的话，旧会话 id 上的 active 任务就成了孤儿——到点往一个
   * 物化失败的会话投递，投递成功、回合跑不出结果、连 agent.failed 都没有。那正是本插件
   * 要消灭的静默失效，而换会话时顺手搬走正是唯一能根治它的时机。
   *
   * 为什么 fail-open：新会话此时已经真实存在，迁移失败不该把「确保会话」判成失败
   * （那会让下一次调用再建一个）。只把原因放进返回值 `warning` 并留一行 warn。
   * @param {string} cwd
   * @param {string} fromSessionId 记录里那条不可用的会话
   * @param {string} toSessionId 刚建好的新会话
   * @returns {Promise<string|undefined>} 失败原因（undefined = 没问题 / 没注入回调）
   */
  async function migrateUnavailable(cwd, fromSessionId, toSessionId) {
    if (onSessionReplaced === undefined) return undefined;
    try {
      await onSessionReplaced({ cwd, fromSessionId, toSessionId });
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`把任务从不可用的会话 ${fromSessionId} 迁到 ${toSessionId} 失败（${message}）：任务仍留在旧会话上，需要人工迁移`);
      return `任务迁移失败：${message}`;
    }
  }

  /** 真正干活的那条路径：查记录 → 验活 → 复用 / 轮换 / 新建。 */
  async function resolve(cwd) {
    const state = loadState();
    const record = state.zones !== null && typeof state.zones === "object" ? state.zones[cwd] : undefined;
    /**
     * 只在「记录的会话不可用」这条路径上填。cwd 不符那条不填是刻意的：
     * 那里旧会话属于**别的项目**，把它的任务搬进本项目等于串轨（见下面那条 warn）。
     */
    let unavailableSessionId;

    if (record !== undefined && record !== null && typeof record.sessionId === "string") {
      try {
        const observed = await inspect(record.sessionId);
        const observedCwd = observed !== null && typeof observed === "object" && observed.meta !== null && typeof observed.meta === "object"
          ? observed.meta.cwd
          : undefined;
        if (observedCwd === cwd) {
          // 复用判据一：**已归档的会话不能复用**。
          // 归档本身就是本插件存在的理由（工作会话要能归档）；记录指着一个已经藏起来的
          // 会话时，复用它等于让用户的定时任务静默落在看不见的会话里 —— 用户以为归档
          // 之后一切正常，实际任务还在往那个会话里灌。这种“静默失效”比多建一个会话糟得多。
          // 顺手把任务迁到新会话：归档过的会话里的任务本来就不会再被用户看见，迁走才是修复。
          if (await archivedNow(record.sessionId)) {
            logWarn(`记录的自动化会话 ${record.sessionId} 已被归档，将新建一个可见的并迁移任务`);
            return await rotate(cwd, record.sessionId, "会话已被归档", undefined);
          }
          // 复用判据二：**体积**。会话涨到压不动之后，任务投递成功但回合跑不出结果，
          // 而且一行错误都没有——所以超过阈值必须换档，不能靠“看起来还活着”判断。
          const verdict = await rotationNow(record.sessionId);
          if (verdict.rotate === true) {
            const bytes = Number.isFinite(verdict.bytes) ? Number(verdict.bytes) : undefined;
            const reason = typeof verdict.reason === "string" && verdict.reason.length > 0 ? verdict.reason : "命中轮换判据";
            return await rotate(cwd, record.sessionId, reason, bytes);
          }
          return {
            sessionId: record.sessionId,
            created: false,
            title: typeof record.title === "string" ? record.title : title,
          };
        }
        // 会话在，cwd 却不是这个项目：绝对不能复用（复用等于把任务建到别的项目的
        // 记忆轨上），只能记一条 warn 后重建。这里也**不迁移**：没有可信的旧会话。
        logWarn(
          `记录的自动化会话 ${record.sessionId} 的 cwd 已不符（记录 ${JSON.stringify(cwd)}，实际 ${JSON.stringify(observedCwd)}），将新建一个`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`记录的自动化会话 ${record.sessionId} 不可用（${message}），将新建一个并迁移任务`);
        unavailableSessionId = record.sessionId;
      }
    }

    const sessionId = await spawnSession(cwd);
    const nextRecord = { sessionId, createdAt: now(), title };
    const warnings = [];
    const persistWarning = await persist(cwd, nextRecord);
    if (persistWarning !== undefined) warnings.push(persistWarning);
    // 迁移放在写盘之后：先把「新会话是谁」记下来，再搬任务。搬的时候要是抛了，记录也已经
    // 指向新会话，下次调用不会再建一个。
    if (unavailableSessionId !== undefined) {
      const migrateWarning = await migrateUnavailable(cwd, unavailableSessionId, sessionId);
      if (migrateWarning !== undefined) warnings.push(migrateWarning);
    }
    if (log !== undefined && log !== null && typeof log.info === "function") {
      log.info(`${LOG_PREFIX} 为 ${cwd} 新建自动化会话 ${sessionId}`);
    }
    return { sessionId, created: true, title, ...(warnings.length > 0 ? { warning: warnings.join("；") } : {}) };
  }

  /**
   * 确保 cwd 有一个可用的自动化会话（幂等）。
   * @param {string} cwd 原样字符串（不做 normalize，见 storage.js 顶部）
   * @returns {Promise<{sessionId: string, created: boolean, title: string, warning?: string}>}
   */
  function ensure(cwd) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      return Promise.reject(new TypeError("ensureZoneSession: cwd 必须是非空字符串"));
    }
    const existing = inflight.get(cwd);
    if (existing !== undefined) return existing;
    const promise = resolve(cwd).finally(() => {
      // 只清理自己那一条：期间若被别的调用换掉，不能误删。
      if (inflight.get(cwd) === promise) inflight.delete(cwd);
    });
    inflight.set(cwd, promise);
    return promise;
  }

  return { ensure, inflightCount: () => inflight.size };
}
