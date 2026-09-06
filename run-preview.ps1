$nodeDir = "%APPDATA%\fnm\node-versions\<version>\installation"
$env:PATH = "$nodeDir;$env:PATH"
& "$nodeDir\npm.cmd" run preview --workspace app -- --port 4173
