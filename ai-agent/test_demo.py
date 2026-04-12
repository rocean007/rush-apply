#!/usr/bin/env python3
"""
Demo mode - runs without backend
"""
import asyncio
import logging
from apply_agent import JobApplicationAgent, BackendClient, UserProfile, Job

logging.basicConfig(level=logging.INFO)

# Mock client for demo
class DemoClient:
    def __init__(self):
        self.user_id = "demo123"
    
    def login(self, email, password):
        print(f"✅ Demo login: {email}")
        return True
    
    def get_profile(self):
        return UserProfile(
            id="demo123",
            email="demo@example.com",
            full_name="Demo User",
            title="Software Engineer",
            skills=["Python", "JavaScript", "React", "Node.js", "SQL"],
            resume_text="Experienced developer..."
        )
    
    def get_jobs(self, limit=5):
        return [
            Job(
                id="1",
                title="Senior Python Developer",
                company="Tech Corp",
                url="https://example.com/job1",
                description="Looking for Python expert with 5+ years experience..."
            ),
            Job(
                id="2",
                title="Full Stack Engineer",
                company="Startup Inc",
                url="https://example.com/job2",
                description="React and Node.js developer needed..."
            )
        ][:limit]
    
    def record_application(self, job_id, status, notes=""):
        print(f"📝 Recorded: Job {job_id} -> {status}")
        return True

async def demo_run():
    print("=" * 60)
    print("🤖 JOB APPLICATION AGENT - DEMO MODE")
    print("=" * 60)
    print("⚠️  This is a demonstration - no actual applications will be submitted")
    print("⚠️  Using mock data instead of real backend")
    print()
    
    # Create mock client and user
    mock_client = DemoClient()
    mock_user = mock_client.get_profile()
    
    # Create agent with visible browser
    from apply_agent import JobApplicationAgent
    agent = JobApplicationAgent(mock_client, mock_user, headless=False)
    
    # Run with 2 demo jobs
    await agent.run(jobs_limit=2)
    
    print("\n✨ Demo complete!")
    print("💡 To use with real backend, set BACKEND_URL and INTERNAL_API_KEY in .env")

if __name__ == "__main__":
    asyncio.run(demo_run())
