/**
 * selector 校验与归一化（纯函数，无 IO）。
 *
 * 为什么要在插件侧先校验一遍：`schedule.create` 对“两个 selector”“零个 selector”
 * 都会抛 `invalid_selector`，但抛出来的是异常；工具的返回值契约是
 * `{ ok:false, code:'invalid_selector' }`。先在这里判掉，模型看到的是干净的
 * 结构化结果，而不是一段异常文本。
 */

/** 六个 selector 参数名，顺序与契约一致。 */
export const SELECTOR_KEYS = Object.freeze([
  "at",
  "after_seconds",
  "every_seconds",
  "daily",
  "weekly",
  "cron",
]);

/** selector 参数名 → schedule 记录里的 kind（报错与状态展示都用它）。 */
export const SELECTOR_KIND = Object.freeze({
  at: "at",
  after_seconds: "after",
  every_seconds: "every",
  daily: "daily",
  weekly: "weekly",
  cron: "cron",
});

/** 每种定时对象的合法字段；多余字段一律丢掉（不把模型的手滑传给 schedule）。 */
const SELECTOR_FIELDS = Object.freeze({
  daily: ["time", "time_zone"],
  weekly: ["time", "time_zone", "weekdays"],
  cron: ["expression", "time_zone"],
});

/**
 * 值是否“被调用方给了”。null 与 undefined 都算没给：模型经常把可选参数写成 null。
 * @param {unknown} value
 */
function isPresent(value) {
  return value !== undefined && value !== null;
}

/**
 * 列出本次调用实际提供了哪些 selector（保持固定顺序，便于稳定报错）。
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
export function presentSelectors(args) {
  const source = args !== null && typeof args === "object" ? args : {};
  return SELECTOR_KEYS.filter((key) => isPresent(source[key]));
}

/**
 * 归一化单个 selector 的值。
 * @param {string} key
 * @param {unknown} value
 */
function normalizeValue(key, value) {
  const fields = SELECTOR_FIELDS[key];
  if (fields === undefined) {
    // at / after_seconds / every_seconds：字符串或整数，交给 schedule 做业务校验。
    return value;
  }
  // 定时对象只透传已声明字段，避免 `{...daily, foo: 1}` 这类脏键一路传到存储层。
  const source = value !== null && typeof value === "object" ? value : {};
  const picked = {};
  for (const field of fields) {
    if (isPresent(source[field])) picked[field] = source[field];
  }
  return picked;
}

/**
 * 取出“恰好一个”selector。
 * @param {Record<string, unknown>} args
 * @returns {{ok: true, selector: Record<string, unknown>, kind: string}
 *   | {ok: false, code: 'invalid_selector', message: string, provided: string[]}}
 */
export function pickSelector(args) {
  const provided = presentSelectors(args);
  if (provided.length === 1) {
    const key = provided[0];
    return {
      ok: true,
      selector: { [key]: normalizeValue(key, args[key]) },
      kind: SELECTOR_KIND[key],
    };
  }
  if (provided.length === 0) {
    return {
      ok: false,
      code: "invalid_selector",
      message: `必须且只能给一个定时方式，可选：${SELECTOR_KEYS.join(" / ")}（本次一个都没给）`,
      provided,
    };
  }
  return {
    ok: false,
    code: "invalid_selector",
    message: `必须且只能给一个定时方式，本次给了 ${provided.join(" / ")}；请只保留一个`,
    provided,
  };
}

/**
 * 从一个 selector 对象反推 kind（状态工具与日志展示用）。
 * @param {Record<string, unknown>} selector
 * @returns {string|undefined}
 */
export function selectorKind(selector) {
  if (selector === null || typeof selector !== "object") return undefined;
  for (const key of SELECTOR_KEYS) {
    if (isPresent(selector[key])) return SELECTOR_KIND[key];
  }
  return undefined;
}
