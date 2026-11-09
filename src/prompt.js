/**
 * 系统提示注入文本与插值中和辅助。
 *
 * 为什么走 `systemPrompt.section({ interpolate: false })` 而不是 `context()`：
 * 这段文字是静态的，`section` + `interpolate:false` 是框架级免插值（renderPrompt
 * 里 `section.interpolate === false ? section.text : interpolate(...)`），
 * 比“每轮自己算、自己中和”更彻底；`context` 还会被拼进运行时上下文快照并
 * 作为 user 消息进入 messages，让模型读到自己的提示块（自我引用放大）。
 */

/** 注入的 section 名（同层同名会抛，必须全局唯一）。 */
export const INJECT_SECTION_NAME = "automation-zone:task-routing";

/**
 * 注入的 section 排序位。
 *
 * 2950 = 落在工具类说明的尾部（TOOL_REPORT 2900 之后、TOOL_COMPUTER_USE 3000 之前），
 * 与“这个工具的用法常驻说明”这一语义相称。
 */
export const INJECT_SECTION_ORDER = 2950;

/**
 * 注入正文（契约 §3.5 原文，逐字不动）。
 *
 * 注意：正文刻意不含 `{{...}}`。这段文字唯一的“风险”是将来有人往里加变量引用，
 * 所以下面仍然过一遍 neutralizeBraces —— 见那个函数。
 */
export const INJECT_RULE_TEXT = `### 自动化任务（定时任务）

创建周期性/定时任务的**唯一正确入口是 \`automation_task_create\` 工具**，不要用 \`schedule_create\`。

原因：\`schedule_create\` 会把任务绑到当前会话上，导致该会话被判定为「有活动」而无法归档，
并且任务会和真人对话历史混在一起。\`automation_task_create\` 会自动定位/创建本项目的
「⚙ 自动化任务」专用会话，把任务建在那里——工作会话因此可以随时归档。

例外：用户明确要求「就在这个会话里提醒我」时才用 \`schedule_create\`。`;

/**
 * 把连续的 `{` 拆开，防止 systemPrompt 插值抛错。
 *
 * 插值扫描器只认 `{{name}}` 组（`GROUP_AT = /^\{\{([^{}]*)\}\}/`）：一旦拼出完整组，
 * 名字非法 / 未注册 / 值为 undefined 三种情况都会 **throw**，而这个 throw 发生在
 * 每轮 prompt 组装期、调用方无从 catch —— 后果是整个会话废掉，不是降级。
 *
 * 中和办法：`{{` → `{ {`。拆开之后扫描器再也找不到 `{` 起点，整段原样返回；
 * 用可见空格而不是零宽字符，是因为零宽字符在日志、复制、再检索时查不出来。
 *
 * 本插件的 section 已经 `interpolate:false`（框架级豁免），这层是第二道保险：
 * 万一将来有人把这段文字挪进 `context()`。
 * @param {string} text
 * @returns {string}
 */
export function neutralizeBraces(text) {
  return String(text).replace(/\{\{+/g, (match) => match.split("").join(" "));
}

/**
 * 渲染最终注入文本（中和后）。
 * @param {string} [text]
 * @returns {string}
 */
export function renderInjectRule(text = INJECT_RULE_TEXT) {
  return neutralizeBraces(text);
}
