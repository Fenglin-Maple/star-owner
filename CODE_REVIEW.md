# 星藏家代码审查记录

审查日期：2026-07-11

## 已修复问题

1. **严重：异步 HTTP 异常可逃逸路由错误处理。** API 服务现在拥有统一 Promise 错误边界，格式错误或超限请求不会形成未处理拒绝。
2. **严重：本地 API 开放通配 CORS。** 已拒绝无关浏览器 Origin，并移除 `Access-Control-Allow-Origin: *`。
3. **高：HTTP JSON 请求体无大小上限。** 现在限制为 1 MiB，超限返回 HTTP `413`。
4. **高：WebView 缺少域名和弹窗边界。** 主窗口与 WebView 已启用沙箱、导航白名单、弹窗阻断和 CSP。
5. **高：伪装成 Bilibili 的 URL 可触发任意网络请求。** 视频解析只允许 `bilibili.com`、`b23.tv` 及其子域，并逐次校验重定向。
6. **高：系统加密不可用时密码明文回退。** 新密码与 API Key 保存现在直接拒绝，不再明文写入 SQLite。
7. **中：同一 BV 可被并发重复下载。** 同收藏夹/BV 的活跃下载任务现在复用同一 Job。
8. **中：提交验证无文件大小和文件类型边界。** Markdown/JSON 限制为普通非符号链接文件，并分别限制为 16 MiB/4 MiB。
9. **中：sql.js 数据库直接覆盖写入。** 改为临时文件、刷新、备份和恢复流程，降低中断损坏风险。
10. **维护性：API、收藏夹同步和产物归档互相耦合。** 收藏夹同步、产物整理、网络策略、窗口策略、媒体错误和原子写入已拆成独立模块；内置 Agent 不再反向依赖 API Server。
11. **维护性：测试状态会污染后续运行。** Smoke 测试现在清理数据库恢复文件和依赖夹，并新增安全、持久化与收藏夹同步测试。

## 保留风险

- 本地 API 没有面向不可信本机进程的强认证，Worker ID 不是安全令牌；不得把端口映射到局域网或公网。
- RAG 助手的“完全访问”模式允许模型访问沙盒外文件并执行命令，只应在可信模型与明确任务下开启。
- Bilibili Cookie 导出文件必须是明文 Netscape 格式才能供 yt-dlp 使用，应保护 Workspace，不要同步到公开网盘或 Git。
- sql.js 仍采用整库导出，超大任务库的写入成本会随数据库体积增长；未来规模明显扩大时应评估原生 SQLite 驱动和 WAL。
- Bilibili 官方接口仍可能触发限流或策略变化，调度器只能降低突发频率，不能保证第三方服务长期稳定。

## 验证入口

```powershell
npm run verify:release
npm run test:security
npm run test:persistence
npm run test:collection-sync
npm run test:video-cache
```
