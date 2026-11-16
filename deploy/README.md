# Continuous AIS collection

GitHub Actions runs the collector every half hour, but GitHub skips scheduled runs under load (on 15-16 Nov 2026 it ran 5 times in 19 hours) and each run listens for 12 minutes. For an unbroken record, run the same script somewhere that stays on.

| Option | What to do |
|---|---|
| Any small Linux server or Raspberry Pi | `docker build -f deploy/Dockerfile -t portflow-collector .` then `docker run -d --restart unless-stopped -e AISSTREAM_API_KEY=<key> -e GIT_REMOTE=https://<token>@github.com/<you>/portflow-simopt-mcp.git portflow-collector`. The token needs write access to the repository contents (a fine-grained personal access token limited to this repository). |
| This Windows PC | Run `deploy/windows_task.ps1` once in PowerShell. It registers a Task Scheduler job that collects for 12 minutes every half hour and pushes. |
| Without git | `python ingest/collect.py --store store --minutes 20 --cycles 0` collects forever into a local folder. |

The collector writes the same files as the GitHub job, so the daily plans, the backtest and the pages read them unchanged. Keep the key out of files and chat; pass it only as an environment variable or secret.
