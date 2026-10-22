# OAuth

The cluster's `OAuth/cluster` in one place: the local htpasswd identity
provider (users come from Doppler through `ExternalSecret/htpasswd`) and the
custom login and provider-selection pages.

## Login theme

`apps/login-theme/login.html` and `providers.html` are the pages OpenShift
serves. The kustomization turns them into the `login-template` and
`provider-template` Secrets in `openshift-config`. To change the look, edit
the HTML and push. OpenShift's own templates are a starting point:
`oc adm create-login-template` and `oc adm create-provider-selection-template`.
