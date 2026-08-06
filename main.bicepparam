using './main.bicep'

param logicAppName = 'la-govcz-fd'
param keyVaultName = 'kv-la-govcz-fd-machv'
param frontDoorResourceId = '/subscriptions/17ab5b7a-9070-406c-811d-c3bf2b2c9371/resourceGroups/shared/providers/Microsoft.Cdn/profiles/fdmachv'
param dnsGovApiUrl = 'https://dnsportal-api-mock.mangohill-ab4a40a3.francecentral.azurecontainerapps.io'
param govZoneName = 'contoso.gov.cz'
param govDomainId = '25cc0cf3-081d-4cf6-899f-0ab786765a9b'
param govCzApiKey = readEnvironmentVariable('GOVCZ_API_KEY', '')
param grantKeyVaultSecretsOfficerToDeployer = true
param keyVaultTags = {
  SecurityControl: 'Ignore'
}
