using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace StarOwnerUpdater
{
    internal static class StandaloneUpdaterBootstrap
    {
        private static readonly string TempRoot = Path.Combine(Path.GetTempPath(), "StarOwner", "standalone-updater");

        public static int LaunchRelocated()
        {
            try
            {
                CleanupOldCopies();
                string directory = Path.Combine(TempRoot, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(directory);
                string source = Application.ExecutablePath;
                string destination = Path.Combine(directory, "Star-Owner-Updater.exe");
                File.Copy(source, destination, true);
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = destination;
                info.Arguments = "--standalone-child";
                info.WorkingDirectory = directory;
                info.UseShellExecute = true;
                Process.Start(info);
                return 0;
            }
            catch (Exception error)
            {
                MessageBox.Show("无法启动独立更新器：\r\n" + error.Message, "星藏家更新器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 20;
            }
        }

        private static void CleanupOldCopies()
        {
            try
            {
                if (!Directory.Exists(TempRoot)) return;
                foreach (string directory in Directory.GetDirectories(TempRoot))
                {
                    try
                    {
                        DirectoryInfo info = new DirectoryInfo(directory);
                        if (DateTime.UtcNow - info.LastWriteTimeUtc > TimeSpan.FromDays(2D)) Directory.Delete(directory, true);
                    }
                    catch { }
                }
            }
            catch { }
        }
    }

    internal static class StandaloneUpdaterCommands
    {
        public static bool TryRun(string[] args, out int exitCode)
        {
            exitCode = 0;
            if (args == null || args.Length == 0) return false;
            string command = args[0] ?? String.Empty;
            if (String.Equals(command, "--standalone-preview", StringComparison.OrdinalIgnoreCase))
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (args.Length < 2) { exitCode = 21; return true; }
                Application.Run(new StandaloneUpdaterForm(true, args[1]));
                return true;
            }
            if (!command.StartsWith("--standalone-test-", StringComparison.OrdinalIgnoreCase)) return false;
            try
            {
                if (String.Equals(command, "--standalone-test-inspect", StringComparison.OrdinalIgnoreCase))
                {
                    RequireArguments(args, 3);
                    StandaloneUpdateService service = new StandaloneUpdateService(args[1], StandaloneUpdateService.DefaultReleaseApi, null, null);
                    InstalledProject project = service.InspectTarget(true);
                    WriteResult(args[2], project.ToDictionary(true));
                }
                else if (String.Equals(command, "--standalone-test-release", StringComparison.OrdinalIgnoreCase))
                {
                    RequireArguments(args, 3);
                    StandaloneRelease release = StandaloneRelease.Parse(File.ReadAllText(args[1], Encoding.UTF8));
                    WriteResult(args[2], release.ToDictionary());
                }
                else if (String.Equals(command, "--standalone-test-entries", StringComparison.OrdinalIgnoreCase))
                {
                    RequireArguments(args, 4);
                    List<StandaloneArchiveEntry> entries = new List<StandaloneArchiveEntry>();
                    foreach (string line in File.ReadAllLines(args[1], Encoding.UTF8))
                    {
                        if (!String.IsNullOrWhiteSpace(line)) entries.Add(new StandaloneArchiveEntry(line.Trim(), false, 1L, 1L, 0));
                    }
                    StandaloneArchivePlan plan = StandaloneArchiveSecurity.Validate(entries, args[2]);
                    WriteResult(args[3], plan.ToDictionary());
                }
                else if (String.Equals(command, "--standalone-test-prepare", StringComparison.OrdinalIgnoreCase)
                    || String.Equals(command, "--standalone-test-install", StringComparison.OrdinalIgnoreCase))
                {
                    RequireArguments(args, 4);
                    string cancelFile = args.Length >= 5 ? args[4] : String.Empty;
                    Func<bool> cancelled = delegate { return !String.IsNullOrEmpty(cancelFile) && File.Exists(cancelFile); };
                    StandaloneUpdateService service = new StandaloneUpdateService(args[1], args[2], null, cancelled);
                    StandalonePreparedUpdate prepared = service.Prepare();
                    Dictionary<string, object> result = prepared.ToDictionary();
                    if (String.Equals(command, "--standalone-test-install", StringComparison.OrdinalIgnoreCase))
                    {
                        ControllerHandoff handoff = service.LaunchController(prepared, true, true);
                        result["operationId"] = handoff.OperationId;
                        result["updaterPid"] = handoff.UpdaterPid;
                        result["accepted"] = true;
                    }
                    WriteResult(args[3], result);
                }
                else
                {
                    return false;
                }
                exitCode = 0;
            }
            catch (OperationCanceledException error)
            {
                if (args.Length >= 4) WriteError(args[3], "cancelled", error.Message);
                exitCode = 22;
            }
            catch (Exception error)
            {
                string output = args.Length >= 4 ? args[3] : (args.Length >= 3 ? args[2] : String.Empty);
                if (!String.IsNullOrEmpty(output)) WriteError(output, "error", error.Message);
                exitCode = 23;
            }
            return true;
        }

        private static void RequireArguments(string[] args, int count)
        {
            if (args.Length < count) throw new ArgumentException("Standalone updater test command is missing arguments.");
        }

        private static void WriteResult(string path, IDictionary<string, object> values)
        {
            Dictionary<string, object> result = new Dictionary<string, object>(values);
            result["ok"] = true;
            JsonFiles.WriteObjectAtomic(path, result);
        }

        private static void WriteError(string path, string status, string message)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = false;
            result["status"] = status;
            result["message"] = message;
            try { JsonFiles.WriteObjectAtomic(path, result); } catch { }
        }
    }

    internal sealed class InstalledProject
    {
        public string Root;
        public string Version;
        public bool HasWorkspace;
        public bool HasDatabase;
        public long DatabaseBytes;
        public bool HasModels;
        public bool HasSharedGitCredentials;

        public Dictionary<string, object> ToDictionary(bool includeRoot)
        {
            Dictionary<string, object> value = new Dictionary<string, object>();
            if (includeRoot) value["root"] = Root;
            value["version"] = Version;
            value["hasWorkspace"] = HasWorkspace;
            value["hasDatabase"] = HasDatabase;
            value["databaseBytes"] = DatabaseBytes;
            value["hasModels"] = HasModels;
            value["hasSharedGitCredentials"] = HasSharedGitCredentials;
            return value;
        }
    }

    internal sealed class StandaloneRelease
    {
        public string Version;
        public string Name;
        public string PageUrl;
        public string PublishedAt;
        public string AssetName;
        public string AssetUrl;
        public long AssetSize;
        public string Checksum;
        public string ChecksumUrl;

        public static StandaloneRelease Parse(string json)
        {
            Dictionary<string, object> release = JsonFiles.SerializerDeserialize(json);
            if (JsonFiles.BoolValue(release, "draft") || JsonFiles.BoolValue(release, "prerelease")) throw new InvalidDataException("GitHub latest 指向的不是稳定正式版，已拒绝自动安装。");
            string version = JsonFiles.StringValue(release, "tag_name").Trim();
            if (version.StartsWith("v", StringComparison.OrdinalIgnoreCase)) version = version.Substring(1);
            if (!Regex.IsMatch(version, "^[0-9]+\\.[0-9]+\\.[0-9]+$")) throw new InvalidDataException("GitHub Release 版本号不是有效的三段式版本。");
            string expectedName = "Star-Owner-v" + version + "-win-x64-core.zip";
            Dictionary<string, object> asset = null;
            Dictionary<string, object> checksumAsset = null;
            foreach (Dictionary<string, object> candidate in JsonFiles.ObjectList(release, "assets"))
            {
                string name = JsonFiles.StringValue(candidate, "name");
                if (String.Equals(name, expectedName, StringComparison.OrdinalIgnoreCase)) asset = candidate;
                if (String.Equals(name, expectedName + ".sha256", StringComparison.OrdinalIgnoreCase)) checksumAsset = candidate;
            }
            if (asset == null) throw new InvalidDataException("Release v" + version + " 中没有找到 " + expectedName + "。");
            string digest = JsonFiles.StringValue(asset, "digest");
            Match digestMatch = Regex.Match(digest, "^sha256:([0-9a-f]{64})$", RegexOptions.IgnoreCase);
            StandaloneRelease value = new StandaloneRelease();
            value.Version = version;
            value.Name = JsonFiles.StringValue(release, "name");
            value.PageUrl = JsonFiles.StringValue(release, "html_url");
            value.PublishedAt = JsonFiles.StringValue(release, "published_at");
            value.AssetName = expectedName;
            value.AssetUrl = JsonFiles.StringValue(asset, "browser_download_url");
            value.AssetSize = JsonFiles.LongValue(asset, "size");
            value.Checksum = digestMatch.Success ? digestMatch.Groups[1].Value.ToLowerInvariant() : String.Empty;
            value.ChecksumUrl = checksumAsset == null ? String.Empty : JsonFiles.StringValue(checksumAsset, "browser_download_url");
            if (String.IsNullOrWhiteSpace(value.AssetUrl)) throw new InvalidDataException("核心包缺少有效的下载地址。");
            return value;
        }

        public Dictionary<string, object> ToDictionary()
        {
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["version"] = Version;
            value["name"] = Name;
            value["pageUrl"] = PageUrl;
            value["publishedAt"] = PublishedAt;
            value["assetName"] = AssetName;
            value["assetUrl"] = AssetUrl;
            value["assetSize"] = AssetSize;
            value["checksum"] = Checksum;
            value["checksumUrl"] = ChecksumUrl;
            return value;
        }
    }

    internal sealed class StandalonePreparedUpdate
    {
        public InstalledProject Project;
        public StandaloneRelease Release;
        public string ArchivePath;
        public string StagingRoot;
        public string PackageRoot;

        public Dictionary<string, object> ToDictionary()
        {
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["project"] = Project.ToDictionary(true);
            value["release"] = Release.ToDictionary();
            value["archivePath"] = ArchivePath;
            value["stagingRoot"] = StagingRoot;
            value["packageRoot"] = PackageRoot;
            return value;
        }
    }

    internal sealed class ControllerHandoff
    {
        public string OperationId;
        public int UpdaterPid;
    }

    internal sealed class StandaloneProgressInfo
    {
        public string Phase;
        public string Status;
        public string Detail;
        public double Progress;
        public long CompletedBytes;
        public long TotalBytes;
    }

    internal sealed class StandaloneArchiveEntry
    {
        public readonly string Name;
        public readonly bool IsDirectory;
        public readonly long Length;
        public readonly long CompressedLength;
        public readonly int ExternalAttributes;

        public StandaloneArchiveEntry(string name, bool isDirectory, long length, long compressedLength, int externalAttributes)
        {
            Name = name;
            IsDirectory = isDirectory;
            Length = length;
            CompressedLength = compressedLength;
            ExternalAttributes = externalAttributes;
        }
    }

    internal sealed class StandaloneArchivePlan
    {
        public string Prefix;
        public long TotalBytes;
        public int EntryCount;

        public Dictionary<string, object> ToDictionary()
        {
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["prefix"] = Prefix;
            value["totalBytes"] = TotalBytes;
            value["entryCount"] = EntryCount;
            return value;
        }
    }
}

namespace StarOwnerUpdater
{
    internal sealed class StandaloneUpdaterForm : Form
    {
        private readonly bool previewMode;
        private readonly string previewPath;
        private readonly AnimatedLogo animation;
        private readonly SmoothProgress progressBar;
        private readonly TextBox pathBox;
        private readonly Button browseButton;
        private readonly Button detectButton;
        private readonly Button startButton;
        private readonly Button cancelButton;
        private readonly Button logButton;
        private readonly Label currentVersionLabel;
        private readonly Label latestVersionLabel;
        private readonly Label dataLabel;
        private readonly Label statusLabel;
        private readonly Label detailLabel;
        private readonly Label percentLabel;
        private readonly Label elapsedLabel;
        private readonly System.Windows.Forms.Timer animationTimer;
        private readonly System.Windows.Forms.Timer elapsedTimer;
        private volatile bool cancellationRequested;
        private bool operationActive;
        private bool handoffAccepted;
        private bool closeRequested;
        private int generation;
        private int animationFrame;
        private DateTime operationStarted;
        private InstalledProject inspectedProject;
        private StandaloneRelease inspectedRelease;
        private StandaloneUpdateService activeService;
        private string logPath = String.Empty;
        private readonly object logLock = new object();

        public StandaloneUpdaterForm(bool preview, string outputPath)
        {
            previewMode = preview;
            previewPath = outputPath;
            Text = "星藏家独立更新器";
            ClientSize = new Size(760, 720);
            MinimumSize = new Size(776, 759);
            MaximumSize = new Size(776, 759);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(247, 252, 255);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            DoubleBuffered = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            Label title = MakeLabel(new Rectangle(36, 20, 688, 37), 20F, FontStyle.Bold, Color.FromArgb(26, 55, 83));
            title.Text = "把旧版星藏家安全更新到最新版";
            Controls.Add(title);
            Label subtitle = MakeLabel(new Rectangle(36, 57, 688, 27), 9.5F, FontStyle.Regular, Color.FromArgb(83, 112, 134));
            subtitle.Text = "选择旧项目根目录，更新器会自动下载 latest 正式版并原地继承全部用户数据";
            Controls.Add(subtitle);

            string logoPath = String.Empty;
            try { logoPath = EmbeddedUpdaterAssets.ExtractPreviewLogo(); } catch { }
            animation = new AnimatedLogo(logoPath);
            animation.Location = new Point(36, 83);
            animation.Size = new Size(688, 154);
            animation.BackColor = BackColor;
            Controls.Add(animation);

            Label pathTitle = MakeLabel(new Rectangle(36, 238, 688, 25), 10F, FontStyle.Bold, Color.FromArgb(37, 76, 102));
            pathTitle.Text = "旧版星藏家目录";
            Controls.Add(pathTitle);
            pathBox = new TextBox();
            pathBox.Location = new Point(36, 267);
            pathBox.Size = new Size(482, 29);
            pathBox.Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            pathBox.BorderStyle = BorderStyle.FixedSingle;
            pathBox.TextChanged += delegate
            {
                if (operationActive || inspectedProject == null) return;
                string current = pathBox.Text.Trim().Trim('"');
                string normalized = String.Empty;
                try { normalized = Path.GetFullPath(String.IsNullOrWhiteSpace(current) ? Environment.CurrentDirectory : current); } catch { }
                if (!String.Equals(normalized, inspectedProject.Root, StringComparison.OrdinalIgnoreCase))
                {
                    inspectedProject = null;
                    inspectedRelease = null;
                    startButton.Enabled = false;
                    currentVersionLabel.Text = "等待检测";
                    latestVersionLabel.Text = "尚未检查";
                    dataLabel.Text = "目录变化后需要重新检查";
                    statusLabel.Text = "请重新检测旧项目目录";
                    detailLabel.Text = "只有完成目录与 latest 检查后才能开始更新。";
                }
            };
            pathBox.KeyDown += delegate(object sender, KeyEventArgs args) { if (args.KeyCode == Keys.Enter) { args.SuppressKeyPress = true; BeginInspection(); } };
            Controls.Add(pathBox);
            browseButton = MakeButton(new Rectangle(528, 264, 92, 34), "选择目录", Color.FromArgb(236, 248, 253), Color.FromArgb(26, 103, 148), Color.FromArgb(139, 199, 225));
            browseButton.Click += delegate { ChooseDirectory(); };
            Controls.Add(browseButton);
            detectButton = MakeButton(new Rectangle(630, 264, 94, 34), "检测版本", Color.FromArgb(248, 252, 255), Color.FromArgb(59, 91, 111), Color.FromArgb(183, 207, 220));
            detectButton.Click += delegate { BeginInspection(); };
            Controls.Add(detectButton);

            Panel separator = new Panel();
            separator.Location = new Point(36, 315);
            separator.Size = new Size(688, 1);
            separator.BackColor = Color.FromArgb(207, 226, 236);
            Controls.Add(separator);

            Label versionTitle = MakeLabel(new Rectangle(36, 329, 165, 22), 8.5F, FontStyle.Regular, Color.FromArgb(111, 132, 146));
            versionTitle.Text = "检测到的旧版本";
            Controls.Add(versionTitle);
            currentVersionLabel = MakeLabel(new Rectangle(36, 351, 165, 31), 13F, FontStyle.Bold, Color.FromArgb(34, 82, 113));
            currentVersionLabel.Text = preview ? "v1.6.2" : "等待选择";
            Controls.Add(currentVersionLabel);
            Label latestTitle = MakeLabel(new Rectangle(222, 329, 165, 22), 8.5F, FontStyle.Regular, Color.FromArgb(111, 132, 146));
            latestTitle.Text = "GitHub latest";
            Controls.Add(latestTitle);
            latestVersionLabel = MakeLabel(new Rectangle(222, 351, 165, 31), 13F, FontStyle.Bold, Color.FromArgb(31, 137, 106));
            latestVersionLabel.Text = preview ? "v1.7.2" : "尚未检查";
            Controls.Add(latestVersionLabel);
            Label dataTitle = MakeLabel(new Rectangle(408, 329, 316, 22), 8.5F, FontStyle.Regular, Color.FromArgb(111, 132, 146));
            dataTitle.Text = "安全继承检查";
            Controls.Add(dataTitle);
            dataLabel = MakeLabel(new Rectangle(408, 351, 316, 31), 9.3F, FontStyle.Bold, Color.FromArgb(47, 100, 128));
            dataLabel.Text = preview ? "Workspace、模型、登录状态均会保留" : "选择目录后自动检查";
            Controls.Add(dataLabel);

            Panel inheritanceBand = new Panel();
            inheritanceBand.Location = new Point(36, 397);
            inheritanceBand.Size = new Size(688, 44);
            inheritanceBand.BackColor = Color.FromArgb(231, 246, 250);
            Controls.Add(inheritanceBand);
            Label inheritance = MakeLabel(new Rectangle(14, 0, 660, 44), 9F, FontStyle.Regular, Color.FromArgb(44, 94, 119));
            inheritance.Text = "原路径不变  ·  保留 Workspace / 收藏夹 / RAG / 模型 / 缓存 / B站登录 / GitHub 私有凭据";
            inheritanceBand.Controls.Add(inheritance);

            statusLabel = MakeLabel(new Rectangle(36, 459, 688, 31), 13F, FontStyle.Bold, Color.FromArgb(27, 102, 150));
            statusLabel.Text = preview ? "正在下载并验证最新正式版" : "请选择旧版星藏家目录";
            Controls.Add(statusLabel);
            detailLabel = MakeLabel(new Rectangle(36, 491, 688, 43), 9.4F, FontStyle.Regular, Color.FromArgb(75, 98, 116));
            detailLabel.Text = preview ? "新版本通过 SHA-256 与安全解压检查后，才会进入事务替换阶段。" : "支持 v1.0.3 及以上正式版和历史 pre-release 便携目录。";
            Controls.Add(detailLabel);
            progressBar = new SmoothProgress();
            progressBar.Location = new Point(36, 548);
            progressBar.Size = new Size(620, 14);
            progressBar.Value = preview ? 0.58D : 0D;
            Controls.Add(progressBar);
            percentLabel = MakeLabel(new Rectangle(664, 538, 60, 31), 9.5F, FontStyle.Bold, Color.FromArgb(27, 102, 150));
            percentLabel.TextAlign = ContentAlignment.MiddleRight;
            percentLabel.Text = preview ? "58%" : "0%";
            Controls.Add(percentLabel);
            elapsedLabel = MakeLabel(new Rectangle(36, 575, 400, 22), 8.5F, FontStyle.Regular, Color.FromArgb(111, 132, 146));
            elapsedLabel.Text = "尚未开始更新";
            Controls.Add(elapsedLabel);

            logButton = MakeButton(new Rectangle(36, 644, 132, 42), "打开更新日志", Color.FromArgb(247, 252, 255), Color.FromArgb(40, 110, 151), Color.FromArgb(154, 204, 228));
            logButton.Enabled = false;
            logButton.Click += delegate { OpenLog(); };
            Controls.Add(logButton);
            startButton = MakeButton(new Rectangle(369, 644, 174, 42), "开始安全更新", Color.FromArgb(226, 247, 241), Color.FromArgb(27, 126, 95), Color.FromArgb(120, 199, 174));
            startButton.Enabled = preview;
            startButton.Click += delegate { BeginUpdate(); };
            Controls.Add(startButton);
            cancelButton = MakeButton(new Rectangle(553, 644, 171, 42), "关闭", Color.FromArgb(255, 240, 243), Color.FromArgb(190, 57, 83), Color.FromArgb(235, 143, 160));
            cancelButton.Click += delegate { CancelOrClose(); };
            Controls.Add(cancelButton);

            animationTimer = new System.Windows.Forms.Timer();
            animationTimer.Interval = 33;
            animationTimer.Tick += delegate
            {
                animationFrame++;
                animation.Frame = animationFrame;
                progressBar.Frame = animationFrame;
                animation.Invalidate();
                progressBar.Invalidate();
            };
            elapsedTimer = new System.Windows.Forms.Timer();
            elapsedTimer.Interval = 500;
            elapsedTimer.Tick += delegate
            {
                if (!operationActive) return;
                TimeSpan elapsed = DateTime.UtcNow - operationStarted;
                elapsedLabel.Text = "已用时 " + ((int)elapsed.TotalMinutes).ToString("00", CultureInfo.InvariantCulture) + ":" + elapsed.Seconds.ToString("00", CultureInfo.InvariantCulture);
            };
            Shown += delegate { OnShown(); };
            FormClosing += OnClosing;
        }

        private void OnShown()
        {
            animationTimer.Start();
            if (!previewMode) return;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 700;
            timer.Tick += delegate
            {
                timer.Stop();
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(previewPath)));
                using (Bitmap bitmap = new Bitmap(ClientSize.Width, ClientSize.Height))
                {
                    DrawToBitmap(bitmap, new Rectangle(Point.Empty, ClientSize));
                    bitmap.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png);
                }
                closeRequested = true;
                Close();
            };
            timer.Start();
        }

        private void ChooseDirectory()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "请选择包含 Start-StarOwner.cmd 的旧版星藏家根目录";
                dialog.ShowNewFolderButton = false;
                if (Directory.Exists(pathBox.Text)) dialog.SelectedPath = pathBox.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    pathBox.Text = dialog.SelectedPath;
                    BeginInspection();
                }
            }
        }

        private void BeginInspection()
        {
            if (operationActive) return;
            string root = pathBox.Text.Trim().Trim('"');
            if (String.IsNullOrWhiteSpace(root)) { MessageBox.Show(this, "请先选择旧版星藏家目录。", "尚未选择目录", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            generation++;
            int currentGeneration = generation;
            cancellationRequested = false;
            operationActive = true;
            operationStarted = DateTime.UtcNow;
            inspectedProject = null;
            inspectedRelease = null;
            SetSelectionEnabled(false);
            startButton.Enabled = false;
            cancelButton.Text = "停止检测";
            statusLabel.Text = "正在检查旧项目与 GitHub latest";
            statusLabel.ForeColor = Color.FromArgb(27, 102, 150);
            detailLabel.Text = "更新器会确认目录完整、数据库有效、旧应用已关闭且目录可写。";
            progressBar.Value = 0.02D;
            progressBar.Indeterminate = true;
            percentLabel.Text = "检查中";
            elapsedTimer.Start();
            Thread worker = new Thread(new ThreadStart(delegate
            {
                try
                {
                    StandaloneUpdateService service = new StandaloneUpdateService(root, StandaloneUpdateService.DefaultReleaseApi, ApplyProgress, IsCancellationRequested);
                    activeService = service;
                    InstalledProject project = service.InspectTarget(true);
                    StandaloneRelease release = service.FetchLatest();
                    SafeUi(delegate
                    {
                        if (currentGeneration != generation) return;
                        inspectedProject = project;
                        inspectedRelease = release;
                        currentVersionLabel.Text = "v" + project.Version;
                        latestVersionLabel.Text = "v" + release.Version;
                        dataLabel.Text = project.HasDatabase ? "已确认 Workspace 数据库有效" : "未发现数据库，将保留现有目录";
                        bool available = StandaloneUpdateService.CompareVersions(release.Version, project.Version) > 0;
                        statusLabel.Text = available ? "可以安全更新到 v" + release.Version : "当前目录已是最新稳定版本";
                        detailLabel.Text = available ? "点击“开始安全更新”后自动下载、校验、解压并由事务更新器接管。" : "不会自动降级或重复覆盖同一稳定版本。";
                        progressBar.Indeterminate = false;
                        progressBar.Value = 1D;
                        percentLabel.Text = "100%";
                        startButton.Enabled = available;
                        FinishBackgroundOperation();
                    });
                }
                catch (OperationCanceledException)
                {
                    SafeUi(delegate { if (currentGeneration == generation) { statusLabel.Text = "检测已停止"; detailLabel.Text = "旧项目没有发生任何变化。"; FinishBackgroundOperation(); } });
                }
                catch (Exception error)
                {
                    SafeUi(delegate { if (currentGeneration == generation) ShowOperationError("无法使用所选目录", error); });
                }
                finally { activeService = null; }
            }));
            worker.IsBackground = true;
            worker.Name = "StarOwnerStandaloneInspect";
            worker.Start();
        }

        private void BeginUpdate()
        {
            if (operationActive || inspectedProject == null || inspectedRelease == null) return;
            DialogResult answer = MessageBox.Show(this,
                "将把当前目录从 v" + inspectedProject.Version + " 更新到 v" + inspectedRelease.Version + "。\r\n\r\n"
                + "Workspace、收藏夹、RAG 文档、模型、缓存、登录状态和 GitHub 私有凭据都会原地保留。\r\n"
                + "替换阶段可随时点击“中止并安全回退”。继续吗？",
                "开始安全更新", MessageBoxButtons.YesNo, MessageBoxIcon.Information, MessageBoxDefaultButton.Button1);
            if (answer != DialogResult.Yes) return;
            string root = inspectedProject.Root;
            generation++;
            int currentGeneration = generation;
            cancellationRequested = false;
            operationActive = true;
            operationStarted = DateTime.UtcNow;
            SetSelectionEnabled(false);
            startButton.Enabled = false;
            cancelButton.Text = "中止并安全回退";
            statusLabel.Text = "正在准备最新正式版";
            statusLabel.ForeColor = Color.FromArgb(27, 102, 150);
            detailLabel.Text = "下载与解压期间不会修改旧项目核心文件。";
            progressBar.Indeterminate = false;
            progressBar.Value = 0.01D;
            percentLabel.Text = "1%";
            elapsedTimer.Start();
            logPath = Path.Combine(root, ".updates", "standalone-updater.log");
            logButton.Enabled = true;
            AppendLog("Standalone update started: " + inspectedProject.Version + " -> " + inspectedRelease.Version);
            Thread worker = new Thread(new ThreadStart(delegate
            {
                try
                {
                    StandaloneUpdateService service = new StandaloneUpdateService(root, StandaloneUpdateService.DefaultReleaseApi, ApplyProgress, IsCancellationRequested);
                    activeService = service;
                    StandalonePreparedUpdate prepared = service.Prepare();
                    if (IsCancellationRequested()) throw new OperationCanceledException();
                    SafeUi(delegate { statusLabel.Text = "正在启动事务更新器"; detailLabel.Text = "接管完成后，本窗口退出，文件替换才会开始。"; progressBar.Indeterminate = true; percentLabel.Text = "接管中"; cancelButton.Enabled = false; });
                    ControllerHandoff handoff = service.LaunchController(prepared, false, false);
                    AppendLog("Transaction controller accepted operation " + handoff.OperationId + " (PID " + handoff.UpdaterPid.ToString(CultureInfo.InvariantCulture) + ").");
                    SafeUi(delegate
                    {
                        if (currentGeneration != generation) return;
                        handoffAccepted = true;
                        progressBar.Indeterminate = false;
                        progressBar.Value = 1D;
                        percentLabel.Text = "100%";
                        statusLabel.Text = "安全更新器已接管";
                        detailLabel.Text = "请在新的更新器窗口查看替换进度；本窗口即将退出。";
                        elapsedTimer.Stop();
                        System.Windows.Forms.Timer closer = new System.Windows.Forms.Timer();
                        closer.Interval = 700;
                        closer.Tick += delegate { closer.Stop(); closeRequested = true; Close(); };
                        closer.Start();
                    });
                }
                catch (OperationCanceledException error)
                {
                    AppendLog("Preparation cancelled: " + error.Message);
                    SafeUi(delegate
                    {
                        if (currentGeneration != generation) return;
                        statusLabel.Text = "更新已安全停止";
                        detailLabel.Text = "旧项目没有发生变化；已下载的断点文件将在下次继续使用。";
                        progressBar.Indeterminate = false;
                        cancelButton.Enabled = true;
                        FinishBackgroundOperation();
                    });
                }
                catch (Exception error)
                {
                    AppendLog("Standalone update failed: " + error);
                    SafeUi(delegate { if (currentGeneration == generation) ShowOperationError("更新没有开始替换", error); });
                }
                finally { activeService = null; }
            }));
            worker.IsBackground = true;
            worker.Name = "StarOwnerStandalonePrepare";
            worker.Start();
        }

        private void ApplyProgress(StandaloneProgressInfo info)
        {
            if (info == null) return;
            AppendLog(info.Phase + " | " + info.Status + " | " + info.Detail);
            SafeUi(delegate
            {
                statusLabel.Text = info.Status;
                detailLabel.Text = info.Detail;
                progressBar.Indeterminate = false;
                progressBar.Value = info.Progress;
                percentLabel.Text = ((int)Math.Round(info.Progress * 100D)).ToString(CultureInfo.InvariantCulture) + "%";
            });
        }

        private void FinishBackgroundOperation()
        {
            operationActive = false;
            elapsedTimer.Stop();
            progressBar.Indeterminate = false;
            cancelButton.Enabled = true;
            cancelButton.Text = "关闭";
            SetSelectionEnabled(true);
        }

        private void ShowOperationError(string heading, Exception error)
        {
            statusLabel.Text = heading;
            detailLabel.Text = error.Message;
            statusLabel.ForeColor = Color.FromArgb(184, 63, 83);
            progressBar.Indeterminate = false;
            percentLabel.Text = "失败";
            FinishBackgroundOperation();
        }

        private void SetSelectionEnabled(bool enabled)
        {
            pathBox.Enabled = enabled;
            browseButton.Enabled = enabled;
            detectButton.Enabled = enabled;
        }

        private void CancelOrClose()
        {
            if (!operationActive)
            {
                closeRequested = true;
                Close();
                return;
            }
            if (cancellationRequested || handoffAccepted) return;
            DialogResult answer = MessageBox.Show(this, "确定停止当前操作吗？\r\n\r\n若已进入替换阶段，新的事务更新器会负责完整回退。", "中止并安全回退", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            cancellationRequested = true;
            StandaloneUpdateService service = activeService;
            if (service != null) service.Cancel();
            cancelButton.Enabled = false;
            cancelButton.Text = "正在安全停止...";
            statusLabel.Text = "正在中止当前步骤";
            detailLabel.Text = "请保持窗口开启，直到确认旧项目没有变化或回退完成。";
            progressBar.Indeterminate = true;
        }

        private void OnClosing(object sender, FormClosingEventArgs args)
        {
            if (previewMode || closeRequested || handoffAccepted || !operationActive) return;
            args.Cancel = true;
            CancelOrClose();
        }

        private bool IsCancellationRequested()
        {
            return cancellationRequested;
        }

        private void SafeUi(MethodInvoker action)
        {
            try
            {
                if (IsDisposed || Disposing) return;
                if (InvokeRequired) BeginInvoke(action); else action();
            }
            catch { }
        }

        private void AppendLog(string message)
        {
            if (String.IsNullOrEmpty(logPath)) return;
            try
            {
                lock (logLock)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(logPath));
                    File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { }
        }

        private void OpenLog()
        {
            if (String.IsNullOrEmpty(logPath)) return;
            try
            {
                if (!File.Exists(logPath)) File.WriteAllText(logPath, String.Empty, new UTF8Encoding(false));
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = logPath;
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch (Exception error) { MessageBox.Show(this, error.Message, "无法打开日志", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }

        private Label MakeLabel(Rectangle bounds, float size, FontStyle style, Color color)
        {
            Label label = new Label();
            label.Bounds = bounds;
            label.Font = new Font("Microsoft YaHei UI", size, style, GraphicsUnit.Point);
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            label.AutoEllipsis = true;
            label.TextAlign = ContentAlignment.MiddleLeft;
            return label;
        }

        private Button MakeButton(Rectangle bounds, string text, Color back, Color fore, Color border)
        {
            Button button = new Button();
            button.Bounds = bounds;
            button.Text = text;
            button.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold, GraphicsUnit.Point);
            button.BackColor = back;
            button.ForeColor = fore;
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = border;
            button.Cursor = Cursors.Hand;
            button.TabStop = false;
            return button;
        }
    }
}

namespace StarOwnerUpdater
{
    internal sealed class StandaloneUpdateService
    {
        public const string DefaultReleaseApi = "https://api.github.com/repos/Fenglin-Maple/star-owner/releases/latest";
        private readonly string projectRoot;
        private readonly string releaseApi;
        private readonly Action<StandaloneProgressInfo> progress;
        private readonly Func<bool> cancellationRequested;
        private DateTime lastProgressAt = DateTime.MinValue;
        private volatile bool explicitlyCancelled;
        private HttpWebRequest activeRequest;

        public StandaloneUpdateService(string root, string api, Action<StandaloneProgressInfo> progressCallback, Func<bool> cancelled)
        {
            projectRoot = Path.GetFullPath(root ?? String.Empty).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            releaseApi = String.IsNullOrWhiteSpace(api) ? DefaultReleaseApi : api;
            progress = progressCallback;
            cancellationRequested = cancelled;
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
        }

        public InstalledProject InspectTarget(bool checkProcesses)
        {
            ThrowIfCancelled();
            if (String.IsNullOrWhiteSpace(projectRoot) || !Directory.Exists(projectRoot)) throw new DirectoryNotFoundException("请选择已经完整解压过的旧版星藏家目录。");
            if (projectRoot.Length > 170) throw new PathTooLongException("旧项目目录过深。请先把整个项目目录移动到更短的位置，例如 D:\\Star-Owner，再进行更新。");
            RequireFile("package.json", "所选目录缺少 package.json，不是可识别的星藏家便携目录。");
            RequireFile("Start-StarOwner.cmd", "所选目录缺少 Start-StarOwner.cmd，请选择完整解压后的星藏家根目录。");
            RequireFile(Path.Combine("node_modules", "electron", "dist", "electron.exe"), "所选目录缺少内置 Electron，可能没有完整解压。");
            Dictionary<string, object> package = JsonFiles.ReadObject(Path.Combine(projectRoot, "package.json"));
            if (!String.Equals(JsonFiles.StringValue(package, "name"), "star-owner", StringComparison.Ordinal)) throw new InvalidDataException("所选目录的应用标识不是星藏家。");
            string version = JsonFiles.StringValue(package, "version");
            if (!Regex.IsMatch(version, "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")) throw new InvalidDataException("无法识别旧项目版本号。");
            if (CompareVersions(version, "1.0.3") < 0) throw new InvalidDataException("独立更新器支持 v1.0.3 及以上便携版本；更早版本请先手动迁移完整项目目录。");
            if (checkProcesses)
            {
                List<int> running = FindRunningProjectProcesses();
                if (running.Count > 0) throw new InvalidOperationException("所选目录中的星藏家仍在运行（PID " + String.Join(", ", running.ConvertAll(delegate(int value) { return value.ToString(CultureInfo.InvariantCulture); }).ToArray()) + "）。请先关闭旧应用和所有 Agent。");
            }
            VerifyWritable();
            string workspace = Path.Combine(projectRoot, "workspace");
            string database = Path.Combine(workspace, "orchestrator.sqlite");
            long databaseBytes = 0L;
            if (File.Exists(database))
            {
                FileInfo info = new FileInfo(database);
                databaseBytes = info.Length;
                if (databaseBytes < 16L) throw new InvalidDataException("旧项目的 workspace/orchestrator.sqlite 已损坏或不完整，已停止自动更新。");
                byte[] header = new byte[16];
                using (FileStream stream = new FileStream(database, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (stream.Read(header, 0, header.Length) != header.Length || Encoding.ASCII.GetString(header) != "SQLite format 3\0") throw new InvalidDataException("旧项目的 workspace/orchestrator.sqlite 不是有效的 SQLite 数据库，已停止自动更新。");
                }
            }
            InstalledProject result = new InstalledProject();
            result.Root = projectRoot;
            result.Version = version;
            result.HasWorkspace = Directory.Exists(workspace);
            result.HasDatabase = File.Exists(database);
            result.DatabaseBytes = databaseBytes;
            result.HasModels = Directory.Exists(Path.Combine(projectRoot, "runtime", "models")) && Directory.GetFiles(Path.Combine(projectRoot, "runtime", "models"), "model.bin", SearchOption.AllDirectories).Length > 0;
            result.HasSharedGitCredentials = Directory.Exists(Path.Combine(projectRoot, ".cache", "shared-git"));
            return result;
        }

        public void Cancel()
        {
            explicitlyCancelled = true;
            HttpWebRequest request = activeRequest;
            try { if (request != null) request.Abort(); } catch { }
        }

        public StandaloneRelease FetchLatest()
        {
            Report("checking", "正在检查 GitHub 最新正式版", "只读取 latest 稳定 Release，不会自动安装预发布版本。", 0.04D, 0L, 0L, true);
            string json = DownloadText(releaseApi, "application/vnd.github+json", 30000);
            StandaloneRelease release = StandaloneRelease.Parse(json);
            Report("checking", "已找到星藏家 v" + release.Version, release.AssetName, 0.08D, 0L, release.AssetSize, true);
            return release;
        }

        public StandalonePreparedUpdate Prepare()
        {
            InstalledProject project = InspectTarget(true);
            RecoverInterruptedOperation();
            project = InspectTarget(true);
            StandaloneRelease release = FetchLatest();
            if (CompareVersions(release.Version, project.Version) <= 0) throw new InvalidOperationException("当前目录已是最新稳定版 v" + project.Version + "，无需覆盖更新。");
            string checksum = release.Checksum;
            if (String.IsNullOrEmpty(checksum) && !String.IsNullOrEmpty(release.ChecksumUrl))
            {
                Report("checking", "正在读取 SHA-256 校验文件", release.AssetName + ".sha256", 0.1D, 0L, release.AssetSize, true);
                Match match = Regex.Match(DownloadText(release.ChecksumUrl, "text/plain", 30000), "\\b([0-9a-f]{64})\\b", RegexOptions.IgnoreCase);
                if (match.Success) checksum = match.Groups[1].Value.ToLowerInvariant();
            }
            if (!Regex.IsMatch(checksum ?? String.Empty, "^[0-9a-f]{64}$", RegexOptions.IgnoreCase)) throw new InvalidDataException("最新 Release 缺少有效的核心包 SHA-256，已停止安装。");
            release.Checksum = checksum.ToLowerInvariant();
            EnsureInitialDiskSpace(release.AssetSize);
            string updates = Path.Combine(projectRoot, ".updates");
            string downloads = Path.Combine(updates, "downloads");
            Directory.CreateDirectory(downloads);
            string archive = Path.Combine(downloads, release.AssetName);
            string partial = archive + ".partial";
            if (File.Exists(archive))
            {
                Report("verifying", "正在校验已下载的更新包", release.AssetName, 0.62D, 0L, new FileInfo(archive).Length, true);
                if (!String.Equals(ComputeSha256(archive), release.Checksum, StringComparison.OrdinalIgnoreCase)) File.Delete(archive);
            }
            if (!File.Exists(archive))
            {
                DownloadArchive(release, partial);
                Report("verifying", "正在校验更新包 SHA-256", release.AssetName, 0.66D, 0L, new FileInfo(partial).Length, true);
                string actual = ComputeSha256(partial);
                if (!String.Equals(actual, release.Checksum, StringComparison.OrdinalIgnoreCase))
                {
                    try { File.Delete(partial); } catch { }
                    throw new InvalidDataException("更新包 SHA-256 不匹配，文件可能损坏，已拒绝安装。实际值：" + actual);
                }
                if (File.Exists(archive)) File.Delete(archive);
                File.Move(partial, archive);
            }
            string staging = Path.Combine(updates, "staging-v" + release.Version);
            SafeDeleteStaging(staging);
            Directory.CreateDirectory(staging);
            string packageRoot;
            try
            {
                packageRoot = ExtractArchive(archive, staging, release.Version);
                ValidateStagedPackage(packageRoot, release.Version);
            }
            catch
            {
                SafeDeleteStaging(staging);
                throw;
            }
            Report("ready", "新版本已经下载并通过完整校验", "正在准备由事务更新器安全接管。", 0.99D, release.AssetSize, release.AssetSize, true);
            StandalonePreparedUpdate prepared = new StandalonePreparedUpdate();
            prepared.Project = project;
            prepared.Release = release;
            prepared.ArchivePath = archive;
            prepared.StagingRoot = staging;
            prepared.PackageRoot = packageRoot;
            return prepared;
        }

        public ControllerHandoff LaunchController(StandalonePreparedUpdate prepared, bool headless, bool disableRelaunch)
        {
            if (prepared == null) throw new ArgumentNullException("prepared");
            ThrowIfCancelled();
            InspectTarget(true);
            ValidateStagedPackage(prepared.PackageRoot, prepared.Release.Version);
            string operationId = "standalone-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ", CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            string updates = Path.Combine(projectRoot, ".updates");
            string runtimeRoot = Path.Combine(updates, "standalone-runtime-" + operationId);
            string helper;
            string recovery;
            string logo;
            EmbeddedUpdaterAssets.ExtractOperationFiles(runtimeRoot, out helper, out recovery, out logo);
            string ready = Path.Combine(updates, "updater-ready-" + operationId + ".json");
            string acknowledgement = Path.Combine(updates, "updater-ack-" + operationId + ".json");
            string cancel = Path.Combine(updates, "updater-cancel-" + operationId + ".json");
            string log = Path.Combine(updates, "updater-" + operationId + ".log");
            string request = Path.Combine(updates, "operation-request.json");
            DeleteIfExists(ready);
            DeleteIfExists(acknowledgement);
            DeleteIfExists(cancel);
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["operationId"] = operationId;
            payload["mode"] = "update";
            payload["projectRoot"] = projectRoot;
            payload["stagedRoot"] = prepared.PackageRoot;
            payload["sourceWorkspace"] = String.Empty;
            payload["targetVersion"] = prepared.Release.Version;
            payload["processId"] = Process.GetCurrentProcess().Id;
            payload["updaterHelperPath"] = helper;
            payload["updaterRecoveryPath"] = recovery;
            payload["updaterPowerShellPath"] = SystemPowerShellPath();
            payload["updaterCommandPath"] = SystemCommandPath();
            payload["updaterReadyFile"] = ready;
            payload["updaterAcknowledgeFile"] = acknowledgement;
            payload["updaterCancelFile"] = cancel;
            payload["updaterLogFile"] = log;
            payload["updaterIconPath"] = logo;
            payload["disableRelaunch"] = disableRelaunch;
            payload["headless"] = headless;
            payload["requestedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            JsonFiles.WriteObjectAtomic(request, payload);
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = Application.ExecutablePath;
            info.Arguments = "--request " + QuoteArgument(request);
            info.WorkingDirectory = runtimeRoot;
            info.UseShellExecute = false;
            info.CreateNoWindow = false;
            Process child = Process.Start(info);
            bool acknowledged = false;
            DateTime deadline = DateTime.UtcNow.AddSeconds(20D);
            try
            {
                while (DateTime.UtcNow < deadline)
                {
                    if (IsCancelled())
                    {
                        try { if (!child.HasExited) child.Kill(); } catch { }
                        DeleteIfExists(request);
                        throw new OperationCanceledException("更新已在修改旧项目之前停止。");
                    }
                    Dictionary<string, object> state = TryReadObject(ready);
                    if (state != null && String.Equals(JsonFiles.StringValue(state, "operationId"), operationId, StringComparison.Ordinal))
                    {
                        string status = JsonFiles.StringValue(state, "status");
                        if (status == "ready" && !acknowledged)
                        {
                            Dictionary<string, object> ack = new Dictionary<string, object>();
                            ack["operationId"] = operationId;
                            ack["status"] = "acknowledged";
                            ack["acknowledgedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                            JsonFiles.WriteObjectAtomic(acknowledgement, ack);
                            acknowledged = true;
                        }
                        else if (status == "accepted")
                        {
                            ControllerHandoff handoff = new ControllerHandoff();
                            handoff.OperationId = operationId;
                            handoff.UpdaterPid = JsonFiles.IntValue(state, "updaterPid");
                            Report("handoff", "事务更新器已安全接管", "当前窗口退出后才会开始替换；后续仍可在更新器窗口中中止并回退。", 1D, prepared.Release.AssetSize, prepared.Release.AssetSize, true);
                            return handoff;
                        }
                    }
                    if (child.HasExited) throw new InvalidOperationException("事务更新器在接管前意外退出，旧项目未被修改。");
                    Thread.Sleep(80);
                }
                try { if (!child.HasExited) child.Kill(); } catch { }
                DeleteIfExists(request);
                throw new TimeoutException("事务更新器启动超时，旧项目未被修改。");
            }
            catch
            {
                if (!acknowledged)
                {
                    DeleteIfExists(ready);
                    DeleteIfExists(acknowledgement);
                }
                throw;
            }
        }

        private void RecoverInterruptedOperation()
        {
            string journal = Path.Combine(projectRoot, ".updates", "operation-journal.json");
            if (!File.Exists(journal)) return;
            Report("recovery", "检测到上次未完成的更新", "正在依据事务日志先恢复旧版本，再继续本次更新。", 0.02D, 0L, 0L, true);
            string runtime = Path.Combine(projectRoot, ".updates", "standalone-recovery-" + Guid.NewGuid().ToString("N"));
            string helper;
            string recovery;
            string logo;
            EmbeddedUpdaterAssets.ExtractOperationFiles(runtime, out helper, out recovery, out logo);
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = SystemPowerShellPath();
            info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + QuoteArgument(recovery) + " -ProjectRoot " + QuoteArgument(projectRoot);
            info.WorkingDirectory = projectRoot;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (Process process = Process.Start(info))
            {
                string output = process.StandardOutput.ReadToEnd();
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0 || File.Exists(journal)) throw new InvalidOperationException("无法自动恢复上次中断的更新。请保留 .updates 目录并查看诊断信息。" + (String.IsNullOrWhiteSpace(error) ? output : error));
            }
        }

        private void DownloadArchive(StandaloneRelease release, string partial)
        {
            long existing = File.Exists(partial) ? new FileInfo(partial).Length : 0L;
            if (release.AssetSize > 0L && existing > release.AssetSize) { File.Delete(partial); existing = 0L; }
            for (int attempt = 0; attempt < 2; attempt++)
            {
                ThrowIfCancelled();
                HttpWebRequest request = CreateRequest(release.AssetUrl, "application/octet-stream", 6 * 60 * 60 * 1000);
                if (existing > 0L) request.AddRange(existing);
                HttpWebResponse response = null;
                try
                {
                    response = (HttpWebResponse)request.GetResponse();
                }
                catch (WebException error)
                {
                    response = error.Response as HttpWebResponse;
                    if (response == null || response.StatusCode != HttpStatusCode.RequestedRangeNotSatisfiable) throw NetworkError(error, response, "更新包下载失败");
                }
                using (response)
                {
                    if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable)
                    {
                        if (existing > 0L && String.Equals(ComputeSha256(partial), release.Checksum, StringComparison.OrdinalIgnoreCase)) return;
                        DeleteIfExists(partial);
                        existing = 0L;
                        continue;
                    }
                    bool resumed = existing > 0L && response.StatusCode == HttpStatusCode.PartialContent && ContentRangeStartsAt(response.Headers["Content-Range"], existing);
                    if (existing > 0L && !resumed)
                    {
                        DeleteIfExists(partial);
                        existing = 0L;
                    }
                    long total = release.AssetSize > 0L ? release.AssetSize : (response.ContentLength > 0L ? existing + response.ContentLength : 0L);
                    FileMode mode = resumed ? FileMode.Append : FileMode.Create;
                    long downloaded = resumed ? existing : 0L;
                    byte[] buffer = new byte[1024 * 1024];
                    using (Stream input = response.GetResponseStream())
                    using (FileStream output = new FileStream(partial, mode, FileAccess.Write, FileShare.Read))
                    {
                        while (true)
                        {
                            ThrowIfCancelled();
                            int read = input.Read(buffer, 0, buffer.Length);
                            if (read <= 0) break;
                            output.Write(buffer, 0, read);
                            downloaded += read;
                            double fraction = total > 0L ? Math.Min(1D, downloaded / (double)total) : 0D;
                            Report("downloading", "正在下载星藏家 v" + release.Version, FormatBytes(downloaded) + (total > 0L ? " / " + FormatBytes(total) : String.Empty), 0.1D + fraction * 0.52D, downloaded, total, false);
                        }
                        output.Flush(true);
                    }
                    if (total > 0L && downloaded != total) throw new IOException("更新包下载不完整：" + FormatBytes(downloaded) + " / " + FormatBytes(total) + "。");
                    return;
                }
            }
            throw new IOException("无法继续更新包断点下载，请重试。");
        }

        private string ExtractArchive(string archivePath, string stagingRoot, string version)
        {
            using (FileStream stream = new FileStream(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read, false, Encoding.UTF8))
            {
                List<StandaloneArchiveEntry> entries = new List<StandaloneArchiveEntry>();
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    bool directory = String.IsNullOrEmpty(entry.Name) || entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal);
                    entries.Add(new StandaloneArchiveEntry(entry.FullName, directory, directory ? 0L : entry.Length, directory ? 0L : entry.CompressedLength, entry.ExternalAttributes));
                }
                StandaloneArchivePlan plan = StandaloneArchiveSecurity.Validate(entries, stagingRoot);
                EnsureExpandedDiskSpace(plan.TotalBytes);
                long completed = 0L;
                byte[] buffer = new byte[1024 * 1024];
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    ThrowIfCancelled();
                    string normalized = entry.FullName.Replace('\\', '/').TrimEnd('/');
                    string outputPath = Path.GetFullPath(Path.Combine(stagingRoot, normalized.Replace('/', Path.DirectorySeparatorChar)));
                    bool directory = String.IsNullOrEmpty(entry.Name) || entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal);
                    if (directory)
                    {
                        Directory.CreateDirectory(outputPath);
                        continue;
                    }
                    string parent = Path.GetDirectoryName(outputPath);
                    if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    using (Stream input = entry.Open())
                    using (FileStream output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        while (true)
                        {
                            ThrowIfCancelled();
                            int read = input.Read(buffer, 0, buffer.Length);
                            if (read <= 0) break;
                            output.Write(buffer, 0, read);
                            completed += read;
                            double fraction = plan.TotalBytes > 0L ? completed / (double)plan.TotalBytes : 0D;
                            Report("extracting", "正在安全解压并检查文件", normalized, 0.72D + Math.Min(1D, fraction) * 0.23D, completed, plan.TotalBytes, false);
                        }
                    }
                }
                string packageRoot = String.IsNullOrEmpty(plan.Prefix) ? stagingRoot : Path.Combine(stagingRoot, plan.Prefix.Replace('/', Path.DirectorySeparatorChar));
                return Path.GetFullPath(packageRoot);
            }
        }

        private void ValidateStagedPackage(string root, string version)
        {
            Report("verifying", "正在验证新版本运行环境", "检查应用、Electron、Python、FFmpeg、Git 与事务更新器。", 0.96D, 0L, 0L, true);
            List<string> required = new List<string>(new string[] {
                "package.json", "package-lock.json", "portable-manifest.json", Path.Combine("src", "main.js"), "Start-StarOwner.cmd",
                Path.Combine("scripts", "apply-portable-operation.ps1"), Path.Combine("scripts", "recover-portable-operation.ps1"),
                Path.Combine("tools", "faster-whisper-cli.py"), Path.Combine("node_modules", "electron", "dist", "electron.exe"),
                Path.Combine("node_modules", "mammoth", "package.json"), Path.Combine("node_modules", "pdf-parse", "package.json"),
                Path.Combine("node_modules", "sql.js", "package.json"), Path.Combine("node_modules", "mermaid", "dist", "mermaid.min.js"),
                Path.Combine("runtime", "git", "cmd", "git.exe"), Path.Combine("runtime", "python"),
                Path.Combine("runtime", "faster-whisper", "Scripts", "python.exe"), Path.Combine("runtime", "faster-whisper", "Lib", "site-packages", "faster_whisper"),
                Path.Combine("runtime", "faster-whisper", "Lib", "site-packages", "yt_dlp"), Path.Combine("runtime", "faster-whisper", "Lib", "site-packages", "imageio_ffmpeg", "binaries"),
                Path.Combine("runtime", "vc-runtime", "concrt140.dll"), Path.Combine("runtime", "vc-runtime", "msvcp140.dll"),
                Path.Combine("runtime", "vc-runtime", "msvcp140_codecvt_ids.dll"), Path.Combine("runtime", "vc-runtime", "vcruntime140.dll"), Path.Combine("runtime", "vc-runtime", "vcruntime140_1.dll")
            });
            if (CompareVersions(version, "1.7.1") >= 0)
            {
                required.Add(Path.Combine("tools", "updater", "StarOwnerUpdater.cs"));
                required.Add(Path.Combine("tools", "updater", "StarOwnerUpdater.exe"));
                required.Add(Path.Combine("tools", "updater", "build-updater.ps1"));
            }
            if (CompareVersions(version, "1.7.2") >= 0) required.Add(Path.Combine("tools", "updater", "StandaloneUpdater.cs"));
            foreach (string relative in required) if (!File.Exists(Path.Combine(root, relative)) && !Directory.Exists(Path.Combine(root, relative))) throw new InvalidDataException("更新包缺少必需文件：" + relative);
            Dictionary<string, object> package = JsonFiles.ReadObject(Path.Combine(root, "package.json"));
            Dictionary<string, object> packageLock = JsonFiles.ReadObject(Path.Combine(root, "package-lock.json"));
            Dictionary<string, object> manifest = JsonFiles.ReadObject(Path.Combine(root, "portable-manifest.json"));
            if (!String.Equals(JsonFiles.StringValue(package, "name"), "star-owner", StringComparison.Ordinal)) throw new InvalidDataException("更新包应用标识不正确。");
            if (!String.Equals(JsonFiles.StringValue(package, "version"), version, StringComparison.Ordinal)) throw new InvalidDataException("更新包 package.json 版本与 Release 不一致。");
            string dependencyVersion = JsonFiles.StringValue(package, "dependencyReleaseVersion");
            if (!Regex.IsMatch(dependencyVersion, "^[0-9]+\\.[0-9]+\\.[0-9]+$")) throw new InvalidDataException("更新包缺少有效的依赖基线版本。");
            if (!String.Equals(JsonFiles.StringValue(packageLock, "version"), version, StringComparison.Ordinal)) throw new InvalidDataException("更新包 package-lock.json 版本不一致。");
            Dictionary<string, object> lockPackages = JsonFiles.ObjectValue(packageLock, "packages");
            Dictionary<string, object> lockRoot = lockPackages == null ? null : JsonFiles.ObjectValue(lockPackages, String.Empty);
            if (lockRoot == null || !String.Equals(JsonFiles.StringValue(lockRoot, "version"), version, StringComparison.Ordinal)) throw new InvalidDataException("更新包 package-lock 根依赖版本不一致。");
            if (!String.Equals(JsonFiles.StringValue(manifest, "version"), version, StringComparison.Ordinal)
                || !String.Equals(JsonFiles.StringValue(manifest, "platform"), "win-x64", StringComparison.Ordinal)
                || !String.Equals(JsonFiles.StringValue(manifest, "launcher"), "Start-StarOwner.cmd", StringComparison.Ordinal)
                || !String.Equals(JsonFiles.StringValue(manifest, "dependencyReleaseVersion"), dependencyVersion, StringComparison.Ordinal)) throw new InvalidDataException("更新包 portable-manifest.json 校验失败。");
            bool hasPython = false;
            foreach (string directory in Directory.GetDirectories(Path.Combine(root, "runtime", "python"))) if (File.Exists(Path.Combine(directory, "python.exe"))) { hasPython = true; break; }
            if (!hasPython) throw new InvalidDataException("更新包缺少项目内置基础 Python。");
            if (Directory.GetFiles(Path.Combine(root, "runtime", "faster-whisper", "Lib", "site-packages", "imageio_ffmpeg", "binaries"), "ffmpeg-*.exe", SearchOption.TopDirectoryOnly).Length == 0) throw new InvalidDataException("更新包缺少项目内置 FFmpeg。");
        }

        private string DownloadText(string url, string accept, int timeout)
        {
            ThrowIfCancelled();
            HttpWebRequest request = CreateRequest(url, accept, timeout);
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (Stream stream = response.GetResponseStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true)) return reader.ReadToEnd();
            }
            catch (WebException error)
            {
                throw NetworkError(error, error.Response as HttpWebResponse, "GitHub 请求失败");
            }
        }

        private HttpWebRequest CreateRequest(string url, string accept, int timeout)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Accept = accept;
            request.UserAgent = "Star-Owner-Standalone-Updater/1.0";
            request.AllowAutoRedirect = true;
            request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            request.Timeout = timeout;
            request.ReadWriteTimeout = timeout;
            request.KeepAlive = true;
            activeRequest = request;
            return request;
        }

        private Exception NetworkError(WebException error, HttpWebResponse response, string prefix)
        {
            if (IsCancelled()) return new OperationCanceledException("更新已安全停止，旧项目尚未被修改。", error);
            string status = response == null ? error.Status.ToString() : ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture);
            return new IOException(prefix + "（" + status + "）。请检查网络后重试。", error);
        }

        private string ComputeSha256(string path)
        {
            using (SHA256 hash = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] buffer = new byte[1024 * 1024];
                long completed = 0L;
                while (true)
                {
                    ThrowIfCancelled();
                    int read = stream.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    hash.TransformBlock(buffer, 0, read, buffer, 0);
                    completed += read;
                    Report("verifying", "正在校验 SHA-256", Path.GetFileName(path), 0.66D + Math.Min(1D, completed / (double)Math.Max(1L, stream.Length)) * 0.05D, completed, stream.Length, false);
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                return BitConverter.ToString(hash.Hash).Replace("-", String.Empty).ToLowerInvariant();
            }
        }

        private List<int> FindRunningProjectProcesses()
        {
            List<int> values = new List<int>();
            string normalizedRoot = NormalizeWindows(projectRoot).TrimEnd('\\');
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT ProcessId, Name, CommandLine FROM Win32_Process WHERE Name='electron.exe' OR Name='node.exe'"))
            using (ManagementObjectCollection results = searcher.Get())
            {
                foreach (ManagementObject process in results)
                {
                    int processId;
                    if (!Int32.TryParse(Convert.ToString(process["ProcessId"], CultureInfo.InvariantCulture), out processId) || processId <= 0 || processId == Process.GetCurrentProcess().Id) continue;
                    string command = NormalizeWindows(Convert.ToString(process["CommandLine"], CultureInfo.InvariantCulture));
                    if (CommandContainsRoot(command, normalizedRoot)) values.Add(processId);
                }
            }
            return values;
        }

        private static bool CommandContainsRoot(string command, string root)
        {
            if (String.IsNullOrEmpty(command) || String.IsNullOrEmpty(root)) return false;
            int offset = command.IndexOf(root, StringComparison.OrdinalIgnoreCase);
            while (offset >= 0)
            {
                char before = offset > 0 ? command[offset - 1] : '\0';
                int afterIndex = offset + root.Length;
                char after = afterIndex < command.Length ? command[afterIndex] : '\0';
                bool left = before == '\0' || Char.IsWhiteSpace(before) || before == '"' || before == '\'' || before == '=';
                bool right = after == '\0' || after == '\\' || after == '/' || after == '"' || after == '\'' || Char.IsWhiteSpace(after);
                if (left && right) return true;
                offset = command.IndexOf(root, offset + 1, StringComparison.OrdinalIgnoreCase);
            }
            return false;
        }

        private void VerifyWritable()
        {
            string updates = Path.Combine(projectRoot, ".updates");
            Directory.CreateDirectory(updates);
            string probe = Path.Combine(updates, ".standalone-write-test-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(probe, "ok", Encoding.ASCII);
            File.Delete(probe);
        }

        private void EnsureInitialDiskSpace(long archiveBytes)
        {
            long wanted = Math.Max(2L * 1024L * 1024L * 1024L, archiveBytes > 0L ? archiveBytes * 3L : 4L * 1024L * 1024L * 1024L);
            EnsureDiskSpace(wanted, "下载、解压和事务备份");
        }

        private void EnsureExpandedDiskSpace(long expandedBytes)
        {
            long wanted = expandedBytes + Math.Max(1024L * 1024L * 1024L, expandedBytes / 2L);
            EnsureDiskSpace(wanted, "解压和事务备份");
        }

        private void EnsureDiskSpace(long wanted, string purpose)
        {
            string root = Path.GetPathRoot(projectRoot);
            DriveInfo drive = new DriveInfo(root);
            if (drive.AvailableFreeSpace < wanted) throw new IOException("磁盘空间不足，" + purpose + "至少还需要约 " + FormatBytes(wanted) + " 可用空间。");
        }

        private void SafeDeleteStaging(string path)
        {
            string updates = Path.GetFullPath(Path.Combine(projectRoot, ".updates")).TrimEnd('\\');
            string target = Path.GetFullPath(path);
            if (!String.Equals(Path.GetDirectoryName(target), updates, StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(Path.GetFileName(target), "^staging-v[0-9]+\\.[0-9]+\\.[0-9]+$", RegexOptions.IgnoreCase)) throw new InvalidOperationException("拒绝清理不属于更新器管理的暂存目录。");
            if (Directory.Exists(target)) Directory.Delete(target, true);
        }

        private void RequireFile(string relative, string message)
        {
            if (!File.Exists(Path.Combine(projectRoot, relative))) throw new InvalidDataException(message);
        }

        private void ThrowIfCancelled()
        {
            if (IsCancelled()) throw new OperationCanceledException("更新已安全停止，旧项目尚未被修改；已下载的断点文件可供下次继续使用。");
        }

        private bool IsCancelled()
        {
            if (explicitlyCancelled) return true;
            try { return cancellationRequested != null && cancellationRequested(); } catch { return true; }
        }

        private void Report(string phase, string status, string detail, double value, long completed, long total, bool force)
        {
            if (progress == null) return;
            DateTime now = DateTime.UtcNow;
            if (!force && now - lastProgressAt < TimeSpan.FromMilliseconds(90D)) return;
            lastProgressAt = now;
            StandaloneProgressInfo info = new StandaloneProgressInfo();
            info.Phase = phase;
            info.Status = status;
            info.Detail = detail;
            info.Progress = Math.Max(0D, Math.Min(1D, value));
            info.CompletedBytes = completed;
            info.TotalBytes = total;
            progress(info);
        }

        public static int CompareVersions(string left, string right)
        {
            Match leftMatch = Regex.Match(left ?? String.Empty, "^([0-9]+(?:\\.[0-9]+){0,2})(?:-([^+]+))?");
            Match rightMatch = Regex.Match(right ?? String.Empty, "^([0-9]+(?:\\.[0-9]+){0,2})(?:-([^+]+))?");
            string[] a = leftMatch.Groups[1].Value.Split('.');
            string[] b = rightMatch.Groups[1].Value.Split('.');
            for (int index = 0; index < 3; index++)
            {
                int av = index < a.Length ? Int32.Parse(a[index], CultureInfo.InvariantCulture) : 0;
                int bv = index < b.Length ? Int32.Parse(b[index], CultureInfo.InvariantCulture) : 0;
                if (av != bv) return av > bv ? 1 : -1;
            }
            string aPre = leftMatch.Groups[2].Value;
            string bPre = rightMatch.Groups[2].Value;
            if (String.IsNullOrEmpty(aPre) && !String.IsNullOrEmpty(bPre)) return 1;
            if (!String.IsNullOrEmpty(aPre) && String.IsNullOrEmpty(bPre)) return -1;
            if (!String.Equals(aPre, bPre, StringComparison.OrdinalIgnoreCase)) return String.Compare(aPre, bPre, StringComparison.OrdinalIgnoreCase);
            return 0;
        }

        private static string SystemPowerShellPath()
        {
            string value = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(value)) throw new FileNotFoundException("Windows PowerShell 不可用，无法执行安全事务。", value);
            return value;
        }

        private static string SystemCommandPath()
        {
            string value = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "cmd.exe");
            if (!File.Exists(value)) throw new FileNotFoundException("Windows 命令处理器不可用，无法重新启动应用。", value);
            return value;
        }

        private static string QuoteArgument(string value)
        {
            value = value ?? String.Empty;
            if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int slashes = 0;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (current == '\\') { slashes++; continue; }
                if (current == '"')
                {
                    result.Append('\\', slashes * 2 + 1);
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                result.Append('\\', slashes);
                slashes = 0;
                result.Append(current);
            }
            result.Append('\\', slashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static bool ContentRangeStartsAt(string value, long expected)
        {
            Match match = Regex.Match(value ?? String.Empty, "^bytes\\s+([0-9]+)-([0-9]+)/([0-9*]+)$", RegexOptions.IgnoreCase);
            long start;
            return match.Success && Int64.TryParse(match.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out start) && start == expected;
        }

        private static string NormalizeWindows(string value)
        {
            return (value ?? String.Empty).Trim().ToLowerInvariant().Replace('/', '\\');
        }

        private static Dictionary<string, object> TryReadObject(string path)
        {
            try { return File.Exists(path) ? JsonFiles.ReadObject(path) : null; } catch { return null; }
        }

        private static void DeleteIfExists(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        public static string FormatBytes(long bytes)
        {
            if (bytes < 1024L) return bytes.ToString(CultureInfo.InvariantCulture) + " B";
            if (bytes < 1024L * 1024L) return (bytes / 1024D).ToString("0.0", CultureInfo.InvariantCulture) + " KB";
            if (bytes < 1024L * 1024L * 1024L) return (bytes / (1024D * 1024D)).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
            return (bytes / (1024D * 1024D * 1024D)).ToString("0.00", CultureInfo.InvariantCulture) + " GB";
        }
    }
}

namespace StarOwnerUpdater
{
    internal static class StandaloneArchiveSecurity
    {
        private const long MaximumExpandedBytes = 32L * 1024L * 1024L * 1024L;
        private const int MaximumEntries = 400000;

        public static StandaloneArchivePlan Validate(IList<StandaloneArchiveEntry> entries, string stagingRoot)
        {
            if (entries == null || entries.Count == 0) throw new InvalidDataException("更新包为空。");
            if (entries.Count > MaximumEntries) throw new InvalidDataException("更新包文件数量异常，已拒绝安装。");
            Dictionary<string, bool> identities = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            List<string> normalizedEntries = new List<string>();
            long totalBytes = 0L;
            List<string> packageEntries = new List<string>();
            string stage = Path.GetFullPath(stagingRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            foreach (StandaloneArchiveEntry raw in entries)
            {
                string normalized = Normalize(raw.Name);
                if (IsLink(raw.ExternalAttributes)) throw new InvalidDataException("更新包包含符号链接、硬链接或重解析点，已拒绝安装：" + normalized);
                bool isDirectory = raw.IsDirectory || raw.Name.EndsWith("/", StringComparison.Ordinal) || raw.Name.EndsWith("\\", StringComparison.Ordinal);
                bool previousDirectory;
                if (identities.TryGetValue(normalized, out previousDirectory)) throw new InvalidDataException("更新包包含 Windows 下会发生覆盖的重复路径：" + normalized);
                string ancestor = normalized;
                while (ancestor.Contains("/"))
                {
                    ancestor = ancestor.Substring(0, ancestor.LastIndexOf('/'));
                    bool ancestorDirectory;
                    if (identities.TryGetValue(ancestor, out ancestorDirectory) && !ancestorDirectory) throw new InvalidDataException("更新包同时把同一路径作为文件和目录：" + ancestor);
                }
                identities[normalized] = isDirectory;
                normalizedEntries.Add(normalized);
                if (!isDirectory)
                {
                    if (raw.Length < 0L || raw.CompressedLength < 0L) throw new InvalidDataException("更新包包含无效的文件长度。");
                    totalBytes = checked(totalBytes + raw.Length);
                    if (totalBytes > MaximumExpandedBytes) throw new InvalidDataException("更新包解压后的体积超过安全上限。");
                    if (raw.CompressedLength > 0L && raw.Length > 1024L * 1024L && raw.Length / Math.Max(1L, raw.CompressedLength) > 5000L) throw new InvalidDataException("更新包包含异常压缩比文件，已拒绝安装：" + normalized);
                }
                string output = Path.GetFullPath(Path.Combine(stage, normalized.Replace('/', Path.DirectorySeparatorChar)));
                if (!IsInside(stage, output)) throw new InvalidDataException("更新包路径越过了解压目录：" + normalized);
                if (output.Length >= 259) throw new PathTooLongException("旧项目目录过深，无法安全解压最新版本。请先把整个项目目录移动到更短的位置后重试。");
                if (normalized.EndsWith("/package.json", StringComparison.OrdinalIgnoreCase) || String.Equals(normalized, "package.json", StringComparison.OrdinalIgnoreCase))
                {
                    packageEntries.Add(normalized);
                }
            }
            if (packageEntries.Count == 0) throw new InvalidDataException("更新包缺少 package.json。");
            packageEntries.Sort(delegate(string left, string right)
            {
                int leftDepth = left.Split('/').Length;
                int rightDepth = right.Split('/').Length;
                return leftDepth != rightDepth ? leftDepth.CompareTo(rightDepth) : String.Compare(left, right, StringComparison.OrdinalIgnoreCase);
            });
            string packageEntry = packageEntries[0];
            int packageDepth = packageEntry.Split('/').Length;
            if (packageEntries.Count > 1 && packageEntries[1].Split('/').Length == packageDepth) throw new InvalidDataException("更新包包含多个顶层 package.json，已拒绝安装。");
            string prefix = String.Equals(packageEntry, "package.json", StringComparison.OrdinalIgnoreCase) ? String.Empty : packageEntry.Substring(0, packageEntry.Length - "/package.json".Length);
            string allowedPrefix = String.IsNullOrEmpty(prefix) ? String.Empty : prefix + "/";
            foreach (string entry in normalizedEntries)
            {
                if (!String.IsNullOrEmpty(prefix) && !String.Equals(entry, prefix, StringComparison.OrdinalIgnoreCase) && !entry.StartsWith(allowedPrefix, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("更新包包含多个顶层目录，已拒绝安装。");
            }
            StandaloneArchivePlan plan = new StandaloneArchivePlan();
            plan.Prefix = prefix;
            plan.TotalBytes = totalBytes;
            plan.EntryCount = entries.Count;
            return plan;
        }

        private static string Normalize(string raw)
        {
            if (String.IsNullOrEmpty(raw)) throw new InvalidDataException("更新包包含空路径条目。");
            foreach (char character in raw) if (character < 32 || character == 127) throw new InvalidDataException("更新包包含控制字符路径，已拒绝安装。");
            string normalized = raw.Replace('\\', '/').TrimEnd('/');
            if (String.IsNullOrEmpty(normalized) || normalized.StartsWith("/", StringComparison.Ordinal) || normalized.StartsWith("//", StringComparison.Ordinal) || Regex.IsMatch(normalized, "^[a-zA-Z]:"))
                throw new InvalidDataException("更新包包含 Win32 绝对路径或设备路径：" + raw);
            string[] segments = normalized.Split('/');
            foreach (string segment in segments)
            {
                if (String.IsNullOrEmpty(segment) || segment == "." || segment == "..") throw new InvalidDataException("更新包包含不安全路径段：" + raw);
                if (segment.IndexOf(':') >= 0) throw new InvalidDataException("更新包包含 NTFS 数据流或盘符路径：" + raw);
                if (segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal)) throw new InvalidDataException("更新包包含 Windows 下不稳定的尾随字符路径：" + raw);
                string device = segment.Split('.')[0].ToUpperInvariant();
                if (Regex.IsMatch(device, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$")) throw new InvalidDataException("更新包包含 Windows 保留设备名：" + raw);
            }
            return normalized;
        }

        private static bool IsLink(int attributes)
        {
            int unixType = (attributes >> 16) & 0xF000;
            return unixType == 0xA000 || unixType == 0x6000 || (attributes & 0x400) != 0;
        }

        private static bool IsInside(string root, string candidate)
        {
            return String.Equals(root, candidate, StringComparison.OrdinalIgnoreCase)
                || candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
    }

    internal static class EmbeddedUpdaterAssets
    {
        private const string ApplyResource = "StarOwnerUpdater.apply-portable-operation.ps1";
        private const string RecoveryResource = "StarOwnerUpdater.recover-portable-operation.ps1";
        private const string LogoResource = "StarOwnerUpdater.star-note.png";

        public static void ExtractOperationFiles(string directory, out string helper, out string recovery, out string logo)
        {
            Directory.CreateDirectory(directory);
            helper = Path.Combine(directory, "apply-portable-operation.ps1");
            recovery = Path.Combine(directory, "recover-portable-operation.ps1");
            logo = Path.Combine(directory, "star-note.png");
            WriteResource(ApplyResource, helper);
            WriteResource(RecoveryResource, recovery);
            WriteResource(LogoResource, logo);
        }

        public static string ExtractPreviewLogo()
        {
            string directory = Path.Combine(Path.GetTempPath(), "StarOwner", "standalone-preview");
            Directory.CreateDirectory(directory);
            string logo = Path.Combine(directory, "star-note.png");
            WriteResource(LogoResource, logo);
            return logo;
        }

        private static void WriteResource(string name, string path)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream input = assembly.GetManifestResourceStream(name))
            {
                if (input == null) throw new InvalidDataException("更新器内置资源缺失：" + name);
                using (FileStream output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read)) input.CopyTo(output);
            }
        }
    }
}
