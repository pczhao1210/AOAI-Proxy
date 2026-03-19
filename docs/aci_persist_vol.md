# ACI 持久化模式（Database + Azure Files + Blob）

[English](aci_persist_vol.en.md)

本文档说明 AOAI Proxy 在 Azure Container Instances 上的持久化选择。

先说明一个关键区别：

- 本仓库的 Bicep / ARM 模板已经默认切到 `database`，并会自动创建 PostgreSQL 服务器和数据库。
- 本文档里的原始 `az container create` 手工流程不会自动创建 PostgreSQL 资源。如果你选择 `database`，需要先准备好连接串。

## 持久化模式

当前支持三种模式：

- `database`：把代理配置持久化到 PostgreSQL
- `azureFile`：把 Azure Files 挂载到 `/app/data`，用于配置、Caddyfile、ACME 证书和 Caddy 状态
- `blob`：通过 Blob SDK 和托管身份持久化配置

注意：

- `database` 模式只负责代理配置持久化，不会自动让 `/app/data` 变成持久卷。
- 在纯 `database` 模式下，生成的 Caddyfile、ACME 证书和 Caddy 状态会随着容器替换而丢失。
- 应用可以在 PostgreSQL 中自动创建 schema、table 和配置行，但手工 ACI 流程仍要求数据库资源本身已经存在。
- `blob` 模式不替代 Azure Files 的卷挂载语义。
- ACI 原生 Azure Files 挂载仍需账号密钥。
- 如果你既要完全无 Key，又要保留 `/app/data` 挂载语义，需要考虑 ACA、AKS 或 VM。

## 前置变量

按需替换以下变量：

- 资源组：`<rg>`
- 区域：`<region>`
- 存储账号：`<storage>`
- 文件共享：`<share>`
- 容器组名称：`<aciName>`
- DNS 标签：`<dnsLabel>`

建议先设置环境变量：

```bash
export RG=<rg>
export REGION=<region>
export STORAGE=<storage>
export SHARE=<share>
export ACI_NAME=<aciName>
export DNS_LABEL=<dnsLabel>
```

## 1) 创建资源组

```bash
az group create -n "$RG" -l "$REGION"
```

## 2) 为 `azureFile` 或 `blob` 创建存储资源

如果你只用 `database` 模式，可以跳过本节。

创建存储账号：

```bash
az storage account create \
  -n "$STORAGE" \
  -g "$RG" \
  -l "$REGION" \
  --sku Standard_LRS \
  --kind StorageV2
```

如果要用 `azureFile`，创建文件共享：

```bash
az storage share create \
  --account-name "$STORAGE" \
  --name "$SHARE" \
  --auth-mode login
```

如果要用 `azureFile`，获取存储账号密钥：

```bash
STORAGE_KEY=$(az storage account keys list \
  -g "$RG" \
  -n "$STORAGE" \
  --query "[0].value" -o tsv)

echo "$STORAGE_KEY"
```

ACI 的 Azure Files 挂载仍需要账号密钥。如果存储账号关闭了 key-based auth，请改用别的平台，或临时允许 shared key access。

## 3) 创建 ACI 并选择持久化方式

### 3.1 `database` 模式

适合“只需要持久化代理配置”的场景，不适合依赖 `/app/data` 持久化 Caddy 状态的场景。

应用可以自动创建 schema、table 和配置行，但不会自动创建 PostgreSQL 数据库资源本身。如果希望 Azure 自动创建 PostgreSQL 服务器和数据库，建议直接使用 [../infra/main.bicep](../infra/main.bicep) 或 [../infra/azuredeploy.json](../infra/azuredeploy.json)。

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

### 3.2 `azureFile` 模式

适合需要 `/app/data` 在重启或替换容器后继续存在的场景。

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
    AZURE_STORAGE_ACCOUNT_URL="https://$STORAGE.blob.core.windows.net" \
    CONFIG_BLOB_CONTAINER=aoai-proxy-config \
    CONFIG_BLOB_NAME=config/config.json \
  --azure-file-volume-account-name "$STORAGE" \
  --azure-file-volume-account-key "$STORAGE_KEY" \
  --azure-file-volume-share-name "$SHARE" \
  --azure-file-volume-mount-path /app/data \
  --os-type Linux
```

### 3.3 `blob` 模式

适合把配置放到 Blob，但不依赖 Azure Files 卷语义的场景。

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
    PERSISTENCE_MODE=blob \
    AZURE_STORAGE_ACCOUNT_URL="https://$STORAGE.blob.core.windows.net" \
    CONFIG_BLOB_CONTAINER=aoai-proxy-config \
    CONFIG_BLOB_NAME=config/config.json \
  --os-type Linux
```

## 4) 验证行为

查看容器日志：

```bash
az container logs -g "$RG" -n "$ACI_NAME"
```

如果使用 `azureFile`，可以进一步查看共享中的文件：

```bash
az storage file list \
  --account-name "$STORAGE" \
  --share-name "$SHARE" \
  --output table
```

预期行为：

- `database`：配置保存到 PostgreSQL，同时容器本地保留缓存；`/app/data/caddy` 不是持久的。
- `azureFile`：`config.json`、生成的 Caddyfile 和 Caddy 状态保存在共享中。
- `blob`：优先从 Blob 恢复配置，但 Caddy 状态仍在容器本地。

## 附：在 Linux VM 上挂载 Azure Files（SMB）

请勿在脚本中硬编码账号密钥；建议使用 `/etc/smbcredentials/<storage>.cred`。

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

## 5) 重启或重建

```bash
az container restart -g "$RG" -n "$ACI_NAME"
```

如果 Azure CLI 不支持 `az container update`，可以删除后重建：

```bash
az container delete -g "$RG" -n "$ACI_NAME" -y
```

## 6) 启用托管身份并授予权限

本项目使用 `DefaultAzureCredential` 访问 Azure OpenAI / Foundry 上游。

不同模式对应的要求如下：

- `database`：配置持久化不需要 Storage RBAC，但 PostgreSQL 的防火墙和网络必须允许容器连接。
- `azureFile`：需要 Azure Files 运行期访问权限。
- `blob`：需要 Blob 容器写入权限。
- 所有使用 AAD 上游认证的场景：需要 Azure OpenAI / Foundry 访问权限。

### 6.1 启用系统分配托管身份

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

获取托管身份主体 ID：

```bash
ACI_PRINCIPAL_ID=$(az container show -g "$RG" -n "$ACI_NAME" --query identity.principalId -o tsv)
echo "$ACI_PRINCIPAL_ID"
```

### 6.2 `azureFile` 模式：授予 Azure Files RBAC

```bash
STORAGE_ID=$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage File Data SMB Share Contributor" \
  --scope "$STORAGE_ID"
```

注意：ACI 的 Azure Files 挂载仍需要账号密钥；RBAC 只是运行期权限，不会替代挂载凭据。

### 6.3 `blob` 模式：授予 Blob 写权限

```bash
BLOB_SCOPE="/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$STORAGE/blobServices/default/containers/aoai-proxy-config"

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$BLOB_SCOPE"
```

### 6.4 `database` 模式：保证 PostgreSQL 可连通

本仓库模板在 `persistenceMode=database` 下会自动创建 PostgreSQL Flexible Server、数据库、允许 Azure 服务访问的 `0.0.0.0` 防火墙规则，并把连接串以安全环境变量方式注入容器。

如果你走的是本文档里的原始 ACI CLI 手工流程，需要自己确保 PostgreSQL 服务器允许该容器连接。

### 6.5 授予 Azure OpenAI / Foundry 访问权限

```bash
AOAI_SCOPE="/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RG/providers/Microsoft.CognitiveServices/accounts/<aoai-account-name>"

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services OpenAI User" \
  --scope "$AOAI_SCOPE"
```

完成后，容器内的 `DefaultAzureCredential` 就可以使用托管身份获取上游访问令牌。
