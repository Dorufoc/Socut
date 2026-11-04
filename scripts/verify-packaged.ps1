$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($env:FOCUSNEWS_ROOT) { $root = $env:FOCUSNEWS_ROOT } else { $root = Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
$installDir = Join-Path $root '.tmp-install\FocusNews'
$setup = Get-ChildItem (Join-Path $root 'release') -Filter '*Setup-win-x64.exe' | Select-Object -First 1
$logFile = Join-Path $env:APPDATA 'focusnews\logs\app.log'
$shotDir = Join-Path $root 'spikes\artifacts'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

function Step($msg) { "[packaged] $msg" }

# 1) 静默安装
if (Test-Path $installDir) { Step "安装目录已存在，先删除"; Remove-Item $installDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Step "安装包 $($setup.Name) $([math]::Round($setup.Length/1MB,2)) MB"
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S', "/D=$installDir" -PassThru -Wait
Step "installer-exit=$($p.ExitCode)"
Step "installed-files=$((Get-ChildItem $installDir -Recurse -File | Measure-Object).Count) / $([math]::Round((Get-ChildItem $installDir -Recurse -File | Measure-Object Length -Sum).Sum/1MB,1)) MB"

# 2) 断网冷启动：把 Chromium 的所有请求指向一个无人监听的端口（等价于无网络）
$exe = Join-Path $installDir 'FocusNews.exe'
$app = Start-Process -FilePath $exe -ArgumentList '--proxy-server=127.0.0.1:9' -PassThru
Step "launched pid=$($app.Id) args=--proxy-server=127.0.0.1:9"
Start-Sleep -Seconds 22

$procs = Get-Process -Name 'FocusNews' -ErrorAction SilentlyContinue
Step "alive-processes=$($procs.Count) workingset=$([math]::Round(($procs | Measure-Object WorkingSet64 -Sum).Sum/1MB,1))MB"
$main = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $main) { Step 'NO-MAIN-WINDOW'; }
else {
  $h = $main.MainWindowHandle
  [void][Win32]::ShowWindow($h, 9)   # SW_RESTORE
  [void][Win32]::MoveWindow($h, 40, 40, 1360, 860, $true)
  [void][Win32]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 4000
  $r = New-Object Win32+RECT
  [void][Win32]::GetWindowRect($h, [ref]$r)
  Step "window title='$($main.MainWindowTitle)' rect=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
  $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $png = Join-Path $shotDir 'packaged-coldstart.png'
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Step "screenshot=$png $([math]::Round((Get-Item $png).Length/1KB,1))KB"
}

# 3) 运行期日志（含随包 FFmpeg 路径与离线启动证据）
Step '--- app.log tail ---'
Get-Content $logFile -Tail 8 | ForEach-Object { "  $_" }

# 4) 优雅关闭：验证退出纪律
if ($main) { [void]$main.CloseMainWindow() }
Start-Sleep -Seconds 8
Step "after-close-alive=$((Get-Process -Name 'FocusNews' -ErrorAction SilentlyContinue).Count)"
Step '--- app.log after close ---'
Get-Content $logFile -Tail 3 | ForEach-Object { "  $_" }

# 4.5) 升级（覆盖安装，M4-4）：同一安装包再装一次到同一目录 = 用户装新版本时的路径，
# 断言三件事：覆盖安装成功、asar 外的 FFmpeg 仍在、升级后仍能离线冷启动
$up = Start-Process -FilePath $setup.FullName -ArgumentList '/S', "/D=$installDir" -PassThru -Wait
Step "upgrade-installer-exit=$($up.ExitCode)"
Step "upgrade-files=$((Get-ChildItem $installDir -Recurse -File | Measure-Object).Count) / $([math]::Round((Get-ChildItem $installDir -Recurse -File | Measure-Object Length -Sum).Sum/1MB,1)) MB"
Step "upgrade-ffmpeg-bundled=$((Get-ChildItem $installDir -Recurse -File -Filter 'ffmpeg.exe' | Measure-Object).Count)"
$app2 = Start-Process -FilePath $exe -ArgumentList '--proxy-server=127.0.0.1:9' -PassThru
Step "upgrade-launched pid=$($app2.Id)"
Start-Sleep -Seconds 18
$alive2 = @(Get-Process -Name 'FocusNews' -ErrorAction SilentlyContinue)
Step "upgrade-alive-processes=$($alive2.Count)"
Step '--- app.log tail after upgrade ---'
Get-Content $logFile -Tail 4 | ForEach-Object { "  $_" }
foreach ($proc in $alive2) { try { [void]$proc.CloseMainWindow() } catch { } }
Start-Sleep -Seconds 6
$left = @(Get-Process -Name 'FocusNews' -ErrorAction SilentlyContinue)
Step "upgrade-after-close-alive=$($left.Count)"
if ($left.Count -gt 0) { $left | Stop-Process -Force; Step 'upgrade force-killed residual' }

# 5) 静默卸载
$uninstaller = Join-Path $installDir 'Uninstall FocusNews.exe'
$u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
Step "uninstaller-exit=$($u.ExitCode)"
Start-Sleep -Seconds 3
Step "install-dir-exists=$(Test-Path $installDir)"

