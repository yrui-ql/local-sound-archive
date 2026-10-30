using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace MusicArchive
{
    internal static class Program
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

        [STAThread]
        private static int Main(string[] args)
        {
            AppPaths.EnsureDirs();
            if (args.Length > 0 && (args[0] == "--maintain" || args[0] == "maintain"))
            {
                try
                {
                    var lib = new LibraryService();
                    var summary = lib.Maintain(msg => { try { File.AppendAllText(AppPaths.MaintenanceLog, msg + Environment.NewLine, new UTF8Encoding(true)); } catch { } });
                    File.WriteAllText(AppPaths.MaintenanceLog, LibraryService.BuildSummary(summary), new UTF8Encoding(true));
                    return 0;
                }
                catch (Exception ex)
                {
                    try { File.WriteAllText(AppPaths.MaintenanceLog, "整理失败：" + ex, new UTF8Encoding(true)); } catch { }
                    return 1;
                }
            }
            Application.SetHighDpiMode(HighDpiMode.SystemAware);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { SetCurrentProcessExplicitAppUserModelID("MusicArchive.Client"); } catch { }
            Application.Run(new MainForm());
            return 0;
        }
    }
}
