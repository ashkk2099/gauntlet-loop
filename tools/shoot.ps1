# shoot.ps1 — 用无头 Edge 截取游戏关键时刻
# 用法: powershell -File tools\shoot.ps1 [-Seed 7] [-Tag v1]
param(
  [int]$Seed = 7,
  [string]$Tag = "v1"
)
$ErrorActionPreference = "Continue"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$prof = "$env:TEMP\edge-headless-gauntlet"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$game = "file:///" + ($root -replace "\\","/") + "/index.html"
$outDir = Join-Path $root "shots"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 每个关键时刻: 名称 + 是否双视口
$shots = @(
  @{ name = "deal";    vps = @("desktop","mobile") },
  @{ name = "reveal";  vps = @("desktop","mobile") },
  @{ name = "result";  vps = @("desktop","mobile") },
  @{ name = "double";  vps = @("desktop") },
  @{ name = "round3";  vps = @("mobile") },
  @{ name = "final";   vps = @("desktop","mobile") }
)
$sizes = @{ desktop = "1440,900"; mobile = "390,844" }

foreach ($s in $shots) {
  foreach ($vp in $s.vps) {
    $file = Join-Path $outDir "$Tag-$($s.name)-$vp.png"
    $url = "$game`?shot=$($s.name)&seed=$Seed"
    $args = @(
      "--headless=new","--disable-gpu","--hide-scrollbars",
      "--user-data-dir=$prof",
      "--screenshot=$file",
      "--window-size=$($sizes[$vp])",
      "--virtual-time-budget=8000",
      $url
    )
    $p = Start-Process -FilePath $edge -ArgumentList $args -Wait -PassThru -NoNewWindow
    if (Test-Path $file) {
      $kb = [math]::Round((Get-Item $file).Length/1KB)
      Write-Output "OK  $Tag-$($s.name)-$vp.png ($kb KB)"
    } else {
      Write-Output "FAIL $Tag-$($s.name)-$vp.png (exit $($p.ExitCode))"
    }
  }
}
