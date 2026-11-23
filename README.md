# Mileage Log

Mileage logging for Pacifica Landscapes. Phase 1: manual trips, Microsoft sign-in, and IRS-ready daily/monthly reports (CSV and PDF), hosted on Azure. Tesla and phone-GPS trips come in phases 2 and 3.

```
apps/mobile      Expo (React Native) app for iOS, Android and web
api              Azure Functions API (Node 22, TypeScript) + local dev server
packages/shared  Types, validation, IRS rates, report math, CSV (used by app and API)
infra            Bicep: Functions (Flex Consumption), PostgreSQL, Key Vault, Static Web App, App Insights
.github          CI, Azure deploy, EAS mobile builds
```

## How it works

- **Trips** are stored per user in PostgreSQL. Business trips must have a destination and business purpose (the IRS substantiation fields), enforced in `packages/shared/src/validation.ts` on both the app and the API.
- **Reports** bucket trips by local day and month (default time zone `America/Los_Angeles`) and value business miles at the IRS rate in force on each trip date — 2026 changed mid-year from 72.5¢ to 76¢ on July 1 (`packages/shared/src/rates.ts`). A custom rate in Settings overrides it.
- **Sign-in** is Microsoft Entra ID (your work account). The API validates Entra access tokens (`api/src/auth.ts`); every query is scoped to the signed-in user.
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

### 1. Entra app registrations

In the Entra admin center → App registrations, create two single-tenant registrations:

**Mileage Log API**
- Expose an API → Application ID URI `api://<api-client-id>` → add scope `access_as_user` (admins and users can consent).
- Manifest: set `"requestedAccessTokenVersion": 2` (shown as `accessTokenAcceptedVersion` in older manifests).

**Mileage Log App** (public client)
- Authentication → add platform **Mobile and desktop applications** with redirect URI `mileagelog://auth`.
- Add platform **Single-page application** with redirect URIs `https://<static-web-app-host>/auth` (from the first deploy's output) and `http://localhost:8081/auth`.
- API permissions → add `Mileage Log API / access_as_user` → grant admin consent.

### 2. Azure resource group and GitHub deploy identity

```sh
az group create -n rg-mileage-log -l westus2

# Identity GitHub Actions signs in as (no stored password; OIDC federation)
az ad app create --display-name mileage-log-github
APP_ID=$(az ad app list --display-name mileage-log-github --query [0].appId -o tsv)
az ad sp create --id $APP_ID
az role assignment create --assignee $APP_ID --role Owner \
  --scope $(az group show -n rg-mileage-log --query id -o tsv)
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:thebandrews/mileage-log:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

`Owner` on the resource group is needed because the template creates role assignments (Key Vault, storage). It is scoped to this one group.

### 3. GitHub secrets and variables

| Name | Kind | Value |
| --- | --- | --- |
| `AZURE_CLIENT_ID` | secret | `$APP_ID` from step 2 |
| `AZURE_TENANT_ID` | secret | your tenant ID |
| `AZURE_SUBSCRIPTION_ID` | secret | your subscription ID |
| `POSTGRES_ADMIN_PASSWORD` | secret | a long random password (16+ chars) |
| `AZURE_RESOURCE_GROUP` | variable | `rg-mileage-log` |
| `ENTRA_API_CLIENT_ID` | variable | client ID of **Mileage Log API** |
| `ENTRA_APP_CLIENT_ID` | variable | client ID of **Mileage Log App** |

Then run **Actions → Deploy to Azure**. It deploys the Bicep, the API (with a health check) and the web app, and prints the web URL. Add that URL's `/auth` to the SPA redirect URIs if you haven't yet.

## Mobile builds (no Mac needed)

1. Join the Apple Developer Program and create an Expo account.
2. Once, from any terminal: `cd apps/mobile && npx eas-cli init && npx eas-cli build -p ios --profile development`. EAS asks for your Apple ID and creates the signing credentials.
3. Set the app's config as EAS environment variables (they're public identifiers, not secrets) for the `development`, `preview` and `production` environments:
   `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_AUTH_MODE=entra`, `EXPO_PUBLIC_ENTRA_TENANT_ID`, `EXPO_PUBLIC_ENTRA_CLIENT_ID`, `EXPO_PUBLIC_ENTRA_API_SCOPE`.
4. After that, **Actions → Mobile build (EAS)** builds without a terminal (needs the `EXPO_TOKEN` secret).

Profiles: `development` (dev client for live reload), `preview` (internal install), `production` (App Store / TestFlight).

## Phase 1 limits

- Postgres allows connections from Azure services (password + TLS). Move to VNet integration if this grows beyond a few users.
- No Tesla or GPS ingestion yet; the schema already has `source` and `external_id` for de-duplicating automatic trips.
- One user's data is private to that user; there are no shared/company views yet.
