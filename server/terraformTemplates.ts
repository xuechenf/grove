import type { ApplicationEnvironment } from '../src/types'

function terraformBlock(source: string, version: string) {
  return {
    required_version: '>= 1.8.0',
    required_providers: {
      [source.split('/').at(-1)!]: { source, version },
    },
  }
}

function outputs(publicIp: string, privateIp: string) {
  return {
    public_ip: { value: publicIp },
    private_ip: { value: privateIp },
  }
}

function awsTemplate(environment: ApplicationEnvironment, publicKey: string) {
  return {
    terraform: terraformBlock('hashicorp/aws', '~> 6.0'),
    provider: { aws: { region: environment.region } },
    data: {
      aws_vpc: { default: { default: true } },
      aws_subnets: {
        default: {
          filter: [{ name: 'vpc-id', values: ['${data.aws_vpc.default.id}'] }],
        },
      },
    },
    resource: {
      aws_security_group: {
        grove: {
          name_prefix: `${environment.slug}-`,
          description: `Grove ${environment.name}`,
          vpc_id: '${data.aws_vpc.default.id}',
          ingress: environment.ingressRules.flatMap((rule) =>
            rule.cidrs.map((cidr) => ({
              description: rule.description,
              protocol: rule.protocol,
              from_port: rule.fromPort,
              to_port: rule.toPort,
              cidr_blocks: [cidr],
            })),
          ),
          egress: [{ protocol: '-1', from_port: 0, to_port: 0, cidr_blocks: ['0.0.0.0/0'] }],
          tags: { Name: environment.slug, 'grove:environment': environment.id },
        },
      },
      aws_key_pair: {
        grove: {
          key_name_prefix: `${environment.slug}-`,
          public_key: publicKey.trim(),
          tags: { 'grove:environment': environment.id },
        },
      },
      aws_instance: {
        grove: {
          ami: environment.imageId,
          instance_type: environment.instanceType,
          subnet_id: '${data.aws_subnets.default.ids[0]}',
          vpc_security_group_ids: ['${aws_security_group.grove.id}'],
          key_name: '${aws_key_pair.grove.key_name}',
          associate_public_ip_address: environment.assignPublicIp,
          root_block_device: [{ volume_size: environment.diskSizeGb, volume_type: 'gp3', encrypted: true }],
          tags: { Name: environment.vmName, 'grove:environment': environment.id },
        },
      },
    },
    output: outputs(
      environment.assignPublicIp ? '${aws_instance.grove.public_ip}' : '',
      '${aws_instance.grove.private_ip}',
    ),
  }
}

function azureTemplate(environment: ApplicationEnvironment, publicKey: string) {
  const ipConfiguration: Record<string, unknown> = {
    name: 'primary',
    subnet_id: '${azurerm_subnet.grove.id}',
    private_ip_address_allocation: 'Dynamic',
  }
  if (environment.assignPublicIp) {
    ipConfiguration.public_ip_address_id = '${azurerm_public_ip.grove[0].id}'
  }
  return {
    terraform: terraformBlock('hashicorp/azurerm', '~> 4.0'),
    provider: { azurerm: { features: {} } },
    resource: {
      azurerm_resource_group: {
        grove: { name: `rg-${environment.slug}`, location: environment.region, tags: { 'grove-environment': environment.id } },
      },
      azurerm_virtual_network: {
        grove: {
          name: `vnet-${environment.slug}`,
          address_space: ['10.42.0.0/16'],
          location: '${azurerm_resource_group.grove.location}',
          resource_group_name: '${azurerm_resource_group.grove.name}',
        },
      },
      azurerm_subnet: {
        grove: {
          name: 'default',
          resource_group_name: '${azurerm_resource_group.grove.name}',
          virtual_network_name: '${azurerm_virtual_network.grove.name}',
          address_prefixes: ['10.42.1.0/24'],
        },
      },
      azurerm_network_security_group: {
        grove: {
          name: `nsg-${environment.slug}`,
          location: '${azurerm_resource_group.grove.location}',
          resource_group_name: '${azurerm_resource_group.grove.name}',
          security_rule: environment.ingressRules.flatMap((rule, ruleIndex) =>
            rule.cidrs.map((cidr, cidrIndex) => ({
              name: `grove-${ruleIndex + 1}-${cidrIndex + 1}`,
              priority: 100 + ruleIndex * 10 + cidrIndex,
              direction: 'Inbound',
              access: 'Allow',
              protocol: rule.protocol === 'tcp' ? 'Tcp' : 'Udp',
              source_port_range: '*',
              destination_port_range: rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort}-${rule.toPort}`,
              source_address_prefix: cidr,
              destination_address_prefix: '*',
              description: rule.description,
            })),
          ),
        },
      },
      azurerm_public_ip: {
        grove: {
          count: environment.assignPublicIp ? 1 : 0,
          name: `pip-${environment.slug}`,
          resource_group_name: '${azurerm_resource_group.grove.name}',
          location: '${azurerm_resource_group.grove.location}',
          allocation_method: 'Static',
          sku: 'Standard',
        },
      },
      azurerm_network_interface: {
        grove: {
          name: `nic-${environment.slug}`,
          location: '${azurerm_resource_group.grove.location}',
          resource_group_name: '${azurerm_resource_group.grove.name}',
          ip_configuration: [ipConfiguration],
        },
      },
      azurerm_network_interface_security_group_association: {
        grove: {
          network_interface_id: '${azurerm_network_interface.grove.id}',
          network_security_group_id: '${azurerm_network_security_group.grove.id}',
        },
      },
      azurerm_linux_virtual_machine: {
        grove: {
          name: environment.vmName,
          resource_group_name: '${azurerm_resource_group.grove.name}',
          location: '${azurerm_resource_group.grove.location}',
          size: environment.instanceType,
          admin_username: environment.systemUser,
          disable_password_authentication: true,
          network_interface_ids: ['${azurerm_network_interface.grove.id}'],
          admin_ssh_key: [{ username: environment.systemUser, public_key: publicKey.trim() }],
          source_image_id: environment.imageId,
          os_disk: [{ caching: 'ReadWrite', storage_account_type: 'Premium_LRS', disk_size_gb: environment.diskSizeGb }],
          tags: { 'grove-environment': environment.id },
        },
      },
    },
    output: outputs(
      environment.assignPublicIp ? '${azurerm_public_ip.grove[0].ip_address}' : '',
      '${azurerm_network_interface.grove.private_ip_address}',
    ),
  }
}

function alicloudTemplate(environment: ApplicationEnvironment, publicKey: string) {
  const rules = Object.fromEntries(
    environment.ingressRules.flatMap((rule, ruleIndex) =>
      rule.cidrs.map((cidr, cidrIndex) => [
        `rule_${ruleIndex + 1}_${cidrIndex + 1}`,
        {
          type: 'ingress',
          ip_protocol: rule.protocol,
          nic_type: 'intranet',
          policy: 'accept',
          port_range: `${rule.fromPort}/${rule.toPort}`,
          priority: 1,
          security_group_id: '${alicloud_security_group.grove.id}',
          cidr_ip: cidr,
          description: rule.description,
        },
      ]),
    ),
  )
  return {
    terraform: terraformBlock('aliyun/alicloud', '~> 1.0'),
    provider: { alicloud: { region: environment.region } },
    data: { alicloud_zones: { available: { available_resource_creation: 'VSwitch' } } },
    resource: {
      alicloud_vpc: { grove: { vpc_name: environment.slug, cidr_block: '10.42.0.0/16', tags: { 'grove-environment': environment.id } } },
      alicloud_vswitch: {
        grove: {
          vswitch_name: `${environment.slug}-default`,
          vpc_id: '${alicloud_vpc.grove.id}',
          cidr_block: '10.42.1.0/24',
          zone_id: '${data.alicloud_zones.available.zones[0].id}',
        },
      },
      alicloud_security_group: {
        grove: { name: environment.slug, vpc_id: '${alicloud_vpc.grove.id}', inner_access_policy: 'Drop' },
      },
      alicloud_security_group_rule: rules,
      alicloud_key_pair: { grove: { key_pair_name: environment.slug, public_key: publicKey.trim() } },
      alicloud_instance: {
        grove: {
          instance_name: environment.vmName,
          image_id: environment.imageId,
          instance_type: environment.instanceType,
          security_groups: ['${alicloud_security_group.grove.id}'],
          vswitch_id: '${alicloud_vswitch.grove.id}',
          key_name: '${alicloud_key_pair.grove.key_pair_name}',
          system_disk_category: 'cloud_essd',
          system_disk_size: environment.diskSizeGb,
          internet_max_bandwidth_out: environment.assignPublicIp ? 10 : 0,
          internet_charge_type: 'PayByTraffic',
          instance_charge_type: 'PostPaid',
          tags: { 'grove-environment': environment.id },
        },
      },
    },
    output: outputs(
      environment.assignPublicIp ? '${alicloud_instance.grove.public_ip}' : '',
      '${alicloud_instance.grove.private_ip}',
    ),
  }
}

export function terraformTemplate(environment: ApplicationEnvironment, publicKey: string) {
  switch (environment.provider) {
    case 'aws':
      return awsTemplate(environment, publicKey)
    case 'azure':
      return azureTemplate(environment, publicKey)
    case 'alicloud':
      return alicloudTemplate(environment, publicKey)
  }
}
