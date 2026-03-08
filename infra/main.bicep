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
  'azureFile'
  'blob'
])
@description('Persistence mode. azureFile keeps the current Azure Files mount; blob stores config via Blob SDK and managed identity.')
param persistenceMode string = 'azureFile'

@description('Name of the new storage account to create for Azure Files and Blob configuration storage. This template does not select or reuse an existing storage account.')
param storageAccountName string

@description('Azure Files share name used when persistenceMode=azureFile.')
param fileShareName string = 'aoaiproxy'

@description('Blob container name used when persistenceMode=blob.')
param blobContainerName string = 'aoai-proxy-config'

@description('Blob path used for the persisted config file when persistenceMode=blob.')
param configBlobName string = 'config/config.json'

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
var enableAzureFile = persistenceMode == 'azureFile'
var enableBlob = persistenceMode == 'blob'
var storageAccountBlobUrl = 'https://${storageAccountName}.blob.${environment().suffixes.storage}'
var imageRegistryCredentials = empty(acrLoginServer) ? [] : [
  {
    server: acrLoginServer
    username: acrUsername
    password: acrPassword
  }
]
var environmentVariables = [
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
      storageAccountName: storageAccount.name
      storageAccountKey: storageAccount.listKeys().keys[0].value
    }
  }
] : []

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
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

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = if (enableAzureFile) {
  name: 'default'
  parent: storageAccount
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = if (enableAzureFile) {
  name: fileShareName
  parent: fileService
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (enableBlob) {
  name: 'default'
  parent: storageAccount
}

resource blobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableBlob) {
  name: blobContainerName
  parent: blobService
  properties: {
    publicAccess: 'None'
  }
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

resource blobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlob) {
  name: guid(blobContainer.id, containerGroup.id, storageBlobDataContributorRoleId)
  scope: blobContainer
  properties: {
    principalId: containerGroup.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource fileRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableAzureFile) {
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
output blobAccountUrl string = storageAccountBlobUrl
output azureFileShareName string = enableAzureFile ? fileShareName : ''
output blobContainerOutput string = enableBlob ? blobContainerName : ''
