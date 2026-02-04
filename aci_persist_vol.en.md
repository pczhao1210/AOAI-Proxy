# ACI Persistence (Azure Files)

This document explains how to create an Azure Files share and mount it to `/app/data` in ACI for persistent config and Caddyfile storage.

## Variables
Replace the following variables as needed:
- Resource group: `<rg>`
- Region: `<region>` (e.g., `japaneast`)
- Storage account: `<storage>` (globally unique, lowercase)
- File share: `<share>`
- Container name: `<aciName>`
- DNS label (optional): `<dnsLabel>` (unique, lowercase)

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

## 2) Create storage account

```bash
az storage account create \
  -n "$STORAGE" \
  -g "$RG" \
  -l "$REGION" \
  --sku Standard_LRS \
  --kind StorageV2
```

## 3) Create Azure Files share

Use AAD (RBAC) to create the share:

```bash
az storage share create \
  --account-name "$STORAGE" \
  --name "$SHARE" \
  --auth-mode login
```

> You must be logged in (`az login`) and have Storage File Data SMB Share Contributor (or higher).

## 4) Get storage account key (only if Key Based Auth is allowed)

> ACI Azure Files mount currently requires the account key. If the storage account disables Key Based Auth, temporarily enable Shared Key access or use an alternative deployment.

> If you see `InvalidApiVersionParameter` (e.g., `2025-06-01`), upgrade Azure CLI or set `AZURE_STORAGE_API_VERSION=2025-04-01` and retry.

```bash
STORAGE_KEY=$(az storage account keys list \
  -g "$RG" \
  -n "$STORAGE" \
  --query "[0].value" -o tsv)

echo "$STORAGE_KEY"
```

## 5) Create ACI and mount Azure Files

The following command mounts the share to `/app/data` for persistence:

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
  --azure-file-volume-account-name "$STORAGE" \
  --azure-file-volume-account-key "$STORAGE_KEY" \
  --azure-file-volume-share-name "$SHARE" \
  --azure-file-volume-mount-path /app/data \
  --os-type Linux
```

> If your image is public, remove the `--registry-*` arguments.

## 6) Verify mount

Check container logs:

```bash
az container logs -g "$RG" -n "$ACI_NAME"
```

List files in the share:

```bash
az storage file list \
  --account-name "$STORAGE" \
  --share-name "$SHARE" \
  --output table
```

You should see `config.json` (created on first start). Admin saves will update files in the share.

ACME certificates and Caddy state are stored in `/app/data/caddy` and must also be persisted.

## Appendix: Mount Azure Files on Linux VM (SMB)

> Do not hardcode keys in scripts. Use `/etc/smbcredentials/<storage>.cred`.

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

## 7) Restart or re-create

```bash
az container restart -g "$RG" -n "$ACI_NAME"
```

If your Azure CLI does not support `az container update`, delete and re-create:

```bash
az container delete -g "$RG" -n "$ACI_NAME" -y
# Then re-run the az container create command above
```

Persistence remains intact after restarts.

## 8) Enable ACI Managed Identity and grant permissions

This project uses `DefaultAzureCredential`. Enable **system-assigned identity** and grant:
- Azure Files access (RBAC)
- Azure OpenAI / Foundry access (RBAC)

### 8.1 Enable system-assigned identity

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
  --azure-file-volume-account-name "$STORAGE" \
  --azure-file-volume-account-key "$STORAGE_KEY" \
  --azure-file-volume-share-name "$SHARE" \
  --azure-file-volume-mount-path /app/data \
  --os-type Linux
```

Get principal ID:

```bash
ACI_PRINCIPAL_ID=$(az container show -g "$RG" -n "$ACI_NAME" --query identity.principalId -o tsv)
echo "$ACI_PRINCIPAL_ID"
```

### 8.2 Grant Azure Files RBAC

```bash
STORAGE_ID=$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage File Data SMB Share Contributor" \
  --scope "$STORAGE_ID"
```

> Note: ACI Azure Files mount still needs the account key; RBAC is for runtime access.

### 8.3 Grant AOAI/Foundry access at subscription scope

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services User" \
  --scope "/subscriptions/$SUBSCRIPTION_ID"
```

After this, `DefaultAzureCredential` will use the managed identity to acquire upstream tokens.
