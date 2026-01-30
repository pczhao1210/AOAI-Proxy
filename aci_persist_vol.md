# ACI 持久化（Azure Files）

本文档说明如何创建 Azure Files 共享，并在 ACI 中挂载到 `/app/data` 以实现配置与 Caddyfile 持久化。

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

## 5) 创建 ACI 并挂载 Azure Files

下面命令会把 Azure Files 共享挂载到 `/app/data`，与应用的持久化路径对齐。

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

> 如果镜像来自公开仓库，可移除 `--registry-*` 参数。

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

正常情况下会看到 `config.json`（首次启动会自动生成）。后续在管理页面保存配置时，文件会写入该共享，从而实现持久化。

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
- Azure Files 共享访问（RBAC）
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

### 8.2 授权访问 Azure Files 共享

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

### 8.3 授权访问 Azure OpenAI / Foundry 资源

对订阅级别授予访问权限（覆盖该订阅内的 AOAI/Foundry 资源）。常用角色：
- `Cognitive Services User`（建议）
- 或 `Cognitive Services Contributor`

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

az role assignment create \
  --assignee-object-id "$ACI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services User" \
  --scope "/subscriptions/$SUBSCRIPTION_ID"
```

完成后，容器内的 `DefaultAzureCredential` 会使用托管身份获取上游访问令牌。
