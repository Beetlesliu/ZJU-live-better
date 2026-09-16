import { COURSES, ZJUAM } from "login-zju";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";
import crypto from "crypto";
import dingTalk from "../shared/dingtalk-webhook.js";
import Decimal from "decimal.js";
Decimal.set({ precision: 100 });

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
// 说明: 在这里配置签到地点后，签到会优先【使用配置的地点】尝试
//      随后会尝试遍历RadarInfo中的所有地点
//      如果失败了>3次，则会尝试三点定位法

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

// if (false)
(async () => {
  while (true) {
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
              answerRadarRollcall(RadarInfo[CONFIG.radarAt], rollcallId);
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


async function answerRadarRollcall(radarXY, rid) {

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

  let radar_outcome = [];

  // Step 1: try configured location
  if (radarXY) {
    const outcome = await _req(radarXY[0], radarXY[1]);
    console.log("[Autosign][Try Config]", radarXY, outcome);
    if (outcome?.status_name === "on_call_fine") return true;
    radar_outcome.push([radarXY, outcome]);
  }

  // Step 2: try all radar beacon points
  for (const [key, value] of Object.entries(RadarInfo)) {
    const outcome = await _req(value[0], value[1]);
    console.log("[Autosign][Try Beacon]", key, value, outcome);

    if (outcome?.status_name === "on_call_fine") return true;
    radar_outcome.push([value, outcome]);
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
