# ACI Persistence Modes (Database + Azure Files)

This document explains the persistence choices for AOAI Proxy when you deploy it to Azure Container Instances.

Important distinction:

- The Bicep and ARM templates in this repo now default to `database+azureFile` and can create or reuse both PostgreSQL and Azure Files resources for you.
- The raw `az container create` flow in this document does not provision PostgreSQL automatically. If you choose `database` or `database+azureFile`, you must already have a working PostgreSQL connection string.

## Persistence Modes

Three modes are supported:

- `database`: persist proxy config in PostgreSQL
- `azureFile`: mount Azure Files at `/app/data` for config, Caddyfile, ACME certificates, and Caddy state
- `database+azureFile`: persist config in PostgreSQL while mounting `/app/data` from Azure Files

Important constraints:

- `database` mode persists proxy configuration only. It does not make `/app/data` durable.
- In pure `database` mode, generated Caddyfile, ACME certificates, and Caddy state remain container-local and are lost when the container group is replaced.
- `azureFile` mode persists both the config file and other `/app/data` filesystem artifacts in Azure Files.
- `database+azureFile` combines PostgreSQL-backed config persistence with Azure Files-backed filesystem persistence and is the most complete ACI option.
- The app auto-creates schema, table, and config row in PostgreSQL, but the raw ACI flow still expects the PostgreSQL database resource itself to already exist.
- ACI native Azure Files mounting still requires the storage account key.
- If you need fully keyless auth and still require `/app/data` mount semantics, move to ACA, AKS, or a VM-based deployment.

Also distinguish the two Azure Files key paths:

- Raw ACI CLI flow: you provide the storage account key yourself.
- Repo-provided Bicep, ARM, and Portal flows: you can either provide `azureFileStorageAccountKey` directly or leave it empty and let deployment call `listKeys`.

## Variables

Replace the following variables as needed:

- Resource group: `<rg>`
- Region: `<region>`
- Storage account: `<storage>`
- File share: `<share>`
- Container name: `<aciName>`
- DNS label: `<dnsLabel>`

Recommended environment variables:

```bash
export RG=<rg>
export REGION=<region>
export STORAGE=<storage>
export SHARE=<share>
export ACI_NAME=<aciName>
export DNS_LABEL=<dnsLabel>
```

## 1) Create resource group

```bash
az group create -n "$RG" -l "$REGION"
```

## 2) Create storage resources for `azureFile` or `database+azureFile`

Skip this section when you use `database` mode only.

Create the storage account:

```bash
az storage account create \
  -n "$STORAGE" \
  -g "$RG" \
  -l "$REGION" \
  --sku Standard_LRS \
  --kind StorageV2
```

Create the Azure Files share:

```bash
az storage share create \
  --account-name "$STORAGE" \
  --name "$SHARE" \
  --auth-mode login
```

Get the storage account key:

```bash
STORAGE_KEY=$(az storage account keys list \
  -g "$RG" \
  -n "$STORAGE" \
  --query "[0].value" -o tsv)

echo "$STORAGE_KEY"
```

ACI Azure Files mounting still requires the account key. If the storage account disables key-based auth, use a different platform or temporarily allow shared key access.

## 3) Create ACI and choose a persistence mode

### 3.1 `database` mode

Use this mode when you want durable proxy configuration but do not need `/app/data` to survive container replacement.

The app can create its schema, table, and config row automatically, but not the PostgreSQL database resource itself. If you want Azure to create the PostgreSQL server and database automatically, use [../infra/main.bicep](../infra/main.bicep) or [../infra/azuredeploy.json](../infra/azuredeploy.json) instead of the raw ACI CLI flow.

```bash
az container create \
  -g "$RG" \
  -n "$ACI_NAME" \
  --image <image> \
  --registry-login-server <registry-login-server> \
  --registry-username <registry-username> \
  --registry-password <registry-password> \
  --assign-identity \
  --cpu 1 --memory 2 \
  --ports 3000 443 \
  --dns-name-label "$DNS_LABEL" \
  --environment-variables \
    PERSISTENCE_MODE=database \
    CONFIG_DB_CONNECTION_STRING="postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/<database>?sslmode=require" \
  --os-type Linux
```

### 3.2 `azureFile` mode

Use this mode when you need `/app/data` to survive restart or replacement, including Caddy state.

The example below uses the raw Azure CLI flow, so it must explicitly pass `--azure-file-volume-account-key "$STORAGE_KEY"`.

If you switch to the repo templates instead, the logic becomes:

- provide `azureFileStorageAccountKey` to use the supplied key directly
- leave it empty to let deployment call `listKeys`
- either way, the actual ACI mount still uses shared-key authentication

```bash
az container create \
  -g "$RG" \
  -n "$ACI_NAME" \
  --image <image> \
  --registry-login-server <registry-login-server> \
  --registry-username <registry-username> \
  --registry-password <registry-password> \
  --cpu 1 --memory 2 \
  --ports 3000 443 \
  --dns-name-label "$DNS_LABEL" \
  --environment-variables \
    PERSISTENCE_MODE=azureFile \
  --azure-file-volume-account-name "$STORAGE" \
  --azure-file-volume-account-key "$STORAGE_KEY" \
  --azure-file-volume-share-name "$SHARE" \
  --azure-file-volume-mount-path /app/data \
  --os-type Linux
```

### 3.3 `database+azureFile` mode

Use this mode when you want both PostgreSQL-backed config persistence and Azure Files-backed `/app/data` durability.

```bash
az container create \
  -g "$RG" \
  -n "$ACI_NAME" \
  --image <image> \
  --registry-login-server <registry-login-server> \
  --registry-username <registry-username> \
  --registry-password <registry-password> \
  --assign-identity \
  --cpu 1 --memory 2 \
  --ports 3000 443 \
  --dns-name-label "$DNS_LABEL" \
  --environment-variables \
    PERSISTENCE_MODE=database+azureFile \
    CONFIG_DB_CONNECTION_STRING="postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/<database>?sslmode=require" \
  --azure-file-volume-account-name "$STORAGE" \
  --azure-file-volume-account-key "$STORAGE_KEY" \
  --azure-file-volume-share-name "$SHARE" \
  --azure-file-volume-mount-path /app/data \
  --os-type Linux
```

## 4) Verify behavior

Check container logs:

```bash
az container logs -g "$RG" -n "$ACI_NAME"
```

If you use `azureFile` or `database+azureFile`, list files in the share:

```bash
az storage file list \
  --account-name "$STORAGE" \
  --share-name "$SHARE" \
  --output table
```

Expected behavior:

- `database`: config is stored in PostgreSQL and a local cache remains inside the container filesystem. `/app/data/caddy` is not durable unless you add your own persistent volume pattern.
- `azureFile`: `config.json`, generated Caddyfile, and Caddy state are persisted in the mounted share.
- `database+azureFile`: config is stored in PostgreSQL while Caddy state and other filesystem artifacts are persisted in the mounted share.

## Appendix: Mount Azure Files on Linux VM (SMB)

Do not hardcode keys in scripts. Use `/etc/smbcredentials/<storage>.cred`.

```bash
sudo mkdir -p /media/aoaiproxy
sudo mkdir -p /etc/smbcredentials
sudo bash -c 'cat > /etc/smbcredentials/<storage>.cred <<EOF
username=<storage>
password=<storage-key>
EOF'
sudo chmod 600 /etc/smbcredentials/<storage>.cred

sudo bash -c 'echo "//<storage>.file.core.windows.net/<share> /media/aoaiproxy cifs nofail,credentials=/etc/smbcredentials/<storage>.cred,dir_mode=0755,file_mode=0755,serverino,nosharesock,mfsymlinks,actimeo=30" >> /etc/fstab'
sudo mount -t cifs //<storage>.file.core.windows.net/<share> /media/aoaiproxy \
  -o credentials=/etc/smbcredentials/<storage>.cred,dir_mode=0755,file_mode=0755,serverino,nosharesock,mfsymlinks,actimeo=30
```

## 5) Restart or re-create

```bash
az container restart -g "$RG" -n "$ACI_NAME"
```

If your Azure CLI does not support `az container update`, delete and re-create:

```bash
az container delete -g "$RG" -n "$ACI_NAME" -y
```

## 6) Enable managed identity and grant permissions

This project uses `DefaultAzureCredential` for upstream Azure OpenAI / Foundry access.

Grant what is relevant for the selected mode:

- `database`: no Storage RBAC is needed for config persistence, but PostgreSQL firewall and networking must allow the container to connect
- `azureFile` and `database+azureFile`: grant Azure Files runtime access
- all AAD upstream scenarios: grant Azure OpenAI / Foundry access

### 6.1 Enable system-assigned identity

```bash
az container create \
  -g "$RG" \
  -n "$ACI_NAME" \
  --image <image> \
  --registry-login-server <registry-login-server> \
  --registry-username <registry-username> \
  --registry-password <registry-password> \
  --assign-identity \
  --cpu 1 --memory 2 \
  --ports 3000 443 \
  --dns-name-label "$DNS_LABEL" \
  --os-type Linux
```

Get principal ID:

```bash
ACI_PRINCIPAL_ID=$(az container show -g "$RG" -n "$ACI_NAME" --query identity.principalId -o tsv)
echo "$ACI_PRINCIPAL_ID"
```

### 6.2 `azureFile` and `database+azureFile` modes: grant Azure Files RBAC

```bash
STORAGE_ID=$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage File Data SMB Share Contributor" \
  --scope "$STORAGE_ID"
```

ACI Azure Files mounting still needs the account key. RBAC is for runtime access, not for replacing the mount credential.

### 6.3 `database` and `database+azureFile` modes: allow PostgreSQL connectivity

For the template-driven deployment in this repo, `persistenceMode=database` and `persistenceMode=database+azureFile` create a PostgreSQL flexible server, create the database, inject the connection string securely, and add a `0.0.0.0` firewall rule so Azure services can connect.

For the raw ACI CLI flow, make sure your PostgreSQL server allows the container to connect.

### 6.4 Grant Azure OpenAI / Foundry access

```bash
AOAI_SCOPE="/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RG/providers/Microsoft.CognitiveServices/accounts/<aoai-account-name>"

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services OpenAI User" \
  --scope "$AOAI_SCOPE"
```

After this, `DefaultAzureCredential` can use the managed identity to acquire upstream tokens.
