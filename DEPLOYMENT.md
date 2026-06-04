# Deployment

This project runs on **SQLite** locally (zero-setup beta) and on **PostgreSQL**
in Railway (production / review environments).

Prisma's datasource `provider` must be a literal (it cannot be switched via an
env var), and SQLite migrations are not valid PostgreSQL, so the two databases
use **two schema files with separate migration histories**:

| Target | Schema | Migrations | DATABASE_URL |
| --- | --- | --- | --- |
| Local beta | `prisma/schema.prisma` (sqlite) | `prisma/migrations/` | `file:./dev.db` |
| Railway | `prisma/production/schema.prisma` (postgresql) | `prisma/production/migrations/` | Postgres connection string |

`prisma/schema.prisma` is the **single source of truth** for the models. The
PostgreSQL schema is generated from it with `npm run prisma:sync-prod` — do not
edit `prisma/production/schema.prisma` by hand.

---

## Local development (unchanged)

```bash
npm install
# .env -> DATABASE_URL="file:./dev.db"
npx prisma migrate dev
npm run dev
```

Nothing about the local SQLite flow changed. The `prisma/production/` folder is
only used for Railway.

---

## Deploy to Railway

### 1. Create the project
1. Go to https://railway.app → **New Project**.
2. Choose **Deploy from GitHub repo**.

### 2. Connect the GitHub repository
1. Authorize Railway for GitHub if prompted.
2. Select **`mironovich2345-code/clubops.ru`**.
3. Railway creates a service from the repo. It reads `railway.json`:
   - build: `npm run build:prod` (generates the Postgres Prisma client, then `next build`)
   - pre-deploy: `npm run prisma:migrate:deploy` (`prisma migrate deploy` against the Postgres schema)
   - start: `npm run start` (`next start`, listens on Railway's `$PORT`)

### 3. Add a PostgreSQL database
1. In the project → **New** → **Database** → **Add PostgreSQL**.
2. Railway provisions a `Postgres` service exposing `DATABASE_URL` (and
   `DATABASE_PUBLIC_URL`).

### 4. Wire up `DATABASE_URL`
On the **app service** → **Variables** → add:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

`${{Postgres.DATABASE_URL}}` is a Railway reference variable — it points at the
Postgres service over the private network. Do not paste a literal connection
string; the reference keeps it in sync and avoids egress fees.

> The app reads `env("DATABASE_URL")`. Because the production schema's provider
> is `postgresql`, this must be a Postgres URL, never a `file:` URL.

### 5. Run migrations
With `railway.json` in place, `prisma migrate deploy` runs automatically on every
deploy via `preDeployCommand`, applying everything in
`prisma/production/migrations/` (currently `0_init`).

To run it manually instead (e.g. first-time setup from your machine using the
Railway CLI):

```bash
railway run npm run prisma:migrate:deploy
# or, with DATABASE_URL exported to the Postgres URL:
npm run prisma:migrate:deploy
```

### 6. Deploy
Push to the connected branch (or click **Deploy**). Railway will:
`npm ci` → `npm run build:prod` → `prisma migrate deploy` → `next start`.

There is no demo seed on Postgres. Either create the first company/club through
the app once auth is wired up, or run a one-off seed manually.

---

## Environment variables

| Variable | Local | Railway |
| --- | --- | --- |
| `DATABASE_URL` | `file:./dev.db` | `${{Postgres.DATABASE_URL}}` |
| `PORT` | (n/a) | injected by Railway, used by `next start` |

`.env` is gitignored and never deployed — set variables in the Railway dashboard.

---

## Changing the data model later

1. Edit `prisma/schema.prisma` (the SQLite source of truth).
2. Local migration: `npx prisma migrate dev --name <change>`.
3. Sync the Postgres schema: `npm run prisma:sync-prod`.
4. Create the matching Postgres migration (offline, no DB needed):

   ```bash
   mkdir prisma/production/migrations/<timestamp>_<change>
   npx prisma migrate diff \
     --from-migrations prisma/production/migrations \
     --to-schema-datamodel prisma/production/schema.prisma \
     --script > prisma/production/migrations/<timestamp>_<change>/migration.sql
   ```
5. Commit both migration folders. Railway applies the new Postgres migration on
   the next deploy.

> Keep the SQLite and PostgreSQL migration histories in lock-step — every model
> change needs a migration in **both** folders.

---

## Alternative: schema push (no migration files)

For throwaway review environments you can skip migration files entirely:

```bash
prisma db push --schema prisma/production/schema.prisma
```

`migrate deploy` (the configured default) is preferred for anything persistent.

---

## Migrations must apply on every deploy (important)

Railway runs `deploy.preDeployCommand` (`npm run prisma:migrate:deploy`) before
starting the app. That command invokes the **`prisma` CLI**, so `prisma` is a
runtime **dependency** (not devDependency) — otherwise it is pruned from the
production image and `migrate deploy` silently fails, leaving the database
behind the schema (missing tables/columns) and causing server-side exceptions
on pages that select the new columns (e.g. `/invoices`, `/expenses`).

If a deploy ever lands with an out-of-date database, apply migrations manually:

```bash
railway run npm run prisma:migrate:deploy
# or, with DATABASE_URL exported to the Postgres connection string:
npm run prisma:migrate:deploy
```

Verify the local SQLite migration history matches the schema (should print an
empty migration):

```bash
npx prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma --script
```
