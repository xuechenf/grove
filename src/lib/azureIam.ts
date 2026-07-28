export function azureIamCommands(subscriptionId: string, suffix: string) {
  const candidate = subscriptionId.trim()
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : '<subscription-id>'
  return [
    'az login',
    `az account set --subscription "${id}"`,
    '',
    `$scope = "/subscriptions/${id}"`,
    '$sp = az ad sp create-for-rbac `',
    `  --name "grove-local-${suffix}" `,
    '  --role "Monitoring Reader" `',
    '  --scopes $scope | ConvertFrom-Json',
    '',
    'az role assignment create `',
    '  --assignee $sp.appId `',
    '  --role "Virtual Machine Contributor" `',
    '  --scope $scope',
    '',
    'az role assignment create `',
    '  --assignee $sp.appId `',
    '  --role "Network Contributor" `',
    '  --scope $scope',
  ].join('\n')
}
