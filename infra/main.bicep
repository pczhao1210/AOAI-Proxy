targetScope = 'resourceGroup'

@description('Location for all new resources.')
param location string = resourceGroup().location

@description('Container group name.')
param containerGroupName string = 'aoai-proxy'

@description('Container image to deploy.')
param image string

@description('Public DNS label for the container group. Leave empty to skip public DNS.')
param dnsNameLabel string = ''

@description('CPU cores for the container.')
param cpu int = 1

@description('Memory in GB for the container.')
param memoryInGb int = 2

@allowed([
  'database'
  'azureFile'
  'blob'
])
@description('Persistence mode. database is the default and stores config in Azure Database for PostgreSQL. azureFile keeps the Azure Files mount. blob stores config via Blob SDK and managed identity.')
param persistenceMode string = 'database'

@allowed([
  'new'
  'existing'
])
@description('Whether to create a new storage account or use an existing one when persistenceMode=azureFile or blob.')
param storageAccountMode string = 'new'

@description('Name of the storage account to create or use for Azure Files or Blob persistence. Leave empty to auto-generate only when storageAccountMode=new.')
param storageAccountName string = ''

@allowed([
  'new'
  'existing'
])
@description('Whether to create the Azure Files share or use an existing one when persistenceMode=azureFile and storageAccountMode=existing. When storageAccountMode=new, the share is always created.')
param fileShareMode string = 'new'

@description('Azure Files share name used when persistenceMode=azureFile.')
param fileShareName string = 'aoaiproxy'

@allowed([
  'new'
  'existing'
])
@description('Whether to create the Blob container or use an existing one when persistenceMode=blob and storageAccountMode=existing. When storageAccountMode=new, the container is always created.')
param blobContainerMode string = 'new'

@description('Blob container name used when persistenceMode=blob.')
param blobContainerName string = 'aoai-proxy-config'

@description('Blob path used for the persisted config file when persistenceMode=blob.')
param configBlobName string = 'config/config.json'

@allowed([
  'new'
  'existing'
])
@description('Whether to create a new PostgreSQL flexible server or use an existing one when persistenceMode=database.')
param databaseServerMode string = 'new'

@description('Name of the PostgreSQL flexible server to create or use. Leave empty to auto-generate only when databaseServerMode=new.')
param databaseServerName string = ''

@allowed([
  'new'
  'existing'
])
@description('Whether to create the PostgreSQL database or use an existing one when persistenceMode=database and databaseServerMode=existing. When databaseServerMode=new, the database is always created.')
param databaseMode string = 'new'

@description('Name of the PostgreSQL database to create or use. Leave empty to auto-create aoaiproxy only when databaseMode=new.')
param databaseName string = ''

@description('PostgreSQL username used to build the application connection string when persistenceMode=database.')
param databaseAdminUsername string = 'aoaiproxyadmin'

@secure()
@description('PostgreSQL password used to build the application connection string when persistenceMode=database. Required only when persistenceMode=database.')
param databaseAdminPassword string = ''

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
@description('PostgreSQL compute tier used when persistenceMode=database.')
param databaseTier string = 'Burstable'

@description('PostgreSQL SKU used when persistenceMode=database. Standard_B1ms is the smallest documented Burstable development size.')
param databaseSkuName string = 'Standard_B1ms'

@allowed([
  '11'
  '12'
  '13'
  '14'
])
@description('PostgreSQL server version used when persistenceMode=database.')
param databaseVersion string = '14'

@description('PostgreSQL storage size in GB used when persistenceMode=database.')
param databaseStorageSizeGB int = 32

@description('Allow connections from Azure services to the PostgreSQL server by creating a 0.0.0.0 firewall rule. This is recommended for ACI because egress IPs are not fixed by default.')
param allowAzureServicesToDatabase bool = true

@description('Database charset used when persistenceMode=database.')
param databaseCharset string = 'UTF8'

@description('Database collation used when persistenceMode=database.')
param databaseCollation string = 'en_US.utf8'

@minLength(2)
@description('Existing Azure OpenAI or Azure AI Foundry account name.')
param cognitiveServicesAccountName string

@description('Resource group that contains the existing Azure OpenAI or Azure AI Foundry account. Defaults to the deployment resource group.')
param cognitiveServicesAccountResourceGroup string = resourceGroup().name

@description('Optional ACR login server. Leave empty for public images.')
param acrLoginServer string = ''

@secure()
@description('Optional ACR username.')
param acrUsername string = ''

@secure()
@description('Optional ACR password.')
param acrPassword string = ''

var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var cognitiveServicesOpenAiUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var azureFileShareContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb')
var deployerPrincipal = deployer()
var deployerBlobPrincipalType = empty(deployerPrincipal.userPrincipalName) ? 'ServicePrincipal' : 'User'
var enableAzureFile = persistenceMode == 'azureFile'
var enableBlob = persistenceMode == 'blob'
var enableDatabase = persistenceMode == 'database'
var useStorage = enableAzureFile || enableBlob
var createStorageAccount = useStorage && storageAccountMode == 'new'
var useExistingStorageAccount = useStorage && storageAccountMode == 'existing'
var effectiveStorageAccountName = !empty(storageAccountName)
  ? toLower(storageAccountName)
  : (createStorageAccount ? take('st${toLower(replace(containerGroupName, '-', ''))}${uniqueString(resourceGroup().id, containerGroupName, 'storage')}', 24) : '')
var createFileShare = enableAzureFile && (createStorageAccount || fileShareMode == 'new')
var createBlobContainer = enableBlob && (createStorageAccount || blobContainerMode == 'new')
var useExistingBlobContainer = enableBlob && useExistingStorageAccount && blobContainerMode == 'existing'
var createDatabaseServer = enableDatabase && databaseServerMode == 'new'
var useExistingDatabaseServer = enableDatabase && databaseServerMode == 'existing'
var effectiveDatabaseServerName = !empty(databaseServerName)
  ? toLower(databaseServerName)
  : (createDatabaseServer ? take('pg-${toLower(replace(containerGroupName, '_', '-'))}-${uniqueString(resourceGroup().id, containerGroupName, 'postgres')}', 63) : '')
var effectiveDatabaseName = !empty(databaseName) ? databaseName : 'aoaiproxy'
var createDatabase = enableDatabase && (createDatabaseServer || databaseMode == 'new')
var storageAccountBlobUrl = useStorage ? 'https://${effectiveStorageAccountName}.blob.${environment().suffixes.storage}' : ''
var databaseServerFqdn = enableDatabase ? '${effectiveDatabaseServerName}.postgres.database.azure.com' : ''
var databaseConnectionString = enableDatabase
  ? 'postgresql://${databaseAdminUsername}:${uriComponent(databaseAdminPassword)}@${databaseServerFqdn}:5432/${effectiveDatabaseName}?sslmode=require'
  : ''
var imageRegistryCredentials = empty(acrLoginServer) ? [] : [
  {
    server: acrLoginServer
    username: acrUsername
    password: acrPassword
  }
]
var environmentVariables = enableDatabase
  ? [
      {
        name: 'PERSISTENCE_MODE'
        value: persistenceMode
      }
      {
        name: 'CONFIG_DB_CONNECTION_STRING'
        secureValue: databaseConnectionString
      }
    ]
  : [
      {
        name: 'PERSISTENCE_MODE'
        value: persistenceMode
      }
      {
        name: 'AZURE_STORAGE_ACCOUNT_URL'
        value: storageAccountBlobUrl
      }
      {
        name: 'CONFIG_BLOB_CONTAINER'
        value: blobContainerName
      }
      {
        name: 'CONFIG_BLOB_NAME'
        value: configBlobName
      }
    ]
var volumeMounts = enableAzureFile ? [
  {
    name: 'configshare'
    mountPath: '/app/data'
  }
] : []
var volumes = enableAzureFile ? [
  {
    name: 'configshare'
    azureFile: {
      shareName: fileShareName
      storageAccountName: effectiveStorageAccountName
      storageAccountKey: listKeys(resourceId('Microsoft.Storage/storageAccounts', effectiveStorageAccountName), '2023-05-01').keys[0].value
    }
  }
] : []

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = if (createStorageAccount) {
  name: effectiveStorageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: enableAzureFile
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource existingStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (useExistingStorageAccount) {
  name: effectiveStorageAccountName
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' = if (createDatabaseServer) {
  name: effectiveDatabaseServerName
  location: location
  properties: {
    administratorLogin: databaseAdminUsername
    administratorLoginPassword: databaseAdminPassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    createMode: 'Create'
    highAvailability: {
      mode: 'Disabled'
    }
    storage: {
      storageSizeGB: databaseStorageSizeGB
    }
    version: databaseVersion
  }
  sku: {
    name: databaseSkuName
    tier: databaseTier
  }
}

resource existingPostgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' existing = if (useExistingDatabaseServer) {
  name: effectiveDatabaseServerName
}

resource postgresFirewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2022-12-01' = if (createDatabaseServer && allowAzureServicesToDatabase) {
  parent: postgresServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = if (createDatabaseServer) {
  parent: postgresServer
  name: effectiveDatabaseName
  properties: {
    charset: databaseCharset
    collation: databaseCollation
  }
}

resource postgresDatabaseOnExistingServer 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = if (useExistingDatabaseServer && databaseMode == 'new') {
  parent: existingPostgresServer
  name: effectiveDatabaseName
  properties: {
    charset: databaseCharset
    collation: databaseCollation
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = if (createFileShare && createStorageAccount) {
  name: 'default'
  parent: storageAccount
}

resource existingStorageFileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' existing = if (createFileShare && useExistingStorageAccount) {
  name: 'default'
  parent: existingStorageAccount
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = if (createFileShare && createStorageAccount) {
  name: fileShareName
  parent: fileService
}

resource fileShareOnExistingStorage 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = if (createFileShare && useExistingStorageAccount) {
  name: fileShareName
  parent: existingStorageFileService
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (createBlobContainer && createStorageAccount) {
  name: 'default'
  parent: storageAccount
}

resource existingStorageBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = if ((createBlobContainer || useExistingBlobContainer) && useExistingStorageAccount) {
  name: 'default'
  parent: existingStorageAccount
}

resource blobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (createBlobContainer && createStorageAccount) {
  name: blobContainerName
  parent: blobService
  properties: {
    publicAccess: 'None'
  }
}

resource blobContainerOnExistingStorage 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (createBlobContainer && useExistingStorageAccount) {
  name: blobContainerName
  parent: existingStorageBlobService
  properties: {
    publicAccess: 'None'
  }
}

resource existingBlobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = if (useExistingBlobContainer) {
  name: blobContainerName
  parent: existingStorageBlobService
}

resource containerGroup 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: containerGroupName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    osType: 'Linux'
    restartPolicy: 'Always'
    containers: [
      {
        name: containerGroupName
        properties: {
          image: image
          environmentVariables: environmentVariables
          ports: [
            {
              port: 3000
              protocol: 'TCP'
            }
            {
              port: 443
              protocol: 'TCP'
            }
          ]
          resources: {
            requests: {
              cpu: cpu
              memoryInGB: memoryInGb
            }
          }
          volumeMounts: volumeMounts
        }
      }
    ]
    imageRegistryCredentials: imageRegistryCredentials
    ipAddress: {
      type: 'Public'
      dnsNameLabel: empty(dnsNameLabel) ? null : dnsNameLabel
      ports: [
        {
          port: 3000
          protocol: 'TCP'
        }
        {
          port: 443
          protocol: 'TCP'
        }
      ]
    }
    volumes: volumes
  }
}

resource blobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createBlobContainer && createStorageAccount) {
  name: guid(blobContainer.id, containerGroup.id, storageBlobDataContributorRoleId)
  scope: blobContainer
  properties: {
    principalId: containerGroup.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource blobRoleAssignmentOnExistingStorage 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createBlobContainer && useExistingStorageAccount) {
  name: guid(blobContainerOnExistingStorage.id, containerGroup.id, storageBlobDataContributorRoleId)
  scope: blobContainerOnExistingStorage
  properties: {
    principalId: containerGroup.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource blobRoleAssignmentOnExistingContainer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useExistingBlobContainer) {
  name: guid(existingBlobContainer.id, containerGroup.id, storageBlobDataContributorRoleId)
  scope: existingBlobContainer
  properties: {
    principalId: containerGroup.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource deployerBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createBlobContainer && createStorageAccount) {
  name: guid(blobContainer.id, deployerPrincipal.objectId, storageBlobDataContributorRoleId)
  scope: blobContainer
  properties: {
    principalId: deployerPrincipal.objectId
    principalType: deployerBlobPrincipalType
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource deployerBlobRoleAssignmentOnExistingStorage 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createBlobContainer && useExistingStorageAccount) {
  name: guid(blobContainerOnExistingStorage.id, deployerPrincipal.objectId, storageBlobDataContributorRoleId)
  scope: blobContainerOnExistingStorage
  properties: {
    principalId: deployerPrincipal.objectId
    principalType: deployerBlobPrincipalType
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource fileRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableAzureFile && createStorageAccount) {
  name: guid(storageAccount.id, containerGroup.id, azureFileShareContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: containerGroup.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: azureFileShareContributorRoleId
  }
}

module cognitiveRoleAssignment 'modules/cognitive-role-assignment.bicep' = {
  name: 'cognitive-role-assignment'
  scope: resourceGroup(cognitiveServicesAccountResourceGroup)
  params: {
    cognitiveServicesAccountName: cognitiveServicesAccountName
    principalId: containerGroup.identity.principalId
    roleDefinitionId: cognitiveServicesOpenAiUserRoleId
  }
}

output containerGroupId string = containerGroup.id
output principalId string = containerGroup.identity.principalId
output persistenceModeOutput string = persistenceMode
output storageAccountModeOutput string = useStorage ? storageAccountMode : ''
output storageAccountNameOutput string = useStorage ? effectiveStorageAccountName : ''
output fileShareModeOutput string = enableAzureFile ? (createFileShare ? 'new' : 'existing') : ''
output blobAccountUrl string = enableBlob ? storageAccountBlobUrl : ''
output azureFileShareName string = enableAzureFile ? fileShareName : ''
output blobContainerModeOutput string = enableBlob ? (createBlobContainer ? 'new' : 'existing') : ''
output blobContainerOutput string = enableBlob ? blobContainerName : ''
output databaseServerModeOutput string = enableDatabase ? databaseServerMode : ''
output databaseServerNameOutput string = enableDatabase ? effectiveDatabaseServerName : ''
output databaseServerFqdnOutput string = enableDatabase ? databaseServerFqdn : ''
output databaseModeOutput string = enableDatabase ? (createDatabase ? 'new' : 'existing') : ''
output databaseNameOutput string = enableDatabase ? effectiveDatabaseName : ''
output databaseAdminUsernameOutput string = enableDatabase ? databaseAdminUsername : ''
