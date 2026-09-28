// Keyway for Windows: setup window + tray status + gateway supervisor.
//
// Single file, C# 5, .NET Framework 4.8 (in-box on Windows 10/11). Build with
// the compiler that ships with Windows, no SDK required (see make-dist.ps1).
//
//   Keyway.exe               setup window (provider, endpoint, key, models)
//   Keyway.exe --background  tray icon; keeps node.exe gateway.mjs running
//
// setup.mjs does the actual install; this app only collects input, shows
// status, and (in --background mode) plays the role launchd plays on macOS.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Keyway")]
[assembly: System.Reflection.AssemblyProduct("Keyway")]
[assembly: System.Reflection.AssemblyVersion("0.3.0.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.3.0")]

namespace Keyway
{
    class Preset
    {
        public string Name, Upstream, Models;
        public Preset(string name, string upstream, string models) { Name = name; Upstream = upstream; Models = models; }
    }

    static class Paths
    {
        public static readonly string ExeDir = Path.GetDirectoryName(Application.ExecutablePath);
        public static readonly string Support = Environment.GetEnvironmentVariable("KEYWAY_SUPPORT_DIR") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Keyway");
        public static string Config { get { return Path.Combine(Support, "config.json"); } }
        public static string Log { get { return Path.Combine(Support, "gateway.log"); } }

        // Release layout: Keyway.exe + resources\{node.exe,setup.mjs,gateway.mjs}.
        // Installed layout (%LOCALAPPDATA%\Keyway): everything side by side.
        public static string Resource(string name)
        {
            string a = Path.Combine(ExeDir, "resources", name);
            return File.Exists(a) ? a : Path.Combine(ExeDir, name);
        }

        public static int Port()
        {
            try
            {
                var cfg = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Config));
                object p;
                if (cfg.TryGetValue("port", out p)) return Convert.ToInt32(p);
            }
            catch { }
            return 8788;
        }
    }

    static class Program
    {
        public const string Version = "0.3.0";
        public const string Repo = "shivamtiwari3/keyway";

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool background = args.Contains("--background");
            bool created;
            using (var mutex = new Mutex(true, background ? @"Local\Keyway.Background" : @"Local\Keyway.Setup", out created))
            {
                if (!created)
                {
                    if (!background) FocusExistingWindow();
                    return;
                }
                if (background) Application.Run(new TrayContext());
                else Application.Run(new SetupForm());
            }
        }

        static void FocusExistingWindow()
        {
            foreach (var p in Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName))
            {
                if (p.Id == Process.GetCurrentProcess().Id || p.MainWindowHandle == IntPtr.Zero) continue;
                ShowWindow(p.MainWindowHandle, 9 /* SW_RESTORE */);
                SetForegroundWindow(p.MainWindowHandle);
            }
        }

        // Newest release tag if it's newer than this build, else null.
        public static string CheckUpdate()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + Repo + "/releases/latest");
                req.Timeout = 5000;
                req.UserAgent = "Keyway/" + Version;
                req.Accept = "application/vnd.github+json";
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var r = new StreamReader(resp.GetResponseStream()))
                {
                    var obj = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(r.ReadToEnd());
                    object tag;
                    if (obj.TryGetValue("tag_name", out tag) && IsNewer(ParseVersion((string)tag), ParseVersion(Version))) return (string)tag;
                }
            }
            catch { }
            return null;
        }

        static int[] ParseVersion(string s)
        {
            return s.TrimStart('v', 'V').Split('.').Select(part =>
            {
                string digits = new string(part.TakeWhile(char.IsDigit).ToArray());
                int n; return int.TryParse(digits, out n) ? n : 0;
            }).ToArray();
        }

        static bool IsNewer(int[] a, int[] b)
        {
            for (int i = 0; i < Math.Max(a.Length, b.Length); i++)
            {
                int x = i < a.Length ? a[i] : 0, y = i < b.Length ? b[i] : 0;
                if (x != y) return x > y;
            }
            return false;
        }

        public static Icon MakeIcon(Color color, int size)
        {
            using (var bmp = new Bitmap(size, size))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    float pad = size / 16f;
                    using (var b = new SolidBrush(color)) g.FillEllipse(b, pad, pad, size - 2 * pad, size - 2 * pad);
                    using (var f = new Font("Segoe UI", size * 0.5f, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                        g.DrawString("K", f, Brushes.White, new RectangleF(0, size * 0.03f, size, size), sf);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
    }

    // ------------------------------------------------------------------
    // Health polling (shared by tray + window)
    // ------------------------------------------------------------------

    class HealthInfo
    {
        public bool Connected;
        public string Provider = "Provider", Detail = "";

        public static HealthInfo Poll()
        {
            var h = new HealthInfo();
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Paths.Port() + "/health");
                req.Timeout = 2000;
                req.Proxy = null; // loopback; never route through a system proxy
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var r = new StreamReader(resp.GetResponseStream()))
                {
                    if (resp.StatusCode != HttpStatusCode.OK) return h;
                    h.Connected = true;
                    var obj = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(r.ReadToEnd());
                    object v;
                    if (obj.TryGetValue("providerName", out v) && v != null) h.Provider = v.ToString();
                    string api = obj.TryGetValue("api", out v) && v != null ? v.ToString() : "?";
                    int n = obj.TryGetValue("models", out v) && v is System.Collections.ICollection ? ((System.Collections.ICollection)v).Count : 0;
                    h.Detail = api + " · " + n + (n == 1 ? " model" : " models");
                }
            }
            catch { }
            return h;
        }
    }

    // ------------------------------------------------------------------
    // Background mode: tray icon + gateway supervisor
    // ------------------------------------------------------------------

    class TrayContext : ApplicationContext
    {
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly ToolStripMenuItem statusItem = new ToolStripMenuItem("Checking…") { Enabled = false };
        readonly ToolStripMenuItem detailItem = new ToolStripMenuItem("") { Enabled = false, Visible = false };
        readonly ToolStripMenuItem updateItem = new ToolStripMenuItem("") { Visible = false };
        readonly Icon onIcon = Program.MakeIcon(Color.FromArgb(22, 163, 74), 32);
        readonly Icon offIcon = Program.MakeIcon(Color.FromArgb(120, 120, 120), 32);
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 5000 };
        readonly Supervisor supervisor = new Supervisor();
        string updateTag;

        public TrayContext()
        {
            updateItem.Click += delegate { Process.Start("https://github.com/" + Program.Repo + "/releases/latest"); };
            menu.Items.Add(statusItem);
            menu.Items.Add(detailItem);
            menu.Items.Add(updateItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Open Setup…", null, delegate { OpenSetup(); });
            menu.Items.Add("Restart Gateway", null, delegate { supervisor.Restart(); Refresh(); });
            menu.Items.Add("Open Log", null, delegate { if (File.Exists(Paths.Log)) Process.Start("notepad.exe", "\"" + Paths.Log + "\""); });
            menu.Items.Add("Copy Diagnostics", null, delegate { CopyDiagnostics(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit Keyway (stops gateway)", null, delegate { Quit(); });

            tray.Icon = offIcon;
            tray.Text = "Keyway";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenSetup(); };
            tray.BalloonTipClicked += delegate { supervisor.Restart(); Refresh(); };

            supervisor.Start();
            timer.Tick += delegate { Refresh(); };
            timer.Start();
            Refresh();
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string tag = Program.CheckUpdate();
                if (tag != null) menu.BeginInvoke((Action)(() => { updateTag = tag; updateItem.Text = "Update available: " + tag; updateItem.Visible = true; }));
            });
        }

        bool polling;
        int downPolls;
        void Refresh()
        {
            if (polling) return;
            polling = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var h = HealthInfo.Poll();
                try
                {
                    menu.BeginInvoke((Action)(() =>
                    {
                        polling = false;
                        statusItem.Text = h.Connected ? "● Connected — " + h.Provider : "○ Not running";
                        detailItem.Text = h.Detail;
                        detailItem.Visible = h.Connected && h.Detail.Length > 0;
                        tray.Icon = h.Connected ? onIcon : offIcon;
                        // Claude Desktop just spins when the gateway is down, so say so loudly (once per outage).
                        downPolls = h.Connected ? 0 : downPolls + 1;
                        if (downPolls == 3)
                            tray.ShowBalloonTip(15000, "Keyway gateway is not running",
                                "Claude Desktop can't get replies. Click to restart the gateway, or open Setup → Remove to switch Claude back to normal.",
                                ToolTipIcon.Warning);
                        string tip = h.Connected ? "Keyway — " + h.Provider : "Keyway — off";
                        tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
                    }));
                }
                catch { polling = false; }
            });
        }

        static void OpenSetup()
        {
            try { Process.Start(Application.ExecutablePath); } catch { }
        }

        void CopyDiagnostics()
        {
            var h = HealthInfo.Poll();
            string text = "Keyway " + Program.Version + " (Windows)\r\n" +
                          "connected=" + h.Connected.ToString().ToLower() + "\r\n" +
                          "provider=" + h.Provider + "\r\n" +
                          "detail=" + h.Detail + "\r\n" +
                          "port=" + Paths.Port() + "\r\n" +
                          "log=" + Paths.Log + "\r\n" +
                          (updateTag != null ? "update=" + updateTag + "\r\n" : "");
            try { Clipboard.SetText(text); } catch { }
        }

        void Quit()
        {
            timer.Stop();
            supervisor.Stop();
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }
    }

    // Keeps node.exe gateway.mjs alive with a hidden window, like launchd KeepAlive.
    class Supervisor
    {
        Process child;
        volatile bool stopping;
        int failures;
        readonly object gate = new object();
        string PidFile(string name) { return Path.Combine(Paths.Support, name); }

        public void Start()
        {
            Directory.CreateDirectory(Paths.Support);
            File.WriteAllText(PidFile("keyway.pid"), Process.GetCurrentProcess().Id.ToString());
            KillStale();
            Launch();
        }

        // A gateway orphaned by a previous crash would hold the port.
        void KillStale()
        {
            try
            {
                int pid = int.Parse(File.ReadAllText(PidFile("gateway.pid")).Trim());
                var p = Process.GetProcessById(pid);
                if (p.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); }
            }
            catch { }
        }

        void Launch()
        {
            lock (gate)
            {
                if (stopping) return;
                string node = Paths.Resource("node.exe"), gateway = Paths.Resource("gateway.mjs");
                if (!File.Exists(node) || !File.Exists(gateway) || !File.Exists(Paths.Config))
                {
                    Append("[keyway] gateway not installed (missing node.exe, gateway.mjs or config.json)");
                    return;
                }
                var psi = new ProcessStartInfo(node, "\"" + gateway + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, // node writes UTF-8, not the ANSI code page
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = Paths.Support,
                };
                psi.EnvironmentVariables["KEYWAY_CONFIG"] = Paths.Config;
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => { if (e.Data != null) Append(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) Append(e.Data); };
                p.Exited += OnExited;
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                child = p;
                try { File.WriteAllText(PidFile("gateway.pid"), p.Id.ToString()); } catch { }
            }
        }

        void OnExited(object sender, EventArgs e)
        {
            if (stopping) return;
            var p = (Process)sender;
            int code = 0;
            try { code = p.ExitCode; } catch { }
            TimeSpan ran = TimeSpan.Zero;
            try { ran = p.ExitTime - p.StartTime; } catch { }
            failures = ran.TotalSeconds > 30 ? 1 : failures + 1;
            int delay = Math.Min(30, 1 << Math.Min(failures - 1, 5)); // 1,2,4,8,16,30s
            Append("[keyway] gateway exited (code " + code + "); restarting in " + delay + "s");
            ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(delay * 1000); Launch(); });
        }

        public void Restart()
        {
            lock (gate)
            {
                failures = 0;
                var p = child;
                child = null;
                if (p != null) { p.Exited -= OnExited; try { if (!p.HasExited) { p.Kill(); p.WaitForExit(3000); } } catch { } }
            }
            Launch();
        }

        public void Stop()
        {
            stopping = true;
            lock (gate)
            {
                try { if (child != null && !child.HasExited) { child.Kill(); child.WaitForExit(3000); } } catch { }
                child = null;
            }
            try { File.Delete(PidFile("gateway.pid")); } catch { }
            try { File.Delete(PidFile("keyway.pid")); } catch { }
        }

        static readonly object logGate = new object();
        static void Append(string line)
        {
            lock (logGate)
            {
                try
                {
                    // Keep the log bounded: roll over at 5 MB.
                    var fi = new FileInfo(Paths.Log);
                    if (fi.Exists && fi.Length > 5 * 1024 * 1024) File.Copy(Paths.Log, Paths.Log + ".1", true);
                    if (fi.Exists && fi.Length > 5 * 1024 * 1024) File.WriteAllText(Paths.Log, "");
                    File.AppendAllText(Paths.Log, line + Environment.NewLine);
                }
                catch { }
            }
        }
    }

    // ------------------------------------------------------------------
    // Setup window
    // ------------------------------------------------------------------

    class SetupForm : Form
    {
        static readonly Preset[] Presets =
        {
            new Preset("Anthropic", "https://api.anthropic.com", "claude-sonnet-4-20250514"),
            new Preset("OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"),
            new Preset("OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini"),
            new Preset("Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
            new Preset("DeepSeek", "https://api.deepseek.com/anthropic", "deepseek-chat"),
            new Preset("Ollama (local)", "http://127.0.0.1:11434/v1", "llama3.2"),
            new Preset("Custom", "", ""),
        };

        readonly ComboBox provider = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
        readonly TextBox endpoint = new TextBox { Dock = DockStyle.Fill };
        readonly TextBox apiKey = new TextBox { Dock = DockStyle.Fill, UseSystemPasswordChar = true };
        readonly TextBox models = new TextBox { Dock = DockStyle.Fill };
        readonly Label status = new Label { AutoSize = true, Text = "Checking…", Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 10f, FontStyle.Bold) };
        readonly Panel dot = new Panel { Width = 12, Height = 12, Margin = new Padding(0, 5, 6, 0) };
        readonly Button install = new Button { Text = "Install", AutoSize = true };
        readonly Button remove = new Button { Text = "Remove", AutoSize = true };
        readonly Button refresh = new Button { Text = "⟳", Width = 36 };
        readonly TextBox log = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Font = new Font("Consolas", 8.5f), Visible = false };
        bool installed, busy, syncing;

        public SetupForm()
        {
            Text = "Keyway";
            Icon = Program.MakeIcon(Color.FromArgb(217, 119, 6), 32);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = SystemFonts.MessageBoxFont;
            ClientSize = new Size(600, 330); // grows when the output log is first shown
            Padding = new Padding(20);

            var title = new Label { Text = "Keyway", AutoSize = true, Font = new Font(Font.FontFamily, 18f, FontStyle.Bold) };
            var subtitle = new Label { Text = "Bring your own key — use any provider's models inside Claude Desktop.", AutoSize = true, ForeColor = SystemColors.GrayText };

            var statusRow = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 8) };
            statusRow.Controls.Add(dot);
            statusRow.Controls.Add(status);
            MakeRound(dot);

            var grid = new TableLayoutPanel { ColumnCount = 2, Dock = DockStyle.Fill, AutoSize = true };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            AddRow(grid, "Provider", provider);
            AddRow(grid, "Endpoint", endpoint);
            AddRow(grid, "API key", apiKey);
            AddRow(grid, "Models", models);

            var hint = new Label { Text = "Comma-separated. Up to 8; the first is the default.", AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(93, 0, 0, 6) };

            var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 6, 0, 8) };
            buttons.Controls.Add(install);
            buttons.Controls.Add(remove);
            buttons.Controls.Add(refresh);

            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1 };
            root.Controls.Add(title);
            root.Controls.Add(subtitle);
            root.Controls.Add(statusRow);
            root.Controls.Add(grid);
            root.Controls.Add(hint);
            root.Controls.Add(buttons);
            root.Controls.Add(log);
            for (int i = 0; i < 6; i++) root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Controls.Add(root);

            foreach (var p in Presets) provider.Items.Add(p.Name);
            provider.SelectedIndexChanged += delegate { ApplyPreset(); };
            endpoint.TextChanged += delegate { SyncPresetFromEndpoint(); UpdateButtons(); };
            apiKey.TextChanged += delegate { UpdateButtons(); };
            models.TextChanged += delegate { UpdateButtons(); };
            install.Click += delegate { DoInstall(); };
            remove.Click += delegate { DoRemove(); };
            refresh.Click += delegate { RefreshStatus(); };
            AcceptButton = install;

            LoadExistingConfig();
            Shown += delegate { RefreshStatus(); };
        }

        static void AddRow(TableLayoutPanel grid, string label, Control c)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = SystemColors.GrayText, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 0, 6) });
            c.Margin = new Padding(3, 3, 3, 3);
            grid.Controls.Add(c);
        }

        static void MakeRound(Control c)
        {
            var path = new GraphicsPath();
            path.AddEllipse(0, 0, c.Width, c.Height);
            c.Region = new Region(path);
        }

        // Prefill from an existing install so "Update" doesn't need everything retyped.
        void LoadExistingConfig()
        {
            provider.SelectedItem = "OpenAI";
            try
            {
                var cfg = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Paths.Config));
                object v;
                syncing = true;
                if (cfg.TryGetValue("providerName", out v) && v != null)
                    provider.SelectedItem = Presets.Any(p => p.Name == v.ToString()) ? v.ToString() : "Custom";
                if (cfg.TryGetValue("upstream", out v) && v != null) endpoint.Text = v.ToString();
                if (cfg.TryGetValue("modelMap", out v) && v is Dictionary<string, object>)
                    models.Text = string.Join(", ", ((Dictionary<string, object>)v).Values.Select(x => x.ToString()).Distinct());
            }
            catch { }
            finally { syncing = false; }
            UpdateButtons();
        }

        void ApplyPreset()
        {
            if (syncing) return;
            var p = Presets.FirstOrDefault(x => x.Name == (string)provider.SelectedItem);
            if (p == null || p.Name == "Custom") return;
            syncing = true;
            endpoint.Text = p.Upstream;
            models.Text = p.Models;
            syncing = false;
        }

        void SyncPresetFromEndpoint()
        {
            if (syncing) return;
            var p = Presets.FirstOrDefault(x => x.Upstream == endpoint.Text.Trim() && x.Name != "Custom");
            syncing = true;
            provider.SelectedItem = p != null ? p.Name : "Custom";
            syncing = false;
        }

        // Installed and not changing the key: setup.mjs reuses the stored key.
        bool CanInstall
        {
            get { return !busy && (apiKey.Text.Length > 0 || installed) && endpoint.Text.Trim().Length > 0 && models.Text.Trim().Length > 0; }
        }

        void UpdateButtons()
        {
            install.Enabled = CanInstall;
            install.Text = installed ? "Update" : "Install";
            remove.Enabled = !busy && installed;
            refresh.Enabled = !busy;
            UseWaitCursor = busy;
        }

        void SetStatus(string text, bool ok)
        {
            status.Text = text;
            dot.BackColor = ok ? Color.FromArgb(22, 163, 74) : Color.Gray;
        }

        void RefreshStatus()
        {
            Run(new[] { "status" }, "status");
        }

        void DoInstall()
        {
            var answer = MessageBox.Show(this,
                "Keyway will start the local gateway and switch Claude Desktop to use it.\n\n" +
                "Claude Desktop will be closed and reopened. Any conversation that is generating a reply will be interrupted.\n\nContinue?",
                "Keyway", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (answer != DialogResult.OK) return;
            var args = new List<string> { "install" };
            if (apiKey.Text.Length > 0) { args.Add("--key"); args.Add(apiKey.Text.Trim()); }
            args.AddRange(new[] {
                "--provider-name", (string)provider.SelectedItem ?? "Provider",
                "--upstream", endpoint.Text.Trim(),
                "--api", "auto",
                "--models", models.Text.Trim(),
            });
            Run(args.ToArray(), "install");
        }

        void DoRemove()
        {
            var answer = MessageBox.Show(this,
                "Remove Keyway? Claude Desktop will be switched back to its normal sign-in and restarted.",
                "Keyway", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
            if (answer != DialogResult.OK) return;
            Run(new[] { "uninstall" }, "uninstall");
        }

        void Run(string[] args, string label)
        {
            busy = true;
            UpdateButtons();
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string output;
                int code = RunSetup(args, out output);
                BeginInvoke((Action)(() => Finished(label, code, output)));
            });
        }

        static int RunSetup(string[] args, out string output)
        {
            string node = Paths.Resource("node.exe"), setup = Paths.Resource("setup.mjs");
            if (!File.Exists(node) || !File.Exists(setup)) { output = "error: node.exe or setup.mjs not found next to Keyway.exe"; return -1; }
            var psi = new ProcessStartInfo(node, Quote(setup) + " " + string.Join(" ", args.Select(Quote)))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            var sb = new StringBuilder();
            try
            {
                using (var p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                    p.Start();
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (!p.WaitForExit(240000)) { try { p.Kill(); } catch { } sb.AppendLine("error: timed out"); }
                    p.WaitForExit();
                    output = sb.ToString().Trim();
                    if (p.ExitCode != 0 && output.Length == 0) output = "error: exit code " + p.ExitCode;
                    return p.ExitCode;
                }
            }
            catch (Exception e) { output = "error: " + e.Message; return -1; }
        }

        // Windows command-line quoting (CommandLineToArgvW rules).
        static string Quote(string s)
        {
            if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
            var sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in s)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') sb.Append('\\', backslashes * 2 + 1).Append('"');
                else sb.Append('\\', backslashes).Append(c);
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2).Append('"');
            return sb.ToString();
        }

        void Finished(string label, int code, string output)
        {
            busy = false;
            if (label != "status")
            {
                if (!log.Visible) { log.Visible = true; ClientSize = new Size(ClientSize.Width, ClientSize.Height + 130); }
                log.Text = output.Length == 0 ? "(no output)" : output.Replace("\n", "\r\n").Replace("\r\r\n", "\r\n");
            }
            if (label == "install")
            {
                bool ok = code == 0 && output.Contains("installed");
                installed = installed || ok;
                SetStatus(ok ? "Installed · Claude Desktop restarting…" : "Install failed", ok);
                if (ok) apiKey.Text = "";
            }
            else if (label == "uninstall")
            {
                installed = false;
                SetStatus(code == 0 ? "Not installed" : "Remove failed", false);
            }
            else
            {
                installed = code == 0 && output.Contains("installed") && !output.Contains("not-installed");
                SetStatus(installed ? "Installed" : "Not installed", installed);
                if (installed)
                {
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        var h = HealthInfo.Poll();
                        try { BeginInvoke((Action)(() => { if (installed) SetStatus(h.Connected ? "Installed · Connected — " + h.Provider : "Installed · gateway not running", h.Connected); })); } catch { }
                    });
                }
            }
            UpdateButtons();
        }
    }
}
