# Generos CRM

Internal customer-relationship system for Generos (kids products: milk, snacks, apparel).
Handles customer segmentation (RFM), cohort analysis, promo strategy, follow-up tasks, and an AI assistant (Deepseek).

**One deploy serves both the API and the web UI.**

---

## What's Built & Tested

Verified end-to-end against a real PostgreSQL database:

| Module | Status | Notes |
|--------|--------|-------|
| Auth (JWT + roles) | TESTED | login -> token -> role-gated routes |
| CSV/Excel upload | TESTED | phone validation, dedup, error reporting |
| RFM scoring | TESTED | configurable thresholds (IDR defaults) |
| Cohort generation + metrics | TESTED | repeat rate, LTV, churn, 30/60/90 retention |
| Segment auto-assignment | TESTED | priority-based conflict resolution + audit log |
| Promo strategies + coupons | TESTED | auto coupon codes, budget tracking |
| Follow-up task generation | TESTED | per-segment, approval gating |
| Redemption + ROI | TESTED | discount math, ROI calculation |
| Nightly pipeline job | TESTED | RFM -> cohort -> segment in one run |
| Web frontend | COMPILES + SERVED | login, dashboard, all tabs, connected to API |
| Message delivery | STUB | console adapter - needs a real provider (see below) |

### The one stub: message delivery
`src/services/deliveryService.js` ships with a console adapter that logs messages instead of sending them. To actually send email/SMS/WhatsApp you must plug in a provider (Twilio, SendGrid, or an Indonesian WhatsApp gateway like Wablas/Qontak) and add its keys. The interface is built; the provider connection is not, because it needs your accounts. This is the only piece not wired to something real.

---

## Stack
- Backend: Node.js 20+ (ES Modules), Express
- Database: PostgreSQL (uses built-in gen_random_uuid(), no extensions)
- Auth: JWT + bcryptjs (pure JS, no native build)
- AI: Deepseek API
- Frontend: Single HTML file, React + Tailwind via CDN (no build step)
- Host: Railway

---

## Project Structure
```
generos-crm/
├── public/
│   └── index.html          # Full frontend (React via CDN, connected to API)
├── src/
│   ├── server.js           # Express app - all routes + serves frontend
│   ├── db/
│   │   ├── pool.js         # Postgres pool
│   │   ├── schema.sql      # Full schema (12 tables)
│   │   ├── migrate.js      # Run schema
│   │   └── seed.js         # Admin user + default segments
│   ├── middleware/
│   │   └── auth.js         # JWT + role checks + job-key auth
│   └── services/
│       ├── rfmService.js       # RFM scoring (configurable)
│       ├── cohortService.js    # Cohort gen + metrics
│       ├── segmentService.js   # Rule-based assignment
│       ├── promoService.js     # Coupons, tasks, ROI
│       ├── deliveryService.js  # Message delivery (STUB adapter)
│       ├── uploadService.js    # CSV/Excel parse + validate
│       └── deepseekService.js  # AI chat
├── .github/workflows/
│   └── rfm-cron.yml        # Daily pipeline trigger
├── railway.json
├── package.json
└── .env.example
```

---

## Deploy to Railway

### 1. Push to GitHub
```
git init && git add . && git commit -m "Generos CRM"
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Create Railway project
railway.app -> New Project -> Deploy from GitHub repo -> select your repo. Railway auto-detects Node via Nixpacks.

### 3. Add PostgreSQL
Project -> New -> Database -> PostgreSQL. Railway auto-injects DATABASE_URL - no manual config.

### 4. Set environment variables
Railway -> service -> Variables:
```
JWT_SECRET=<long-random-string>
JOB_SECRET_KEY=<another-long-random-string>
DEEPSEEK_API_KEY=<your-deepseek-key>
NODE_ENV=production
MAX_DISCOUNT_PCT=50
CHURN_THRESHOLD_DAYS=90
RFM_RECENCY_DAYS=15,30,60,90
RFM_FREQUENCY=5,3,2,1
RFM_MONETARY=2000000,1000000,500000,150000
SEED_ADMIN_EMAIL=admin@generos.com
SEED_ADMIN_PASSWORD=<your-admin-password>
```
(DATABASE_URL and PORT are provided by Railway automatically.)

### 5. Initialize the database
After first deploy, run once via Railway shell (or locally pointed at the Railway DB):
```
npm run migrate   # create tables
npm run seed      # create admin user + 6 default segments
```

### 6. Set up the daily pipeline (GitHub Actions)
Railway's native cron is limited, so the nightly RFM->cohort->segment run is triggered by GitHub Actions:
- GitHub repo -> Settings -> Secrets -> Actions:
  - RAILWAY_APP_URL = your app URL (e.g. https://generos-crm.up.railway.app)
  - JOB_SECRET_KEY = same value as in Railway
- Runs daily 2 AM Jakarta time. Trigger manually anytime from the Actions tab.

### 7. Open the app
Visit your Railway URL. Log in with the seed admin credentials. Upload a CSV, then trigger the pipeline to assign segments.

---

## Local Development
```
cp .env.example .env     # fill in values; needs a local Postgres
npm install
npm run migrate
npm run seed
npm run dev              # http://localhost:3000
```

---

## CSV Format
```
phone_number,name,purchase_date,purchase_amount,product_category
08123456789,Budi,2026-06-01,250000,milk
```
- phone_number - accepts 08... or 62..., normalized to 62..., used as unique ID
- purchase_amount - in IDR
- Multiple rows per phone = multiple purchases (merged automatically)
- Optional columns: email, product_category, quantity, source

---

## Key Design Decisions
- Phone = unique ID - more stable than email in the Indonesian market
- RFM thresholds in IDR, configurable - defaults assume kids-product price points; adjust via env
- Priority-based segment conflicts - one segment per customer; lowest priority number wins
- Batch pipeline, not real-time - uploads are periodic, so daily recalculation is enough
- gen_random_uuid() + bcryptjs - zero native compilation, deploys clean on Railway
- Single-service deploy - Express serves both API and the static frontend

---

## Still To Do (if you extend it)
- Connect a real delivery provider (the only stub)
- A/B test execution (schema supports it; runner not built)
- External DB backup schedule (don't rely solely on Railway's)
- Frontend: customer detail panel, task management UI, promo builder (API is ready for all three)

See GENEROS_CRM_SPECIFICATION.md for the full original spec.
