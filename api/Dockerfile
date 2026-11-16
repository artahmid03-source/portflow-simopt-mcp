# PortFlow planning API (api/app.py): the CP-SAT + yard-simulation engine behind the tower pages' copilot.
#   docker build -f api/Dockerfile -t portflow-api .
#   docker run -p 8000:8000 portflow-api            -> http://localhost:8000/health
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "ortools>=9.10" "simpy>=4.1" "scipy>=1.11" "numpy>=1.26" "fastmcp>=2.0"
COPY portflow_mcp.py ./
COPY sites/ sites/
COPY api/ api/
ENV PYTHONUNBUFFERED=1 PORTFLOW_CPSAT_TIME_S=20 PORTFLOW_CPSAT_WORKERS=2 PORTFLOW_PROCS=1
EXPOSE 8000
CMD ["python", "api/app.py"]
