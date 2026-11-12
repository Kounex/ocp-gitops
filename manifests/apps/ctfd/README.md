# Hosting Open Tech Quest

OpenShift deployment of [Open Tech Quest](https://github.com/open-tech-quest/ctfd-plugin)
with CTFd, MariaDB and Redis. This repository owns the manifests, bootstrap and
cluster integration; the plugin repository owns the application image and docs.

## Deployments

Both instances use namespace `ctfd` on separate clusters.

| Overlay / Argo application | Workers | Total CPU request / limit | Total memory request / limit |
|---|---:|---|---|
| [prod](apps/overlays/prod) / `ctfd-app` — playground | 2 | 225m / 5 cores | 576 MiB / 2.25 GiB |
| [event](apps/overlays/event) / `ctfd-event` — 400-attendee profile, **temporary** (removed after the event) | 8 | 4.75 / 7.5 cores | 1.625 / 3.25 GiB |

- [apps/base](apps/base) contains the shared stack, startup, storage and security.
- The playground uses **https://otq.apps.ocp.kounex.com** and storage class
  `lvms-vg1`. Its Route uses the cluster wildcard certificate and redirects HTTP
  to HTTPS.
- The event overlay uses its cluster's default RWO storage class and an assigned
  Route hostname. Follow the [event cluster runbook](../../../cluster/event/README.md)
  for bootstrap and disposable load testing.

The event allocation comes from the plugin's 0.1.20 measurements. See the
[sizing guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/sizing.md)
for results, limits and retesting guidance. Declared image versions and resource
settings live in the overlays; init and runtime share the same image pin.

## Storage and startup

Three RWO PVCs hold uploads/logs/recovery control (10 GiB), MariaDB (10 GiB) and Redis AOF (1 GiB).
Each component has one replica and uses `Recreate`; upgrades can interrupt service.
Containers use the namespace-scoped `nonroot-v2` grant. NetworkPolicies restrict
web ingress to the OpenShift router and database/cache ingress to CTFd and its
temporary recovery helper. The helper has zero replicas outside a full restore;
the resource totals above are unchanged standing allocations.

The init container waits for MariaDB, runs migrations and performs native setup
once, creating the initial administrator with team mode and public registration.
Existing accounts/settings are preserved. The web server starts after setup;
the administrator bootstrap password is only supplied to the init container.

## Secrets

ExternalSecret [`ctfd-secrets`](apps/base/external-secret.yaml) reads from
`ClusterSecretStore/doppler`: project `ocp`, config `main` on the playground and
an independent `event` config on the event cluster. Required keys:

- `CTFD_SECRET_KEY`
- `CTFD_DB_PASSWORD`
- `CTFD_DB_ROOT_PASSWORD`
- `CTFD_REDIS_PASSWORD`
- `CTFD_ADMIN_PASSWORD`
- `CTFD_BACKUP_WORKER_TOKEN` — independent per instance, exposed only through
  separate ExternalSecret `ctfd-backup-client`, outside captured app credentials

Use URL-safe hex passwords because the template builds database/cache URLs.
Database credential rotation must update the live database account as well as
Doppler; initialization variables do not change an existing account. Restart
affected deployments after rotation. Changing `CTFD_ADMIN_PASSWORD` does not
reset an existing administrator; use native CTFd account settings instead.

## Updates and checks

Each overlay pins `newTag: X.Y.Z@sha256:...`. Renovate proposes CTFd image updates
for review. During the current development phase, deploy each tested plugin
release to the playground first, verify it, then update event to the same version
and digest. Keep both instances current without changing their resource profiles.
Use the pins from the plugin's release notes. Validate from the repository root:

```sh
tools/validate.sh
kustomize build manifests/apps/ctfd/apps/overlays/event
```

Playground and event run **the same MariaDB, 10.11 LTS** (supported to
2028-02), set once in `apps/base/database.yaml`, so what is tested on the
playground holds for the event. Don't pin it per overlay. The event cluster is
temporary; after it is gone this is simply the playground's version. Renovate offers only
10.11 patches until CTFd#2916 (below) is fixed; after that, LTS lines only
(10.11, 11.4, 11.8, x.3 from 12 on), moved on both clusters together while the
event still exists. A major
upgrade can't be undone by reverting the image: rolling back means emptying the
database PVC and restoring a dump, so take one on the target cluster first.
History: the playground ran 12.3.3 for a few hours on 2026-11-07 and was put
back on 10.11.19 the same evening (empty PVC, pre-upgrade dump restored; no
data had changed) to avoid drift from the event.

**Fresh installs need MariaDB 10.11 to 11.8, not 12.x.** MariaDB 12.1 and later
name unnamed foreign keys `1`, `2`, ... instead of `<table>_ibfk_N`, and CTFd's
migration `b295b033364d` drops `awards_ibfk_1` by name, so the init container's
migrations fail on an empty 12.x database (upstream
[CTFd#2916](https://github.com/CTFd/CTFd/issues/2916), open). Checked 2026-11-07:
the plugin's v0.1.22 MariaDB suite fails at that migration on 12.3.3 and passes
(187 tests) on 10.11.19. A database created on 10.11 and upgraded in place keeps
its old names and works, and so does restoring a dump (it carries the names).
So an upgraded database would run, but any fresh install (a rebuilt playground,
the event cluster, `cluster/event/loadtest`) would fail at the init container.
Both clusters stay on 10.11 until CTFd fixes #2916.

Back up MariaDB and uploads before upgrades, then commit/push and check the
corresponding Argo application is Synced/Healthy. Use an explicit kubeconfig when
checking pods, PVCs, ExternalSecret and Route in `ctfd`. Verify `/login` and
`/quest/admin` after rollout. Preserve Secret keys and PVCs; rollback requires a
compatible image/database or restoration of the matching backup.

Both instances connect to an external backup/restore worker through
`otq-backups.apps.ocp.kounex.com`; the prod overlay routes TLS to the host's
private libvirt listener. Its keys, job journal and encrypted repository remain
outside restored SQL/uploads. Named RBAC permits it to read/capture, suspend only
the owning Argo app and scale only CTFd/its helper. The persistent maintenance
marker blocks requests while recovery verifies data; health probes use
`/healthcheck`. Hosting bootstrap skips writes while fenced. Disposable load tests
explicitly remove recovery credentials and integration.

The temporary event retains encrypted, deduplicated
snapshots every 15 minutes with 10-day retention, daily repository checks and
isolated restore verification. Playground backups are on demand. Organizer's
**Backup & Restore** uses the same engine/repository as the schedule, and performs
reviewed full replacement only for qualified snapshots; granular/legacy recovery
stays operator-managed. See the plugin's
[backup guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/backups.md).
Worker installation, private profiles and recovery procedures live in the operator
environment. Event access survives interactive login expiry; revoke it at teardown.

**Deleting the Argo application with its finalizer prunes its PVCs.** Take and
verify a final off-cluster backup before event teardown, then stop both external
timers and revoke their event credential; retain the backup and decryption key.
Configure SMTP in CTFd before relying on password reset or email verification.

For application configuration, use the plugin's
[hosting guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/deployment.md).
For signup, attendance, authoring, demos and running the event, use its
[operations guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/operations.md).
