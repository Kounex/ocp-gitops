#!/usr/bin/env bash
# Build every kustomization in the repo and validate the output.
# Used by CI (.github/workflows/validate.yml); runs anywhere kustomize and
# kubeconform are on PATH. _init/ is applied by hand on a fresh cluster and
# is validated like the rest.
set -euo pipefail
cd "$(dirname "$0")/.."

K8S_VERSION="${K8S_VERSION:-1.34.0}"
CRDS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

fail=0
while IFS= read -r dir; do
  if ! out=$(kustomize build "$dir" 2>&1); then
    echo "::error file=$dir::kustomize build failed: $out"
    fail=1
    continue
  fi
  if ! printf '%s\n' "$out" | kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
      -schema-location default -schema-location "$CRDS" -ignore-missing-schemas >/tmp/kc.out 2>&1; then
    echo "::error file=$dir::schema validation failed"
    cat /tmp/kc.out
    fail=1
  else
    echo "ok  $dir  ($(tail -1 /tmp/kc.out))"
  fi
done < <(find . -name 'kustomization.y*ml' -not -path './.git/*' -printf '%h\n' | sort)

exit "$fail"
