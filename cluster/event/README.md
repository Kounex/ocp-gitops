# Independent event cluster

This entrypoint installs only the Open Tech Quest event platform. It does not
bootstrap the personal cluster's OAuth, certificates, LVM storage or other apps.
No existing cluster entrypoint references this directory.

Use an explicit kubeconfig for the intended cluster for every command. The
cluster needs a default RWO StorageClass and enough per-node CPU for the event
overlay's six-CPU application request, in addition to platform workloads.

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
a later-event polling run without deleting sessions.

The test uses `ClusterSecretStore/doppler-ctfd-loadtest` and bootstrap Secret
`openshift-operators/ctfd-loadtest-doppler-token`, key `token`. Scope that token
to a separate Doppler config with fresh values for all five CTFd secrets.
Never reuse the real event credentials. Private participant credentials are
written inside the test pod at `/run/quest-loadtest/participants.json`.

Include `../test-platform` in `platform/kustomization.yaml` only while testing.
Removing that reference lets Argo prune the test Application, namespace and
PVCs. The clean event Application remains independent. The fixture is a
synthetic test tool and is never part of the event overlay itself.
