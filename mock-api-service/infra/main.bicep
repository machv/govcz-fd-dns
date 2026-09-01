targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Container App name.')
param appName string = 'dnsportal-api-mock'

@description('Globally unique Azure Container Registry name.')
param registryName string = toLower('acr${uniqueString(subscription().subscriptionId, resourceGroup().id, appName)}')

@description('Repository and tag built in the provisioned registry.')
param imageName string = 'dnsportal-api-mock:latest'

@description('Deploy the Container App. Set false on the first deployment, build the image, then redeploy with true.')
param deployContainerApp bool = true

@secure()
@description('Password protecting the admin portal.')
param portalPassword string

@description('Container Apps managed environment name.')
param environmentName string = '${appName}-env'

@description('Log Analytics workspace name.')
param logAnalyticsWorkspaceName string = '${appName}-logs'

@description('Expose the service publicly. Set false for environment-internal ingress.')
param externalIngress bool = true

@minValue(0)
@description('Minimum number of replicas. Keep at 1 when Redis is not configured.')
param minReplicas int = 1

@minValue(1)
@description('Maximum number of replicas. Keep at 1 when Redis is not configured.')
param maxReplicas int = 1

@allowed([
  '0.25'
  '0.5'
  '0.75'
  '1.0'
  '1.25'
  '1.5'
  '1.75'
  '2.0'
])
@description('Container CPU cores.')
param cpu string = '0.5'

@allowed([
  '0.5Gi'
  '1Gi'
  '1.5Gi'
  '2Gi'
  '3Gi'
  '3.5Gi'
  '4Gi'
])
@description('Container memory.')
param memory string = '1Gi'

@secure()
@description('Optional Redis URL, preferably rediss://. Leave empty for in-memory state.')
param redisUrl string = ''

@description('Redis key used to store mock state.')
param redisKey string = 'dnsportal-mock:state'

@description('Resource tags.')
param tags object = {}

var redisSecrets = empty(redisUrl) ? [] : [
  {
    name: 'redis-url'
    value: redisUrl
  }
]

var registrySecrets = [
  {
    name: 'registry-password'
    value: registry.listCredentials().passwords[0].value
  }
]

var appSecrets = concat([
  {
    name: 'portal-password'
    value: portalPassword
  }
], redisSecrets, registrySecrets)

var redisEnvironmentVariables = empty(redisUrl) ? [] : [
  {
    name: 'REDIS_URL'
    secretRef: 'redis-url'
  }
  {
    name: 'REDIS_KEY'
    value: redisKey
  }
]

var registryConfiguration = [
  {
    server: registry.properties.loginServer
    username: registry.name
    passwordSecretRef: 'registry-password'
  }
]

var containerAppFqdn = containerApp.?properties.configuration.ingress.fqdn ?? ''

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
    publicNetworkAccess: 'Enabled'
    policies: {
      quarantinePolicy: {
        status: 'disabled'
      }
      retentionPolicy: {
        days: 7
        status: 'disabled'
      }
      trustPolicy: {
        type: 'Notary'
        status: 'disabled'
      }
    }
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerApp) {
  name: appName
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: externalIngress
        allowInsecure: false
        targetPort: 3000
        transport: 'auto'
      }
      registries: registryConfiguration
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'dnsportal-api-mock'
          image: '${registry.properties.loginServer}/${imageName}'
          env: concat([
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'PORTAL_PASSWORD'
              secretRef: 'portal-password'
            }
          ], redisEnvironmentVariables)
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/v1/healthcheck/'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/v1/healthcheck/'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 2
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

output containerAppName string = containerApp.name
output environmentName string = environment.name
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output image string = '${registry.properties.loginServer}/${imageName}'
output fqdn string = containerAppFqdn
output url string = empty(containerAppFqdn) ? '' : 'https://${containerAppFqdn}'
