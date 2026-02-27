# LAZR Discrepancy Agent — TODO

- [x] Install pg driver and configure PostgreSQL AWS RDS connection
- [x] Add DB_* environment variables — .env.template provided for user to fill
- [x] Create server/pgDb.ts — raw PostgreSQL client (pg) for AWS RDS
- [x] Create server/routers/discrepancy.ts — tRPC procedures: getStats, getCustomers, chat
- [x] Wire discrepancy router into server/routers.ts
- [x] Build client/src/pages/Dashboard.tsx — KPI cards + discrepancy table + AI chat
- [x] Apply dark theme (JetBrains Mono, dark blue bg, cyan accents) in index.css
- [x] Update App.tsx to route to Dashboard
- [x] Auto-refresh: node-cron daily job at 6AM UTC + 5min frontend polling
- [x] Write vitest tests for discrepancy procedures (6/6 passing)
- [x] Create .env.template file with fictitious credentials
- [x] Create vercel.json deployment config
- [x] Final checkpoint and delivery
