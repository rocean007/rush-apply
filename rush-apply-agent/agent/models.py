"""Shared data models for RushApply Agent."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class UserProfile:
    id: str
    email: str
    full_name: str
    title: str = ""
    phone: str = ""
    location: str = ""
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""
    summary: str = ""
    skills: list[str] = field(default_factory=list)
    experience: list[dict] = field(default_factory=list)   # [{role, company, start, end, bullets}]
    education: list[dict] = field(default_factory=list)    # [{degree, institution, year}]
    certifications: list[str] = field(default_factory=list)
    resume_text: str = ""


@dataclass
class Job:
    id: str
    title: str
    company: str
    url: str
    description: str = ""
    location: str = ""
    salary: str = ""
    tags: list[str] = field(default_factory=list)
    source: str = ""


@dataclass
class ApplicationResult:
    job_id: str
    success: bool
    message: str
    cv_path: str = ""
    cl_path: str = ""
    duration_s: float = 0.0
