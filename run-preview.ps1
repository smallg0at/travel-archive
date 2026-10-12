# The newest installed node, whatever version that is: the version directory is
# machine state, and hardcoding one goes stale on the next upgrade.
$nodeDir = (Get-ChildItem "$env:APPDATA\fnm\node-versions\*\installation" -Directory |
  Sort-Object { [version]($_.Parent.Name -replace '^v', '') } |
  Select-Object -Last 1).FullName
$env:PATH = "$nodeDir;$env:PATH"
& "$nodeDir\npm.cmd" run preview --workspace app -- --port 4173
