targetScope = 'resourceGroup'

@minLength(2)
@description('Existing Azure OpenAI or Azure AI Foundry account name.')
param cognitiveServicesAccountName string

@description('Principal ID that should receive Cognitive Services OpenAI User on the target account.')
param principalId string

@description('Role definition ID for the assignment.')
param roleDefinitionId string

resource cognitiveAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: cognitiveServicesAccountName
}

resource llmRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(cognitiveAccount.id, principalId, roleDefinitionId)
  scope: cognitiveAccount
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
  }
}