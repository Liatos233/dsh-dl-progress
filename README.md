# dsh-dl-progress

在 DSH 界面右下角显示**下载任务名称 + 真实百分比进度条 + 速率 + 剩余时间**的插件。

## 两种进度来源

### 1. 插件自带的 `download_file` 工具（推荐）

插件自己就是下载器：它流式拉取、自己写盘、在写入循环里累加字节数，所以进度**精确到字节**，不受 shell 引号/变量/路径风格影响。

```
download_file(url, path?)
  url   http(s) 下载地址
  path  保存的绝对路径（可选；省略则存到临时目录，按 URL 文件名命名）
```

特点：

- 每 150 ms 刷新一次任务状态 → 百分比是连续涨的
- 速率按 150 ms 窗口算瞬时值，再做指数平滑（`speed = speed*0.7 + inst*0.3`）
- 剩余时间 `etaMs = (total - received) / speed`，`total` 未知时不显示
- 失败立刻标 `failed` 并写入原因（`fetch failed` / `HTTP 404`）
- 单次上限 **8 GB**，超过自动中止
- `path` 必须是绝对路径

### 2. shell 命令的兜底识别

每条 shell 命令在 DSH 里都是一个 host job，job 的 label 就是完整命令。插件订阅 jobs 服务的事件，命中下载特征就建卡：

```
curl -o <path> / curl -O          wget
Invoke-WebRequest -OutFile <path> Start-BitsTransfer -Destination <path>
pip install / npm i / pnpm add / yarn add
git clone / huggingface-cli download / ollama pull
```

能力边界：

- 命令里带**字面 Windows 绝对路径**时 → 每 400 ms `stat` 该文件得到 `received`，用增量算速率，再用 HEAD / Range 探 `total` → 有百分比和 ETA
- 路径是变量（`$dst`）或相对路径 → 只有 `total`（显示「共 X MB」）或跑马灯
- 用 `Invoke-WebRequest` 查接口不会误建卡（必须带 `-OutFile`）

### 3. 约定式进度文件（可选，精度最高）

脚本可自行往 `~/.dsh/download-progress/<id>.json` 写：

```json
{"id":"dl-abc","name":"pkg.zip","received":5242880,"total":10485760,"status":"running","updatedAt":1762899999000}
```

插件读取后按 `id` 合并；同名的 running 任务会被并入，避免同一任务出现两张卡。

## 状态接口

```
GET /dsh-dl-progress/state
→ {"tasks":[{
    "id":"tool-xxx","name":"pkg.zip","status":"running",
    "received":5242880,"total":10485760,
    "speed":1048576,"etaMs":5000
  }],"now":...}
```

- `speed`：字节/秒（指数平滑后的瞬时速率）
- `etaMs`：预计剩余毫秒；`total` 未知或已停止时为 `null`

只读、无鉴权，只暴露任务名与字节数。

## 面板行为

- 固定右下角，无任务时整块隐藏
- 运行中且有速率：

  ```
  big-demo.tgz              31.3 MB/s · 剩 1s
  53.0 MB / 56.7 MB · 94%
  ██████████████████░
  ```

- 有 `total` 但 `received` 为 0 → 「共 X MB」+ 跑马灯
- 两者都没有 → 「进行中」+ 跑马灯
- 完成显示绿色「完成」、失败显示红色「失败」，30 秒后自动消失
- 完成后速率与 ETA 清空

速率格式自动切换：`B/s` → `KB/s` → `MB/s`；剩余时间 <60 秒显示「N 秒」，否则「N 分」或「N 分 M 秒」。

## 实测数据

**54 MB 包（800 ms 采样）**

| 时刻 | 已下载 | 进度 | 速率 | 剩余 |
|---|---|---|---|---|
| 1.6s | 0 | — | — | — |
| 2.4s | 385 KB | 1% | 0.66 MB/s | 81s |
| 3.2s | 8.1 MB | 14% | 10.8 MB/s | 4s |
| 4.0s | 32.2 MB | 57% | 31.3 MB/s | 1s |
| 4.8s | 53.0 MB | 94% | 30.0 MB/s | 0s |
| 5.6s | 56.7 MB | 100% | 清零 | — |

**其他**

```
download_file → npm 元数据        2166 / 2166 字节   done
download_file → dsh-ops 包 8.9MB  9286401 / 9286401 done（磁盘大小一致）
shell: Invoke-WebRequest 查接口  → 不建卡
```

## 已知限制

- **首次 ETA 可能高估**：连接刚建立时首个采样只有几百 KB，算出的剩余时间会偏大，约 1 秒后被指数平滑纠正
- 可达性取决于主机网络（实测 `speed.cloudflare.com` 不可达，npm registry 正常）
- shell 兜底路径无法解析 PowerShell 变量，变量路径没有字节进度
- 面板是自绘 DOM（固定右下角），不参与 DSH 布局；将来有官方状态栏 slot 可以改挂
- 后台任务与前台任务共用 jobs 事件链路，行为一致

## 排错

- 面板不出现：先访问 `http://127.0.0.1:<端口>/dsh-dl-progress/state`，200 说明 host 正常
- 插件在插件列表里显示 `fiberPhase: failed`：看 `diagnostic` 字段，通常是工具 schema 不合法
- 有卡片但一直跑马灯：确认命令里是字面绝对路径，或改用 `download_file`
- 速率显示 `-`：说明还没拿到两个采样点，或 `total` 未知
