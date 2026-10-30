using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace MusicArchive
{
    internal sealed class BackendService : IDisposable
    {
        private readonly CookieContainer _cookies = new CookieContainer();
        private readonly HttpClient _http;
        private Process _proc;
        private readonly object _logLock = new object();
        private readonly string _logPath;

        public bool StartedByUs { get; private set; }

        public BackendService()
        {
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                UseCookies = true,
                CookieContainer = _cookies,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            };
            _http = new HttpClient(handler)
            {
                BaseAddress = new Uri("http://127.0.0.1:18088/"),
                Timeout = TimeSpan.FromSeconds(20),
            };
            _logPath = Path.Combine(AppPaths.LogDir, "music-dl-web.log");
        }

        public static bool PortOpen(int port = 18088, int timeoutMs = 400)
        {
            var client = new TcpClient();
            try
            {
                var iar = client.BeginConnect("127.0.0.1", port, null, null);
                if (!iar.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                client.EndConnect(iar);
                return true;
            }
            catch { return false; }
            finally { client.Close(); }
        }

        private void AppendLog(string line)
        {
            try { lock (_logLock) File.AppendAllText(_logPath, line + Environment.NewLine); } catch { }
        }

        public async Task<bool> EnsureStartedAsync(Action<string> status = null)
        {
            if (PortOpen()) return true;
            if (!File.Exists(AppPaths.MusicDlExe))
            {
                status?.Invoke("找不到 go-music-dl 可执行文件");
                return false;
            }
            Directory.CreateDirectory(AppPaths.LogDir);
            var soda = AppPaths.DetectSodaClientDir();
            var work = Path.Combine(AppPaths.DataDir, "go-music-dl");
            Directory.CreateDirectory(work);
            var psi = new ProcessStartInfo(AppPaths.MusicDlExe, "web --port 18088 --no-browser")
            {
                WorkingDirectory = work,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            if (soda != null) psi.Environment["QISHUI_CLIENT_DIR"] = soda;
            try
            {
                _proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                _proc.OutputDataReceived += (s, e) => { if (e.Data != null) AppendLog(e.Data); };
                _proc.ErrorDataReceived += (s, e) => { if (e.Data != null) AppendLog(e.Data); };
                _proc.Start();
                _proc.BeginOutputReadLine();
                _proc.BeginErrorReadLine();
                StartedByUs = true;
            }
            catch (Exception ex)
            {
                status?.Invoke("下载服务启动失败：" + ex.Message);
                return false;
            }
            status?.Invoke("下载服务启动中…");
            for (int i = 0; i < 60; i++)
            {
                if (PortOpen()) return true;
                if (_proc != null && _proc.HasExited) break;
                await Task.Delay(400);
            }
            status?.Invoke("下载服务 25 秒内没有就绪");
            return false;
        }

        public async Task<bool> EnsureLoginAsync()
        {
            var cred = AppPaths.ReadAdminCredentials();
            if (cred == null) return false;
            try
            {
                var body = new FormUrlEncodedContent(new[]
                {
                    new System.Collections.Generic.KeyValuePair<string,string>("next", "/music"),
                    new System.Collections.Generic.KeyValuePair<string,string>("username", cred[0]),
                    new System.Collections.Generic.KeyValuePair<string,string>("password", cred[1]),
                });
                await _http.PostAsync("music/login", body);
                var settings = await GetSettingsAsync();
                return settings != null;
            }
            catch { return false; }
        }

        public async Task<JsonObject> GetSettingsAsync()
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, "music/settings");
                req.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");
                using var resp = await _http.SendAsync(req);
                if (!resp.IsSuccessStatusCode) return null;
                var text = await resp.Content.ReadAsStringAsync();
                return JsonNode.Parse(text) as JsonObject;
            }
            catch { return null; }
        }

        public async Task<bool> UpdateSettingsAsync(Action<JsonObject> mutate)
        {
            var settings = await GetSettingsAsync();
            if (settings == null) return false;
            mutate(settings);
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, "music/settings");
                req.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");
                req.Content = new StringContent(settings.ToJsonString(), Encoding.UTF8, "application/json");
                using var resp = await _http.SendAsync(req);
                return resp.IsSuccessStatusCode;
            }
            catch { return false; }
        }

        public Task<bool> ConfigureLibraryAsync(string musicDir)
        {
            return UpdateSettingsAsync(s =>
            {
                s["downloadToLocal"] = true;
                s["downloadDir"] = musicDir;
                s["downloadFilenameTemplate"] = "{artist} - {name}";
                s["autoCheckUpdate"] = false;
            });
        }

        // WebView2 内的会话与脚本时序不稳定；用本机 PowerShell 的 WebRequestSession 做一次确定性配置。
        // 这同时验证了本机管理员凭据可用。
        public async Task<bool> ConfigureLibraryViaPowerShellAsync(string musicDir)
        {
            var cred = AppPaths.ReadAdminCredentials();
            if (cred == null) return false;
            var script = Path.Combine(AppPaths.LogDir, "configure-client.ps1");
            var log = Path.Combine(AppPaths.LogDir, "configure-client.log");
            var ps = "$ErrorActionPreference='Stop'" + Environment.NewLine +
                     "$cred=Get-Content " + PsQuote(AppPaths.CredFile) + Environment.NewLine +
                     "$u=(($cred|Where-Object{$_ -match '^username='})-replace '^username=','')" + Environment.NewLine +
                     "$p=(($cred|Where-Object{$_ -match '^password='})-replace '^password=','')" + Environment.NewLine +
                     "$s=New-Object Microsoft.PowerShell.Commands.WebRequestSession" + Environment.NewLine +
                     "Invoke-WebRequest -Uri 'http://127.0.0.1:18088/music/login' -Method Post -Body @{next='/music';username=$u;password=$p} -ContentType 'application/x-www-form-urlencoded' -WebSession $s -MaximumRedirection 5 -UseBasicParsing | Out-Null" + Environment.NewLine +
                     "$r=Invoke-WebRequest -Uri 'http://127.0.0.1:18088/music/settings' -WebSession $s -UseBasicParsing -Headers @{'X-Requested-With'='XMLHttpRequest'}" + Environment.NewLine +
                     "$j=$r.Content|ConvertFrom-Json" + Environment.NewLine +
                     "$j.downloadDir=" + PsQuote(musicDir) + Environment.NewLine +
                     "$j.downloadToLocal=$true" + Environment.NewLine +
                     "$j.downloadFilenameTemplate='{artist} - {name}'" + Environment.NewLine +
                     "$j.autoCheckUpdate=$false" + Environment.NewLine +
                     "$body=$j|ConvertTo-Json -Depth 20 -Compress" + Environment.NewLine +
                     "$bytes=[Text.Encoding]::UTF8.GetBytes($body)" + Environment.NewLine +
                     "$resp=Invoke-WebRequest -Uri 'http://127.0.0.1:18088/music/settings' -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -WebSession $s -UseBasicParsing -Headers @{'X-Requested-With'='XMLHttpRequest'}" + Environment.NewLine +
                     "if ($resp.StatusCode -eq 200) { 'OK' } else { 'POST-' + $resp.StatusCode; exit 3 }";
            try
            {
                File.WriteAllText(script, ps, new UTF8Encoding(true));
                var psi = new ProcessStartInfo("powershell.exe")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                psi.ArgumentList.Add("-NoProfile");
                psi.ArgumentList.Add("-ExecutionPolicy");
                psi.ArgumentList.Add("Bypass");
                psi.ArgumentList.Add("-File");
                psi.ArgumentList.Add(script);
                using var p = Process.Start(psi);
                var stdout = await p.StandardOutput.ReadToEndAsync();
                var stderr = await p.StandardError.ReadToEndAsync();
                await p.WaitForExitAsync();
                try { File.WriteAllText(log, "exit=" + p.ExitCode + Environment.NewLine + stdout + Environment.NewLine + stderr, new UTF8Encoding(true)); } catch { }
                return p.ExitCode == 0 && stdout.Contains("OK");
            }
            catch { return false; }
        }

        private static string PsQuote(string s)
        {
            return "'" + (s ?? "").Replace("'", "''") + "'";
        }

        public void StopIfStarted()
        {
            try
            {
                if (StartedByUs && _proc != null && !_proc.HasExited)
                {
                    _proc.Kill(true);
                    _proc.WaitForExit(5000);
                }
            }
            catch { }
            finally { _proc = null; }
        }

        public void Dispose()
        {
            StopIfStarted();
            _http.Dispose();
        }
    }
}
