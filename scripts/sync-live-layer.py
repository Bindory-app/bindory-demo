#!/usr/bin/env python3
"""Sync wireframe/live.html into the checked-in wireframe. Use --check in CI."""
import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    folder = Path(__file__).resolve().parents[1] / "wireframe"
    app = folder / "app.html"
    html, live = app.read_bytes(), (folder / "live.html").read_bytes()
    start = b"<!-- Bindory demo: connect the wireframe to the real backend,"
    end = b"\n})();\n</script>\n"
    if not live.startswith(start) or not live.endswith(end) or live.count(end) != 1:
        parser.exit(1, "live.html boundaries changed; update the sync script\n")
    if html.count(start) != 1:
        parser.exit(1, "expected exactly one embedded live layer in app.html\n")
    before, _, tail = html.partition(start)
    if tail.count(end) != 1:
        parser.exit(1, "expected exactly one end of the embedded live layer\n")
    embedded, _, after = tail.partition(end)
    if start + embedded + end == live:
        print("Live layer is in sync.")
    elif args.check:
        parser.exit(1, "Embedded live layer is stale; run scripts/sync-live-layer.py\n")
    else:
        app.write_bytes(before + live + after)
        print("Updated the embedded live layer.")


if __name__ == "__main__":
    main()
