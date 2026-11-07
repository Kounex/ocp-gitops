# Hosting Open Tech Quest

OpenShift deployment of [Open Tech Quest](https://github.com/open-tech-quest/ctfd-plugin)
with CTFd, MariaDB and Redis. This repository owns the manifests, bootstrap and
cluster integration; the plugin repository owns the application image and docs.

## Deployments

Both instances use namespace `ctfd` on separate clusters.

| Overlay / Argo application | Workers | Total CPU request / limit | Total memory request / limit |
|---|---:|---|---|
| [prod](apps/overlays/prod) / `ctfd-app` — playground | 2 | 225m / 5 cores | 576 MiB / 2.25 GiB |
| [event](apps/overlays/event) / `ctfd-event` — 400-attendee profile | 8 | 4.75 / 7.5 cores | 1.625 / 3.25 GiB |

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

Three RWO PVCs hold uploads/logs (10 GiB), MariaDB (10 GiB) and Redis AOF (1 GiB).
Each component has one replica and uses `Recreate`; upgrades can interrupt service.
Containers use the namespace-scoped `nonroot-v2` grant. NetworkPolicies restrict
web ingress to the OpenShift router and database/cache ingress to CTFd.

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

Use URL-safe hex passwords because the template builds database/cache URLs.
Database credential rotation must update the live database account as well as
Doppler; initialization variables do not change an existing account. Restart
affected deployments after rotation. Changing `CTFD_ADMIN_PASSWORD` does not
reset an existing administrator; use native CTFd account settings instead.

## Updates and checks

Each overlay pins `newTag: X.Y.Z@sha256:...`. Renovate proposes CTFd image updates
for review. Test the playground before promoting the event, using the version and
digest from the plugin's release notes. Validate from the repository root:

```sh
tools/validate.sh
kustomize build manifests/apps/ctfd/apps/overlays/event
```

MariaDB follows LTS lines only (Renovate `allowedVersions`: 10.11, 11.4, 11.8,
then x.3 from 12 on). The playground runs **12.3 LTS** (in-place upgrade from
10.11 on 2026-11-07, via `MARIADB_AUTO_UPGRADE`). The event overlay pins
**10.11 LTS** (supported to 2028-02) in `patches/resources.yaml` until its own
upgrade is decided. A major upgrade can't be undone by reverting the image:
rolling back means emptying the database PVC and restoring a dump, so take one on
the target cluster first.

Back up MariaDB and uploads before upgrades, then commit/push and check the
corresponding Argo application is Synced/Healthy. Use an explicit kubeconfig when
checking pods, PVCs, ExternalSecret and Route in `ctfd`. Verify `/login` and
`/quest/admin` after rollout. Preserve Secret keys and PVCs; rollback requires a
compatible image/database or restoration of the matching backup.

These manifests define no scheduled off-cluster backup. **Deleting the Argo
application with its finalizer prunes its PVCs.** Configure SMTP in CTFd before
relying on password reset or email verification.

For application configuration, use the plugin's
[hosting guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/deployment.md).
For signup, attendance, authoring, demos and running the event, use its
[operations guide](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/operations.md).
