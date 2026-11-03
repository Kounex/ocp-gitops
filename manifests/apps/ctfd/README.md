# CTFd

CTFd, MariaDB 10.11 and Redis 7.4, translated from the
[upstream Compose deployment](https://docs.ctfd.io/docs/deployment/installation/).
Argo CD deploys `apps/overlays/prod` into namespace `ctfd`.

Public URL: https://ctfd.apps.ocp.kounex.com. The edge-terminated Route uses
the ingress controller's existing wildcard certificate and redirects HTTP
to HTTPS. CTFd handles participant and administrator authentication.
This hostname uses the OpenShift router directly, as requested, rather
than the fleet's usual Cloudflare Tunnel.

## Storage and startup

Three `lvms-vg1` RWO PVCs persist uploads and CTFd audit logs (10 GiB),
MariaDB (10 GiB), and Redis AOF (1 GiB). Each deployment uses `Recreate`
to avoid concurrent writers. This is a single-node deployment with brief
downtime during upgrades.

The init container waits for MariaDB, applies CTFd migrations, then runs
the upstream setup flow once. It creates the `admin` account (email
`contact@kounex.com`), a default CTF named `CTFd`, individual user mode,
and public registration. Customize the event through the admin UI.
On subsequent starts it preserves existing accounts and settings. The
web server starts only after setup succeeds, preventing public takeover
of an unclaimed installation. The bootstrap password is not passed to
the web server container.

The dedicated runtime ServiceAccount may use `nonroot-v2` in this namespace
to support upstream fixed UIDs. Containers run without root, additional
capabilities, privilege escalation, or mounted API tokens. NetworkPolicies
restrict web ingress to the router and database/cache ingress to CTFd.

## Secrets

ExternalSecret `ctfd-secrets` uses `ClusterSecretStore/doppler`, project
`ocp`, config `main`, with these keys:

- `CTFD_SECRET_KEY`
- `CTFD_DB_PASSWORD`
- `CTFD_DB_ROOT_PASSWORD`
- `CTFD_REDIS_PASSWORD`
- `CTFD_ADMIN_PASSWORD`

Passwords are generated as URL-safe hex, since database and Redis URLs
are composed by the ExternalSecret template. Preserve this format when
rotating them. Database password changes also require updating the live
database account; environment variables initialize credentials only on
an empty data directory. Restart the affected deployments after rotating
secrets. Changing the bootstrap password does not reset an existing admin;
use CTFd's account settings for that.

Retrieve the initial administrator password locally (do not paste it into
Git or logs):

```sh
doppler secrets get CTFD_ADMIN_PASSWORD --plain --project ocp --config main
```

## Operations

Check `ctfd-app` in Argo CD and the pods, PVCs, ExternalSecret and Route
in namespace `ctfd`. Initial resource requests total 225m CPU and 576 MiB
RAM; the init container replaces rather than adds to the web allocation.
Images are version/digest pinned and tracked by Renovate.

Persistent volumes survive pod restarts, but no scheduled off-cluster
backup is configured for this app. Before storing important event data,
arrange backups covering both MariaDB and uploads. A CTFd admin export
provides a portable event snapshot. Removing this app from the root
kustomization prunes its resources, including all three PVCs.

SMTP is not configured; configure it in CTFd before relying on password
reset or email verification. Registration does not require email verification.
