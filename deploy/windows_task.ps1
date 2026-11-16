# Runs the collector on this Windows PC every 30 minutes (Task Scheduler), as an alternative to an always-on server.
# Prerequisites: git and uv on PATH, a clone of the data branch in .\store, and AISSTREAM_API_KEY set for your user:
#   git clone -b data --single-branch https://github.com/artahmid03-source/portflow-simopt-mcp.git store
#   [Environment]::SetEnvironmentVariable("AISSTREAM_API_KEY", "<your key>", "User")
$repo = Split-Path -Parent $PSScriptRoot
$cmd = "cd '$repo'; uv run --extra ais python ingest/collect.py --store store --minutes 12 --git-push"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "PortFlow AIS collector" -Action $action -Trigger $trigger -Description "PortFlow: listen to AISStream and push to the data branch" -Force
