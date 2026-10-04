# One Windows job object for one run's processes (37beede). The runner starts this host at the start of a run, has it
# assign each turn's claude.exe to the job as soon as it is spawned, and at the end of the run asks it for the
# processes still in the job and then ends them all. A process created by a process in the job is in the job too,
# whatever becomes of its parent, so the commands the CLI moves to the background and the shells Git Bash starts
# for them (whose parents exit at once) are ended with the rest. Nothing is ended between turns.
#
# Commands on stdin, one per line: "assign <pid>", "list", "kill", "exit". Each answers one line of JSON on stdout.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class M3Job {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returned);
  public static int[] Pids(IntPtr job) {
    int size = 8 + 4 * 4096;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) return new int[0];
      int n = Marshal.ReadInt32(buf, 4);
      int[] pids = new int[n];
      for (int i = 0; i < n; i++) pids[i] = (int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size);
      return pids;
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
"@
$job = [M3Job]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { Write-Output '{"ready":false}'; exit 1 }
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim().Split(' ')
  switch ($parts[0]) {
    'assign' {
      $pid_ = [int]$parts[1]
      # PROCESS_SET_QUOTA | PROCESS_TERMINATE
      $h = [M3Job]::OpenProcess(0x0101, $false, $pid_)
      $ok = ($h -ne [IntPtr]::Zero) -and [M3Job]::AssignProcessToJobObject($job, $h)
      if ($h -ne [IntPtr]::Zero) { [void][M3Job]::CloseHandle($h) }
      [Console]::Out.WriteLine((@{ assigned = $pid_; ok = [bool]$ok } | ConvertTo-Json -Compress))
    }
    'list' {
      $pids = [M3Job]::Pids($job)
      $procs = @(foreach ($p in $pids) { $c = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; if ($c) { @{ pid = $p; command = [string]$c.CommandLine } } })
      [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ processes = $procs }))
    }
    'kill' {
      $ok = [M3Job]::TerminateJobObject($job, 1)
      [Console]::Out.WriteLine((@{ killed = [bool]$ok } | ConvertTo-Json -Compress))
    }
    'exit' { [void][M3Job]::CloseHandle($job); exit 0 }
  }
  [Console]::Out.Flush()
}
