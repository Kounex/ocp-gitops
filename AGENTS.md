# ocp-gitops

Argo CD source of truth for the single-node OpenShift cluster `ocp.kounex.com`
(apps under `*.apps.ocp.kounex.com`). The cluster runs as a VM on the big
Hetzner host. Host facts, VM size, SSH access and the cert-expiry recovery
after a long shutdown are in the private it-env repo:
`~/agent/it-env/docs/machines/hetzner.md`. Read that before touching the VM.

**This repo is public.** Nothing secret goes in here: no passwords, tokens,
JWT secrets, DSNs with credentials, or private notes. Secrets come from Doppler
through External Secrets (`ClusterSecretStore/doppler`). Private notes and
audits go in `docs/private/` (gitignored).

Open work: the audit of 2026-10-22, `docs/private/audit-2026-10-22.md`
(local only). Work through it before adding new things.

## Rules

- **Git first.** Change the repo, push to `main`, let Argo sync. A manual change
  on the cluster is break-glass only. Mirror it to Git in the same session, or
  list it under "Not in Git" below.
- **Image tags:** exact, readable versions, never `latest` (workspace rule in
  `~/agent/AGENTS.md`). Renovate reads the raw `image:` lines, so when an app
  also pins tags in kustomize `images:`, bump both.
- **CPU budget:** 8 vCPU / 32 GiB, 7.5 CPU allocatable. The scheduler counts
  **requests**, not usage. Check before adding workloads:
  `oc describe node master-0 | grep -A5 "Allocated resources"`. Keep requests
  small; limits can stay generous.
- **Disabling an app does not delete it.** Commenting it out in
  `manifests/apps/kustomization.yml` removes the parent Application, but the
  Applications carry no `resources-finalizer`, so the workloads keep running
  unmanaged (that is how `ctfd`, `sharry`, `test` and `mirror-test` were left
  behind). After disabling, delete the child Application and the namespace by
  hand. Check for PVC data first.
- **Duplicates:** bracket, nayris, muse and update-day also run on the NAS
  (`/volume1/docker/...`), and the NAS copies are the live ones. Do not
  re-enable a cluster copy that shares a token with a NAS service (update-day
  shares its Discord token).

## Access

From the NAS (no `argocd` CLI; drive Argo through its CRs with `oc`):

```sh
ssh hetzner
export KUBECONFIG=/root/hetzner-ocp4/ocp/auth/kubeconfig
alias o='oc --insecure-skip-tls-verify'   # why: see it-env hetzner.md
o -n openshift-gitops get applications
```

- Render locally before pushing: there is no kustomize on the NAS; copy the
  folder to the Hetzner host and run `oc kustomize <dir>` there.
- Refresh now: `o -n openshift-gitops annotate application <app> argocd.argoproj.io/refresh=hard --overwrite`
- Sync now (Argo does not retry a revision that already failed):
  `o -n openshift-gitops patch application <app> --type merge -p '{"operation":{"initiatedBy":{"username":"agent"},"sync":{"syncStrategy":{"hook":{}}}}}'`
- `oc exec` can fail cluster-wide while the DevWorkspace webhook pods are not
  running. Fall back to `crictl` on the node (`ssh core@<node>` from the host).
- Argo UI: `https://openshift-gitops-server-openshift-gitops.apps.ocp.kounex.com`
  (OpenShift login; group `cluster-admins` is Argo admin).

## Layout

Bootstrap chain (manual steps only on a fresh cluster):

1. `_init/`: `oc apply -k _init` installs the GitOps operator Subscription and
   gives the Argo controller cluster-wide rights.
2. `cluster/{day1,day2,operators}/`: apply once by hand. Each creates a
   `bootstrap-*` Application pointing at `environment/*`.
3. `environment/*`: the AppProjects (`configs`, `apps`, `operators`) and the
   three managers: `configs-manager` → `manifests/configs`,
   `apps-manager` → `manifests/apps`, `operators-manager` → `manifests/operators`.
4. `manifests/<area>/<name>/application.yml` is a parent Application whose
   `apps/` folder holds the real resources or child Applications.

| Area | Enabled | What |
|---|---|---|
| operators | external-secrets (community, v0.11), cert-manager (Red Hat), lvm-storage | OLM Subscriptions |
| configs | external-secrets (Doppler store), auth (htpasswd IdP), login-theme, cert-manager (Let's Encrypt via Cloudflare DNS, API/wildcard certs, **also the ArgoCD CR**), lvm-storage | cluster config |
| apps | bluespice, bracket, it-tools, nayris | workloads |

Enable or disable a whole area entry by (un)commenting its line in that area's
`kustomization.yml`.

## Conventions

The detailed conventions live in `.cursor/rules/` (`gitops-conventions.mdc`,
`app-template-chart.mdc`, `cluster-context.mdc`). They apply to every agent,
not just Cursor. Keep them and this file in sync. In short:

- Sync waves: 200 parent app, 210 AppProject/ServiceAccounts, 220 child apps,
  230 ExternalSecrets and RBAC. Configs use 100–150.
- Single-image apps use the bjw-s `app-template` chart. Multi-part apps use
  plain manifests with a Kustomize `overlays/prod` (bluespice) or
  `overlays/kounex-ocp` (nayris).
- Sync policy `automated: {prune: true, selfHeal: true}`, `CreateNamespace=true`.
  Client-side apply by default. Server-side apply only where another
  controller owns fields (ArgoCD CR, APIServer, IngressController, OAuth); when
  applying those by hand, use `--server-side --field-manager=argocd-controller`.
- Routes: `ingress` with `route.openshift.io/termination: edge`, or a Route.

## Gotchas

- **A stuck sync blocks the next one.** If the running operation waits for a
  resource that can never become healthy, Argo will not start a new auto-sync
  for a newer commit. Apply the Git-rendered fix by hand, or let it time out.
- **BlueSpice 5.2.7+** needs `WIKI_ARTICLE_PATH: "wiki"` set explicitly (base
  ConfigMap), or nginx renders `return 301 /` and the probes fail on a redirect
  loop. The installer Job (Sync hook) runs the database update on every sync.
- **External Secrets API:** manifests use `external-secrets.io/v1beta1`, which
  upstream stopped serving in v0.17. Moving to `v1` must come before any ESO
  upgrade (see the audit).
- Argo CD here is 3.x (annotation resource tracking).

## Not in Git

Cluster state that this repo does not describe:

- `GitopsService/cluster` console-plugin resource requests (25m each, patched
  2026-10-22).
- The ClusterVersion update channel.
- Namespace `hm-playground` (deployed by hand, May 2026).
- Operators installed from the console: Web Terminal and the DevWorkspace
  operator it needs.
- The VM size and CPU weight (libvirt, see it-env).

## Git

Public `github.com/Kounex/ocp-gitops`, branch `main`. Every push to `main`
deploys, so commit finished units only. Renovate opens branches and PRs; its
dashboard is issue #44.

Not tracked (`.gitignore`): `docs/private/` (audits, private notes), `.env`,
`.DS_Store`.
