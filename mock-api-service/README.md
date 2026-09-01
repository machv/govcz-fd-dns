# DNSPortal API mock

Stateful integration-test mock based on the downloaded DNSPortal OpenAPI 3.1
contract at <https://api.dnsportal.gov.cz/openapi.json>.

It implements the commonly stateful flows:

- create, list, read, update, suspend, resume, and delete domains;
- create, list, update, and delete DNS records;
- create, list, read, and revoke API tokens;
- zones, FQDN availability/translation, login, and health check;
- a basic admin portal at `/admin`.

The original contract is served at `/openapi.json`. Unimplemented endpoints
return a clear `404 NOT_IMPLEMENTED` response instead of fabricated success.
Protected `/v1` endpoints require a valid `X-API-Key` matching a token currently
shown in live state. Health check and login/logout/refresh endpoints remain
public. The admin portal and its state endpoints are password-protected. Calls
made from an authenticated admin portal session may create initial content
without supplying an API key.

## Run locally

```bash
npm install
PORTAL_PASSWORD=local-secret STATE_FILE=.data/state.json npm start
```

Open <http://localhost:3000/admin> and enter any username plus the configured
password in the browser's Basic Authentication dialog. `STATE_FILE` provides
restart-safe local persistence; Redis should be used in Azure.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listening port |
| `PORTAL_PASSWORD` | required | Password protecting the admin portal and its state operations |
| `STATE_FILE` | unset | Local JSON persistence path; ignored when Redis is configured |
| `REDIS_URL` | unset | Redis connection URL; enables persistent shared state |
| `REDIS_KEY` | `dnsportal-mock:state` | Redis key containing mock state |

Set a strong `PORTAL_PASSWORD` in Azure Container Apps secrets. For persistence,
provide a TLS Redis URL such as `rediss://...` through a secret reference.

## Container

```bash
docker build -t dnsportal-api-mock .
docker run --rm -p 3000:3000 \
  -e PORTAL_PASSWORD=local-secret \
  dnsportal-api-mock
```

## Azure Container Apps

`infra/main.bicep` creates an Azure Container Registry, Log Analytics workspace,
Container Apps managed environment, and the Container App. Sign in, define the
deployment values, and create a resource group in France Central:

```bash
az login

RESOURCE_GROUP="rg-dnsportal-api-mock"
LOCATION="francecentral"
PORTAL_PASSWORD="replace-with-a-strong-password"

az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION"
```

On the first deployment, create the registry and supporting infrastructure
without the Container App:

```bash
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name dnsportal-api-mock-bootstrap \
  --template-file infra/main.bicep \
  --parameters \
    location="$LOCATION" \
    portalPassword="$PORTAL_PASSWORD" \
    deployContainerApp=false
```

Read the generated registry name and use an ACR Task to build and push the
container directly from the current local source directory:

```bash
ACR_NAME="$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name dnsportal-api-mock-bootstrap \
  --query properties.outputs.registryName.value \
  --output tsv)"

az acr build \
  --registry "$ACR_NAME" \
  --image dnsportal-api-mock:latest \
  .
```

Deploy the Container App using the image now stored in ACR:

```bash
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name dnsportal-api-mock \
  --template-file infra/main.bicep \
  --parameters \
    location="$LOCATION" \
    portalPassword="$PORTAL_PASSWORD" \
    deployContainerApp=true
```

Print the deployed service URL:

```bash
az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name dnsportal-api-mock \
  --query properties.outputs.url.value \
  --output tsv
```

For persistent shared data, add `redisUrl="$REDIS_URL"` and set
`maxReplicas` above 1 if desired. Without Redis, the deployment defaults to one
replica and data is lost when that replica is replaced.
