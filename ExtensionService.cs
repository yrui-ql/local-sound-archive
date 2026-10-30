using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace MusicArchive
{
    internal sealed class ExtensionManifest
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Version { get; set; }
        public string Description { get; set; }
        public string Runtime { get; set; } = "node";
        public string Entry { get; set; } = "index.mjs";
        public string Kind { get; set; } = "source";
        public List<string> Capabilities { get; set; } = new List<string>();
        public List<string> Permissions { get; set; } = new List<string>();
    }

    internal sealed class ExtensionEntry
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Description { get; set; }
        public string Version { get; set; }
        public string ActiveVersion { get; set; }
        public string LastGood { get; set; }
        public bool Enabled { get; set; }
        public bool SafeMode { get; set; }
        public string Runtime { get; set; }
        public string Entry { get; set; }
        public string Kind { get; set; }
        public List<string> Capabilities { get; set; } = new List<string>();
        public List<string> Permissions { get; set; } = new List<string>();
        public DateTime InstalledAt { get; set; } = DateTime.Now;
    }

    internal sealed class ExtensionRegistry
    {
        public bool SafeMode { get; set; }
        public List<ExtensionEntry> Extensions { get; set; } = new List<ExtensionEntry>();
    }

    internal sealed class ExtensionService
    {
        private static readonly JsonSerializerOptions JsonOpt = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            WriteIndented = true,
        };

        public string Root { get; } = Path.Combine(AppPaths.DataDir, "extensions");
        private string RegistryFile => Path.Combine(Root, "registry.json");
        private ExtensionRegistry _registry;

        public ExtensionService()
        {
            Directory.CreateDirectory(Root);
            Load();
        }

        private void Load()
        {
            try
            {
                if (File.Exists(RegistryFile))
                    _registry = JsonSerializer.Deserialize<ExtensionRegistry>(File.ReadAllText(RegistryFile), JsonOpt);
            }
            catch { }
            if (_registry == null) _registry = new ExtensionRegistry();
            if (_registry.Extensions == null) _registry.Extensions = new List<ExtensionEntry>();
        }

        private void Save()
        {
            Directory.CreateDirectory(Root);
            var temp = RegistryFile + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_registry, JsonOpt), new UTF8Encoding(true));
            if (File.Exists(RegistryFile)) File.Delete(RegistryFile);
            File.Move(temp, RegistryFile);
        }

        public object List()
        {
            return new
            {
                ok = true,
                root = Root,
                safeMode = _registry.SafeMode,
                extensions = _registry.Extensions
                    .OrderByDescending(x => x.InstalledAt)
                    .Select(x => new
                    {
                        id = x.Id,
                        name = x.Name,
                        description = x.Description,
                        version = x.Version,
                        activeVersion = x.ActiveVersion,
                        lastGood = x.LastGood,
                        enabled = x.Enabled && !_registry.SafeMode,
                        safeMode = _registry.SafeMode,
                        runtime = x.Runtime,
                        kind = x.Kind,
                        capabilities = x.Capabilities,
                        permissions = x.Permissions ?? new List<string>(),
                        canRollback = !string.IsNullOrWhiteSpace(x.LastGood) &&
                            !string.Equals(x.LastGood, x.ActiveVersion, StringComparison.OrdinalIgnoreCase),
                        installedAt = x.InstalledAt.ToString("yyyy-MM-dd HH:mm"),
                    }).ToList(),
            };
        }

        public object Install(string sourcePath, string installId = null)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(sourcePath) || (!Directory.Exists(sourcePath) && !File.Exists(sourcePath)))
                    return Error("目录或压缩包不存在");
                var temp = Path.Combine(Root, ".staging-" + Guid.NewGuid().ToString("N"));
                var sourceDir = sourcePath;
                var cleanup = new List<string>();
                if (File.Exists(sourcePath) && sourcePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                {
                    sourceDir = Path.Combine(temp, "source");
                    Directory.CreateDirectory(sourceDir);
                    ZipFile.ExtractToDirectory(sourcePath, sourceDir);
                    cleanup.Add(temp);
                }
                else if (Directory.Exists(sourcePath))
                {
                    sourceDir = Path.Combine(temp, "source");
                    Directory.CreateDirectory(sourceDir);
                    CopyDirectory(sourcePath, sourceDir);
                }
                var manifestPath = new[] { "extension.json", "manifest.json" }
                    .Select(n => Path.Combine(sourceDir, n)).FirstOrDefault(File.Exists);
                if (manifestPath == null) return Error("缺少 extension.json");
                var manifest = JsonSerializer.Deserialize<ExtensionManifest>(File.ReadAllText(manifestPath), JsonOpt);
                if (manifest == null || string.IsNullOrWhiteSpace(manifest.Id) || string.IsNullOrWhiteSpace(manifest.Version))
                    return Error("扩展清单缺少 id/version");
                if (!System.Text.RegularExpressions.Regex.IsMatch(manifest.Id, "^[a-z0-9][a-z0-9._-]{0,63}$"))
                    return Error("扩展 id 只能使用小写字母、数字、点、下划线、短横线");
                if (!System.Text.RegularExpressions.Regex.IsMatch(manifest.Version, "^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$"))
                    return Error("扩展版本号无效");
                if (string.IsNullOrWhiteSpace(manifest.Entry) || !File.Exists(Path.Combine(sourceDir, manifest.Entry)))
                    return Error("扩展入口文件不存在：" + manifest.Entry);
                if (!string.IsNullOrWhiteSpace(installId) && !string.Equals(installId, manifest.Id, StringComparison.Ordinal))
                    return Error("安装目标与扩展 id 不一致");
                var id = manifest.Id;
                var versionDir = Path.Combine(Root, id, manifest.Version);
                Directory.CreateDirectory(Path.GetDirectoryName(versionDir));
                if (Directory.Exists(versionDir)) Directory.Delete(versionDir, true);
                Directory.Move(sourceDir, versionDir);
                foreach (var path in cleanup) try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
                var existing = _registry.Extensions.FirstOrDefault(x => x.Id == id);
                var previousActive = existing?.ActiveVersion;
                if (existing == null)
                {
                    existing = new ExtensionEntry { Id = id };
                    _registry.Extensions.Add(existing);
                }
                existing.Name = manifest.Name ?? id;
                existing.Description = manifest.Description ?? "";
                existing.Version = manifest.Version;
                existing.ActiveVersion = manifest.Version;
                existing.LastGood = string.IsNullOrWhiteSpace(previousActive) ? null : previousActive;
                existing.Enabled = true;
                existing.Runtime = manifest.Runtime ?? "node";
                existing.Entry = manifest.Entry ?? "index.mjs";
                existing.Kind = manifest.Kind ?? "source";
                existing.Capabilities = manifest.Capabilities ?? new List<string>();
                existing.Permissions = manifest.Permissions ?? new List<string>();
                existing.InstalledAt = DateTime.Now;
                var probe = Probe(id, versionDir, existing);
                if (!probe.ok) { existing.Enabled = false; }
                Save();
                return new { ok = probe.ok, id, version = manifest.Version, health = probe, error = probe.ok ? null : probe.error };
            }
            catch (Exception ex) { return Error(ex.Message); }
        }

        public object Action(string action, string id)
        {
            var entry = _registry.Extensions.FirstOrDefault(x => string.Equals(x.Id, id, StringComparison.OrdinalIgnoreCase));
            if (entry == null) return Error("扩展不存在");
            if (_registry.SafeMode && action != "disable" && action != "open") return Error("安全模式已开启");
            try
            {
                switch ((action ?? "").ToLowerInvariant())
                {
                    case "enable":
                        if (string.IsNullOrWhiteSpace(entry.ActiveVersion)) return Error("没有可用版本");
                        var probe = Probe(entry.Id, VersionDir(entry, entry.ActiveVersion), entry);
                        if (!probe.ok) return new { ok = false, error = probe.error, health = probe };
                        entry.Enabled = true; Save();
                        return new { ok = true, health = probe };
                    case "disable":
                        entry.Enabled = false; Save();
                        return new { ok = true };
                    case "rollback":
                        if (string.IsNullOrWhiteSpace(entry.LastGood) || !Directory.Exists(VersionDir(entry, entry.LastGood)))
                            return Error("没有可回退的版本");
                        var oldActive = entry.ActiveVersion;
                        var rp = Probe(entry.Id, VersionDir(entry, entry.LastGood), entry);
                        if (!rp.ok) return new { ok = false, error = rp.error, health = rp };
                        entry.ActiveVersion = entry.LastGood;
                        entry.LastGood = oldActive;
                        entry.Enabled = true;
                        Save();
                        return new { ok = true, version = entry.ActiveVersion, health = rp };
                    case "remove":
                        entry.Enabled = false;
                        _registry.Extensions.Remove(entry);
                        Save();
                        try { var dir = Path.Combine(Root, entry.Id); if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
                        return new { ok = true };
                    case "open":
                        var folder = Path.Combine(Root, entry.Id);
                        Directory.CreateDirectory(folder);
                        Process.Start(new ProcessStartInfo("explorer.exe", folder) { UseShellExecute = true });
                        return new { ok = true };
                    case "health":
                        return new { ok = true, health = Probe(entry.Id, VersionDir(entry, entry.ActiveVersion), entry) };
                    default:
                        return Error("未知操作");
                }
            }
            catch (Exception ex) { return Error(ex.Message); }
        }

        public object SetSafeMode(bool enabled)
        {
            _registry.SafeMode = enabled;
            Save();
            return new { ok = true, safeMode = enabled };
        }

        public object InstallSample()
        {
            var temp = Path.Combine(Path.GetTempPath(), "music-extension-sample-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(temp);
                File.WriteAllText(Path.Combine(temp, "extension.json"), JsonSerializer.Serialize(new ExtensionManifest
                {
                    Id = "sample-source",
                    Name = "Sample Source",
                    Version = "0.1.0",
                    Description = "示例连接器：演示扩展协议、搜索与解析接口。",
                    Runtime = "node",
                    Entry = "index.mjs",
                    Kind = "source",
                    Capabilities = new List<string> { "search", "resolve", "health" },
                    Permissions = new List<string> { "network" },
                }, JsonOpt), new UTF8Encoding(false));
                File.WriteAllText(Path.Combine(temp, "index.mjs"), SampleConnector, new UTF8Encoding(false));
                return Install(temp, "sample-source");
            }
            finally { try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { } }
        }

        private string VersionDir(ExtensionEntry entry, string version)
            => string.IsNullOrWhiteSpace(version) ? null : Path.Combine(Root, entry.Id, version);

        private (bool ok, string error, string detail) Probe(string id, string versionDir, ExtensionEntry entry)
        {
            try
            {
                if (versionDir == null || !Directory.Exists(versionDir)) return (false, "版本目录不存在", null);
                var runtime = string.IsNullOrWhiteSpace(entry.Runtime) ? "node" : entry.Runtime;
                var entryFile = Path.Combine(versionDir, string.IsNullOrWhiteSpace(entry.Entry) ? "index.mjs" : entry.Entry);
                if (!File.Exists(entryFile)) return (false, "入口文件不存在", null);
                var psi = new ProcessStartInfo
                {
                    FileName = runtime == "node" ? "node" : runtime,
                    WorkingDirectory = versionDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                if (runtime == "node") psi.ArgumentList.Add(entryFile);
                using var process = Process.Start(psi);
                if (process == null) return (false, "无法启动扩展进程", null);
                process.StandardInput.WriteLine("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"describe\"}");
                process.StandardInput.Flush();
                var read = Task.Run(() => process.StandardOutput.ReadLine());
                if (!read.Wait(2500))
                {
                    try { process.Kill(true); } catch { }
                    return (false, "扩展健康检查超时", null);
                }
                var line = read.Result;
                try { process.Kill(true); } catch { }
                if (string.IsNullOrWhiteSpace(line)) return (false, "扩展没有返回 describe 响应", null);
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("result", out var result))
                    return (false, "扩展 describe 响应无效", line);
                return (true, null, line);
            }
            catch (Exception ex) { return (false, ex.Message, null); }
        }

        private static object Error(string message) => new { ok = false, error = message };

        private static void CopyDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(source, file);
                var dest = Path.Combine(target, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                File.Copy(file, dest, true);
            }
        }

        public object DetectAgents()
        {
            var agents = new[]
            {
                new { id = "codex", name = "Codex", command = "codex" },
                new { id = "claude", name = "Claude Code", command = "claude" },
                new { id = "dsh", name = "DSH", command = "dsh" },
            }.Select(a =>
            {
                var path = a.id == "dsh" ? FindDsh() : Where(a.command);
                var version = path == null ? null : RunCapture(path, "--version");
                return new { a.id, a.name, a.command, found = path != null, path, version, status = path == null ? "not-found" : "available" };
            }).ToList();
            return new { ok = true, agents };
        }

        public object LaunchAgent(string id)
        {
            var detected = DetectAgents();
            var list = detected.GetType().GetProperty("agents")?.GetValue(detected) as System.Collections.IEnumerable;
            string command = null, name = id;
            if (list != null)
            {
                foreach (var item in list)
                {
                    var t = item.GetType();
                    if (string.Equals(t.GetProperty("id")?.GetValue(item) as string, id, StringComparison.OrdinalIgnoreCase))
                    {
                        command = t.GetProperty("path")?.GetValue(item) as string;
                        name = t.GetProperty("name")?.GetValue(item) as string ?? id;
                        break;
                    }
                }
            }
            if (string.IsNullOrWhiteSpace(command)) return Error("没有检测到该工具");
            var workspace = Path.Combine(AppPaths.DataDir, "extensions-dev", id + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"));
            Directory.CreateDirectory(workspace);
            var sdkDir = Path.Combine(AppPaths.AppDir, "extension-sdk");
            if (Directory.Exists(sdkDir))
            {
                var targetSdk = Path.Combine(workspace, "sdk");
                Directory.CreateDirectory(targetSdk);
                CopyDirectory(sdkDir, targetSdk);
            }
            File.WriteAllText(Path.Combine(workspace, "AGENT.md"),
                "# 扩展开发工作区\n\n" +
                "你正在为「留声」开发一个扩展连接器。\n\n" +
                "把本目录里的 `sdk/SKILL.md` 当作开发 Skill，`sdk/EXTENSIONS.md` 当作协议。\n" +
                "示例：`sdk/sample-source/`；测试器：`sdk/test-connector.mjs`。\n\n" +
                "在扩展目录内生成符合 `extension.json` 的连接器，并运行：\n" +
                "`node sdk/test-connector.mjs .`\n\n" +
                "不要修改客户端源码，不要写入 active 扩展目录。\n", new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(workspace, "extension.json"),
                "{\n  \"id\": \"new-source\",\n  \"name\": \"New Source\",\n  \"version\": \"0.1.0\",\n  \"description\": \"Replace this description\",\n  \"runtime\": \"node\",\n  \"entry\": \"index.mjs\",\n  \"kind\": \"source\",\n  \"capabilities\": [\"search\", \"resolve\", \"health\"],\n  \"permissions\": [\"network\"]\n}\n", new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(workspace, "index.mjs"),
                "import readline from 'node:readline';\n" +
                "const rl = readline.createInterface({ input: process.stdin });\n" +
                "const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');\n" +
                "rl.on('line', (line) => {\n" +
                "  let req; try { req = JSON.parse(line); } catch { return; }\n" +
                "  if (req.method === 'describe') return send(req.id, { name: 'New Source', version: '0.1.0', capabilities: ['search', 'resolve', 'health'] });\n" +
                "  if (req.method === 'health') return send(req.id, { ok: true });\n" +
                "  if (req.method === 'search') return send(req.id, { songs: [] });\n" +
                "  if (req.method === 'resolve') return send(req.id, { ok: false, error: 'not implemented' });\n" +
                "  send(req.id, { ok: false, error: 'unknown method' });\n" +
                "});\n", new UTF8Encoding(false));
            try
            {
                var args = "/k cd /d \"" + workspace + "\" && \"" + command + "\"";
                Process.Start(new ProcessStartInfo("cmd.exe", args) { UseShellExecute = true });
                return new { ok = true, workspace, agent = name };
            }
            catch (Exception ex) { return Error(ex.Message); }
        }

        private static string Where(string command)
        {
            try
            {
                var psi = new ProcessStartInfo("where.exe", command)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using var p = Process.Start(psi);
                if (p == null) return null;
                var read = p.StandardOutput.ReadLine();
                if (!p.WaitForExit(1500)) { try { p.Kill(true); } catch { } return null; }
                return string.IsNullOrWhiteSpace(read) ? null : read.Trim();
            }
            catch { return null; }
        }

        private static string FindDsh()
        {
            var env = Environment.GetEnvironmentVariable("DSH_CLI");
            if (!string.IsNullOrWhiteSpace(env) && File.Exists(env)) return env;
            env = Environment.GetEnvironmentVariable("DSH_EXE");
            if (!string.IsNullOrWhiteSpace(env))
            {
                var cliFromEnv = DshCliFromExe(env);
                if (cliFromEnv != null) return cliFromEnv;
            }
            foreach (var processName in new[] { "DeepSeek Harness", "DSH", "dsh" })
            {
                try
                {
                    foreach (var process in Process.GetProcessesByName(processName))
                    {
                        try
                        {
                            var exe = process.MainModule?.FileName;
                            var cli = exe == null ? null : DshCliFromExe(exe);
                            if (cli != null) return cli;
                        }
                        catch { }
                    }
                }
                catch { }
            }
            var fromWhere = Where("dsh.cmd") ?? Where("dsh");
            if (!string.IsNullOrWhiteSpace(fromWhere)) return fromWhere;
            var roots = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DeepSeek Harness"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DeepSeek Harness"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "DeepSeek Harness"),
            };
            foreach (var root in roots)
            {
                var cli = Path.Combine(root, "resources", "runtime", "cli", "bin", "dsh.cmd");
                if (File.Exists(cli)) return cli;
            }
            return null;
        }

        private static string DshCliFromExe(string exe)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(exe)) return null;
                var dir = File.Exists(exe) ? Path.GetDirectoryName(exe) : exe;
                if (string.IsNullOrWhiteSpace(dir)) return null;
                var candidates = new[]
                {
                    Path.Combine(dir, "resources", "runtime", "cli", "bin", "dsh.cmd"),
                    Path.Combine(dir, "runtime", "cli", "bin", "dsh.cmd"),
                    Path.Combine(dir, "resources", "app.asar.unpacked", "dsh", "bin", "dsh.cmd"),
                };
                return candidates.FirstOrDefault(File.Exists);
            }
            catch { return null; }
        }

        private static string RunCapture(string command, string args)
        {
            try
            {
                ProcessStartInfo psi;
                if (command.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) ||
                    command.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
                {
                    psi = new ProcessStartInfo("cmd.exe", "/c \"" + command + "\" " + args)
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    };
                }
                else
                {
                    psi = new ProcessStartInfo(command, args)
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    };
                }
                using var p = Process.Start(psi);
                if (p == null) return null;
                var task = p.StandardOutput.ReadLineAsync();
                if (!task.Wait(1500)) { try { p.Kill(true); } catch { } return null; }
                return task.Result?.Trim();
            }
            catch { return null; }
        }

        private const string SampleConnector = @"#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'describe') send(req.id, { name: 'Sample Source', version: '0.1.0', capabilities: ['search', 'resolve', 'health'] });
  else if (req.method === 'health') send(req.id, { ok: true });
  else if (req.method === 'search') send(req.id, { songs: [] });
  else if (req.method === 'resolve') send(req.id, { ok: false, error: 'sample only' });
  else send(req.id, { ok: false, error: 'unknown method' });
});
";
    }
}



