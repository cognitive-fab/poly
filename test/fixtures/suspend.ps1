# Suspends or resumes a process by id (test/m3-cleanup.test.mjs): a launcher held suspended cannot start the CLI, as
# under the gate's load on 4 October, when the cap fired before the stand-in CLI had started.
param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][ValidateSet('suspend', 'resume')][string]$Action)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PolySuspend {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
"@
$p = [System.Diagnostics.Process]::GetProcessById($ProcessId)
if ($Action -eq 'suspend') { [void][PolySuspend]::NtSuspendProcess($p.Handle) } else { [void][PolySuspend]::NtResumeProcess($p.Handle) }
