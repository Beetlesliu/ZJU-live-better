# 学在浙大作业 → DeskBox 待办同步

把学在浙大（courses.zju.edu.cn）的未完成作业自动写进本机 DeskBox 的待办控件。

```
学在浙大 ──(reminders.js 每 10 分钟)──► 服务器 .reminder-state.json
                                              │
                                    ssh 免密拉取 │ 本机每 30 分钟
                                              ▼
                                    DeskBox todo.json ──► 桌面控件
```

## 为什么是这样的架构

**数据从服务器拉，不在本机登录学在浙大。** 服务器上 `zju-reminders.timer` 已经每
10 分钟登录一次并刷新 `.reminder-state.json`，里面 `title / course / ddlIso / url`
四个字段齐全。本机直接取这个文件即可——不用在本机放 ZJU 凭据，也不会多出一个 CAS
登录源（学在浙大 429 限流是账号级的，登录源越少越好）。

服务器端**不需要任何改动**。

## 为什么写入要重启 DeskBox

DeskBox 没有对 `todo.json` 挂 `FileSystemWatcher`。控件内容只在三个时机从磁盘读：
创建控件、应用启动、点击待办通知。之后就一直是内存副本，任何编辑都会把**整个列表**
回写。所以运行期间的外部写入既看不到、又会在下次编辑时被覆盖。

唯一可靠的落地方式是 **关闭 → 写入 → 重新启动**。为了不无谓打扰：

- 只在**真的有变化**时才写入和重启（新增/更新/移除/交还皆为 0 时脚本直接退出）
- 重启走的是 DeskBox 自己的计划任务，启动参数和你登录时完全一致
- 关闭优先请求优雅退出；挂件类应用通常没有主窗口，此时直接结束进程

> ⚠️ **已知代价**：强制结束进程时若 DeskBox 正在做大文件搬运（它自带文件整理
> 功能，实测搬一个目录要几分钟），可能打断该次搬运。改动本身是磁盘操作、不受影响。
> 同步只在作业列表变化时才触发（大约每周几次），撞上的概率不高。
> 需要完全避免的话：`Disable-ScheduledTask -TaskName "ZJU-DeskBox-Sync"` 临时停掉，
> 手动跑 `node deskbox/sync.js --no-restart` 即可。

## 安全边界

脚本**只碰自己创建的条目**，这条边界是硬性的：

| 情况 | 行为 |
| --- | --- |
| 你自己在 DeskBox 里加的待办 | **永远不动**（id 不在状态文件里就完全不碰） |
| 同步进去的条目，你勾了完成 | 识别为「交还」，保留你的完成状态，此后**再也不动它** |
| 同步进去的条目，学校那边已提交/消失 | 从 DeskBox 移除 |
| 同步进去的条目，截止时间被学校改了 | 更新截止时间，保留你的提醒状态（不会重复弹通知） |

写入前后都会回读校验，改动前留一份 `todo.json.zju-sync-backup` 可手工还原。

## 用法

```bash
node deskbox/sync.js                # 正常同步（有变化才重启 DeskBox）
node deskbox/sync.js --dry-run      # 只报告将发生什么，不写盘不重启
node deskbox/sync.js --no-restart   # 写盘但不重启（下次 DeskBox 启动才可见）
node deskbox/sync.js --force        # 没有变化也强制写盘 + 重启
node deskbox/sync.js --quiet        # 无变化时不输出（计划任务用）
```

### 自动运行

计划任务 **`ZJU-DeskBox-Sync`**，每 30 分钟一轮，通过 `run-hidden.vbs` 静默调用
（直接用 node.exe 当动作会每轮闪一次控制台黑框）。

```powershell
Get-ScheduledTaskInfo -TaskName "ZJU-DeskBox-Sync"   # 看上次结果和下次时间
Start-ScheduledTask   -TaskName "ZJU-DeskBox-Sync"   # 立刻跑一轮
Disable-ScheduledTask -TaskName "ZJU-DeskBox-Sync"   # 临时停用
```

> **注意**：注册时用的是「重复触发器 + `StartWhenAvailable`」而不是登录触发器——
> 当前账号不是管理员，而 `-AtLogOn` 触发器需要管理员权限（会直接报「拒绝访问」）。
> `StartWhenAvailable` 会在开机后补跑错过的实例，效果等同。

日志在 `deskbox/sync.log`（超过 1MB 自动轮转一次）。因为带了 `--quiet`，
**没发生任何事的时候不写日志**，所以这个文件就是一份干净的变更审计记录。

## 同步进去的条目长什么样

- **标题**：`第1次作业（计量经济学）`——带上课程名，否则不同课程的同名作业分不清
- **截止时间**：学在浙大的 DDL，DeskBox 会在截止前 5 分钟弹 Windows 原生通知
  （沿用你 `todoReminderEnabled=true` / `todoDefaultReminderOffsetMinutes=5` 的设置，
  和钉钉推送互为备份）
- **排序**：作业按 DDL 从近到远排在最前，你自己的待办保持原有相对顺序跟在后面
- **备注**：一个直达学在浙大对应作业的链接

条目 id 是作业 URL 的 md5，固定不变——所以反复同步只会更新同一批条目，不会重复堆积。

## 排查

```bash
node deskbox/sync.js --dry-run     # 先看它打算做什么
```

| 报错 | 原因 |
| --- | --- |
| `快照已过期 N 分钟` | 服务器上 `zju-reminders.timer` 没在跑。`ssh root@124.223.111.42 systemctl status zju-reminders.timer` |
| `SSH 拉取失败` | 本机到服务器的免密登录失效。`ssh -o BatchMode=yes root@124.223.111.42 echo ok` |
| `找不到 ...settings.json` | DeskBox 没装或没运行过 |
| `没有启用中的待办控件` | DeskBox 里待办控件被禁用了 |
| `DeskBox 自动重启失败` | 待办已写入磁盘，没丢数据，手动打开 DeskBox 即可 |

`.sync-state.json` 记录「哪些条目是本脚本同步进去的」，删掉它不会误删你的待办，
但会让脚本失去对已有同步条目的跟踪（它们会变成「你自己的待办」而不再被更新）。
