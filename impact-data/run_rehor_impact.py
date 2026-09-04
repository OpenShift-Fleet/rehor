#!/usr/bin/env python3
"""Run complete Rehor impact collection and report generation."""

import argparse
import sys
from pathlib import Path

import analyze_rehor_tasks
import collect_rehor_impact
import generate_rehor_report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default="impact-data/runs")
    parser.add_argument("--app-interface", default=str(Path.home() / "insights/app-interface"))
    parser.add_argument("--memory-api")
    parser.add_argument("--jira-filter", default="107017")
    parser.add_argument("--skip-cycles", action="store_true")
    parser.add_argument("--no-clone-config-repos", action="store_true")
    args = parser.parse_args()

    collector_args = [
        "collect_rehor_impact.py",
        "--output-dir",
        args.output_dir,
        "--app-interface",
        args.app_interface,
        "--jira-filter",
        args.jira_filter,
    ]
    if args.memory_api:
        collector_args.extend(["--memory-api", args.memory_api])
    if args.skip_cycles:
        collector_args.append("--skip-cycles")
    if args.no_clone_config_repos:
        collector_args.append("--no-clone-config-repos")
    old_argv = sys.argv
    try:
        print("[1/3] Collecting Jira, Rehor API, GitHub, GitLab, app-interface", flush=True)
        sys.argv = collector_args
        collect_rehor_impact.main()
        run_dirs = sorted(Path(args.output_dir).glob("20*"))
        if not run_dirs:
            raise RuntimeError("collector produced no run directory")
        run = run_dirs[-1]
        print(f"[2/3] Analyzing task artifacts: {run}", flush=True)
        sys.argv = ["analyze_rehor_tasks.py", "--output-dir", str(run)]
        if args.memory_api:
            sys.argv.extend(["--api", args.memory_api])
        analyze_rehor_tasks.main()
        print(f"[3/3] Generating Markdown report: {run}", flush=True)
        sys.argv = ["generate_rehor_report.py", str(run)]
        generate_rehor_report.main()
        print(f"Complete: {run}", flush=True)
    finally:
        sys.argv = old_argv


if __name__ == "__main__":
    main()
