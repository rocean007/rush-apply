"""
PDF Maker — professional CV and cover letter PDF generation.
Uses ReportLab (pure Python, no system deps).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .models import Job, UserProfile

log = logging.getLogger("rush.pdf_maker")

# ── Brand palette ────────────────────────────────────────
DARK    = colors.HexColor("#1a1a2e")
ACCENT  = colors.HexColor("#0f3460")
LIGHT   = colors.HexColor("#16213e")
SUBTLE  = colors.HexColor("#e94560")
GREY    = colors.HexColor("#6b7280")
WHITE   = colors.white
PAGE_W, PAGE_H = A4


class PDFMaker:
    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

    # ──────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────

    async def build_cv(self, user: UserProfile, job: Job, cv_text: str) -> Path:
        safe_company = re.sub(r"[^\w]", "_", job.company)[:20]
        filename = f"CV_{user.full_name.replace(' ', '_')}_{safe_company}.pdf"
        path = self.output_dir / filename
        self._render_cv(user, job, cv_text, path)
        log.info("  CV PDF → %s", path)
        return path

    async def build_cover_letter(self, user: UserProfile, job: Job, text: str) -> Path:
        safe_company = re.sub(r"[^\w]", "_", job.company)[:20]
        filename = f"CoverLetter_{user.full_name.replace(' ', '_')}_{safe_company}.pdf"
        path = self.output_dir / filename
        self._render_cover_letter(user, job, text, path)
        log.info("  Cover Letter PDF → %s", path)
        return path

    # ──────────────────────────────────────────
    # CV renderer
    # ──────────────────────────────────────────

    def _render_cv(self, user: UserProfile, job: Job, cv_text: str, path: Path):
        doc = SimpleDocTemplate(
            str(path), pagesize=A4,
            leftMargin=1.5*cm, rightMargin=1.5*cm,
            topMargin=1.5*cm, bottomMargin=1.5*cm,
        )

        styles = self._build_styles()
        story = []

        # ── Header block ──────────────────────
        story.append(Paragraph(user.full_name.upper(), styles["name"]))
        story.append(Paragraph(user.title, styles["title_line"]))

        contact_parts = [x for x in [user.email, user.phone, user.location] if x]
        story.append(Paragraph("  |  ".join(contact_parts), styles["contact"]))

        links = []
        if user.linkedin: links.append(f"<link href='{user.linkedin}'>LinkedIn</link>")
        if user.github:   links.append(f"<link href='{user.github}'>GitHub</link>")
        if user.portfolio: links.append(f"<link href='{user.portfolio}'>Portfolio</link>")
        if links:
            story.append(Paragraph("  ·  ".join(links), styles["contact"]))

        story.append(HRFlowable(width="100%", thickness=2, color=ACCENT, spaceAfter=4))

        # ── Parse cv_text sections ─────────────
        sections = self._parse_cv_sections(cv_text)

        for section_name, content_lines in sections.items():
            story.append(Spacer(1, 4*mm))
            story.append(Paragraph(section_name, styles["section_head"]))
            story.append(HRFlowable(width="100%", thickness=0.5, color=GREY, spaceBefore=1, spaceAfter=3))

            for line in content_lines:
                line = line.strip()
                if not line:
                    story.append(Spacer(1, 2*mm))
                elif line.startswith("•") or line.startswith("✓") or line.startswith("  •"):
                    story.append(Paragraph(line.lstrip(), styles["bullet"]))
                elif "|" in line and "(" in line:
                    # Experience title line
                    story.append(Paragraph(line, styles["exp_title"]))
                else:
                    story.append(Paragraph(line, styles["body"]))

        doc.build(story)

    # ──────────────────────────────────────────
    # Cover letter renderer
    # ──────────────────────────────────────────

    def _render_cover_letter(self, user: UserProfile, job: Job, text: str, path: Path):
        doc = SimpleDocTemplate(
            str(path), pagesize=A4,
            leftMargin=2*cm, rightMargin=2*cm,
            topMargin=2*cm, bottomMargin=2*cm,
        )

        styles = self._build_styles()
        story = []

        # Header
        story.append(Paragraph(user.full_name.upper(), styles["name"]))
        story.append(Paragraph(user.title, styles["title_line"]))
        contact_parts = [x for x in [user.email, user.phone, user.location] if x]
        story.append(Paragraph("  |  ".join(contact_parts), styles["contact"]))
        story.append(HRFlowable(width="100%", thickness=2, color=ACCENT, spaceAfter=8))

        # Date + To block
        story.append(Spacer(1, 4*mm))
        story.append(Paragraph(datetime.now().strftime("%B %d, %Y"), styles["body"]))
        story.append(Spacer(1, 3*mm))
        story.append(Paragraph(f"Hiring Manager<br/>{job.company}", styles["body"]))
        story.append(Spacer(1, 6*mm))
        story.append(Paragraph(f"Re: Application for {job.title}", styles["exp_title"]))
        story.append(HRFlowable(width="100%", thickness=0.5, color=GREY, spaceBefore=2, spaceAfter=6))

        # Body paragraphs
        for para in text.split("\n\n"):
            para = para.strip()
            if para:
                story.append(Paragraph(para, styles["cl_body"]))
                story.append(Spacer(1, 4*mm))

        doc.build(story)

    # ──────────────────────────────────────────
    # Helpers
    # ──────────────────────────────────────────

    def _parse_cv_sections(self, cv_text: str) -> dict[str, list[str]]:
        """Split CV text into {SECTION_NAME: [lines]}."""
        sections: dict[str, list[str]] = {}
        current_section = "PROFILE"
        sections[current_section] = []

        KNOWN_SECTIONS = {
            "PROFESSIONAL SUMMARY", "KEY SKILLS", "SKILLS",
            "EXPERIENCE", "WORK EXPERIENCE", "EDUCATION",
            "CERTIFICATIONS", "KEY ACHIEVEMENTS", "ACHIEVEMENTS", "PROJECTS",
        }

        for line in cv_text.split("\n"):
            stripped = line.strip()
            if stripped.upper() in KNOWN_SECTIONS:
                current_section = stripped.upper()
                sections.setdefault(current_section, [])
            elif stripped.startswith("─") or stripped == "":
                if current_section in sections:
                    sections[current_section].append("")
            else:
                # Skip header lines (name, email etc.) — already in PDF header
                if current_section == "PROFILE" and ("@" in stripped or stripped == stripped.upper()):
                    continue
                sections.setdefault(current_section, []).append(stripped)

        # Remove PROFILE section if empty or just noise
        if not any(sections.get("PROFILE", [])):
            sections.pop("PROFILE", None)

        return {k: v for k, v in sections.items() if any(l.strip() for l in v)}

    def _build_styles(self) -> dict[str, ParagraphStyle]:
        base = getSampleStyleSheet()
        return {
            "name": ParagraphStyle(
                "name", fontSize=22, textColor=DARK, fontName="Helvetica-Bold",
                alignment=TA_CENTER, spaceAfter=2,
            ),
            "title_line": ParagraphStyle(
                "title_line", fontSize=11, textColor=ACCENT, fontName="Helvetica",
                alignment=TA_CENTER, spaceAfter=2,
            ),
            "contact": ParagraphStyle(
                "contact", fontSize=9, textColor=GREY, fontName="Helvetica",
                alignment=TA_CENTER, spaceAfter=2,
            ),
            "section_head": ParagraphStyle(
                "section_head", fontSize=11, textColor=ACCENT, fontName="Helvetica-Bold",
                spaceBefore=4, spaceAfter=2, letterSpacing=1,
            ),
            "exp_title": ParagraphStyle(
                "exp_title", fontSize=10, textColor=DARK, fontName="Helvetica-Bold",
                spaceBefore=3, spaceAfter=1,
            ),
            "body": ParagraphStyle(
                "body", fontSize=9.5, textColor=DARK, fontName="Helvetica",
                spaceAfter=2, leading=14,
            ),
            "bullet": ParagraphStyle(
                "bullet", fontSize=9.5, textColor=DARK, fontName="Helvetica",
                spaceAfter=2, leftIndent=12, leading=13,
            ),
            "cl_body": ParagraphStyle(
                "cl_body", fontSize=10.5, textColor=DARK, fontName="Helvetica",
                leading=16, spaceAfter=4,
            ),
        }
