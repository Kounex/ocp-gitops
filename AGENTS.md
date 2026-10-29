# ocp-gitops

Argo CD source of truth for the single-node OpenShift cluster `ocp.kounex.com`
(apps under `*.apps.ocp.kounex.com`). The cluster runs as a VM on the big
Hetzner host. Host facts, VM size, SSH access and the cert-expiry recovery
after a long shutdown are in the private it-env repo:
`~/agent/it-env/docs/machines/hetzner.md`. Read that before touching the VM.

**This repo is public, and stays public.** Nothing secret goes in here: no
passwords, tokens, JWT secrets, DSNs with credentials, or private notes.
Secrets come from Doppler through External Secrets
(`ClusterSecretStore/doppler`). Private notes and audits go in `docs/private/`
(gitignored). The audit of 2026-10-22 is `docs/private/audit-2026-10-22.md`
(local only; its status table says what was done).

State (2026-10-29): OpenShift 4.22.19, OpenShift GitOps 1.22 (Argo CD 3.5),
8 vCPU / 32 GiB.

## Rules

- **Git first.** Change the repo, push to `main`, let Argo sync. A manual change
  on the cluster is break-glass only. Mirror it to Git in the same session, or
  list it under "Not in Git" below.
- **CI must pass.** `.github/workflows/validate.yml` runs `tools/validate.sh`
  (kustomize build of every kustomization + kubeconform). Run it before
  pushing when you can. Renovate automerges minor/patch updates only after it
  passes.
- **Image tags:** exact, readable versions, never `latest` (workspace rule in
  `~/agent/AGENTS.md`). Renovate reads the raw `image:` lines.
- **Updates:** Renovate (Saturdays) automerges minor/patch/digest image and
  chart updates after CI; majors and the BlueSpice group wait as PRs. The
  OpenShift version itself is never updated by anything: z-streams on channel
  `stable-4.22` are applied by hand, a new minor is a channel change. Operator
  subscriptions are `Automatic` within their channels. How this fits the rest
  of the fleet (and when a new project should run here rather than on the NAS
  or Hetzner): `docs/version-management.md` and `docs/new-project.md` in the
  private it-env repo.
- **CPU budget:** 8 vCPU / 32 GiB, 7.5 CPU allocatable. The scheduler counts
  **requests**, not usage. Check before adding workloads:
  `oc describe node master-0 | grep -A5 "Allocated resources"` (about 5 of 7.5
  CPU requested on 2026-10-22). Keep requests small; limits can stay generous.
- **Removing an app deletes it.** Workload apps (`manifests/apps/*`) carry the
  `resources-finalizer`: deleting the line in `manifests/apps/kustomization.yml`
  deletes the app's resources, **PVCs included**. Config and operator apps do
  **not** carry it on purpose: removing one leaves its resources running
  unmanaged. Clean those up by hand if that is the intent.
- **Never let Argo delete itself or cluster singletons.** The ArgoCD CR,
  GitopsService and NotificationsConfiguration have `Prune=false`. Moving a
  resource between Applications whose old owner prunes needs `Prune=false`
  first (push, sync), then the move.
- **NAS duplicates:** bracket, nayris, muse and update-day run on the NAS
  (`/volume1/docker/...`) and were removed from here on 2026-10-22. Do not
  bring a cluster copy back while the NAS one shares its tokens (update-day
  shares its Discord token).

## Access

From the NAS (no `argocd` CLI; drive Argo through its CRs with `oc`):

```sh
ssh hetzner
export KUBECONFIG=/root/hetzner-ocp4/ocp/auth/kubeconfig
alias o='oc --insecure-skip-tls-verify'   # why: see it-env hetzner.md
o -n openshift-gitops get applications
```

- Validate locally: `tools/validate.sh` needs kustomize and kubeconform. Neither
  is installed on the NAS; run it on the Hetzner host with throwaway binaries
  in a temp dir, or rely on CI.
- Refresh now: `o -n openshift-gitops annotate application <app> argocd.argoproj.io/refresh=hard --overwrite`
- Sync now (Argo does not retry a revision that already failed):
  `o -n openshift-gitops patch application <app> --type merge -p '{"operation":{"initiatedBy":{"username":"agent"},"sync":{"syncStrategy":{"hook":{}}}}}'`
- Pause one app (survives its parent's self-heal):
  `o -n openshift-gitops annotate application <app> argocd.argoproj.io/skip-reconcile=true`;
  resume with `argocd.argoproj.io/skip-reconcile-`.
- `oc exec` fails cluster-wide while the DevWorkspace webhook pods are not
  running. Fall back to `crictl` on the node (`ssh core@<node>` from the host).
- Argo UI: `https://openshift-gitops-server-openshift-gitops.apps.ocp.kounex.com`
  (OpenShift login; group `cluster-admins` is Argo admin). Cluster console:
  `https://console-openshift-console.apps.ocp.kounex.com`.

## Layout

Bootstrap chain (manual steps only on a fresh cluster, see README):

1. `_init/`: GitOps operator (own namespace, channel `gitops-1.22`) and
   cluster-wide rights for the Argo controller.
2. `cluster/{day1,day2,operators}/`: the `bootstrap-*` Applications.
3. `environment/*`: AppProjects (`configs`, `apps`, `operators`) and the three
   managers: `configs-manager` → `manifests/configs`, `apps-manager` →
   `manifests/apps`, `operators-manager` → `manifests/operators`.
4. `manifests/<area>/<name>/application.yml` is a parent Application whose
   `apps/` folder holds the resources or child Applications.

| Area | Entries |
|---|---|
| operators | `external-secrets` (Red Hat ESO, `stable-v1`), `cert-manager` (Red Hat), `lvm-storage` (channel follows the OpenShift minor: `stable-4.22`) |
| configs | `external-secrets` (ExternalSecretsConfig + Doppler store), `oauth` (htpasswd IdP + login pages built from `apps/login-theme/*.html`), `gitops` (ArgoCD CR, GitopsService, ntfy notifications), `cert-manager` (Let's Encrypt via Cloudflare DNS, API + wildcard certs), `lvm-storage`, `cloudflared` (Cloudflare Tunnel `ocp`, rules in `apps/config.yaml`) |
| apps | `bluespice` (wiki, `wiki.apps.ocp.kounex.com`), `it-tools` |

Projects: `apps` may only use this repo, deploy to `openshift-gitops` and
`bluespice`, and create Namespaces and ClusterRoleBindings. Each child app has
its own project (e.g. `it-tools`: the bjw-s chart repo, its own namespace). A
new app needs its namespace added to `apps` if the parent deploys into it.

## Conventions

The detailed conventions live in `.cursor/rules/` (`gitops-conventions.mdc`,
`app-template-chart.mdc`, `cluster-context.mdc`). They apply to every agent,
not just Cursor. Keep them and this file in sync. In short:

- Sync waves: 200 parent app, 210 AppProject/ServiceAccounts, 220 child apps,
  230 ExternalSecrets and RBAC. Configs and operators use 100–160.
- Single-image apps use the bjw-s `app-template` chart. Multi-part apps use
  plain manifests with a Kustomize `overlays/prod` (bluespice).
- Sync policy `automated: {prune: true, selfHeal: true}`, `CreateNamespace=true`.
  Client-side apply by default. Server-side apply only where another
  controller owns fields (ArgoCD CR, APIServer, IngressController, OAuth,
  GitopsService, NotificationsConfiguration, the login Secrets). When applying
  those by hand, use `--server-side --field-manager=argocd-controller`.
- ExternalSecrets: `external-secrets.io/v1`, `ClusterSecretStore/doppler`,
  annotation `SkipDryRunOnMissingResource=true`.

## Operations

- **Notifications:** Argo pushes to the workspace's ntfy topic when a sync
  fails or an app turns Degraded/Missing (`manifests/configs/gitops/apps/notifications.yml`).
  Test a template: `o -n openshift-gitops exec deploy/openshift-gitops-notifications-controller -- argocd admin notifications template notify ntfy-health <app> --recipient ntfy`
  (that sends a real push).
- **Backups:** BlueSpice writes a daily zip (SQL dump + uploads) into its own
  volume at 04:00 UTC. The NAS timer `ocp-bluespice-backup.timer` (units in
  `tools/backup/systemd/`, installed to `~/.config/systemd/user/`) pulls the
  newest one to `/volume1/docker/ocp-backups/bluespice` at 07:15, keeps 30
  days, and alerts via ntfy on failure or a backup older than 48 h. Each zip
  holds `database.sql` and `filesystem/images/`. A restore has not been
  rehearsed yet.
- **Cluster updates:** channel `stable-4.22`. Before an update take an etcd
  backup (`cluster-backup.sh` on the node, copy to `/root/ocp-backups/` on the
  host; the 2026-10-22 one is there). Move lvm-storage's channel with the
  OpenShift minor. On one node the API drops several times during an update;
  "Failing" in between is normal.
- **Public hostnames via Cloudflare Tunnel:** an app can get
  `<name>.kounex.com` (Cloudflare TLS, optional Authentik login) without a
  Route or certificate. Add a rule to
  `manifests/configs/cloudflared/apps/config.yaml` above the catch-all,
  pointing at the Service (`http://<svc>.<ns>.svc:<port>`), push, then run
  `~/agent/it-env/scripts/tunnel-route.sh add <host> ocp <service> --access|--public`
  on the NAS for the Access app and DNS record. Full guide (all four
  tunnels): `~/agent/it-env/services/cloudflare-tunnels/AGENTS.md`.
- **Renovate:** dashboard is issue #44. BlueSpice images come as one grouped
  PR that is merged by hand (database update runs on sync).

## Gotchas

- **A stuck sync blocks the next one.** If the running operation waits for a
  resource that can never become healthy, Argo will not start a new auto-sync
  for a newer commit. Apply the Git-rendered fix by hand, or let it time out.
- **Argo 2.x leftovers:** objects created before Argo 3 may carry only the old
  `app.kubernetes.io/instance` label and no tracking annotation. Their parent
  then neither prunes nor manages them. A sync of the parent stamps the
  annotation (fixed for all Applications on 2026-10-22).
- **OAuth changes restart the OAuth server.** Re-applying OAuth or the login
  Secrets rolls `oauth-openshift`; the authentication operator and the
  ClusterVersion show "not available" for 1–3 minutes.
- **BlueSpice 5.2.7+** needs `WIKI_ARTICLE_PATH: "wiki"` set explicitly (base
  ConfigMap), or nginx renders `return 301 /` and the probes fail on a redirect
  loop. The installer Job (Sync hook) runs the database update on every sync.
- **OLM can deadlock on a replace chain** (DevWorkspace 0.42 → 0.43 → 1.0.0 on
  2026-10-22). The CSV status can be stale; read the `olm-operator` log for the
  CSV, then delete the stuck middle CSV.

## Not in Git

Cluster state that this repo does not describe:

- Secret `openshift-operators/doppler-token` (Doppler service token for the
  ClusterSecretStore). Without it no ExternalSecret works.
  It is a read-only service token for Doppler project `ocp`, config `main`
  (workplace `rh`); keep it that way. New keys are added with the personal
  token `DOPPLER_TOKEN` in `~/.localrc` on the NAS.
- Key `ntfyTopic` in Secret `openshift-gitops/argocd-notifications-secret`
  (the ntfy topic is the credential; value in `~/.localrc` as `NTFY_TOPIC`).
- Argo's local `admin` account and its non-expiring API token (issued
  2026-05-29), most likely used by Cursor's Argo MCP. A dedicated account with
  its own token would be cleaner; it needs a Cursor config change.
- The ClusterVersion channel (`stable-4.22`) and the GitOps Subscription's
  live object (`_init/` describes it, but `_init` is not synced by Argo).
- Namespace `hm-playground` (a playground deployed by hand, May 2026; stays
  as is).
- Operators installed from the console: Web Terminal and the DevWorkspace
  operator it needs.
- The VM size and CPU weight (libvirt, see it-env).

## Git

Public `github.com/Kounex/ocp-gitops`, branch `main`. Every push to `main`
deploys, so commit finished units only.

Not tracked (`.gitignore`): `docs/private/` (audits, private notes), `.env`,
`.DS_Store`.
