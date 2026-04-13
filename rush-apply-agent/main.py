#!/usr/bin/env python3
"""
RushApply AI Agent — CLI Entry Point
=====================================
Autonomously applies to jobs from the RushApply portal.

Usage:
    python main.py --email you@example.com --password secret --jobs-limit 10
    python main.py --dry-run   # Generate PDFs only, skip browser
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("agent.log", mode="a"),
    ],
)
log = logging.getLogger("rush")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="RushApply AI Agent — autonomous job application engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py --email me@example.com --password secret
  python main.py --email me@example.com --password secret --jobs-limit 20 --no-headless
  python main.py --email me@example.com --password secret --dry-run
        """,
    )
    p.add_argument("--email",       required=True,  help="Your RushApply login email")
    p.add_argument("--password",    required=True,  help="Your RushApply login password")
    p.add_argument("--user-id",     default="",     help="User ID (optional, fetched automatically)")
    p.add_argument("--jobs-limit",  type=int, default=10, help="Max jobs to process (default: 10)")
    p.add_argument("--output-dir",  default="output",  help="Where to save PDFs (default: ./output)")
    p.add_argument("--dry-run",     action="store_true", help="Generate PDFs only, skip browser automation")
    p.add_argument("--headless",    action="store_true", default=True,  help="Run browser headless (default)")
    p.add_argument("--no-headless", dest="headless", action="store_false", help="Show browser window")
    p.add_argument("--backend-url", default=os.getenv("BACKEND_URL", "http://localhost:8080"),
                   help="RushApply backend URL")
    p.add_argument("--api-key",     default=os.getenv("INTERNAL_API_KEY", ""),
                   help="Internal API key")
    return p.parse_args()


async def run(args: argparse.Namespace):
    # Late imports so env is loaded first
    from agent.ai_engine import AIEngine
    from agent.backend_client import BackendClient
    from agent.orchestrator import JobApplicationAgent

    client = BackendClient(
        base_url=args.backend_url,
        api_key=args.api_key,
        user_id=args.user_id,
    )

    if not client.login(args.email, args.password):
        log.error("Authentication failed. Check credentials and backend URL.")
        sys.exit(1)

    user = client.get_profile()
    if not user:
        log.error("Could not fetch user profile.")
        sys.exit(1)

    log.info("Agent initialised for: %s (%s)", user.full_name, user.email)

    ai = AIEngine()

    agent = JobApplicationAgent(
        client=client,
        user=user,
        ai=ai,
        headless=args.headless,
        dry_run=args.dry_run,
        output_dir=Path(args.output_dir),
    )

    results = await agent.run(jobs_limit=args.jobs_limit)
    return results


def main():
    args = parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
