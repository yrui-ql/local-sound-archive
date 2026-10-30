using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using VBFileSystem = Microsoft.VisualBasic.FileIO.FileSystem;
using VBUIOption = Microsoft.VisualBasic.FileIO.UIOption;
using VBRecycleOption = Microsoft.VisualBasic.FileIO.RecycleOption;

namespace MusicArchive
{
    internal sealed class LibraryConfig
    {
        public string LibraryRoot { get; set; }
        public List<string> SourceDirs { get; set; } = new List<string>();
        public string MusicSubdir { get; set; } = "音乐";
        public string RecordingSubdir { get; set; } = "录音";
        public string ReportSubdir { get; set; } = "_报告";
        public string IndexFile { get; set; } = "_索引.json";
        public string DecryptStaging { get; set; }
        public string DecryptOutput { get; set; }
    }

    internal sealed class LibraryIndexEntry
    {
        public string RelPath { get; set; }
        public string Artist { get; set; }
        public string Album { get; set; }
        public string Title { get; set; }
        public long Size { get; set; }
    }

    internal sealed class LibrarySummary
    {
        public string LibraryRoot { get; set; } = "";
        public string ReportPath { get; set; }
        public int SourceFiles { get; set; }
        public int Imported { get; set; }
        public int ExactDuplicates { get; set; }
        public int LibraryDuplicates { get; set; }
        public long ImportedBytes { get; set; }
        public int EncryptedFiles { get; set; }
        public long EncryptedBytes { get; set; }
        public int NearDuplicateGroups { get; set; }
        public int AutoDeletedDuplicates { get; set; }
        public long AutoDeletedBytes { get; set; }
        public int AutoDeleteErrors { get; set; }
        public int Errors { get; set; }
        public TimeSpan Elapsed { get; set; }
        public int Linked { get; set; }
        public List<string> EncryptedByType { get; } = new List<string>();
    }

    internal sealed class LibraryRemovalResult
    {
        public int Removed { get; set; }
        public long Bytes { get; set; }
        public List<string> Paths { get; } = new List<string>();
        public List<string> Errors { get; } = new List<string>();
    }

    internal sealed class LibraryService
    {
        private static readonly JsonSerializerOptions JsonOpt = new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNameCaseInsensitive = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };
        private static readonly HashSet<string> PlayableExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".wma", ".opus", ".ape", ".m4b" };
        private static readonly HashSet<string> EncryptedExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".ncm", ".mflac", ".mgg", ".mgg1", ".mflac0", ".qmc0", ".qmc2", ".qmc3", ".qmcflac", ".qmcogg", ".kgm", ".kgma", ".kwm", ".tkm" };

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLink(string lpFileName, string lpExistingFileName, IntPtr lpSecurityAttributes);

        private sealed class LibRef
        {
            public string Key;
            public string RelPath;
            public string AbsPath;
            public long Size;
            public string Hash;
        }

        public LibraryConfig Config { get; private set; }
        public string MusicDir { get { return Path.Combine(Config.LibraryRoot, Config.MusicSubdir); } }
        public string RecordingDir { get { return Path.Combine(Config.LibraryRoot, Config.RecordingSubdir); } }
        public string ReportDir { get { return Path.Combine(Config.LibraryRoot, Config.ReportSubdir); } }
        public string TempDir { get { return Path.Combine(Config.LibraryRoot, "_临时"); } }
        public string IndexPath { get { return Path.Combine(Config.LibraryRoot, Config.IndexFile); } }

        public LibraryService()
        {
            AppPaths.EnsureDirs();
            LoadOrCreateConfig();
            Directory.CreateDirectory(Config.LibraryRoot);
            Directory.CreateDirectory(MusicDir);
            Directory.CreateDirectory(RecordingDir);
            Directory.CreateDirectory(ReportDir);
            Directory.CreateDirectory(TempDir);
        }

        private static string DefaultLibraryRoot()
        {
            var configured = Environment.GetEnvironmentVariable("MUSIC_ARCHIVE_LIBRARY");
            if (!string.IsNullOrWhiteSpace(configured))
            {
                try { return Path.GetFullPath(Environment.ExpandEnvironmentVariables(configured)); }
                catch { }
            }
            var music = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);
            if (string.IsNullOrWhiteSpace(music)) music = AppPaths.DataDir;
            return Path.Combine(music, "音乐档案");
        }

        private void LoadOrCreateConfig()
        {
            try
            {
                if (File.Exists(AppPaths.ConfigFile))
                {
                    var cfg = JsonSerializer.Deserialize<LibraryConfig>(File.ReadAllText(AppPaths.ConfigFile), JsonOpt);
                    if (cfg != null && !string.IsNullOrWhiteSpace(cfg.LibraryRoot))
                    {
                        cfg.LibraryRoot = Path.GetFullPath(Environment.ExpandEnvironmentVariables(cfg.LibraryRoot));
                        cfg.SourceDirs = (cfg.SourceDirs ?? new List<string>())
                            .Where(p => !string.IsNullOrWhiteSpace(p))
                            .Select(p => { try { return Path.GetFullPath(Environment.ExpandEnvironmentVariables(p)); } catch { return p; } })
                            .ToList();
                        var envLibrary = Environment.GetEnvironmentVariable("MUSIC_ARCHIVE_LIBRARY");
                        if (!string.IsNullOrWhiteSpace(envLibrary))
                            cfg.LibraryRoot = Path.GetFullPath(Environment.ExpandEnvironmentVariables(envLibrary));
                        Config = cfg;
                        return;
                    }
                }
            }
            catch { }
            Config = new LibraryConfig { LibraryRoot = DefaultLibraryRoot() };
            void Add(string p)
            {
                try
                {
                    if (!string.IsNullOrWhiteSpace(p) && Directory.Exists(p))
                    {
                        var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(p));
                        if (!Config.SourceDirs.Contains(full, StringComparer.OrdinalIgnoreCase)) Config.SourceDirs.Add(full);
                    }
                }
                catch { }
            }
            var envSources = Environment.GetEnvironmentVariable("MUSIC_ARCHIVE_SOURCES");
            if (!string.IsNullOrWhiteSpace(envSources))
                foreach (var part in envSources.Split(new[] { ';', '|' }, StringSplitOptions.RemoveEmptyEntries)) Add(part.Trim());
            Add(Environment.GetFolderPath(Environment.SpecialFolder.MyMusic));
            Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"));
            Add(Path.Combine(AppPaths.DataDir, "_inbox"));
            Add(Path.Combine(AppPaths.DataDir, "recordings"));
            SaveConfig();
        }

        public void SaveConfig()
        {
            try { File.WriteAllText(AppPaths.ConfigFile, JsonSerializer.Serialize(Config, JsonOpt), new UTF8Encoding(true)); } catch { }
        }

        public void ReloadConfig()
        {
            try { LoadOrCreateConfig(); } catch { }
            try
            {
                Directory.CreateDirectory(Config.LibraryRoot);
                Directory.CreateDirectory(MusicDir);
                Directory.CreateDirectory(RecordingDir);
                Directory.CreateDirectory(ReportDir);
                Directory.CreateDirectory(TempDir);
            }
            catch { }
        }

        private Dictionary<string, LibraryIndexEntry> LoadIndex()
        {
            try
            {
                if (File.Exists(IndexPath))
                {
                    var d = JsonSerializer.Deserialize<Dictionary<string, LibraryIndexEntry>>(File.ReadAllText(IndexPath), JsonOpt);
                    if (d != null) return new Dictionary<string, LibraryIndexEntry>(d, StringComparer.OrdinalIgnoreCase);
                }
            }
            catch { }
            return new Dictionary<string, LibraryIndexEntry>(StringComparer.OrdinalIgnoreCase);
        }

        private void SaveIndex(Dictionary<string, LibraryIndexEntry> index)
        {
            try { File.WriteAllText(IndexPath, JsonSerializer.Serialize(index, JsonOpt), new UTF8Encoding(false)); } catch { }
        }

        private static string HashFile(string path)
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.SequentialScan);
            using var sha = SHA256.Create();
            return Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
        }

        private static string SafeName(string s, int max = 96)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            var invalid = Path.GetInvalidFileNameChars();
            var sb = new StringBuilder();
            foreach (var ch in s.Trim())
            {
                if (Array.IndexOf(invalid, ch) >= 0 || char.IsControl(ch)) sb.Append('_');
                else sb.Append(ch);
            }
            var r = sb.ToString().Trim().TrimEnd('.');
            if (r.Length > max) r = r.Substring(0, max).TrimEnd();
            return string.IsNullOrWhiteSpace(r) ? null : r;
        }

        private sealed class TagInfo
        {
            public string Title;
            public string Artist;
            public string Album;
            public uint Track;
        }

        private static TagInfo ReadTags(string path)
        {
            var info = new TagInfo();
            try
            {
                using var f = TagLib.File.Create(path);
                info.Title = string.IsNullOrWhiteSpace(f.Tag.Title) ? null : f.Tag.Title;
                info.Artist = (f.Tag.Performers != null && f.Tag.Performers.Length > 0) ? f.Tag.Performers[0] : null;
                info.Album = string.IsNullOrWhiteSpace(f.Tag.Album) ? null : f.Tag.Album;
                info.Track = f.Tag.Track;
            }
            catch { }
            // 汽水/QQ 等下载的 M4A 常见标签为空，文件名由下载器写成 "歌手 - 歌名"；
            // 标签缺字段时用文件名补齐，避免库里出现 null/未分类。
            var fileName = Path.GetFileNameWithoutExtension(path);
            if (string.IsNullOrWhiteSpace(info.Title) || string.IsNullOrWhiteSpace(info.Artist))
            {
                var idx = fileName.IndexOf(" - ", StringComparison.Ordinal);
                if (idx > 0)
                {
                    if (string.IsNullOrWhiteSpace(info.Artist)) info.Artist = fileName.Substring(0, idx).Trim();
                    if (string.IsNullOrWhiteSpace(info.Title)) info.Title = fileName.Substring(idx + 3).Trim();
                }
                else if (string.IsNullOrWhiteSpace(info.Title))
                {
                    info.Title = fileName;
                }
            }
            return info;
        }

        private static string NormKey(string artist, string title)
        {
            return ((artist ?? "").Trim().ToLowerInvariant()) + "|" + ((title ?? "").Trim().ToLowerInvariant());
        }

        private string BuildDestination(TagInfo tag, string sourcePath)
        {
            var ext = Path.GetExtension(sourcePath);
            var title = SafeName(tag.Title) ?? SafeName(Path.GetFileNameWithoutExtension(sourcePath)) ?? "未命名";
            var artist = SafeName(tag.Artist);
            var album = SafeName(tag.Album);
            string dir = artist == null ? Path.Combine(MusicDir, "未分类")
                : (album == null ? Path.Combine(MusicDir, artist) : Path.Combine(MusicDir, artist, album));
            Directory.CreateDirectory(dir);
            var prefix = tag.Track > 0 ? tag.Track.ToString("00") + " " : "";
            var dest = Path.Combine(dir, prefix + title + ext);
            int n = 2;
            while (File.Exists(dest))
            {
                dest = Path.Combine(dir, prefix + title + " (" + n + ")" + ext);
                n++;
            }
            return dest;
        }

        private static bool IsInside(string path, string root)
        {
            var p = path.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var r = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return p.StartsWith(r, StringComparison.OrdinalIgnoreCase);
        }

        private static bool TryLink(string src, string dest)
        {
            try
            {
                if (Path.GetPathRoot(src).Equals(Path.GetPathRoot(dest), StringComparison.OrdinalIgnoreCase))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    if (CreateHardLink(dest, src, IntPtr.Zero)) return true;
                }
            }
            catch { }
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            File.Copy(src, dest, false);
            return false;
        }

        public LibrarySummary Maintain(Action<string> progress = null, bool autoDeleteDuplicates = false)
        {
            var started = DateTime.Now;
            var summary = new LibrarySummary { LibraryRoot = Config.LibraryRoot };
            var index = LoadIndex();
            var errors = new List<string>();
            var dupLines = new List<string>();
            var autoDeletePaths = new List<string>();
            var encryptedCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            long encryptedBytes = 0;
            void P(string msg) { try { progress?.Invoke(msg); } catch { } }

            // 0) 库内已有文件：只按大小分组，不读全文件（同大小才读哈希）
            P("扫描音乐库…");
            var bySize = new Dictionary<long, List<LibRef>>();
            var relToKey = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in index) if (kv.Value?.RelPath != null) relToKey[kv.Value.RelPath] = kv.Key;
            try
            {
                foreach (var path in Directory.EnumerateFiles(MusicDir, "*", SearchOption.AllDirectories))
                {
                    if (!PlayableExt.Contains(Path.GetExtension(path))) continue;
                    var rel = Path.GetRelativePath(Config.LibraryRoot, path);
                    var size = new FileInfo(path).Length;
                    var key = relToKey.TryGetValue(rel, out var k) ? k : "size:" + size;
                    if (!index.ContainsKey(key))
                    {
                        var tag = ReadTags(path);
                        index[key] = new LibraryIndexEntry { RelPath = rel, Artist = tag.Artist, Album = tag.Album, Title = tag.Title, Size = size };
                    }
                    else if (index[key] is LibraryIndexEntry old &&
                             (string.IsNullOrWhiteSpace(old.Title) || string.IsNullOrWhiteSpace(old.Artist)))
                    {
                        // 旧索引里标签为空的条目（早期导入的 M4A）用文件名补齐并回写。
                        var tag = ReadTags(path);
                        old.RelPath = rel;
                        old.Artist = tag.Artist;
                        if (string.IsNullOrWhiteSpace(old.Album)) old.Album = tag.Album;
                        old.Title = tag.Title;
                    }
                    var rf = new LibRef { Key = key, RelPath = rel, AbsPath = path, Size = size };
                    if (!bySize.TryGetValue(size, out var l)) bySize[size] = l = new List<LibRef>();
                    l.Add(rf);
                }
            }
            catch (Exception ex) { errors.Add("扫描库失败：" + ex.Message); }

            // 1) 来源文件按大小分组：唯一大小直接导入（不读全文件）；同大小才计算哈希去重
            P("扫描导入来源…");
            var sourceItems = new List<string>();
            foreach (var source in Config.SourceDirs)
            {
                try
                {
                    if (!Directory.Exists(source)) continue;
                    var fullSource = Path.GetFullPath(source);
                    if (IsInside(fullSource, Path.GetFullPath(Config.LibraryRoot))) continue;
                    foreach (var file in Directory.EnumerateFiles(fullSource, "*", SearchOption.AllDirectories))
                    {
                        var ext = Path.GetExtension(file).ToLowerInvariant();
                        if (EncryptedExt.Contains(ext))
                        {
                            var size = new FileInfo(file).Length;
                            summary.EncryptedFiles++;
                            encryptedBytes += size;
                            encryptedCounts[ext] = encryptedCounts.TryGetValue(ext, out var c) ? c + 1 : 1;
                        }
                        else if (PlayableExt.Contains(ext)) sourceItems.Add(file);
                    }
                }
                catch (Exception ex) { errors.Add("扫描来源失败 " + source + "：" + ex.Message); }
            }
            summary.SourceFiles = sourceItems.Count;
            summary.EncryptedBytes = encryptedBytes;

            P("导入与去重…");
            int imported = 0;
            var sourceGroups = sourceItems.Select(p => new { Path = p, Size = new FileInfo(p).Length }).GroupBy(x => x.Size);
            var existingHashes = new HashSet<string>(index.Keys.Where(k => !k.StartsWith("size:", StringComparison.OrdinalIgnoreCase)), StringComparer.OrdinalIgnoreCase);
            int done = 0, total = sourceItems.Count;

            foreach (var group in sourceGroups)
            {
                if (!bySize.TryGetValue(group.Key, out var candidates)) candidates = new List<LibRef>();
                var items = group.ToList();
                bool needHash = items.Count > 1 || candidates.Count > 0;
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (needHash)
                {
                    foreach (var c in candidates)
                    {
                        if (c.Hash == null) { try { c.Hash = HashFile(c.AbsPath); } catch { } }
                    }
                }
                foreach (var item in items)
                {
                    done++;
                    try
                    {
                        string hash = null;
                        if (needHash)
                        {
                            hash = HashFile(item.Path);
                            var matched = candidates.FirstOrDefault(c => string.Equals(c.Hash, hash, StringComparison.OrdinalIgnoreCase));
                            if (seen.Contains(hash) || matched != null || existingHashes.Contains(hash))
                            {
                                summary.ExactDuplicates++;
                                if (dupLines.Count < 600)
                                    dupLines.Add("- `" + item.Path + "`  \n  与库内 `" + (matched?.RelPath ?? "(已有)") + "` 完全相同（SHA-256）");
                                if (!IsInside(Path.GetFullPath(item.Path), Path.GetFullPath(Config.LibraryRoot)))
                                    autoDeletePaths.Add(item.Path);
                                continue;
                            }
                            seen.Add(hash);
                        }
                        var tag = ReadTags(item.Path);
                        var dest = BuildDestination(tag, item.Path);
                        bool linked = TryLink(item.Path, dest);
                        if (linked) summary.Linked++;
                        var rel = Path.GetRelativePath(Config.LibraryRoot, dest);
                        var key = hash ?? ("size:" + item.Size);
                        while (index.ContainsKey(key)) key = key + ":" + Guid.NewGuid().ToString("N").Substring(0, 8);
                        index[key] = new LibraryIndexEntry { RelPath = rel, Artist = tag.Artist, Album = tag.Album, Title = tag.Title, Size = item.Size };
                        if (hash != null) existingHashes.Add(hash);
                        if (!bySize.TryGetValue(item.Size, out var list)) bySize[item.Size] = list = new List<LibRef>();
                        list.Add(new LibRef { Key = key, RelPath = rel, AbsPath = dest, Size = item.Size, Hash = hash });
                        imported++;
                        summary.Imported++;
                        summary.ImportedBytes += item.Size;
                    }
                    catch (Exception ex)
                    {
                        if (errors.Count < 200) errors.Add("导入失败 " + item.Path + "：" + ex.Message);
                    }
                    if (done % 10 == 0 || done == total) P("整理中… " + done + "/" + total + "，已导入 " + imported);
                }
            }

            // 2) 完全重复的来源文件：默认不动；开启自动清理后送回收站。
            if (autoDeleteDuplicates && autoDeletePaths.Count > 0)
            {
                P("清理完全重复的来源文件…");
                foreach (var path in autoDeletePaths.Distinct(StringComparer.OrdinalIgnoreCase))
                {
                    try
                    {
                        if (!File.Exists(path)) continue;
                        var size = new FileInfo(path).Length;
                        if (OperatingSystem.IsWindows())
                            VBFileSystem.DeleteFile(path, VBUIOption.OnlyErrorDialogs, VBRecycleOption.SendToRecycleBin);
                        else
                            File.Delete(path);
                        summary.AutoDeletedDuplicates++;
                        summary.AutoDeletedBytes += size;
                    }
                    catch (Exception ex)
                    {
                        summary.AutoDeleteErrors++;
                        if (errors.Count < 200) errors.Add("自动删除重复失败 " + path + "：" + ex.Message);
                    }
                }
            }

            // 3) 近似重复
            var near = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in index)
            {
                var key = NormKey(kv.Value.Artist, kv.Value.Title);
                if (key.Trim('|').Length == 0) continue;
                if (!near.TryGetValue(key, out var list)) near[key] = list = new List<string>();
                list.Add(kv.Value.RelPath ?? "");
            }
            var nearGroups = near.Where(x => x.Value.Count > 1).ToList();
            summary.NearDuplicateGroups = nearGroups.Count;
            summary.Errors = errors.Count;
            summary.Elapsed = DateTime.Now - started;
            summary.EncryptedByType.AddRange(encryptedCounts.OrderByDescending(x => x.Value).Select(x => x.Key + " × " + x.Value));
            SaveIndex(index);

            // 3) 报告
            try
            {
                var sb = new StringBuilder();
                sb.AppendLine("# 音乐库整理报告");
                sb.AppendLine();
                sb.AppendLine("- 生成时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                sb.AppendLine("- 音乐库：" + Config.LibraryRoot);
                sb.AppendLine("- 来源：" + string.Join("；", Config.SourceDirs));
                sb.AppendLine("- 用时：" + summary.Elapsed.ToString(@"hh\:mm\:ss"));
                sb.AppendLine();
                sb.AppendLine("## 结果");
                sb.AppendLine();
                sb.AppendLine("| 项目 | 数量 |");
                sb.AppendLine("|---|---|");
                sb.AppendLine("| 来源中可导入文件 | " + summary.SourceFiles + " |");
                sb.AppendLine("| 本轮导入 | " + summary.Imported + "（" + FormatBytes(summary.ImportedBytes) + "） |");
                sb.AppendLine("| 硬链接（同盘，不额外占空间） | " + summary.Linked + " |");
                sb.AppendLine("| 完全重复（未重复导入） | " + summary.ExactDuplicates + " |");
                sb.AppendLine("| 自动删除完全重复来源 | " + summary.AutoDeletedDuplicates + "（" + FormatBytes(summary.AutoDeletedBytes) + "，回收站） |");
                sb.AppendLine("| 自动删除失败 | " + summary.AutoDeleteErrors + " |");
                sb.AppendLine("| 加密原档（未导入） | " + summary.EncryptedFiles + "（" + FormatBytes(encryptedBytes) + "） |");
                sb.AppendLine("| 近似重复组 | " + summary.NearDuplicateGroups + " |");
                sb.AppendLine("| 错误 | " + summary.Errors + " |");
                sb.AppendLine();
                if (summary.EncryptedByType.Count > 0)
                {
                    sb.AppendLine("## 加密原档统计（需解密后才能进入播放库）");
                    sb.AppendLine();
                    foreach (var x in summary.EncryptedByType) sb.AppendLine("- " + x);
                    sb.AppendLine();
                }
                if (nearGroups.Count > 0)
                {
                    sb.AppendLine("## 近似重复（同歌手 + 同标题，不同文件）");
                    sb.AppendLine();
                    foreach (var g in nearGroups.Take(200))
                    {
                        sb.AppendLine("- `" + g.Key + "`");
                        foreach (var p in g.Value.Take(5)) sb.AppendLine("  - " + p);
                    }
                    sb.AppendLine();
                }
                if (dupLines.Count > 0)
                {
                    sb.AppendLine("## 完全重复的来源文件（库内保留一份）");
                    sb.AppendLine();
                    sb.AppendLine("> 开启「自动删除完全重复」时，命中的来源文件已送入回收站；未开启时以下文件保持原样。");
                    sb.AppendLine();
                    foreach (var d in dupLines.Take(400)) sb.AppendLine(d);
                    sb.AppendLine();
                }
                if (errors.Count > 0)
                {
                    sb.AppendLine("## 错误");
                    sb.AppendLine();
                    foreach (var e in errors.Take(100)) sb.AppendLine("- " + e);
                }
                sb.AppendLine();
                sb.AppendLine("> 音乐库文件只新增/去重；开启自动清理时，完全重复来源文件送回收站；近似重复只报告不处理。");
                var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
                var report = Path.Combine(ReportDir, "整理报告-" + stamp + ".md");
                File.WriteAllText(report, sb.ToString(), new UTF8Encoding(true));
                File.WriteAllText(Path.Combine(ReportDir, "最新整理报告.md"), sb.ToString(), new UTF8Encoding(true));
                summary.ReportPath = report;
            }
            catch (Exception ex)
            {
                errors.Add("写报告失败：" + ex.Message);
                summary.Errors = errors.Count;
            }

            try { File.WriteAllText(AppPaths.MaintenanceLog, BuildSummary(summary), new UTF8Encoding(true)); } catch { }
            P("完成：" + BuildSummary(summary).Replace(Environment.NewLine, " "));
            return summary;
        }

        public static string FormatBytes(long bytes)
        {
            double b = bytes;
            string[] units = { "B", "KB", "MB", "GB", "TB" };
            int i = 0;
            while (b >= 1024 && i < units.Length - 1) { b /= 1024; i++; }
            return b.ToString("0.##") + " " + units[i];
        }

        public LibraryRemovalResult RemoveLibraryTracks(IEnumerable<(string Title, string Artist)> tracks, bool recycle = true)
        {
            var result = new LibraryRemovalResult();
            var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var t in tracks)
            {
                var key = NormKey(t.Artist, t.Title);
                if (key.Trim('|').Length > 0) wanted.Add(key);
            }
            if (wanted.Count == 0) return result;
            var index = LoadIndex();
            var root = Path.GetFullPath(Config.LibraryRoot);
            foreach (var kv in index.ToList())
            {
                var entry = kv.Value;
                if (entry == null || string.IsNullOrWhiteSpace(entry.RelPath)) continue;
                if (!wanted.Contains(NormKey(entry.Artist, entry.Title))) continue;
                var path = Path.GetFullPath(Path.Combine(Config.LibraryRoot, entry.RelPath));
                if (!IsInside(path, root))
                {
                    result.Errors.Add("拒绝删除库外路径：" + path);
                    continue;
                }
                try
                {
                    if (File.Exists(path))
                    {
                        var size = new FileInfo(path).Length;
                        if (recycle && OperatingSystem.IsWindows())
                            VBFileSystem.DeleteFile(path, VBUIOption.OnlyErrorDialogs, VBRecycleOption.SendToRecycleBin);
                        else
                            File.Delete(path);
                        result.Bytes += size;
                        result.Paths.Add(path);
                        result.Removed++;
                    }
                    index.Remove(kv.Key);
                }
                catch (Exception ex)
                {
                    result.Errors.Add(path + "：" + ex.Message);
                }
            }
            SaveIndex(index);
            return result;
        }

        public static string BuildSummary(LibrarySummary s)
        {
            return "音乐库 " + s.LibraryRoot + Environment.NewLine +
                   "来源文件 " + s.SourceFiles + "，导入 " + s.Imported + "（" + FormatBytes(s.ImportedBytes) + "，硬链接 " + s.Linked + "）" + Environment.NewLine +
                   "完全重复 " + s.ExactDuplicates + "，自动删除重复来源 " + s.AutoDeletedDuplicates + "，近似重复组 " + s.NearDuplicateGroups + Environment.NewLine +
                   "加密原档 " + s.EncryptedFiles + "（" + FormatBytes(s.EncryptedBytes) + "），错误 " + s.Errors + Environment.NewLine +
                   "用时 " + s.Elapsed.ToString(@"hh\:mm\:ss") + Environment.NewLine +
                   "报告 " + (s.ReportPath ?? "(未生成)");
        }
    }
}
