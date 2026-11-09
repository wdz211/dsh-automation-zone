/**
 * 掷骰节流曲线（「主动开口判定器」的纯函数内核）。
 *
 * 机制来源：上游插件 `dsh-speak-up` 的 `lib_host.js`（58807 字节那份，中文标识符）。
 * 本文件只把它的**判定内核**搬过来——峰谷判档、命中线公式、时机因子、安静时段、
 * 掷骰口径，一行数学都不改；但**不搬那个插件本身**（不装它、不碰它的配置与日志）。
 *
 * 三条为什么：
 *  1. **纯函数、零依赖**。随机数由调用方注入（`roll`），"现在"也从外面传进来，
 *     所以整段最容易算错的逻辑可以脱机单测；半夜跑测试不会因为正好是谷时/峰时而红。
 *  2. **只判定、不触发**。DSH 的 schedule 由内核到点触发，插件拦不住「这一轮该不该真跑」，
 *     所以节流只能做成「真开口之前先问一次门」。本模块只回答 speak / hold / blocked，
 *     真开口由调用方自己做。
 *  3. **默认关闭**（`enabled: false`）。装上它不应该让任何既有任务行为发生变化。
 */

/**
 * 峰时窗口（当天第几分钟，含起不含止）。
 *
 * 上游把时段**写死**、不给设置项（"这个不用用户单独设置"），只让用户调两格命中线。
 * 所以这里也是常量，不做成配置——一旦可配，"为什么今天特别安静"会多出一个变量。
 */
export const PEAK_WINDOWS = [
  [9 * 60, 12 * 60], // 09:00 ~ 12:00（周一至周五）
  [14 * 60, 18 * 60], // 14:00 ~ 18:00（周一至周五）
];

/**
 * 全部默认值（唯一一份真源；`normalizeConfig` 与测试都从这一份取）。
 *
 * 每一格后面标明它对应 speak-up 默认配置里的哪一项，方便以后回上游对口径。
 * ⚠ 只有 `enabled` 是本插件新增的：上游没有"判定器"这个概念（它自己就是触发器）。
 */
export const THROTTLE_DEFAULTS = {
  enabled: false, // 本插件新增：默认关（装上不改变任何既有行为）
  peakLine: 20, // speak-up「峰时命中线」20：峰时（贵）→ 命中线低、少开口
  valleyLine: 60, // speak-up「谷时命中线」60：谷时（便宜）→ 命中线高、多开口
  missBonus: 10, // speak-up「没中加成」10：每没掷中一次，下一次命中线加这么多
  bonusCap: 40, // speak-up「加成上限」40：加成最多攒到这么多
  quietFrom: 1, // speak-up「安静起」1（小时，含起不含止；起 === 止 表示不启用）
  quietTo: 8, // speak-up「安静止」8
  nearThresholdMinutes: 20, // speak-up「近阈值分钟」20：距上次说话 < 它 → 乘近因子
  nearFactor: 0.15, // speak-up「近因子」0.15
  farThresholdMinutes: 360, // speak-up「远阈值分钟」360：距上次说话 > 它 → 乘远因子
  farFactor: 1.5, // speak-up「远因子」1.5
  cooldownMinutes: 20, // speak-up「搭话冷却分钟」20：自己开口之后的冷却（0 = 不冷却）
  intervalMinutes: 30, // speak-up「间隔分钟」30 —— ⚠ 本插件不自带定时器，这一格只作记账/给调用方参考
  dryRun: true, // speak-up「试运行」true —— ⚠ 判定器不负责开口，这一格**不参与判定**，只作记录
};

/** 判定结果的三个取值。`blocked` = 硬闸拦下（没掷骰子），`hold` = 掷了没中，`speak` = 掷中。 */
export const GATE_DECISIONS = ["speak", "hold", "blocked"];

/**
 * 机器可读的判定原因。
 * - `disabled` / `quiet-hours` / `cooldown` 是三种硬闸（都**不动**连没中计数器）
 * - `hit` / `miss` 是掷骰结果
 */
export const GATE_CODES = ["disabled", "quiet-hours", "cooldown", "hit", "miss"];

/**
 * 上游的 `布()`：只认真正是布尔的真值，取不到就用兜底。
 * 为什么不能直接 `Boolean(value)`：`''` / `0` / `'false'` 都会被当成 true，
 * 于是"关掉"的配置看起来是开着的。
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolOf(value, fallback) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

/** 上游的 `数()`：不是数字就用兜底，是数字就夹到区间里。 */
function numberIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 乐观取数：拿不到就返回兜底（本文件内部只用于纯函数入参消毒）。 */
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 夹到区间里。
 *
 * ⚠ 为什么导出（本文件唯一一个"为了能测"而导出的内部件）：`computeLine` 的四个入参在到达
 *   这一行之前已经被逐个 `Math.max(0, …)` 夹过，所以「线值的下界」在任何合法入参下都取不到
 *   负数——把这里的 `Math.max(min, …)` 删成 `Math.min(max, …)` 之后，`line` 照样是同一个值，
 *   属于等价变异，从任何 `line` 断言上都看不出来。而在 `decide` 里同一把 clamp 还负责消毒
 *   注入的掷值（`roll: -0.5` 必须变成 0），那才是下界在运行时的唯一可观测出口。
 *   导出之后单测可以直接钉住上/下界，改坏这一行必红。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 现在是峰时（贵）还是谷时（便宜）。
 *
 * ⚠ 先判周末再算分钟（顺序别写反）：周六周日**全天谷时**，不参与两个窗口的判断。
 * ⚠ 边界：09:00 算峰、12:00 算谷、14:00 算峰、18:00 算谷（含起不含止）。
 * ⚠ 用的是**这台机器本地时区**（getDay/getHours 都是本地时间），与上游一致。
 * @param {Date|number} [now] 时刻；不传就是现在
 * @returns {boolean} true = 峰时
 */
export function isPeak(now = new Date()) {
  const date = now instanceof Date ? now : new Date(Number(now));
  const day = date.getDay(); // 0 = 周日，6 = 周六
  if (day === 0 || day === 6) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  return PEAK_WINDOWS.some(([from, to]) => minute >= from && minute < to);
}

/** 峰时/谷时的短称呼（记账与等式共用一份，别在两处各写一遍）。 */
export function tierOf(now = new Date()) {
  return isPeak(now) ? "peak" : "valley";
}

/**
 * 是不是在安静时段里。
 *
 * ⚠ 起 > 止 必须能跨午夜（23 点 ~ 7 点），所以不能只写 `hour >= from && hour < to`。
 * ⚠ 起 === 止 一律当成「不启用安静时段」（否则 0 ~ 0 会变成全天静音，很难查）。
 * @param {number} hour 0~23
 * @param {number} from 起（含）
 * @param {number} to 止（不含）
 * @returns {boolean}
 */
export function isQuietHour(hour, from, to) {
  const h = finiteOr(hour, -1);
  const a = finiteOr(from, -1);
  const b = finiteOr(to, -1);
  if (h < 0 || a < 0 || b < 0) return false;
  if (a === b) return false;
  if (a < b) return h >= a && h < b;
  return h >= a || h < b;
}

/**
 * 时机因子三档。
 *
 * ⚠ 拿不到「距上次说话」时因子按 **1**（不是按近因子）——不知道就按中性算，
 *   既不能因为读不到历史就狂开口，也不能就彻底闭嘴。
 * ⚠ 边界是**严格不等**：正好等于近阈值不算"近"，正好等于远阈值不算"远"（与上游一致）。
 * @param {number|undefined} minutes 距上次说话多少分钟；undefined = 不知道
 * @param {object} [cfg] 归一化后的配置（缺项按 THROTTLE_DEFAULTS 兜底）
 * @returns {number}
 */
export function timingFactor(minutes, cfg) {
  const settings = isPlainObject(cfg) ? cfg : {};
  const nearMinutes = finiteOr(settings.nearThresholdMinutes, THROTTLE_DEFAULTS.nearThresholdMinutes);
  const nearFactor = finiteOr(settings.nearFactor, THROTTLE_DEFAULTS.nearFactor);
  const farMinutes = finiteOr(settings.farThresholdMinutes, THROTTLE_DEFAULTS.farThresholdMinutes);
  const farFactor = finiteOr(settings.farFactor, THROTTLE_DEFAULTS.farFactor);
  const value = Number.isFinite(minutes) ? Number(minutes) : undefined;
  if (value === undefined) return 1;
  if (value < nearMinutes) return nearFactor;
  if (value > farMinutes) return farFactor;
  return 1;
}

/**
 * 算这一次的命中线：`base × factor + min(加成上限, 连没中 × 没中加成)`，最后夹 0~100。
 *
 * ⚠⚠ 顺序是**先乘因子、再加攒下来的加成**（上游特意要求的口径，别写反）：
 *     60 × 0.15 + 10 = 19，而反过来的 (60 + 10) × 0.15 = 10.5 —— 差一倍。
 * ⚠ 加成是"攒"出来的：每没掷中一次 +missBonus，加到 bonusCap 就停。
 * @param {{base?: number, factor?: number, streak?: number, missBonus?: number, bonusCap?: number}} input
 * @returns {{bonus: number, line: number}}
 */
export function computeLine(input) {
  const options = isPlainObject(input) ? input : {};
  const base = Math.max(0, finiteOr(options.base, 0));
  const factor = Math.max(0, finiteOr(options.factor, 1));
  const streak = Math.max(0, finiteOr(options.streak, 0));
  const missBonus = Math.max(0, finiteOr(options.missBonus, THROTTLE_DEFAULTS.missBonus));
  const bonusCap = Math.max(0, finiteOr(options.bonusCap, THROTTLE_DEFAULTS.bonusCap));
  const bonus = Math.min(bonusCap, streak * missBonus);
  const line = clamp(base * factor + bonus, 0, 100);
  return { bonus, line };
}

/** 一位小数；非数字给 `0.0`（渲染层不许出现 NaN/undefined）。 */
function fixed1(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(1);
}

/** 基数的显示形态：整数的 `60` 与带小数的原样保留，都不用补零（上游等式里是 `谷时命中线 60` 那种写法）。 */
function plainNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(n);
}

/** 因子的显示形态：整数补一位小数（1 → `1.0`），小数原样（0.15 / 1.5）。 */
function factorText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "1.0";
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * 「命中线」那句话（人话等式）。
 *
 * 口径沿用上游：**先说最终答案（命中线是多少），再说怎么来的**——
 * 用户曾把「峰时命中线 20%」误读成"在骰子点数上再加 20%"，所以必须写成
 * `命中线 62.0 = 谷时 60 × 因子 1.0 + 加成 10.0；距上次说话 41.0 分钟`
 * 这种一看就知道"这个数怎么算出来的"的等式。
 * @param {{line?: number, tier?: string, base?: number, factor?: number, minutes?: number, bonus?: number}} input
 * @returns {string}
 */
export function lineEquation(input) {
  const options = isPlainObject(input) ? input : {};
  const tierText = options.tier === "peak" ? "峰时" : "谷时";
  const factor = factorText(options.factor);
  const bonus = finiteOr(options.bonus, 0);
  const head = `命中线 ${fixed1(options.line)} = ${tierText} ${plainNumber(options.base)} × 因子 ${factor}`;
  const bonusPart = bonus > 0 ? ` + 加成 ${fixed1(bonus)}` : "";
  const tail = Number.isFinite(options.minutes)
    ? `距上次说话 ${fixed1(options.minutes)} 分钟`
    : "距上次说话时间不明";
  return `${head}${bonusPart}；${tail}`;
}

/**
 * 逐字段类型校验 + 夹区间（照上游归一化口径：非数字用兜底、数字夹上下限）。
 *
 * 为什么必须有一层归一化：配置可能来自 YAML（字符串 `"60"`）、被手改坏（`null`）、
 * 或者压根没写。判定器是这个插件唯一会"凭数字下结论"的地方，脏数据必须在这里挡住，
 * 不能让它一路飘到 `Math.min(NaN, ...)`。
 * @param {unknown} raw
 * @returns {typeof THROTTLE_DEFAULTS}
 */
export function normalizeThrottle(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const D = THROTTLE_DEFAULTS;
  return {
    enabled: boolOf(source.enabled, D.enabled),
    peakLine: numberIn(source.peakLine, D.peakLine, 0, 100),
    valleyLine: numberIn(source.valleyLine, D.valleyLine, 0, 100),
    missBonus: numberIn(source.missBonus, D.missBonus, 0, 100),
    bonusCap: numberIn(source.bonusCap, D.bonusCap, 0, 100),
    quietFrom: Math.round(numberIn(source.quietFrom, D.quietFrom, 0, 23)),
    quietTo: Math.round(numberIn(source.quietTo, D.quietTo, 0, 23)),
    nearThresholdMinutes: numberIn(source.nearThresholdMinutes, D.nearThresholdMinutes, 0, 100000),
    nearFactor: numberIn(source.nearFactor, D.nearFactor, 0, 100),
    farThresholdMinutes: numberIn(source.farThresholdMinutes, D.farThresholdMinutes, 0, 100000),
    farFactor: numberIn(source.farFactor, D.farFactor, 0, 100),
    cooldownMinutes: Math.round(numberIn(source.cooldownMinutes, D.cooldownMinutes, 0, 1440)),
    intervalMinutes: Math.round(numberIn(source.intervalMinutes, D.intervalMinutes, 1, 1440)),
    dryRun: boolOf(source.dryRun, D.dryRun),
  };
}

/**
 * 连没中计数器的归一化：**非负安全整数**，其余一律回到 0。
 *
 * 为什么不用 `Math.max(0, Number(x))`：`NaN` 会让后面整条等式变成 `NaN`，
 * 而 `1.5` 次没中在语义上不存在——这类值只可能来自手改文件，直接当没攒过更安全。
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeStreak(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * 时间戳的归一化：毫秒整数或 `null`。
 *
 * `null` 与 `0` 语义不同：`null` = 从没记过（冷却不生效），`0` 若是真值会让
 * `Date.now() - 0` 变成"几十分钟前"那种荒谬结论。所以 0 也当没记过。
 * @param {unknown} raw
 * @returns {number|null}
 */
export function normalizeTimestamp(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * 状态节的归一化（状态文件里 `throttle[cwd] = { streak, lastSpokeAt }`）。
 * @param {unknown} raw
 * @returns {{streak: number, lastSpokeAt: number|null}}
 */
export function normalizeThrottleState(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    streak: normalizeStreak(source.streak),
    lastSpokeAt: normalizeTimestamp(source.lastSpokeAt),
  };
}

/**
 * 判定之后连没中计数器变成多少（唯一真源，别在工具层再写一遍）。
 * - `hold`（没掷中）→ +1
 * - `speak`（掷中）→ 清零，回到一开始
 * - `blocked`（硬闸）→ **不动**（没掷骰子，凭什么记账）
 * @param {string} decision
 * @param {unknown} streak
 * @returns {number}
 */
export function nextStreak(decision, streak) {
  const current = normalizeStreak(streak);
  if (decision === "hold") return current + 1;
  if (decision === "speak") return 0;
  return current;
}

/** `now` 的三种形态（Date / 毫秒 / 不传）统一成毫秒。 */
function toMillis(now) {
  if (now instanceof Date) {
    const t = now.getTime();
    return Number.isFinite(t) ? t : Date.now();
  }
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Date.now();
}

/**
 * 一次判定的全部答案。
 *
 * 硬闸顺序沿用上游的自动那一轮：**总开关 → 安静时段 → 冷却 → 掷骰**。
 * 顺序不能换：反过来会出现"在安静时段里仍然把连没中 +1"这种账，
 * 而那正是上游刻意避开的（三种 blocked 都不动计数器）。
 *
 * ⚠ `roll` 是 **0~1 的原始随机数**（上游 `Math.random()` 的原样），比较时乘 100 得到
 *   「掷值」。投这个参数是为了测试能钉死结果；缺省才用 `Math.random()`。
 * ⚠ `blocked` 时 `roll` 是 `null`（根本没掷），`reason` 会说清被哪道闸拦下。
 * @param {{
 *   cfg?: object,
 *   now?: Date|number,
 *   streak?: number,
 *   lastSpokeAt?: number|null,
 *   minutesSinceLastUserMessage?: number,
 *   roll?: number,
 * }} input
 * @returns {{decision: string, code: string, line: number, roll: number|null,
 *   bonus: number, factor: number, base: number, tier: string, nextLine: number, reason: string}}
 */
export function decide(input) {
  const options = isPlainObject(input) ? input : {};
  const cfg = normalizeThrottle(options.cfg);
  const nowMs = toMillis(options.now);
  const nowDate = new Date(nowMs);
  const streak = normalizeStreak(options.streak);
  const lastSpokeAt = normalizeTimestamp(options.lastSpokeAt);
  const minutes = Number.isFinite(options.minutesSinceLastUserMessage)
    ? Number(options.minutesSinceLastUserMessage)
    : undefined;

  // 判档与算线都用同一个时刻：免得压在边界上时"说的是一档、算的是另一档"。
  const tier = tierOf(nowDate);
  const base = tier === "peak" ? cfg.peakLine : cfg.valleyLine;
  const factor = timingFactor(minutes, cfg);
  const { bonus, line } = computeLine({
    base,
    factor,
    streak,
    missBonus: cfg.missBonus,
    bonusCap: cfg.bonusCap,
  });
  // 「如果这次没中，下一次的命中线会变成多少」——仅供展示，用同一套公式喂 streak+1。
  const { line: nextLine } = computeLine({
    base,
    factor,
    streak: streak + 1,
    missBonus: cfg.missBonus,
    bonusCap: cfg.bonusCap,
  });
  const common = { line, bonus, factor, base, tier, nextLine };
  const equation = lineEquation({ line, tier, base, factor, minutes, bonus });

  // ---- 硬闸 1：总开关。判定器默认是关的，关着就什么都不做（包括不动连没中）----
  if (cfg.enabled !== true) {
    return {
      decision: "blocked",
      code: "disabled",
      roll: null,
      ...common,
      reason: "判定器是关着的（throttle.enabled=false），这一轮不掷骰子",
    };
  }

  // ---- 硬闸 2：安静时段 ----
  const hour = nowDate.getHours();
  if (isQuietHour(hour, cfg.quietFrom, cfg.quietTo)) {
    return {
      decision: "blocked",
      code: "quiet-hours",
      roll: null,
      ...common,
      reason: `现在 ${hour} 点在安静时段（${cfg.quietFrom}~${cfg.quietTo}）里，这轮不掷`,
    };
  }

  // ---- 硬闸 3：自己刚开过口的冷却（0 = 不冷却）----
  if (lastSpokeAt !== null && cfg.cooldownMinutes > 0) {
    const elapsed = (nowMs - lastSpokeAt) / 60000;
    if (elapsed < cfg.cooldownMinutes) {
      return {
        decision: "blocked",
        code: "cooldown",
        roll: null,
        ...common,
        reason: `自己刚开过口（${fixed1(elapsed)} 分钟前，冷却 ${cfg.cooldownMinutes} 分钟），这轮不重复`,
      };
    }
  }

  // ---- 到这里才掷骰子 ----
  const rawRoll = Number.isFinite(options.roll) ? clamp(Number(options.roll), 0, 1) : Math.random();
  const point = rawRoll * 100;
  if (point >= line) {
    // 没掷中：攒一次加成。下次的线用同一个函数算（免得两处写法漂移）。
    const nextText = cfg.missBonus === 0
      ? `下次命中线还是 ${fixed1(nextLine)}（没中加成关着）`
      : `下次命中线变 ${fixed1(nextLine)}（没中加成 +${cfg.missBonus}）`;
    return {
      decision: "hold",
      code: "miss",
      roll: rawRoll,
      ...common,
      reason: `没掷中 ✗ 掷出 ${fixed1(point)}（命中线 ${fixed1(line)} —— 要掷到 ${fixed1(line)} 以下才开口）｜${equation}｜${nextText}`,
    };
  }
  const wasStreak = streak;
  const cleared = wasStreak > 0
    ? `没中加成清零（之前连着 ${wasStreak} 次没中）`
    : "没中加成本来就是 0（还没攒过）";
  return {
    decision: "speak",
    code: "hit",
    roll: rawRoll,
    ...common,
    reason: `掷中 ✓ 掷出 ${fixed1(point)}（命中线 ${fixed1(line)} —— 掷到 ${fixed1(line)} 以下就开口）｜${equation}｜${cleared}`,
  };
}
