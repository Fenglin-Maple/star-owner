# 星藏家

星藏家是一个面向 Bilibili 收藏夹的本地视频知识整理桌面应用。它负责收藏夹同步、视频缓存、ASR、关键帧、字幕比较、AI 视频总结、Markdown 文档库、RAG 对话和知识库导出。

项目主页与源码：[Fenglin-Maple/star-owner](https://github.com/Fenglin-Maple/star-owner)

**Built with OpenAI Codex.** 用户负责产品方向与真实工作流判断，Codex 参与架构、Electron UI、任务状态机、资源调度、GPU ASR、测试和发布工程化。

> `0.10.0` 的边界：视频总结任务只由应用内 Agent 工作流执行。外部 Codex、Claude Code、OpenCode 或其它 Agent 不再领取视频任务，也不能调用媒体工具或提交产物；它们可以通过本机只读 HTTP API 访问全部已完成 Markdown 知识库。

## 核心能力

- 使用独立、持久化、沙箱化 WebView 登录 Bilibili，不复用系统浏览器登录态。
- 同步账号收藏夹，保存 BV、标题、UP 主、时长、发布日期、收藏日期和收藏状态。
- 同步前停止该收藏夹的应用内视频工作流；完整分页读取后以 SQLite 事务提交，失败或崩溃自动回滚。
- B 站报告数量包含隐藏、私密或暂不可见条目时，同步记录“报告数 / 可见数 / 差值”，合并全部可见更新并保留缺席任务的本地状态；只有无可见性差值的快照才据此判定移出收藏夹。
- 收藏夹同步进度条下方直接展示 B 站报告、接口可见、暂不可见、失效记录和有效任务数量，选回已同步收藏夹时仍可查看上次统计。
- “任务总览”的启用/关闭开关直接控制应用内 Agent 可领取的未完成任务；关闭任务不会影响已有完成文档。
- “任务总览”按所选收藏夹统计全部、待处理、处理中、已完成、失败/打回和已关闭任务；状态数字同时是列表筛选入口，并可继续叠加搜索、日期和时长条件。
- 多个应用内 Agent 会话可绑定不同模型和收藏夹并行工作，每个任务使用新的 `workId` 与独立模型上下文。
- 应用统一执行下载、合轨、ASR、字幕、关键帧、评论和缓存清理工具，并管理显存、并发、排队与日志。
- 关键帧通过 FFmpeg 图片流统一写成 `frame-001.jpg` 等真实文件；收藏夹名、标题或 UP 主名含 `%` 时也不会干扰抽帧编号。B 站收藏夹、缓存收藏夹和单视频模式共用此实现。
- faster-whisper 默认使用多语言 `medium` 模型，输出逐句 SRT、时间轴文本和结构化起止时间。
- 自动检测 NVIDIA GPU、CTranslate2 CUDA、显存、项目内 Python/模型，以及 CPU ASR 回退所需的系统环境。
- “视频总结（单个）”直接处理 BV 或链接，产物归档到内置用户/内置收藏夹。
- 文档以“小结 -> 思维导图 -> 目录”开头，正文含真实 Bilibili 时间轴链接、关键帧、字幕比较和热评分析。
- 文档库可筛选、预览和受管删除；RAG 助手可逐页读取原始 Markdown 与原图。
- 外部只读知识库 API 提供目录、元数据、原文分页、搜索和受校验图片读取。
- 下载视频队列与视频库支持合轨缓存、封面、横竖屏播放器、筛选、缺失检测和确认删除。
- 所有数据库、Cookie、缓存、日志和产物默认位于项目 `workspace/` 与已注册 Workspace 库中。

## 桌面导航

左侧栏支持展开、收起和三级菜单：

- “启动页”：启动进度、工具健康状态、最近 500 条状态，以及默认收起的外部 Agent 知识库接入提示词。
- “视频总结（单个）”：常用一级入口。
- “下载视频”：建立应用托管的视频缓存收藏夹。
- “工作准备”：B站登录、收藏夹同步、任务总览。
- “AI”：RAG 知识库助手、Agent 视频总结工作流、视频总结（单个）、AI 模型配置。
- “文件浏览”：视频库、文档库、导出。
- “设置”：二级“应用设置”，以及二级“状态查询”下的三级 Agent 工作列表、Agent 工具模块、Agent 工具状态。
- “README”：在应用内阅读本文件。

## 收藏夹工作流

1. 在“B站登录”登录。应用自动同步用户名、头像、Cookie 和收藏夹列表。
2. 在“收藏夹同步”选择收藏夹并点击“同步任务”。
3. 在“任务总览”查看状态数量，按状态筛选任务，并按需要启用或关闭未完成视频。
4. 在“AI -> Agent 视频总结工作流”新建会话，选择供应商、模型和工作收藏夹。
5. Agent 从该收藏夹领取启用任务，应用准备视频、ASR、字幕、关键帧和热评素材。
6. AI 生成 Markdown，应用规范化结构、校验产物、统一命名并清理临时媒体。
7. 在“文档库”阅读，在“RAG 知识库助手”分析，或在“导出”生成外部 RAG 目录。

收藏夹同步优先于工作流。开始同步会停止绑定该收藏夹的所有持续工作流，中止当前任务，清除本次尝试文件并使旧 `workId` 失效。同步成功后由用户手动重新开始工作流；未同步完成、正在同步或已在 B 站删除的收藏夹不能继续派发。

同步对账遵循“已完成产物保留，未完成任务跟随远端”的原则：

- 新增收藏视频：创建新的待派发任务。
- 移出收藏夹且未完成：从任务库存移除。
- 移出收藏夹但已经完成：保留文档，标题附加“（已移出收藏夹）”，RAG 可读取其收藏状态。
- 收藏夹改名：按稳定的 B 站收藏夹 ID 更新显示名，继续使用原 `storageName` 与产物目录。
- 收藏夹在 B 站删除：本地名称附加“（已在B站删除的收藏夹）”，保留完成文档，但禁止重启相关工作流。
- 同步中断或应用崩溃：恢复上一次完整状态，并在运行日志记录回滚。
- 报告数量大于分页可见数量：同步仍可完成，界面提示暂不可见条目数量；新增与可见元数据正常更新，未出现在本次结果中的本地任务和完成产物保持原状态。

视频只有在 B 站明确返回 `-404`、`62002`、`62004`、`62012` 或等价的删除/下架提示时才进入永久失效墓碑。网络、FFmpeg、ASR 和 Markdown 校验错误一律按普通失败回退；旧版本中被 Markdown 校验误判为失效的任务会在启动时自动恢复为 `pending`。

## 单视频模式

“视频总结（单个）”输出到默认 Workspace 的：

```text
workspace/<内置用户>/<用户选择的内置收藏夹>/<视频产物目录>/
```

同一个内置收藏夹中的同一 BV 只保留一个版本：

- 有任务正在工作：切换到原会话，不创建重复任务。
- 已有完成产物：必须选择“放弃任务并保留旧产物”或“重新生成并覆盖旧产物”。
- 选择覆盖：先清除旧产物和本次旧缓存，复用同一任务身份，从头生成唯一的新产物。
- 失败、待开始或产物文件缺失：清理后原位从头重建。
- 在文档库删除单视频产物：永久删除产物、任务和关联单视频会话，不回到待派发。
- 删除后再次处理相同 BV：按全新单视频任务处理，不显示“已有产物”提醒。

“保留缓存视频”默认关闭。关闭时验收后删除临时视频；开启时将合轨视频保留在该视频产物目录。

## 文档删除语义

文档库右键可删除完成文档和相关生成产物：

- 来源仍在 B 站收藏夹：任务按不变的收藏夹 ID 回到 `pending`，可由应用内 Agent 重新处理；收藏夹改名不影响恢复目标。
- 视频已移出 B 站收藏夹：删除产物和任务，不恢复。
- 原 B 站收藏夹已删除：删除产物和任务，不恢复。
- 单视频或其它本地内置产物：删除产物和任务，不恢复。
- 缓存来源任务：删除总结生成物时保留已登记的缓存视频、封面和缓存元数据。

## 文档标准

模板位于 [`templates/video-summary-template.md`](templates/video-summary-template.md)。应用内 Agent 至少生成：

- 结论优先的小结；
- 紧随小结的 Mermaid 思维导图；
- 可点击目录；
- 带 Bilibili 时间轴链接的完整正文；
- 新闻、技术、经验、方法、参数、前提、限制和时效性说明；
- 精选关键帧及用途说明；
- Bilibili 字幕与本次 ASR 字幕的完整性、术语和时间轴比较；
- 可获取时的热评前三条分析；
- Worker、模型、工具、字幕选择和缓存清理记录。

无论是否存在站内字幕，都会检查并运行一次 ASR。Agent 优先读取：

```text
asr/transcript.srt
asr/asr-transcript.txt
asr/asr-result.json
```

`asr-result.json` 的 `segments[].start/end` 与 SRT 起止时间是时间轴依据，不能根据纯文本顺序猜测。若源视频本身没有音轨，应用会写入 `noAudioStream=true` 的空 ASR 诊断并继续任务；Agent 必须明确说明无音轨，改用站内字幕、关键帧与多模态画面理解。无法判断字幕质量时，再结合关键帧和多模态模型核对。

## 应用托管工具

| 工具 | 用途 |
| --- | --- |
| `video-info` | 获取视频完整元数据并生成 `info.json` |
| `material-bundle` | 准备下载、字幕、ASR、关键帧和评论等素材 |
| `merged-video` | 下载音视频并生成合轨视频 |
| `asr` | 使用 faster-whisper 生成逐句时间轴字幕 |
| `bili-subtitles` | 提取各分 P 站内字幕并检查覆盖率 |
| `comments-top3` | 获取热评前三条 |
| `clean-cache` | 删除临时音视频，保护已登记缓存源 |

这些工具只由应用内工作流调用。外部进程不能通过 HTTP 执行工具。工具模块页面可查看用途、提示词、内部命令、输出和开源项目来源，也可以禁用某个模块。

资源池默认包括：

- `api`：2 条通道，限制 Bilibili API 启动频率。
- `media`：3 条通道，用于下载、FFmpeg、音频和关键帧。
- `disk`：2 条通道，用于缓存清理。
- `asr`：1 条 CUDA `float16` 通道；可手动开启 CPU `int8` 辅助通道。

设置页显示真实 ASR 兼容性。`medium` 建议至少 4096 MiB 显存或 8192 MiB 系统内存；`small` 建议至少 2048 MiB 显存或 6144 MiB 系统内存。CPU 通道仅在当前项目内置运行时支持的 Windows x64 环境开放，默认关闭。

## 外部知识库 API

默认地址：

```text
http://127.0.0.1:17391
```

外部 Agent 先读取协议：

```http
GET /api/manifest
```

推荐流程：

```http
GET /api/knowledge/catalog
GET /api/knowledge/documents?offset=0&limit=100
GET /api/knowledge/documents/<documentId>
GET /api/knowledge/documents/<documentId>/content?startLine=1&lineCount=400
GET /api/knowledge/documents/<documentId>/assets
GET /api/knowledge/documents/<documentId>/assets/<assetId>
GET /api/knowledge/search?q=<query>&limit=20
```

目录接口默认覆盖全量已完成 Markdown，可按 `userId`、`collectionId`、`bvid`、`title`、`owner`、`tag`、发布日期和收藏日期筛选。`publishedAt` 是视频发布日期，`favoriteAddedAt` 是收藏日期，`favoriteMembership` 表示仍在收藏夹、已移出或原收藏夹已删除。

原文接口按 1 基行号分页，返回 `nextStartLine` 与 SHA-256。需要完整原文时持续读取到 `nextStartLine=null`。搜索摘要只用于定位，`partial=true` 表示触及扫描预算；精确 Markdown 原文始终是事实来源。

图片接口只返回产物目录内经过签名与大小校验的 PNG、JPEG、GIF、WebP 或 AVIF。资产 ID 是文档内不透明标识，外部 Agent 不应推测本机路径。

旧的视频工作流接口统一返回：

```text
HTTP 410
EXTERNAL_VIDEO_WORKFLOW_DISABLED
```

包括 `/api/workers`、`/api/tasks`、`/api/tools`、`/api/tool-runs`、`/api/active-collection` 和相关子路径。

## RAG 知识库助手

RAG 助手支持多个 OpenAI/NewAPI 兼容供应商和多会话：

- 按用户/收藏夹多选知识库；
- 原始 Markdown 分页读取和最多 24 轮知识工具调用；
- 对支持视觉输入的模型提供原图；
- 显示流式内容、供应商返回的 reasoning、工具状态和 Token 用量；
- 会话达到模型窗口 75% 或安全输入边界时自动压缩，也可手动压缩；
- 上传图片、PDF、Markdown、Word、音频、视频等附件，能力按模型声明降级；
- 每个会话使用独立沙盒；CMD、沙盒外文件和私网访问在有限权限下请求批准。

应用只显示供应商明确返回的 reasoning，不提取隐藏思维链。

## 视频 Agent 上下文

持续工作流的 Worker ID 在会话内保持不变，但每个视频获得新的 `workId` 和全新的模型请求上下文。上一视频的消息不会进入下一视频，只有统计数据累计。

普通视频直接使用当前任务完整素材。只有预计请求达到模型上下文窗口 82%，或供应商实际返回上下文超限时，应用才使用相同供应商与模型开启独立整理请求，完整分块读取素材并生成分层证据包；原 Worker ID、当前 `workId` 和任务状态不变。若整理后仍超限，任务按标准中止流程清理并回到待派发。

## Workspace

默认目录：

```text
<project>/workspace/
```

主要结构：

```text
workspace/
  orchestrator.sqlite
  <用户名>/
    cookies/
    <收藏夹 storageName>/
      <BV + 标题 + UP + 日期 + 收藏夹 + 标签>/
        <同名>.md
        info.json
        cover.*
        frames/
        subtitles/
        asr/
        comments/
```

设置页可以注册多个 Workspace 库，但必须指定一个默认库。知识库 API 只读取已注册 Workspace 内、状态为 `done` 且文件仍存在的 Markdown，不暴露本机绝对路径。

## 下载与部署

Windows 用户可从 GitHub Releases 下载便携包。首次启动若缺少运行时或模型，应用会提示从本项目 Release 下载并显示进度；设置页可重新检查和下载。

源码运行：

```powershell
git clone https://github.com/Fenglin-Maple/star-owner.git
cd star-owner
npm install
npm start
```

部署完整 ASR 运行时：

```powershell
npm run setup:asr
```

发布前总验证：

```powershell
npm run verify:release
```

新增重点测试：

```powershell
npm run test:knowledge-api
npm run test:hardware
npm run test:internal-agent
npm run test:document-lifecycle
```

本版本只提交源码与文档时无需重新上传未变化的 Release 依赖包。

## 项目结构

```text
src/main.js                         Electron 主进程与 IPC
src/core/api-server.js              本机只读知识库 HTTP 服务
src/core/knowledge-api.js           目录、原文、搜索与图片边界
src/core/internal-agent-manager.js  应用内视频总结工作流
src/core/collection-sync-service.js 收藏夹事务同步
src/core/document-lifecycle.js      文档删除与任务恢复语义
src/core/tool-runner.js             工具资源池与 ASR 常驻服务
src/core/hardware-capabilities.js   NVIDIA/CUDA/CPU ASR 能力检测
src/core/rag-assistant.js           RAG 会话、工具与权限
src/core/video-cache-manager.js     下载队列与视频缓存库
src/core/store.js                   sql.js 持久化
src/renderer/                       桌面 UI
tools/                              项目内媒体和 ASR 工具入口
templates/                          视频总结 Markdown 模板
scripts/                            测试、部署与发布验证
```

## 安全与许可

知识库 API 仅绑定 `127.0.0.1`，拒绝无关浏览器 Origin，不开放通配 CORS，没有写接口，也不提供面向不可信本机进程的认证。不要将端口映射到局域网或公网。

Bilibili Cookie 为工具兼容性必须以 Netscape 明文格式保存；账号密码和模型 API Key 使用 Electron `safeStorage`，不可用时拒绝明文保存。发布前不要提交 `workspace/`、日志、Cookie、模型密钥或私人文档。

项目采用 `GPL-3.0-or-later`。第三方组件与模型条款见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)，部署说明见 [`DEPLOYMENT.md`](DEPLOYMENT.md)，设计细节见 [`DESIGN.md`](DESIGN.md)，安全边界见 [`SECURITY.md`](SECURITY.md)。
