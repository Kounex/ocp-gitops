# Open Tech Quest on CTFd

[Open Tech Quest](https://github.com/open-tech-quest/ctfd-plugin) extends CTFd
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
Use **Organize → Event → Public registration** to open or close self-signup.
Closing signup blocks new native-form accounts; existing users can still log in
and check in where attendance permits. This control preserves CTFd’s existing
setting on startup and records changes in the organizer audit log.

## Event cluster overlay

`apps/overlays/event` prepares the larger configuration for the next
400-participant / 50-team load test on a cluster with sufficient capacity.
The existing `ctfd-app` continues to select `apps/overlays/prod`; adding this
overlay does not resize the current deployment.

| Component | CPU request / limit | Memory request / limit |
|---|---|---|
| CTFd, 8 Gunicorn workers in one pod | 6 / 8 cores | 2 GiB / 4 GiB |
| MariaDB | 1 / 2 cores | 1 GiB / 2 GiB |
| Redis | 250m / 500m | 128 MiB / 256 MiB |
| **Total** | **7.25 / 10.5 cores** | **3.125 GiB / 6.25 GiB** |

The initialization container retains the base's smaller allocation and runs
before the web container, so it does not add to these steady-state totals.
The CTFd pod needs a node that can admit its full 6-CPU / 2-GiB request;
OpenShift services and other workloads need capacity in addition to the table.
This is a configuration to validate, not a proven 400-user capacity guarantee.
It keeps one replica, `Recreate`, the existing PVC sizes and the base's pinned
images. It does not seed event content, participants or progress.

The overlay merges `WORKERS=8` and `SQLALCHEMY_MAX_OVERFLOW=5` into
`ctfd-config`. For the pinned CTFd 3.8.9 / Flask-SQLAlchemy MySQL pool, each
worker can keep up to 10 pooled connections plus at most 5 overflow connections:
120 application connections across eight workers. MariaDB's default limit
is 151, leaving room for initialization and operations. CTFd already exposes
the overflow setting in its optional configuration section; no application
image or startup-command changes are needed. Recheck pool defaults when
updating the upstream CTFd/Flask-SQLAlchemy base.

Build it independently:

```sh
kustomize build manifests/apps/ctfd/apps/overlays/event
```

On the new cluster, configure its Argo CD Application with these source and
destination fields, using a project that permits namespace `ctfd`:

```yaml
spec:
  source:
    repoURL: https://github.com/Kounex/ocp-gitops.git
    targetRevision: main
    path: manifests/apps/ctfd/apps/overlays/event
  destination:
    server: https://kubernetes.default.svc
    namespace: ctfd
```

The event overlay builds directly from `base`, so it does not inherit the
Hetzner `lvms-vg1` storage class or `otq.apps.ocp.kounex.com` hostname. The
new cluster must have a default StorageClass for the three RWO PVCs. With no
explicit Route host, OpenShift assigns one under that cluster's ingress
domain. Inspect `oc -n ctfd get route ctfd` after sync. Add cluster-specific
storage-class or Route-host patches there if required once those values are
known.

Install External Secrets and provision `ClusterSecretStore/doppler` on the
new cluster before syncing this app. Use an event-specific Doppler config
with the five `CTFD_*` keys listed above; the ExternalSecret builds URLs for
the local `database` and `cache` services. Keep that cluster's credentials
and persistent data independent from the current deployment. The namespace,
runtime ServiceAccount, SCC binding and NetworkPolicies come from the base.

Before using this profile for the event, repeat the authenticated 400-user
polling and flag-submission test, including late-event solve history, cold
arrivals and reconnect bursts. The earlier four-worker tests found CPU
pressure and event-write lock contention; larger limits alone do not validate
those paths. Monitor database pool occupancy as well as latency, errors,
traffic, CPU throttling, memory and restarts.

## Application image and event setup

CI in `open-tech-quest/ctfd-plugin` builds `ghcr.io/open-tech-quest/ctfd-plugin`; both
initialization and runtime use the same version/digest. The pinned upstream
CTFd base is extended with a plugin and built React frontend, without a core
fork. Runtime secrets remain the same Doppler keys above.

The plugin creates five empty default rooms in **draft**: OpenShift, Ansible, RHEL,
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

## Organization image source

The public application repository is **open-tech-quest/ctfd-plugin**. CI derives
its lowercase registry namespace from the repository owner, publishes versioned
`ghcr.io/open-tech-quest/ctfd-plugin` images with source/revision labels, and keeps
the existing `vX.Y.Z` sequence. No personal publish token or Doppler secret is
needed by CI. The package is public for anonymous pulls by OpenShift and Renovate.

Both containers pin the tested version and index digest above. The previous
`ghcr.io/kounex/open-tech-quest:0.1.15@sha256:7327e4279f8989129ba3c375911ec8c60d45b291791620e09cf56caf9d4605e2`
remains available as a historical rollback image. The application URL, namespace,
plugin identifier, database, PVCs and ExternalSecret retain their existing IDs.
The organization transfer preserves the repository ID, Git history, tags,
releases and pull requests; old GitHub source URLs redirect to the new repository.

## Organizer demo preview

The organizer Event tab offers explicit **Load demo content** / **Remove demo
content** controls: 25 self-contained practice challenges and Markdown room
introductions. Startup never seeds them. Loading requires draft and unmapped
rooms; durable batch ownership supports targeted cleanup and restoration of
previous introductions without removing real challenges or participant data.
The competition cannot start while demo content is active. See the application
operations guide for preview/removal behavior. The app also supplies the event
Q favicon on participant, login and native administration pages.

## Staff and room authoring

Use **Organize → Users** as a full administrator to promote self-registered
accounts to **Challenge maintainer**. Full administrators remain managed in
native CTFd. Maintainers get only Rooms in Organize and no privileged event,
participant, team or role administration. They are excluded from attendance,
team allocation and play; promotion clears readiness and detaches an unused
provisional assignment. Recorded competition activity prevents conversion.

Both staff roles can create standard flag challenges directly in Rooms, edit
Markdown descriptions and accepted static flags, check answers without progress,
and manage the prerequisite order. Authoring is restricted to Draft without
recorded activity; an administrator must remove the loaded demo before real
challenge authoring. Flags stay in the database and authorized editor responses,
never Git or public bootstrap/audit payloads.

The five topic rooms remain defaults. Room managers can rename display titles,
add custom rooms with a generic theme and remove unused rooms. Removal preserves
native challenges/flags/files and rejects activity or demo ownership. Stable
slugs preserve links on rename; an intentionally empty room list stays empty
across restarts. Navigation and standings follow the configured room list.

## Challenge visibility

The room editor supports native **Hidden**, **Visible** and **Locked** states.
Hidden challenges are omitted from participant paths, prerequisites and
unpublished award counts without deleting solves; restoring visibility restores
eligible credit at its original timestamp. Locked challenges retain their place
and earned credit but deny content and submissions. Staff can preview both.
Native CTFd requirements and next links follow the active room path atomically,
including visibility changes through the stock API. Startup repairs older
derived dependencies while preserving mappings, starts and submissions. A new
room clock requires its first non-hidden step to be Visible; existing clocks
never reset. Published award snapshots stay immutable.

## Account moderation and retained evidence

**Organize → Users** supports **Return to participant**, safe confirmed deletion
of unused accounts, and **Ban / Unban account**. Role transitions clear readiness
and unused provisional assignments. Deletion repairs captain ownership and refuses
history-bearing or frozen memberships. Bans stop the account's solves from counting
without deleting the native records; teammates can legitimately re-solve affected
challenges. Recovery uses a new server timestamp, the same clock/pause/cutoff rules,
and native grading/rate limits. Unbanning restores eligible original contributions
without duplicate credit. Published contribution changes require unpublishing.

User actions and allocation previews bind account incarnations so reused IDs cannot
validate stale requests. Full administrator controls remain native with self/last
admin and history protections. The Users view links to native submission history;
original and `quest_recovery` records remain available for investigation. Restore
matching plugin code with its database; pre-recovery code cannot interpret the
new native submission subtype.

## Participant attendance and final rosters

Participants register their own CTFd account. **Organize → Event / Teams →
Attendance check-in** independently controls when they can confirm **I'm ready
to quest**; capture starts off on installation and this upgrade. Keep it closed
while collecting early registrations. Opening prompts unconfirmed signed-in
participants across Quest within five seconds and on returning to a tab; signup
during the window leads directly to the same prompt. Native account pages show
a link notice without discarding edits. Pages held open from before this release
need one initial refresh to load the new prompt behavior.

Closing rejects new confirmations even from stale forms and retains recorded
attendance. Reopening prompts only unconfirmed people. **Organize → Teams**
persists the maximum group size (default five), tracks personal attendance and
forms random teams from checked-in eligible people only. Morning registration
requires no teams or initial allocation. Close attendance capture before
previewing/applying grouping or finalizing rosters. **Move to attendance review**
also closes capture atomically. Apply the
server-bound plan after review; intervening window changes, readiness or roster
changes invalidate older previews. No-show accounts are kept unassigned.

By default names are **Team 1, Team 2, Team 3, …**, final and locked against user
changes. **Let participants choose team names** enables one-time naming by any
ready teammate before finalization. Enabling after apply opens generated unclaimed
names only; chosen or organizer-corrected identities never reopen. Disabling locks
current names without discarding chosen ones. Naming policy freezes at finalization.
Organizers can place late arrivals with a reason or create an additional group.
Finalize rosters before starting the competition; membership stays fixed.
Check-in and naming never start room or event clocks. Native account moderation
remains available. All ownership and progress remain in native CTFd models;
plugin metadata uses the same backed-up MariaDB database and existing secrets.
See [event operations](https://github.com/open-tech-quest/ctfd-plugin/blob/main/docs/operations.md).

## Event-day cutoff and post-start arrivals

Close registration and attendance at the cutoff. Then **Move to attendance review
→ Preview checked-in teams → Apply reviewed teams → Finalize
rosters → Start event**. Only if participant naming is enabled do members choose
names before finalization. Repeated previews of unchanged state return the same
random proposal; readiness, roster, capacity and naming-policy changes invalidate
it. Closing windows never performs grouping automatically.

After finalization, reopen registration if needed and open late-only attendance
for unassigned newcomers. They confirm their own attendance; an administrator
admits them with a reason into a named team with space or an additional agreed
final-named team. Existing players never move and existing clocks/progress do not
reset. New teams follow the configured event/room timing policy. Late-only capture
and admission work in draft/live/paused before cutoff; close/published events
refuse admission. Checked-in post-finalization arrivals can wait across event
start once capture is closed; they cannot play until placed.
