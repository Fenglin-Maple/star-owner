# 星⭐收藏家

星⭐收藏家是一个面向 Bilibili 收藏夹的本地多 Agent 视频知识整理工作台。

**Built with OpenAI Codex.** 用户负责产品方向和真实工作流判断，Codex 参与了架构设计、Electron UI、Agent API、资源调度、GPU ASR 常驻服务、真实视频全流程测试、故障定位和发布工程化。它不是一次性生成的演示页，而是在连续协作中把需求跑成了能接单、能排队、能验收、能预览的桌面系统。

桌面应用负责登录会话、收藏夹同步、任务库存、Worker 身份、工具执行、租约、产物校验、工作库和统计；Codex、Claude Code 或其它 Agent 通过本地 HTTP API 领取单个视频任务，调用应用托管的媒体工具，并提交结构化 Markdown。

> 当前边界：应用负责“准备任务、执行工具、校验和收集成果”，不会在主进程中自动替代 Agent 撰写视频总结。

## 核心能力

- 使用独立持久化 WebView 登录 Bilibili，不复用系统浏览器登录态。
- 启动时实际调用每个工具的健康探针，并显示在线、部分可用或离线状态。
- 同步指定账号的收藏夹，并保留 BV 号、标题、UP 主、时长、发布时间和收藏时间等信息。
- 在桌面端选择并激活当前工作的账号与收藏夹。
- 多个 Agent 并行领取任务，每个新会话由应用分配独立 Worker ID。
- 任务使用 15 分钟租约，Agent 可通过心跳续期；超时任务自动回到可领取状态。
- Agent 通过 API 请求应用执行下载、ASR、关键帧、评论和缓存清理工具。
- 应用校验 Markdown、`info.json`、图片引用和必需章节，合格后才将任务标记完成。
- 文档以“小结 → 思维导图 → 目录”开头，应用使用项目内 Mermaid 离线渲染思维导图。
- 按 Worker ID 独立统计领取量、完成量、成功率、时长权重和工具调用。
- 从多个账号与收藏夹中选择已完成 Markdown，导出 RAG 目录和机器可读 manifest。

## 工作流程

1. 在“B站登录”中登录账号，应用自动同步用户名、头像、Cookie 和收藏夹。
2. 在“收藏夹”中读取列表并同步目标收藏夹，应用建立或增量更新任务库存。
3. 在“任务”中选择用户和收藏夹，并将其激活为 Agent 当前工作目标。
4. 新 Agent 会话通过 `/api/workers/register` 上报调用工具和模型，获得应用生成的 Worker ID。
5. Agent 使用 Worker ID 请求 `/api/tasks/claim`，一次领取一个启用任务。
6. Agent 通过任务返回的工具接口准备视频、音频、字幕、关键帧和热评素材。
7. Agent 参考标准模板完成 Markdown 与 `info.json`，清理临时媒体缓存后提交。
8. 应用校验产物。通过则归档到 Workspace；不通过则返回明确错误供 Agent 修正。
9. 用户可在“文档库”中筛选并预览已经完成的 Markdown，再从“导出”汇总文档建立后续 RAG 知识库。

## Agent 快速接入

默认 API 地址：

```text
http://127.0.0.1:17391
```

先读取统一接口清单：

```http
GET /api/manifest
```

查看本次启动的工具接口检查结果：

```http
GET /api/tool-health
```

每个全新 Agent 会话注册一次：

```http
POST /api/workers/register
Content-Type: application/json

{
  "tool": "codex",
  "model": "实际模型名称",
  "sessionLabel": "可选会话备注"
}
```

保存返回的 `workerId`，后续领取、心跳、工具执行、取消、提交和失败上报都必须携带它。Worker ID 由应用生成，Agent 不应自行命名。

桌面端已激活收藏夹后领取任务：

```http
POST /api/tasks/claim
Content-Type: application/json

{
  "workerId": "worker-..."
}
```

- 返回 `NO_TASK`：当前没有可领取任务，可以正常结束。
- 返回 HTTP `423` 和 `WORKER_PAUSED`：用户已暂停该 Worker，停止继续申请新任务。
- 已领取任务应在 15 分钟内发送心跳，并严格使用返回的 `artifactDir`。

完整协作提示词可在应用“启动页”的“快速上手”中复制。

## 文档产物要求

标准模板位于 [`templates/video-summary-template.md`](templates/video-summary-template.md)，也可以通过以下接口获取：

```http
GET /api/templates/video-summary
```

视频总结至少包含：

- 结论优先的小结；
- 紧随小结的 Mermaid 思维导图；
- 可点击的目录；
- 带 Bilibili 时间轴链接的正文目录与章节；
- 完整的新闻、技术、经验、方法、限制和时效性说明；
- 精选关键帧及其用途说明；
- Bilibili 字幕与本次 ASR 字幕的比较和选择依据；
- 可获取时的热评前三条分析；
- Worker、模型、工具、字幕选择和缓存清理记录。

无论视频是否存在站内字幕，都必须运行一次 ASR。若字幕优劣无法判断，可结合关键帧和 Agent 的多模态能力校正专有名词与语义。

提交校验会拒绝缺少 Mermaid fenced code block，或没有按“小结 → 思维导图 → 目录”排列的文档。文档库使用随项目打包的 Mermaid，不依赖 CDN；历史文档中的思维导图在预览时也会提升到目录前显示。

## 应用托管工具

| 工具 | 用途 |
| --- | --- |
| `video-info` | 获取视频完整元数据并生成 `info.json` |
| `material-bundle` | 一次准备下载、字幕、ASR、关键帧、评论等主要素材 |
| `merged-video` | 下载并生成音视频合轨的可播放视频 |
| `asr` | 使用 faster-whisper 生成独立语音字幕 |
| `bili-subtitles` | 提取各分 P 的站内人工/自动字幕；按视频时长和最低覆盖率拒绝串线或残缺资源，无可用字幕时写入空索引并保留拒绝原因 |
| `comments-top3` | 获取热评前三条供评论分析 |
| `clean-cache` | 删除临时音视频缓存，保留 Markdown、图片、字幕和 JSON |

工具由应用进程启动并记录日志。Agent 不应绕过 API 直接运行项目脚本。工具请求立即返回 HTTP `202`，之后通过运行接口轮询 `queued -> running -> succeeded/failed/cancelled/timeout`；排队响应包含资源池、阶段、队位、等待原因和预计等待时间。

项目通过 npm 自带 FFmpeg 和 yt-dlp，不依赖系统 PATH。faster-whisper 使用 `runtime/python` 下的 CPython 3.12、`runtime/faster-whisper` 虚拟环境，以及 `runtime/models/small` 和 `runtime/models/large-v3-turbo` 模型。CUDA 12 的 cuBLAS/cuDNN 也安装在同一虚拟环境。

重新部署完整 ASR 运行时：

```powershell
npm run setup:asr
```

该运行时和模型约占用 3.8GB，均位于项目 `runtime/` 目录。`FASTER_WHISPER_BIN` 仍可用于显式覆盖默认执行器。

### 资源池与常驻 ASR

- `api`：2 条通道，启动间隔默认 850ms，降低 Bilibili API 突发请求和 412 风险。
- `media`：2 条通道，统一承载 yt-dlp 下载、合轨、音频提取和关键帧处理。
- `disk`：2 条通道，负责缓存清理等磁盘操作。
- `asr`：1 条常驻 CUDA `float16` 通道；设置页可手动开启第 2 条 CPU `int8` 通道。

GPU ASR 在应用启动时默认加载多语言 `small` 模型，后续任务复用同一进程；`large-v3-turbo` 作为本地高质量备选保留。服务直接启动项目内真实 CPython，避免 Windows venv 启动器破坏常驻 stdin/stdout 管道。标准 16kHz PCM 音频按 10 秒临时 WAV 分块推理，分块立即删除，并持续回传进度。调度器通过 `nvidia-smi` 检查空闲显存，默认保留 1024MiB；低于阈值时新请求继续排队并返回 `GPU_CAPACITY_WAIT`。CPU ASR 默认关闭，不占用内存；关闭 CPU 开关时，正在执行的 CPU 请求会完成，但不再接收新任务，空闲后服务退出。

查看实时资源状态：

```text
GET http://127.0.0.1:17391/api/scheduler
```

应用重启时，SQLite 中处于排队或运行状态的工具调用会恢复入队。工具排队和运行期间，应用自动保护其父任务的 15 分钟租约。

## Workspace

项目默认工作库为：

```text
<project>/workspace
```

用户可以在“设置”中添加多个 Workspace，但必须指定一个默认库。新任务使用当前默认库，切换默认库不会移动或删除已有成果。

单个视频的产物结构：

```text
<workspace>/
  <Bilibili 用户名>/
    <收藏夹名>/
      [BV-...][标题-...][UP-...][发布日-...][收藏日-...][来自收藏夹-...][标签-...]/
        [BV-...][标题-...][UP-...][发布日-...][收藏日-...][来自收藏夹-...][标签-...].md
        info.json
        frames/
        asr/
        comments/
        tool-runs/
```

目录和 Markdown 默认使用同一个元数据名称。设置页可分别关闭 BV 号、标题、UP 主、发布日期、收藏日期、来源收藏夹和标签；发布日与收藏日使用不同字段名，不会混淆。收藏夹快速同步不逐条请求标签，应用会在 Agent 提交时读取 `info.json`，补齐标签后整理最终目录和 Markdown 文件名。设置变更用于新验收产物，不会擅自移动已有知识库。

SQLite 数据库位于 `workspace/orchestrator.sqlite`。Agent 不直接读写数据库、索引、配置或工作库注册信息。

## Markdown 文档库

“文档库”只索引已经通过应用验收且仍存在输出路径的任务。可按账号和收藏夹切换，搜索 BV 号、UP 主或标题，并组合使用收藏日期、发布日期和视频时长筛选。排序支持收藏时间或发布时间的正序与倒序。

列表筛选只读取 SQLite 轻量索引；选择一篇后才读取 Markdown 正文。预览支持本地关键帧、表格、代码、引用和网页链接，时间轴链接交给系统默认浏览器打开，也可以直接用本机默认 Markdown 应用打开原文件。

## 任务与 Worker 管理

- 任务可以单独或批量启用、关闭；关闭任务不会再被派发。
- 领取顺序默认按收藏时间从新到旧。
- 同步收藏夹时保留已有任务的完成状态、启用状态和历史记录。
- 每个 Worker 独立记录调用工具、模型、当前任务、最后活动时间和绩效。
- 用户可在“工作 Agent”中暂停或重新激活 Worker。
- 暂停只阻止下一次任务分配，不会阻止已领取任务发送心跳或提交成果。

## RAG 导出

“导出”栏目只读取已经通过校验的完成任务。导出队列可跨用户和收藏夹保存选择，并支持将以下元数据加入文件名：

- BV 号；
- 视频标题；
- UP 主；
- 来源收藏夹；
- 发布日期；
- 收藏日期；
- 标签。

每次导出还会生成 `star-owner-rag-manifest-<timestamp>.json`，记录源账号、收藏夹、视频链接、时间信息、源 Markdown 和导出文件路径。导出不会删除或移动 Workspace 中的原始产物。

## 下载与部署

普通用户从 GitHub Release 下载 `Star-Owner-v<version>-win-x64-core.zip` 和 `Star-Owner-v<version>-model-small.zip`。先解压核心包，再把模型包解压到核心包根目录；模型包已经带有 `runtime/models/small` 相对目录。完成后双击 `Start-StarOwner.cmd`。这两个资产合起来包含 Electron、Mermaid、FFmpeg、yt-dlp、Python、faster-whisper、CUDA 运行库和默认模型，不需要再次安装或联网拉取工具。

GitHub 单文件上限为 2GB，而当前 Windows 单体 `small` 便携包实测约 2.05GiB，因此官方 GitHub 发布使用核心包与模型包分离。构建脚本仍支持生成单体包，供网盘或其它允许大文件的渠道使用。

完整的人类部署、Agent 接入、便携包构建和 GitHub 发布步骤见 [`DEPLOYMENT.md`](DEPLOYMENT.md)。Agent 与代码贡献者规则见 [`AGENTS.md`](AGENTS.md)。

## 从源码运行

源码开发需要 Node.js 22+、npm 和 `uv`。所有媒体运行时仍安装到项目自己的 `runtime/`，不会污染系统 Python。

```powershell
npm ci
npm run setup:asr
npm run verify:release
npm start
```

烟雾测试：

```powershell
npm run smoke
```

## 项目结构

```text
src/main.js                 Electron 主进程、IPC、窗口和导出
src/preload.js              安全的渲染层桥接
src/core/store.js           SQLite 持久化与 Worker/任务记录
src/core/api-server.js      本地 Agent API 与任务生命周期
src/core/tool-runner.js     受控工具进程、超时、日志和取消
src/core/analytics.js       收藏夹、Worker 和工具统计
src/core/bili.js            Bilibili 会话与收藏夹接口
src/renderer/               桌面 UI
templates/                  Agent 参考模板
runtime/                    项目内 Python、faster-whisper、CUDA DLL 和模型
workspace/                  默认数据库、Cookie 和工作产物
DESIGN.md                   完整设计与实现约束
DEPLOYMENT.md               人类、Agent 与 GitHub Release 部署指南
THIRD_PARTY_NOTICES.md      第三方组件、模型与许可证清单
```

更详细的架构、状态机和安全边界见 [`DESIGN.md`](DESIGN.md)。

## 开源许可

项目自有代码采用 [`GPL-3.0-or-later`](LICENSE)。FFmpeg、Electron、Mermaid、yt-dlp、faster-whisper、模型和 NVIDIA 运行库各自保留上游许可；其中 NVIDIA CUDA/cuDNN 是专有可再分发运行库，并非开源软件。发布二进制前必须阅读 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 并履行 FFmpeg 对应源码义务。

请勿把 `workspace/`、Cookie、账号信息、SQLite 数据库、日志、下载视频或本机快捷方式提交到 GitHub。
