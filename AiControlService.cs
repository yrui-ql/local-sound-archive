using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MusicArchive
{
    internal sealed class AiControlConfig
    {
        public bool Enabled { get; set; }
        public int Port { get; set; } = 18765;
        public string Token { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.Now;
    }

    internal sealed class AiControlService : IDisposable
    {
        private readonly Func<string, JsonElement, Task<object>> _dispatch;
        private readonly string _configPath = Path.Combine(AppPaths.DataDir, "ai-control.json");
        private readonly string _logPath = Path.Combine(AppPaths.DataDir, "ai-control.log");
        private readonly object _sync = new object();
        private AiControlConfig _config;
        private HttpListener _listener;
        private CancellationTokenSource _cts;
        private Task _loop;
        private string _lastError;

        public AiControlService(Func<string, JsonElement, Task<object>> dispatch)
        {
            _dispatch = dispatch;
            Load();
        }

        public string Endpoint => _config == null ? "" : "http://127.0.0.1:" + _config.Port + "/v1";
        public string McpServerPath => Path.Combine(AppPaths.AppDir, "ai-control", "mcp-server.mjs");
        public string ConfigPath => _configPath;

        private void Load()
        {
            try
            {
                if (File.Exists(_configPath))
                    _config = JsonSerializer.Deserialize<AiControlConfig>(File.ReadAllText(_configPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            }
            catch { }
            if (_config == null) _config = new AiControlConfig();
            if (string.IsNullOrWhiteSpace(_config.Token)) _config.Token = Guid.NewGuid().ToString("N");
            if (_config.Port < 1024 || _config.Port > 65000) _config.Port = 18765;
            Save();
        }

        private void Save()
        {
            try
            {
                Directory.CreateDirectory(AppPaths.DataDir);
                File.WriteAllText(_configPath, JsonSerializer.Serialize(_config, new JsonSerializerOptions
                {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                }), new UTF8Encoding(true));
            }
            catch { }
        }

        public object SetEnabled(bool enabled)
        {
            _config.Enabled = enabled;
            Save();
            if (enabled) Start();
            else Stop();
            return Status();
        }

        public object Status()
        {
            return new
            {
                ok = true,
                enabled = _config.Enabled,
                running = IsRunning,
                port = _config.Port,
                endpoint = Endpoint,
                mcpServerPath = McpServerPath,
                configPath = _configPath,
                error = _lastError,
            };
        }

        public bool IsRunning
        {
            get { lock (_sync) return _listener != null && _listener.IsListening; }
        }

        public void StartIfEnabled()
        {
            if (_config.Enabled) Start();
        }

        public void Start()
        {
            lock (_sync)
            {
                if (IsRunning) return;
                try
                {
                    _cts = new CancellationTokenSource();
                    _listener = new HttpListener();
                    _listener.Prefixes.Add("http://127.0.0.1:" + _config.Port + "/");
                    _listener.Start();
                    _lastError = null;
                    _loop = Task.Run(() => ListenLoop(_cts.Token));
                }
                catch (Exception ex)
                {
                    _lastError = ex.Message;
                    try { _listener?.Close(); } catch { }
                    _listener = null;
                }
            }
        }

        public void Stop()
        {
            lock (_sync)
            {
                try { _cts?.Cancel(); } catch { }
                try { _listener?.Stop(); _listener?.Close(); } catch { }
                _listener = null;
                _cfgDisabled();
            }
        }

        private void _cfgDisabled()
        {
            if (_config != null) _config.Enabled = false;
        }

        private async Task ListenLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested && _listener != null && _listener.IsListening)
            {
                HttpListenerContext context;
                try { context = await _listener.GetContextAsync(); }
                catch { break; }
                _ = Task.Run(() => Handle(context));
            }
        }

        private async Task Handle(HttpListenerContext context)
        {
            var req = context.Request;
            var res = context.Response;
            try
            {
                res.Headers["Cache-Control"] = "no-store";
                res.ContentType = "application/json; charset=utf-8";
                if (!Authorized(req))
                {
                    await Write(res, 401, new { ok = false, error = "unauthorized" });
                    return;
                }
                object result;
                var path = req.Url.AbsolutePath.TrimEnd('/');
                if (path == "/v1/health")
                {
                    result = new { ok = true, service = "lsa-ai-control", version = "1" };
                }
                else if (path == "/v1/status" && req.HttpMethod == "GET")
                {
                    result = await _dispatch("status", EmptyObject());
                }
                else if (path == "/v1/library" && req.HttpMethod == "GET")
                {
                    var query = req.QueryString["query"] ?? "";
                    var limitText = req.QueryString["limit"] ?? "20";
                    int.TryParse(limitText, out var limit);
                    using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { query, limit = Math.Max(1, Math.Min(100, limit)) }));
                    result = await _dispatch("librarySearch", doc.RootElement.Clone());
                }
                else if (path == "/v1/command" && req.HttpMethod == "POST")
                {
                    string body;
                    using (var reader = new StreamReader(req.InputStream, req.ContentEncoding ?? Encoding.UTF8))
                        body = await reader.ReadToEndAsync();
                    using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
                    var root = doc.RootElement;
                    var action = root.TryGetProperty("action", out var actionEl) ? actionEl.GetString() : null;
                    if (string.IsNullOrWhiteSpace(action)) { await Write(res, 400, new { ok = false, error = "action required" }); return; }
                    var args = root.TryGetProperty("args", out var argsEl) ? argsEl.Clone() : EmptyObject();
                    result = await _dispatch(action, args);
                }
                else
                {
                    await Write(res, 404, new { ok = false, error = "not found" });
                    return;
                }
                Log(req.HttpMethod + " " + req.Url.AbsolutePath + " " + (path == "/v1/command" ? "" : path));
                await Write(res, 200, result);
            }
            catch (Exception ex)
            {
                try { await Write(res, 500, new { ok = false, error = ex.Message }); } catch { }
            }
        }

        private bool Authorized(HttpListenerRequest req)
        {
            var token = req.Headers["X-LSA-Token"];
            if (string.IsNullOrEmpty(token))
            {
                var auth = req.Headers["Authorization"] ?? "";
                if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) token = auth.Substring(7).Trim();
            }
            return !string.IsNullOrEmpty(token) && string.Equals(token, _config.Token, StringComparison.Ordinal);
        }

        private static async Task Write(HttpListenerResponse res, int status, object data)
        {
            res.StatusCode = status;
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(data));
            res.ContentLength64 = bytes.Length;
            await res.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            res.Close();
        }

        private static JsonElement EmptyObject()
        {
            using var doc = JsonDocument.Parse("{}");
            return doc.RootElement.Clone();
        }

        private void Log(string line)
        {
            try
            {
                Directory.CreateDirectory(AppPaths.DataDir);
                File.AppendAllText(_logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine, new UTF8Encoding(true));
            }
            catch { }
        }

        public void Dispose()
        {
            Stop();
            _cts?.Dispose();
        }
    }
}

