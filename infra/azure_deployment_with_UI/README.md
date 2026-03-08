# Azure Managed Application Package

This folder contains a service-catalog style Azure Managed Application package source.

Required package files:

- `mainTemplate.json`
- `createUiDefinition.json`

When you create `app.zip`, these two files must be at the root of the zip file.

## Package

From the repository root:

```bash
cd infra/azure_deployment_with_UI
zip -j app.zip mainTemplate.json createUiDefinition.json
```

## Publish Definition With Azure CLI

You need:

- A resource group for the managed application definition
- A principal ID and role definition ID for the publisher authorization on the managed resource group
- Either a package URI or the local files in this folder

Example using local files directly:

```bash
az managedapp definition create \
  --resource-group <definition-rg> \
  --name aoai-proxy-managedapp \
  --location <location> \
  --display-name "AOAI Foundry Proxy" \
  --description "AOAI Foundry Proxy with custom UI for ACI deployment" \
  --lock-level ReadOnly \
  --authorizations <principalId>:<roleDefinitionId> \
  --create-ui-definition @createUiDefinition.json \
  --main-template @mainTemplate.json
```

Example using a package zip uploaded to blob storage:

```bash
az managedapp definition create \
  --resource-group <definition-rg> \
  --name aoai-proxy-managedapp \
  --location <location> \
  --display-name "AOAI Foundry Proxy" \
  --description "AOAI Foundry Proxy with custom UI for ACI deployment" \
  --lock-level ReadOnly \
  --authorizations <principalId>:<roleDefinitionId> \
  --package-file-uri https://<storage>.blob.core.windows.net/<container>/app.zip
```

## Deploy An Instance

Get the managed application definition ID:

```bash
az managedapp definition show \
  --resource-group <definition-rg> \
  --name aoai-proxy-managedapp \
  --query id -o tsv
```

Deploy a service catalog instance:

```bash
az managedapp create \
  --resource-group <application-rg> \
  --name aoai-proxy-instance \
  --location <location> \
  --kind ServiceCatalog \
  --managed-rg-id /subscriptions/<subscription-id>/resourceGroups/<managed-rg-name> \
  --managedapp-definition-id <definition-id>
```

If you want to supply parameters by CLI instead of the portal UI, use `--parameters @<file>.json`.