"""MCP server entry point: the PortFlow engine tools plus the Chattogram NCT tools.

    uv run server.py          (stdio transport, for Claude Desktop / Claude Code)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "sites"))
import chattogram_nct  # noqa: E402  (registers the nct_* tools on the engine's server)

if __name__ == "__main__":
    chattogram_nct.eng.mcp.run()
