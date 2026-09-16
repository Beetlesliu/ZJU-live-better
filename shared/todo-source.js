/**
 * 待办数据源：直接读 /api/todos 的结构化 JSON。
 *
 * 以前的 ddl-reminder / new-todo-reminder 是 spawn 一个子进程跑
 * courses.zju/todolist.js，再把它的**人类可读 stdout** 用正则解回来：
 *
 *   /^- (.+?) @ (.+)$/          ← 标题里带 " @ " 就会被截断
 *   /DDL\s+(.+?)\)$/            ← 依赖 toLocaleString() 的输出格式
 *   new Date("6/8/2026, 11:59:00 PM")   ← 依赖运行时的 TZ 与 Node ICU 版本
 *
 * 而 API 本来就返回 ISO 时间和干净的字段。直连之后这一整条链子都没了，
 * 同时也省掉每次运行一个子进程（及它自己的一次 CAS 登录）。
 */

import "dotenv/config";

import { COURSES, ZJUAM } from "login-zju";

export const COURSES_ORIGIN = "https://courses.zju.edu.cn";

let cachedCourses = null;

function getCourses() {
  if (cachedCourses) return cachedCourses;

  const { ZJU_USERNAME, ZJU_PASSWORD } = process.env;
  if (!ZJU_USERNAME || !ZJU_PASSWORD) {
    throw new Error("缺少 ZJU_USERNAME / ZJU_PASSWORD，请检查 .env");
  }

  cachedCourses = new COURSES(new ZJUAM(ZJU_USERNAME, ZJU_PASSWORD));
  return cachedCourses;
}

export function activityUrl(courseId, activityId) {
  return `${COURSES_ORIGIN}/course/${courseId}/learning-activity#/${activityId}`;
}

function clean(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeTodo(raw) {
  const endTimeIso = raw?.end_time ? new Date(raw.end_time).toISOString() : null;
  const parsed = endTimeIso ? new Date(endTimeIso) : null;

  // 学在浙大对"未设置 DDL"的作业会返回 1970 这种哨兵值，不能当成真的截止时间
  const usable = parsed && !Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2000;

  return {
    id: raw?.id,
    title: clean(raw?.title, "(无标题)"),
    course: clean(raw?.course_name, "未知课程"),
    courseId: raw?.course_id,
    type: clean(raw?.type, ""),
    endTime: usable ? parsed : null,
    // 即便 DDL 不可用也保留原始 ISO，作为 key 的一部分保证稳定
    endTimeIso,
    url: activityUrl(raw?.course_id, raw?.id),
  };
}

/**
 * 拉取待办列表。网络/鉴权失败时抛异常，让调用方走失败分支——
 * 绝不返回空数组冒充"没有待办"，那会把一整轮提醒静默吞掉。
 */
export async function fetchTodos() {
  const courses = getCourses();
  const res = await courses.fetch(`${COURSES_ORIGIN}/api/todos`);

  if (!res.ok) {
    throw new Error(`GET /api/todos 返回 HTTP ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  if (!Array.isArray(body?.todo_list)) {
    throw new Error("/api/todos 响应里没有 todo_list 数组");
  }

  return body.todo_list.map(normalizeTodo);
}

/** 待办在列表中的稳定标识，与旧脚本的 key 格式保持一致以便复用历史 state */
export function makeTodoKey(todo) {
  return todo.url || `${todo.course}::${todo.title}::${todo.endTimeIso ?? "no-ddl"}`;
}
