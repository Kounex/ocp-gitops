# OpenShift GitOps

Repository to reflect the Kounex OCP cluster.

# Bootstrap Cluster

The following steps are needed to setup the GitOps environmnt and workflow

## OC CLI

TODO

## Red Hat GitOps Operator
For the GitOps workflow, we will make use ArgoCD which is part of the Red Hat GitOps Operator. To install the operator, we apply the `Subscription` which will deploy all necessary components:
```sh
oc apply -f clusters/operator-gitops.yml
```