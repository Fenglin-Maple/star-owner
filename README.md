<p align="center">
  <img src="assets/star-note.png" width="148" alt="星藏家图标">
</p>

<h1 align="center">星藏家</h1>

<p align="center">
  <strong>把“稍后再看”变成真正可用的视频知识库</strong><br>
  面向 Bilibili 收藏夹的本地 AI 视频知识整理桌面应用
</p>

<p align="center">
  <a href="https://github.com/Fenglin-Maple/star-owner/releases/latest"><img src="https://img.shields.io/github/v/release/Fenglin-Maple/star-owner?label=version&amp;color=ff6699" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-20b8cd" alt="支持 Windows 10 和 Windows 11">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-1d2939" alt="GPL-3.0-or-later 许可证"></a>
</p>

星藏家是一个面向 Bilibili 收藏夹的本地视频知识整理桌面应用。它负责收藏夹同步、视频缓存、ASR、关键帧、字幕比较、AI 视频总结、Markdown 文档库、RAG 对话、知识库导出，以及“B站之外”中的本地媒体和多模态文档工具。

项目主页与源码：[Fenglin-Maple/star-owner](https://github.com/Fenglin-Maple/star-owner)

**Built with OpenAI Codex.**

> `1.4.7` 版本边界：视频总结任务只由应用内 Agent 工作流执行。外部 Codex、Claude Code、OpenCode 或其它 Agent 不再领取视频任务，也不能调用媒体工具或提交产物；它们可以通过本机只读 HTTP API 访问全部已完成 Markdown 知识库。
>
> “视频总结（单个）”和批量 Agent 工作流仍只处理普通 BV 单 P 视频；多 P、番剧、电影、纪录片、综艺、互动视频和其它特殊页面在这两个入口会被明确拒绝。`B站之外 -> B站多P视频总结`提供独立的多 P 父任务、逐 P 处理、追加 P、父任务查看器和 RAG 目录支持，不会改变上述两个旧入口的保护边界。

`1.4.7` 默认使用多语言 `large-v3-turbo` ASR：NVIDIA GPU 使用 `int8_float16`，CPU 使用 `int8`。CPU 与 CUDA 是互斥的独立运行模式，ASR 请求仍在选定通道中排队。当前版本只在应用中暴露 `large-v3-turbo` 和 `small`；旧版 `medium` 依赖包保留在历史 Release 中供旧应用使用，不会被新版本删除或展示。

本版本提供多 P 视频父任务处理与 GitHub B站总结共享。完整 B站总结可按稳定文档 ID 上传并创建 PR，审核合并后的文档可按单篇或远程收藏夹挂载到本地“共享”用户，进入文档库和 RAG；共享用户不进入任务总览或 Agent 派发。共享仓库必须存在匹配仓库身份、默认分支和能力声明的 `_star-owner-repository.json`，通过检测后才会保存到已验证仓库下拉列表；进入工具时会复查当前仓库，失败不会覆盖原有连接。默认仓库仍为 `Fenglin-Maple/Blibili-Markdowns`；用户也可以一键在当前 GitHub 账号下创建公开共享仓库，应用会预置 README、贡献规范、CODEOWNERS、PR 模板和校验/目录索引 Actions。私有自定义仓库只有在星藏家当前授权可访问时才会读取。

共享上传使用核心包内的 Portable Git，不读取用户全局 Git、SSH、HOME 或凭据配置。单次最多选择 `1000` 篇且总提交不超过 `1 GiB`；上传期间应用显示不可绕过的进度窗口并锁定其它操作，用户可主动中止，网络或 Git 中断也会清理可识别的临时分支和工作目录。候选区支持用户、收藏夹、标题/BV/UP主、生成时间和时长筛选；准备上传列表在固定高度区域内滚动，可继续筛选、全选当前结果并批量移除。应用按 GitHub 数字 ID 判断目标仓库主人：主人直接创建临时分支/PR，其他贡献者使用 Fork/PR，commit author 绑定实际登录账户。共享包会把单视频最终正文规范为 `summary.md`，把多 P 规范为 `index.md` 与 `parts/cid-*/summary.md`；只附带图片和脱敏共享元数据，不上传 Agent 草稿、ASR、字幕、评论或本地过程 JSON。

远程共享目录优先一次读取由主分支 Action 自动维护的根目录 `catalog.json`；旧仓库缺少或损坏索引时才回退 Git tree 与逐篇元数据兼容读取。用户可分别按 GitHub 用户名、哔哩哔哩用户名和视频名称搜索，并按“GitHub 用户 -> 哔哩哔哩用户 -> 收藏夹 -> 视频总结”四层树展示。挂载有变化的文档时，应用通过内置 Portable Git 一次浅克隆当前仓库，再从本地快照批量取出所需文档；Git 快照失败时，API 回退也只读取一次文件树。已挂载且本地完整、远程版本未变的收藏夹会直接提示无需更新，不重复下载；单篇挂载再升级为整收藏夹挂载时会自动归并重复记录和本地产物。共享收藏夹只进入文档库与 RAG，任务总览、单视频总结和 Agent 工作流的前后端都会排除或拒绝它。创建/检测仓库、读取目录、挂载和同步都显示项目数、当前条目和百分比进度。

“B站之外”首页只展示带运行数据的工具入口卡，点击后进入独占工具视图并可返回工具箱；常规窗口中多 P 与共享功能左右分栏，接近最小窗口宽度时自动改为单列。GitHub 授权优先通过默认浏览器调用项目内置 Git Credential Manager，凭据强制保存在应用私有 DPAPI 目录；Token 粘贴仍作为备用路径。应用提供仅清除自身数据库与内置 Git 私有令牌的账户切换操作，绝不清理系统凭据库或用户全局 Git。1.4.7 继续沿用前端会话设置串行保存、旧流事件门控、审批失败重试和模型配置供应商绑定；同时保留 OpenAI/NewAPI 的 `/v1` 根路径探测、模型能力识别、RAG 上下文预检和大 Markdown 分页读取。

## 快速安装与第一次使用

适用于 Windows 10/11 x64。普通用户不需要预先安装 Node.js、Python、FFmpeg、SQLite 或 faster-whisper。

1. 打开 [最新 GitHub Release](https://github.com/Fenglin-Maple/star-owner/releases/latest)，下载 `Star-Owner-v<version>-win-x64-core.zip`；建议同时下载同名 `.sha256` 校验文件。
2. 将 ZIP 完整解压到当前用户可写且路径较短的目录，例如 `D:\Star-Owner`；不要在压缩包预览窗口内直接运行。
3. 双击解压目录根部的 `Start-StarOwner.cmd`。便携包首次成功启动后会在当前用户桌面自动创建“星藏家”快捷方式，以后可直接使用桌面图标启动；同一安装目录不会反复创建。
4. 核心包包含 Electron、Python、faster-whisper、FFmpeg、yt-dlp、CUDA/VC++ 运行依赖，但不包含 ASR 模型权重。全新安装首次启动会列出缺失的必需 `large-v3-turbo`；`small` 是可选模型。可让应用自动下载，也可从 `v1.0.0` Release 手动下载对应 ZIP，然后在“设置 -> 应用设置 -> 项目依赖包”点击“从本地导入”。ZIP 不需要自行解压；应用会核对版本、文件名、官方 SHA-256 和包结构。
5. 在启动页按照“第一次上手”依次完成：`配置 AI 模型 -> 登录 B站 -> 同步收藏夹 -> 检查任务 -> 创建 Agent 视频总结工作流`。

默认 ASR 模型为多语言 `large-v3-turbo`；资源更紧张时可切换 `small`。应用会在任务运行前后检查磁盘空间，默认至少保留 2 GB，并在大容量磁盘上使用封顶的比例阈值，空间不足时停止新增处理并给出迁移提示。建议为核心包、模型、缓存和视频产物预留至少 12 GB 可用空间。

## 核心能力

星藏家把分散的视频处理步骤收进一条可追踪的本地工作流：

`收藏夹或单个视频 -> 任务治理 -> 媒体与字幕处理 -> AI 总结 -> Markdown 文档库 -> RAG 检索与导出`

### 收藏夹同步与任务治理

- 使用独立、持久化、沙箱化 WebView 登录 Bilibili，支持扫码登录，不复用系统浏览器登录态；每次点击“扫码登录”都会重新加载二维码页面，避免沿用过期二维码。
- 已登录状态启动时只读取一次收藏夹目录和远端视频数量，不读取收藏夹视频分页、不改变任务。进入“收藏夹同步”时会用长时提示列出相对上次成功同步发生数量变化的收藏夹。
- 同步收藏夹及 BV、标题、UP 主、时长、发布日期、收藏日期和收藏状态；一次同步会为同一 B 站用户建立持久化批次快照，收藏夹目录对账和目标视频库存全部成功后才提交，失败或崩溃自动整体回滚。
- 面对隐藏、私密或暂不可见条目，分别记录 B 站报告数、接口可见数与差值，保守合并本地状态，避免把暂时不可见的视频误判为已移出。
- “任务总览”集中展示待处理、处理中、已完成、失败/打回和已关闭任务；支持搜索、日期、时长及状态筛选，并可按视频启用或关闭后续处理。
- 任务总览支持“一键启用筛选结果”：当前收藏夹在普通/高级筛选后的可见任务会被整体启用，同收藏夹其余未完成任务自动关闭，已完成记录仍保留。

### 应用内 Agent 视频总结工作流

- 多个 Agent 会话可以绑定不同 AI 供应商、模型和收藏夹并行工作；每个视频使用新的 `workId` 和独立模型上下文，不会混入上一个视频的对话。
- 应用统一调度视频下载、音视频合轨、字幕提取、ASR、关键帧、热评和缓存清理，并管理显存、并发队列、执行超时与运行日志。
- 工作被中止或发生普通故障时，应用清理本次尝试文件并回退任务；确认删除或下架的视频才会进入永久失效状态。
- 除收藏夹批量工作流外，也可以直接粘贴 BV 或视频链接完成单视频总结，产物自动归档到内置用户和指定内置收藏夹。

### 有时间轴依据的 Markdown 文档

- 无论视频是否带有站内字幕，都会运行一次 faster-whisper ASR；默认使用多语言 `large-v3-turbo` 模型，生成逐句 SRT、时间轴文本和结构化起止时间。
- Agent 对比站内字幕与 ASR 字幕的完整性、术语和时间轴，并可结合关键帧与多模态能力判断更可靠的内容依据。
- 关键帧通过 FFmpeg 输出为真实图片文件，工作流可设置最低关键帧数和按视频时长增加的间隔额度，文档按“小结 -> 思维导图 -> 目录”组织，正文包含 Bilibili 时间轴链接、关键帧、字幕比较和热评前三分析。
- 视频、图片、字幕、元数据和 Markdown 按统一目录与命名规则归档，任务完成后自动清理不需要保留的临时媒体缓存；工作流可选择保留视频、字幕和 ASR 过程缓存。

### 文档库、RAG 与外部知识访问

- 文档库支持按用户、收藏夹、BV、标题、UP 主、日期和时长筛选，并可预览或按来源语义受管删除产物。
- 内置 RAG 知识库助手可以逐页读取原始 Markdown 与原图，进行跨视频检索、比较、归纳和连续对话。
- 导出功能可将选定文档整理为外部知识库目录；本机只读 HTTP API 还向 Codex、Claude Code、OpenCode 等外部 Agent 提供目录、元数据、原文分页、搜索和受校验图片读取。

### 视频缓存与本地运行保障

- 下载队列与视频库支持合轨视频缓存、封面、横竖屏播放、条件筛选、文件缺失检测和确认删除；缓存视频收藏夹也可作为 AI 总结任务来源。
- 自动检测 NVIDIA GPU、CTranslate2 CUDA、显存、项目内 Python 和 ASR 模型；可在 `small` 与 `large-v3-turbo` 间切换，并提供默认关闭的独立 CPU ASR 模式。CPU 模式启用后不会同时运行 CUDA ASR。
- 数据库、Cookie、模型配置、缓存、日志和最终产物默认保存在项目 `workspace/` 与用户注册的 Workspace 库中，便于迁移、备份和统一管理。

### “B站之外”本地工具箱

- “视频 / 音频字幕生成”支持选择一个可读取的视频或音频文件，复用统一媒体与 ASR 队列，按需生成 `SRT`、`VTT`、`LRC`、`TXT` 和 `JSON`，字幕写回原文件目录。
- “本地视频 / 音频导入内置缓存收藏夹”支持单个或多个视频、音频及其文件夹；只接受项目内置 FFmpeg 可解码的媒体，导入前显示同名冲突，支持逐项跳过或覆盖。视频和音频会按每 10 分钟 30 MiB 的预算压缩，单遍编码优先保证速度，只有超出预算时才自动降码率重试；总进度和每个视频的独立进度都会显示，视频竖屏比例保留，源文件不移动；音频保存为仅含音频流的缓存 MP4，后续可直接交给 Agent/ASR，导入记录带有本地来源、导入/投稿/收藏时间和可派发 Agent 任务。
- “本地文档知识库导入”支持图片、PDF、DOCX、PPTX、XLSX/XLSM、Markdown 和常见文本。原件、Markdown 索引与图片资源都会保存到“多模态文档”收藏夹，RAG 可以读取原始 Markdown 和可识别的本地图片；普通源文件上限为 256 MiB，文本文件上限为 64 MiB，Office 文件上限为 128 MiB。Office 还限制单条 XML 为 32 MiB、媒体为 64 MiB、其它条目为 96 MiB、总解压内容为 512 MiB，并限制条目和媒体数量；Excel 每张表最多读取 100000 行、每行 10000 个单元格、单元格文本 10000 字符，索引文本最多写入 8 MiB。PDF 解析有 120 秒超时且取消会终止解析子进程，原始文件仍不会被破坏。
- 本地工具中断或应用关闭时，已完成条目保留，当前及未开始条目回退并清理过渡文件。现代 Office 使用受限 ZIP/XML 解析；旧式二进制 `.doc`、`.ppt`、`.xls` 不在当前支持范围，避免依赖系统 Office 或全局运行时。
- “B站多P视频总结”一次只处理一个父任务，支持选择 P、设置内部并发、停止/继续、刷新追加 P 和删除父任务；本地 `index.md` 会在每个 P 完成时自动提取其 `## 小结`，连同 P 标题、状态和完整正文入口写入“每 P 小结”，不额外调用模型。目录 Markdown 作为父文档，P 总结作为子文档，均可被 RAG 按父任务、P 序号和 CID 读取；既有父目录会在升级后首次启动时自动重建。点击入口卡后进入独占工具视图，常规宽度下左侧创建与执行、右侧父任务查看器；查看器先选择多 P 收藏夹，再显示该收藏夹下的父任务和 P 状态。
- “GitHub 文档共享”只允许已完成的 B站视频总结（多 P 必须上传完整父任务包），不上传原始视频、音频、ASR 缓存、Cookie 或 API Key。上传者可按用户、收藏夹、标题/BV/UP主、生成时间和时长筛选，批量加入按收藏夹折叠的准备上传列表。默认浏览器授权存入项目私有 DPAPI 凭据目录，Token 粘贴保留为备用；普通用户创建 Fork/分支/PR，仓库主人直接创建仓库分支/PR。清除授权只删除星藏家数据库和内置 Git 私有凭据，不修改系统 Git 或全局凭据。连接仓库前会验证共享规范并加入已验证仓库列表；远程目录优先一次读取 Action 生成的 `catalog.json`，挂载更新通过内置 Git 的单次浅克隆批量导入。下载者可按 GitHub 用户、B站用户和视频名称搜索四层远程目录，将筛选结果、单篇或整个远程收藏夹挂载到“共享”用户，也可多选本地挂载统一同步；无变化时不会重复下载，重叠的单篇/整收藏夹挂载会自动归并。远程删除只标记失效并保留本地文档，共享收藏夹不进入任务总览或 Agent 派发。点击入口卡后进入独占工具视图，常规宽度下左侧下载/挂载、右侧上传 PR；各项远程自动化均显示进度。

## 桌面导航

左侧栏支持展开、收起和三级菜单：

- “启动页”：启动进度、工具健康状态、最近 500 条状态、可点击的“第一次上手”五步流程，以及默认收起的外部 Agent 知识库接入提示词。启动页内容超出窗口时使用独立纵向滚动，不会截断下方日志或提示词。
- “视频总结（单个）”：常用一级入口。
- “下载视频”：建立应用托管的视频缓存收藏夹。
- “工作准备”：B站登录、收藏夹同步、任务总览。
- “AI”：RAG 知识库助手、Agent 视频总结工作流、视频总结（单个）、AI 模型配置。
- “文件浏览”：视频库、文档库、导出。
- “设置”：二级“应用设置”，以及二级“状态查询”下的三级 Agent 工作列表、Agent 工具模块、Agent 工具状态。
- “README”：在应用内阅读本文件。

“第一次上手”按推荐顺序跳转到 AI 模型配置、B站登录、收藏夹同步、任务总览和 Agent 视频总结工作流。每个流程节点都是按钮；跳转到二级页面时会自动展开对应侧栏栏目。

## 收藏夹工作流

1. 在“B站登录”登录。应用自动同步用户名、头像和 Cookie；已登录状态启动时会只读检查一次收藏夹目录数量。
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
| `local-subtitles` | 为单个本地视频/音频生成 SRT、VTT、LRC、TXT 或 JSON 字幕 |
| `local-video-import` | 压缩本地视频/音频并导入内置缓存视频收藏夹 |
| `local-document-import` | 导入本地多模态文档、原件和图片资源 |

这些工具只由应用内工作流调用。外部进程不能通过 HTTP 执行工具。工具模块页面可查看用途、提示词、内部命令、输出和开源项目来源，也可以禁用某个模块。

资源池默认包括：

- `api`：2 条通道，限制 Bilibili API 启动频率。
- `media`：3 条通道，用于下载、FFmpeg、音频和关键帧。
- `disk`：2 条通道，用于缓存清理。
- `asr`：1 条 CUDA 常驻通道或 1 条 CPU 常驻通道，二者互斥；`small` 使用 `float16`，`large-v3-turbo` 使用低显存 `int8_float16`，CPU 使用 `int8`。

设置页显示真实 ASR 兼容性。`small` 建议至少 2048 MiB 总显存或 6144 MiB 系统内存；`large-v3-turbo` 建议至少 3072 MiB 总显存、启动时 2048 MiB 空闲显存或 8192 MiB 系统内存。独立 CPU 通道仅在当前项目内置运行时支持的 Windows x64 环境开放，默认关闭。

本机 RTX 4070 Laptop 实测同一组 59 秒中文、159 秒英文竖屏和 80 秒日语/背景音乐 Bilibili 音轨：Turbo 峰值显存增量约 1348 MiB，并正确检测三种语言并生成有效 SRT。该结果用于确定 3GB 显卡门槛，不代表所有驱动、音轨和显卡都有完全相同的占用或准确率。

## 外部知识库 API

默认地址：

```text
http://127.0.0.1:17391
```

外部 Agent 先确认服务，再读取协议：

```http
GET /api/health
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

目录 `limit` 支持 1～500。排序参数使用 `字段-方向` 格式，例如 `favorite-desc`、`published-asc` 或 `completed-desc`，不能写成下划线格式。所有筛选值和 `documentId` 都应进行 URL 编码。

原文接口按 1 基行号分页，`lineCount` 单次支持 1～1000 行，默认 400 行，并返回 `nextStartLine`、总行数和 SHA-256。需要完整原文时持续读取到 `nextStartLine=null`。搜索摘要只用于定位，`partial=true` 表示触及扫描预算；精确 Markdown 原文始终是事实来源。

图片接口只返回产物目录内经过签名与大小校验的 PNG、JPEG、GIF、WebP 或 AVIF。资产 ID 是文档内不透明标识，外部 Agent 不应推测本机路径。支持视觉输入的 Agent 应先列出资产并真实请求图片二进制，再分析像素或将图片作为附件/Markdown 图片返回；不能仅根据文件名或图注声称看过原图。

启动页提供的可复制提示词还包含目录分页、日期语义、引用规范、跨文档比较、搜索扫描预算和 `404/409/410/413/416` 错误恢复规则，可直接交给新的外部 Agent 会话使用。

旧的视频工作流接口统一返回：

```text
HTTP 410
EXTERNAL_VIDEO_WORKFLOW_DISABLED
```

包括 `/api/workers`、`/api/tasks`、`/api/tools`、`/api/tool-runs`、`/api/active-collection` 和相关子路径。

## RAG 知识库助手

RAG 助手支持多个 OpenAI/NewAPI 兼容供应商和多会话：

- 按用户/收藏夹多选知识库；
- 原始 Markdown 分页读取和最多 24 轮知识工具调用；逐行读取按 UTF-8 字符流分页，不会为读取一小段原文一次性加载整篇超大 Markdown；
- 对支持视觉输入的模型提供原图；
- 显示流式内容、供应商返回的 reasoning、工具状态和 Token 用量；兼容 SSE 分块、非流式 JSON，以及正文中的 `<think>`、`<thinking>`、`<analysis>` 推理标签，推理标签不会混入正文；
- 按实际发送的 JSON 消息预检上下文，图片/音频附件按实际 base64 载荷估算；会话达到模型窗口 75% 或安全输入边界时自动压缩，也可手动压缩。不支持压缩的模型会在发送前给出切换模型或新建会话提示；
- 知识库检索有文档数、分块数、结果字符数和耗时预算，单个损坏/缺失文档会跳过并提示，不会让整次检索静默失败；
- 上传图片、PDF、Markdown、Word、音频、视频等附件，能力按模型声明降级；
- 每个会话使用独立沙盒；CMD、沙盒外文件和私网访问在有限权限下请求批准。

应用只显示供应商明确返回的 reasoning，或供应商明确放在上述兼容标签中的内容，不会自行推断或生成模型未返回的隐藏思维链。

## 视频 Agent 上下文

持续工作流的 Worker ID 在会话内保持不变，但每个视频获得新的 `workId` 和全新的模型请求上下文。上一视频的消息不会进入下一视频，只有统计数据累计。会话同时保存用户与收藏夹名称快照，并优先读取收藏夹当前名称，因此新建过程中的异步刷新和后续改名都不会让列表身份信息消失。

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

Windows 产物路径按传统 259 字符安全上限预算。标题包含 `\ / : * ? " < > |`、控制字符、尾随点/空格或保留设备名时会自动清理；标题过长时保留可辨识前缀和稳定哈希，最低保留 24 个字符。若 Workspace 本身过深，应用启动时会先于依赖下载弹出迁移提示，任务执行时也会返回 `WINDOWS_PATH_TOO_LONG`，不会把它误判为视频或 AI 失败。

安全迁移便携安装：停止 Agent 并关闭应用，将**整个项目目录**复制到较短位置（推荐 `D:\Star-Owner`），从新位置启动并确认任务、文档、登录状态正常后再删除旧目录。不要只移动 `workspace/`。数据库会自动把旧默认 Workspace 下的受管绝对路径重定位到新目录；用户另外注册的外部 Workspace 不会被改写。

## 下载与部署

自 1.0.9 起，应用支持在设置中检查 GitHub 最新稳定版并执行校验、暂存、替换和失败回滚，保留 `workspace/`、`runtime/` 与视频产物。更新 helper 从待安装的新包中执行，覆盖 `templates` 等运行时目录；下载断点遇到 HTTP 416 时会校验完整包并复用或从头重下，`.updates/operation-journal.json` 会记录未完成操作并在下次启动显示。旧版 v1.0.3 及更高版本可通过设置中的迁移入口导入完整 workspace；迁移前应停止 Agent、关闭旧应用，并把完整项目放在较短目录中。

“B站之外”是可在设置中关闭的一级工具箱栏目。当前版本已提供多 P 视频总结、GitHub B站总结共享、单个本地视频/音频字幕、本地视频/音频压缩导入内置缓存收藏夹和本地多模态文档知识库导入；首页只展示响应式工具入口卡和实用状态数据，点击卡片后在同一内容窗口进入独占工具视图，并通过左上角按钮返回。应用只在后端服务完成启动后刷新这些工具，不会在启动过程中提前弹出多 P 服务尚未加载的错误。多 P 与共享工具在常规宽度采用左右分栏，在窄窗口自动上下排列；TTS、本地 PDF 总结等其它工具仍为后续规划，不会显示为已实现功能。

Windows 10/11 x64 用户可从 [GitHub Releases](https://github.com/Fenglin-Maple/star-owner/releases/latest) 下载便携包：

1. 只需下载 `Star-Owner-v<version>-win-x64-core.zip`；同名 `.sha256` 文件用于校验下载完整性。
2. 将 ZIP 完整解压到当前用户可写的目录，不要在压缩包预览窗口内直接运行。
3. 双击解压目录根部的 `Start-StarOwner.cmd`。应用固定使用便携包内 Electron/Node、Python、FFmpeg、yt-dlp 和 SQLite，不读取全局 Node 来执行媒体工具。
4. 首次启动若提示缺少 ASR 模型，可允许应用自动下载；也可在设置的“项目依赖包”中点击模型名称打开正确 Release，下载完整 ZIP 后直接“从本地导入”。下载中的按钮会变成“暂停”，暂停会保留 `.partial` 断点缓存，之后可继续下载；下载中或暂停时点击“从本地导入”会先中止自动下载并清理受管缓存。默认使用 `large-v3-turbo`，资源不足时可切换 `small`；如果没有 NVIDIA/CUDA，可在设置中改用独立 CPU ASR。
5. 按启动页“第一次上手”依次完成模型配置、B站登录、收藏夹同步、任务检查和 Agent 工作流创建。

运行时和模型 ZIP 是应用内依赖管理器使用的独立资产。设置页可以重新检查、下载或修复依赖，并可导入手动下载的 `small`、`large-v3-turbo` ZIP。`1.4.7` 继续使用 `v1.0.0` 依赖基线，接受精确名称 `Star-Owner-v1.0.0-model-small.zip` 和 `Star-Owner-v1.0.0-model-large-v3-turbo.zip`；旧版 `medium` ZIP 仍保留在该 Release 供旧应用使用。依赖管理器核对 GitHub Release SHA-256、模型类型和目录结构，未经校验的包不会安装，错误导入不会损伤原有健康模型。

每个项目副本根据其绝对项目根目录派生独立的 B 站 WebView partition。空白目录不会读取另一份星藏家的登录 Cookie；从旧版本升级时，仅当当前目录已有用户数据库记录，才会把旧固定 partition 的 B 站 Cookie 做一次兼容迁移，旧 partition 不会被清空。

应用创建的 Node、Python、FFmpeg、yt-dlp、CTranslate2、CUDA、VC++ 和 Git 子进程会使用项目目录中的绝对路径与受控环境。应用会清除用户的 `PATH`、`PYTHONPATH`、Conda/虚拟环境、`NODE_PATH`、`NODE_OPTIONS`、自定义 faster-whisper 覆盖变量、全局 Git 配置、SSH 配置和凭据辅助程序，只保留项目运行时目录及必要的 Windows 系统目录；因此不会因为电脑安装了其它版本的 Node、Python、FFmpeg 或 Git 而改变主工作流。RAG 的 `run_command` 仍是用户明确授权的 CMD 能力，但同样使用受控 PATH；需要访问系统命令时应明确使用绝对路径。

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
npm run test:asr-models
npm run test:internal-agent
npm run test:document-lifecycle
npm run test:local-toolbox
npm run test:runtime-isolation
npm run test:git-runtime
npm run test:runtime-node
```

常规代码版本使用 `npm run package:core` 只生成核心 ZIP，并复用 `package.json` 中 `dependencyReleaseVersion` 指定的 Release 依赖。`npm run package:model:turbo` 可单独生成按依赖版本命名的 Turbo 模型 ZIP 与 SHA-256，不会同时生成核心包。只有 Python、CUDA、faster-whisper、FFmpeg、yt-dlp、VC++ 运行库、模型权重或依赖目录契约变化时，才更新或补充相应 runtime/model 资产。

## 项目结构

```text
src/main.js                         Electron 主进程与 IPC
src/core/api-server.js              本机只读知识库 HTTP 服务
src/core/knowledge-api.js           目录、原文、搜索与图片边界
src/core/internal-agent-manager.js  应用内视频总结工作流
src/core/collection-sync-service.js 收藏夹事务同步
src/core/document-lifecycle.js      文档删除与任务恢复语义
src/core/tool-runner.js             工具资源池与 ASR 常驻服务
src/core/asr-models.js              ASR 模型、计算类型与资源门槛注册表
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
