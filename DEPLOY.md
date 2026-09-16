# 部署说明（本机自建部分）

上游 README 讲的是怎么用各个脚本。这份文档只讲**这台服务器上怎么跑**。

## 现状：systemd 托管

之前是靠 tmux 里手敲的 `while true` 循环跑的。问题在于那些循环**从未落盘**——
`run-ddl-reminder-loop.sh`、`run-autosign-loop.sh` 在磁盘上根本不存在，
只活在 shell 内存和 tmux 回滚缓冲里。服务器一重启（腾讯云偶发维护）
全部静默消失，而且不会有任何通知。现已改为 systemd。

| 单元 | 作用 | 模式 |
| --- | --- | --- |
| `zju-autosign.service` | 雷达/数字签到监听 | 常驻，`Restart=always` |
| `zju-reminders.timer` | 触发 `zju-reminders.service`，每 10 分钟一轮 | `OnCalendar=*:0/10`，`Persistent=true` |
| `zju-grades.service` | 正式成绩监控（zdbk），出分即推送 | 常驻，时段 08:00–24:00，间隔 1h |

```bash
systemctl status zju-autosign zju-reminders.timer zju-grades
systemctl restart zju-autosign          # 改了 autosign.js 之后
systemctl start   zju-reminders.service # 立刻跑一轮提醒
```

### 统一状态

```bash
zju-status                  # 回看 24 小时
zju-status "7 days ago"     # 回看一周
```

一条命令覆盖：单元状态与重启次数、autosign 签到事件、提醒最近一轮结果、
各 state 文件新鲜度、钉钉配置、journal 占用。

### 看日志

日志走 journald，自带轮转，不再需要 logrotate，也不再有 tmux 2000 行回滚上限的限制。

```bash
journalctl -u zju-autosign -f                 # 实时
journalctl -u zju-reminders --since today     # 今天的提醒记录
journalctl -u zju-grades -n 50
```

### 配置

全部通过项目根目录的 `.env` 读取（由各脚本内的 `dotenv/config` 加载）。

```
ZJU_USERNAME / ZJU_PASSWORD      必需
ENABLE_DINGTALK=true             钉钉总开关
DINGTALK_WEBHOOK / DINGTALK_SECRET
PINTIA_COOKIE                    reliableTodolist 用
```

> ⚠️ **不要**把这些变量挪进 systemd 的 `EnvironmentFile=`。
> `.env` 里有带行尾注释的行（`ENABLE_DINGTALK=true # ...`），
> dotenv 会剥掉注释，而 systemd 不会——会原样读成
> `true # ...` 从而判定为非 true、静默关掉推送。
> 现在依赖 `WorkingDirectory=` + 脚本内 dotenv，已验证可用。

成绩监控的可选参数（都有默认值，当前未在 `.env` 中覆盖）：
`GRADE_STATE_PATH`、`GRADE_MONITOR_START_HOUR`、`GRADE_MONITOR_END_HOUR`、
`GRADE_MONITOR_INTERVAL_SECONDS`、`GRADE_NOTIFY_INITIAL`、`GRADE_CHECK_EVALUATION`。

## 提醒脚本

原 `ddl-reminder.js` 与 `new-todo-reminder.js` 已合并为 `reminders.js`：
一个进程、一次 CAS 登录、一次 `/api/todos`，同时产出「新待办」和「24h/8h/1h 截止」两类提醒。
两个旧文件保留为转发 shim，直接 `node ddl-reminder.js` 仍可用。

```bash
node reminders.js          # 跑一轮
node reminders.js --loop   # 常驻（不依赖 systemd 时用）
```

数据源直接读 `/api/todos` 的结构化 JSON，不再 spawn 子进程并正则解析其
人类可读输出（旧做法依赖 `toLocaleString()`，locale 或 Node 版本一变就静默解析失败）。

状态写在 `.reminder-state.json`（原子写入：临时文件 + rename）。
关键语义：**钉钉发送失败时不标记为已发送**，下一轮会重发——
旧版是无条件落 state，一次网络抖动就能让提醒永久消失。

## 自动评教（需人工执行）

`alt.zju/autojudge.js` 是交互式脚本，**需要 TTY，不要放进 systemd**。

```bash
node alt.zju/autojudge.js --dry-run   # 只列课程，不提交
node alt.zju/autojudge.js             # 交互式提交
```

⚠️ 默认模式会立即向学校提交评教，内容恒为满分且与课程实际教学质量无关，
且没有撤销入口。建议先在 tmux 里跑 `--dry-run` 核对名单。

## 本机 DeskBox 待办同步

`deskbox/` 是**本机 Windows 侧**的工具（不在服务器上跑），把学在浙大的未完成作业
自动写进 DeskBox 待办控件——数据直接从服务器 `.reminder-state.json` 拉，所以服务端
零改动，本机也不需要 ZJU 凭据。

```bash
node deskbox/sync.js --dry-run    # 先看它打算做什么
node deskbox/sync.js              # 同步（有变化才重启 DeskBox）
```

计划任务 `ZJU-DeskBox-Sync` 每 30 分钟一轮，日志在 `deskbox/sync.log`。

完整说明、安全边界和排查表见 **`deskbox/README.md`**。

## 已停用的东西

- `run-new-todo-loop.sh`、`run-todolist-dingtalk.sh`：已被 systemd timer 和
  `reminders.js` 取代，已删除（`run-todolist-dingtalk.sh` 依赖的
  `/tmp/zju-todolist.log` 早已不存在，是死代码）。
- `zju-proxy`（zju-connect）：当前无任何脚本依赖它。
- tmux 会话本身保留，作为临时调试入口，但不再是服务的运行方式。
