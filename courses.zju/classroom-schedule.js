/**
 * 教务网课表 → 雷达签到优先地点。
 *
 * 背景：雷达签到的原始逻辑是「配置地点 → 遍历 RadarInfo 全部 12 个信标 → 三点定位」，
 * 最坏要发 14 次请求。学在浙大对 rollcall 接口加了账号级 429 限流后，这个量级很危险。
 * 但实际上同一门课一整个学期都在同一间教室——只要知道课表，第一次就能试对。
 *
 * 数据源是教务网（zdbk）的学生课表接口。返回的 kbList[].kcb 是一段 <br> 分隔的
 * 富文本，形如：
 *
 *   博弈论<br>秋冬{第1-8周|1节/周}<br>汪淼军<br>紫金港北3-213zwf2027年01月13日(10:30-12:30)zwf
 *   └课程名┘  └── 学期/周次 ──┘  └教师┘  └─ 上课教室 ─┘└── z w f 分隔的考试信息 ──┘
 *
 * 我们只取「课程名」和「上课教室」两段：前者用来跟签到的 course_title 对上，
 * 后者用来查 ROOM_BEACON_RULES 得到信标键。
 *
 * ⚠️ ROOM_BEACON_RULES 是按楼群名猜的初始值，需要按实际签到效果校正。
 *    猜错不会坏事——签不上会回退到原来的全信标遍历，只是白花一次请求。
 */

import fs from "node:fs";
import path from "node:path";

const TIMETABLE_URL =
  "https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N253508";

/**
 * 教室名前缀 → RadarInfo 里的信标键。
 *
 * 按顺序匹配，第一条命中即返回。没命中的教室返回 null（= 不猜，直接走原来的全遍历）。
 * 体育场馆、经济学院大楼这些暂时故意不映射：它们的实际位置我没把握，
 * 与其猜错浪费一次请求，不如干脆不猜。等你实测出该用哪个信标再补上来。
 */
export const ROOM_BEACON_RULES = [
  [/^紫金港东/, "ZJGD1"], // 东1A-*、东2-*
  [/^紫金港西/, "ZJGX1"], // 西1-*、西2-*
  [/^紫金港北/, "ZJGB1"], // 北2-*、北3-*、北4-*
  [/^紫金港蒙民伟/, "ZJGB1"], // 蒙民伟楼，待实测确认
];

/** 服务器时区不一定是东八区，学期、星期几一律按北京时间算 */
function beijingNow(now = new Date()) {
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}

/**
 * 候选的 (学年, 学期) 组合，按可能性从高到低。
 *
 * xqm 取值是教务系统的内部编码，实测浙大这边 12 = 秋冬学期（9 月开学）、
 * 16 = 春夏学期（2 月开学）。学期边界靠月份推，不硬编码——
 * 猜错了也有后备组合兜底，反正最后以「返回了非空课表」为准。
 */
export function candidateTerms(now = new Date()) {
  const bj = beijingNow(now);
  const y = bj.getFullYear();
  const m = bj.getMonth() + 1;
  // 9 月到次年 1 月属于秋冬学期；1 月还算上一学年
  const isFall = m >= 9 || m <= 1;
  const academicYear = isFall ? (m <= 1 ? y - 1 : y) : y - 1;
  return isFall
    ? [
        [academicYear, 12],
        [academicYear, 16],
        [academicYear - 1, 16],
        [academicYear + 1, 12],
      ]
    : [
        [academicYear, 16],
        [academicYear, 12],
        [academicYear - 1, 16],
        [academicYear + 1, 12],
      ];
}

/** 今天是周几，按 RadarInfo 那套习惯：1=周一 … 7=周日 */
export function beijingWeekday(now = new Date()) {
  const d = beijingNow(now).getDay();
  return d === 0 ? 7 : d;
}

/** 拆 kbList[].kcb。字段不够时返回空串而不是抛错——课表里偶尔会有残缺条目 */
export function parseKcb(kcb) {
  const seg = String(kcb ?? "").split("<br>");
  return {
    course: (seg[0] ?? "").trim(),
    when: (seg[1] ?? "").trim(),
    teacher: (seg[2] ?? "").trim(),
    // 第 4 段是「教室 zwf 考试时间 zwf 考试教室」，考试信息可能为空
    room: String(seg[3] ?? "").split("zwf")[0].trim(),
  };
}

export function roomToBeacon(room, rules = ROOM_BEACON_RULES) {
  if (!room) return null;
  for (const [re, key] of rules) if (re.test(room)) return key;
  return null;
}

/**
 * 拉一次课表。逐个试候选学期，谁先返回非空课表就用谁——
 * 比「推导出唯一正确的学期」稳，教务系统换个编码也不用改代码。
 */
export async function fetchSchedule({ zdbk, now = new Date() }) {
  const tried = [];
  for (const [xnm, xqm] of candidateTerms(now)) {
    let res;
    try {
      res = await zdbk.fetch(TIMETABLE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `xnm=${xnm}&xqm=${xqm}`,
      });
    } catch (err) {
      tried.push(`${xnm}-${xqm}: ${err.message}`);
      continue;
    }
    if (res.status !== 200) {
      tried.push(`${xnm}-${xqm}: status ${res.status}`);
      continue;
    }
    const json = await res.json().catch(() => null);
    const kbList = json?.kbList ?? [];
    if (!kbList.length) {
      tried.push(`${xnm}-${xqm}: 0 条`);
      continue;
    }
    const entries = kbList
      .map((e) => {
        const { course, when, teacher, room } = parseKcb(e.kcb);
        return {
          course,
          when,
          teacher,
          room,
          beacon: roomToBeacon(room),
          xqj: String(e.xqj ?? ""),
          djj: String(e.djj ?? ""),
        };
      })
      .filter((e) => e.course);
    return { xnm, xqm, entries, fetchedAt: new Date().toISOString() };
  }
  throw new Error(`课表拉取失败，已尝试 ${tried.join("；")}`);
}

/** 归一化课程名再比对：全角括号、空格、书名号差异不该影响匹配 */
function normalizeCourseName(s) {
  return String(s ?? "")
    .replace(/[\s　]/g, "")
    .replace(/[（）()【】\[\]]/g, "")
    .toLowerCase();
}

/**
 * 给定签到通知里的课程名，返回该课可能要去的信标键（有序、去重）。
 *
 * 先精确匹配，再退化为互相包含——学在浙大和教务网的课程名偶尔对不齐
 * （比如一边叫「计量经济学」另一边叫「中级计量经济学」）。
 * 同一天有课的教室优先；当天没课就退回到这门课的全部教室。
 * 匹配不到返回空数组，调用方据此回退到原来的全遍历。
 */
export function beaconKeysForCourse(entries, courseTitle, weekday = null) {
  const target = normalizeCourseName(courseTitle);
  if (!target) return [];

  const all = entries ?? [];
  let hits = all.filter((e) => normalizeCourseName(e.course) === target);
  if (!hits.length) {
    hits = all.filter((e) => {
      const c = normalizeCourseName(e.course);
      return c && (c.includes(target) || target.includes(c));
    });
  }
  if (!hits.length) return [];

  const sameDay = weekday != null ? hits.filter((e) => e.xqj === String(weekday)) : [];
  const pool = sameDay.length ? sameDay : hits;

  const out = [];
  for (const e of pool) {
    if (e.beacon && !out.includes(e.beacon)) out.push(e.beacon);
  }
  return out;
}

/** 读缓存。宁可返回 null 也不抛错——课表只是优化项，坏了不该拖垮签到 */
export function readScheduleCache(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeScheduleCache(filePath, data) {
  // 与 reminders 一致：先写临时文件再 rename，避免读到写了一半的 JSON
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * 拿课表：缓存够新就直接用，否则重新拉一次；拉失败就沿用旧缓存。
 * 任何情况下都不抛错——最差返回 null，调用方回退到原来的全信标遍历。
 */
export async function loadSchedule({
  zdbk,
  cachePath,
  maxAgeMs,
  log = () => {},
  now = new Date(),
}) {
  const cached = readScheduleCache(cachePath);
  const ageMs = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;

  if (cached && ageMs < maxAgeMs) {
    log(
      `[课表] 用缓存：${cached.entries?.length ?? 0} 条，` +
        `${Math.round(ageMs / 60000)} 分钟前拉取（学期 ${cached.xnm}/${cached.xqm}）`
    );
    return { ...cached, stale: false };
  }

  try {
    const fresh = await fetchSchedule({ zdbk, now });
    writeScheduleCache(cachePath, fresh);
    const mapped = fresh.entries.filter((e) => e.beacon).length;
    log(
      `[课表] 已刷新：学期 ${fresh.xnm}/${fresh.xqm}，${fresh.entries.length} 条，` +
        `其中 ${mapped} 条能映射到信标`
    );
    return { ...fresh, stale: false };
  } catch (err) {
    if (cached) {
      // 标成 stale，调用方据此改用「失败重试间隔」而不是正常刷新周期
      log(`[课表] 刷新失败，沿用旧缓存（${err.message}）`);
      return { ...cached, stale: true };
    }
    log(`[课表] 拉取失败且无缓存，本次退回全信标遍历（${err.message}）`);
    return null;
  }
}
