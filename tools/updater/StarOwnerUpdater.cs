using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace StarOwnerUpdater
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }

            if (args.Length >= 2 && String.Equals(args[0], "--version-file", StringComparison.OrdinalIgnoreCase))
            {
                return WriteVersionFile(args[1]);
            }

            int standaloneExitCode;
            if (StandaloneUpdaterCommands.TryRun(args, out standaloneExitCode)) return standaloneExitCode;

            if (args.Length >= 5 && String.Equals(args[0], "--probe", StringComparison.OrdinalIgnoreCase))
            {
                return RunProbe(args[1], args[2], args[3], args[4]);
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Length >= 2 && String.Equals(args[0], "--preview", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    string iconPath = args.Length >= 3 ? args[2] : String.Empty;
                    Application.Run(UpdaterForm.CreatePreview(args[1], iconPath));
                    return 0;
                }
                catch (Exception error)
                {
                    string diagnostic = error.GetType().FullName + Environment.NewLine + error.Message + Environment.NewLine + error.StackTrace;
                    File.WriteAllText(Path.GetFullPath(args[1]) + ".error.txt", diagnostic, new UTF8Encoding(false));
                    return 5;
                }
            }

            if (args.Length == 0 || (args.Length >= 1 && String.Equals(args[0], "--standalone", StringComparison.OrdinalIgnoreCase)))
            {
                return StandaloneUpdaterBootstrap.LaunchRelocated();
            }

            if (args.Length >= 1 && String.Equals(args[0], "--standalone-child", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    StandaloneStartupOptions options = StandaloneStartupOptions.Parse(args);
                    if (!String.IsNullOrEmpty(options.ExpectedVersion)
                        && !String.Equals(options.ExpectedVersion, UpdaterBuildInfo.Version, StringComparison.Ordinal))
                    {
                        throw new InvalidDataException("下载的更新器版本与目标星藏家版本不一致。");
                    }
                    Application.Run(new StandaloneUpdaterForm(false, String.Empty, options));
                    return 0;
                }
                catch (Exception error)
                {
                    MessageBox.Show("无法启动同版本更新器：\r\n" + error.Message, "星藏家更新器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 7;
                }
            }

            string requestPath = ReadOption(args, "--request");
            if (String.IsNullOrWhiteSpace(requestPath))
            {
                MessageBox.Show("更新器没有收到有效的操作请求。", "星藏家更新器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 2;
            }

            try
            {
                UpdaterRequest request = UpdaterRequest.Load(requestPath);
                Application.Run(new UpdaterForm(request, false, String.Empty));
                return 0;
            }
            catch (Exception error)
            {
                MessageBox.Show("无法启动更新器：\r\n" + error.Message, "星藏家更新器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 3;
            }
        }

        private static int RunProbe(string readyFile, string completeFile, string delayText, string marker)
        {
            try
            {
                int delay;
                if (!Int32.TryParse(delayText, out delay)) delay = 1500;
                JsonFiles.WriteTextAtomic(readyFile, marker + ":ready");
                Thread.Sleep(Math.Max(100, delay));
                JsonFiles.WriteTextAtomic(completeFile, marker + ":complete");
                return 0;
            }
            catch { return 4; }
        }

        private static int WriteVersionFile(string path)
        {
            try
            {
                Dictionary<string, object> value = new Dictionary<string, object>();
                value["product"] = "star-owner-updater";
                value["version"] = UpdaterBuildInfo.Version;
                value["protocolVersion"] = UpdaterBuildInfo.ProtocolVersion;
                JsonFiles.WriteObjectAtomic(Path.GetFullPath(path), value);
                return 0;
            }
            catch { return 6; }
        }

        private static string ReadOption(string[] args, string name)
        {
            for (int index = 0; index < args.Length - 1; index++)
            {
                if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
            }
            return String.Empty;
        }
    }

    internal sealed class UpdaterRequest
    {
        public string RequestPath;
        public string OperationId;
        public string Mode;
        public string ProjectRoot;
        public string StagedRoot;
        public string SourceWorkspace;
        public string TargetVersion;
        public string UpdaterVersion;
        public string HelperPath;
        public string RecoveryPath;
        public string PowerShellPath;
        public string CommandPath;
        public string ReadyFile;
        public string AcknowledgeFile;
        public string CancelFile;
        public string LogFile;
        public string IconPath;
        public int ProcessId;
        public bool DisableRelaunch;
        public bool Headless;

        public string UpdatesRoot { get { return Path.Combine(ProjectRoot, ".updates"); } }
        public string JournalFile { get { return Path.Combine(UpdatesRoot, "operation-journal.json"); } }
        public string ResultFile { get { return Path.Combine(UpdatesRoot, "operation-result.json"); } }

        public static UpdaterRequest Load(string requestPath)
        {
            Dictionary<string, object> data = JsonFiles.ReadObject(requestPath);
            UpdaterRequest value = new UpdaterRequest();
            value.RequestPath = Path.GetFullPath(requestPath);
            value.OperationId = JsonFiles.StringValue(data, "operationId");
            value.Mode = JsonFiles.StringValue(data, "mode");
            value.ProjectRoot = FullPath(JsonFiles.StringValue(data, "projectRoot"), "projectRoot");
            value.StagedRoot = OptionalFullPath(JsonFiles.StringValue(data, "stagedRoot"));
            value.SourceWorkspace = OptionalFullPath(JsonFiles.StringValue(data, "sourceWorkspace"));
            value.TargetVersion = JsonFiles.StringValue(data, "targetVersion");
            value.UpdaterVersion = JsonFiles.StringValue(data, "updaterVersion");
            value.HelperPath = FullPath(JsonFiles.StringValue(data, "updaterHelperPath"), "updaterHelperPath");
            value.RecoveryPath = FullPath(JsonFiles.StringValue(data, "updaterRecoveryPath"), "updaterRecoveryPath");
            value.PowerShellPath = FullPath(JsonFiles.StringValue(data, "updaterPowerShellPath"), "updaterPowerShellPath");
            value.CommandPath = FullPath(JsonFiles.StringValue(data, "updaterCommandPath"), "updaterCommandPath");
            value.ReadyFile = FullPath(JsonFiles.StringValue(data, "updaterReadyFile"), "updaterReadyFile");
            value.AcknowledgeFile = FullPath(JsonFiles.StringValue(data, "updaterAcknowledgeFile"), "updaterAcknowledgeFile");
            value.CancelFile = FullPath(JsonFiles.StringValue(data, "updaterCancelFile"), "updaterCancelFile");
            value.LogFile = FullPath(JsonFiles.StringValue(data, "updaterLogFile"), "updaterLogFile");
            value.IconPath = OptionalFullPath(JsonFiles.StringValue(data, "updaterIconPath"));
            value.ProcessId = JsonFiles.IntValue(data, "processId");
            value.DisableRelaunch = JsonFiles.BoolValue(data, "disableRelaunch");
            value.Headless = JsonFiles.BoolValue(data, "headless");

            if (String.IsNullOrWhiteSpace(value.OperationId)) throw new InvalidDataException("operationId is missing.");
            if (value.Mode != "update" && value.Mode != "migrate") throw new InvalidDataException("mode must be update or migrate.");
            if (value.ProcessId <= 0) throw new InvalidDataException("processId is invalid.");
            if (!Regex.IsMatch(value.TargetVersion ?? String.Empty, "^[0-9]+\\.[0-9]+\\.[0-9]+$")) throw new InvalidDataException("targetVersion is invalid.");
            if (!String.Equals(value.UpdaterVersion, value.TargetVersion, StringComparison.Ordinal)
                || !String.Equals(UpdaterBuildInfo.Version, value.TargetVersion, StringComparison.Ordinal))
            {
                throw new InvalidDataException("The updater version must exactly match the target Star Owner version.");
            }
            RequireFile(value.HelperPath, "operation helper");
            RequireFile(value.RecoveryPath, "recovery helper");
            RequireFile(value.PowerShellPath, "Windows PowerShell");
            RequireFile(value.CommandPath, "Windows command processor");
            Directory.CreateDirectory(value.UpdatesRoot);
            return value;
        }

        private static string FullPath(string value, string label)
        {
            if (String.IsNullOrWhiteSpace(value)) throw new InvalidDataException(label + " is missing.");
            return Path.GetFullPath(value);
        }

        private static string OptionalFullPath(string value)
        {
            return String.IsNullOrWhiteSpace(value) ? String.Empty : Path.GetFullPath(value);
        }

        private static void RequireFile(string path, string label)
        {
            if (!File.Exists(path)) throw new FileNotFoundException(label + " is missing.", path);
        }
    }

    internal static class JsonFiles
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        public static Dictionary<string, object> SerializerDeserialize(string text)
        {
            Dictionary<string, object> value = Serializer.Deserialize<Dictionary<string, object>>((text ?? String.Empty).TrimStart('\uFEFF'));
            if (value == null) throw new InvalidDataException("JSON object is empty.");
            return value;
        }

        public static Dictionary<string, object> ReadObject(string path)
        {
            string text;
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false), true)) text = reader.ReadToEnd();
            text = text.TrimStart('\uFEFF');
            Dictionary<string, object> value = Serializer.Deserialize<Dictionary<string, object>>(text);
            if (value == null) throw new InvalidDataException("JSON object is empty: " + path);
            return value;
        }

        public static void WriteObjectAtomic(string path, IDictionary<string, object> value)
        {
            WriteTextAtomic(path, Serializer.Serialize(value));
        }

        public static void WriteTextAtomic(string path, string text)
        {
            string full = Path.GetFullPath(path);
            string parent = Path.GetDirectoryName(full);
            if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            string temporary = full + ".tmp-" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            File.WriteAllText(temporary, text, new UTF8Encoding(false));
            if (!File.Exists(full)) File.Move(temporary, full);
            else
            {
                try { File.Replace(temporary, full, null, true); }
                catch
                {
                    File.Delete(full);
                    File.Move(temporary, full);
                }
            }
        }

        public static string StringValue(IDictionary<string, object> data, string key)
        {
            object value;
            return data.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : String.Empty;
        }

        public static int IntValue(IDictionary<string, object> data, string key)
        {
            object value;
            int result;
            return data.TryGetValue(key, out value) && Int32.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out result) ? result : 0;
        }

        public static long LongValue(IDictionary<string, object> data, string key)
        {
            object value;
            long result;
            return data != null && data.TryGetValue(key, out value) && Int64.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out result) ? result : 0L;
        }

        public static Dictionary<string, object> ObjectValue(IDictionary<string, object> data, string key)
        {
            object value;
            if (data == null || !data.TryGetValue(key, out value) || value == null) return null;
            return value as Dictionary<string, object>;
        }

        public static List<Dictionary<string, object>> ObjectList(IDictionary<string, object> data, string key)
        {
            List<Dictionary<string, object>> values = new List<Dictionary<string, object>>();
            object raw;
            if (data == null || !data.TryGetValue(key, out raw) || raw == null) return values;
            IEnumerable sequence = raw as IEnumerable;
            if (sequence == null || raw is string) return values;
            foreach (object item in sequence)
            {
                Dictionary<string, object> value = item as Dictionary<string, object>;
                if (value != null) values.Add(value);
            }
            return values;
        }

        public static double DoubleValue(IDictionary<string, object> data, string key, double fallback)
        {
            object value;
            double result;
            return data.TryGetValue(key, out value) && Double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out result) ? result : fallback;
        }

        public static bool BoolValue(IDictionary<string, object> data, string key)
        {
            object value;
            bool result;
            return data.TryGetValue(key, out value) && Boolean.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out result) && result;
        }
    }

    internal sealed class UpdaterForm : Form
    {
        private readonly UpdaterRequest request;
        private readonly bool previewMode;
        private readonly string previewPath;
        private readonly System.Windows.Forms.Timer animationTimer;
        private readonly System.Windows.Forms.Timer monitorTimer;
        private readonly AnimatedLogo animation;
        private readonly SmoothProgress progress;
        private readonly Label titleLabel;
        private readonly Label statusLabel;
        private readonly Label detailLabel;
        private readonly Label itemLabel;
        private readonly Label percentLabel;
        private readonly Label elapsedLabel;
        private readonly Button cancelButton;
        private readonly Button logButton;
        private Process helperProcess;
        private Process recoveryProcess;
        private DateTime startedAt;
        private DateTime cancelStartedAt;
        private DateTime helperExitedAt;
        private bool cancellationRequested;
        private bool forceRecoveryPending;
        private bool recoveryStarted;
        private bool terminal;
        private bool launcherStarted;
        private bool closeRequested;
        private int animationFrame;
        private readonly object logLock = new object();

        public static UpdaterForm CreatePreview(string imagePath, string iconPath)
        {
            UpdaterRequest demo = new UpdaterRequest();
            demo.OperationId = "preview";
            demo.Mode = "update";
            demo.TargetVersion = UpdaterBuildInfo.Version;
            demo.UpdaterVersion = UpdaterBuildInfo.Version;
            demo.IconPath = iconPath;
            demo.ProjectRoot = Environment.CurrentDirectory;
            return new UpdaterForm(demo, true, imagePath);
        }

        public UpdaterForm(UpdaterRequest requestValue, bool preview, string previewOutput)
        {
            request = requestValue;
            previewMode = preview;
            previewPath = previewOutput;
            Text = request.Mode == "migrate" ? "星藏家数据迁移" : "星藏家更新器";
            ClientSize = new Size(680, 620);
            MinimumSize = new Size(696, 659);
            MaximumSize = new Size(696, 659);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(247, 252, 255);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            TopMost = !preview;
            DoubleBuffered = true;
            if (request.Headless) { ShowInTaskbar = false; Opacity = 0.01D; WindowState = FormWindowState.Minimized; }
            try
            {
                if (!String.IsNullOrEmpty(request.IconPath) && File.Exists(request.IconPath)) Icon = new Icon(request.IconPath);
                else Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch { }

            titleLabel = MakeLabel(new Rectangle(40, 23, 600, 36), 20F, FontStyle.Bold, Color.FromArgb(26, 55, 83));
            titleLabel.Text = request.Mode == "migrate" ? "正在迁移旧版本数据" : "正在安装星藏家 v" + request.TargetVersion;
            Controls.Add(titleLabel);

            Label subtitle = MakeLabel(new Rectangle(40, 60, 600, 25), 9.5F, FontStyle.Regular, Color.FromArgb(91, 119, 141));
            subtitle.Text = request.Mode == "migrate" ? "完整复制 Workspace，并在异常时恢复迁移前状态" : "安全替换应用核心文件，Workspace、模型与运行时依赖保持不变";
            Controls.Add(subtitle);

            animation = new AnimatedLogo(request.IconPath);
            animation.Location = new Point(40, 88);
            animation.Size = new Size(600, 232);
            animation.BackColor = BackColor;
            Controls.Add(animation);

            statusLabel = MakeLabel(new Rectangle(40, 331, 600, 30), 13F, FontStyle.Bold, Color.FromArgb(27, 102, 150));
            statusLabel.Text = preview ? "正在安全替换应用文件" : "正在准备更新器";
            Controls.Add(statusLabel);

            detailLabel = MakeLabel(new Rectangle(40, 365, 600, 43), 9.5F, FontStyle.Regular, Color.FromArgb(75, 98, 116));
            detailLabel.Text = preview ? "已完成完整备份，正在写入经过校验的新版本核心文件。" : "更新器启动后会等待主应用完整退出，再开始备份和替换。";
            Controls.Add(detailLabel);

            Panel itemBand = new Panel();
            itemBand.Location = new Point(40, 415);
            itemBand.Size = new Size(600, 42);
            itemBand.BackColor = Color.FromArgb(232, 245, 251);
            Controls.Add(itemBand);
            itemLabel = MakeLabel(new Rectangle(14, 0, 572, 42), 9F, FontStyle.Regular, Color.FromArgb(48, 91, 119));
            itemLabel.TextAlign = ContentAlignment.MiddleLeft;
            itemLabel.Text = preview ? "当前项目：node_modules" : "正在建立安全接管连接...";
            itemBand.Controls.Add(itemLabel);

            progress = new SmoothProgress();
            progress.Location = new Point(40, 478);
            progress.Size = new Size(540, 14);
            progress.Value = preview ? 0.62D : 0.02D;
            Controls.Add(progress);
            percentLabel = MakeLabel(new Rectangle(588, 468, 52, 30), 9.5F, FontStyle.Bold, Color.FromArgb(27, 102, 150));
            percentLabel.TextAlign = ContentAlignment.MiddleRight;
            percentLabel.Text = preview ? "62%" : "2%";
            Controls.Add(percentLabel);

            elapsedLabel = MakeLabel(new Rectangle(40, 504, 330, 22), 8.5F, FontStyle.Regular, Color.FromArgb(115, 132, 145));
            elapsedLabel.Text = "已用时 00:00";
            Controls.Add(elapsedLabel);

            logButton = MakeButton(new Rectangle(40, 546, 128, 42), "打开更新日志", Color.FromArgb(247, 252, 255), Color.FromArgb(40, 110, 151), Color.FromArgb(154, 204, 228));
            logButton.Click += delegate { OpenLog(); };
            Controls.Add(logButton);

            cancelButton = MakeButton(new Rectangle(455, 546, 185, 42), "中止并回退", Color.FromArgb(255, 240, 243), Color.FromArgb(190, 57, 83), Color.FromArgb(235, 143, 160));
            cancelButton.Click += delegate { CancelOrClose(); };
            Controls.Add(cancelButton);

            animationTimer = new System.Windows.Forms.Timer();
            animationTimer.Interval = 33;
            animationTimer.Tick += delegate
            {
                animationFrame++;
                animation.Frame = animationFrame;
                progress.Frame = animationFrame;
                animation.Invalidate();
                progress.Invalidate();
            };
            monitorTimer = new System.Windows.Forms.Timer();
            monitorTimer.Interval = 180;
            monitorTimer.Tick += delegate { MonitorOperation(); };
            Shown += delegate { OnUpdaterShown(); };
            FormClosing += OnUpdaterClosing;
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

        private void OnUpdaterShown()
        {
            startedAt = DateTime.UtcNow;
            animationTimer.Start();
            if (previewMode)
            {
                System.Windows.Forms.Timer previewTimer = new System.Windows.Forms.Timer();
                previewTimer.Interval = 700;
                previewTimer.Tick += delegate
                {
                    previewTimer.Stop();
                    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(previewPath)));
                    using (Bitmap bitmap = new Bitmap(ClientSize.Width, ClientSize.Height))
                    {
                        DrawToBitmap(bitmap, new Rectangle(Point.Empty, ClientSize));
                        bitmap.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png);
                    }
                    closeRequested = true;
                    Close();
                };
                previewTimer.Start();
                return;
            }

            try
            {
                WriteReadiness("ready", 0);
                AppendLog("Updater UI ready; waiting for the application handoff acknowledgement.");
                monitorTimer.Start();
            }
            catch (Exception error)
            {
                AppendLog("Updater startup failed: " + error);
                WriteLocalResult("handoff-failed", "更新器无法启动事务：" + error.Message);
                CompleteFromResult(SafeRead(request.ResultFile));
            }
        }

        private void StartHelper()
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = request.PowerShellPath;
            info.Arguments = JoinArguments(new string[] {
                "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", request.HelperPath,
                "-Mode", request.Mode, "-ProjectRoot", request.ProjectRoot, "-ProcessId", request.ProcessId.ToString(CultureInfo.InvariantCulture),
                "-StagedRoot", request.StagedRoot, "-SourceWorkspace", request.SourceWorkspace, "-TargetVersion", request.TargetVersion,
                "-OperationId", request.OperationId, "-CancelFile", request.CancelFile
            });
            info.WorkingDirectory = request.ProjectRoot;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            helperProcess = StartLoggedProcess(info, "helper");
        }

        private void WriteReadiness(string status, int helperPid)
        {
            Dictionary<string, object> ready = new Dictionary<string, object>();
            ready["operationId"] = request.OperationId;
            ready["status"] = status;
            ready["updaterPid"] = Process.GetCurrentProcess().Id;
            if (helperPid > 0) ready["helperPid"] = helperPid;
            ready["readyAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            JsonFiles.WriteObjectAtomic(request.ReadyFile, ready);
        }

        private Process StartLoggedProcess(ProcessStartInfo info, string label)
        {
            Process process = new Process();
            process.StartInfo = info;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (!String.IsNullOrEmpty(args.Data)) AppendLog(label + ": " + args.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (!String.IsNullOrEmpty(args.Data)) AppendLog(label + " error: " + args.Data); };
            if (!process.Start()) throw new InvalidOperationException("Could not start " + label + ".");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            AppendLog(label + " process started (PID " + process.Id.ToString(CultureInfo.InvariantCulture) + ").");
            return process;
        }

        private void MonitorOperation()
        {
            if (terminal) return;
            TimeSpan elapsed = DateTime.UtcNow - startedAt;
            elapsedLabel.Text = "已用时 " + ((int)elapsed.TotalMinutes).ToString("00", CultureInfo.InvariantCulture) + ":" + elapsed.Seconds.ToString("00", CultureInfo.InvariantCulture);

            Dictionary<string, object> result = SafeRead(request.ResultFile);
            if (MatchesOperation(result))
            {
                CompleteFromResult(result);
                return;
            }

            Dictionary<string, object> journal = SafeRead(request.JournalFile);
            if (MatchesOperation(journal)) ApplyJournal(journal);

            if (helperProcess == null && !recoveryStarted && !cancellationRequested)
            {
                Dictionary<string, object> acknowledgement = SafeRead(request.AcknowledgeFile);
                bool accepted = acknowledgement != null
                    && String.Equals(JsonFiles.StringValue(acknowledgement, "operationId"), request.OperationId, StringComparison.Ordinal)
                    && JsonFiles.StringValue(acknowledgement, "status") == "acknowledged";
                if (accepted)
                {
                    try
                    {
                        StartHelper();
                        WriteReadiness("accepted", helperProcess.Id);
                        statusLabel.Text = "更新器已安全接管";
                        detailLabel.Text = "正在等待主应用退出；退出后才会开始修改文件。";
                        itemLabel.Text = "事务助手已启动，等待释放应用文件...";
                    }
                    catch (Exception error)
                    {
                        AppendLog("Could not accept the application handoff: " + error);
                        try { if (helperProcess != null && !HasExited(helperProcess)) helperProcess.Kill(); } catch { }
                        WriteLocalResult("handoff-failed", "无法启动事务助手：" + error.Message);
                        CompleteFromResult(SafeRead(request.ResultFile));
                    }
                }
                else if ((DateTime.UtcNow - startedAt).TotalSeconds >= 20D)
                {
                    WriteLocalResult("handoff-failed", "主应用没有确认更新器接管，未修改任何文件。请返回应用重试。");
                    CompleteFromResult(SafeRead(request.ResultFile));
                }
                return;
            }

            if (forceRecoveryPending && (helperProcess == null || HasExited(helperProcess)))
            {
                forceRecoveryPending = false;
                StartRecovery();
                return;
            }

            if (recoveryStarted)
            {
                if (recoveryProcess != null && HasExited(recoveryProcess)) FinishRecovery();
                return;
            }

            if (helperProcess != null && HasExited(helperProcess))
            {
                if (helperExitedAt == DateTime.MinValue) helperExitedAt = DateTime.UtcNow;
                if ((DateTime.UtcNow - helperExitedAt).TotalMilliseconds >= 700D) StartRecovery();
                return;
            }

            if (cancellationRequested)
            {
                string journalStatus = journal == null ? String.Empty : JsonFiles.StringValue(journal, "status");
                double cancelSeconds = (DateTime.UtcNow - cancelStartedAt).TotalSeconds;
                if (cancelSeconds >= 3D && journalStatus != "rolling-back") ForceStopHelper();
                else if (cancelSeconds >= 120D) ForceStopHelper();
            }
        }

        private void ApplyJournal(Dictionary<string, object> journal)
        {
            string status = JsonFiles.StringValue(journal, "status");
            string phase = JsonFiles.StringValue(journal, "phase");
            string message = JsonFiles.StringValue(journal, "message");
            string item = JsonFiles.StringValue(journal, "item");
            double value = JsonFiles.DoubleValue(journal, "progress", progress.Value);
            progress.Value = Math.Max(0D, Math.Min(1D, value));
            progress.Indeterminate = status == "waiting-for-exit" || status == "rolling-back";
            percentLabel.Text = ((int)Math.Round(progress.Value * 100D)).ToString(CultureInfo.InvariantCulture) + "%";

            if (status == "waiting-for-exit") statusLabel.Text = "正在等待星藏家安全退出";
            else if (status == "backing-up") statusLabel.Text = request.Mode == "migrate" ? "正在备份当前 Workspace" : "正在备份当前应用";
            else if (status == "applying") statusLabel.Text = request.Mode == "migrate" ? "正在迁移用户数据" : "正在安装新版本";
            else if (status == "rolling-back") statusLabel.Text = "正在恢复更新前状态";
            else statusLabel.Text = cancellationRequested ? "正在中止并准备回退" : "正在执行安全事务";

            if (status == "waiting-for-exit") detailLabel.Text = "主应用退出前不会修改任何文件。";
            else if (status == "backing-up") detailLabel.Text = "每个完成备份的项目都会立即写入事务日志。";
            else if (status == "applying") detailLabel.Text = request.Mode == "migrate" ? "正在从旧版本复制完整 Workspace。" : "正在写入经过校验的新版本核心文件。";
            else if (status == "rolling-back") detailLabel.Text = "正在依据事务日志恢复已变更的项目。";
            else if (!String.IsNullOrWhiteSpace(message)) detailLabel.Text = message;
            itemLabel.Text = String.IsNullOrWhiteSpace(item) ? PhaseLabel(phase) : "当前项目：" + item;
        }

        private string PhaseLabel(string phase)
        {
            if (phase == "wait") return "等待主应用释放正在使用的文件...";
            if (phase == "backup") return "正在建立可完整恢复的事务备份...";
            if (phase == "apply") return request.Mode == "migrate" ? "正在复制 Workspace 数据..." : "正在替换应用核心文件...";
            if (phase == "rollback") return "正在从事务备份恢复文件...";
            if (phase == "verify") return "正在校验更新后的关键文件...";
            return "正在处理更新事务...";
        }

        private void CancelOrClose()
        {
            if (terminal)
            {
                closeRequested = true;
                Close();
                return;
            }
            if (cancellationRequested) return;
            DialogResult answer = MessageBox.Show(this, "确定中止当前操作并恢复到操作前状态吗？\r\n\r\n回退完成前请不要强制结束更新器。", "中止并回退", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            BeginCancellation();
        }

        private void BeginCancellation()
        {
            cancellationRequested = true;
            cancelStartedAt = DateTime.UtcNow;
            cancelButton.Enabled = false;
            cancelButton.Text = "正在中止并回退...";
            statusLabel.Text = "正在中止并恢复原版本";
            detailLabel.Text = "已请求停止当前步骤；更新器会验证回退结果后再重新打开星藏家。";
            progress.Indeterminate = true;
            Dictionary<string, object> cancel = new Dictionary<string, object>();
            cancel["operationId"] = request.OperationId;
            cancel["requestedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            JsonFiles.WriteObjectAtomic(request.CancelFile, cancel);
            AppendLog("Cancellation and rollback requested by the user.");
            if (helperProcess == null || HasExited(helperProcess)) StartRecovery();
        }

        private void ForceStopHelper()
        {
            if (forceRecoveryPending || recoveryStarted) return;
            AppendLog("Helper did not reach a cancellation point in time; terminating it before recovery.");
            try
            {
                if (helperProcess != null && !HasExited(helperProcess)) helperProcess.Kill();
            }
            catch (Exception error) { AppendLog("Could not terminate helper immediately: " + error.Message); }
            forceRecoveryPending = true;
        }

        private void StartRecovery()
        {
            if (recoveryStarted || terminal) return;
            recoveryStarted = true;
            progress.Indeterminate = true;
            statusLabel.Text = "正在验证并恢复操作前状态";
            detailLabel.Text = "更新器正在读取事务记录，恢复已替换的文件。";
            itemLabel.Text = "回退期间请保持此窗口开启...";
            AppendLog("Starting recovery helper.");
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = request.PowerShellPath;
                info.Arguments = JoinArguments(new string[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", request.RecoveryPath, "-ProjectRoot", request.ProjectRoot });
                info.WorkingDirectory = request.ProjectRoot;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                recoveryProcess = StartLoggedProcess(info, "recovery");
            }
            catch (Exception error)
            {
                AppendLog("Recovery could not start: " + error);
                WriteLocalResult("recovery-failed", "无法启动回退程序：" + error.Message);
                CompleteFromResult(SafeRead(request.ResultFile));
            }
        }

        private void FinishRecovery()
        {
            Dictionary<string, object> result = SafeRead(request.ResultFile);
            if (!MatchesOperation(result))
            {
                int exitCode = SafeExitCode(recoveryProcess);
                string status = exitCode == 0 ? (cancellationRequested ? "cancelled" : "rolled-back") : "recovery-failed";
                string message = exitCode == 0 ? "操作已停止，原版本保持不变。" : "回退程序异常退出，请保留 .updates 目录进行诊断。";
                WriteLocalResult(status, message);
                result = SafeRead(request.ResultFile);
            }
            CompleteFromResult(result);
        }

        private void CompleteFromResult(Dictionary<string, object> result)
        {
            if (terminal) return;
            terminal = true;
            monitorTimer.Stop();
            progress.Indeterminate = false;
            cancelButton.Enabled = true;
            cancelButton.Text = "关闭";
            cancelButton.BackColor = Color.FromArgb(235, 247, 252);
            cancelButton.ForeColor = Color.FromArgb(25, 101, 145);
            cancelButton.FlatAppearance.BorderColor = Color.FromArgb(137, 194, 221);
            string status = result == null ? "recovery-failed" : JsonFiles.StringValue(result, "status");
            string message = result == null ? "没有读取到可靠的操作结果。" : JsonFiles.StringValue(result, "message");

            if (status == "succeeded")
            {
                progress.Value = 1D;
                percentLabel.Text = "100%";
                titleLabel.Text = request.Mode == "migrate" ? "数据迁移完成" : "星藏家更新完成";
                statusLabel.Text = request.Mode == "migrate" ? "旧版本数据已安全迁移" : "v" + request.TargetVersion + " 已安装完成";
                detailLabel.Text = "正在重新打开星藏家；Workspace、模型与运行时依赖均已保留。";
                itemLabel.Text = "操作已通过事务校验";
                statusLabel.ForeColor = Color.FromArgb(31, 137, 106);
                ScheduleRelaunchAndClose(true);
            }
            else if (status == "cancelled" || status == "rolled-back")
            {
                progress.Value = 1D;
                percentLabel.Text = "100%";
                titleLabel.Text = cancellationRequested ? "更新已中止并回退" : "安装未完成，已安全回退";
                statusLabel.Text = "已恢复到操作前状态";
                detailLabel.Text = String.IsNullOrWhiteSpace(message) ? "原应用文件和用户数据保持可用。" : message;
                itemLabel.Text = "正在重新打开原版本星藏家";
                statusLabel.ForeColor = Color.FromArgb(181, 112, 30);
                ScheduleRelaunchAndClose(false);
            }
            else
            {
                titleLabel.Text = "自动回退需要人工检查";
                statusLabel.Text = "请保留当前应用目录和 .updates 目录";
                detailLabel.Text = String.IsNullOrWhiteSpace(message) ? "回退结果无法确认，请不要删除事务备份。" : message;
                itemLabel.Text = "诊断日志：" + request.LogFile;
                statusLabel.ForeColor = Color.FromArgb(190, 57, 83);
            }
            TopMost = false;
            try { if (File.Exists(request.ReadyFile)) File.Delete(request.ReadyFile); } catch { }
            try { if (File.Exists(request.AcknowledgeFile)) File.Delete(request.AcknowledgeFile); } catch { }
            try { if (File.Exists(request.CancelFile)) File.Delete(request.CancelFile); } catch { }
            AppendLog("Terminal updater result: " + status + " - " + message);
            if (request.DisableRelaunch && request.Headless)
            {
                System.Windows.Forms.Timer testCloser = new System.Windows.Forms.Timer();
                testCloser.Interval = 250;
                testCloser.Tick += delegate { testCloser.Stop(); closeRequested = true; Close(); };
                testCloser.Start();
            }
        }

        private void ScheduleRelaunchAndClose(bool closeAfterLaunch)
        {
            if (request.DisableRelaunch) return;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 650;
            timer.Tick += delegate
            {
                timer.Stop();
                StartLauncher();
                if (closeAfterLaunch)
                {
                    System.Windows.Forms.Timer closer = new System.Windows.Forms.Timer();
                    closer.Interval = 1800;
                    closer.Tick += delegate { closer.Stop(); closeRequested = true; Close(); };
                    closer.Start();
                }
            };
            timer.Start();
        }

        private void StartLauncher()
        {
            if (launcherStarted || request.DisableRelaunch) return;
            launcherStarted = true;
            string launcher = Path.Combine(request.ProjectRoot, "Start-StarOwner.cmd");
            if (!File.Exists(launcher))
            {
                AppendLog("Launcher is missing after the operation: " + launcher);
                return;
            }
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = request.CommandPath;
                info.Arguments = "/d /s /c " + QuoteArgument(launcher);
                info.WorkingDirectory = request.ProjectRoot;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                Process.Start(info);
                AppendLog("Application launcher started.");
            }
            catch (Exception error) { AppendLog("Could not relaunch the application: " + error); }
        }

        private void WriteLocalResult(string status, string message)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["operationId"] = request.OperationId;
            result["mode"] = request.Mode;
            result["status"] = status;
            result["message"] = message;
            result["targetVersion"] = request.TargetVersion;
            result["finishedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            JsonFiles.WriteObjectAtomic(request.ResultFile, result);
        }

        private Dictionary<string, object> SafeRead(string path)
        {
            try { return File.Exists(path) ? JsonFiles.ReadObject(path) : null; }
            catch { return null; }
        }

        private bool MatchesOperation(Dictionary<string, object> value)
        {
            return value != null && String.Equals(JsonFiles.StringValue(value, "operationId"), request.OperationId, StringComparison.Ordinal);
        }

        private bool HasExited(Process process)
        {
            try { return process == null || process.HasExited; } catch { return true; }
        }

        private int SafeExitCode(Process process)
        {
            try { return process == null || !process.HasExited ? -1 : process.ExitCode; } catch { return -1; }
        }

        private void AppendLog(string message)
        {
            if (previewMode || String.IsNullOrEmpty(request.LogFile)) return;
            try
            {
                lock (logLock)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(request.LogFile));
                    File.AppendAllText(request.LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { }
        }

        private void OpenLog()
        {
            if (previewMode || String.IsNullOrEmpty(request.LogFile)) return;
            try
            {
                if (!File.Exists(request.LogFile)) File.WriteAllText(request.LogFile, String.Empty, new UTF8Encoding(false));
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = request.LogFile;
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch (Exception error) { MessageBox.Show(this, error.Message, "无法打开日志", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }

        private void OnUpdaterClosing(object sender, FormClosingEventArgs args)
        {
            if (previewMode || terminal || closeRequested) return;
            args.Cancel = true;
            if (cancellationRequested)
            {
                MessageBox.Show(this, "回退尚未完成，请保持更新器开启。", "正在保护应用数据", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            CancelOrClose();
        }

        private static string JoinArguments(string[] arguments)
        {
            StringBuilder builder = new StringBuilder();
            for (int index = 0; index < arguments.Length; index++)
            {
                if (index > 0) builder.Append(' ');
                builder.Append(QuoteArgument(arguments[index] ?? String.Empty));
            }
            return builder.ToString();
        }

        private static string QuoteArgument(string value)
        {
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
    }

    internal sealed class SmoothProgress : Control
    {
        public double Value = 0D;
        public bool Indeterminate;
        public int Frame;

        public SmoothProgress()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint, true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            Graphics graphics = args.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle track = new Rectangle(0, 1, Math.Max(1, Width - 1), Math.Max(8, Height - 3));
            using (GraphicsPath trackPath = Rounded(track, 6))
            using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(218, 234, 242))) graphics.FillPath(trackBrush, trackPath);
            int width = Indeterminate ? Math.Max(70, Width / 4) : (int)Math.Round((Width - 1) * Math.Max(0D, Math.Min(1D, Value)));
            int start = Indeterminate ? (Frame * 5 % (Width + width)) - width : 0;
            Rectangle fill = new Rectangle(start, 1, Math.Max(1, width), Math.Max(8, Height - 3));
            graphics.SetClip(track);
            using (LinearGradientBrush brush = new LinearGradientBrush(fill, Color.FromArgb(54, 182, 216), Color.FromArgb(91, 216, 177), LinearGradientMode.Horizontal))
            using (GraphicsPath fillPath = Rounded(fill, 6)) graphics.FillPath(brush, fillPath);
            if (width > 24)
            {
                int shine = Indeterminate ? start + width / 2 : (Frame * 4 % Math.Max(1, width + 60)) - 30;
                using (LinearGradientBrush glint = new LinearGradientBrush(new Rectangle(shine, 0, 40, Height), Color.FromArgb(0, 255, 255, 255), Color.FromArgb(120, 255, 255, 255), LinearGradientMode.Horizontal)) graphics.FillRectangle(glint, shine, 0, 40, Height);
            }
            graphics.ResetClip();
        }

        private static GraphicsPath Rounded(Rectangle rectangle, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int diameter = radius * 2;
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class AnimatedLogo : Control
    {
        private Image logo;
        public int Frame;

        public AnimatedLogo(string iconPath)
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint, true);
            BackColor = Color.Transparent;
            try
            {
                if (!String.IsNullOrEmpty(iconPath) && File.Exists(iconPath)) logo = Image.FromFile(iconPath);
                else logo = Icon.ExtractAssociatedIcon(Application.ExecutablePath).ToBitmap();
            }
            catch { logo = null; }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && logo != null) logo.Dispose();
            base.Dispose(disposing);
        }

        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            Graphics graphics = args.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            float cx = Width / 2F;
            float cy = Height / 2F - 4F;
            double time = Frame / 30D;

            for (int ring = 0; ring < 3; ring++)
            {
                double phase = (time * 0.34D + ring / 3D) % 1D;
                float radius = 62F + (float)phase * 70F;
                int alpha = (int)(78D * (1D - phase));
                using (Pen pen = new Pen(Color.FromArgb(Math.Max(0, alpha), ring == 1 ? 242 : 73, ring == 1 ? 152 : 190, ring == 1 ? 187 : 223), 2F))
                    graphics.DrawEllipse(pen, cx - radius * 1.34F, cy - radius * 0.48F, radius * 2.68F, radius * 0.96F);
            }

            using (Pen orbit = new Pen(Color.FromArgb(55, 67, 175, 215), 1.2F))
            {
                graphics.TranslateTransform(cx, cy);
                graphics.RotateTransform((float)(time * 15D));
                graphics.DrawEllipse(orbit, -128F, -46F, 256F, 92F);
                graphics.ResetTransform();
            }

            Color[] sparkColors = new Color[] { Color.FromArgb(244, 140, 176), Color.FromArgb(74, 190, 221), Color.FromArgb(255, 198, 91), Color.FromArgb(89, 209, 173) };
            for (int index = 0; index < 15; index++)
            {
                double angle = index * 2.399D + time * (0.22D + (index % 3) * 0.05D);
                double radius = 74D + (index % 5) * 18D + Math.Sin(time * 1.2D + index) * 7D;
                float x = cx + (float)(Math.Cos(angle) * radius * 1.45D);
                float y = cy + (float)(Math.Sin(angle) * radius * 0.58D);
                float size = 2.5F + (index % 4);
                Color color = sparkColors[index % sparkColors.Length];
                int alpha = 100 + (int)(80D * (0.5D + 0.5D * Math.Sin(time * 2D + index)));
                using (SolidBrush brush = new SolidBrush(Color.FromArgb(alpha, color))) graphics.FillEllipse(brush, x - size / 2F, y - size / 2F, size, size);
            }

            float pulse = 1F + (float)Math.Sin(time * 2.2D) * 0.035F;
            float iconSize = 112F * pulse;
            using (GraphicsPath glowPath = new GraphicsPath())
            {
                glowPath.AddEllipse(cx - iconSize * 0.66F, cy - iconSize * 0.66F, iconSize * 1.32F, iconSize * 1.32F);
                using (PathGradientBrush glow = new PathGradientBrush(glowPath))
                {
                    glow.CenterColor = Color.FromArgb(78, 255, 255, 255);
                    glow.SurroundColors = new Color[] { Color.FromArgb(0, 92, 197, 222) };
                    graphics.FillPath(glow, glowPath);
                }
            }
            if (logo != null) graphics.DrawImage(logo, cx - iconSize / 2F, cy - iconSize / 2F, iconSize, iconSize);

            using (Font font = new Font("Segoe UI", 8.5F, FontStyle.Bold, GraphicsUnit.Point))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(115, 76, 123, 148)))
            {
                string text = "STAR OWNER  /  SAFE UPDATE";
                SizeF measured = graphics.MeasureString(text, font);
                graphics.DrawString(text, font, brush, cx - measured.Width / 2F, Height - 23F);
            }
        }
    }
}
