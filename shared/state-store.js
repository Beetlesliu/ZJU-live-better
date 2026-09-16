import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录，避免各脚本硬编码绝对路径 */
export const PROJECT_ROOT = path.resolve(__dirname, "..");

export function resolveProjectPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

/**
 * 读取 JSON 状态文件。
 * 文件不存在或损坏时返回 fallback（而不是让调用方崩掉）。
 */
export function loadState(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return typeof fallback === "function" ? fallback() : fallback;
  }
}

/**
 * 原子写入：先写临时文件再 rename。
 *
 * 直接 writeFileSync 覆盖的问题是：写一半崩溃会留下截断的 JSON，
 * 下次 loadState 解析失败返回空状态，于是所有已发过的提醒会被重发一遍。
 * rename 在同一文件系统内是原子的，读到的要么是旧内容要么是新内容。
 */
export function saveState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}
