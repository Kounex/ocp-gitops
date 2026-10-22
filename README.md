# ocp-gitops

Everything that runs on the single-node OpenShift cluster `ocp.kounex.com`,
deployed by OpenShift GitOps (Argo CD) from this repo. Push to `main` and Argo
syncs it.

Agents and anyone operating the cluster: read [AGENTS.md](AGENTS.md) first.

## What's in here

| Path | What |
|---|---|
| `_init/` | One-time bootstrap: the OpenShift GitOps operator Subscription and cluster-wide rights for the Argo controller. |
| `cluster/` | One-time bootstrap: the three `bootstrap-*` Applications. |
| `environment/` | AppProjects and the three "manager" Applications that read `manifests/`. |
| `manifests/operators/` | Operator Subscriptions (cert-manager, External Secrets, LVM Storage). |
| `manifests/configs/` | Cluster configuration: OAuth and login page, certificates, Argo CD itself, secret store, storage, Cloudflare Tunnel. |
| `manifests/apps/` | Workloads: BlueSpice wiki, IT-Tools. |
| `tools/` | Manifest validation (also run in CI) and the off-cluster backup job. |

## Bootstrap a fresh cluster

```sh
oc apply -k _init                     # GitOps operator + controller rights
# wait until the openshift-gitops namespace and Argo CD are running
oc apply -k cluster/operators
oc apply -k cluster/day1
oc apply -k cluster/day2
```

From there Argo CD installs the operators, then the cluster configuration,
then the apps (sync waves order them). Secrets come from Doppler through
External Secrets, so the Doppler token Secret has to exist before the secret
store can work.

## Validate locally

```sh
tools/validate.sh   # needs kustomize and kubeconform on PATH
```

The same check runs on every push and pull request
(`.github/workflows/validate.yml`). Renovate keeps image and chart versions
current and merges minor and patch updates once that check passes.
