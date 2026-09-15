import crypto from "crypto";
import fs from "fs";
import { spawn } from "child_process";
import "dotenv/config";

const PROJECT_DIR = "/opt/ZJU-live-better";
const TODO_SCRIPT = "courses.zju/todolist.js";
const STATE_FILE = "/opt/ZJU-live-better/.new-todo-state.json";

const ENABLE_DINGTALK = process.env.ENABLE_DINGTALK === "true";
const DINGTALK_WEBHOOK = process.env.DINGTALK_WEBHOOK || "";
const DINGTALK_SECRET = process.env.DINGTALK_SECRET || "";

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      initialized: false,
      todos: {},
    };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      initialized: false,
      todos: {},
    };
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
        reject(new Error(`todolist.js exited with code ${code}`));
      } else {
        resolve(output);
      }
    });
  });
}

// 解析 todolist.js 的输出：
//   - 第十四周作业 @ 微积分（甲）Ⅱ
//     Remains 10 hours (DDL 6/8/2026, 11:59:00 PM)
//     Go to https://courses.zju.edu.cn/... to submit it.
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
        ddlIso: "",
        url: "",
      };
      todos.push(current);
      continue;
    }

    if (!current) continue;

    const ddlMatch = line.match(/DDL\s+(.+?)\)$/);
    if (ddlMatch) {
      current.ddlRaw = ddlMatch[1].trim();

      const ddlDate = new Date(current.ddlRaw);
      if (!Number.isNaN(ddlDate.getTime())) {
        current.ddlIso = ddlDate.toISOString();
      }

      continue;
    }

    const urlMatch = line.match(/Go to\s+(https?:\/\/\S+)\s+to submit it\./);
    if (urlMatch) {
      current.url = urlMatch[1].trim();
      continue;
    }
  }

  return todos;
}

function makeTodoKey(todo) {
  // URL 里通常包含 learning-activity ID，最稳定
  if (todo.url) return todo.url;

  // 没 URL 时兜底
  return `${todo.course}::${todo.title}::${todo.ddlIso || todo.ddlRaw}`;
}

function formatDdl(todo) {
  if (!todo.ddlRaw) return "未知";

  const date = new Date(todo.ddlRaw);

  if (Number.isNaN(date.getTime())) {
    return todo.ddlRaw;
  }

  if (date.getFullYear() < 2000) {
    return "异常 DDL / 未设置";
  }

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
    console.log("DingTalk disabled or DINGTALK_WEBHOOK empty. Message below:");
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

function buildMessage(newTodos) {
  const parts = [
    "【ZJU 新待办提醒】",
    `检测到 ${newTodos.length} 个新发布/新出现的待办事项：`,
  ];

  for (const todo of newTodos) {
    parts.push("");
    parts.push(`- ${todo.title}`);
    parts.push(`  课程：${todo.course}`);
    parts.push(`  DDL：${formatDdl(todo)}`);

    if (todo.url) {
      parts.push(`  链接：${todo.url}`);
    }
  }

  return parts.join("\n");
}

async function main() {
  console.log(`========== ${new Date().toISOString()} checking new todos ==========`);

  const state = loadState();
  const output = await runTodolist();
  const todos = parseTodos(output);

  console.log(`Parsed ${todos.length} todos.`);

  const currentTodos = {};
  for (const todo of todos) {
    const key = makeTodoKey(todo);

    currentTodos[key] = {
      title: todo.title,
      course: todo.course,
      ddlRaw: todo.ddlRaw,
      ddlIso: todo.ddlIso,
      url: todo.url,
      lastSeenAt: new Date().toISOString(),
      firstSeenAt: state.todos?.[key]?.firstSeenAt || new Date().toISOString(),
    };
  }

  // 第一次运行只建立基准，不发提醒
  if (!state.initialized) {
    saveState({
      initialized: true,
      updatedAt: new Date().toISOString(),
      todos: currentTodos,
    });

    console.log("Initialized todo snapshot. No notification sent.");
    return;
  }

  const oldTodos = state.todos || {};
  const newTodos = [];

  for (const todo of todos) {
    const key = makeTodoKey(todo);

    if (!oldTodos[key]) {
      newTodos.push(todo);
    }
  }

  saveState({
    initialized: true,
    updatedAt: new Date().toISOString(),
    todos: currentTodos,
  });

  if (newTodos.length === 0) {
    console.log("No new todos.");
    return;
  }

  const message = buildMessage(newTodos);
  await sendDingTalk(message);

  console.log(`Sent ${newTodos.length} new todo reminder(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
