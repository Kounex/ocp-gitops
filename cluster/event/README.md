# Independent event cluster

This entrypoint installs only the Open Tech Quest event platform. It does not
bootstrap the personal cluster's OAuth, certificates, LVM storage or other apps.
No existing cluster entrypoint references this directory.

Use an explicit kubeconfig for the intended cluster for every command. The
cluster needs a default RWO StorageClass and enough per-node CPU for the event
overlay's eight-CPU application request, in addition to platform workloads.

## Bootstrap

1. Apply the Git-tracked Red Hat OpenShift GitOps installation:

   ```sh
   oc --kubeconfig <event-kubeconfig> apply -k cluster/event/bootstrap
   ```

   Wait for the GitOps Operator and the default Argo CD instance in
   `openshift-gitops` to be ready. The bootstrap reuses the existing pinned
   `gitops-1.22` subscription and controller permissions in `_init/`.

2. Create `openshift-operators/doppler-token`, key `token`, with a read-only
   service token scoped to the event's own Doppler config. That config needs
   `CTFD_SECRET_KEY`, `CTFD_DB_PASSWORD`, `CTFD_DB_ROOT_PASSWORD`,
   `CTFD_REDIS_PASSWORD` and `CTFD_ADMIN_PASSWORD`. Use independent, URL-safe
   credentials. Keep the token and secret values out of Git and logs.

3. Apply the Argo CD entrypoint:

   ```sh
   oc --kubeconfig <event-kubeconfig> apply -k cluster/event
   ```

Argo CD installs the Red Hat External Secrets Operator, its operand config and
the Doppler ClusterSecretStore, then deploys the existing `event` overlay through
Application `ctfd-event`. Retries allow time for operator APIs to become ready.
Application `ctfd-event-platform` owns this platform configuration; the event
Application owns the three application deployments and their PVCs.

The event instance starts clean in draft. No load-test participants or progress
are part of this entrypoint. Inspect its generated Route in namespace `ctfd`.
Use a separate disposable namespace/database and separate credentials for load
testing. Keep the clean event instance and its data independent from fixtures.

Bootstrap-only state outside Git: the login credentials/kubeconfig and the
Doppler service-token Secret. All application resource changes go through Git.
Removing the event Application with its finalizer also prunes its PVCs; preserve
backups before storing real event data.

## Disposable capacity test

`test-platform/` adds an independent `ctfd-loadtest` Application using the same
event overlay, three deployments and persistent storage. Its fixture creates
400 synthetic users in 50 teams, 25 demo challenges and 500 historical solves.
Only its bootstrap init container seeds data; normal CTFd endpoints handle the
subsequent load. The fixture refuses any database except `ctfd_loadtest_test`
and preserves progress on restarts. `fixture.py --late` adds solve history for
a later-event polling run without deleting sessions. Run it in the test pod
with `env PYTHONPATH=/opt/CTFd python /loadtest/fixture.py --late`.

The test uses `ClusterSecretStore/doppler-ctfd-loadtest` and bootstrap Secret
`openshift-operators/ctfd-loadtest-doppler-token`, key `token`. Scope that token
to a separate Doppler config with fresh values for all five CTFd secrets.
Never reuse the real event credentials. Private participant credentials are
written inside the test pod at `/run/quest-loadtest/participants.json`.

Include `../test-platform` in `platform/kustomization.yaml` only while testing.
Removing that reference lets Argo prune the test Application, namespace and
PVCs. The clean event Application remains independent. The fixture is a
synthetic test tool and is never part of the event overlay itself.

### Optional Route diagnostics

`loadtest/diagnostics/cold-download` is an optional generator, excluded from the
normal event and disposable fixture. Add it to the disposable kustomization only
while measuring. Its idle Node container runs an anonymous cold HTML/static
check with `node /loadgen/coldcheck.cjs` through the public HTTPS Route.
`client.mjs` also runs 400 native protocol clients using the shipped `polling.ts`;
its copy must match the plugin image under test. Set the client URL constants
to the disposable Route and clean health Route before testing another cluster. This measures HTTP capacity,
not browser rendering. The scheduler preserves normal healthy polling intervals.

Before enabling the generator, provision temporary Secret `ctfd-loadtest-driver` in the disposable
namespace, file/key `private-runtime.json`, containing test-only native sessions.
Provision it privately; never commit credentials or include it in result archives.
Set `OTQ_RUN_ROOT=/work` and invoke `node /loadgen/client.mjs --run <name> --hold 600`.
Results go to `/work/<name>`. Collect request CSVs, final summaries, server CPU /
RAM / throttling, network counters, DB lock waits and pools. Count raw wire
failures and bounded GET retries separately from unrecovered requests; capture
disposal provenance at socket failure and retain late responses. Require finalized
outcomes, zero unexpected errors, all 50 correct flag acknowledgments, all 400
members observing their team solve, and all 400 return/reload actions. Steady
qualification used at least 172.6 successful requests/s and endpoint p95 <=2s.

Retain failed runs. A fixed-rate replay that retains old polls while adding
startup calls is an overload control; actual reloads dispose the old resources.
External connection limits and browser rendering need separate checks even when
origin capacity passes. Remove the diagnostic reference after testing; removing
`../test-platform` prunes its namespace, private session Secret and PVCs. Revoke
and remove the separate bootstrap service token in `openshift-operators` too.

## Application release source

The `ctfd-event` Application keeps its source path in this repository, while its
workload overlay consumes a tagged `open-tech-quest/ctfd-plugin` deployment plus
the same release's event-400 component. Native resources and bootstrap are owned
upstream; External Secrets, Argo resources and cluster integration remain here.
Use `tools/update-ctfd-release.py VERSION --overlay event` to update the upstream
reference and image digest together, validate, commit/push and verify Argo health.
The prod overlay has an independent release pin and retains its small allocation.
