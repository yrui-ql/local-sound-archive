using System;
using System.IO;

namespace MusicArchive
{
    internal static class AppPaths
    {
        public static readonly string AppDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        private static string Up(string p, int n)
        {
            for (int i = 0; i < n; i++)
            {
                var d = Directory.GetParent(p);
                if (d == null) return p;
                p = d.FullName;
            }
            return p;
        }
        // app -> music-client -> media -> env -> workspace
        public static readonly string MediaDir = Up(AppDir, 2);
        public static readonly string EnvDir = Up(AppDir, 3);
        public static readonly string Root = Up(AppDir, 4);
        public static readonly string DataDir = Environment.GetEnvironmentVariable("MUSIC_ARCHIVE_DATA_DIR") is { Length: > 0 } data
            ? Path.GetFullPath(Environment.ExpandEnvironmentVariables(data))
            : Path.Combine(Root, "03_DATA", "50_music");
        public static readonly string LogDir = Path.Combine(DataDir, "logs");
        public static readonly string CredFile = Path.Combine(DataDir, "admin-credentials.txt");
        public static readonly string ConfigFile = Environment.GetEnvironmentVariable("MUSIC_ARCHIVE_CONFIG") is { Length: > 0 } cfg
            ? Path.GetFullPath(Environment.ExpandEnvironmentVariables(cfg))
            : Path.Combine(DataDir, "client-config.json");
        public static readonly string MaintenanceLog = Path.Combine(DataDir, "maintenance.log");
        public static readonly string MusicDlExe = Path.Combine(MediaDir, "go-music-dl", "music-dl.exe");
        public static readonly string FfmpegExe = Path.Combine(EnvDir, "30_phone", "_tools", "ffmpeg", "ffmpeg.exe");
        public static readonly string AppExe = Path.Combine(AppDir, "LSA.exe");

        public static void EnsureDirs()
        {
            Directory.CreateDirectory(DataDir);
            Directory.CreateDirectory(LogDir);
        }

        public static string[] ReadAdminCredentials()
        {
            try
            {
                if (!File.Exists(CredFile)) return null;
                string user = null, pass = null;
                foreach (var line in File.ReadAllLines(CredFile))
                {
                    if (line.StartsWith("username=")) user = line.Substring("username=".Length);
                    else if (line.StartsWith("password=")) pass = line.Substring("password=".Length);
                }
                if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(pass)) return null;
                return new[] { user, pass };
            }
            catch { return null; }
        }

        public static string DetectSodaClientDir()
        {
            var env = Environment.GetEnvironmentVariable("QISHUI_CLIENT_DIR");
            if (!string.IsNullOrEmpty(env) && File.Exists(Path.Combine(env, "SodaMusic.exe"))) return env;
            var roots = new System.Collections.Generic.List<string>();
            foreach (var hive in new[] { Microsoft.Win32.RegistryHive.CurrentUser, Microsoft.Win32.RegistryHive.LocalMachine })
            {
                foreach (var view in new[] { Microsoft.Win32.RegistryView.Default, Microsoft.Win32.RegistryView.Registry32 })
                {
                    try
                    {
                        using (var baseKey = Microsoft.Win32.RegistryKey.OpenBaseKey(hive, view))
                        using (var uninstall = baseKey.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                        {
                            if (uninstall == null) continue;
                            foreach (var sub in uninstall.GetSubKeyNames())
                            {
                                using (var k = uninstall.OpenSubKey(sub))
                                {
                                    if (k == null) continue;
                                    var name = k.GetValue("DisplayName") as string;
                                    var loc = k.GetValue("InstallLocation") as string;
                                    if (!string.IsNullOrEmpty(loc) && name != null && (name.Contains("汽水") || name.IndexOf("SodaMusic", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("QiShui", StringComparison.OrdinalIgnoreCase) >= 0))
                                        roots.Add(loc);
                                }
                            }
                        }
                    }
                    catch { }
                }
            }
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.DriveType != DriveType.Fixed) continue;
                    foreach (var n in new[] { "QiShuiMusic", "SodaMusic", "汽水音乐" })
                        roots.Add(Path.Combine(drive.RootDirectory.FullName, n));
                }
                catch { }
            }
            foreach (var loc in roots)
            {
                try
                {
                    if (!Directory.Exists(loc)) continue;
                    foreach (var sig in Directory.EnumerateFiles(loc, "bdms.node", SearchOption.AllDirectories))
                    {
                        // bdms.node 位于 <版本目录>/resources/app.asar.unpacked/，SodaMusic.exe 在 <版本目录> 根。
                        var dir = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sig), "..", ".."));
                        if (File.Exists(Path.Combine(dir, "SodaMusic.exe"))) return dir;
                    }
                }
                catch { }
            }
            return null;
        }
    }
}


