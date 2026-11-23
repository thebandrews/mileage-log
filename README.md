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

The live web app's redirect `https://lively-grass-0921a801e.5.azurestaticapps.net/auth` is also registered. If the Static Web App is ever recreated with a new host name, add its `/auth` URL to **Mileage Log App → Authentication → Single-page application**.

### 2. Resource group and GitHub deploy identity (done, personal "Azure subscription 1")

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
# GitHub now also identifies repos by numeric IDs in the token subject; trust that form too.
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-main-ids",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:thebandrews@915663/mileage-log@1468237833:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"
echo "AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)"
```

`Owner` on the resource group is needed because the template creates role assignments (storage, monitoring) and the database admin. It is scoped to this one group. If the subscription has never used these services, register the providers once: `az provider register -n Microsoft.Web`, `Microsoft.DBforPostgreSQL`, `Microsoft.OperationalInsights`, `Microsoft.Insights`, `Microsoft.Storage`.

### 3. Deploy (no secrets)

Nothing secret is stored in GitHub. Deploys sign in to Azure with OIDC (a short-lived token GitHub mints per run, trusted through the federated credential above), and the API signs in to PostgreSQL with its own managed identity (password sign-in is off). The identifiers the workflow needs are committed at the top of `.github/workflows/deploy.yml`:

| Name | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | `c1c509c8-1676-4338-bcc7-1f9a3431d14b` (mileage-log-github) |
| `AZURE_TENANT_ID` | `6b2283e3-b75d-414f-933e-02cf1cdf6053` (personal tenant) |
| `AZURE_SUBSCRIPTION_ID` | `d308b3d9-92b1-4b1c-aba9-a7ca4b923521` (Azure subscription 1) |
| `AZURE_RESOURCE_GROUP` | `rg-mileage-log` (West US 2) |

Every push to `main` that touches the app, API or infra deploys; **Actions → Deploy to Azure → Run workflow** deploys by hand. Each run deploys the Bicep, the API (with a health check) and the web app, and prints the web URL.

## Start/End trips

Today has a **Start trip** button. Pick the vehicle and tap Start; tap End when you arrive. Miles come from:

- **A linked Tesla:** the server reads the car's odometer and location at Start and End (Tesla Fleet API, two reads per trip, inside Tesla's free monthly credit).
- **Any other vehicle, in the iPhone app:** the phone measures the distance with GPS between Start and End, even locked in a pocket (location access must be set to "Always"). Odometer readings are optional; if you enter both, the odometer wins. Only the total leaves the phone, at End. If GPS lost the trip for a stretch, the trip-ended screen asks you to check the miles.
- **Any other vehicle, on the web:** odometer readings at Start and End (pre-filled from the last reading), or the miles typed at End. Browsers stop reporting location in the background, so the web app doesn't track.

Ended trips start out unclassified and wait in the **inbox** on Today: one tap for Personal, one tap for Business when the trip already has a destination and purpose (otherwise it opens the trip to add them).

Start and end points are turned into addresses with Azure Maps (managed identity, no keys). Rename a place once ("Yard", "Smith residence") and trips that start or end within 150 m reuse the name.

## Tesla connection (after Tesla approves the developer app)

1. In the Tesla developer dashboard, set the allowed origin to `https://lively-grass-0921a801e.5.azurestaticapps.net` and the redirect URI to `https://lively-grass-0921a801e.5.azurestaticapps.net/tesla/callback`; request the `vehicle_device_data` and `vehicle_location` scopes.
2. The partner public key is already published at `https://lively-grass-0921a801e.5.azurestaticapps.net/.well-known/appspecific/com.tesla.3p.public-key.pem`. Its private half was created inside Key Vault and never leaves it.
3. Store the client secret in Key Vault (never in GitHub), from Cloud Shell:
   `az keyvault secret set --vault-name <vault> -n tesla-client-secret --value '<client secret>'`
4. Put the client ID (public) in `infra/main.bicepparam` as `teslaClientId` and push; the deploy turns the feature on.
5. Register the partner account once (Tesla requires it per region), from Cloud Shell:
   ```sh
   TOKEN=$(curl -s -X POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token \
     -d grant_type=client_credentials -d client_id=<client id> -d client_secret='<client secret>' \
     -d scope='openid vehicle_device_data vehicle_location' \
     -d audience=https://fleet-api.prd.na.vn.cloud.tesla.com | jq -r .access_token)
   curl -s -X POST https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"domain":"lively-grass-0921a801e.5.azurestaticapps.net"}'
   ```
6. In the app: **Settings → Connect Tesla**. Your Tesla vehicle is linked by VIN (a Tesla you already added is reused).

## Mobile builds (no Mac needed)

1. Join the Apple Developer Program and create a free Expo account at expo.dev.
2. From any terminal with Node (Azure Cloud Shell works), once:
   ```sh
   git clone https://github.com/thebandrews/mileage-log && cd mileage-log/apps/mobile && npm install
   npx eas-cli@latest login
   npx eas-cli@latest init                 # creates the Expo project; commit the projectId it adds to app.json
   npx eas-cli@latest device:create        # shows a link/QR: open it on the iPhone to register it
   npx eas-cli@latest build -p ios --profile preview
   ```
   EAS asks for your Apple ID and creates the signing credentials (stored by Expo, not in GitHub). When the build finishes, open its link on the iPhone to install. iOS 16+ also needs **Settings → Privacy & Security → Developer Mode** turned on for internal builds.
3. The app's config (API address, Entra tenant and client IDs) is in `apps/mobile/eas.json` for each profile. These are public identifiers, not secrets; nothing else needs setting.
4. To build without a terminal, connect this repo in the Expo dashboard (Project → GitHub) and start builds there, so no Expo token is stored in GitHub either.

Profiles: `development` (dev client for live reload), `preview` (internal install), `production` (App Store / TestFlight).

## Phase 1 limits

- Postgres accepts connections from Azure services; each still needs a valid Entra token and TLS (password sign-in is off). Move to VNet integration if this grows beyond a few users.
- To query the database yourself, add your account as a second Entra admin on the server in the portal.
- Trips only come from Start/End and manual entry; automatic trips (phase 4) will use `source` and `external_id` to avoid duplicates.
- One user's data is private to that user; there are no shared/company views yet.
