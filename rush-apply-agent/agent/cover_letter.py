"""Cover Letter Generator skill."""
from __future__ import annotations

import logging
from .ai_engine import AIEngine
from .models import Job, UserProfile

log = logging.getLogger("rush.cover_letter")


class CoverLetterGenerator:
    def __init__(self, ai: AIEngine):
        self.ai = ai

    async def generate(self, user: UserProfile, job: Job) -> str:
        letter = await self.ai.generate_cover_letter(user, job)
        if not letter:
            # Fallback template
            skills_str = ", ".join(user.skills[:5])
            letter = (
                f"Dear Hiring Manager,\n\n"
                f"I am writing to express my interest in the {job.title} position at {job.company}. "
                f"As an experienced {user.title} with expertise in {skills_str}, "
                f"I am confident I can make a significant contribution to your team.\n\n"
                f"Throughout my career I have developed strong skills that align well with the "
                f"requirements of this role. I am particularly excited about this opportunity at "
                f"{job.company} and look forward to discussing how I can contribute.\n\n"
                f"Thank you for considering my application.\n\n"
                f"Sincerely,\n{user.full_name}\n{user.email}\n{user.phone}"
            )
        return letter
