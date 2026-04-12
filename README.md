# Auto Job Apply AI Agent

Automated job application platform with AI-powered resume tailoring, browser automation, and real-time application tracking.

## Architecture

```
auto-job-agent/
├── frontend/          React 18 + TypeScript + Vite + TailwindCSS
├── backend/           Node.js + Express + TypeScript
├── ai-agent/          Python + Playwright + NVIDIA CUDA
├── vercel.json        Deployment config
└── package.json       Root workspace
```

## Quick Start

```bash
# Install all workspaces
npm install

# Start all services (dev)
npm run dev
```

## Services

| Service  | Port | Tech |
|----------|------|------|
| Frontend | 3000 | Vite dev server |
| Backend  | 8080 | Express + TS |
| AI Agent | —    | Python daemon |

## Environment Setup

Copy `.env.example` to `.env` in each subdirectory and fill in values.

## Deployment

Frontend + Backend deploy to Vercel via `vercel.json`.  
AI Agent runs on a CUDA-enabled server (Docker or systemd).
