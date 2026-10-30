using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MusicArchive
{
    internal sealed class MainForm : Form
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern IntPtr SetClassLongPtr(IntPtr hwnd, int index, IntPtr value);
        private Icon _appIcon;

        private void ApplyDarkTitleBar(bool dark)
        {
            try
            {
                int value = dark ? 1 : 0;
                DwmSetWindowAttribute(Handle, 20, ref value, sizeof(int)); // DWMWA_USE_IMMERSIVE_DARK_MODE
                var background = dark ? Color.FromArgb(11, 13, 16) : Color.FromArgb(243, 239, 231);
                BackColor = background;
                if (_web != null) _web.DefaultBackgroundColor = background;
            }
            catch { }
        }
        private void SetTheme(JsonElement args)
        {
            var dark = !(args.ValueKind == JsonValueKind.Object && args.TryGetProperty("dark", out var d) && d.ValueKind == JsonValueKind.False);
            ApplyDarkTitleBar(dark);
        }

        private void SetUiScale(JsonElement args)
        {
            try
            {
                var scale = 1.15;
                if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("scale", out var value) && value.TryGetDouble(out var parsed))
                    scale = parsed;
                scale = Math.Max(0.9, Math.Min(1.6, scale));
                _web.ZoomFactor = scale;
            }
            catch { }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (_appIcon == null) return;
            try
            {
                SendMessage(Handle, 0x80, (IntPtr)1, _appIcon.Handle); // WM_SETICON / ICON_BIG
                SendMessage(Handle, 0x80, (IntPtr)0, _appIcon.Handle); // WM_SETICON / ICON_SMALL
                SetClassLongPtr(Handle, -14, _appIcon.Handle);         // GCLP_HICON
                SetClassLongPtr(Handle, -34, _appIcon.Handle);         // GCLP_HICONSM
            }
            catch { }
        }
        private readonly BackendService _backend = new BackendService();
        private readonly RecordingService _recorder = new RecordingService();
        private readonly ExtensionService _extensions = new ExtensionService();
        private readonly Dictionary<string, TaskCompletionSource<object>> _aiPending = new Dictionary<string, TaskCompletionSource<object>>();
        private readonly AiControlService _aiControl;
        private LibraryService _library = new LibraryService();
        private readonly HttpClient _api;
        private readonly HttpClient _adminApi;
        private readonly CookieContainer _adminCookies = new CookieContainer();
        private readonly WebView2 _web = new WebView2();
        private bool _busy;
        private bool _backendReady;
        private bool _adminReady;
        private System.Threading.Timer _likesTimer;
        private bool _likesRunning;
        private bool _likesImporting;
        private readonly string _likesConfigPath = Path.Combine(AppPaths.DataDir, "likes-sync.json");
        private readonly string _likesDir = Path.Combine(AppPaths.DataDir, "likes");
        private readonly string _likesEventsPath = Path.Combine(AppPaths.DataDir, "likes", "events.json");
        private readonly string _likesLastRunPath = Path.Combine(AppPaths.DataDir, "likes", "last-run.json");
        private static readonly JsonSerializerOptions LikesJson = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            WriteIndented = true,
        };

        private sealed class LikesConfig
        {
            public bool Enabled { get; set; } = true;
            public int IntervalHours { get; set; } = 24;
            public bool Backfill { get; set; }
            public bool AutoImport { get; set; } = true;
            public bool GenerateReport { get; set; }
            public bool AutoRemoveUnliked { get; set; } = true;
            public bool AutoDeleteDuplicates { get; set; } = true;
            public bool AutoMaintain { get; set; } = true;
            public int MaintainIntervalHours { get; set; } = 24;
            public string LastMaintainAt { get; set; }
            public string NextMaintainAt { get; set; }
            public string[] Sources { get; set; } = new[] { "soda", "netease", "qq" };
            public string LastRunAt { get; set; }
            public string NextRunAt { get; set; }
            public bool PendingImport { get; set; }
            public string UpdatedAt { get; set; }
        }

        public MainForm()
        {
            _aiControl = new AiControlService(SendAiCommandAsync);
            Text = "留声 · LSA";
            Width = 1440;
            Height = 900;
            MinimumSize = new Size(960, 620);
            WindowState = FormWindowState.Normal;
            StartPosition = FormStartPosition.CenterScreen;
            try
            {
                using var iconStream = typeof(MainForm).Assembly.GetManifestResourceStream("MusicArchive.app.ico");
                if (iconStream != null) _appIcon = new Icon(iconStream, new Size(256, 256));
            }
            catch { }
            if (_appIcon == null)
            {
                try { _appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            }
            if (_appIcon != null) Icon = _appIcon;
            BackColor = Color.FromArgb(11, 13, 16);

            _api = new HttpClient
            {
                BaseAddress = new Uri("http://127.0.0.1:18088/"),
                Timeout = TimeSpan.FromSeconds(30),
            };
            var adminHandler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                UseCookies = true,
                CookieContainer = _adminCookies,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            };
            _adminApi = new HttpClient(adminHandler)
            {
                BaseAddress = new Uri("http://127.0.0.1:18088/"),
                Timeout = TimeSpan.FromSeconds(30),
            };

            _web.Dock = DockStyle.Fill;
            _web.DefaultBackgroundColor = Color.FromArgb(11, 13, 16);
            Controls.Add(_web);

            Shown += async (s, e) => { ApplyDarkTitleBar(true); await StartAsync(); _aiControl.StartIfEnabled(); };
            FormClosing += OnClosing;
        }

        private async Task StartAsync()
        {
            _backendReady = await _backend.EnsureStartedAsync(_ => { });
            if (_backendReady)
            {
                try { await _backend.ConfigureLibraryViaPowerShellAsync(_library.MusicDir); } catch { }
            }
            await InitWebAsync();
            StartLikesScheduler();
        }

        private async Task InitWebAsync()
        {
            try
            {
                var dataFolder = Path.Combine(AppPaths.AppDir, "webview-data");
                Directory.CreateDirectory(dataFolder);
                var env = await CoreWebView2Environment.CreateAsync(null, dataFolder);
                await _web.EnsureCoreWebView2Async(env);
                try { _web.ZoomFactor = 1.0; } catch { }

                var uiDir = Path.Combine(AppPaths.AppDir, "ui");
                _web.CoreWebView2.SetVirtualHostNameToFolderMapping("app.local", uiDir, CoreWebView2HostResourceAccessKind.Allow);
                _web.CoreWebView2.SetVirtualHostNameToFolderMapping("music.local", _library.Config.LibraryRoot, CoreWebView2HostResourceAccessKind.Allow);
                // 音频走独立 audio.local + CORS；app.local 的虚拟目录映射会拦截 /audio 路径。
                _web.CoreWebView2.AddWebResourceRequestedFilter("https://audio.local/audio/*", CoreWebView2WebResourceContext.All);
                _web.CoreWebView2.WebResourceRequested += OnAudioResourceRequested;
                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.WebMessageReceived += OnWebMessage;
                _web.CoreWebView2.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    var target = e.Uri ?? "";
                    // 本机服务地址永远不在系统浏览器里打开；下载器由客户端内嵌界面使用。
                    if (target.StartsWith("http://127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
                        target.StartsWith("http://localhost", StringComparison.OrdinalIgnoreCase)) return;
                    try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
                };
                _web.CoreWebView2.ProcessFailed += (s, e) => { };
                try { await _web.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache); } catch { }
                _web.CoreWebView2.Navigate("https://app.local/index.html?v=20261031-18");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "界面初始化失败：" + ex.Message, "留声", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnAudioResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                var uri = new Uri(e.Request.Uri);
                const string prefix = "/audio/";
                if (!uri.AbsolutePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return;
                const string cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length\r\n";
                if (string.Equals(e.Request.Method, "OPTIONS", StringComparison.OrdinalIgnoreCase))
                {
                    e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(), 204, "No Content", cors + "Content-Length: 0\r\n");
                    return;
                }
                var range = e.Request.Headers.GetHeader("Range");
                var root = Path.GetFullPath(_library.Config.LibraryRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var rel = Uri.UnescapeDataString(uri.AbsolutePath.Substring(prefix.Length)).Replace('/', Path.DirectorySeparatorChar);
                var path = Path.GetFullPath(Path.Combine(root, rel));
                if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
                {
                    e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(), 404, "Not Found", cors + "Content-Length: 0\r\n");
                    return;
                }
                var length = new FileInfo(path).Length;
                long start = 0, end = length - 1;
                var partial = false;
                if (!string.IsNullOrWhiteSpace(range) && range.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
                {
                    partial = true;
                    var spec = range.Substring(6).Split(',')[0].Trim();
                    var dash = spec.IndexOf('-');
                    if (dash >= 0)
                    {
                        var left = spec.Substring(0, dash).Trim();
                        var right = spec.Substring(dash + 1).Trim();
                        if (left.Length == 0 && long.TryParse(right, out var suffix))
                        {
                            start = Math.Max(0, length - suffix);
                            end = length - 1;
                        }
                        else
                        {
                            if (long.TryParse(left, out var s)) start = s;
                            end = string.IsNullOrWhiteSpace(right) ? length - 1 : (long.TryParse(right, out var r2) ? r2 : length - 1);
                        }
                    }
                }
                if (start < 0) start = 0;
                if (end >= length) end = length - 1;
                // 开放式 Range（bytes=0-）不把整张无损专辑读进内存，按 8MB 分段。
                const long maxChunk = 8L * 1024 * 1024;
                if (end - start + 1 > maxChunk) end = start + maxChunk - 1;
                if (start > end || start >= length)
                {
                    e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(), 416, "Range Not Satisfiable",
                        "Content-Range: bytes */" + length + "\r\nContent-Length: 0\r\n");
                    return;
                }
                var count = (int)Math.Min(int.MaxValue, end - start + 1);
                var buffer = new byte[count];
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    fs.Seek(start, SeekOrigin.Begin);
                    var read = 0;
                    while (read < count)
                    {
                        var n = fs.Read(buffer, read, count - read);
                        if (n <= 0) break;
                        read += n;
                    }
                }
                var ext = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
                var mime = ext == "flac" ? "audio/flac" : ext == "m4a" || ext == "aac" ? "audio/mp4" :
                    ext == "ogg" ? "audio/ogg" : ext == "wav" ? "audio/wav" : ext == "mp3" ? "audio/mpeg" : "application/octet-stream";
                var headers = "Content-Type: " + mime + "\r\nContent-Length: " + count + "\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\n" + cors;
                if (partial) headers += "Content-Range: bytes " + start + "-" + end + "/" + length + "\r\n";
                var ms = new MemoryStream(buffer, 0, count, false, true);
                e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(ms, partial ? 206 : 200, partial ? "Partial Content" : "OK", headers);
            }
            catch (Exception ex)
            {
                try
                {
                    e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(ex.Message)), 500, "Internal Server Error",
                        "Content-Type: text/plain; charset=utf-8\r\nContent-Length: " + Encoding.UTF8.GetByteCount(ex.Message) + "\r\n" + "Access-Control-Allow-Origin: *\r\n");
                }
                catch { }
            }
        }

        private void PostEvent(string type, object data)
        {
            try
            {
                var json = JsonSerializer.Serialize(new { type, data });
                if (InvokeRequired) BeginInvoke(new Action(() => { try { _web.CoreWebView2.PostWebMessageAsJson(json); } catch { } }));
                else _web.CoreWebView2.PostWebMessageAsJson(json);
            }
            catch { }
        }

        private void Reply(string id, object data, string error = null)
        {
            var json = JsonSerializer.Serialize(new { id, ok = error == null, data, error });
            try
            {
                if (InvokeRequired) BeginInvoke(new Action(() => { try { _web.CoreWebView2.PostWebMessageAsJson(json); } catch { } }));
                else _web.CoreWebView2.PostWebMessageAsJson(json);
            }
            catch { }
        }

        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string id = null;
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                var root = doc.RootElement;
                id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
                var cmd = root.TryGetProperty("cmd", out var cEl) ? cEl.GetString() : null;
                var args = root.TryGetProperty("args", out var aEl) ? aEl : default;
                if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(cmd)) return;

                switch (cmd)
                {
                    case "ready":
                        Reply(id, new { backend = _backendReady, libraryRoot = _library.Config.LibraryRoot });
                        return;
                    case "setTheme":
                        SetTheme(args);
                        Reply(id, new { ok = true });
                        return;
                    case "setUiScale":
                        SetUiScale(args);
                        Reply(id, new { ok = true });
                        return;
                    case "chooseFolder":
                        Reply(id, ChooseFolder(args));
                        return;
                    case "getExtensions":
                        Reply(id, _extensions.List());
                        return;
                    case "installExtension":
                        Reply(id, _extensions.Install(GetString(args, "path")));
                        return;
                    case "installSampleExtension":
                        Reply(id, _extensions.InstallSample());
                        return;
                    case "extensionAction":
                        Reply(id, _extensions.Action(GetString(args, "action"), GetString(args, "id")));
                        return;
                    case "setExtensionSafeMode":
                        var safe = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("safeMode", out var sm) && sm.ValueKind == JsonValueKind.True;
                        Reply(id, _extensions.SetSafeMode(safe));
                        return;
                    case "getAgents":
                        Reply(id, _extensions.DetectAgents());
                        return;
                    case "launchAgent":
                        Reply(id, _extensions.LaunchAgent(GetString(args, "id")));
                        return;
                    case "copyText":
                        Reply(id, CopyText(GetString(args, "text")));
                        return;
                    case "openExtensionDocs":
                        Reply(id, OpenExtensionDocs());
                        return;
                    case "openExtensionCapabilities":
                        Reply(id, OpenExtensionCapabilities());
                        return;
                    case "getAiControlStatus":
                        Reply(id, _aiControl.Status());
                        return;
                    case "setAiControlEnabled":
                        var aiEnabled = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("enabled", out var ae) && ae.ValueKind == JsonValueKind.True;
                        Reply(id, _aiControl.SetEnabled(aiEnabled));
                        return;
                    case "copyAiMcpConfig":
                        Reply(id, CopyAiMcpConfig());
                        return;
                    case "openAiControlDocs":
                        Reply(id, OpenAiControlDocs());
                        return;
                    case "aiResult":
                        Reply(id, ResolveAiResult(args));
                        return;
                    case "setLibraryRoot":
                        Reply(id, await SetLibraryRootAsync(args));
                        return;
                    case "addSourceDir":
                        Reply(id, AddSourceDir(args));
                        return;
                    case "removeSourceDir":
                        Reply(id, RemoveSourceDir(args));
                        return;
                    case "getLibrary":
                        Reply(id, BuildLibrary());
                        return;
                    case "getAppInfo":
                        Reply(id, BuildAppInfo());
                        return;
                    case "openFolder":
                        OpenFolder(GetString(args, "kind"));
                        Reply(id, new { ok = true });
                        return;
                    case "search":
                        Reply(id, await SearchAsync(GetString(args, "query")));
                        return;
                    case "download":
                        Reply(id, await EnqueueAsync(args));
                        return;
                    case "getDownloads":
                        Reply(id, await GetDownloadsAsync());
                        return;
                    case "downloadAction":
                        Reply(id, await DownloadActionAsync(args));
                        return;
                    case "clearFailed":
                        Reply(id, await ClearFailedAsync());
                        return;
                    case "qrStart":
                        Reply(id, await QrStartAsync(args));
                        return;
                    case "qrPoll":
                        Reply(id, await QrPollAsync(args));
                        return;
                    case "getLikes":
                        Reply(id, await GetLikesAsync());
                        return;
                    case "saveLikes":
                        Reply(id, SaveLikesConfig(args));
                        return;
                    case "syncLikes":
                        Reply(id, await RunLikesSyncAsync(false));
                        return;
                    case "openLikesReport":
                        OpenFolder("reports");
                        Reply(id, new { ok = true });
                        return;
                    case "recordStatus":
                        Reply(id, RecordStatus());
                        return;
                    case "recordStart":
                        Reply(id, RecordStart());
                        return;
                    case "recordStop":
                        Reply(id, await RecordStopAsync());
                        return;
                    case "recordings":
                        Reply(id, RecordingFiles());
                        return;
                    case "maintain":
                        Reply(id, await MaintainAsync());
                        return;
                    case "decrypt":
                        Reply(id, await DecryptAsync());
                        return;
                    case "sodaLike":
                        Reply(id, await SodaLikeAsync());
                        return;
                    case "sodaRetry":
                        Reply(id, await SodaRetryAsync());
                        return;
                    case "sodaUgc":
                        Reply(id, await SodaUgcAsync());
                        return;
                    case "exportM3u":
                        Reply(id, await ExportM3uAsync(args));
                        return;
                    case "getLyrics":
                        Reply(id, await GetLyricsAsync(args));
                        return;
                    default:
                        Reply(id, null, "未知命令：" + cmd);
                        return;
                }
            }
            catch (Exception ex)
            {
                if (id != null) Reply(id, null, ex.Message);
            }
        }

        private static string GetString(JsonElement args, string name)
        {
            if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String)
                return v.GetString();
            return null;
        }

        private object BuildLibrary()
        {
            try
            {
                _library.ReloadConfig();
                var index = Path.Combine(_library.Config.LibraryRoot, _library.Config.IndexFile);
                if (!File.Exists(index)) return new { tracks = Array.Empty<object>(), count = 0, totalBytes = 0L, formats = new Dictionary<string, int>() };
                var opt = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                var dict = JsonSerializer.Deserialize<Dictionary<string, LibraryIndexEntry>>(File.ReadAllText(index), opt)
                           ?? new Dictionary<string, LibraryIndexEntry>();
                var formats = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                var list = new List<(object Item, string Artist, string Title)>();
                long total = 0;
                foreach (var entry in dict.Values)
                {
                    if (entry?.RelPath == null) continue;
                    var ext = Path.GetExtension(entry.RelPath).TrimStart('.').ToLowerInvariant();
                    if (ext != "flac" && ext != "mp3" && ext != "m4a" && ext != "wav" && ext != "ogg" && ext != "aac") continue;
                    formats[ext] = formats.TryGetValue(ext, out var c) ? c + 1 : 1;
                    total += entry.Size;
                    var artist = string.IsNullOrWhiteSpace(entry.Artist) ? "未知歌手" : entry.Artist;
                    var title = string.IsNullOrWhiteSpace(entry.Title) ? Path.GetFileNameWithoutExtension(entry.RelPath) : entry.Title;
                    DateTime? addedAt = null;
                    try
                    {
                        var full = Path.Combine(_library.Config.LibraryRoot, entry.RelPath);
                        if (File.Exists(full))
                        {
                            var created = File.GetCreationTimeUtc(full);
                            addedAt = created > DateTime.UnixEpoch ? created : File.GetLastWriteTimeUtc(full);
                        }
                    }
                    catch { }
                    list.Add((new
                    {
                        title,
                        artist,
                        album = string.IsNullOrWhiteSpace(entry.Album) ? "" : entry.Album,
                        size = entry.Size,
                        ext,
                        addedAt = addedAt?.ToString("o"),
                        url = "https://audio.local/audio/" + EncodeRel(entry.RelPath),
                    }, artist, title));
                }
                var ordered = list.OrderBy(x => x.Artist, StringComparer.CurrentCulture).ThenBy(x => x.Title, StringComparer.CurrentCulture).Select(x => x.Item).ToList();
                return new { tracks = ordered, count = ordered.Count, totalBytes = total, formats };
            }
            catch (Exception ex)
            {
                return new { tracks = Array.Empty<object>(), count = 0, totalBytes = 0L, formats = new Dictionary<string, int>(), error = ex.Message };
            }
        }

        private object BuildAppInfo()
        {
            return new
            {
                libraryRoot = _library.Config.LibraryRoot,
                musicDir = _library.MusicDir,
                recordingDir = _library.RecordingDir,
                reportDir = _library.ReportDir,
                sourceDirs = _library.Config.SourceDirs,
                backend = _backendReady,
                version = "3.0",
                qqNote = "QQ 音乐缓存 467 个 / 21.73 GB 缺完整 EKey，暂不可解密",
            };
        }

        private object ChooseFolder(JsonElement args)
        {
            try
            {
                var initial = GetString(args, "initial") ?? _library.Config.LibraryRoot;
                using var dialog = new FolderBrowserDialog
                {
                    Description = "选择音乐档案目录",
                    UseDescriptionForTitle = true,
                    SelectedPath = Directory.Exists(initial) ? initial : Environment.GetFolderPath(Environment.SpecialFolder.MyMusic),
                    ShowNewFolderButton = true,
                };
                return dialog.ShowDialog(this) == DialogResult.OK
                    ? new { ok = true, path = dialog.SelectedPath }
                    : new { ok = false, canceled = true };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private async Task<object> SetLibraryRootAsync(JsonElement args)
        {
            try
            {
                var path = GetString(args, "path")?.Trim();
                if (string.IsNullOrWhiteSpace(path)) return new { ok = false, error = "目录为空" };
                var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
                Directory.CreateDirectory(full);
                _library.Config.LibraryRoot = full;
                _library.SaveConfig();
                _library.ReloadConfig();
                try { await _backend.ConfigureLibraryViaPowerShellAsync(_library.MusicDir); } catch { }
                return new { ok = true, libraryRoot = _library.Config.LibraryRoot };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private object AddSourceDir(JsonElement args)
        {
            try
            {
                var path = GetString(args, "path")?.Trim();
                if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return new { ok = false, error = "目录不存在" };
                var full = Path.GetFullPath(path);
                if (!_library.Config.SourceDirs.Contains(full, StringComparer.OrdinalIgnoreCase))
                {
                    _library.Config.SourceDirs.Add(full);
                    _library.SaveConfig();
                }
                return new { ok = true, sourceDirs = _library.Config.SourceDirs };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private object RemoveSourceDir(JsonElement args)
        {
            try
            {
                var path = GetString(args, "path")?.Trim();
                if (string.IsNullOrWhiteSpace(path)) return new { ok = false, error = "目录为空" };
                _library.Config.SourceDirs.RemoveAll((p) => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
                _library.SaveConfig();
                return new { ok = true, sourceDirs = _library.Config.SourceDirs };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private static string EncodeRel(string rel)
        {
            var normalized = rel.Replace('\\', '/');
            return string.Join("/", normalized.Split('/').Select(Uri.EscapeDataString));
        }

        private void OpenFolder(string kind)
        {
            string path;
            switch (kind)
            {
                case "reports": path = _library.ReportDir; break;
                case "recordings": path = _library.RecordingDir; break;
                case "extensions": path = _extensions.Root; break;
                case "extensions-dev": path = Path.Combine(AppPaths.DataDir, "extensions-dev"); break;
                default: path = _library.Config.LibraryRoot; break;
            }
            try { Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo("explorer.exe", "\"" + path + "\"") { UseShellExecute = true }); } catch { }
        }

        private object CopyText(string text)
        {
            try { Clipboard.SetText(text ?? ""); return new { ok = true }; }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private object OpenExtensionDocs() => OpenExtensionSdkFile("EXTENSIONS.md");

        private object OpenExtensionCapabilities() => OpenExtensionSdkFile("CAPABILITIES.md");

        private object OpenExtensionSdkFile(string fileName)
        {
            var candidates = new[]
            {
                Path.Combine(AppPaths.AppDir, "extension-sdk", fileName),
                Path.Combine(AppPaths.Root, ".agents", "assets", "music-archive", "client-src", "extension-sdk", fileName),
                Path.Combine(AppPaths.AppDir, fileName),
            };
            var file = candidates.FirstOrDefault(File.Exists);
            if (file == null) return new { ok = false, error = "没有找到 " + fileName };
            try
            {
                Process.Start(new ProcessStartInfo("notepad.exe", "\"" + file + "\"") { UseShellExecute = true });
                return new { ok = true, path = file };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private object OpenAiControlDocs()
        {
            var candidates = new[]
            {
                Path.Combine(AppPaths.AppDir, "ai-control", "AI_CONTROL.md"),
                Path.Combine(AppPaths.Root, ".agents", "assets", "music-archive", "client-src", "ai-control", "AI_CONTROL.md"),
            };
            var file = candidates.FirstOrDefault(File.Exists);
            if (file == null) return new { ok = false, error = "没有找到 AI_CONTROL.md" };
            try
            {
                Process.Start(new ProcessStartInfo("notepad.exe", "\"" + file + "\"") { UseShellExecute = true });
                return new { ok = true, path = file };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private object CopyAiMcpConfig()
        {
            try
            {
                var node = Path.Combine(AppPaths.EnvDir, "_shared", "node", "node.exe");
                if (!File.Exists(node)) node = "node";
                var config = new
                {
                    mcpServers = new Dictionary<string, object>
                    {
                        ["lsa"] = new
                        {
                            command = node,
                            args = new[] { _aiControl.McpServerPath, "--config", _aiControl.ConfigPath },
                        },
                    },
                };
                var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
                Clipboard.SetText(json);
                return new { ok = true, json };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private async Task<object> SendAiCommandAsync(string action, JsonElement args)
        {
            if (_web == null) return new { ok = false, error = "界面尚未就绪" };
            var requestId = "ai-" + Guid.NewGuid().ToString("N");
            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_aiPending) _aiPending[requestId] = tcs;
            try
            {
                var payload = JsonSerializer.Serialize(new
                {
                    type = "ai-command",
                    id = requestId,
                    action,
                    args = args.ValueKind == JsonValueKind.Undefined ? (object)new { } : args,
                });
                void Post()
                {
                    try
                    {
                        if (_web.CoreWebView2 == null) { tcs.TrySetResult(new { ok = false, error = "界面尚未就绪" }); return; }
                        _web.CoreWebView2.PostWebMessageAsJson(payload);
                    }
                    catch (Exception ex) { tcs.TrySetResult(new { ok = false, error = ex.Message }); }
                }
                if (InvokeRequired) BeginInvoke(new Action(Post));
                else Post();
                var done = await Task.WhenAny(tcs.Task, Task.Delay(10000));
                if (done != tcs.Task) return new { ok = false, error = "AI 指令超时" };
                return await tcs.Task;
            }
            finally
            {
                lock (_aiPending) _aiPending.Remove(requestId);
            }
        }

        private object ResolveAiResult(JsonElement args)
        {
            var requestId = GetString(args, "requestId");
            TaskCompletionSource<object> tcs = null;
            if (!string.IsNullOrWhiteSpace(requestId))
            {
                lock (_aiPending) _aiPending.TryGetValue(requestId, out tcs);
            }
            if (tcs == null) return new { ok = false, error = "AI 指令已失效" };
            var error = GetString(args, "error");
            if (!string.IsNullOrWhiteSpace(error))
                tcs.TrySetResult(new { ok = false, error });
            else if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("result", out var result))
                tcs.TrySetResult(result.Clone());
            else
                tcs.TrySetResult(new { ok = true });
            return new { ok = true };
        }

        private async Task<object> SearchAsync(string query)
        {
            if (string.IsNullOrWhiteSpace(query)) return new { songs = Array.Empty<object>(), count = 0 };
            var url = "music/search?q=" + Uri.EscapeDataString(query) + "&type=song&page=1&page_size=30";
            var html = await _api.GetStringAsync(url);
            var songs = new List<object>();
            foreach (Match m in Regex.Matches(html, "<li class=\"song-card\"(?<a>[\\s\\S]*?)>", RegexOptions.Singleline))
            {
                var attrs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (Match a in Regex.Matches(m.Groups["a"].Value, "data-(?<k>[\\w-]+)=(?:\"(?<v>[^\"]*)\"|'(?<v2>[^']*)')"))
                    attrs[a.Groups["k"].Value] = WebUtility.HtmlDecode(a.Groups["v"].Success ? a.Groups["v"].Value : a.Groups["v2"].Value);
                if (!attrs.TryGetValue("id", out var id) || string.IsNullOrEmpty(id)) continue;
                attrs.TryGetValue("source", out var source);
                attrs.TryGetValue("name", out var name);
                attrs.TryGetValue("artist", out var artist);
                attrs.TryGetValue("album", out var album);
                attrs.TryGetValue("cover", out var cover);
                attrs.TryGetValue("duration", out var durText);
                attrs.TryGetValue("extra", out var extraText);
                int.TryParse(durText, out var duration);
                JsonElement extra = default;
                try { extra = JsonSerializer.Deserialize<JsonElement>(string.IsNullOrWhiteSpace(extraText) ? "{}" : extraText); }
                catch { extra = JsonSerializer.Deserialize<JsonElement>("{}"); }
                songs.Add(new { id, source = source ?? "", name = name ?? "未知", artist = artist ?? "未知", album = album ?? "", cover = cover ?? "", duration, extra });
            }
            return new { songs, count = songs.Count };
        }

        private async Task<object> EnqueueAsync(JsonElement args)
        {
            if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("songs", out var arr) || arr.ValueKind != JsonValueKind.Array)
                return new { ok = false, error = "没有选择歌曲" };
            var songs = new List<object>();
            foreach (var s in arr.EnumerateArray())
            {
                var extraText = "{}";
                if (s.TryGetProperty("extra", out var ex))
                    extraText = ex.ValueKind == JsonValueKind.String ? (ex.GetString() ?? "{}") : ex.GetRawText();
                songs.Add(new
                {
                    id = GetString(s, "id") ?? "",
                    source = GetString(s, "source") ?? "",
                    name = GetString(s, "name") ?? "",
                    artist = GetString(s, "artist") ?? "",
                    album = GetString(s, "album") ?? "",
                    cover = GetString(s, "cover") ?? "",
                    extra = extraText,
                    embed = false,
                });
            }
            if (songs.Count == 0) return new { ok = false, error = "没有选择歌曲" };
            var payload = JsonSerializer.Serialize(new { request_id = Guid.NewGuid().ToString(), songs });
            using var req = new HttpRequestMessage(HttpMethod.Post, "music/api/downloads/queue");
            req.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");
            req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var resp = await _api.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode) return new { ok = false, error = body };
            return new { ok = true, queued = songs.Count };
        }

        private readonly Dictionary<string, object> _lyricsCache = new();

        private async Task<object> GetLyricsAsync(JsonElement args)
        {
            var title = GetString(args, "title")?.Trim() ?? "";
            var artist = GetString(args, "artist")?.Trim() ?? "";
            var url = GetString(args, "url")?.Trim() ?? "";
            var duration = "";
            if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("duration", out var durationEl))
                duration = durationEl.ValueKind == JsonValueKind.Number ? durationEl.GetDouble().ToString("0.###") : durationEl.ToString();
            if (string.IsNullOrWhiteSpace(title)) return new { ok = false, error = "当前没有歌曲" };

            var lrcPath = ResolveLyricsSidecar(url);
            var transPath = lrcPath == null ? null : Path.ChangeExtension(lrcPath, ".trans.lrc");
            if (lrcPath != null && File.Exists(lrcPath))
            {
                try
                {
                    var localLrc = File.ReadAllText(lrcPath, Encoding.UTF8);
                    var localTrans = transPath != null && File.Exists(transPath) ? File.ReadAllText(transPath, Encoding.UTF8) : "";
                    if (!string.IsNullOrWhiteSpace(localLrc))
                    {
                        var local = new { ok = true, lrc = localLrc, tlyric = localTrans, source = "local", local = true, saved = true, cover = "" };
                        lock (_lyricsCache) _lyricsCache[title + "|" + artist + "|" + duration] = local;
                        return local;
                    }
                }
                catch { }
            }

            var key = title + "|" + artist + "|" + duration;
            lock (_lyricsCache) { if (_lyricsCache.TryGetValue(key, out var cached)) return cached; }
            var node = Path.Combine(AppPaths.EnvDir, "_shared", "node", "node.exe");
            var script = Path.Combine(AppPaths.Root, ".agents", "scripts", "fetch-lyrics.mjs");
            if (!File.Exists(node) || !File.Exists(script)) return new { ok = false, error = "找不到歌词脚本" };
            try
            {
                var psi = new ProcessStartInfo(node)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = AppPaths.Root,
                };
                psi.ArgumentList.Add(script);
                psi.ArgumentList.Add(title);
                psi.ArgumentList.Add(artist);
                psi.ArgumentList.Add(duration);
                using var p = Process.Start(psi);
                var outputTask = p!.StandardOutput.ReadToEndAsync();
                var errorTask = p.StandardError.ReadToEndAsync();
                await p.WaitForExitAsync();
                var output = (await outputTask).Trim();
                var error = (await errorTask).Trim();
                if (p.ExitCode != 0 || string.IsNullOrWhiteSpace(output))
                    return new { ok = false, error = string.IsNullOrWhiteSpace(error) ? "歌词脚本执行失败" : error };
                var line = output.Split('\n').Reverse().FirstOrDefault(x => x.TrimStart().StartsWith("{"))?.Trim();
                if (line == null) return new { ok = false, error = "歌词脚本输出无效" };
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (!root.TryGetProperty("ok", out var okEl) || okEl.ValueKind != JsonValueKind.True)
                {
                    var miss = root.Clone();
                    lock (_lyricsCache) _lyricsCache[key] = miss;
                    return miss;
                }
                var lrc = root.TryGetProperty("lrc", out var lrcEl) ? lrcEl.GetString() ?? "" : "";
                var tlyric = root.TryGetProperty("tlyric", out var transEl) ? transEl.GetString() ?? "" : "";
                var source = root.TryGetProperty("source", out var sourceEl) ? sourceEl.GetString() ?? "" : "online";
                var cover = root.TryGetProperty("cover", out var coverEl) ? coverEl.GetString() ?? "" : "";
                var saved = false;
                if (lrcPath != null && !string.IsNullOrWhiteSpace(lrc))
                {
                    try
                    {
                        File.WriteAllText(lrcPath, lrc, new UTF8Encoding(false));
                        if (transPath != null && !string.IsNullOrWhiteSpace(tlyric)) File.WriteAllText(transPath, tlyric, new UTF8Encoding(false));
                        saved = true;
                    }
                    catch { }
                }
                var value = new { ok = true, lrc, tlyric, source, local = false, saved, cover };
                lock (_lyricsCache) _lyricsCache[key] = value;
                return value;
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private async Task<object> ExportM3uAsync(JsonElement args)
        {
            try
            {
                if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("tracks", out var tracks) || tracks.ValueKind != JsonValueKind.Array)
                    return new { ok = false, error = "没有可导出的歌曲" };
                var root = Path.GetFullPath(_library.Config.LibraryRoot);
                var outDir = Path.Combine(root, "_导出");
                Directory.CreateDirectory(outDir);
                var path = Path.Combine(outDir, "本地歌单-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".m3u8");
                var lines = new List<string> { "#EXTM3U" };
                var added = 0;
                var skipped = 0;
                foreach (var track in tracks.EnumerateArray())
                {
                    var url = track.TryGetProperty("url", out var urlEl) ? urlEl.GetString() ?? "" : "";
                    var full = ResolveAudioPath(url);
                    if (full == null) { skipped++; continue; }
                    var title = track.TryGetProperty("title", out var titleEl) ? titleEl.GetString() ?? "" : Path.GetFileNameWithoutExtension(full);
                    var artist = track.TryGetProperty("artist", out var artistEl) ? artistEl.GetString() ?? "" : "";
                    lines.Add("#EXTINF:-1," + (artist + " - " + title).Replace('\r', ' ').Replace('\n', ' '));
                    lines.Add(full);
                    added++;
                }
                if (added == 0) return new { ok = false, error = "没有找到可导出的有效文件" };
                File.WriteAllText(path, string.Join("\n", lines) + "\n", new UTF8Encoding(true));
                return new { ok = true, path, added, skipped };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private string ResolveAudioPath(string url)
        {
            try
            {
                const string prefix = "https://audio.local/audio/";
                if (string.IsNullOrWhiteSpace(url) || !url.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
                var encoded = url.Substring(prefix.Length);
                var rel = string.Join("/", encoded.Split('/').Select(Uri.UnescapeDataString)).Replace('/', '\\');
                var root = Path.GetFullPath(_library.Config.LibraryRoot);
                var full = Path.GetFullPath(Path.Combine(root, rel));
                if (!full.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) return null;
                return full;
            }
            catch { return null; }
        }

        private string ResolveLyricsSidecar(string url)
        {
            var full = ResolveAudioPath(url);
            return full == null ? null : Path.ChangeExtension(full, ".lrc");
        }

        private async Task<object> ClearFailedAsync()
        {
            try
            {
                var ids = new List<int>();
                for (var page = 1; page <= 20; page++)
                {
                    var json = await _api.GetStringAsync("music/api/downloads/queue?page=" + page + "&page_size=200");
                    using var doc = JsonDocument.Parse(json);
                    if (!doc.RootElement.TryGetProperty("tasks", out var tasks) || tasks.ValueKind != JsonValueKind.Array) break;
                    foreach (var task in tasks.EnumerateArray())
                    {
                        if (!task.TryGetProperty("Status", out var st) || st.GetString() != "failed") continue;
                        if (!task.TryGetProperty("ID", out var idEl)) continue;
                        if (idEl.TryGetInt32(out var taskId)) ids.Add(taskId);
                    }
                    if (tasks.GetArrayLength() < 50) break;
                }
                var removed = 0;
                foreach (var taskId in ids.Distinct())
                {
                    using var del = await _api.DeleteAsync("music/api/downloads/queue/" + taskId);
                    if (del.IsSuccessStatusCode) removed++;
                }
                return new { ok = true, removed };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private async Task<object> GetDownloadsAsync()
        {
            try
            {
                var queueJson = await _api.GetStringAsync("music/api/downloads/queue?page=1&page_size=200");
                var recordsJson = await _api.GetStringAsync("music/api/downloads/records?page=1&page_size=100");
                using var qd = JsonDocument.Parse(queueJson);
                using var rd = JsonDocument.Parse(recordsJson);
                return new { queue = qd.RootElement.Clone(), records = rd.RootElement.Clone() };
            }
            catch (Exception ex)
            {
                return new { error = ex.Message };
            }
        }

        private async Task<object> DownloadActionAsync(JsonElement args)
        {
            var action = GetString(args, "action") ?? "";
            int taskId = 0;
            if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("id", out var idEl))
            {
                if (idEl.ValueKind == JsonValueKind.Number) idEl.TryGetInt32(out taskId);
                else int.TryParse(idEl.ToString(), out taskId);
            }
            try
            {
                if (action == "clear")
                {
                    using var del = await _api.DeleteAsync("music/api/downloads/queue");
                    var body = await del.Content.ReadAsStringAsync();
                    return new { ok = del.IsSuccessStatusCode, status = (int)del.StatusCode, body };
                }
                if (action != "retry" && action != "cancel")
                    return new { ok = false, error = "不支持的任务操作" };
                if (taskId <= 0) return new { ok = false, error = "任务 ID 无效" };
                using var req = new HttpRequestMessage(HttpMethod.Post, "music/api/downloads/queue/" + taskId + "/" + action);
                req.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");
                using var resp = await _api.SendAsync(req);
                var text = await resp.Content.ReadAsStringAsync();
                return new { ok = resp.IsSuccessStatusCode, status = (int)resp.StatusCode, body = text };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private async Task<object> GetLikesAsync()
        {
            var cfg = LoadLikesConfig();
            var cookies = await GetCookieStatusAsync();
            var lastRunElement = ReadJsonElement(_likesLastRunPath, "null");
            string lastRunAt = cfg.LastRunAt;
            if (string.IsNullOrWhiteSpace(lastRunAt) && lastRunElement.ValueKind == JsonValueKind.Object &&
                lastRunElement.TryGetProperty("at", out var lastAt) && lastAt.ValueKind == JsonValueKind.String)
                lastRunAt = lastAt.GetString();
            var sources = new List<object>();
            foreach (var source in new[] { "soda", "netease", "qq" })
            {
                var state = ReadJsonElement(Path.Combine(_likesDir, "state-" + source + ".json"), "null");
                int likedTotal = 0;
                string lastSync = null, playlist = null;
                bool backfilled = false;
                if (state.ValueKind == JsonValueKind.Object)
                {
                    if (state.TryGetProperty("likedTotal", out var lt) && lt.TryGetInt32(out var n)) likedTotal = n;
                    if (state.TryGetProperty("lastSync", out var ls)) lastSync = ls.GetString();
                    if (state.TryGetProperty("backfilled", out var bf)) backfilled = bf.ValueKind == JsonValueKind.True;
                    if (state.TryGetProperty("likedPlaylist", out var lp) && lp.ValueKind == JsonValueKind.Object && lp.TryGetProperty("title", out var title)) playlist = title.GetString();
                }
                sources.Add(new
                {
                    id = source,
                    name = source == "soda" ? "汽水音乐" : source == "netease" ? "网易云音乐" : "QQ 音乐",
                    connected = cookies.TryGetValue(source, out var connected) && connected,
                    likedTotal,
                    lastSync,
                    playlist,
                    backfilled,
                });
            }
            return new
            {
                config = new
                {
                    enabled = cfg.Enabled,
                    intervalHours = cfg.IntervalHours,
                    backfill = cfg.Backfill,
                    autoImport = cfg.AutoImport,
                    generateReport = cfg.GenerateReport,
                    autoRemoveUnliked = cfg.AutoRemoveUnliked,
                    autoDeleteDuplicates = cfg.AutoDeleteDuplicates,
                    autoMaintain = cfg.AutoMaintain,
                    maintainIntervalHours = cfg.MaintainIntervalHours,
                    lastMaintainAt = cfg.LastMaintainAt,
                    nextMaintainAt = cfg.NextMaintainAt,
                    lastRunAt = lastRunAt,
                    nextRunAt = cfg.NextRunAt,
                    pendingImport = cfg.PendingImport,
                },
                cookies,
                sources,
                events = ReadJsonElement(_likesEventsPath, "[]"),
                lastRun = lastRunElement,
                report = Path.Combine(_library.ReportDir, "最新喜欢同步.md"),
            };
        }

        private JsonElement ReadJsonElement(string path, string fallback)
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                return doc.RootElement.Clone();
            }
            catch
            {
                using var doc = JsonDocument.Parse(fallback);
                return doc.RootElement.Clone();
            }
        }

        private async Task<Dictionary<string, bool>> GetCookieStatusAsync()
        {
            var result = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase)
            {
                ["soda"] = false, ["netease"] = false, ["qq"] = false,
            };
            if (!await EnsureAdminAsync()) return result;
            try
            {
                var json = await _adminApi.GetStringAsync("music/cookies");
                using var doc = JsonDocument.Parse(json);
                foreach (var key in new[] { "soda", "netease", "qq" })
                {
                    if (doc.RootElement.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
                        result[key] = (v.GetString() ?? "").Trim().Length > 0;
                }
            }
            catch { }
            return result;
        }

        private async Task<bool> EnsureAdminAsync()
        {
            if (_adminReady) return true;
            var cred = AppPaths.ReadAdminCredentials();
            if (cred == null) return false;
            try
            {
                using var form = new FormUrlEncodedContent(new[]
                {
                    new KeyValuePair<string, string>("next", "/music"),
                    new KeyValuePair<string, string>("username", cred[0]),
                    new KeyValuePair<string, string>("password", cred[1]),
                });
                using var resp = await _adminApi.PostAsync("music/login", form);
                _adminReady = resp.IsSuccessStatusCode || (int)resp.StatusCode < 400;
                return _adminReady;
            }
            catch { return false; }
        }

        private LikesConfig LoadLikesConfig()
        {
            LikesConfig cfg = null;
            try
            {
                if (File.Exists(_likesConfigPath))
                    cfg = JsonSerializer.Deserialize<LikesConfig>(File.ReadAllText(_likesConfigPath), LikesJson);
            }
            catch { }
            cfg ??= new LikesConfig();
            if (cfg.IntervalHours <= 0) cfg.IntervalHours = 24;
            if (cfg.MaintainIntervalHours <= 0) cfg.MaintainIntervalHours = 24;
            if (cfg.Sources == null || cfg.Sources.Length == 0) cfg.Sources = new[] { "soda", "netease", "qq" };
            cfg.Enabled = cfg.Enabled;
            var changed = false;
            if (cfg.Enabled && string.IsNullOrWhiteSpace(cfg.NextRunAt))
            {
                cfg.NextRunAt = DateTimeOffset.Now.AddHours(cfg.IntervalHours).ToString("o");
                changed = true;
            }
            if (cfg.AutoMaintain && string.IsNullOrWhiteSpace(cfg.NextMaintainAt))
            {
                cfg.NextMaintainAt = DateTimeOffset.Now.AddHours(cfg.MaintainIntervalHours).ToString("o");
                changed = true;
            }
            if (changed)
            {
                cfg.UpdatedAt = DateTimeOffset.Now.ToString("o");
                WriteLikesConfig(cfg);
            }
            return cfg;
        }

        private void WriteLikesConfig(LikesConfig cfg)
        {
            try
            {
                Directory.CreateDirectory(AppPaths.DataDir);
                cfg.UpdatedAt = DateTimeOffset.Now.ToString("o");
                File.WriteAllText(_likesConfigPath, JsonSerializer.Serialize(cfg, LikesJson));
            }
            catch { }
        }

        private object SaveLikesConfig(JsonElement args)
        {
            try
            {
                var cfg = LoadLikesConfig();
                if (args.ValueKind == JsonValueKind.Object)
                {
                    if (args.TryGetProperty("enabled", out var en) && (en.ValueKind == JsonValueKind.True || en.ValueKind == JsonValueKind.False))
                    {
                        var wasEnabled = cfg.Enabled;
                        cfg.Enabled = en.ValueKind == JsonValueKind.True;
                        if (cfg.Enabled && !wasEnabled)
                            cfg.NextRunAt = DateTimeOffset.Now.AddHours(cfg.IntervalHours).ToString("o");
                    }
                    if (args.TryGetProperty("intervalHours", out var ih) && ih.TryGetInt32(out var hours))
                    {
                        cfg.IntervalHours = Math.Max(1, Math.Min(24 * 30, hours));
                        cfg.NextRunAt = DateTimeOffset.Now.AddHours(cfg.IntervalHours).ToString("o");
                    }
                    if (args.TryGetProperty("backfill", out var bf)) cfg.Backfill = bf.ValueKind == JsonValueKind.True;
                    if (args.TryGetProperty("autoImport", out var ai)) cfg.AutoImport = ai.ValueKind == JsonValueKind.True;
                    if (args.TryGetProperty("generateReport", out var gr)) cfg.GenerateReport = gr.ValueKind == JsonValueKind.True;
                    if (args.TryGetProperty("autoRemoveUnliked", out var ar)) cfg.AutoRemoveUnliked = ar.ValueKind == JsonValueKind.True;
                    if (args.TryGetProperty("autoDeleteDuplicates", out var ad)) cfg.AutoDeleteDuplicates = ad.ValueKind == JsonValueKind.True;
                    if (args.TryGetProperty("autoMaintain", out var am))
                    {
                        cfg.AutoMaintain = am.ValueKind == JsonValueKind.True;
                        cfg.NextMaintainAt = cfg.AutoMaintain ? DateTimeOffset.Now.AddHours(cfg.MaintainIntervalHours).ToString("o") : null;
                    }
                    if (args.TryGetProperty("maintainIntervalHours", out var mh) && mh.TryGetInt32(out var mhours))
                    {
                        cfg.MaintainIntervalHours = Math.Max(1, Math.Min(24 * 30, mhours));
                        cfg.NextMaintainAt = DateTimeOffset.Now.AddHours(cfg.MaintainIntervalHours).ToString("o");
                    }
                }
                if (!cfg.Enabled) cfg.PendingImport = false;
                WriteLikesConfig(cfg);
                return new { ok = true, config = new { enabled = cfg.Enabled, intervalHours = cfg.IntervalHours, backfill = cfg.Backfill, autoImport = cfg.AutoImport, generateReport = cfg.GenerateReport, autoRemoveUnliked = cfg.AutoRemoveUnliked, autoDeleteDuplicates = cfg.AutoDeleteDuplicates, autoMaintain = cfg.AutoMaintain, maintainIntervalHours = cfg.MaintainIntervalHours, lastMaintainAt = cfg.LastMaintainAt, nextMaintainAt = cfg.NextMaintainAt, lastRunAt = cfg.LastRunAt, nextRunAt = cfg.NextRunAt, pendingImport = cfg.PendingImport } };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private static string NormMeta(string artist, string title)
        {
            return ((artist ?? "").Trim().ToLowerInvariant()) + "|" + ((title ?? "").Trim().ToLowerInvariant());
        }

        private async Task<object> AutoRemoveUnlikedAsync(JsonElement last, LikesConfig cfg)
        {
            if (!cfg.AutoRemoveUnliked || last.ValueKind != JsonValueKind.Object ||
                !last.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                return null;
            var targets = new List<(string Title, string Artist)>();
            var seenTargets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var r in results.EnumerateArray())
            {
                if (!r.TryGetProperty("removedSongs", out var rs) || rs.ValueKind != JsonValueKind.Array) continue;
                foreach (var s in rs.EnumerateArray())
                {
                    var title = s.TryGetProperty("title", out var t) ? t.GetString() : null;
                    var artist = s.TryGetProperty("artist", out var a) ? a.GetString() : null;
                    if (string.IsNullOrWhiteSpace(title)) continue;
                    var key = NormMeta(artist, title);
                    if (seenTargets.Add(key)) targets.Add((title, artist ?? ""));
                }
            }
            if (targets.Count == 0) return null;

            // 仍被其它已连接平台喜欢的歌不删（避免网易云取消但汽水还喜欢）。
            var stillLiked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var statePath in Directory.GetFiles(_likesDir, "state-*.json"))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(statePath));
                    if (!doc.RootElement.TryGetProperty("seen", out var seen) || seen.ValueKind != JsonValueKind.Array) continue;
                    foreach (var s in seen.EnumerateArray())
                    {
                        var title = s.TryGetProperty("title", out var t) ? t.GetString() : null;
                        var artist = s.TryGetProperty("artist", out var a) ? a.GetString() : null;
                        if (!string.IsNullOrWhiteSpace(title)) stillLiked.Add(NormMeta(artist, title));
                    }
                }
            }
            catch { }
            var skippedCount = 0;
            var removable = new List<(string Title, string Artist)>();
            foreach (var target in targets)
            {
                if (stillLiked.Contains(NormMeta(target.Artist, target.Title))) skippedCount++;
                else removable.Add(target);
            }
            targets = removable;
            if (targets.Count == 0) return new { removed = 0, skipped = skippedCount, errors = 0 };

            _library.ReloadConfig();
            var result = await Task.Run(() => _library.RemoveLibraryTracks(targets, true));
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var report = Path.Combine(_library.ReportDir, "取消喜欢删除-" + stamp + ".md");
            try
            {
                Directory.CreateDirectory(_library.ReportDir);
                var sb = new StringBuilder();
                sb.AppendLine("# 取消喜欢 · 本地清理报告");
                sb.AppendLine();
                sb.AppendLine("- 时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                sb.AppendLine("- 策略：取消喜欢后从音乐库移入回收站；仍被其它平台喜欢的跳过。");
                sb.AppendLine("- 匹配：歌名 + 歌手完全一致（忽略大小写/首尾空格）。");
                sb.AppendLine();
                sb.AppendLine("| 项目 | 数量 |");
                sb.AppendLine("|---|---|");
                sb.AppendLine("| 取消喜欢命中 | " + targets.Count + " |");
                sb.AppendLine("| 已移入回收站 | " + result.Removed + " |");
                sb.AppendLine("| 失败 | " + result.Errors.Count + " |");
                sb.AppendLine();
                if (result.Paths.Count > 0)
                {
                    sb.AppendLine("## 已移除文件");
                    sb.AppendLine();
                    foreach (var p in result.Paths) sb.AppendLine("- `" + p + "`");
                    sb.AppendLine();
                }
                if (result.Errors.Count > 0)
                {
                    sb.AppendLine("## 错误");
                    sb.AppendLine();
                    foreach (var e in result.Errors) sb.AppendLine("- " + e);
                }
                File.WriteAllText(report, sb.ToString(), new UTF8Encoding(true));
            }
            catch { }
            PostEvent("likes", new { phase = "removed", at = DateTimeOffset.Now.ToString("o"), removed = result.Removed, skipped = skippedCount, errors = result.Errors.Count, report });
            return new { removed = result.Removed, skipped = skippedCount, errors = result.Errors.Count, report };
        }

        private async Task<object> RunLikesSyncAsync(bool scheduled)
        {
            if (_likesRunning) return new { ok = false, error = "喜欢同步已在运行" };
            if (_busy) return new { ok = false, error = "已有任务在运行" };
            var node = Path.Combine(AppPaths.EnvDir, "_shared", "node", "node.exe");
            var script = Path.Combine(AppPaths.Root, ".agents", "scripts", "sync-liked-music.mjs");
            if (!File.Exists(node) || !File.Exists(script)) return new { ok = false, error = "找不到 node 或喜欢同步脚本" };
            _likesRunning = true;
            _busy = true;
            PostEvent("likes", new { phase = "start", scheduled });
            try
            {
                var psi = new ProcessStartInfo(node)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = AppPaths.Root,
                };
                psy_add(psi, script); psy_add(psi, "--apply");
                using var p = Process.Start(psi);
                p.OutputDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                await p.WaitForExitAsync();
                var cfg = LoadLikesConfig();
                var last = ReadJsonElement(_likesLastRunPath, "null");
                int queued = 0;
                if (last.ValueKind == JsonValueKind.Object && last.TryGetProperty("queued", out var q)) q.TryGetInt32(out queued);
                cfg.LastRunAt = DateTimeOffset.Now.ToString("o");
                cfg.NextRunAt = DateTimeOffset.Now.AddHours(cfg.IntervalHours).ToString("o");
                cfg.PendingImport = cfg.AutoImport && queued > 0;
                WriteLikesConfig(cfg);
                object removed = null;
                if (cfg.AutoRemoveUnliked) removed = await AutoRemoveUnlikedAsync(last, cfg);
                if (queued > 0 && cfg.AutoImport) StartAutoImportWatcher();
                var ok = p.ExitCode == 0;
                PostEvent("likes", new { phase = "done", ok, scheduled, queued, removed, lastRun = last.Clone(), config = new { cfg.Enabled, cfg.IntervalHours, cfg.Backfill, cfg.AutoImport, cfg.AutoRemoveUnliked, cfg.AutoDeleteDuplicates, cfg.AutoMaintain, cfg.MaintainIntervalHours, cfg.LastMaintainAt, cfg.NextMaintainAt, cfg.LastRunAt, cfg.NextRunAt, cfg.PendingImport } });
                return new { ok, exitCode = p.ExitCode, queued, scheduled, removed, lastRun = last.Clone(), report = Path.Combine(_library.ReportDir, "最新喜欢同步.md") };
            }
            catch (Exception ex)
            {
                PostEvent("likes", new { phase = "error", error = ex.Message, scheduled });
                return new { ok = false, error = ex.Message };
            }
            finally
            {
                _busy = false;
                _likesRunning = false;
            }
        }

        private async Task<int> GetActiveDownloadCountAsync()
        {
            try
            {
                var json = await _api.GetStringAsync("music/api/downloads/queue?page=1&page_size=1");
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("counts", out var counts)) return 0;
                int waiting = 0, downloading = 0;
                if (counts.TryGetProperty("waiting", out var w)) w.TryGetInt32(out waiting);
                if (counts.TryGetProperty("downloading", out var d)) d.TryGetInt32(out downloading);
                return waiting + downloading;
            }
            catch { return 0; }
        }

        private void StartAutoImportWatcher()
        {
            if (_likesImporting) return;
            _likesImporting = true;
            _ = Task.Run(async () =>
            {
                try
                {
                    var deadline = DateTime.UtcNow.AddHours(4);
                    await Task.Delay(15000);
                    while (DateTime.UtcNow < deadline)
                    {
                        if (await GetActiveDownloadCountAsync() == 0) break;
                        await Task.Delay(30000);
                    }
                    for (int i = 0; i < 60 && _busy; i++) await Task.Delay(5000);
                    if (_busy) return;
                    await ImportAfterLikesAsync();
                }
                catch { }
                finally { _likesImporting = false; }
            });
        }

        private async Task ImportAfterLikesAsync()
        {
            var cfg = LoadLikesConfig();
            if (!cfg.AutoImport) return;
            _busy = true;
            PostEvent("likes", new { phase = "importing" });
            try
            {
                _library.ReloadConfig();
                _library.SaveConfig();
                var summary = await Task.Run(() => _library.Maintain(msg => PostEvent("progress", msg), cfg.AutoDeleteDuplicates));
                cfg.PendingImport = false;
                WriteLikesConfig(cfg);
                PostEvent("likes", new { phase = "imported", summary = LibraryService.BuildSummary(summary), config = new { cfg.Enabled, cfg.IntervalHours, cfg.Backfill, cfg.AutoImport, cfg.AutoRemoveUnliked, cfg.AutoDeleteDuplicates, cfg.AutoMaintain, cfg.MaintainIntervalHours, cfg.LastMaintainAt, cfg.NextMaintainAt, cfg.LastRunAt, cfg.NextRunAt, cfg.PendingImport } });
            }
            catch (Exception ex) { PostEvent("likes", new { phase = "importError", error = ex.Message }); }
            finally { _busy = false; }
        }

        private void StartLikesScheduler()
        {
            try
            {
                var cfg = LoadLikesConfig();
                if (cfg.PendingImport) StartAutoImportWatcher();
                _likesTimer?.Dispose();
                _likesTimer = new System.Threading.Timer(async _ => await CheckLikesScheduleAsync(), null, TimeSpan.FromSeconds(20), TimeSpan.FromSeconds(60));
            }
            catch { }
        }

        private async Task CheckLikesScheduleAsync()
        {
            try
            {
                if (_likesRunning || _busy || !_backendReady) return;
                var cfg = LoadLikesConfig();
                if (cfg.Enabled && DateTimeOffset.TryParse(cfg.NextRunAt, out var next) && DateTimeOffset.Now >= next)
                    await RunLikesSyncAsync(true);

                cfg = LoadLikesConfig();
                if (!_busy && cfg.AutoMaintain && DateTimeOffset.TryParse(cfg.NextMaintainAt, out var maintainNext) && DateTimeOffset.Now >= maintainNext)
                {
                    if (await GetActiveDownloadCountAsync() == 0)
                        await RunMaintenanceAsync(true);
                }
            }
            catch { }
        }

        private async Task<object> QrStartAsync(JsonElement args)
        {
            var source = GetString(args, "source");
            if (source != "netease" && source != "qq")
                return new { ok = false, error = "该平台暂不支持客户端内扫码登录" };
            if (!await EnsureAdminAsync()) return new { ok = false, error = "本机下载服务未就绪，无法创建二维码" };
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, "music/qr_login/" + source);
                req.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");
                using var resp = await _adminApi.SendAsync(req);
                var text = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode) return new { ok = false, error = "创建二维码失败（HTTP " + (int)resp.StatusCode + "）" };
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                var key = root.TryGetProperty("key", out var k) ? k.GetString() : null;
                if (string.IsNullOrWhiteSpace(key)) return new { ok = false, error = "二维码会话无效" };
                var image = root.TryGetProperty("image_url", out var iu) ? iu.GetString() : null;
                if (string.IsNullOrWhiteSpace(image) && root.TryGetProperty("url", out var u))
                {
                    var qrText = u.GetString();
                    if (!string.IsNullOrWhiteSpace(qrText)) image = RenderQrDataUrl(qrText);
                }
                if (string.IsNullOrWhiteSpace(image)) return new { ok = false, error = "二维码图片生成失败（本机缺少 QR 运行时）" };
                var message = source == "qq" ? "请打开 QQ 音乐扫码" : "请打开网易云音乐扫码";
                return new { ok = true, source, key, image, status = "waiting", message };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private async Task<object> QrPollAsync(JsonElement args)
        {
            var source = GetString(args, "source");
            var key = GetString(args, "key");
            if ((source != "netease" && source != "qq") || string.IsNullOrWhiteSpace(key))
                return new { ok = false, error = "二维码会话无效" };
            if (!await EnsureAdminAsync()) return new { ok = false, error = "本机下载服务未就绪" };
            try
            {
                using var resp = await _adminApi.GetAsync("music/qr_login/" + source + "?key=" + Uri.EscapeDataString(key));
                var text = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode) return new { ok = false, error = "检查登录状态失败（HTTP " + (int)resp.StatusCode + "）" };
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                var status = root.TryGetProperty("status", out var st) ? st.GetString() : "waiting";
                var message = root.TryGetProperty("message", out var ms) ? ms.GetString() : null;
                if (status == "success")
                {
                    var cookie = ExtractQrCookie(root);
                    if (string.IsNullOrWhiteSpace(cookie)) return new { ok = false, error = "登录成功但没有拿到 Cookie" };
                    var payload = JsonSerializer.Serialize(new Dictionary<string, string> { [source] = cookie });
                    using var save = new HttpRequestMessage(HttpMethod.Post, "music/cookies")
                    {
                        Content = new StringContent(payload, Encoding.UTF8, "application/json"),
                    };
                    save.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");
                    using var saveResp = await _adminApi.SendAsync(save);
                    if (!saveResp.IsSuccessStatusCode) return new { ok = false, error = "登录成功但保存 Cookie 失败" };
                    return new { ok = true, status = "success", message = "登录成功，已保存本机 Cookie" };
                }
                return new { ok = true, status, message = message ?? "" };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        }

        private static string ExtractQrCookie(JsonElement root)
        {
            if (root.TryGetProperty("cookie", out var c) && c.ValueKind == JsonValueKind.String)
                return (c.GetString() ?? "").Trim();
            if (root.TryGetProperty("cookies", out var cs) && cs.ValueKind == JsonValueKind.Object)
            {
                var parts = new List<string>();
                foreach (var p in cs.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.String) continue;
                    var v = p.Value.GetString();
                    if (!string.IsNullOrWhiteSpace(p.Name) && !string.IsNullOrWhiteSpace(v)) parts.Add(p.Name + "=" + v);
                }
                parts.Sort(StringComparer.Ordinal);
                return string.Join("; ", parts);
            }
            return null;
        }

        private string RenderQrDataUrl(string payload)
        {
            try
            {
                var helper = Path.Combine(AppPaths.Root, ".agents", "assets", "music-archive", "account", "render-qr.py");
                if (!File.Exists(helper)) return null;
                foreach (var python in new[]
                {
                    Path.Combine(AppPaths.EnvDir, "40_bot", "venv", "Scripts", "python.exe"),
                    Path.Combine(AppPaths.EnvDir, "30_phone", "_python", "python.exe"),
                    "python", "py",
                })
                {
                    try
                    {
                        var psi = new ProcessStartInfo(python)
                        {
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardOutput = true,
                            RedirectStandardError = true,
                            StandardOutputEncoding = Encoding.ASCII,
                            StandardErrorEncoding = Encoding.UTF8,
                        };
                        psi.ArgumentList.Add(helper);
                        psi.ArgumentList.Add(payload);
                        using var p = Process.Start(psi);
                        var b64 = p.StandardOutput.ReadToEnd().Trim();
                        p.WaitForExit(15000);
                        if (p.ExitCode == 0 && b64.Length > 100) return "data:image/png;base64," + b64;
                    }
                    catch { }
                }
            }
            catch { }
            return null;
        }

        private object RecordStatus()
        {
            if (!_recorder.IsRecording) return new { recording = false, seconds = 0 };
            var span = DateTime.Now - _recorder.StartedAt;
            return new { recording = true, seconds = (int)span.TotalSeconds };
        }

        private object RecordStart()
        {
            _recorder.Start(_library.RecordingDir, _library.TempDir);
            return new { recording = true };
        }

        private async Task<object> RecordStopAsync()
        {
            var file = await _recorder.StopAsync(_library.RecordingDir);
            return new { recording = false, file = file == null ? null : Path.GetFileName(file) };
        }

        private object RecordingFiles()
        {
            try
            {
                var files = Directory.Exists(_library.RecordingDir)
                    ? Directory.GetFiles(_library.RecordingDir, "*.flac").OrderByDescending(File.GetLastWriteTime).Take(8).Select(f => new { name = Path.GetFileName(f), size = new FileInfo(f).Length })
                    : Enumerable.Empty<object>();
                return new { files = files.ToList() };
            }
            catch { return new { files = new List<object>() }; }
        }

        private async Task<object> RunMaintenanceAsync(bool scheduled)
        {
            if (_busy) return new { ok = false, error = "已有任务在运行" };
            _busy = true;
            var cfg = LoadLikesConfig();
            PostEvent("likes", new { phase = "maintainStart", scheduled, autoDeleteDuplicates = cfg.AutoDeleteDuplicates });
            try
            {
                _library.ReloadConfig();
                _library.SaveConfig();
                var summary = await Task.Run(() => _library.Maintain(msg => PostEvent("progress", msg), cfg.AutoDeleteDuplicates));
                cfg = LoadLikesConfig();
                cfg.LastMaintainAt = DateTimeOffset.Now.ToString("o");
                cfg.NextMaintainAt = cfg.AutoMaintain
                    ? DateTimeOffset.Now.AddHours(cfg.MaintainIntervalHours).ToString("o")
                    : null;
                WriteLikesConfig(cfg);
                PostEvent("likes", new
                {
                    phase = "maintained",
                    scheduled,
                    summary = LibraryService.BuildSummary(summary),
                    config = new { cfg.AutoMaintain, cfg.MaintainIntervalHours, cfg.LastMaintainAt, cfg.NextMaintainAt },
                });
                return new { ok = true, scheduled, summary = LibraryService.BuildSummary(summary), report = summary.ReportPath };
            }
            catch (Exception ex)
            {
                PostEvent("likes", new { phase = "maintainError", scheduled, error = ex.Message });
                return new { ok = false, error = ex.Message };
            }
            finally { _busy = false; }
        }

        private async Task<object> MaintainAsync()
        {
            return await RunMaintenanceAsync(false);
        }

        private async Task<object> DecryptAsync()
        {
            if (_busy) return new { ok = false, error = "已有任务在运行" };
            var tool = Path.Combine(AppPaths.MediaDir, "music-key", "MusicKey-CLI.exe");
            var node = Path.Combine(AppPaths.EnvDir, "_shared", "node", "node.exe");
            var script = Path.Combine(AppPaths.Root, ".agents", "scripts", "decrypt-music-archive.mjs");
            if (!File.Exists(tool)) return new { ok = false, error = "未安装 MusicKey（先跑 install-music-key.mjs --apply）" };
            if (!File.Exists(node) || !File.Exists(script)) return new { ok = false, error = "找不到 node 或解密脚本" };
            _busy = true;
            try
            {
                var psi = new ProcessStartInfo(node)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = AppPaths.Root,
                };
                psy_add(psi, script); psy_add(psi, "--apply"); psy_add(psi, "--parallel"); psy_add(psi, "4");
                using var p = Process.Start(psi);
                p.OutputDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                await p.WaitForExitAsync();
                return new { ok = p.ExitCode == 0, exitCode = p.ExitCode, report = Path.Combine(_library.ReportDir, "最新解密报告.md") };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
            finally { _busy = false; }
        }

        private async Task<object> SodaLikeAsync()
        {
            if (_busy) return new { ok = false, error = "已有任务在运行" };
            var node = Path.Combine(AppPaths.EnvDir, "_shared", "node", "node.exe");
            var script = Path.Combine(AppPaths.Root, ".agents", "scripts", "sync-soda-like.mjs");
            if (!File.Exists(node) || !File.Exists(script)) return new { ok = false, error = "找不到 node 或汽水同步脚本" };
            _busy = true;
            try
            {
                var psi = new ProcessStartInfo(node)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = AppPaths.Root,
                };
                psy_add(psi, script);
                psy_add(psi, "--apply");
                using var p = Process.Start(psi);
                p.OutputDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                await p.WaitForExitAsync();
                return new { ok = p.ExitCode == 0, exitCode = p.ExitCode, report = Path.Combine(_library.ReportDir, "最新汽水喜欢同步.md") };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
            finally { _busy = false; }
        }

        private async Task<object> SodaRetryAsync()
        {
            if (_busy) return new { ok = false, error = "已有任务在运行" };
            var node = Path.Combine(AppPaths.EnvDir, "_shared", "node", "node.exe");
            var script = Path.Combine(AppPaths.Root, ".agents", "scripts", "retry-failed-soda.mjs");
            if (!File.Exists(node) || !File.Exists(script)) return new { ok = false, error = "找不到 node 或换源脚本" };
            _busy = true;
            try
            {
                var psi = new ProcessStartInfo(node)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = AppPaths.Root,
                };
                psy_add(psi, script);
                psy_add(psi, "--apply");
                using var p = Process.Start(psi);
                p.OutputDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                await p.WaitForExitAsync();
                if (p.ExitCode == 0) StartAutoImportWatcher();
                return new { ok = p.ExitCode == 0, exitCode = p.ExitCode, report = Path.Combine(_library.ReportDir, "最新汽水补下报告.md") };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
            finally { _busy = false; }
        }

        private async Task<object> SodaUgcAsync()
        {
            if (_busy) return new { ok = false, error = "已有任务在运行" };
            var node = Path.Combine(AppPaths.EnvDir, "_shared", "node", "node.exe");
            var script = Path.Combine(AppPaths.Root, ".agents", "scripts", "soda-ugc.mjs");
            if (!File.Exists(node) || !File.Exists(script)) return new { ok = false, error = "找不到 node 或原声补下脚本" };
            _busy = true;
            try
            {
                var psi = new ProcessStartInfo(node)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = AppPaths.Root,
                };
                var soda = AppPaths.DetectSodaClientDir();
                if (!string.IsNullOrWhiteSpace(soda)) psi.Environment["QISHUI_CLIENT_DIR"] = soda;
                psy_add(psi, script);
                psy_add(psi, "--apply");
                using var p = Process.Start(psi);
                p.OutputDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) PostEvent("progress", e.Data.Trim()); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                await p.WaitForExitAsync();
                return new { ok = p.ExitCode == 0, exitCode = p.ExitCode };
            }
            catch (Exception ex) { return new { ok = false, error = ex.Message }; }
            finally { _busy = false; }
        }

        private static void psy_add(ProcessStartInfo psi, string arg) => psi.ArgumentList.Add(arg);

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            try { _likesTimer?.Dispose(); } catch { }
            try { if (_recorder.IsRecording) _recorder.StopAsync(_library.RecordingDir).GetAwaiter().GetResult(); } catch { }
            try { _backend.StopIfStarted(); } catch { }
        }
    }
}


























