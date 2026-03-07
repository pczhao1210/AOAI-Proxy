# ACI 持久化（Azure Files + Blob 配置选项）

[English](aci_persist_vol.en.md)

本文档说明如何保留 Azure Files 挂载到 `/app/data`，并在需要时增加基于 Blob SDK 的配置文件保存和读取选项。

## 持久化模式

当前支持两种部署模式：

- `azureFile`：继续使用 Azure Files 挂载 `/app/data`，适合配置、Caddyfile 和 Caddy 状态的文件系统持久化
- `blob`：应用通过 Blob SDK + Managed Identity 保存和读取配置文件，适合禁用 Blob Key Auth 的场景

注意：

- `blob` 模式不替代 Azure Files 的卷挂载语义
- ACI 原生 Azure Files 挂载仍需账号密钥
- 如果你要求“完全禁用 Key Authentication 且仍保留 `/app/data` 挂载语义”，则需要评估 ACA、AKS 或 VM 等替代平台

## 前置变量
请按需替换以下变量：
- 资源组：`<rg>`
- 区域：`<region>`（如 `japaneast`）
- 存储账号名：`<storage>`（全局唯一、小写）
- 文件共享名：`<share>`
- 容器名：`<aciName>`
- DNS 标签（可选）：`<dnsLabel>`（唯一、小写）

建议先在本机设置环境变量：

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

## 2) 创建存储账号

```bash
az storage account create \
  -n "$STORAGE" \
  -g "$RG" \
  -l "$REGION" \
  --sku Standard_LRS \
  --kind StorageV2
```

## 3) 创建 Azure Files 共享

使用 AAD（RBAC）创建共享：

```bash
az storage share create \
  --account-name "$STORAGE" \
  --name "$SHARE" \
  --auth-mode login
```

> 需要已 `az login`，并具有 Storage File Data SMB Share Contributor（或更高）权限。

## 4) 获取存储账号密钥（仅当允许 Key Based Auth）

> ACI 的 Azure Files 挂载目前仍需账号密钥。若存储账号禁止 Key Based Auth，需要临时启用 Shared Key access 或使用支持 AAD 挂载的替代部署方案。

> 若出现 `InvalidApiVersionParameter`（如 `2025-06-01` 无效），请先升级 Azure CLI，或设置环境变量 `AZURE_STORAGE_API_VERSION=2025-04-01` 再执行命令。

```bash
STORAGE_KEY=$(az storage account keys list \
  -g "$RG" \
  -n "$STORAGE" \
  --query "[0].value" -o tsv)

echo "$STORAGE_KEY"
```

## 5) 创建 ACI 并指定持久化方式

### 5.1 `azureFile` 模式

下面命令会把 Azure Files 共享挂载到 `/app/data`，并显式设置 `PERSISTENCE_MODE=azureFile`。

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

> 如果镜像来自公开仓库，可移除 `--registry-*` 参数。

### 5.2 `blob` 模式

如果你要保留 ACI，但把配置文件保存/读取切换到 Blob SDK，可使用如下环境变量。此模式不再依赖 Azure Files 读取配置文件，但 `/app/data` 的文件系统持久化也不再由 Blob 替代。

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

## 6) 验证挂载是否生效

查看容器日志：

```bash
az container logs -g "$RG" -n "$ACI_NAME"
```

验证文件共享内容：

```bash
az storage file list \
  --account-name "$STORAGE" \
  --share-name "$SHARE" \
  --output table
```

在 `azureFile` 模式下，正常情况下会看到 `config.json`（首次启动会自动生成）。后续在管理页面保存配置时，文件会写入该共享，从而实现持久化。

在 `blob` 模式下，管理页面保存配置后会将最新配置上传到 Blob，并在下次启动时优先从 Blob 恢复。

ACME 证书与 Caddy 状态保存在 `/app/data/caddy`，请确保该目录也被挂载到 Azure Files 共享中。

## 附：在 Linux VM 上挂载 Azure Files（SMB）

> 请勿在脚本中硬编码账号密钥；推荐使用 `/etc/smbcredentials/<storage>.cred` 管理。

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

## 7) 更新或重启

```bash
az container restart -g "$RG" -n "$ACI_NAME"
```

如果你的 Azure CLI 版本不支持 `az container update`，请删除后重建：

```bash
az container delete -g "$RG" -n "$ACI_NAME" -y
# 然后使用上面的 az container create 命令重建
```

重启后配置与 Caddyfile 仍会保留在 Azure Files 中。

## 8) 启用 ACI Managed Identity 并授予权限

本项目使用 `DefaultAzureCredential` 获取 AAD Token。建议为 ACI 启用 **系统分配托管身份**，并授予：
- `azureFile` 模式：Azure Files 共享访问（RBAC）
- `blob` 模式：Blob 容器写入访问（RBAC）
- Azure OpenAI / Foundry 资源访问（RBAC）

### 8.1 启用系统分配托管身份

创建 ACI 时启用：

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

获取托管身份主体 ID：

```bash
ACI_PRINCIPAL_ID=$(az container show -g "$RG" -n "$ACI_NAME" --query identity.principalId -o tsv)
echo "$ACI_PRINCIPAL_ID"
```

### 8.2 `azureFile` 模式：授权访问 Azure Files 共享

为存储账号授予 RBAC 权限（至少 `Storage File Data SMB Share Contributor`）：

```bash
STORAGE_ID=$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage File Data SMB Share Contributor" \
  --scope "$STORAGE_ID"
```

> 说明：ACI 的 Azure Files **挂载**目前仍需账号密钥；RBAC 主要用于运行期访问存储账号（如需 API 访问）。

### 8.3 `blob` 模式：授权访问 Blob 容器

建议使用容器级或存储账号级 scope，避免订阅级过宽授权。示例：

```bash
BLOB_SCOPE="/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$STORAGE/blobServices/default/containers/aoai-proxy-config"

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$BLOB_SCOPE"
```

### 8.4 授权访问 Azure OpenAI / Foundry 资源

建议使用 Azure OpenAI 资源级 scope，而不是订阅级：

```bash
AOAI_SCOPE="/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RG/providers/Microsoft.CognitiveServices/accounts/<aoai-account-name>"

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services OpenAI User" \
  --scope "$AOAI_SCOPE"
```

完成后，容器内的 `DefaultAzureCredential` 会使用托管身份获取上游访问令牌。
