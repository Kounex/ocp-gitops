# Open Tech Quest on CTFd

[Open Tech Quest](https://github.com/Kounex/open-tech-quest) extends CTFd
with event-branded sequential team rooms, shared progress, prize timing,
organizer controls and a 50-team projector. The stack uses MariaDB 10.11
and Redis 7.4, translated from the
[upstream Compose deployment](https://docs.ctfd.io/docs/deployment/installation/).
Argo CD deploys `apps/overlays/prod` into namespace `ctfd`.

Public URL: https://otq.apps.ocp.kounex.com. The edge-terminated Route uses
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
`contact@kounex.com`), an event named `Open Tech Quest`, team user mode,
and public registration. Customize the event through the admin UI.
On subsequent starts it preserves existing accounts and settings, renaming
only the stock `CTFd` placeholder title. The
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

## Application image and event setup

CI in `Kounex/open-tech-quest` builds `ghcr.io/kounex/open-tech-quest`; both
initialization and runtime use the same version/digest. The pinned upstream
CTFd base is extended with a plugin and built React frontend, without a core
fork. Runtime secrets remain the same Doppler keys above.

The plugin creates five empty rooms in **draft**: OpenShift, Ansible, RHEL,
Security and AI. No demo participants, flags or challenges enter the image.
A fresh instance safely switches to team mode; an existing instance with
individual solves refuses conversion until ownership is explicitly migrated.

- Participant app: `/quest` (also the root redirect).
- Organizer app: `/quest/admin`, using the existing CTFd admin login.
- Projector: `/quest/stage`, controlled from the organizer Projector tab.
- Native challenge authoring: `/admin/challenges`.

Configure challenge order, teams, roster release, timing and selected room
assets before opening the event. Use quest lifecycle controls rather than
native time/mode settings; the plugin records pauses/cutoffs and final
publication snapshots. See the application repository's operations guide.

Pre-migration private backup on Hetzner:
`/root/ocp-backups/ctfd/pre-open-tech-quest-2026-11-03/` (SQL and uploads;
contains credentials, never copy into this public repository).

## Organizer demo preview

The organizer Event tab offers explicit **Load demo content** / **Remove demo
content** controls: 25 self-contained practice challenges and Markdown room
introductions. Startup never seeds them. Loading requires draft and unmapped
rooms; durable batch ownership supports targeted cleanup and restoration of
previous introductions without removing real challenges or participant data.
The competition cannot start while demo content is active. See the application
operations guide for preview/removal behavior. The app also supplies the event
Q favicon on participant, login and native administration pages.

## Participant attendance and final rosters

Participants register their own CTFd account and confirm **I'm ready to quest**
in the lobby. **Organize → Teams** persists the maximum group size (default
five), previews random provisional allocation, tracks personal attendance and
shows names/status for each group. Close check-in, review the attendance-based
optimization, then apply its server-bound plan. Changed readiness or rosters
invalidate older previews; no-show accounts are kept unassigned.

Any ready member then chooses the final unique team name once. Organizers can
place late arrivals with a reason or create an additional group if needed.
Finalize rosters before starting the competition; membership stays fixed.
Check-in and naming never start room or event clocks. Native account moderation
remains available. All ownership and progress remain in native CTFd models;
plugin metadata uses the same backed-up MariaDB database and existing secrets.
See [event operations](https://github.com/Kounex/open-tech-quest/blob/main/docs/operations.md).
