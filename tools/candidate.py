#!/usr/bin/python3
"""Prepare and verify unchanged CI candidates for REQ-PUBLISH-003.

These commands run only in read-only build/release verification jobs. The
privileged publisher deliberately retains its independent, checkout-free checks.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

import build


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "lucastsudaka/unite-next"
UUID = "unite-next@lucastsudaka.github.io"


def required(environment, name, pattern=None):
    value = environment.get(name)
    if not isinstance(value, str) or not value or pattern and not re.fullmatch(pattern, value):
        raise ValueError(f"Invalid or missing {name}")
    return value


def source_identity(root, environment, *, version=None, reviewed_commit=None):
    commit = required(environment, "GITHUB_SHA", r"[0-9a-f]{40}")
    if (environment.get("GITHUB_REPOSITORY") != REPOSITORY or
            environment.get("GITHUB_REF") != "refs/heads/master" or
            reviewed_commit is not None and reviewed_commit != commit):
        raise ValueError("Workflow must select the exact reviewed master commit")
    head = subprocess.check_output(
        ["git", "-c", f"safe.directory={root}", "rev-parse", "HEAD"],
        cwd=root, text=True, timeout=10).strip()
    if head != commit:
        raise ValueError("Checkout does not match the workflow commit")
    metadata = build.identity(root, version=version)
    if metadata["uuid"] != UUID or metadata.get("url") != "https://github.com/" + REPOSITORY:
        raise ValueError("Candidate must belong to the selected independent repository")
    return metadata, commit


def regular_bytes(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Candidate input must be a regular file: {path.name}")
    return path.read_bytes()


def manifest(metadata, commit, filename, digest, *, channel="native"):
    return {"repository": REPOSITORY, "source_commit": commit,
            "uuid": metadata["uuid"], "version": metadata["version"],
            "channel": channel, "archive": filename, "sha256": digest}


def write_bundle(destination, files):
    """Create one new output directory; never replace previous artifacts."""
    destination.mkdir()
    try:
        for name, data in files.items():
            with (destination / name).open("xb") as output:
                output.write(data)
    except BaseException as error:
        try:
            shutil.rmtree(destination)
        except OSError as cleanup_error:
            raise OSError(f"Candidate staging failed: {error}; cleanup failed: {cleanup_error}") from error
        raise


def prepare_candidate(root, environment, *, channel="native"):
    if channel not in ("native", "ego"):
        raise ValueError(f"Unknown candidate channel: {channel}")
    metadata, commit = source_identity(root, environment)
    event = json.loads(Path(required(environment, "GITHUB_EVENT_PATH")).read_text(encoding="utf-8"))
    repository = event.get("repository") if isinstance(event, dict) else None
    if (environment.get("GITHUB_EVENT_NAME") != "push" or
            not isinstance(repository, dict) or repository.get("private") is not False):
        raise ValueError("Acceptance artifacts require the selected public repository's master push")
    filename = (f"{metadata['uuid']}.shell-extension.zip" if channel == "ego" else
                f"unite-next-v{metadata['version']}.zip")
    source = root / "build" / "ego" if channel == "ego" else root / "build"
    data = regular_bytes(source / filename)
    if channel == "ego":
        native = regular_bytes(root / "build" / f"unite-next-v{metadata['version']}.zip")
        with zipfile.ZipFile(io.BytesIO(native)) as archive:
            payload = {item.filename: archive.read(item) for item in archive.infolist() if not item.is_dir()}
            modes = {item.filename: item.external_attr >> 16 for item in archive.infolist() if not item.is_dir()}
        build.validate_archive(io.BytesIO(native), payload)
        if json.loads(payload["metadata.json"]) != metadata:
            raise ValueError("Native reference metadata differs from the selected source")
        build.validate_archive(io.BytesIO(data), build.channel_files(metadata, payload, "ego"))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if {item.filename: item.external_attr >> 16 for item in archive.infolist() if not item.is_dir()} != modes:
                raise ValueError("EGO ZIP file modes differ from the native payload")
    digest = hashlib.sha256(data).hexdigest()
    record = manifest(metadata, commit, filename, digest, channel=channel)
    destination = root / "build" / ("ego-candidate" if channel == "ego" else "candidate")
    write_bundle(destination, {
        filename: data,
        filename + ".sha256": f"{digest}  {filename}\n".encode(),
        "candidate.json": (json.dumps(record, sort_keys=True, indent=2) + "\n").encode(),
    })
    return record


def github_json(path, environment):
    request = urllib.request.Request(
        "https://api.github.com/repos/" + REPOSITORY + path,
        headers={"Authorization": "Bearer " + required(environment, "GH_TOKEN"),
                 "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def object_value(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"Invalid {name} API response")
    return value


def verify_origin(root, environment, get=None):
    commit = required(environment, "REVIEWED_COMMIT", r"[0-9a-f]{40}")
    metadata, _ = source_identity(root, environment,
                                  version=required(environment, "REQUESTED_VERSION"),
                                  reviewed_commit=commit)
    run_id = required(environment, "ACCEPTED_RUN_ID", r"[1-9][0-9]*")
    artifact_id = required(environment, "ACCEPTED_ARTIFACT_ID", r"[1-9][0-9]*")
    required(environment, "ACCEPTED_SHA256", r"[0-9a-f]{64}")
    fetch = get if get is not None else lambda path: github_json(path, environment)
    repository = object_value(fetch(""), "repository")
    if (repository.get("private") is not False or repository.get("fork") is not False or
            repository.get("full_name") != REPOSITORY or repository.get("default_branch") != "master"):
        raise ValueError("Delivery must be the selected public independent repository on master")
    run = object_value(fetch("/actions/runs/" + run_id), "run")
    artifact = object_value(fetch("/actions/artifacts/" + artifact_id), "artifact")
    run_repository = object_value(run.get("repository"), "run repository")
    head_repository = object_value(run.get("head_repository"), "head repository")
    artifact_run = object_value(artifact.get("workflow_run"), "artifact run")
    path = run.get("path")
    if (run.get("status") != "completed" or run.get("conclusion") != "success" or
            run.get("event") != "push" or run.get("head_branch") != "master" or
            run.get("head_sha") != commit or not isinstance(path, str) or
            path.split("@", 1)[0] != ".github/workflows/build.yml" or
            run_repository.get("full_name") != REPOSITORY or head_repository.get("full_name") != REPOSITORY or
            type(artifact.get("id")) is not int or artifact["id"] != int(artifact_id) or
            artifact.get("name") != "unite-next-native-candidate" or artifact.get("expired") is not False or
            type(artifact_run.get("id")) is not int or artifact_run["id"] != int(run_id) or
            artifact_run.get("head_sha") != commit):
        raise ValueError("Accepted artifact does not originate in the successful reviewed master build")
    return {"version": metadata["version"], "uuid": metadata["uuid"]}


def verify_payload(root, environment):
    metadata, commit = source_identity(root, environment)
    accepted_digest = required(environment, "ACCEPTED_SHA256", r"[0-9a-f]{64}")
    filename = f"unite-next-v{metadata['version']}.zip"
    names = {filename, filename + ".sha256", "candidate.json"}
    accepted = root / "accepted"
    if accepted.is_symlink() or not accepted.is_dir() or {path.name for path in accepted.iterdir()} != names:
        raise ValueError("Unexpected accepted artifact contents")
    files = {name: regular_bytes(accepted / name) for name in names}
    data = files[filename]
    digest = hashlib.sha256(data).hexdigest()
    expected = manifest(metadata, commit, filename, digest)
    actual = json.loads(files["candidate.json"])
    if (digest != accepted_digest or actual != expected or
            not isinstance(actual, dict) or type(actual.get("version")) is not int or
            files[filename + ".sha256"] != f"{digest}  {filename}\n".encode()):
        raise ValueError("Accepted artifact digest, source manifest or checksum differs")
    reference_data = regular_bytes(root / "build" / filename)
    with zipfile.ZipFile(io.BytesIO(reference_data)) as reference:
        payload = {item.filename: reference.read(item) for item in reference.infolist() if not item.is_dir()}
        modes = {item.filename: item.external_attr >> 16 for item in reference.infolist() if not item.is_dir()}
    build.validate_archive(io.BytesIO(reference_data), payload)
    build.validate_archive(io.BytesIO(data), payload)
    with zipfile.ZipFile(io.BytesIO(data)) as original:
        if {item.filename: item.external_attr >> 16 for item in original.infolist() if not item.is_dir()} != modes:
            raise ValueError("Accepted ZIP file modes differ from the source payload")
    write_bundle(root / "build/accepted-release", files)
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "prepare-ego", "verify-origin", "verify-payload"))
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepare_candidate(ROOT, os.environ)
        elif args.command == "prepare-ego":
            result = prepare_candidate(ROOT, os.environ, channel="ego")
        elif args.command == "verify-origin":
            result = verify_origin(ROOT, os.environ)
            with Path(required(os.environ, "GITHUB_OUTPUT")).open("a", encoding="utf-8") as output:
                output.write(f"version={result['version']}\nuuid={result['uuid']}\n")
        else:
            result = verify_payload(ROOT, os.environ)
    except (OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"candidate {args.command} failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
