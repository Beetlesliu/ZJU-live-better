import crypto from "crypto";
import fs from "fs";
import { spawn } from "child_process";
import "dotenv/config";

const PROJECT_DIR = "/opt/ZJU-live-better";
const TODO_SCRIPT = "courses.zju/todolist.js";

const STATE_FILE = "/opt/ZJU-live-better/.ddl-reminder-state.json";

// 提醒节点：24小时、8小时、1小时
const THRESHOLDS_HOURS = [24, 8, 1];

// 检查窗口：比如每10分钟跑一次，这里设20分钟，避免 cron 延迟漏发
const WINDOW_MINUTES = Number(process.env.DDL_REMINDER_WINDOW_MINUTES || 20);

// 钉钉配置
const DINGTALK_WEBHOOK = process.env.DINGTALK_WEBHOOK || "";
const DINGTALK_SECRET = process.env.DINGTALK_SECRET || "";
const ENABLE_DINGTALK = process.env.ENABLE_DINGTALK === "true";

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function runTodolist() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [TODO_SCRIPT], {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        TZ: process.env.TZ || "Asia/Shanghai",
      },
    });

    let output = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`todolist exited with code ${code}`));
      } else {
        resolve(output);
      }
    });
  });
}

// 解析这种格式：
//   - 第十四周作业 @ 微积分（甲）Ⅱ
//     Remains 10 hours (DDL 6/8/2026, 11:59:00 PM)
//     Go to https://... to submit it.
function parseTodos(output) {
  const lines = output.split("\n");
  const todos = [];

  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const titleMatch = line.match(/^- (.+?) @ (.+)$/);
    if (titleMatch) {
      current = {
        title: titleMatch[1].trim(),
        course: titleMatch[2].trim(),
        ddlRaw: "",
        url: "",
      };
      todos.push(current);
      continue;
    }

    if (!current) continue;

    const ddlMatch = line.match(/DDL\s+(.+?)\)$/);
    if (ddlMatch) {
      current.ddlRaw = ddlMatch[1].trim();
      continue;
    }

    const urlMatch = line.match(/Go to\s+(https?:\/\/\S+)\s+to submit it\./);
    if (urlMatch) {
      current.url = urlMatch[1].trim();
      continue;
    }
  }

  return todos
    .map((todo) => {
      const ddlDate = parseDDL(todo.ddlRaw);
      return {
        ...todo,
        ddlDate,
      };
    })
    .filter((todo) => todo.ddlDate && !Number.isNaN(todo.ddlDate.getTime()));
}

function parseDDL(ddlRaw) {
  // 输入类似：6/8/2026, 11:59:00 PM
  // JS 会按当前 TZ 解析，所以运行脚本时设置 TZ=Asia/Shanghai
  if (!ddlRaw) return null;
  return new Date(ddlRaw);
}

function formatRemain(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return `${days}天${restHours}小时`;
  }

  return `${hours}小时${minutes}分钟`;
}

function formatDDL(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function makeKey(todo, threshold) {
  // DDL 改了会生成新 key，避免旧提醒状态影响新 DDL
  const base = todo.url || `${todo.course}-${todo.title}`;
  return `${threshold}h::${base}::${todo.ddlDate.toISOString()}`;
}

function collectDueReminders(todos, state) {
  const now = new Date();
  const reminders = [];

  for (const todo of todos) {
    // 忽略 1970 这种异常 DDL
    if (todo.ddlDate.getFullYear() < 2000) continue;

    const diffMs = todo.ddlDate.getTime() - now.getTime();
    if (diffMs <= 0) continue;

    const diffMinutes = diffMs / 60000;

    for (const threshold of THRESHOLDS_HOURS) {
      const thresholdMinutes = threshold * 60;
      const lowerBound = thresholdMinutes - WINDOW_MINUTES;
      const upperBound = thresholdMinutes;

      // 在 threshold 到 threshold-WINDOW 之间提醒一次
      if (diffMinutes <= upperBound && diffMinutes > lowerBound) {
        const key = makeKey(todo, threshold);
        if (!state[key]) {
          reminders.push({
            threshold,
            key,
            todo,
            diffMs,
          });
        }
      }
    }
  }

  return reminders;
}

function buildMessage(reminders) {
  const groups = new Map();

  for (const item of reminders) {
    if (!groups.has(item.threshold)) groups.set(item.threshold, []);
    groups.get(item.threshold).push(item);
  }

  const parts = ["【ZJU 待办截止提醒】"];

  for (const threshold of THRESHOLDS_HOURS) {
    const items = groups.get(threshold);
    if (!items || items.length === 0) continue;

    parts.push("");
    parts.push(`距离截止约 ${threshold} 小时：`);

    for (const { todo, diffMs } of items) {
      parts.push("");
      parts.push(`- ${todo.title}`);
      parts.push(`  课程：${todo.course}`);
      parts.push(`  DDL：${formatDDL(todo.ddlDate)}`);
      parts.push(`  剩余：${formatRemain(diffMs)}`);
      if (todo.url) parts.push(`  链接：${todo.url}`);
    }
  }

  return parts.join("\n");
}

function signedDingTalkUrl() {
  if (!DINGTALK_WEBHOOK) {
    throw new Error("DINGTALK_WEBHOOK is empty");
  }

  if (!DINGTALK_SECRET) {
    return DINGTALK_WEBHOOK;
  }

  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${DINGTALK_SECRET}`;

  const sign = crypto
    .createHmac("sha256", DINGTALK_SECRET)
    .update(stringToSign)
    .digest("base64");

  return `${DINGTALK_WEBHOOK}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

async function sendDingTalk(content) {
  if (!ENABLE_DINGTALK || !DINGTALK_WEBHOOK) {
    console.log("DingTalk disabled or webhook empty. Message below:");
    console.log(content);
    return;
  }

  const res = await fetch(signedDingTalkUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msgtype: "text",
      text: {
        content,
      },
    }),
  });

  const text = await res.text();
  console.log("DingTalk response:", text);
}

async function main() {
  console.log(`========== ${new Date().toISOString()} checking DDL reminders ==========`);

  const state = loadState();
  const output = await runTodolist();
  const todos = parseTodos(output);

  console.log(`Parsed ${todos.length} todos.`);

  const reminders = collectDueReminders(todos, state);

  if (reminders.length === 0) {
    console.log("No DDL reminders to send.");
    return;
  }

  const message = buildMessage(reminders);
  await sendDingTalk(message);

  const nowIso = new Date().toISOString();
  for (const item of reminders) {
    state[item.key] = {
      sentAt: nowIso,
      threshold: item.threshold,
      title: item.todo.title,
      course: item.todo.course,
      ddl: item.todo.ddlDate.toISOString(),
    };
  }

  saveState(state);
  console.log(`Sent ${reminders.length} reminder(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
