# Additional operator catalog for the AI lab

This catalog exposes the OpenShift AI operator from the Red Hat OpenShift 4.22
operator index alongside the cluster's default OpenShift 5.0 catalogs.

The default `redhat-operators` CatalogSource continues to use the v5.0 index.
The additional `redhat-ai-operators` CatalogSource uses
`registry.redhat.io/redhat/redhat-operator-index:v4.22`. It contains the full
4.22 catalog, not an AI-only filtered catalog. Its display name distinguishes
the lab source in the console.

Observed channel heads on 2026-11-12:

| Package | Channel | Version |
| --- | --- | --- |
| `rhods-operator` | `stable-3.5`, `stable-3.x`, `eus-3.5` | 3.5.2 |
| `rhods-operator` | `beta` | 3.6.0-ea.2 |
| `rhods-operator` | `stable` | 2.25.8 |

Adding the catalog does not install or upgrade an operator. When deliberately
installing OpenShift AI from this source, use
`spec.source: redhat-ai-operators` and the intended channel. OpenShift 5
compatibility must be validated separately; catalog visibility does not
establish product support. The Early Access channel is intended for lab work.

The index polls every four hours so newly published channel heads become
discoverable. The `30Mi` memory target follows the reference catalog's setting;
it is not a hard memory limit or a guarantee of actual consumption.

This app is in the Hetzner operator manager's composition. The separate event
cluster bootstrap does not include it. As with the repository's other operator
apps, deleting the parent Application does not cascade-delete the catalog.
