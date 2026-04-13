#!/usr/bin/env python3
"""
RushApply AI Agent — Orchestrator
Autonomous job application engine: CV generation, cover letters, PDF creation, form filling.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from playwright.async_api import BrowserContext, Page, async_playwright

from .ai_engine import AIEngine
from .cv_builder import CVBuilder
from .cover_letter import CoverLetterGenerator
from .pdf_maker import PDFMaker
from .backend_client import BackendClient
from .models import ApplicationResult, Job, UserProfile

load_dotenv()
log = logging.getLogger("rush.orchestrator")


class JobApplicationAgent:
    """
    Autonomous agent that:
    1. Fetches jobs from RushApply portal
    2. Generates tailored CV + cover letter per job
    3. Produces PDFs
    4. Navigates to job URL and fills/submits the application form
    5. Records results back to backend
    """

    def __init__(
        self,
        client: BackendClient,
        user: UserProfile,
        ai: AIEngine,
        headless: bool = True,
        dry_run: bool = False,
        output_dir: Path = Path("output"),
    ):
        self.client = client
        self.user = user
        self.ai = ai
        self.headless = headless
        self.dry_run = dry_run
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.cv_builder = CVBuilder(ai, output_dir)
        self.cl_gen = CoverLetterGenerator(ai)
        self.pdf_maker = PDFMaker(output_dir)
        self.results: list[ApplicationResult] = []

    # ──────────────────────────────────────────
    # Main entry
    # ──────────────────────────────────────────

    async def run(self, jobs_limit: int = 10) -> list[ApplicationResult]:
        jobs = self.client.get_pending_jobs(limit=jobs_limit)
        if not jobs:
            log.warning("No pending jobs found in RushApply portal.")
            return []

        log.info("🚀 Processing %d jobs for %s", len(jobs), self.user.full_name)

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=self.headless,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 900},
                accept_downloads=True,
            )

            for job in jobs:
                result = await self._process_one(job, context)
                self.results.append(result)
                self._log_result(result, job)
                await asyncio.sleep(2)

            await browser.close()

        self._print_summary()
        self._write_report()
        return self.results

    # ──────────────────────────────────────────
    # Per-job pipeline
    # ──────────────────────────────────────────

    async def _process_one(self, job: Job, context: BrowserContext) -> ApplicationResult:
        t0 = time.time()
        log.info("─── [%s] %s @ %s", job.id, job.title, job.company)

        try:
            # 1. Generate tailored CV text
            cv_text = await self.cv_builder.generate(self.user, job)

            # 2. Generate cover letter
            cover_letter = await self.cl_gen.generate(self.user, job)

            # 3. Build PDFs
            cv_path = await self.pdf_maker.build_cv(self.user, job, cv_text)
            cl_path = await self.pdf_maker.build_cover_letter(self.user, job, cover_letter)

            if self.dry_run:
                log.info("  DRY RUN — skipping browser, PDFs saved: %s | %s", cv_path, cl_path)
                self.client.record_application(job.id, "dry_run", f"CV: {cv_path}, CL: {cl_path}")
                return ApplicationResult(
                    job_id=job.id, success=True,
                    message="Dry run — PDFs generated",
                    cv_path=str(cv_path), cl_path=str(cl_path),
                    duration_s=round(time.time() - t0, 2),
                )

            # 4. Navigate and fill application form
            page = await context.new_page()
            try:
                filled = await self._fill_application(page, job, cv_path, cl_path, cover_letter)
            finally:
                await page.close()

            status = "applied" if filled else "form_not_found"
            self.client.record_application(
                job.id, status,
                notes=f"Agent | CV={cv_path.name} | CL={cl_path.name} | filled={filled}",
            )

            return ApplicationResult(
                job_id=job.id, success=filled,
                message="Application submitted" if filled else "Form not found / manual review needed",
                cv_path=str(cv_path), cl_path=str(cl_path),
                duration_s=round(time.time() - t0, 2),
            )

        except Exception as exc:
            log.exception("Error on job %s: %s", job.id, exc)
            self.client.record_application(job.id, "error", str(exc))
            return ApplicationResult(
                job_id=job.id, success=False, message=str(exc),
                duration_s=round(time.time() - t0, 2),
            )

    # ──────────────────────────────────────────
    # Browser / form filling
    # ──────────────────────────────────────────

    async def _fill_application(
        self,
        page: Page,
        job: Job,
        cv_path: Path,
        cl_path: Path,
        cover_letter: str,
    ) -> bool:
        await page.goto(job.url, timeout=25_000, wait_until="domcontentloaded")

        try:
            await page.wait_for_load_state("networkidle", timeout=10_000)
        except Exception:
            pass

        # Detect all visible form inputs
        raw_fields = await page.evaluate("""() => {
            const inputs = Array.from(document.querySelectorAll(
                'input[type=text], input[type=email], input[type=tel], ' +
                'input[type=url], input[type=number], textarea, select'
            ));
            return inputs.map(el => ({
                tag:         el.tagName.toLowerCase(),
                type:        el.type || '',
                name:        el.name || '',
                id:          el.id || '',
                placeholder: el.placeholder || '',
                ariaLabel:   el.getAttribute('aria-label') || '',
                label:       (document.querySelector(`label[for="${el.id}"]`) || {}).innerText || '',
            }));
        }""")

        if not raw_fields:
            log.info("  No form fields found.")
            return False

        # Build a clean label→value map via AI
        field_descriptions = [
            f"{i}: name={f['name']} id={f['id']} placeholder={f['placeholder']} label={f['label']} aria={f['ariaLabel']}"
            for i, f in enumerate(raw_fields)
        ]
        answers = await self.ai.generate_form_answers(self.user, job, field_descriptions, cover_letter)

        filled = 0
        for i, f in enumerate(raw_fields):
            key = str(i)
            val = answers.get(key) or answers.get(f["name"]) or answers.get(f["id"])
            if not val:
                continue

            selector = (
                f"[name='{f['name']}']" if f["name"]
                else f"#{f['id']}" if f["id"]
                else None
            )
            if not selector:
                continue

            try:
                if f["tag"] == "select":
                    await page.select_option(selector, label=str(val))
                else:
                    await page.fill(selector, str(val))
                filled += 1
            except Exception:
                pass

        # Upload CV if file input exists
        file_inputs = await page.query_selector_all("input[type=file]")
        for fi in file_inputs:
            label_text = await page.evaluate(
                "(el) => (document.querySelector(`label[for='${el.id}']`) || {}).innerText || ''", fi
            )
            path_to_upload = cv_path
            if "cover" in label_text.lower():
                path_to_upload = cl_path
            try:
                await fi.set_input_files(str(path_to_upload))
                log.info("  Uploaded %s", path_to_upload.name)
            except Exception as e:
                log.warning("  File upload failed: %s", e)

        log.info("  Filled %d/%d fields", filled, len(raw_fields))

        # Submit
        if filled > 0:
            submitted = await self._try_submit(page)
            return submitted

        return False

    async def _try_submit(self, page: Page) -> bool:
        submit_selectors = [
            "button[type=submit]",
            "input[type=submit]",
            "button:has-text('Submit')",
            "button:has-text('Apply')",
            "button:has-text('Send Application')",
            "[data-testid*='submit']",
        ]
        for sel in submit_selectors:
            try:
                btn = await page.query_selector(sel)
                if btn:
                    await btn.click()
                    await page.wait_for_load_state("networkidle", timeout=8_000)
                    log.info("  ✓ Submitted via: %s", sel)
                    return True
            except Exception:
                pass
        log.warning("  Could not find submit button — manual review needed")
        return False

    # ──────────────────────────────────────────
    # Reporting
    # ──────────────────────────────────────────

    def _log_result(self, r: ApplicationResult, job: Job):
        icon = "✓" if r.success else "✗"
        log.info("[%s] %s @ %s — %s (%.1fs)", icon, job.title, job.company, r.message, r.duration_s)

    def _print_summary(self):
        total = len(self.results)
        ok = sum(1 for r in self.results if r.success)
        avg = sum(r.duration_s for r in self.results) / max(total, 1)
        print(f"\n{'═'*50}")
        print(f"  RushApply Agent Summary")
        print(f"  Applied : {ok}/{total}")
        print(f"  Failed  : {total - ok}/{total}")
        print(f"  Avg time: {avg:.1f}s/job")
        print(f"{'═'*50}\n")

    def _write_report(self):
        report = [
            {
                "job_id": r.job_id,
                "success": r.success,
                "message": r.message,
                "cv_path": r.cv_path,
                "cl_path": r.cl_path,
                "duration_s": r.duration_s,
            }
            for r in self.results
        ]
        path = self.output_dir / "run_report.json"
        path.write_text(json.dumps(report, indent=2))
        log.info("Report saved: %s", path)
