#!/usr/bin/env python3
import asyncio
import sys
from unittest.mock import Mock

# Mock the requests module for testing without backend
import requests
requests.post = Mock(return_value=Mock(ok=True))
requests.get = Mock(return_value=Mock(ok=True, json=lambda: {"jobs": []}))

# Now import and run your agent
from apply_agent import main

# Run with test arguments
sys.argv = [
    "apply_agent.py",
    "--user-id", "test123",
    "--email", "test@example.com", 
    "--password", "test123",
    "--jobs-limit", "1",
    "--no-headless"
]

if __name__ == "__main__":
    main()
