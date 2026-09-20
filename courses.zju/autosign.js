import { COURSES, ZDBK, ZJUAM } from "login-zju";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";
import crypto from "crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dingTalk from "../shared/dingtalk-webhook.js";
import Decimal from "decimal.js";
import {
  beaconKeysForCourse,
  beijingWeekday,
  loadSchedule,
} from "./classroom-schedule.js";
Decimal.set({ precision: 100 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  radarAt: "ZJGD1",
  coldDownTime: 4000, // 4s
  // ---- 数字签到：只轮询取码，不做万位爆破（见文件底部说明）----
  numberCodePollInterval: 3000, // 轮询 number_code 的间隔
  numberCodeDeadline: 120000, // 最长等待取码时间，超时告警
  numberCodeEarlyWarn: 45000, // 等待多久还没码就先推送「请手动签到」
  // ---- 限流保护：学在浙大已对 rollcall API 加频率限制 ----
  minRequestGap: 350, // 任意两次 rollcall 请求的最小间隔
  backoffBase: 20000, // 触发 429 后的全局暂停基准，按次翻倍
  maxBackoff: 300000, // 全局暂停上限 5 分钟
  // ---- 课表优先：先用课表匹配出的教室，签不上再回退到全信标遍历 ----
  scheduleEnabled: process.env.AUTOSIGN_SCHEDULE !== "false",
  scheduleCachePath:
    process.env.AUTOSIGN_SCHEDULE_CACHE ||
    path.join(__dirname, "..", ".schedule-state.json"),
  scheduleRefreshMs: Number(process.env.AUTOSIGN_SCHEDULE_REFRESH_MS || 6 * 3600 * 1000),
  // 拉失败时的重试间隔，比刷新周期短得多——课表拿不到会退回全信标遍历（费请求但能签上）
  scheduleRetryMs: Number(process.env.AUTOSIGN_SCHEDULE_RETRY_MS || 10 * 60 * 1000),
};
const RadarInfo = {
  ZJGD1: [120.089136, 30.302331], //东一教学楼
  ZJGX1: [120.085042, 30.30173], //西教学楼
  ZJGB1: [120.077135, 30.305142], //段永平教学楼
  YQ4: [120.122176,30.261555], //玉泉教四
  YQ1: [120.123853,30.262544], //玉泉教一
  YQ7: [120.120344,30.263907], //玉泉教七
  ZJ1: [120.126008,30.192908], //之江校区1
  HJC1: [120.195939,30.272068], //华家池校区1
  HJC2: [120.198193,30.270419], //华家池校区2
  ZJ2: [120.124267,30.19139], //之江校区2 // 之江校区半径都没500米
  YQSS: [120.124001,30.265735], //虽然大概不会有课在宿舍上但还是放一个点位
  ZJG4: [120.073427,30.299757], //紫金港大西区
};
// 雷达签到的尝试顺序（越靠前越省请求）：
//   1. 【课表匹配到的教室】——查教务网课表，把上课教室映射成信标，通常第 1 次就中
//   2. 【配置的雷达地点】CONFIG.radarAt
//   3. 遍历 RadarInfo 中的其余全部信标
//   4. 仍失败则三点定位
// 见文件下方「课表优先」一节。课表拿不到时自动退化成 2→3→4，与旧行为一致。

// 成功率：目前【雷达点名】+【已配置了雷达地点】的情况可以100%签到成功
//        数字点名改为「轮询取码」，不再爆破，原因见 batchNumberRollCall 注释

// 顺便一提，经测试，radar_out_of_scope的限制是500米整

const sendBoth=(msg)=>{
  console.log(msg);
  dingTalk(msg);
}


const courses = new COURSES(
  new ZJUAM(process.env.ZJU_USERNAME, process.env.ZJU_PASSWORD)
);

dingTalk("[Auto Sign-in] Logged in as " + process.env.ZJU_USERNAME);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let req_num = 0;

// ============================================================
// 限流保护
// ------------------------------------------------------------
// 学在浙大对 rollcall 相关接口加了频率限制：短时间内请求过多会返回
// 429 TOO MANY REQUESTS，且限制作用于【账号】而非单个 Session
// （换 Session、换设备同样被拦）。
//
// 因此所有 rollcall 请求都必须经过 gate()，并在收到 429 时全局退避，
// 否则会把整个账号打封 —— 连雷达签到一起失效。
// ============================================================
let lastRequestAt = 0;
let globalPauseUntil = 0;
let rateLimitStrikes = 0;

async function gate() {
  for (;;) {
    const now = Date.now();
    if (now < globalPauseUntil) {
      await sleep(Math.min(globalPauseUntil - now, 10000));
      continue;
    }
    const since = Date.now() - lastRequestAt;
    if (since < CONFIG.minRequestGap) {
      await sleep(CONFIG.minRequestGap - since);
      continue;
    }
    lastRequestAt = Date.now();
    return;
  }
}

function noteRateLimited(context) {
  rateLimitStrikes += 1;
  const backoff = Math.min(
    CONFIG.backoffBase * Math.pow(2, rateLimitStrikes - 1),
    CONFIG.maxBackoff
  );
  globalPauseUntil = Date.now() + backoff;
  sendBoth(
    `[Auto Sign-in] ⚠️ 触发限流 429 @ ${context}，全局暂停 ${Math.round(
      backoff / 1000
    )}s（第 ${rateLimitStrikes} 次）。所有签到请求已挂起，避免账号被打封。`
  );
}

function noteOk() {
  rateLimitStrikes = 0;
}

// 只保留可安全外发的标量字段，避免把其他同学的姓名/学号推送到钉钉
function summarizeRollcall(data) {
  if (!data || typeof data !== "object") return String(data);
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
      out[k] = v;
    }
  }
  return out;
}

// ============================================================
// 课表优先
// ------------------------------------------------------------
// 雷达签到原本是「配置地点 → 遍历全部 12 个信标 → 三点定位」，最坏 14 次请求。
// 学在浙大加了账号级 429 限流之后，这个量级很危险。但同一门课一整个学期都在
// 同一间教室——先查课表拿到教室、映射成信标试一次，成了就收工，通常只要 1 次。
//
// 课表只是优化项：任何一环失败（教务网挂了、课程名对不上、教室没映射）都必须
// 退回原来的全信标遍历，绝不能因为课表出问题而漏签。
// ============================================================
let scheduleCache = null;
let scheduleInFlight = false;
let scheduleNextCheckAt = 0; // 下次允许碰课表的时间（正常周期 or 失败退避）

async function refreshSchedule(force = false) {
  if (!CONFIG.scheduleEnabled || scheduleInFlight) return;
  if (!force && Date.now() < scheduleNextCheckAt) return;

  scheduleInFlight = true;
  try {
    const zdbk = new ZDBK(
      new ZJUAM(process.env.ZJU_USERNAME, process.env.ZJU_PASSWORD)
    );
    const next = await loadSchedule({
      zdbk,
      cachePath: CONFIG.scheduleCachePath,
      maxAgeMs: CONFIG.scheduleRefreshMs,
      log: (m) => console.log("[Auto Sign-in]" + m),
    });
    scheduleCache = next;
    // 顺利拿到（新鲜的或刚拉的）→ 正常周期；只翻出旧缓存或彻底没拿到 → 短退避重试，
    // 否则课前那一次失败就要等满整个刷新周期，等于这场课全废了。
    scheduleNextCheckAt =
      Date.now() +
      (next && !next.stale ? CONFIG.scheduleRefreshMs : CONFIG.scheduleRetryMs);
  } catch (err) {
    // loadSchedule 内部已经兜过底，这里防的是 ZDBK 构造 / CAS 登录本身抛错
    console.log(`[Auto Sign-in][课表] 初始化失败，退回全信标遍历：${err.message}`);
    scheduleCache = null;
    scheduleNextCheckAt = Date.now() + CONFIG.scheduleRetryMs;
  } finally {
    scheduleInFlight = false;
  }
}

/**
 * 这次雷达签到按什么顺序试地点：课表匹配到的排最前，然后是配置地点，
 * 最后是其余全部信标兜底。重复坐标交给 answerRadarRollcall 去重。
 */
function radarCoordinateOrder(rollcall) {
  const keys = [];
  const matched = beaconKeysForCourse(
    scheduleCache?.entries,
    rollcall?.course_title,
    beijingWeekday()
  );

  if (matched.length) {
    console.log(
      `[Auto Sign-in][课表] 「${rollcall?.course_title}」→ 优先信标 ${matched.join(", ")}`
    );
  } else {
    console.log(
      `[Auto Sign-in][课表] 「${rollcall?.course_title}」没匹配到教室，按默认顺序尝试`
    );
  }

  keys.push(...matched);
  if (CONFIG.radarAt) keys.push(CONFIG.radarAt);
  keys.push(...Object.keys(RadarInfo));

  return keys.map((k) => RadarInfo[k]).filter(Boolean);
}

// if (false)
(async () => {
  // 先把课表拉起来再进循环，否则第一节课的第一次签到用不上（那次最要紧）
  await refreshSchedule(true);

  while (true) {
    // 不 await：刷新只影响下一次签到的起点，不该拖慢轮询
    refreshSchedule();

    await gate();
    await courses
      .fetch("https://courses.zju.edu.cn/api/radar/rollcalls")
      .then(async (res) => {
        if (res.status === 429) {
          noteRateLimited("radar/rollcalls");
          return { rollcalls: [] };
        }
        if (res.status !== 200) {
          // 只打日志，避免持续异常时刷屏钉钉；429 已在上面单独告警
          console.log(`[-][Auto Sign-in] radar/rollcalls 返回 ${res.status}`);
          return { rollcalls: [] };
        }
        const fa = await res.text();
        try {
          const parsed = JSON.parse(fa);
          noteOk();
          return parsed;
        } catch (e) {
          sendBoth("[-][Auto Sign-in] Something went wrong: " + fa + "\nError: " + e.toString());
          return { rollcalls: [] };
        }
      })
      .then(async (v) => {
        if (v.rollcalls.length == 0) {
          console.log(`[Auto Sign-in](Req #${++req_num}) No rollcalls found.`);
        } else {
          console.log(
            `[Auto Sign-in](Req #${++req_num}) Found ${v.rollcalls.length} rollcalls.
                They are:${v.rollcalls.map(
                  (rc) => `
                  - ${rc.title} @ ${rc.course_title} by ${rc.created_by_name} (${rc.department_name})`
            )}`
          );
          // console.log(v.rollcalls);



          v.rollcalls.forEach((rollcall) => {
            /**
             * It looks like
             *
  {
    avatar_big_url: '',
    class_name: '',
    course_id: 77997,
    course_title: '思想道德与法治',
    created_by: 1835,
    created_by_name: '单珏慧',
    department_name: '马克思主义学院',
    grade_name: '',
    group_set_id: 0,
    is_expired: false,
    is_number: false,
    is_radar: true,
    published_at: null,
    rollcall_id: 171329,
    rollcall_status: 'in_progress',
    rollcall_time: '2024-12-12T10:51:43Z',
    scored: true,
    source: 'radar',
    status: 'absent',
    student_rollcall_id: 0,
    title: '2024.12.12 18:51',
    type: 'another'
  }
             */
            const rollcallId = rollcall.rollcall_id;
            // console.log(rollcall);
            if (rollcall.status == "on_call_fine" || rollcall.status == "on_call" || rollcall.status_name == "on_call_fine" || rollcall.status_name == "on_call") {
              console.log("[Auto Sign-in] Note that #" + rollcallId + " is on call.");
              ;
              return;
            }
            console.log("[Auto Sign-in] Now answering rollcall #" + rollcallId);
            if (rollcall.is_radar) {
              sendBoth(`[Auto Sign-in] Answering new radar rollcall #${rollcallId}: ${rollcall.title} @ ${rollcall.course_title} by ${rollcall.created_by_name} (${rollcall.department_name})`);
              answerRadarRollcall(radarCoordinateOrder(rollcall), rollcallId);
              return;
            }
            if (rollcall.is_number) {
              batchNumberRollCall(rollcallId, rollcall);
              return;
            }
            // None of the above.
            console.log(`[Auto Sign-in] Rollcall #${rollcallId} has an unknown type and we cannot handle it yet.`)
            console.log("[Auto Sign-in] Rollcall details: ", rollcall);
            console.log("[Auto Sign-in] If you see this message, please consider \x1b[31m submitting an issue with the rollcall details above \x1b[0m so that we can support this type in the future. Thank you!");
          });
        }
      }).catch((e) => {
        console.log(
          `[Auto Sign-in](Req #${++req_num}) Failed to fetch rollcalls: `,
          e
        );
      });

    await sleep(CONFIG.coldDownTime);
  }
})();

function decimalHaversineDist(lon, lat, lon_i, lat_i, R) {
  const DEG = Decimal.acos(-1).div(180);

  const λ  = new Decimal(lon).mul(DEG);
  const φ  = new Decimal(lat).mul(DEG);
  const λi = new Decimal(lon_i).mul(DEG);
  const φi = new Decimal(lat_i).mul(DEG);

  const dφ = φ.minus(φi);
  const dλ = λ.minus(λi);

  const sin_dφ_2 = dφ.div(2).sin().pow(2);
  const sin_dλ_2 = dλ.div(2).sin().pow(2);

  const h = sin_dφ_2.plus(
    φ.cos().mul(φi.cos()).mul(sin_dλ_2)
  );

  const deltaSigma = Decimal.asin(h.sqrt()).mul(2);

  return R.mul(deltaSigma);
}

function residualsDecimal(lon, lat, pts, R) {
  const res = [];

  for (const p of pts) {
    const dist = decimalHaversineDist(lon, lat, p.lon, p.lat, R);
    res.push(new Decimal(p.d).minus(dist));
  }
  return res;
}

function jacobianDecimal(lon, lat, pts, R) {
  const eps = new Decimal("1e-12");

  const base = residualsDecimal(lon, lat, pts, R);

  const resLon = residualsDecimal(
    new Decimal(lon).plus(eps),
    lat,
    pts,
    R
  );
  const resLat = residualsDecimal(
    lon,
    new Decimal(lat).plus(eps),
    pts,
    R
  );

  const J = [];
  for (let i = 0; i < pts.length; i++) {
    const dLon = resLon[i].minus(base[i]).div(eps).neg();
    const dLat = resLat[i].minus(base[i]).div(eps).neg();
    J.push([dLon, dLat]);
  }
  return J;
}

function gaussNewtonDecimal(pts, lon0, lat0, R) {
  let lon = new Decimal(lon0);
  let lat = new Decimal(lat0);

  for (let iter = 0; iter < 30; iter++) {
    const r = residualsDecimal(lon, lat, pts, R);
    const J = jacobianDecimal(lon, lat, pts, R);

    let JTJ = [
      [new Decimal(0), new Decimal(0)],
      [new Decimal(0), new Decimal(0)]
    ];
    let JTr = [new Decimal(0), new Decimal(0)];

    for (let i = 0; i < pts.length; i++) {
      const j = J[i];
      const ri = r[i];

      JTJ[0][0] = JTJ[0][0].plus(j[0].mul(j[0]));
      JTJ[0][1] = JTJ[0][1].plus(j[0].mul(j[1]));
      JTJ[1][0] = JTJ[1][0].plus(j[1].mul(j[0]));
      JTJ[1][1] = JTJ[1][1].plus(j[1].mul(j[1]));

      JTr[0] = JTr[0].plus(j[0].mul(ri));
      JTr[1] = JTr[1].plus(j[1].mul(ri));
    }

    const det = JTJ[0][0].mul(JTJ[1][1]).minus(
      JTJ[0][1].mul(JTJ[1][0])
    );

    const inv = [
      [
        JTJ[1][1].div(det),
        JTJ[0][1].neg().div(det)
      ],
      [
        JTJ[1][0].neg().div(det),
        JTJ[0][0].div(det)
      ]
    ];

    const dLon = inv[0][0].mul(JTr[0]).plus(inv[0][1].mul(JTr[1]));
    const dLat = inv[1][0].mul(JTr[0]).plus(inv[1][1].mul(JTr[1]));

    lon = lon.plus(dLon);
    lat = lat.plus(dLat);

    console.log(`[Iter ${iter}] lon = ${lon}, lat = ${lat}`);

    // 收敛条件
    if (dLon.abs().lt("1e-14") && dLat.abs().lt("1e-14")) break;
  }

  return { lon, lat };
}

function rmsDecimal(lon, lat, pts, R) {
  let sum = new Decimal(0);

  for (const p of pts) {
    const dModel = decimalHaversineDist(lon, lat, p.lon, p.lat, R);
    const diff = new Decimal(p.d).minus(dModel);
    sum = sum.plus(diff.mul(diff));
  }

  return sum.div(pts.length).sqrt();
}

function solveSphereLeastSquaresDecimal(rawPoints) {

  const lon0 = rawPoints.reduce((s,p)=>s+p.lon,0) / rawPoints.length;
  const lat0 = rawPoints.reduce((s,p)=>s+p.lat,0) / rawPoints.length;

  const R = new Decimal("6372999.26");

  const res = gaussNewtonDecimal(rawPoints, lon0, lat0, R);

  const rms = rmsDecimal(res.lon, res.lat, rawPoints, R);

  return {
    lon: Number(res.lon),
    lat: Number(res.lat),
    rms: Number(rms)
  };
}


/**
 * @param {Array<[number, number]>} coords 有序的候选坐标，第一个是首选。
 *        由 radarCoordinateOrder() 按「课表匹配 → 配置地点 → 其余信标」排好。
 */
async function answerRadarRollcall(coords, rid) {

  async function _req(lon, lat) {
    await gate();
    return await courses.fetch(
      "https://courses.zju.edu.cn/api/rollcall/" + rid + "/answer?api_version=1.1.2",
        {
          body: JSON.stringify({
            deviceId: uuidv4(),
            latitude: lat,
            longitude: lon,
            speed: null,
            accuracy: 68,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
          }),
          method: "PUT",
        headers: { "Content-Type": "application/json" }
      }
    ).then(async v => {
      if (v.status === 429) {
        noteRateLimited(`answer radar #${rid}`);
        return { __rateLimited: true };
      }
      try { return await v.json(); }
      catch (e) { console.log("[Autosign][JSON error]", e); return null; }
      });
  }

  // 去重：配置地点本来就在 RadarInfo 表里，原来的写法会拿同一个坐标试两遍，
  // 白白多一次可能触发 429 的请求。
  const seen = new Set();
  const queue = [];
  for (const coord of coords ?? []) {
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const key = `${coord[0]},${coord[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(coord);
  }

  if (queue.length === 0) {
    sendBoth(`[Autosign] 雷达签到 #${rid}：没有可用的签到地点，请检查 RadarInfo 配置`);
    return false;
  }

  const radar_outcome = [];

  // Step 1: 首选地点。通常就是课表匹配出来的那间教室——成了就只花 1 次请求。
  const preferred = queue[0];
  const preferredOutcome = await _req(preferred[0], preferred[1]);
  console.log("[Autosign][Try Preferred]", preferred, preferredOutcome);
  if (preferredOutcome?.status_name === "on_call_fine") return true;
  radar_outcome.push([preferred, preferredOutcome]);

  // Step 2: 其余信标逐个兜底
  for (const coord of queue.slice(1)) {
    const outcome = await _req(coord[0], coord[1]);
    console.log("[Autosign][Try Beacon]", coord, outcome);

    if (outcome?.status_name === "on_call_fine") return true;
    radar_outcome.push([coord, outcome]);
  }

  // Step 3: spherical Nelder-Mead trilateration
  let rawPoints = [];

  for (const [coord, outcome] of radar_outcome) {
    const d = Number(outcome?.distance ?? outcome?.data?.distance ?? outcome?.result?.distance);
    if (Number.isFinite(d) && d > 0) {
      rawPoints.push({ lon: coord[0], lat: coord[1], d });
      console.log("[Autosign][Dist Point]", coord, "d =", d);
    }
  }

  if (rawPoints.length < 3) {
    console.log("[Autosign][SphereFit] Not enough points.");
    return false;
  }

  const est = solveSphereLeastSquaresDecimal(rawPoints);

  console.log("[Autosign][SphereFit] Estimated:", est);

  const finalOutcome = await _req(est.lon, est.lat);

  if (finalOutcome?.status_name === "on_call_fine") {
    sendBoth(`[Autosign] Estimated position success: ${est.lon}, ${est.lat}`);
    return true;
  }

  return false;
}

async function answerNumberRollcall(numberCode, rid) {
  await gate();
  const res = await courses.fetch(
    "https://courses.zju.edu.cn/api/rollcall/" +
      rid +
      "/answer_number_rollcall",
    {
      body: JSON.stringify({
        deviceId: uuidv4(),
        numberCode,
      }),
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (res.status === 429) {
    noteRateLimited(`answer_number #${rid}`);
    return { ok: false, rateLimited: true, status: 429 };
  }

  /*
  When fail:
  400 BAD REQUEST
  {"error_code":"wrong_number_code","message":"wrong number code","number_code":"6921"}
  When success:
  200 OK
  {"id":5427153,"status":"on_call"}
   */
  let body = null;
  try { body = await res.json(); } catch (e) { /* 可能是空响应 */ }

  if (res.status !== 200) {
    console.log("[Autosign][answer_number] 非 200:", res.status, body);
    return { ok: false, status: res.status, body };
  }
  noteOk();
  return { ok: true, status: 200, body };
}

// ============================================================
// 数字签到
// ------------------------------------------------------------
// 历史实现是「并发爆破 0000-9999」。该做法在 2026-09 之后已不可用：
//
//   1. 学在浙大对 rollcall API 加了频率限制，短时间大量请求返回 429；
//   2. 限制作用于【账号】而非 Session —— 换设备、换 Session 一样被拦，
//      一旦打封，雷达签到会一起失效；
//   3. 即使不被封，按限流下的安全速率跑完 1 万个码也要 4 小时以上，
//      远超签到窗口，实际上不可能爆破成功。
//
// 现在改为：直接轮询 student_rollcalls 读取 number_code。
// 每 3 秒一个请求，完全在限流阈值内。
// 若在窗口内始终拿不到码，则推送钉钉提醒人工签到，
// 并附上接口的真实返回以便定位（这正是诊断学校改动的关键信息）。
// ============================================================
const numberTasks = new Map(); // rid -> Promise，防止重复处理
const numberWarned = new Set(); // 已推送过「请手动签到」的 rid

async function batchNumberRollCall(rid, meta = {}) {
  if (numberTasks.has(rid)) {
    console.log("[Auto Sign-in] 数字签到 #" + rid + " 已在处理中");
    return numberTasks.get(rid);
  }

  const task = (async () => {
    const startedAt = Date.now();
    const deadline = startedAt + CONFIG.numberCodeDeadline;
    let lastSummary = null;
    let lastStatus = null;

    console.log(`[Auto Sign-in] 数字签到 #${rid} 开始轮询签到码（每 ${CONFIG.numberCodePollInterval}ms 一次）`);

    while (Date.now() < deadline) {
      const poll = await getNumberCode(rid);
      lastStatus = poll.status ?? lastStatus;
      if (poll.data) lastSummary = summarizeRollcall(poll.data);

      const rawCode = poll.data?.number_code;
      const code =
        rawCode === null || rawCode === undefined || String(rawCode).trim() === ""
          ? null
          : String(rawCode).trim().padStart(4, "0");

      if (code) {
        console.log(`[Auto Sign-in] #${rid} 取到签到码 ${code}，提交中…`);
        const r = await answerNumberRollcall(code, rid);
        if (r.ok) {
          sendBoth(`[Auto Sign-in] 数字签到 #${rid} 成功，签到码 ${code}。`);
          return;
        }
        if (r.rateLimited) {
          // 已全局退避，等下轮继续
          console.log(`[Auto Sign-in] #${rid} 提交触发限流，等待退避后重试`);
        } else {
          console.log(`[Auto Sign-in] #${rid} 签到码 ${code} 被拒绝：`, r.status, r.body);
          sendBoth(
            `[Auto Sign-in] ⚠️ 数字签到 #${rid} 取到签到码 ${code} 但提交被拒（HTTP ${r.status}）。` +
              `可能是提交格式已变更，请手动签到。`
          );
          return;
        }
      }

      // 等了一段时间还没码，先提醒人工签，别等到窗口结束
      if (
        !code &&
        Date.now() - startedAt > CONFIG.numberCodeEarlyWarn &&
        !numberWarned.has(rid)
      ) {
        numberWarned.add(rid);
        sendBoth(buildManualSignMsg(rid, meta, lastSummary, lastStatus));
      }

      await sleep(CONFIG.numberCodePollInterval);
    }

    if (!numberWarned.has(rid)) {
      numberWarned.add(rid);
      sendBoth(buildManualSignMsg(rid, meta, lastSummary, lastStatus));
    }
    console.log(`[Auto Sign-in] 数字签到 #${rid} 结束（未取到签到码）`, lastSummary);
  })().finally(() => {
    numberTasks.delete(rid);
  });

  numberTasks.set(rid, task);
  return task;
}

function buildManualSignMsg(rid, meta, summary, status) {
  const lines = [
    `[Auto Sign-in] 🚨 数字签到 #${rid} 取不到签到码，请尽快手动签到！`,
    ``,
    `课程：${meta.course_title ?? "未知"}`,
    `时间：${meta.title ?? "未知"}`,
    `教师：${meta.created_by_name ?? "未知"}`,
    ``,
    `诊断信息（供定位学校改动）：`,
    `- student_rollcalls HTTP ${status ?? "?"}`,
  ];
  if (summary) {
    for (const k of [
      "is_number",
      "is_radar",
      "status",
      "number_code",
      "published_at",
      "end_time",
      "title",
    ]) {
      if (k in summary) lines.push(`- ${k}: ${JSON.stringify(summary[k])}`);
    }
  } else {
    lines.push(`- 未取到响应体`);
  }
  return lines.join("\n");
}

async function getNumberCode(rid) {
  await gate();
  try {
    const res = await courses.fetch(
      "https://courses.zju.edu.cn/api/rollcall/" + rid + "/student_rollcalls",
    );
    if (res.status === 429) {
      noteRateLimited(`student_rollcalls #${rid}`);
      return { rateLimited: true, status: 429 };
    }
    if (res.status !== 200) {
      return { status: res.status };
    }
    const data = await res.json();
    noteOk();
    return { data, status: 200 };
  } catch (e) {
    console.log("[Autosign][JSON error]", e);
    return { error: String(e) };
  }
}
