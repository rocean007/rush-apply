# Frontend — Auto Job Agent

React 18 + TypeScript + Vite + TailwindCSS with glassmorphism design.

## Setup

```bash
cd frontend
cp .env.example .env
npm install
npm run dev        # Start dev server on :3000
npm run build      # Production build → dist/
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend API base URL (empty = same origin) |
| `VITE_APP_NAME` | App display name |

## Component Architecture

```
src/
├── components/
│   ├── layout/
│   │   ├── Layout.tsx        # Root layout with Outlet
│   │   └── Navbar.tsx        # Sticky nav with auth toggle
│   ├── features/
│   │   ├── AuthModal.tsx     # Slide-in auth panel (Zod validation)
│   │   └── JobCard.tsx       # Job listing with apply action
│   └── ui/
│       ├── Skeletons.tsx     # Shimmer skeleton loaders
│       ├── CookieBanner.tsx  # GDPR consent
│       ├── ErrorBoundary.tsx # React error boundary
│       └── FullPageLoader.tsx
├── pages/
│   ├── Landing.tsx           # Job search + listings
│   ├── Dashboard.tsx         # Application tracker
│   └── ResumeBuilder.tsx     # AI resume generator
├── store/
│   └── index.ts              # Zustand stores (auth, jobs, app)
├── utils/
│   ├── api.ts                # Typed fetch wrapper with retry
│   └── cache.ts              # IndexedDB caching
├── workers/
│   └── resumeParser.worker.ts  # Off-thread resume parsing
└── types/
    └── index.ts              # Shared TypeScript interfaces
```

## State Management (Zustand)

Three stores with persist middleware:
- `useAuthStore` — user session, login/register/logout
- `useJobStore` — job listings, search, pagination, apply
- `useAppStore` — theme, cookie consent, applications list

## Key Features

- **Glassmorphism UI** — backdrop blur, translucent cards, noise texture
- **Dark/light mode** — system preference + manual toggle, persisted
- **Skeleton loaders** — all async content has shimmer placeholders
- **Code splitting** — all pages lazy-loaded via React.lazy
- **Framer Motion** — staggered list animations, modal slide-in
- **Zod validation** — auth forms fully validated client-side
- **IndexedDB cache** — offline job listings via idb library
- **Web Worker** — resume text parsing off main thread
- **Error boundary** — catches render errors gracefully
- **GDPR banner** — functional cookies only, consent persisted

## Vercel Deployment

```bash
npm run build
# Deploy dist/ to Vercel static
# API rewrites in root vercel.json
```
