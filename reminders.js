/**
 * 合并版提醒进程：一个进程同时负责
 *   1. 新待办提醒（列表里新出现的 item）
 *   2. 截止提醒（距 DDL 24h / 8h / 1h）
 *
 * 取代原来的 ddl-reminder.js + new-todo-reminder.js。原来两个脚本各自
 * spawn 一次 todolist.js、各自做一次 CAS 登录、各自拉一遍 /api/todos，
 * 现在合成一次。
 *
 * 用法：
 *   node reminders.js           # 跑一轮就退出（给 systemd timer 用）
 *   node reminders.js --loop    # 常驻，按 REMINDER_INTERVAL_SECONDS 轮询
 */

import { pathToFileURL } from "url";

import "dotenv/config";

import { dingTalkMarkdown } from "./shared/dingtalk-webhook.js";
import { loadState, saveState, resolveProjectPath } from "./shared/state-store.js";
import { fetchTodos, makeTodoKey } from "./shared/todo-source.js";

const STATE_FILE = resolveProjectPath(".reminder-state.json");
const LEGACY_DDL_STATE = resolveProjectPath(".ddl-reminder-state.json");

// 提醒节点，从宽到紧
const THRESHOLDS_HOURS = [24, 8, 1];

const INTERVAL_SECONDS = Number(process.env.REMINDER_INTERVAL_SECONDS || 600);
const LOOP = process.argv.includes("--loop");

const TZ = "Asia/Shanghai";

function formatDdl(date) {
  if (!date) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatRemain(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours >= 24) {
    return `${Math.floor(hours / 24)}天${hours % 24}小时`;
  }
  return `${hours}小时${minutes}分钟`;
}

function makeDdlKey(todo, threshold) {
  // 格式与旧版 ddl-reminder.js 完全一致，这样迁移过来的 state 能直接复用
  const base = todo.url || `${todo.course}-${todo.title}`;
  return `${threshold}h::${base}::${todo.endTimeIso}`;
}

// ---------------------------------------------------------------- state

function loadReminderState() {
  const existing = loadState(STATE_FILE, null);
  if (existing && typeof existing === "object") return existing;

  // 首次运行：把旧脚本的 state 迁移过来，避免重复轰炸一遍已有待办
  const state = { version: 2, initialized: false, ddlSent: {}, todos: {} };

  const legacyDdl = loadState(LEGACY_DDL_STATE, null);
  if (legacyDdl && typeof legacyDdl === "object") {
    state.ddlSent = legacyDdl;
    console.log(`[migrate] 从 .ddl-reminder-state.json 导入 ${Object.keys(legacyDdl).length} 条 DDL 记录`);
  }

  const legacyTodo = loadState(resolveProjectPath(".new-todo-state.json"), null);
  if (legacyTodo && typeof legacyTodo === "object") {
    state.todos = legacyTodo.todos || {};
    state.initialized = Boolean(legacyTodo.initialized);
    console.log(`[migrate] 从 .new-todo-state.json 导入 ${Object.keys(state.todos).length} 条待办基线`);
  }

  return state;
}

// 已发送记录会随待办一起无限增长，清掉 DDL 过去一周以上的条目
function pruneSentMap(sentMap, now) {
  const cutoff = now - 7 * 24 * 3600 * 1000;
  let removed = 0;

  for (const [key, value] of Object.entries(sentMap)) {
    const ddl = Date.parse(value?.ddl ?? "");
    if (Number.isFinite(ddl) && ddl < cutoff) {
      delete sentMap[key];
      removed += 1;
    }
  }

  return removed;
}

// ---------------------------------------------------------------- 计算

function collectNewTodos(todos, state) {
  if (!state.initialized) return [];

  const known = state.todos || {};
  return todos.filter((todo) => !known[makeTodoKey(todo)]);
}

function collectDdlReminders(todos, sentMap, now) {
  const reminders = [];

  for (const todo of todos) {
    if (!todo.endTime) continue;

    const remainMs = todo.endTime.getTime() - now;
    if (remainMs <= 0) continue;

    // 已经越过哪些节点（剩余时间 <= 阈值），从紧到松
    const due = THRESHOLDS_HOURS.filter((h) => remainMs <= h * 3600 * 1000).sort(
      (a, b) => a - b
    );
    if (due.length === 0) continue;

    // 只发最紧的那个；更宽松的节点早就过期了，一并标记掉，避免补发一堆陈年提醒
    const urgent = due[0];
    const keys = due.map((h) => makeDdlKey(todo, h));

    if (sentMap[keys[0]]) continue;

    reminders.push({ todo, threshold: urgent, remainMs, keys });
  }

  return reminders;
}

function buildMessage(newTodos, ddlReminders) {
  const parts = [];

  if (newTodos.length > 0) {
    parts.push(`### 🆕 新待办（${newTodos.length}）`);
    for (const todo of newTodos) {
      parts.push("");
      parts.push(`- **${todo.title}**`);
      parts.push(`  课程：${todo.course}`);
      parts.push(`  截止：${formatDdl(todo.endTime)}`);
      parts.push(`  [去处理](${todo.url})`);
    }
  }

  if (ddlReminders.length > 0) {
    if (parts.length > 0) parts.push("", "---", "");
    parts.push("### ⏰ 即将截止");

    for (const threshold of THRESHOLDS_HOURS) {
      const group = ddlReminders.filter((r) => r.threshold === threshold);
      if (group.length === 0) continue;

      parts.push("");
      parts.push(`**距离截止约 ${threshold} 小时**`);

      for (const { todo, remainMs } of group) {
        parts.push("");
        parts.push(`- **${todo.title}**`);
        parts.push(`  课程：${todo.course}`);
        parts.push(`  截止：${formatDdl(todo.endTime)}`);
        parts.push(`  剩余：${formatRemain(remainMs)}`);
        parts.push(`  [去提交](${todo.url})`);
      }
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------- 主流程

async function runOnce() {
  const now = Date.now();
  const state = loadReminderState();

  // 拉取失败会抛异常 → 不落任何 state，下一轮重试
  const todos = await fetchTodos();
  console.log(`[${new Date(now).toISOString()}] 拉到 ${todos.length} 条待办`);

  const newTodos = collectNewTodos(todos, state);
  const ddlReminders = collectDdlReminders(todos, state.ddlSent || {}, now);

  // 基线是"我见过什么"而不是"我发了什么"，所以无论钉钉发没发都要更新。
  // 否则钉钉停用期间攒下的待办会在恢复后一次性全被当成"新待办"刷屏。
  const seen = {};
  const nowIso = new Date(now).toISOString();
  for (const todo of todos) {
    const key = makeTodoKey(todo);
    seen[key] = {
      title: todo.title,
      course: todo.course,
      ddlIso: todo.endTimeIso,
      url: todo.url,
      lastSeenAt: nowIso,
      firstSeenAt: state.todos?.[key]?.firstSeenAt || nowIso,
    };
  }
  state.todos = seen;
  state.initialized = true;
  state.updatedAt = nowIso;

  const pruned = pruneSentMap(state.ddlSent || (state.ddlSent = {}), now);
  if (pruned > 0) console.log(`[prune] 清理 ${pruned} 条过期发送记录`);

  if (newTodos.length === 0 && ddlReminders.length === 0) {
    console.log("没有需要提醒的条目");
    saveState(STATE_FILE, state);
    return;
  }

  const message = buildMessage(newTodos, ddlReminders);

  try {
    const result = await dingTalkMarkdown(message, "ZJU 待办提醒");

    if (!result.sent) {
      console.log(`钉钉未启用（${result.reason}），本轮不标记已发送。消息内容：`);
      console.log(message);
      return;
    }

    for (const { todo, threshold, keys } of ddlReminders) {
      for (const key of keys) {
        state.ddlSent[key] = {
          sentAt: new Date().toISOString(),
          threshold,
          title: todo.title,
          course: todo.course,
          ddl: todo.endTimeIso,
        };
      }
    }

    console.log(`已发送：${newTodos.length} 条新待办，${ddlReminders.length} 条截止提醒`);
  } finally {
    // dingTalkMarkdown 抛异常时走到这里：基线和 prune 结果照常落盘，
    // 但上面那段 ddlSent 赋值根本没执行——于是下一轮会把同样的提醒重新算出来再发。
    // 旧版是无条件落 state，一次网络抖动就能让提醒永久消失。
    saveState(STATE_FILE, state);
  }
}

async function main() {
  if (!LOOP) {
    await runOnce();
    return;
  }

  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      // 常驻模式下单轮失败不该拖垮进程
      console.error(`[loop] 本轮失败：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
  }
}

// 直接 `node reminders.js` 才执行；被 import 时只暴露下面的纯函数供测试
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export {
  buildMessage,
  collectDdlReminders,
  collectNewTodos,
  formatRemain,
  main,
  makeDdlKey,
  pruneSentMap,
};
