# Mileage Log

Mileage logging for Pacifica Landscapes. Phase 1: manual trips, Microsoft sign-in, and IRS-ready daily/monthly reports (CSV and PDF), hosted on Azure. Tesla and phone-GPS trips come in phases 2 and 3.

```
apps/mobile      Expo (React Native) app for iOS, Android and web
api              Azure Functions API (Node 22, TypeScript) + local dev server
packages/shared  Types, validation, IRS rates, report math, CSV (used by app and API)
infra            Bicep: Functions (Flex Consumption), PostgreSQL (Entra auth), Static Web App, App Insights
.github          CI and Azure deploy
```

## How it works

- **Trips** are stored per user in PostgreSQL. Business trips must have a destination and business purpose (the IRS substantiation fields), enforced in `packages/shared/src/validation.ts` on both the app and the API.
- **Reports** bucket trips by local day and month (default time zone `America/Los_Angeles`) and value business miles at the IRS rate in force on each trip date — 2026 changed mid-year from 72.5¢ to 76¢ on July 1 (`packages/shared/src/rates.ts`). A custom rate in Settings overrides it.
- **Sign-in** is Microsoft Entra ID (your work account). The API validates Entra access tokens (`api/src/auth.ts`); every query is scoped to the signed-in user.
- **Database sign-in** uses the API's managed identity (`PG_AUTH=entra` in `api/src/db.ts`); there is no database password. Locally, `DATABASE_URL` with a password still works.
- **Migrations** run automatically on the API's first request (`api/src/db.ts`), or with `npm run migrate`.

## Local development

Requires Node 22 and PostgreSQL 16.

```sh
npm install
createdb mileage_dev

# API on http://localhost:7071/api, no sign-in (send X-Dev-User instead)
DATABASE_URL=postgres://localhost/mileage_dev AUTH_MODE=dev npm run dev:api

# App: copy the env template, then start Expo (press w for web, or scan the QR with a dev build)
cp apps/mobile/.env.example apps/mobile/.env.local
npm run dev:mobile
```

On a physical phone, `localhost` is the phone itself: set `EXPO_PUBLIC_API_URL` to your computer's LAN address, or run `npx expo start --tunnel` and point the app at a deployed API.

Tests (API tests need a scratch database; they drop and recreate its schema):

```sh
TEST_DATABASE_URL=postgres://localhost/mileage_test npm test
npm run typecheck
```

## Azure setup (one time)

Sign-in and hosting live in different tenants:

| | Tenant | Used for |
| --- | --- | --- |
| Pacifica Landscapes | `4712cd50-fdbe-47a5-b632-f5d5e5e1a61b` | Entra app registrations; users sign in with work accounts |
| Personal (ben.andrews@live.com) | `benandrewslive.onmicrosoft.com` | Azure subscription that hosts the API, database and web app |

The API accepts tokens from the Pacifica tenant only; where it's hosted doesn't matter.

### 1. Entra app registrations (done)

Created in the Pacifica tenant; their IDs are committed in `.github/workflows/deploy.yml`, `infra/main.bicepparam` and `apps/mobile/.env.example`.

| Registration | Client ID | Settings |
| --- | --- | --- |
| Mileage Log API | `1e605472-f866-4d4d-a242-a17e6881ccaa` | App ID URI `api://1e605472-…`, scope `access_as_user`, access token version 2 |
| Mileage Log App | `8f9a2e0f-8e53-4d67-87f5-e16d4445e40a` | Public client redirect `mileagelog://auth`; SPA redirect `http://localhost:8081/auth`; `access_as_user` with admin consent |

After the first deploy, add `https://<static-web-app-host>/auth` to **Mileage Log App → Authentication → Single-page application**.

### 2. Resource group and GitHub deploy identity (personal subscription)

Run these signed in as ben.andrews@live.com (Azure Cloud Shell in the portal works, or `az login --tenant benandrewslive.onmicrosoft.com`):

```sh
az account set --subscription "<personal subscription name or id>"
az group create -n rg-mileage-log -l westus2

# Identity GitHub Actions signs in as (no stored password; OIDC federation)
APP_ID=$(az ad app create --display-name mileage-log-github --query appId -o tsv)
az ad sp create --id $APP_ID
az role assignment create --assignee $APP_ID --role Owner \
  --scope $(az group show -n rg-mileage-log --query id -o tsv)
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:thebandrews/mileage-log:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"
echo "AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)"
```

`Owner` on the resource group is needed because the template creates role assignments (storage, monitoring) and the database admin. It is scoped to this one group. If the subscription has never used these services, register the providers once: `az provider register -n Microsoft.Web`, `Microsoft.DBforPostgreSQL`, `Microsoft.OperationalInsights`, `Microsoft.Insights`, `Microsoft.Storage`.

### 3. GitHub variables (no secrets)

Nothing secret is stored in GitHub. Deploys sign in to Azure with OIDC (a short-lived token GitHub mints per run, trusted through the federated credential above), and the API signs in to PostgreSQL with its own managed identity (the database has password sign-in turned off). These four repository **variables** are identifiers, not credentials:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | from step 2 |
| `AZURE_TENANT_ID` | from step 2 (the personal tenant) |
| `AZURE_SUBSCRIPTION_ID` | from step 2 |
| `AZURE_RESOURCE_GROUP` | `rg-mileage-log` |

Then run **Actions → Deploy to Azure**. It deploys the Bicep, the API (with a health check) and the web app, and prints the web URL.

## Mobile builds (no Mac needed)

1. Join the Apple Developer Program and create an Expo account.
2. Once, from any terminal: `cd apps/mobile && npx eas-cli init && npx eas-cli build -p ios --profile development`. EAS asks for your Apple ID and creates the signing credentials (stored by Expo, not in GitHub).
3. Set the app's config as EAS environment variables (public identifiers, not secrets) for the `development`, `preview` and `production` environments: `EXPO_PUBLIC_API_URL` (the deployed API), `EXPO_PUBLIC_AUTH_MODE=entra`, and the three `EXPO_PUBLIC_ENTRA_*` values from `apps/mobile/.env.example`.
4. To build without a terminal, connect this repo in the Expo dashboard (Project → GitHub) and start builds there, so no Expo token is stored in GitHub either.

Profiles: `development` (dev client for live reload), `preview` (internal install), `production` (App Store / TestFlight).

## Phase 1 limits

- Postgres accepts connections from Azure services; each still needs a valid Entra token and TLS (password sign-in is off). Move to VNet integration if this grows beyond a few users.
- To query the database yourself, add your account as a second Entra admin on the server in the portal.
- No Tesla or GPS ingestion yet; the schema already has `source` and `external_id` for de-duplicating automatic trips.
- One user's data is private to that user; there are no shared/company views yet.
