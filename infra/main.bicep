targetScope = 'resourceGroup'

@description('Location for all new resources.')
param location string = resourceGroup().location

@description('Container group name.')
param containerGroupName string = 'aoai-proxy'

@description('Container image to deploy.')
param image string

@description('Public DNS label for the container group. Leave empty to skip public DNS. This does not make the ACI private; the current template still creates a public IP address.')
param dnsNameLabel string = ''

@description('CPU cores for the container.')
param cpu int = 1

@description('Memory in GB for the container.')
param memoryInGb int = 2

@allowed([
  'database'
  'database+azureFile'
  'azureFile'
])
@description('Persistence mode. database+azureFile is the default and stores config in Azure Database for PostgreSQL while mounting /app/data from Azure Files. database keeps PostgreSQL-backed config only. azureFile keeps only the Azure Files mount.')
param persistenceMode string = 'database+azureFile'

@allowed([
  'new'
  'existing'
])
@description('Whether to create a new storage account or use an existing one when persistenceMode includes azureFile.')
param storageAccountMode string = 'new'

@description('Name of the storage account to create or use for Azure Files persistence. Leave empty to auto-generate only when storageAccountMode=new.')
param storageAccountName string = ''

@allowed([
  'new'
  'existing'
])
@description('Whether to create the Azure Files share or use an existing one when persistenceMode includes azureFile and storageAccountMode=existing. When storageAccountMode=new, the share is always created.')
param fileShareMode string = 'new'

@description('Azure Files share name used when persistenceMode includes azureFile.')
param fileShareName string = 'aoaiproxy'

@secure()
@description('Optional Azure Files storage account key used when persistenceMode includes azureFile. When provided, the container group uses this key directly instead of calling listKeys during deployment.')
param azureFileStorageAccountKey string = ''

@allowed([
  'new'
  'existing'
])
@description('Whether to create a new PostgreSQL flexible server or use an existing one when persistenceMode includes database.')
param databaseServerMode string = 'new'

@description('Name of the PostgreSQL flexible server to create or use. Leave empty to auto-generate only when databaseServerMode=new.')
param databaseServerName string = ''

@allowed([
  'new'
  'existing'
])
@description('Whether to create the PostgreSQL database or use an existing one when persistenceMode includes database and databaseServerMode=existing. When databaseServerMode=new, the database is always created.')
param databaseMode string = 'new'

@description('Name of the PostgreSQL database to create or use. Leave empty to auto-create aoaiproxy only when databaseMode=new.')
param databaseName string = ''

@description('PostgreSQL username used to build the application connection string when persistenceMode includes database.')
param databaseAdminUsername string = 'aoaiproxyadmin'

@secure()
@description('PostgreSQL password used to build the application connection string when persistenceMode includes database. Required only when persistenceMode includes database.')
param databaseAdminPassword string = ''

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
@description('PostgreSQL compute tier used when persistenceMode includes database.')
param databaseTier string = 'Burstable'

@description('PostgreSQL SKU used when persistenceMode includes database. Standard_B1ms is the smallest documented Burstable development size.')
param databaseSkuName string = 'Standard_B1ms'

@allowed([
  '11'
  '12'
  '13'
  '14'
])
@description('PostgreSQL server version used when persistenceMode includes database.')
param databaseVersion string = '14'

@description('PostgreSQL storage size in GB used when persistenceMode includes database.')
param databaseStorageSizeGB int = 32

@description('Allow connections from Azure services to the PostgreSQL server by creating a 0.0.0.0 firewall rule. Enable only when this public ACI deployment cannot reach PostgreSQL through a private or pre-approved network path.')
param allowAzureServicesToDatabase bool = false

@description('Database charset used when persistenceMode includes database.')
param databaseCharset string = 'UTF8'

@description('Database collation used when persistenceMode includes database.')
param databaseCollation string = 'en_US.utf8'

@minLength(2)
@description('Existing Azure OpenAI or Azure AI Foundry account name.')
param cognitiveServicesAccountName string

@description('Resource group that contains the existing Azure OpenAI or Azure AI Foundry account. Defaults to the deployment resource group.')
param cognitiveServicesAccountResourceGroup string = resourceGroup().name

@description('Optional registry login server used only when basic image-pull credentials are required. Leave empty for public images or registries that do not need credentials from this template.')
param acrLoginServer string = ''

@secure()
@description('Optional ACR username.')
param acrUsername string = ''

@secure()
@description('Optional ACR password.')
param acrPassword string = ''

var cognitiveServicesOpenAiUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var azureFileShareContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb')
var normalizedPersistenceMode = toLower(replace(replace(persistenceMode, ' ', ''), '_', ''))
var enableAzureFile = contains(normalizedPersistenceMode, 'azurefile')
var enableDatabase = contains(normalizedPersistenceMode, 'database')
var useStorage = enableAzureFile
var createStorageAccount = useStorage && storageAccountMode == 'new'
var useExistingStorageAccount = useStorage && storageAccountMode == 'existing'
var effectiveStorageAccountName = !empty(storageAccountName)
  ? toLower(storageAccountName)
  : (createStorageAccount ? take('st${toLower(replace(containerGroupName, '-', ''))}${uniqueString(resourceGroup().id, containerGroupName, 'storage')}', 24) : '')
var createFileShare = enableAzureFile && (createStorageAccount || fileShareMode == 'new')
var createDatabaseServer = enableDatabase && databaseServerMode == 'new'
var useExistingDatabaseServer = enableDatabase && databaseServerMode == 'existing'
var effectiveDatabaseServerName = !empty(databaseServerName)
  ? toLower(databaseServerName)
  : (createDatabaseServer ? take('pg-${toLower(replace(containerGroupName, '_', '-'))}-${uniqueString(resourceGroup().id, containerGroupName, 'postgres')}', 63) : '')
var effectiveDatabaseName = !empty(databaseName) ? databaseName : 'aoaiproxy'
var createDatabase = enableDatabase && (createDatabaseServer || databaseMode == 'new')
var databaseServerFqdn = enableDatabase ? '${effectiveDatabaseServerName}.postgres.database.azure.com' : ''
var databaseConnectionString = enableDatabase
  ? 'postgresql://${databaseAdminUsername}:${uriComponent(databaseAdminPassword)}@${databaseServerFqdn}:5432/${effectiveDatabaseName}?sslmode=require'
  : ''
var useImageRegistryCredentials = !empty(acrLoginServer) && !empty(acrUsername) && !empty(acrPassword)
var imageRegistryCredentials = useImageRegistryCredentials ? [
  {
    server: acrLoginServer
    username: acrUsername
    password: acrPassword
  }
] : []
var effectiveAzureFileStorageAccountKey = enableAzureFile
  ? (!empty(azureFileStorageAccountKey)
      ? azureFileStorageAccountKey
      : (createStorageAccount ? storageAccount!.listKeys().keys[0].value : existingStorageAccount!.listKeys().keys[0].value))
  : ''
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
      storageAccountKey: effectiveAzureFileStorageAccountKey
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
output azureFileShareName string = enableAzureFile ? fileShareName : ''
output databaseServerModeOutput string = enableDatabase ? databaseServerMode : ''
output databaseServerNameOutput string = enableDatabase ? effectiveDatabaseServerName : ''
output databaseServerFqdnOutput string = enableDatabase ? databaseServerFqdn : ''
output databaseModeOutput string = enableDatabase ? (createDatabase ? 'new' : 'existing') : ''
output databaseNameOutput string = enableDatabase ? effectiveDatabaseName : ''
output databaseAdminUsernameOutput string = enableDatabase ? databaseAdminUsername : ''
