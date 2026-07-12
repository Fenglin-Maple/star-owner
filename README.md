# 星藏家

星藏家是一个面向 Bilibili 收藏夹的本地多 Agent 视频知识整理工作台。

**Built with OpenAI Codex.** 用户负责产品方向和真实工作流判断，Codex 参与了架构设计、Electron UI、Agent API、资源调度、GPU ASR 常驻服务、真实视频全流程测试、故障定位和发布工程化。它不是一次性生成的演示页，而是在连续协作中把需求跑成了能接单、能排队、能验收、能预览的桌面系统。

桌面应用负责登录会话、收藏夹同步、任务库存、Worker 身份、工具执行、租约、产物校验、工作库和统计。Codex、Claude Code 或其它外部 Agent 可以通过本地 HTTP API 工作；应用内 Agent 也能使用同一套任务、工具、校验、缓存清理和归档规则持续接单。

> 当前边界：视频知识整理可以由外部 Agent 或用户配置的应用内模型完成。模型供应商是用户自行配置的 OpenAI/NewAPI 兼容接口，应用不会附带或代售模型额度。

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
- “Agent 工具状态”将运行记录、调用统计和 API 快速参考合并展示，可展开查看每次执行、排队、资源通道、命令、日志与错误。
- “Agent 视频总结工作流”可并行运行多个持续接单 Agent，每个会话拥有独立 Worker ID、模型、收藏夹目标、进度和 Token 统计。
- “视频总结（单个）”可直接粘贴 BV 号或视频链接，微调要求并输出到指定目录，同时归档到“内置用户/内置收藏夹”。
- “下载视频”可多次提交 BV 号、完整链接或短链，按队列并行下载合轨视频；公开访问失败且明确需要登录时才暂停等待。
- 内置缓存视频收藏夹可直接在“任务激活”中成为 Agent 工作源，素材工具自动复用已有 `merged.*`，不会重复下载。
- “视频库”提供收藏夹、标题、BV、UP、标签、时长和下载日期筛选，以及本地封面、横竖屏自适应播放器、文件定位、缺失检测和确认删除。
- AI 模型配置由 RAG 知识库助手、持续接单 Agent 和单视频 Agent 共用，支持多个供应商及每个供应商的多个模型。
- 内置多会话 RAG 知识库助手，可连接 OpenAI/NewAPI 兼容供应商，直接检索已验收的收藏夹 Markdown 知识库。
- 从多个账号与收藏夹中选择已完成 Markdown，导出 RAG 目录和机器可读 manifest。
- 首次启动会检查项目内媒体运行时和 ASR 模型；缺失时可从本仓库 GitHub Releases 一键下载、校验并安装，设置页支持重新下载。

## 工作流程

1. 在“B站登录”中登录账号，应用自动同步用户名、头像、Cookie 和收藏夹。
2. 在“收藏夹同步”中读取列表并同步目标收藏夹，应用建立或增量更新任务库存；也可以在“下载视频”中先建立本地缓存库存。
3. 在“任务激活”中选择用户和普通/缓存收藏夹，并将其激活为 Agent 当前工作目标。
4. 新 Agent 会话通过 `/api/workers/register` 上报调用工具和模型，获得应用生成的 Worker ID。
5. Agent 使用 Worker ID 请求 `/api/tasks/claim`，一次领取一个启用任务。
6. Agent 通过任务返回的工具接口准备视频、音频、字幕、关键帧和热评素材。
7. Agent 参考标准模板完成 Markdown 与 `info.json`，清理临时媒体缓存后提交。
8. 应用校验产物。通过则归档到 Workspace；不通过则返回明确错误供 Agent 修正。
9. 用户可在“文档库”中筛选并预览已经完成的 Markdown，也可以在“RAG 知识库助手”中选择账号/收藏夹知识库直接对话分析。
10. “导出”可把选中文档与 manifest 汇总到外部目录，用于其它 RAG 系统。

不想启动外部 Agent 时，也可以在“AI → Agent 视频总结工作流”中新建多个应用内会话。它们会从指定收藏夹持续领取未完成任务，直到库存耗尽或用户暂停。临时处理单个视频时，使用启动页下方的一级入口或“AI → 视频总结（单个）”，选择或新建内置收藏夹、指定外部输出目录并启动即可。

## 桌面导航

左侧栏使用一级菜单与可展开的二级菜单，收起侧边栏后页面会重新分配宽度，列表、图表和工作区随内容区域一起扩展：

- “启动页”显示后端启动进度、工具在线状态、快速上手和最近状态；
- “视频总结（单个）”与“下载视频”是常用一级入口；
- “工作准备”包含 B站登录、收藏夹同步和任务激活；
- “AI”包含 RAG 知识库助手、Agent 视频总结工作流、视频总结（单个）和共享 AI 模型配置；
- “状态查询”包含 Agent 工作列表、Agent 工具模块和 Agent 工具状态；
- “文件浏览”包含视频库、文档库和导出；
- 设置与 README 固定在侧边栏底部。

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

保存返回的 `workerId`，后续领取、心跳、工具执行、取消、提交和中止上报都必须携带它。Worker ID 由应用生成，Agent 不应自行命名。

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

当前任务因错误、用户要求或其它原因无法继续时，Agent 必须说明原因并让应用中止本次尝试：

```http
POST /api/tasks/<taskId>/abort
Content-Type: application/json

{
  "workerId": "worker-...",
  "reason": "无法继续工作的具体问题、发生步骤和可排查原因"
}
```

应用会取消该任务仍在排队或运行的工具、删除本次尝试产生的文件、清空领取与完成字段，并把任务恢复为未领取的 `pending`。下次领取会从头创建素材，不使用断点。旧版 `/fail` 仍是兼容别名，但行为同样是完整回滚，不会保留 `failed` 半成品。

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
| `clean-cache` | 删除临时音视频缓存；缓存库任务和显式保留选项会保留根目录合轨视频 |

工具由应用进程启动并记录日志。Agent 不应绕过 API 直接运行项目脚本。工具请求立即返回 HTTP `202`，之后通过运行接口轮询 `queued -> running -> succeeded/failed/cancelled/timeout`；排队响应包含资源池、阶段、队位、等待原因和预计等待时间。

项目将 FFmpeg（通过 `imageio-ffmpeg` 固定轮子）与 yt-dlp 固定安装到 `runtime/faster-whisper`，不依赖系统 PATH，也不在 `npm ci` 时运行第三方 Python 检查或下载媒体工具。faster-whisper 使用 `runtime/python` 下的 CPython 3.12、同一个项目虚拟环境，以及 `runtime/models/small` 和 `runtime/models/medium` 两个内置模型。CUDA 12 的 cuBLAS/cuDNN 也安装在该环境。

重新部署完整 ASR 运行时：

```powershell
npm run setup:asr
```

该运行时和模型约占用 3.8GB，均位于项目 `runtime/` 目录。`FASTER_WHISPER_BIN` 仍可用于显式覆盖默认执行器。

### 资源池与常驻 ASR

- `api`：2 条通道，启动间隔默认 850ms，降低 Bilibili API 突发请求和 412 风险。
- `media`：3 条通道，统一承载 yt-dlp 下载、合轨、音频提取和关键帧处理；缓存下载管理器最多并行提交 3 个任务。
- `disk`：2 条通道，负责缓存清理等磁盘操作。
- `asr`：1 条常驻 CUDA `float16` 通道；设置页可手动开启第 2 条 CPU `int8` 通道。

GPU ASR 在应用启动时默认加载多语言 `medium` 模型，在准确率、速度与 8GB 笔记本显存之间取得更均衡的效果；设置页可在 ASR 队列空闲时切换到更快、更省显存的 `small` 模型。切换会安全重启 GPU/CPU 常驻服务，转写或排队期间不会强制中断。服务直接启动项目内真实 CPython，并优先加载 `runtime/vc-runtime` 中随项目提供的 Microsoft Visual C++ 运行库，避免 Windows venv 启动器或电脑全局 DLL 版本破坏常驻服务。原生启动失败采用最长 60 秒的指数退避，不会被多个排队任务反复拉起刷屏。标准 16kHz PCM 音频按 10 秒临时 WAV 分块推理，分块立即删除，并持续回传进度。调度器通过 `nvidia-smi` 检查空闲显存，默认保留 1024MiB；低于阈值时新请求继续排队并返回 `GPU_CAPACITY_WAIT`。CPU ASR 默认关闭，不占用内存；关闭 CPU 开关时，正在执行的 CPU 请求会完成，但不再接收新任务，空闲后服务退出。

查看实时资源状态：

```text
GET http://127.0.0.1:17391/api/scheduler
```

应用重启时，未完成的视频总结任务不会恢复旧工具或断点：应用会取消遗留运行记录、清理本次目录并将任务退回 `pending`。下载视频等不属于已领取总结任务的独立队列仍可恢复调度。工具排队和运行期间，应用自动保护其父任务的 15 分钟租约；租约超时且已无活跃工具时也执行同一套完整回滚。

## Workspace

项目默认工作库为：

```text
<project>/workspace
```

用户可以在“设置”中添加多个 Workspace，但必须指定一个默认库。新任务使用当前默认库，切换默认库不会移动或删除已有成果。

缓存视频同样登记在 SQLite，并固定保存在 `<workspace>/内置用户/<缓存收藏夹>/视频缓存/`。同一收藏夹内的同一 BV 只允许一个活跃下载任务，避免多个任务同时写入同一个视频目录。默认“内置视频缓存”收藏夹受保护且不能删除，其它缓存收藏夹删除前必须确认，并只会删除通过托管根目录校验的视频目录。

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

## RAG 知识库助手

“RAG 知识库助手”是面向本地视频知识库的多会话 Agent 工作台。它不复制第二份知识库：可选范围直接来自已经通过应用验收、且 Markdown 文件仍存在的任务，并按 Bilibili 用户与收藏夹分组。左上角铅笔按钮直接跳转到统一的“AI 模型配置”，新建会话使用其下方的明确文字按钮。

- 供应商：支持 OpenAI-compatible 与 NewAPI-compatible 的 `/models`、`/chat/completions` 接口；当用户填写服务根域名时会自动探测并记住 `/v1` 兼容根路径。API Key 由主进程保存，渲染层不会读取明文。
- 模型：每个供应商可以拉取并多选启用多个模型，并为每个模型分别记录上下文窗口、最大输出 Token、工具、推理流、视觉、音频、图片返回、压缩和子 Agent 能力。未知现代模型默认使用 1M 上下文/128K 输出，GPT-5/Codex 默认使用 400K/128K，均可手动覆盖。
- 对话：支持多个持久化会话、流式正文、供应商返回的推理字段、工具状态、当前上下文占比、手动上下文压缩和按模型累计 Token 统计。输入栏右下角可直接切换当前会话的供应商与模型。推理区只在供应商实际返回 `reasoning_content`、`reasoning` 或 `thinking` 时出现；普通模型只显示一条助手回复状态。
- 会话设置：默认收起，通过聊天标题栏设置按钮打开弹窗；可修改会话名称、模型、知识库、沙盒和权限。右键会话可直接编辑或二次确认删除。
- 知识库：可在一个会话中多选多个账号/收藏夹；支持工具调用的模型除 `knowledge_search` 外，还能列出选中知识库的原始文档、按行逐字读取完整 Markdown。读取采用分页和上下文预算，不会用摘要冒充原文，也不会把整个收藏夹一次性塞进模型请求。不支持工具调用的模型仍只会收到应用预检索的相关片段。
- 知识库图片：开启模型“视觉”能力后，助手可按文档读取最多四张原始本地图片并作为多模态输入直接查看。应用在工具记录中展示这些原图；模型也可使用工具返回的安全图片 URI，把已查看图片嵌入回答。图片 URI 只能解析当前会话已选择知识库内仍存在的文件。
- 附件：文本、Markdown、JSON、CSV、代码、PDF 和 DOCX 会提取文字；兼容模型可接收图片和音频。视频及其它不属于标准兼容接口输入的文件保留在会话沙盒中供文件工具处理。
- Agent 工具：可列出、读取、写入会话文件，执行 CMD，使用内置不可见浏览器检索/读取网页，调用系统默认浏览器，以及在模型支持时发起隔离的子 Agent 调用。
- 权限：每个会话拥有独立沙盒。有限权限下，沙盒外路径、CMD、私网浏览和打开默认浏览器会弹窗审批；完全访问模式允许访问沙盒外路径并减少审批。

能力开关描述“允许应用向该模型发送什么”，不保证远程模型一定实现相应协议。推理链、图片输出、音视频输入、工具调用、上下文压缩和子 Agent 均以供应商实际返回与模型能力为准。为避免误泄露资料，只有用户在当前会话中选择的知识库和附件才会发往配置的远程模型供应商。

## Agent 工作流与单视频总结

“AI 模型配置”是三类 AI 功能共用的模型中心。用户可以保存多个 OpenAI-compatible 或 NewAPI-compatible 供应商，拉取模型列表，启用多个模型，并分别声明上下文窗口、最大输出、工具、推理流和视觉等能力。供应商输出值只是模型未单独配置时的默认值，不等于上下文窗口。API Key 由主进程加密保存；视频总结 Agent 和 RAG 知识库助手读取同一份配置与按模型 Token 统计。对话历史按模型上下文预算动态装载，不再固定截断为 40 条。

“Agent”栏目用于收藏夹批处理。每个会话绑定一个模型、一个收藏夹和一个由应用生成的 Worker ID，可同时启动多个会话并行工作。应用内 Agent 使用与外部 Agent 相同的 15 分钟租约、资源池排队、素材工具、Markdown 模板、提交校验、缓存清理、最终命名和工作绩效记录；暂停可以等待当前单完成，立即停止则取消当前工具、删除本次缓存并把任务恢复为未领取未完成。应用正常退出、意外退出后的启动恢复、租约超时和 Agent 自身错误使用相同回滚规则。

资源等待与基础设施故障会被区别处理：显存暂时不足、API 限速等可恢复状态继续排队；ASR 常驻服务连续原生崩溃等不可恢复状态会终止相关工具队列、清除当前尝试、暂停 Worker、把当前视频退回待领取，并让内置 Agent 在自己的输出区报告中断步骤、错误、可能原因和处理建议。外部 Agent 无法继续时应调用 `/abort` 上报同类信息；其下次任务申请若收到 `stop-and-report` 指令及原因，不应继续领取其它视频。

“视频总结（单个）”不要求先从 Bilibili 收藏夹导入任务：

1. 粘贴 BV 号或视频链接；
2. 选择模型以及“内置用户”下的内置收藏夹，也可以现场新建收藏夹；
3. 选择关键帧数量、热评数量并填写额外要求；
4. 必须指定一个外部输出目录，然后启动任务；
5. 可选择“处理完成后保留缓存视频到视频文件夹”，默认关闭；未启用任何远程模型时启动按钮不可点击；
6. 应用第一次强制不携带 Cookie，优先尝试公开获取视频与元数据；只有工具明确返回登录、注册用户、私有视频或 Cookie 必需信号时，才进入“等待登录”并弹窗提供 B站登录跳转；
7. 登录完成后回到单视频页面点击“开始/继续”，应用同步新的 Cookie 并重试；
8. 界面流式显示模型推理字段、正文、阶段、进度、日志和 Token；
9. 通过校验后，完整视频产物先归档到默认 Workspace 的 `内置用户/<内置收藏夹>/`，再复制一份到指定外部目录。

内置用户和内置收藏夹使用普通知识库索引。即使还没有 Markdown，文档库和导出也会显示内置用户及收藏夹，并标注 `0 篇`；完成后产物自动进入普通筛选。RAG 知识库助手只选择有可检索 Markdown 的知识库。单视频任务仍会执行独立 ASR、字幕比较、关键帧、热评、清缓存和结构校验，不是简化质量要求的旁路。

## 视频缓存队列与视频库

“下载视频”不依赖 AI 模型。每次提交必须选择一个内置缓存视频收藏夹，可现场新建；输入支持 BV 号、普通视频链接和 Bilibili 短链。视频固定保存到所选收藏夹的应用托管目录，不提供任意外部输出路径。下载管理器先读取公开元数据并缓存封面，再通过应用工具队列下载 720p 以内的合轨视频，保存标题、UP、时长、标签、发布时间、画面尺寸、下载时间和文件位置。只有明确需要登录时才暂停并弹出登录入口，登录后可一次恢复全部等待项。

缓存收藏夹会出现在“任务激活”的内置用户下。激活后，内外部 Agent 领取到的是普通任务协议，但任务额外带有 `cachedVideoId`、`cachedVideoFile` 和 `reuseCachedMedia`。素材包直接复用缓存视频，ASR、字幕、关键帧和评论仍按完整总结标准执行。Agent 仍调用 `clean-cache`；任务中止时，应用保留已登记的合轨视频、封面、`info.json` 和 `cache-record.json`，删除本次生成的音频、ASR、字幕、关键帧、评论、草稿和工具日志。

“文件浏览 → 视频库”使用自定义主题播放器，不启用浏览器原生 controls。封面优先读取视频目录中的本地文件，现有记录可回退到任务元数据中的 Bilibili HTTPS 封面；缩略图完整显示而不裁切。播放器根据媒体真实宽高切换横屏或竖屏布局，竖屏视频保持原始比例居中完整展示。列表中的 BV 号支持左键通过默认浏览器打开原视频、右键复制纯 BV 号并显示角落提示。列表会实时标记缓存文件是否存在，支持按缓存收藏夹、标题/BV/UP/标签、时长和下载日期筛选。可在资源管理器中定位单个视频；多选删除和收藏夹删除均需要确认。默认“内置视频缓存”收藏夹不可删除，后端还会校验登记根目录，避免删除到缓存目录以外。

## 任务与 Worker 管理

- 任务可以单独或批量启用、关闭；关闭任务不会再被派发。
- 领取顺序默认按收藏时间从新到旧。
- 同步收藏夹时保留已有任务的完成状态、启用状态和历史记录。
- 每个 Worker 独立记录调用工具、模型、当前任务、最后活动时间和绩效。
- 用户可在“Agent 工作列表”中暂停或重新激活 Worker。
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

普通用户只需从 GitHub Release 下载并解压 `Star-Owner-v<version>-win-x64-core.zip`，然后双击 `Start-StarOwner.cmd`。应用首次启动会检查项目内的媒体/ASR 运行时以及内置 `small`、`medium` 模型；若缺失，会弹窗询问是否从本仓库 Release 自动下载对应资产。下载、SHA-256 校验、路径安全检查和解压进度都在应用内显示，也可在“设置 → 项目依赖包”稍后下载或重新安装。

Release 提供 `Star-Owner-v<version>-runtime-win-x64.zip`、`Star-Owner-v<version>-model-small.zip` 和 `Star-Owner-v<version>-model-medium.zip`。所有压缩包内部都保留从项目根目录开始的 `runtime/...` 相对路径。GitHub 单文件上限为 2GB，因此大型运行时和模型不放进 Git 仓库，也不要求用户手工拼装超大单体包。便携核心包可继续预装基础运行时；缺失或损坏时应用会按相同资产执行修复。

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
npm run test:rag
npm run test:internal-agent
npm run test:scheduler
npm run test:video-cache
npm run test:security
npm run test:persistence
npm run test:collection-sync
```

## 项目结构

```text
src/main.js                 Electron 主进程、IPC、窗口和导出
src/preload.js              安全的渲染层桥接
src/core/store.js           SQLite 持久化与 Worker/任务记录
src/core/api-server.js      收紧后的本地 Agent API 与任务生命周期
src/core/collection-sync-service.js  收藏夹同步与任务索引
src/core/submission-artifacts.js     内外部 Agent 共用的产物归档
src/core/network-policy.js           URL、跨域与私网策略
src/core/desktop-security.js         Electron/WebView 安全边界
src/core/atomic-file.js              SQLite 可恢复写入
src/core/tool-runner.js     受控工具进程、超时、日志和取消
src/core/analytics.js       收藏夹、Worker 和工具统计
src/core/bili.js            Bilibili 会话与收藏夹接口
src/core/rag-assistant.js   RAG 会话、兼容模型、检索、工具与权限
src/core/internal-agent-manager.js  应用内持续 Agent、单任务与统一验收
src/core/dependency-manager.js      Release 依赖检查、下载、校验与安装
src/renderer/               桌面 UI
templates/                  Agent 参考模板
runtime/                    项目内 Python、VC++ 运行库、faster-whisper、CUDA DLL 和模型
workspace/                  默认数据库、Cookie 和工作产物
DESIGN.md                   完整设计与实现约束
DEPLOYMENT.md               人类、Agent 与 GitHub Release 部署指南
CODE_REVIEW.md              安全与可维护性审查记录
THIRD_PARTY_NOTICES.md      第三方组件、模型与许可证清单
```

更详细的架构、状态机和安全边界见 [`DESIGN.md`](DESIGN.md)。

本地 Agent API 只接受无浏览器 `Origin` 的本机进程请求或同源请求，不开放通配 CORS；JSON 请求体限制为 1 MiB。Bilibili WebView 运行在沙箱中，只允许 Bilibili 官方域名且禁止弹窗。保存账号密码或模型 API Key 时，如果系统 `safeStorage` 不可用，应用会拒绝保存，不会明文回退。完整审查记录与残余风险见 [`CODE_REVIEW.md`](CODE_REVIEW.md)。

## 开源许可

项目自有代码采用 [`GPL-3.0-or-later`](LICENSE)。FFmpeg、Electron、Mermaid、yt-dlp、faster-whisper、模型、Microsoft Visual C++ 运行库和 NVIDIA 运行库各自保留上游许可；其中 Microsoft VC++ 与 NVIDIA CUDA/cuDNN 是专有可再分发运行库，并非开源软件。发布二进制前必须阅读 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 并履行 FFmpeg 对应源码义务。

请勿把 `workspace/`、Cookie、账号信息、SQLite 数据库、日志、下载视频或本机快捷方式提交到 GitHub。
