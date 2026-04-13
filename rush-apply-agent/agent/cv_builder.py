"""CV Builder — generates tailored CV content per job."""
from __future__ import annotations

import logging
from pathlib import Path

from .ai_engine import AIEngine
from .models import Job, UserProfile

log = logging.getLogger("rush.cv_builder")


class CVBuilder:
    def __init__(self, ai: AIEngine, output_dir: Path):
        self.ai = ai
        self.output_dir = output_dir

    async def generate(self, user: UserProfile, job: Job) -> str:
        """Return plain-text CV tailored for job. Used by PDFMaker."""
        ai_data = await self.ai.generate_cv_content(user, job)

        summary = ai_data.get("summary") or user.summary or (
            f"Experienced {user.title} with expertise in {', '.join(user.skills[:4])}."
        )
        skills_highlight = ai_data.get("skills_highlight") or user.skills[:8]
        exp_bullets = ai_data.get("experience_bullets", {})
        achievements = ai_data.get("key_achievements", [])

        lines = [
            f"{user.full_name.upper()}",
            f"{user.title}",
            f"{user.email} | {user.phone} | {user.location}",
        ]
        if user.linkedin:
            lines.append(f"LinkedIn: {user.linkedin}")
        if user.github:
            lines.append(f"GitHub: {user.github}")
        if user.portfolio:
            lines.append(f"Portfolio: {user.portfolio}")

        lines += [
            "",
            "PROFESSIONAL SUMMARY",
            "─" * 40,
            summary,
            "",
            "KEY SKILLS",
            "─" * 40,
        ]
        for i in range(0, len(skills_highlight), 3):
            lines.append("  •  ".join(skills_highlight[i:i+3]))

        if user.experience:
            lines += ["", "EXPERIENCE", "─" * 40]
            for exp in user.experience[:5]:
                company = exp.get("company", "")
                role = exp.get("role", "")
                start = exp.get("start", "")
                end = exp.get("end", "Present")
                lines.append(f"{role} | {company}  ({start} – {end})")
                bullets = exp_bullets.get(company) or exp.get("bullets", [])
                for b in bullets[:4]:
                    lines.append(f"  • {b}")
                lines.append("")

        if achievements:
            lines += ["KEY ACHIEVEMENTS", "─" * 40]
            for a in achievements:
                lines.append(f"  ✓ {a}")
            lines.append("")

        if user.education:
            lines += ["EDUCATION", "─" * 40]
            for edu in user.education:
                degree = edu.get("degree", "")
                institution = edu.get("institution", "")
                year = edu.get("year", "")
                lines.append(f"{degree} — {institution} ({year})")
            lines.append("")

        if user.certifications:
            lines += ["CERTIFICATIONS", "─" * 40]
            for cert in user.certifications:
                lines.append(f"  • {cert}")

        return "\n".join(lines)
