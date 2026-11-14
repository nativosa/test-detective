// R4b Step 1D: the stdio relay and job object of launch-as.ps1 (compiled there with Add-Type, and by
// src/eval/test/sandbox-relay.test.ts against a same-user child). Starts the child described by the
// ProcessStartInfo (in production with UserName/Password: CreateProcessWithLogonW), puts it in a
// kill-on-close job object, and only then writes JobConfirmation to the child's stdin. stage2.mjs
// waits for that line before it starts anything, so no descendant can exist outside the job. When
// this process exits or is killed, the job handle closes and Windows ends every process in the job.
// Note: .NET Framework's Process.Start may itself write a UTF-8 BOM to the child's stdin before
// anything else (AutoFlush on a UTF-8 console encoding); stage2.mjs consumes it with the confirmation.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TdSandboxRelay {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  const uint KillOnJobClose = 0x2000;
  const int ExtendedLimitInformation = 9;
  /** The first line the child reads on stdin; written only after the child is in the job. */
  public const string JobConfirmation = "TD-JOB-ASSIGNED";

  static Thread Pump(Stream from, Stream to, bool closeTarget) {
    var t = new Thread(() => {
      var buffer = new byte[65536];
      try {
        int n;
        while ((n = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, n); to.Flush(); }
      } catch (IOException) { } catch (ObjectDisposedException) { }
      if (closeTarget) { try { to.Close(); } catch (IOException) { } }
    });
    t.IsBackground = true;
    t.Start();
    return t;
  }

  static void Kill(Process child) {
    try { child.Kill(); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
  }

  // Returns the child's exit code; 96 when the child could not be put in the job (it is killed before it was told to go on).
  public static int Run(ProcessStartInfo info) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return 96;
    var limits = new ExtendedLimits();
    limits.Basic.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) return 96;
    Process child = Process.Start(info);
    bool inJob;
    if (!AssignProcessToJobObject(job, child.Handle) || !IsProcessInJob(child.Handle, job, out inJob) || !inJob) {
      Kill(child);
      return 96;
    }
    Stream childIn = child.StandardInput.BaseStream;
    byte[] go = Encoding.ASCII.GetBytes(JobConfirmation + "\n");
    try { childIn.Write(go, 0, go.Length); childIn.Flush(); } catch (IOException) { Kill(child); return 96; }
    Pump(Console.OpenStandardInput(), childIn, true);
    Thread output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
    Thread errors = Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false);
    child.WaitForExit();
    output.Join(5000);
    errors.Join(5000);
    // The job handle stays open until this process exits; then KILL_ON_JOB_CLOSE ends any leftover descendant.
    return child.ExitCode;
  }
}
