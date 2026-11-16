# Always-on AIS collector: listens around the clock and pushes to the `data` branch every cycle.
#   docker build -f deploy/Dockerfile -t portflow-collector .
#   docker run -d --restart unless-stopped -e AISSTREAM_API_KEY=... -e GIT_REMOTE=https://<token>@github.com/<you>/portflow-simopt-mcp.git portflow-collector
FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY ingest/ ingest/
RUN pip install --no-cache-dir "websockets>=14"
COPY deploy/run_collector.sh /app/run_collector.sh
CMD ["sh", "/app/run_collector.sh"]
