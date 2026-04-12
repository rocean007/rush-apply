# Backend API — Auto Job Agent

Node.js + Express + TypeScript REST API with SQLite storage and AI integration.

## Setup

```bash
cd backend
cp .env.example .env
# Fill in .env values
npm install
npm run db:migrate   # Initialize database (auto-runs on start)
npm run dev          # Start dev server on :8080
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 8080) |
| `JWT_SECRET` | **Yes** | Secret for JWT signing |
| `DATABASE_URL` | No | SQLite path (default: ./data/jobs.db) |
| `ALLOWED_ORIGINS` | **Yes** | Comma-separated CORS origins |
| `INTERNAL_API_KEY` | **Yes** | Key for AI agent → backend calls |
| `POLLINATIONS_API_URL` | No | AI API URL (default: Pollinations) |
| `GROQ_API_KEY` | No | Groq fallback API key |

## API Endpoints

### Auth

```bash
# Register
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123","fullName":"John Doe"}'

# Login
curl -X POST http://localhost:8080/api/auth/login \
  -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123","rememberMe":false}'

# Logout
curl -X POST http://localhost:8080/api/auth/logout -b cookies.txt
```

### Jobs

```bash
# List jobs (paginated)
curl "http://localhost:8080/api/jobs?page=1&limit=20&search=react&source=remoteok"

# Apply to a job (auth required)
curl -X POST http://localhost:8080/api/jobs/apply/JOB_ID \
  -b cookies.txt
```

### User

```bash
# Get profile
curl http://localhost:8080/api/user/profile -b cookies.txt

# Update profile
curl -X PUT http://localhost:8080/api/user/profile \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"title":"Senior Developer","skills":["React","TypeScript","Node.js"]}'

# Generate AI resume
curl -X POST http://localhost:8080/api/user/resume/generate \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"jobDescription":"We are looking for a React developer..."}'

# List applications
curl http://localhost:8080/api/user/applications -b cookies.txt
```

## Database Migration

Schema is auto-applied on startup. Manual run:
```bash
npm run db:migrate
```

## Security Features

- JWT in HTTP-only cookies
- CORS whitelist
- Rate limiting: 100 req/15min per IP
- Helmet.js security headers
- Input sanitization via express-validator
- bcrypt password hashing (12 rounds)
