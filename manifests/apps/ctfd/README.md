# Hosting Open Tech Quest

This repository owns OpenShift manifests for
[Open Tech Quest](https://github.com/open-tech-quest/ctfd-plugin), CTFd, MariaDB and
Redis. The plugin repository owns application images and public behavior/docs.

## Maintained deployment

[Playground](https://otq.apps.ocp.kounex.com) uses namespace `ctfd`, Argo application
`ctfd-app` and overlay [prod](apps/overlays/prod). It now preserves the completed
17 November 2026 event as a living snapshot; resetting or seeding needs explicit
owner intent. Runtime versions are pinned in the overlay, not this README.

| Workers | Total CPU request / limit | Total memory request / limit |
|---:|---|---|
| 2 | 225m / 5 cores | 576 MiB / 2.25 GiB |

[apps/base](apps/base) contains startup, storage and security. Prod uses
`lvms-vg1` storage and an HTTPS Route with the cluster wildcard certificate.
For measured event capacity and retesting, see the plugin's
[sizing guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/sizing.md).

## Storage, startup and secrets

Three RWO PVCs hold uploads/logs/recovery control (10 GiB), MariaDB (10 GiB) and
Redis AOF (1 GiB). Each component is a single replica using `Recreate`; rollouts
interrupt service. The recovery helper normally has zero replicas. Containers
use the namespace-scoped `nonroot-v2` grant, with NetworkPolicies limiting web,
database/cache and temporary recovery-helper ingress.

Initialization waits for MariaDB, runs migrations and performs native CTFd setup
once. Existing accounts/settings survive startup. The bootstrap administrator
password is supplied only to initialization; changing it does not reset an
existing/restored account. Use native account settings for that.

ExternalSecrets read from `ClusterSecretStore/doppler`, project `ocp`, config
`main`. Required keys: `CTFD_SECRET_KEY`, `CTFD_DB_PASSWORD`,
`CTFD_DB_ROOT_PASSWORD`, `CTFD_REDIS_PASSWORD`, `CTFD_ADMIN_PASSWORD`, and separate
`CTFD_BACKUP_WORKER_TOKEN`. The latter is exposed through `ctfd-backup-client`,
outside captured application credentials. Use URL-safe hex values for generated
credential URLs. Database rotation must update the live account as well as the
secret manager; initialization variables do not rotate existing accounts.

## Updates and recovery

The overlay pins `newTag: X.Y.Z@sha256:...` for init/runtime/helper together.
Renovate proposes CTFd changes for review. Deploy tested releases to playground,
keep its data/resources, then verify `ctfd-app` is Synced/Healthy, pods/PVCs and
ExternalSecrets are ready, `/login` works and the site serves the expected version.
Validate from the repository root with `tools/validate.sh` and
`kustomize build manifests/apps/ctfd/apps/overlays/prod`.

MariaDB stays on 10.11 in `apps/base/database.yaml`, with no overlay pin. Native
CTFd migrations rely on historical foreign-key names and fail on fresh MariaDB
12.x databases; see [CTFd#2916](https://github.com/CTFd/CTFd/issues/2916). Qualify
an upgrade and restore path before changing that line. Reverting an image alone
cannot undo a database major upgrade. Preserve PVCs and secrets during updates.

Playground connects to the external backup worker through
`otq-backups.apps.ocp.kounex.com`; prod routes TLS to the host's private listener.
Worker keys, journals and repository stay outside restored SQL/uploads. Scoped
RBAC lets it capture, suspend only the owning Argo app and scale CTFd/its helper.
The persistent maintenance marker blocks writers during full recovery;
`/healthcheck` remains available for probes and bootstrap skips writes while fenced.

Organizer **Backup & Restore** provides on-demand full signed backups and reviewed
replacement for qualified sources. Event JSON exports are reports, not recovery
backups. Two selected 17 November points are retained separately off site; the
workshop's periodic capture/drill schedules and active worker profile are retired.
Private installation, retained-point/key locations and restore instructions live
in the operator environment. Public contract:
[backup guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/backups.md).

Deleting an Argo application carrying its finalizer prunes its resources,
**including PVCs**. Backup and verify before intentional removal.

## Historical workshop paths

`cluster/event/` and [overlay event](apps/overlays/event) remain as historical
scaffolding until the external workshop expires or its Argo is deliberately
detached. They are no longer a rollout target; do not remove source paths that
its Argo may still reference. Playground uses only prod. Disposable load tests
must remove recovery credentials/integration and use isolated data.

Application configuration and event operations belong in the plugin's
[hosting](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/deployment.md)
and [operations](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/operations.md)
guides. Configure SMTP before relying on password-reset emails.
