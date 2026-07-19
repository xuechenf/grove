# Grove Environments Product Requirements Document

Status: Draft for product approval
Last updated: 2026-07-20
Product stage: VM-first multicloud redesign

This document defines the intended Grove Environments product. It supersedes earlier planning drafts for the redesign. `SPEC.md` continues to describe the currently shipped Grove v0.1 behavior until this PRD is implemented.

## 1. Executive Summary

Grove Environments is a local-first desktop application for building, deploying, and operating applications on Linux virtual machines across AWS, Microsoft Azure, and Alibaba Cloud China.

Grove runs as the control plane on the user's workstation. It owns a local workspace containing application source, build history, immutable application versions, artifacts, environment definitions, Terraform state, and operation history. Cloud resources remain in the user's own provider accounts. Grove has no hosted control plane and no Grove-operated artifact service.

The product combines four responsibilities:

1. Build applications from local or remote source inside a managed local workspace.
2. Discover and operate existing cloud VMs, security groups, power state, and metrics through provider APIs.
3. Deploy and operate application versions over SSH, supplemented by provider APIs.
4. Provide the current Grove-style VM console for machine health, terminal access, files, application status, and logs.

An application can be deployed to one or many VMs. Every target VM stores Grove-managed application data under `~/grove/<app-name>` so that the active release, previous release, artifacts, logs, shared files, and runtime state remain inspectable and recoverable.

## 2. Product Vision

> The user manages applications, environments, and VMs. Grove manages the local workspace, cloud infrastructure, remote VM workspaces, and the deployment relationship between them.

Grove should feel like a local, multicloud application platform rather than a collection of cloud consoles and shell scripts. In the happy path, users do not need to run builds, Terraform, SSH copy commands, systemd commands, or DNS API calls manually.

## 3. Problem Statement

Deploying an application to a VM involves several systems that rarely share one lifecycle:

- Source selection and repeatable builds.
- Application artifact retention and rollback.
- Cloud credentials, networking, security groups, keys, VMs, and static addresses.
- SSH bootstrap, upload, process management, health checks, and logs.
- Domain records and TLS.
- Fleet visibility when one application runs on multiple VMs or clouds.

The operational burden grows when the same application must run across global and mainland-China providers. Existing Grove already solves useful parts of VM management, SSH, SFTP, terminal access, runtime sampling, logs, and guarded copilot operations. Grove Environments turns those machine-level capabilities into an application-level lifecycle.

## 4. Goals

### 4.1 Primary goals

- Build application versions locally from a managed workspace.
- Deploy the same immutable version to AWS, Azure, and Alibaba Cloud China VMs.
- Discover and operate existing cloud VMs without granting Grove any resource-creation path.
- Inspect metrics and manage security-group ingress rules and machine power through provider-neutral controls.
- Support local-folder and remote-Git source targets.
- Preserve current Grove VM inventory, SSH, terminal, files, machine status, and log workflows.
- Deploy an application to one or multiple VMs.
- Provide health-gated deployment and rollback.
- Store the complete remote application workspace under `~/grove/<app-name>`.
- Manage SSH, cloud-provider, and Name.com credential profiles in Grove Settings.
- Manage the local workspace location in Grove Settings.
- Automate Name.com DNS records for public environments.
- Make routine workspace and deployment operations invisible in the happy path while retaining diagnostics and escape hatches.

### 4.2 Non-goals for the VM MVP

- Container deployment.
- Kubernetes.
- A Grove-hosted control plane or artifact store.
- Team accounts, shared workspaces, or distributed locking.
- Hosted CI/CD.
- Managed databases, queues, or caches.
- Creating complete cloud networks, NAT gateways, or complex routing topologies.
- Health-aware global traffic management.
- Windows VM workloads.
- Autonomous autoscaling while the local controller is offline.
- Automatically pushing local source to a remote repository.
- Creating, cloning, or terminating cloud VMs or other cloud resources.

## 5. Product Principles

1. **Local-first ownership.** Source, builds, artifacts, desired state, and credentials stay under the user's control.
2. **Two operational roots.** Virtual Machines and Applications are equal, explicit top-level sections: machines own host operations; applications own build and deployment operations.
3. **Confirm before cloud mutation.** Firewall, power, and destructive Terraform cleanup actions are reviewed before execution.
4. **Immutable versions.** Every successful build creates a new version with a content digest.
5. **Health before success.** Builds, deployments, and rollouts are not marked successful until their configured checks pass.
6. **Rollback is a first-class operation.** Current and previous healthy versions are protected locally and on target VMs.
7. **Provider differences remain visible.** Grove normalizes the common lifecycle without hiding important provider-specific capabilities or errors.
8. **Credentials are profiles, not scattered fields.** Applications, VMs, and environments reference centrally managed credential profiles.
9. **No manual workspace administration in the happy path.** Grove creates, locks, repairs, migrates, and cleans its own managed data.
10. **Deterministic core, assisted operations.** Every core workflow works without the copilot; the copilot may explain, diagnose, and prepare guarded actions.

## 6. Target Users and Use Cases

### 6.1 Target users

- Individual developers operating a small application fleet.
- Small teams without a dedicated platform engineering function.
- Operators managing global and mainland-China deployments.
- Agencies managing applications in customer-owned accounts.
- Developers who want more ownership than a hosted PaaS and less repetition than raw infrastructure tools.

### 6.2 Core use cases

- Import a local project, build a version, and deploy it to an existing VM.
- Discover existing AWS, Azure, or Alibaba Cloud VMs and deploy an application to them.
- Deploy the same version to multiple VMs.
- Roll out a new version one VM at a time and stop when health fails.
- Observe machine health and application health in one view.
- Tail and search application logs across multiple VMs.
- Roll back to the previous healthy version.
- Add a Name.com hostname pointing to one or more public VM addresses.
- Add or rotate an SSH or provider credential once and update its consumers by reference.

## 7. Domain Model

| Object | Definition |
| --- | --- |
| Workspace | Grove-managed local root containing applications and local system state |
| Application | Long-lived service or product with one source target and many versions |
| Source target | Local folder or remote Git repository used as build input |
| Application version | One immutable successful build and its packaged artifact |
| Environment | Named deployment target such as development, staging, or production |
| VM | Existing Linux machine reachable by Grove through SSH and optionally a provider API |
| Application instance | One application installed on one VM |
| Deployment | Attempt to move one or more application instances to a desired version |
| Infrastructure workspace | Environment-specific Terraform configuration, plan, lock, and state |
| Credential profile | Securely stored SSH, cloud-provider, Name.com, or copilot credential reference |

An environment contains one or more target VMs and one desired application version. Each VM has an independently observed application instance, allowing the environment to report healthy, deploying, degraded, diverged, failed, or unknown states.

## 8. Information Architecture

The left sidebar has exactly two primary operational sections. Settings remains a global utility at the bottom of the sidebar and is not a third operational section.

```text
Virtual machines
  Fleet overview
  VM overview
    Machine status and resources
    Applications and service status
    SSH terminal and command execution
    Logs
    Files
    Activity
    Management configuration

Applications
  Application overview and status
  Configuration
  Source and builds
  Versions and artifacts
  Environments and deployed VMs
  Deployments and rollback history
  Combined application logs

Settings
  Workspace
  SSH credentials
  Cloud providers
  Name.com
  Copilot
  Appearance
```

Selecting **Virtual Machines** replaces the sidebar's contextual list with every managed VM, including provider, connection state, and application count. Selecting a VM opens the familiar Grove machine-management surface: status and resource metrics, SSH terminal and commands, application/service status, logs, files, activity, and management configuration.

Selecting **Applications** replaces the contextual list with every Grove application. Selecting an application opens its status, configuration, source and build controls, versions, deployment history, deployed VMs, environments, public access, and combined logs. Deployments and versions are application-owned history, not separate primary navigation destinations.

The copilot is available as a collapsible application, environment, or VM assistant. It does not permanently consume the main operational workspace.

## 9. Managed Local Workspace

### 9.1 User contract

The user selects or creates one workspace during onboarding. Grove Settings shows its location, status, free space, and maintenance actions.

Routine users do not need to create folders, name build directories, locate artifacts, edit Terraform state, or clean temporary files. Advanced actions may reveal the workspace, export diagnostics, verify integrity, relocate it, or repair it.

### 9.2 Layout

```text
<workspace>/
  .grove/
    workspace.db
    settings.json
    locks/
    operations/

  <app-name>/
    grove.yaml
    source/

    .grove/
      versions/
        <version-id>/
          manifest.json
          source-manifest.json
          artifact.tar.zst
          artifact.sha256
          build.log

      environments/
        <environment-id>/
          terraform/
          deployment.json

      build-work/
      cache/
```

Application names are readable lowercase slugs containing letters, numbers, and hyphens.

### 9.3 Ownership boundary

User-editable data:

- Application source under `source/`.
- `grove.yaml`.
- Application documentation.

Grove-managed data:

- Source snapshots.
- Build work directories.
- Version artifacts and manifests.
- Build and deployment logs.
- Terraform files and state.
- Operation journals and locks.
- Cache and retention metadata.

Grove never builds directly in the editable source directory and never overwrites or deletes local source as part of a normal build.

### 9.4 Reliability requirements

- Global workspace schema version.
- Per-application and per-environment operation locks.
- Atomic move from temporary to final version directories.
- Durable operation journals and restart recovery.
- Disk-space preflight checks.
- Automatic cleanup of abandoned temporary work.
- Protected current and rollback artifacts.
- Integrity verification using SHA-256.
- Automatic backup before schema migration or relocation.
- No application version registered before a complete successful build.

## 10. Source Targets

### 10.1 Local folder

Grove imports a selected local folder into the application's managed `source/` directory. The original external folder remains untouched. The managed copy becomes the build source.

Git is optional. Grove does not automatically commit, reset, push, or change branches.

### 10.2 Remote Git repository

Grove clones the repository into the managed `source/` directory and records the remote URL, selected branch or tag, and resolved commit SHA. Synchronization is allowed only when the controlled checkout is clean. Authentication may use an SSH credential profile or a repository-specific credential added in a later milestone.

Remote repositories are read-only source origins in the MVP. Automatic repository creation and pushing are out of scope.

### 10.3 Source snapshot

Every build starts from a frozen source snapshot:

1. Resolve or refresh the source target.
2. Apply `.gitignore` and Grove exclusion rules.
3. Block known secret-bearing and generated files.
4. Copy the selected inputs into an isolated build directory.
5. Calculate a source digest.
6. Execute the build against the frozen snapshot.

Changes made to editable source during a running build do not alter that build.

## 11. Build and Application Versions

### 11.1 Build behavior

All builds run on the local workstation inside Grove's managed application workspace. Build output streams into the UI and a durable build log. Builds are cancellable and subject to timeouts and disk quotas.

Build-time secrets are unavailable by default. A later milestone may support explicitly scoped build secrets.

### 11.2 Target compatibility

Because the desktop may run on Windows while target VMs run Linux, each build records a build engine and target platform:

- Native local build.
- WSL Linux build on Windows.
- Local Docker or Podman builder.

Containerized building does not imply container deployment. It is a mechanism for producing Linux-compatible VM artifacts.

### 11.3 Version identity

Every successful build creates a new version, even when the source digest matches a prior version. A version records:

- Stable version ID.
- Source type, source digest, and optional Git commit.
- Build recipe digest.
- Build engine, OS, architecture, and runtime versions.
- Build start, duration, and result.
- Artifact path, size, and SHA-256 digest.
- Deployment references and retention protection.

### 11.4 Artifact contents

Artifacts contain only declared build output and required runtime manifests. They exclude source-control metadata, tests unless explicitly included, local environment files, credentials, Terraform state, caches, logs, and Grove workspace data.

Retention must never remove an artifact that is currently deployed or protected as an immediate rollback target.

## 12. Infrastructure Management

### 12.1 Responsibility split

Terraform owns persistent infrastructure configuration:

- VM creation and replacement.
- Existing network and subnet attachment.
- Security groups or NSGs.
- Static public IPs.
- SSH public-key registration.
- Disks and resource tags.
- Future load balancers and scaling groups.

Provider APIs handle:

- Credential validation.
- Region and resource discovery.
- Power state, start, stop, and reboot.
- Metrics and provider diagnostics.
- Observed-state reconciliation.

SSH/SFTP handles the universal guest deployment contract. Provider-native command APIs may assist with bootstrap or recovery, but the MVP cannot depend on provider-specific file-upload behavior.

### 12.2 Provider mapping

| Capability | AWS | Azure | Alibaba Cloud China |
| --- | --- | --- | --- |
| VM | EC2 | Linux Virtual Machine | ECS |
| Network | VPC/Subnet | VNet/Subnet | VPC/VSwitch |
| Firewall | Security Group | Network Security Group | Security Group |
| Static address | Elastic IP | Static Public IP | EIP |
| SSH public key | EC2 key pair | VM SSH key | ECS key pair |
| Metrics | CloudWatch | Azure Monitor | CloudMonitor |

### 12.3 Terraform workflow

1. Generate a provider-specific module from normalized inputs.
2. Initialize a version-pinned provider workspace.
3. Create a saved plan.
4. Parse the plan into a user-facing resource summary.
5. Require confirmation for create, update, and destroy.
6. Apply the exact reviewed plan.
7. Record outputs and reconcile observed resources.

Terraform state remains local and must not receive cloud credentials, SSH private keys, Name.com tokens, or application secrets as inputs. Credential profiles are materialized into the Terraform subprocess environment only for the duration of an operation.

## 13. VM Management

Grove retains the current machine-management experience.

### 13.1 Machine status

- Provider power state and resource identity.
- SSH connectivity and host-key status.
- OS, architecture, kernel, and uptime.
- CPU, load, memory, disk, and network usage.
- Running services and top processes.
- Grove workspace disk use.
- Installed application instances and their health.
- Alerts and recent failures.

### 13.2 Machine operations

- Interactive SSH terminal.
- Local and remote file browser and transfer.
- Explicit command execution.
- Provider API start, stop, and reboot.
- SSH connection test and credential reassignment.
- Application start, stop, restart, redeploy, rollback, and log access.
- Activity and audit history.

Interactive terminals and Grove deployments use separate SSH channels.

## 14. Remote VM Workspace

Every managed VM uses `~/grove`. Host-level metadata lives under `~/grove/.grove`. Each deployed application uses:

```text
~/grove/<app-name>/
  state.json

  artifacts/
    <version-id>.tar.zst
    <version-id>.sha256

  releases/
    <version-id>/
    <previous-version-id>/

  current -> releases/<version-id>
  previous -> releases/<previous-version-id>

  shared/
    config/
    data/
    cache/

  runtime/
    service.env
    service.pid
    service.unit
    health.json

  logs/
    stdout.log
    stderr.log
    application.log
    deployments/
    archive/
```

The remote artifact digest must match the local canonical version before extraction or activation.

Grove may reconcile its local understanding from remote `state.json`, but it never deletes an unknown `~/grove` application folder automatically.

## 15. Application Deployment

### 15.1 Preflight

Before changing any target, Grove checks:

- Artifact integrity.
- SSH reachability and pinned host key.
- Target OS and architecture.
- Available disk space.
- Runtime prerequisites.
- Application port conflicts.
- Current and rollback versions.
- Environment target membership.

A failed preflight changes nothing.

### 15.2 Single-VM deployment

1. Upload the selected artifact to a temporary remote path.
2. Verify SHA-256.
3. Move the artifact into the application artifact store.
4. Extract into a new release directory.
5. Install release-time dependencies.
6. Write nonsecret runtime configuration and secret material through the guarded credential path.
7. Start the candidate release.
8. Run the configured health check.
9. Atomically switch `current` and update `previous`.
10. Persist local and remote deployment records.

Failed upload, extraction, release preparation, start, or health validation leaves the active release untouched.

### 15.3 Multi-VM deployment

An environment can target multiple VMs. Artifact upload may run with bounded concurrency because it does not affect active releases.

Activation strategies:

- All at once for development environments.
- Rolling for production environments.

The default rolling policy updates one VM, validates health, then proceeds. When a target fails, Grove stops the rollout and rolls back already changed VMs by default. The environment reports target-level and aggregate status throughout the operation.

### 15.4 Aggregate environment status

| Status | Meaning |
| --- | --- |
| Healthy | Every required VM runs the desired healthy version |
| Deploying | At least one target is being updated |
| Degraded | Some targets are unhealthy or unreachable |
| Diverged | Targets run different versions outside an active rollout |
| Failed | The desired version is not healthy on any required target |
| Unknown | Grove cannot inspect enough targets to determine health |

### 15.5 Rollback

If the previous release remains on the VM, Grove switches the symlink and restarts the service. If it has been removed, Grove reuploads the protected local artifact and recreates the release. Rollback requires no source refresh, rebuild, Terraform operation, or cloud artifact store.

## 16. Service, Health, and Logs

### 16.1 Service management

The preferred Linux implementation is a user-level systemd service owned by the SSH deployment user. One-time bootstrap may enable user lingering so services survive logout and reboot.

Grove can start, stop, restart, reload, enable, disable, and inspect the service. Service configuration always references `~/grove/<app-name>/current`.

### 16.2 Application status

Per application instance, Grove shows:

- Desired, active, and previous version.
- Service state, PID, and uptime.
- Health state and latency.
- Listening port.
- CPU and memory use.
- Workspace disk use.
- Last deployment and failure.
- Configuration and artifact digests.
- Drift from desired state.

### 16.3 Logs

Logs remain under the remote application folder. Grove supports live tailing, bounded search, download, rotation status, deployment logs, and a combined multi-VM view that prefixes each line with the VM name.

## 17. Networking, Domain, and TLS

The VM MVP supports an existing network and either a reachable private address or a static public IP. Public SSH must be restricted to a user-approved CIDR and must never default to `0.0.0.0/0`.

Name.com integration:

1. Validate a Name.com credential profile.
2. Confirm that the selected domain uses Name.com DNS.
3. Create or update only Grove-owned DNS records.
4. Record provider record IDs for safe reconciliation and deletion.
5. Point a hostname to one or more static public VM IPs.
6. Configure the shared VM reverse proxy and validate HTTPS.

Multiple A records provide basic DNS distribution but not health-aware routing. Provider load balancers are a later milestone.

## 18. Settings and Credential Management

Grove Settings is the central control plane for the workspace and credential profiles.

### 18.1 Workspace settings

- Current workspace path.
- Choose or create workspace.
- Reveal in file manager.
- Free space and health status.
- Verify integrity.
- Relocate workspace with copy, verification, atomic switch, and rollback.
- Export diagnostics.
- Cache and artifact retention limits.

### 18.2 SSH credential profiles

Supported profile types:

- Imported private-key file.
- Grove-generated Ed25519 key.
- SSH agent.
- Password authentication only when explicitly enabled.
- Optional bastion/jump-host configuration.

Each profile shows its name, fingerprint, public-key path or agent status, last test, and referencing VMs. Private key material is never displayed after import. Deleting a profile is blocked while VMs reference it unless they are reassigned.

### 18.3 Cloud-provider credential profiles

Supported providers:

- AWS profile, access key, or assumed-role configuration.
- Azure tenant, subscription, and service-principal configuration.
- Alibaba Cloud RAM AccessKey profile with China-region awareness.

Each profile supports test, rename, replace secret, set default, show referencing environments, and remove when unused. Grove surfaces the verified identity, account or subscription, and available regions without exposing secret values.

### 18.4 Name.com profiles

Each profile contains a Name.com username and API token, plus verified accessible domains and last test result. Applications and environments reference the profile by ID. Deleting an in-use profile requires reassignment and must not delete DNS records.

### 18.5 Copilot and appearance

Existing copilot-provider and theme settings remain available as separate sections.

### 18.6 Storage and security

- Secret values are stored in the OS credential vault where available.
- Local state stores profile IDs, labels, nonsecret metadata, and usage references.
- Secrets are materialized only into the operation that needs them.
- Terraform receives cloud credentials through a short-lived process environment.
- SSH operations resolve an SSH profile immediately before connection.
- Name.com tokens are available only to the DNS driver.
- Credentials, private keys, Terraform state, and secret values are excluded from logs and copilot context.
- Test operations are read-only.
- Credential replacement never silently mutates unrelated resources.

## 19. Happy-Path User Flows

### 19.1 First-run setup

1. Choose a local workspace folder.
2. Add an SSH credential.
3. Optionally connect AWS, Azure, Alibaba Cloud, and Name.com.
4. Add the first application.

### 19.2 Build and deploy to an existing VM

1. Import local source or clone a remote repository.
2. Confirm detected build and run configuration.
3. Select Build new version.
4. Add or select an existing VM.
5. Select Deploy.
6. Observe upload, activation, and health validation.

### 19.3 Connect and operate cloud VMs

1. Import or select a cloud-provider credential profile.
2. Let Grove discover existing VMs across configured regions.
3. Match or add SSH access for the selected machines.
4. Review machine metrics and security-group ingress.
5. Deploy a selected application version.
6. Optionally attach a Name.com hostname.

### 19.4 Multi-VM rollout

1. Select an environment with multiple target VMs.
2. Choose an application version.
3. Review rolling policy and preflight results.
4. Start deployment.
5. Observe per-target progress and aggregate health.

## 20. MVP Scope

The VM MVP includes:

- One managed local workspace.
- Multiple applications.
- Local-folder and remote-Git source targets.
- Local immutable builds and artifacts.
- Native, WSL, or local-container build engines as available.
- Existing Ubuntu VMs only; cloud resource creation and termination are unavailable.
- AWS, Azure, and Alibaba Cloud China provider connections.
- Provider-neutral inventory, metrics, power controls, and ingress security-group management.
- Central SSH, cloud, and Name.com credential management.
- Single- and multi-VM environments.
- SSH/SFTP deployment, terminal, files, machine status, application status, and logs.
- Rolling deployment and rollback.
- Name.com DNS records and basic TLS proxy setup.
- Workspace and operation recovery.

## 21. Post-MVP Direction

- Managed load balancers and health-aware routing.
- Autoscaling groups and immutable provider images.
- Remote or shared workspaces.
- Hosted Git and CI/CD integrations.
- Provider secret-manager references.
- Container build and deployment mode.
- Team collaboration and policy controls.
- Windows workloads.
- Distributed operation runners.

## 22. Acceptance Criteria

The MVP is complete when:

- The left sidebar has exactly two primary operational sections: Virtual Machines and Applications.
- The Virtual Machines section lists the complete managed fleet and each VM opens machine status, SSH and terminal, application services, logs, files, activity, and management configuration.
- The Applications section lists every application with health and active-version context; each application opens configuration, builds, version history, deployments, deployed VMs, rollback, and combined logs.
- A user can choose a workspace and never manually administer Grove's internal files in a successful workflow.
- A local or remote source target can produce an immutable local version and artifact.
- Builds use frozen source snapshots and do not modify editable source.
- The same version can deploy to AWS, Azure, and Alibaba Cloud China VMs.
- One application can deploy to multiple VMs with target-level status.
- Every remote application is contained under `~/grove/<app-name>` with artifacts, releases, logs, and rollback state.
- Artifact digests are verified before activation.
- Failed deployments leave the current version running.
- Rolling deployment stops and rolls back according to policy when health fails.
- VM pages expose SSH, terminal, files, machine status, application status, and logs.
- Settings centrally manages workspace location and SSH, cloud-provider, and Name.com profiles.
- Credential tests do not mutate external resources.
- No UI, local API, or Kimi tool can create or terminate cloud resources.
- Firewall and power mutations require confirmation and are recorded in activity history.
- Legacy Terraform cleanup can only apply a reviewed destroy plan for a recorded Grove-owned environment.
- Name.com operations modify only recorded Grove-owned DNS entries.
- Grove can restart during a build or deployment and recover to a clear, safe state.

## 23. Success Measures

- Time from imported source to first healthy existing-VM deployment.
- Time from provider connection to first healthy deployment on a discovered VM.
- Percentage of deployments completed without manual shell intervention.
- Rollback success rate.
- Orphaned resource rate after destroy.
- Workspace recovery success after interrupted operations.
- Cross-provider acceptance-suite parity.
- Credential-test and SSH-connection success rates.

## 24. Major Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Windows builds produce Linux-incompatible artifacts | Record target platform and support WSL or local container builders |
| Terraform state contains sensitive infrastructure data | Restrictive local permissions; never pass secrets or private keys through Terraform inputs |
| Local workspace loss removes build history | Workspace backup/export and integrity tooling; remote sharing later |
| SSH access is unavailable on a discovered VM | Preflight, clear credential mapping, and a reachable public or private network path |
| Multi-VM rollout leaves versions diverged | Durable per-target journal, default stop-and-rollback policy, explicit reconciliation |
| DNS points to unhealthy machines | Health before record creation; clearly label basic multi-A distribution as non-health-aware |
| Credential rotation breaks consumers | Stable profile IDs, usage inventory, test-before-replace, reassignment workflow |
| Workspace automation damages source | Strict source/Grove ownership boundary, frozen build snapshots, no destructive Git automation |
| Existing Grove monolith grows further | Introduce application, environment, workspace, Terraform, credential, and deployment domain services |

## 25. Delivery Sequence

1. Managed workspace, settings profile model, and application/source domain.
2. Local build/version/artifact pipeline with simulated deployment tests.
3. Existing-VM SSH deployment using `~/grove/<app-name>`.
4. VM application status, logs, rollback, and reconciliation.
5. Multi-VM environments and rolling deployment.
6. Provider-neutral existing-VM control plane and AWS vertical slice.
7. Azure and Alibaba Cloud China existing-VM provider parity.
8. Name.com DNS and reverse-proxy integration.
9. Cross-provider acceptance testing and desktop release hardening.
