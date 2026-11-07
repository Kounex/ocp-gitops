#!/usr/bin/env python3
"""Promote matching upstream CTFd manifests and image into selected overlays."""
import argparse
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'open-tech-quest/ctfd-plugin'
IMAGE = 'ghcr.io/' + REPOSITORY
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')

def request_json(url, headers=None):
    request = urllib.request.Request(url, headers={'User-Agent':'ctfd-release-promoter', **(headers or {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response), response.headers

def verify_release(version):
    tag = 'v' + version
    metadata, _ = request_json('https://github.com/' + REPOSITORY + '/releases/download/' + tag + '/release.json')
    assert metadata['version'] == version and metadata['tag'] == tag
    assert metadata['image'] == IMAGE + ':' + version
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', metadata['digest'])
    assert re.fullmatch(r'[0-9a-f]{40}', metadata['source_commit'])
    ref, _ = request_json('https://api.github.com/repos/' + REPOSITORY + '/git/ref/tags/' + tag)
    assert ref['object']['type'] == 'commit' and ref['object']['sha'] == metadata['source_commit']
    # Verify the published digest and OCI revision independently of release.json.
    token, _ = request_json('https://ghcr.io/token?service=ghcr.io&scope=repository:' + REPOSITORY + ':pull')
    headers = {'Authorization':'Bearer ' + token['token'], 'Accept':
        'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'}
    prefix = 'https://ghcr.io/v2/' + REPOSITORY + '/'
    manifest, response_headers = request_json(prefix + 'manifests/' + version, headers)
    assert response_headers.get('Docker-Content-Digest') == metadata['digest']
    if 'manifests' in manifest:
        platform = next(item for item in manifest['manifests'] if item.get('platform', {}).get('os') == 'linux'
                        and item['platform'].get('architecture') == 'amd64')
        manifest, _ = request_json(prefix + 'manifests/' + platform['digest'], headers)
    configuration, _ = request_json(prefix + 'blobs/' + manifest['config']['digest'], headers)
    labels = configuration['config']['Labels']
    assert labels['org.opencontainers.image.version'] == version
    assert labels['org.opencontainers.image.revision'] == metadata['source_commit']
    return metadata

def update_document(document, version, digest, environment):
    upstream = r'https://github\.com/open-tech-quest/ctfd-plugin\.git//deploy/(overlays/openshift|components/event-400)\?ref=v[0-9]+\.[0-9]+\.[0-9]+'
    paths = re.findall(upstream, document)
    expected = ['overlays/openshift'] + (['components/event-400'] if environment == 'event' else [])
    assert sorted(paths) == sorted(expected), 'Unexpected upstream references in ' + environment
    document = re.sub(upstream, lambda match: 'https://github.com/' + REPOSITORY + '.git//deploy/' + match.group(1)
                      + '?ref=v' + version, document)
    pattern = r'(?m)^  - name: ghcr\.io/open-tech-quest/ctfd-plugin\n(?:^    [^\n]*\n)+'
    blocks = re.findall(pattern, document)
    assert len(blocks) == 1, 'Expected one CTFd image override'
    block = blocks[0]
    assert len(re.findall(r'(?m)^    newTag:', block)) == len(re.findall(r'(?m)^    digest:', block)) == 1
    assert not re.search(r'(?m)^    newName:', block)
    updated = re.sub(r'(?m)^    newTag:[^\n]+', '    newTag: ' + version, block)
    updated = re.sub(r'(?m)^    digest:[^\n]+', '    digest: ' + digest, updated)
    return document.replace(block, updated, 1)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', help='Published X.Y.Z plugin release')
    parser.add_argument('--overlay', choices=['prod','event','all'], required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        parser.error('Use an X.Y.Z release version without the v prefix')
    release = verify_release(args.version)
    environments = ['prod','event'] if args.overlay == 'all' else [args.overlay]
    updates = {}
    for name in environments:
        path = ROOT / 'manifests/apps/ctfd/apps/overlays' / name / 'kustomization.yaml'
        updates[path] = update_document(path.read_text(), args.version, release['digest'], name)
    if not args.dry_run:
        for path, document in updates.items():
            path.write_text(document)
    print(('Verified' if args.dry_run else 'Updated') + ' ' + ', '.join(environments) + ' to ' + release['tag']
          + ' with matching manifests and image digest. Review, validate and commit the change.')

if __name__ == '__main__':
    main()
