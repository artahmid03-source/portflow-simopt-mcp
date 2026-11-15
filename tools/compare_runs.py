"""Compare two pipeline outputs: integers, strings and structure must match exactly, floats to 1e-6.
Usage: python tools/compare_runs.py committed.json fresh.json"""
import json
import math
import sys


def diff(a, b, path="$", out=None):
    out = [] if out is None else out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f"{path}.{k}: present on one side only")
            else:
                diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} vs {len(b)}")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                diff(x, y, f"{path}[{i}]", out)
    elif isinstance(a, float) or isinstance(b, float):
        if not (isinstance(a, (int, float)) and isinstance(b, (int, float)) and math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9)):
            out.append(f"{path}: {a!r} vs {b!r}")
    elif a != b:
        out.append(f"{path}: {a!r} vs {b!r}")
    return out


if __name__ == "__main__":
    d = diff(json.load(open(sys.argv[1])), json.load(open(sys.argv[2])))
    for line in d[:40]:
        print(line)
    print(f"{len(d)} difference(s)")
    sys.exit(1 if d else 0)
