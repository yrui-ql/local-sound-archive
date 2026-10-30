using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using NAudio.Wave;

namespace MusicArchive
{
    internal sealed class RecordingService : IDisposable
    {
        private WasapiLoopbackCapture _capture;
        private WaveFileWriter _writer;
        private TaskCompletionSource<bool> _stopped;
        private string _wavPath;

        public DateTime StartedAt { get; private set; }
        public bool IsRecording { get { return _capture != null; } }
        public string LastFile { get; private set; }

        public void Start(string outputDir, string tempDir)
        {
            if (_capture != null) throw new InvalidOperationException("已经在录音");
            Directory.CreateDirectory(outputDir);
            Directory.CreateDirectory(tempDir);
            _wavPath = Path.Combine(tempDir, "rec-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".wav");
            _capture = new WasapiLoopbackCapture();
            _writer = new WaveFileWriter(_wavPath, _capture.WaveFormat);
            _stopped = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _capture.DataAvailable += (s, e) =>
            {
                try { if (e.BytesRecorded > 0) _writer.Write(e.Buffer, 0, e.BytesRecorded); } catch { }
            };
            _capture.RecordingStopped += (s, e) =>
            {
                try { _writer?.Flush(); } catch { }
                _stopped.TrySetResult(true);
            };
            _capture.StartRecording();
            StartedAt = DateTime.Now;
        }

        public async Task<string> StopAsync(string outputDir)
        {
            if (_capture == null) return null;
            var capture = _capture;
            try { capture.StopRecording(); } catch { }
            try { await Task.WhenAny(_stopped.Task, Task.Delay(10000)); } catch { }
            try { capture.Dispose(); } catch { }
            try { _writer.Dispose(); } catch { }
            _capture = null;
            _writer = null;
            var baseName = "录音 " + StartedAt.ToString("yyyy-MM-dd HH-mm-ss");
            var wav = _wavPath;
            _wavPath = null;
            var flac = Path.Combine(outputDir, baseName + ".flac");
            if (File.Exists(wav) && File.Exists(AppPaths.FfmpegExe) && await ConvertToFlacAsync(wav, flac))
            {
                try { File.Delete(wav); } catch { }
                LastFile = flac;
                return flac;
            }
            LastFile = wav;
            return wav;
        }

        private static async Task<bool> ConvertToFlacAsync(string wav, string flac)
        {
            try
            {
                var psi = new ProcessStartInfo(AppPaths.FfmpegExe)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                foreach (var a in new[] { "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-c:a", "flac", "-compression_level", "8", flac })
                    psi.ArgumentList.Add(a);
                using var p = Process.Start(psi);
                await p.WaitForExitAsync();
                return p.ExitCode == 0 && File.Exists(flac) && new FileInfo(flac).Length > 0;
            }
            catch { return false; }
        }

        public void Dispose()
        {
            try { _capture?.Dispose(); } catch { }
            try { _writer?.Dispose(); } catch { }
            _capture = null;
            _writer = null;
        }
    }
}
