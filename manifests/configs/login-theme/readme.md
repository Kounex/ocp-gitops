# Custom OpenShift Login / Providers Template

These resources will apply custom login / providers `HTML`s which are going to be used for the login experience (provider selection and login). Essentially the to-be-used `HTML`s are going to be put inside designated `Secret`s and then used in the `OAuth` resource in `spec.templates` by patching the existing resource.

## How to apply

If you are using GitOps with ArgoCD, simply add the `login-theme` folder into your repo and reference the `kustomization.yml` as the starting point which will create the ArgoCD `Application` resource for this feature

Otherwise just apply the inner `kustomization.yml` inside the `configs` folder with

```sh
oc apply -k configs
```

## Make your own theme

--