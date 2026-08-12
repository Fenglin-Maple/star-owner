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

GitHub 文档共享工具的完整设计、数据契约、Fork/PR 流程、挂载同步规则和 GitHub Actions 维护约定见：[DESIGN_SHARED_KNOWLEDGE.md](DESIGN_SHARED_KNOWLEDGE.md)。该文件是该功能的唯一权威设计文档，设计发生变化时必须同步更新。

**Built with OpenAI Codex.**

未来功能候选与实现前约束记录在 [FUTURE_FEATURES.md](FUTURE_FEATURES.md)，其中内容不代表当前版本已经实现。

## 从 1.0.3 到 1.7.3

- **1.0.3 - 1.1.x · 稳定基础**：确立应用内 Agent 视频工作流、任务治理和只读知识接口，补齐 Windows 路径、日志、项目内运行时、更新迁移、模型与主题设置。
- **1.2.x - 1.3.x · B站之外**：加入本地音视频字幕与压缩导入、多模态文档知识库、多 P 视频总结，并统一资源排队、取消回滚、磁盘与大文件安全边界。
- **1.4.x · 多 P 与文档共享**：完善多 P 父子任务、逐 P 进度和续做；上线基于 Portable Git、Fork/PR、校验 Action 与 `catalog.json` 的 GitHub 文档共享、挂载和同步。
- **1.5.x · RAG 与多模态**：扩展按收藏夹检索、图片批处理和上下文展示，持续修复网页访问、本地导入、共享目录、多 P 产物及不同供应商工具调用兼容。
- **1.6.x · 稳定性与性能**：强化运行时、更新迁移和安装回滚；修复 RAG 网页取消；治理高 P 并发、进度刷新和父任务操作卡顿；补齐 B站 Cookie、风控退避与 GitHub 授权失效处理。
- **1.7.0 · 登录与文件库边界**：需要登录的 B站收藏夹、视频信息、单视频、多 P 和下载请求统一使用应用 Cookie，并给出登录提示；本地媒体导入收藏夹不再作为 B站下载目标；视频库与文档库按已有文件记录展示，不受任务启用/关闭状态影响。
- **1.7.1 · 可视化安全更新**：更新与旧版数据迁移改由独立原生窗口接管，显示图标动画、阶段、当前项目和持续进度；只有完成双向启动握手后主应用才退出，执行中可“中止并回退”，助手异常退出也会依据事务日志恢复原版本。
- **1.7.2 · 独立一键更新器**：可单独下载更新器 EXE，选择任意 v1.0.3 及以上正式版或历史 pre-release 目录后，自动读取 GitHub latest、断点下载、校验并原地更新；Workspace、模型、缓存、登录状态和应用私有凭据安全继承，全流程支持中止与事务回退。
- **1.7.3 · 同版本更新协议**：安装 vX.Y.Z 必须由 vX.Y.Z 更新器执行。应用内更新先下载并校验目标更新器，再下载核心包；旧更新器会自动移交给目标版本更新器，任何版本、协议、SHA-256 或便携清单不一致都会在替换前停止。解压会先验证并剥离 ZIP 外层目录，再使用受管的 `.updates/s` 短暂存路径，增加 Windows 长路径余量；事务日志使用原子替换和短暂占用重试，进度读取不会打断更新。

> **当前功能边界**：普通“视频总结（单个）”和批量 Agent 工作流只处理 BV 单 P 视频；多 P、番剧、电影、纪录片、综艺、互动视频和其它特殊页面会被明确拒绝。多 P 请使用 `B站之外 -> B站多P视频总结`。外部 Codex、Claude Code、OpenCode 等 Agent 只能通过本机只读 HTTP API 访问已完成知识库，不能领取视频任务、调用媒体工具或提交产物。

## 快速安装与第一次使用

适用于 Windows 10/11 x64。普通用户不需要预先安装 Node.js、Python、FFmpeg、SQLite 或 faster-whisper。

1. 打开 [最新 GitHub Release](https://github.com/Fenglin-Maple/star-owner/releases/latest)，下载 `Star-Owner-v<version>-win-x64-core.zip`；建议同时下载同名 `.sha256` 校验文件。
2. 将 ZIP 完整解压到当前用户可写且路径较短的目录，例如 `D:\Star-Owner`；不要在压缩包预览窗口内直接运行。
3. 双击解压目录根部的 `Start-StarOwner.cmd`。便携包首次成功启动后会在当前用户桌面自动创建“星藏家”快捷方式，以后可直接使用桌面图标启动；同一安装目录不会反复创建。
4. 核心包包含 Electron、Python、faster-whisper、FFmpeg、yt-dlp、CUDA/VC++ 运行依赖，但不包含 ASR 模型权重。全新安装首次启动会列出缺失的必需 `large-v3-turbo`；`small` 是可选模型。可让应用自动下载，也可从 `v1.0.0` Release 手动下载对应 ZIP，然后在“设置 -> 应用设置 -> 项目依赖包”点击“从本地导入”。ZIP 不需要自行解压；应用会核对版本、文件名、官方 SHA-256 和包结构。
5. 在启动页按照“第一次上手”依次完成：`配置 AI 模型 -> 登录 B站 -> 同步收藏夹 -> 检查任务 -> 创建 Agent 视频总结工作流`。

已有 v1.0.3 或更高版本时，也可以从最新 Release 只下载 `Star-Owner-Updater-v<version>-win-x64.exe`。先关闭旧星藏家和全部 Agent，双击更新器并选择包含 `Start-StarOwner.cmd` 的旧项目根目录；更新器会自动安装 GitHub `latest` 正式版到原目录。自 v1.7.3 起，更新器若发现 latest 更高，会先下载并校验 latest 的同版本更新器，再自动移交；旧二进制不会直接安装未来核心包。v1.7.2 及更早的已发布应用尚不具备这套自举协议，首次跨入 v1.7.3 或更高版本时应直接下载目标版本更新器。不要先删除或移动 `workspace/`，原路径更新才能完整继承收藏夹、RAG 文档、模型、缓存、B站登录和应用私有 GitHub 凭据。

默认 ASR 模型为多语言 `large-v3-turbo`；资源更紧张时可切换 `small`。应用会在任务运行前后检查磁盘空间，默认至少保留 2 GB，并在大容量磁盘上使用封顶的比例阈值，空间不足时停止新增处理并给出迁移提示。建议为核心包、模型、缓存和视频产物预留至少 12 GB 可用空间。

## 核心能力

星藏家把分散的视频处理步骤收进一条可追踪的本地工作流：

`收藏夹或单个视频 -> 任务治理 -> 媒体与字幕处理 -> AI 总结 -> Markdown 文档库 -> RAG 检索与导出`

### 收藏夹同步与任务治理

- 使用独立、持久化、沙箱化 WebView 登录 Bilibili，支持扫码登录，不复用系统浏览器登录态；每次点击“扫码登录”都会重新加载二维码页面，避免沿用过期二维码。
- 单视频、多 P、B站视频缓存和收藏夹视频工作流向 B站请求元数据、字幕、评论或媒体时都会携带应用当前保存的 Cookie，不再先匿名尝试；缺少可用 Cookie 时会在联网前停止，并通过右下角通知引导用户登录。本地导入的视频和音频不需要 B站登录。
- 已登录状态启动时只读取一次收藏夹目录和远端视频数量，不读取收藏夹视频分页、不改变任务。进入“收藏夹同步”时会用长时提示列出相对上次成功同步发生数量变化的收藏夹。
- 同步收藏夹及 BV、标题、UP 主、时长、发布日期、收藏日期和收藏状态；一次同步会为同一 B 站用户建立持久化批次快照，收藏夹目录对账和目标视频库存全部成功后才提交，失败或崩溃自动整体回滚。
- 面对隐藏、私密或暂不可见条目，分别记录 B 站报告数、接口可见数与差值，保守合并本地状态，避免把暂时不可见的视频误判为已移出。
- “任务总览”集中展示待处理、处理中、已完成、失败/打回和已关闭任务；支持搜索、日期、时长及状态筛选，并可按视频启用或关闭后续处理。
- “文件浏览”中的视频库和文档库按本地文件记录展示，不跟随“任务总览”的启用/关闭状态筛选；关闭后续处理不会隐藏已经存在的视频或 Markdown，文件被手动移走时仍保留缺失提示。
- “下载视频”始终要求应用内 B站登录 Cookie，且不会把“B站之外”本地视频/音频导入收藏夹列为下载目标；旧版未标记的本地导入收藏夹会根据既有媒体记录自动识别，本地媒体仍照常显示在视频库中。
- 任务总览支持“一键启用筛选结果”：当前收藏夹在普通/高级筛选后的可见任务会被整体启用，同收藏夹其余未完成任务自动关闭，已完成记录仍保留。

### 应用内 Agent 视频总结工作流

- 多个 Agent 会话可以绑定不同 AI 供应商、模型和收藏夹并行工作；每个视频使用新的 `workId` 和独立模型上下文，不会混入上一个视频的对话。
- 普通 Agent 在领取首个需要访问 B站的任务前，会从应用私有登录会话重新导出当前 Cookie，核对 B站收藏夹所属 UID，并以一次事务写回收藏夹后再启动；同一任务运行中不会切换 Cookie，若被 B站拒绝则回滚当前任务并等待重新登录。本地导入的视频/音频完全跳过该检查；“下载视频”产生的 B站缓存仍需补取元数据、字幕或评论，因此使用当前登录 Cookie；多 P 继续由父任务入口独立完成认证。
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
- “B站多P视频总结”一次只处理一个父任务，支持选择 P、设置内部并发、停止/继续、刷新追加 P 和删除父任务；父任务查看器默认展开子 P 平铺列表，也可以收起只看父任务总进度。每个子 P 显示独立进度条、阶段、状态和 CID，并可单独停止；停止只回滚目标 P，必要时补位工作流继续处理其它 P。父任务总进度汇总各子 P 的实时进度。创建并开始后，右侧查看器会自动切换到本次任务的目标收藏夹。运行中的高频进度只发送给多 P 查看器，按 800ms 节流、只携带当前父任务并局部更新已有进度控件，不写活动数据库、不触发全局任务快照，也不重建收藏夹下拉框；停止、继续、重试和删除只合并多 P 局部状态，并保持父任务列表与子 P 列表的滚动位置。高 P 创建会分批让出主线程，启动时的会话、首批任务和工具状态合并为一次数据库落盘；多 P 中间会话/工具进度使用更长的批量窗口，完成、失败、停止和应用退出仍立即保存。父目录刷新会缓存未变化的子 P 产物与小结，不再反复读取此前所有 Markdown；升级时会一次性清理旧版误存的多 P 进度快照。流式输出不会逐 token 扫描全库任务/会话或把多 P 正文发送到无关 Agent 页面，父任务产物删除也使用异步安全清理，避免阻塞窗口。多 P 素材任务继承当前 B站登录 Cookie，并复用父任务已经读取的 BV 元数据，避免每个子 P 重复匿名请求；遇到 B站 `HTTP 412 / API -412` 时只在多 P 路径执行带随机抖动的有限退避重试，普通 Agent 与单视频路径保持原行为。本地 `index.md` 会在每个 P 完成时自动提取其 `## 小结`，连同 P 标题、状态和完整正文入口写入“每 P 小结”，不额外调用模型。目录 Markdown 作为父文档，P 总结作为子文档，均可被 RAG 按父任务、P 序号和 CID 读取；既有父目录会在升级后首次启动时自动重建。点击入口卡后进入独占工具视图，常规宽度下左侧创建与执行、右侧父任务查看器；查看器先选择多 P 收藏夹，再显示该收藏夹下的父任务和 P 状态。
- “GitHub 文档共享”只允许已完成的 B站视频总结（多 P 必须上传完整父任务包），不上传原始视频、音频、ASR 缓存、Cookie 或 API Key。上传者可按用户、收藏夹、标题/BV/UP主、生成时间和时长筛选，批量加入按收藏夹折叠的准备上传列表，并可在上传栏显式刷新本地目录。默认浏览器授权存入项目私有 DPAPI 凭据目录，Token 粘贴保留为备用；普通用户创建 Fork/分支/PR，仓库主人直接创建仓库分支/PR。共享仓库会把稳定的 `validate-shared-docs` Action 检查设置为合并前必需检查；仓主首次连接或一键建仓需要具备该仓库的分支管理权限（Fine-grained Token 需 Administration: Read and write，经典 Token 需对应 repo 管理权限）。清除授权只删除星藏家数据库和内置 Git 私有凭据，不修改系统 Git 或全局凭据。连接仓库前会验证共享规范并加入已验证仓库列表；未保存 GitHub 授权时，公开仓库目录可以匿名读取；已保存 Token 被 GitHub 以 `401` 拒绝时会中止读取并在右下角提示重新授权，不会匿名重试。远程目录优先一次读取 Action 生成的 `catalog.json`，挂载更新通过内置 Git 的 partial clone + sparse checkout 批量导入，并在整批失败时恢复原状态。下载者可按 GitHub 用户、B站用户和视频名称搜索四层远程目录，将筛选结果、单篇或整个远程收藏夹挂载到“共享”用户，也可多选本地挂载统一同步；挂载目标菜单可以选择已有收藏夹或直接输入新名称，未选择时会按日期时间自动创建本地共享收藏夹。同一远程收藏夹从首篇文档起就复用唯一来源节点，单篇、多篇和完整收藏夹操作只改变同步范围。无变化时不会重复下载。远程删除只标记失效并保留本地文档，共享收藏夹不进入任务总览或 Agent 派发。点击入口卡后进入独占工具视图，常规宽度下左侧下载/挂载、右侧上传 PR；各项远程自动化均显示进度。

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

目录接口默认覆盖全量已完成 Markdown，可按 `userId`、`collectionId`、`bvid`、`title`、`owner`、`tag`、发布日期和收藏日期筛选。用户指定收藏夹时，必须先从 catalog 解析精确的 `collectionId`，并在后续目录和搜索请求中持续携带它；`collectionId` 是收藏夹 ID，不能当作 `documentId` 使用。`publishedAt` 是视频发布日期，`favoriteAddedAt` 是收藏日期，`favoriteMembership` 表示仍在收藏夹、已移出或原收藏夹已删除。

目录 `limit` 支持 1～500。排序参数使用 `字段-方向` 格式，例如 `favorite-desc`、`published-asc` 或 `completed-desc`，不能写成下划线格式。所有筛选值和 `documentId` 都应进行 URL 编码。

原文接口按 1 基行号分页，`lineCount` 单次支持 1～1000 行，默认 400 行，并返回 `nextStartLine`、总行数和 SHA-256。需要完整原文时持续读取到 `nextStartLine=null`。搜索摘要只用于定位，`partial=true` 表示触及扫描预算；此时要缩小收藏夹、用户、BV 或标签范围，不能据此断言整个收藏夹没有内容。精确 Markdown 原文始终是事实来源；不同收藏夹中的相同 BVID 视为独立来源，不自动去重。

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
- 知识库检索支持会话已选收藏夹的精确范围：模型可先调用 `knowledge_list_collections` 获取 ID，再把 `collection_id` 或 `collection_ids` 传给目录/搜索工具；每次搜索最多检查 60000 个分块，并同时受文档数、结果字符数和耗时预算约束。单个损坏/缺失文档会跳过并提示，不会让整次检索静默失败；
- 会话消息顶部显示本轮耗时和工具调用次数；最终回答之前的模型过渡文字与工具调用按实际顺序放入较淡的“过程内容”，流式生成时展开，完成后及历史轮次默认收起。历史消息没有位置记录时，工具记录回退到正文开头且不拆分原正文。供应商在工具调用后失败时，已发生的工具记录和部分输出仍会保留。
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

安全迁移便携安装：停止 Agent 并关闭应用，将**整个项目目录**复制到较短位置（推荐 `D:\Star-Owner`），从新位置启动并确认任务、文档、登录状态正常后再删除旧目录。不要只移动 `workspace/`。迁移入口会在安排操作时以及复制前各检查一次旧目录的 Electron/Node 进程，旧应用仍运行时拒绝迁移。数据库只会重定位旧默认 Workspace 下明确定义的受管路径字段；聊天正文、供应商提示词和其它普通文本保持原样，用户另外注册的外部 Workspace 不会被改写。

## 下载与部署

自 1.0.9 起，应用支持在设置中检查 GitHub 最新稳定版并执行校验、暂存、替换和失败回滚，保留 `workspace/`、`runtime/` 与视频产物。更新 helper 从待安装的新包中执行，覆盖 `templates` 等运行时目录；下载断点遇到 HTTP 416 时会校验完整包并复用或从头重下。自 1.4.9 起，helper 会逐项持久化备份清单，只有完整备份后才替换文件；`Start-StarOwner.cmd` 会在 Electron 启动前读取 `.updates/operation-journal.json` 并恢复中断操作，无法安全恢复时停止启动并保留诊断结果。1.4.11 起，应用只按名称规则、数量和保留期清理自身旧 ZIP、断点、暂存目录与操作备份，活动事务、待安装包和回滚失败证据不会被例行清理；1.4.12 起，更新 ZIP 还会拒绝 Win32 盘符/UNC/设备路径、NTFS 数据流、控制字符、危险路径段、保留设备名和大小写碰撞条目。自 1.7.1 起，独立原生更新器先显示窗口并与主应用完成“就绪 -> 确认 -> 接管”双向握手，随后才允许 Electron 退出；窗口持续显示备份、替换、校验或迁移进度，并提供“中止并回退”。启动失败或握手超时不会关闭原应用，助手异常退出会调用临时回退脚本，更新日志保存在 `.updates/`。自 1.7.2 起，Release 还提供可单独下载的更新器 EXE；它可选择任意 v1.0.3 及以上旧便携目录，自动读取 latest 正式版、断点下载、SHA-256 校验、安全解压并原地启动同一事务协议。自 1.7.3 起，Release 的核心 ZIP、独立更新器 EXE 及两份 SHA-256 缺一不可；应用内更新先校验目标更新器，事务请求、EXE 内嵌版本、更新器源码和便携清单必须与目标应用完全一致。旧更新器会自动下载并移交给目标版本更新器，核心包只有通过同版本门槛后才会下载或安装。下载或解压中止时旧目录完全不变，替换中止时按日志完整回退。旧版数据也可继续通过设置中的迁移入口导入完整 workspace；迁移前应停止 Agent、关闭旧应用，并把完整项目放在较短目录中。

“B站之外”是可在设置中关闭的一级工具箱栏目。当前版本已提供多 P 视频总结、GitHub B站总结共享、单个本地视频/音频字幕、本地视频/音频压缩导入内置缓存收藏夹和本地多模态文档知识库导入；首页只展示响应式工具入口卡和实用状态数据，点击卡片后在同一内容窗口进入独占工具视图，并通过左上角按钮返回。应用只在后端服务完成启动后刷新这些工具，不会在启动过程中提前弹出多 P 服务尚未加载的错误。多 P 与共享工具在常规宽度采用左右分栏，在窄窗口自动上下排列；TTS、本地 PDF 总结等其它工具仍为后续规划，不会显示为已实现功能。

Windows 10/11 x64 用户可从 [GitHub Releases](https://github.com/Fenglin-Maple/star-owner/releases/latest) 下载便携包：

1. 只需下载 `Star-Owner-v<version>-win-x64-core.zip`；同名 `.sha256` 文件用于校验下载完整性。
2. 将 ZIP 完整解压到当前用户可写的目录，不要在压缩包预览窗口内直接运行。
3. 双击解压目录根部的 `Start-StarOwner.cmd`。应用固定使用便携包内 Electron/Node、Python、FFmpeg、yt-dlp 和 SQLite，不读取全局 Node 来执行媒体工具。
4. 首次启动若提示缺少 ASR 模型，可允许应用自动下载；也可在设置的“项目依赖包”中点击模型名称打开正确 Release，下载完整 ZIP 后直接“从本地导入”。下载中的按钮会变成“暂停”，暂停会保留 `.partial` 断点缓存，之后可继续下载；下载中或暂停时点击“从本地导入”会先中止自动下载并清理受管缓存。默认使用 `large-v3-turbo`，资源不足时可切换 `small`；如果没有 NVIDIA/CUDA，可在设置中改用独立 CPU ASR。
5. 按启动页“第一次上手”依次完成模型配置、B站登录、收藏夹同步、任务检查和 Agent 工作流创建。

更新已有便携目录时，可改为下载 `Star-Owner-Updater-v<version>-win-x64.exe` 及其 `.sha256`。更新器自身会再次校验真正安装的 core ZIP；若手中的更新器版本低于 latest，它只负责取得并启动 latest 同版本更新器。它不会安装 draft/pre-release、不会自动降级，也不会让旧更新器直接安装未来核心包；检测到旧应用仍在运行、SQLite 损坏、空间不足、版本/协议不一致、包结构异常或校验不一致时会在替换前停止。

运行时和模型 ZIP 是应用内依赖管理器使用的独立资产。设置页可以重新检查、下载或修复依赖，并可导入手动下载的 `small`、`large-v3-turbo` ZIP。`1.7.3` 继续使用 `v1.0.0` 依赖基线，接受精确名称 `Star-Owner-v1.0.0-model-small.zip` 和 `Star-Owner-v1.0.0-model-large-v3-turbo.zip`；旧版 `medium` ZIP 仍保留在该 Release 供旧应用使用。依赖管理器核对 GitHub Release SHA-256、模型类型和目录结构，并把包 ID、依赖版本、资产名、SHA-256 与 probes 写入受管清单；旧版已安装的官方 `v1.0.0` 依赖只做一次兼容认领，之后清单缺失或不匹配都会要求重新安装。核心包本身包含完整运行时（不含模型权重），新版本更新包还会在安装前核对 portable manifest、lockfile、事务脚本、原生更新器和关键运行时文件。清单与 runtime/model 目录共用 `installing -> committed` journal，中断不会留下清单与文件不一致或新旧混合版本。

每个项目副本根据其绝对项目根目录派生独立的 B 站 WebView partition。空白目录不会读取另一份星藏家的登录 Cookie；从旧版本升级时，仅当当前目录已有用户数据库记录，才会把旧固定 partition 的 B 站 Cookie 做一次兼容迁移。部分 Cookie 写入失败会标记为待重试，下次启动只补目标 partition 中缺失的 Cookie，不覆盖已有登录信息；旧 partition 不会被清空。

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

维护者发布任何正式版或 pre-release 时，都必须在同一 Release 页面同时提供该版本的 core ZIP、同版本更新器 EXE 和两份 SHA-256，并在仓库外的本地测试目录完成规定的旧版本升级、中止回退及数据完整性矩阵。应用和旧更新器主动检查更新时只读取稳定 `latest`、忽略 pre-release；用户直接下载某个 pre-release 的同版本更新器时，才允许明确更新到该 pre-release。pre-release 定向安装是后续发布前必须实现和通过测试的门禁，v1.7.3 尚未具备。完整发布门禁和当前实现边界见 [DEPLOYMENT.md](DEPLOYMENT.md#6-release-checklist)。

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
tools/updater/                      原生更新器源码、版本身份与构建脚本
templates/                          视频总结 Markdown 模板
scripts/                            测试、部署与发布验证
```

## 安全与许可

知识库 API 仅绑定 `127.0.0.1`，拒绝无关浏览器 Origin，不开放通配 CORS，没有写接口，也不提供面向不可信本机进程的认证。不要将端口映射到局域网或公网。

Bilibili Cookie 为工具兼容性必须以 Netscape 明文格式保存；账号密码和模型 API Key 使用 Electron `safeStorage`，不可用时拒绝明文保存。发布前不要提交 `workspace/`、日志、Cookie、模型密钥或私人文档。

项目采用 `GPL-3.0-or-later`。第三方组件与模型条款见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)，部署说明见 [`DEPLOYMENT.md`](DEPLOYMENT.md)，设计细节见 [`DESIGN.md`](DESIGN.md)，安全边界见 [`SECURITY.md`](SECURITY.md)。
