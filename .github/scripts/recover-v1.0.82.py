"""Verify the immutable v1.0.82 inputs and publish the reviewed npm tarballs."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zipfile import ZipFile

REPO = "vilmire/adhdev"
REPO_ID = 1184511583
VERSION = "1.0.82"
TAG_SHA = "4c6dd8e9a0186e2dd6367bb530307ccca6f1d17a"
RUN = 46008160692
ARTIFACT = 15201354641
ZIP_SHA = "e855f70cd81794bfa3b3213e1baf6c5ffce9d6cca681e6019371e2c3583dc6a4"
ENVIRONMENT = "npm-v1.0.82-recovery"
REGISTRY = "https://registry.npmjs.org"
PUBLISH = ("mesh-shared", "session-host-core", "ghostty-vt-node", "mcp-server", "daemon-core", "daemon-standalone")
DIST = {"session-host-core", "session-host-daemon", "mcp-server", "daemon-core", "daemon-standalone", "web-standalone"}
CONTROL_PATHS = {
    ".github/scripts/recover-v1.0.82-reference.json",
    ".github/scripts/recover-v1.0.82.py",
    ".github/workflows/ci.yml",
    ".github/workflows/ghostty-vt-node.yml",
    ".github/workflows/recover-v1.0.82.yml",
    "packages/ghostty-vt-node/scripts/check-prebuilts.mjs",
    "packages/ghostty-vt-node/scripts/check-release-prebuilts.sh",
    "packages/ghostty-vt-node/test/host-path-scan.test.mjs",
}
REFERENCE = json.loads(Path(__file__).with_name("recover-v1.0.82-reference.json").read_text())
DEPS = ("dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta")
METADATA = ("name", "version", *DEPS, "bundleDependencies", "bundledDependencies", "publishConfig", "engines", "os", "cpu")


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPO}/{path}"]))


def workflow_run(run_id, workflow_id, path, sha, event, branch, conclusion):
    run = api(f"actions/runs/{run_id}")
    require(
        (run["id"], run["workflow_id"], run["path"], run["head_sha"], run["event"],
         run["head_branch"], run["status"], run["conclusion"], run["repository"]["id"],
         run["head_repository"]["id"]) ==
        (int(run_id), workflow_id, path, sha, event, branch, "completed", conclusion, REPO_ID, REPO_ID),
        f"Unexpected workflow provenance for run {run_id}",
    )


def steps_succeeded(job, *names):
    success = {step["name"] for step in job["steps"] if step["conclusion"] == "success"}
    return set(names) <= success


def verify_tag():
    tag = api(f"git/ref/tags/v{VERSION}")
    require(tag["ref"] == f"refs/tags/v{VERSION}" and tag["object"]["type"] == "commit"
            and tag["object"]["sha"] == TAG_SHA, "Immutable tag does not point to the approved commit")


def verify_environment():
    path = f"environments/{ENVIRONMENT}"
    environment = api(path)
    require(not environment.get("can_admins_bypass", True),
            "The recovery environment must disable administrator bypass")
    rules = [rule for rule in environment["protection_rules"] if rule["type"] == "required_reviewers"]
    require(len(rules) == 1 and not rules[0]["prevent_self_review"]
            and [(item["type"], item["reviewer"].get("login")) for item in rules[0]["reviewers"]] ==
            [("User", "vilmire")], "The recovery environment must require the owner's review")
    policy = api(f"{path}/deployment-branch-policies")
    require(policy["total_count"] == 1 and policy["branch_policies"][0]["name"] == "main"
            and policy["branch_policies"][0]["type"] == "branch",
            "The recovery environment must allow only the main branch")


def verify_control(control, control_sha):
    paths = subprocess.check_output(
        ["git", "-C", control, "diff", "--name-only", "--no-renames", TAG_SHA, control_sha], text=True)
    require(set(paths.splitlines()) == CONTROL_PATHS, "Control commit includes unapproved paths or omits recovery files")


def provenance(native_run, control_sha, archive, publishing):
    verify_tag()
    if publishing:
        verify_environment()
    workflow_run(RUN, 247790850, ".github/workflows/ci.yml", TAG_SHA, "push", f"v{VERSION}", "failure")
    jobs = {job["id"]: job for job in api(f"actions/runs/{RUN}/attempts/1/jobs?per_page=100")["jobs"]}
    for job_id, name in [(140536499749, "build (22)"), (140537675988, "test")]:
        job = jobs[job_id]
        require((job["name"], job["head_sha"], job["conclusion"]) == (name, TAG_SHA, "success"),
                f"Original tag job {job_id} did not pass")
    require(steps_succeeded(jobs[140536499749], "Build all packages", "Upload publish artifacts"),
            "Original tag build/upload evidence is incomplete")
    checks = [step for step in jobs[140537675988]["steps"] if step["name"].startswith(("Test ", "Typecheck "))]
    require(len(checks) == 18 and all(step["conclusion"] == "success" for step in checks),
            "Original tag test/typecheck evidence is incomplete")

    require(re.fullmatch(r"[1-9][0-9]{0,19}", native_run), "Expected a numeric Windows native evidence run ID")
    workflow_run(native_run, 254955064, ".github/workflows/ghostty-vt-node.yml", control_sha,
                 "workflow_dispatch", "main", "success")
    native_jobs = api(f"actions/runs/{native_run}/jobs?per_page=100")["jobs"]
    windows = [job for job in native_jobs if job["name"] == "native-build (windows-2022, win32, x64, 22)"]
    require(len(windows) == 1 and windows[0]["head_sha"] == control_sha and windows[0]["conclusion"] == "success"
            and steps_succeeded(windows[0], "Build ghostty-vt-node", "Test ghostty-vt-node",
                                "Stage native artifact", "Upload native artifact"),
            "Expected a successful Windows VS 2022 build, test and verified artifact upload")

    artifact = api(f"actions/artifacts/{ARTIFACT}")
    origin = artifact["workflow_run"]
    require((artifact["id"], artifact["name"], artifact["digest"], artifact["expired"],
             origin["id"], origin["head_sha"], origin["head_branch"], origin["repository_id"],
             origin["head_repository_id"]) ==
            (ARTIFACT, "publish-artifacts", f"sha256:{ZIP_SHA}", False, RUN, TAG_SHA,
             f"v{VERSION}", REPO_ID, REPO_ID), "Unexpected or expired build artifact")
    with archive.open("xb") as target:
        subprocess.run(["gh", "api", f"repos/{REPO}/actions/artifacts/{ARTIFACT}/zip"],
                       stdout=target, check=True)
    print(f"Verified tag {TAG_SHA}, tag CI {RUN} attempt 1, build artifact {ARTIFACT}, Windows run {native_run}")


def extract_dist(archive, source):
    with archive.open("rb") as data:
        require(hashlib.file_digest(data, "sha256").hexdigest() == ZIP_SHA, "Build artifact ZIP digest mismatch")
    with ZipFile(archive) as zipped:
        entries = zipped.infolist()
        seen = set()
        for entry in entries:
            parts = entry.filename.split("/")
            require(len(parts) >= 3 and parts[0] in DIST and parts[1] == "dist"
                    and all(part not in ("", ".", "..") for part in parts)
                    and "\\" not in entry.filename and entry.filename not in seen
                    and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG),
                    "Unexpected file in build artifact")
            seen.add(entry.filename)
        require({name.split("/")[0] for name in seen} == DIST, "Build artifact is missing dist trees")
        for entry in entries:
            target = source / "packages" / entry.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            with zipped.open(entry) as reader, target.open("xb") as writer:
                shutil.copyfileobj(reader, writer)
            target.chmod(0o755 if entry.filename == "daemon-standalone/dist/index.js" else 0o644)
    require((source / "packages/daemon-standalone/dist/index.js").read_bytes().startswith(b"#!/usr/bin/env node"),
            "Missing standalone shebang")


def metadata(value):
    return {key: value[key] for key in METADATA if key in value}


def package_record(slug, archive):
    raw = archive.read_bytes()
    with tarfile.open(archive) as packed:
        entries = [entry for entry in packed.getmembers() if entry.name == "package/package.json"]
        require(len(entries) == 1 and entries[0].isfile(), f"{slug}: invalid package.json entry")
        package = json.load(packed.extractfile(entries[0]))
    require(not package.get("private") and metadata(package) == REFERENCE[slug]["package"],
            f"{slug}: package name, version, dependencies or publish metadata mismatch")
    return {
        "filename": archive.name,
        "package": metadata(package),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "integrity": "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode(),
        "size": len(raw),
    }


def pack(source, bundle, native_run, control_sha):
    actual_sha = subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD"], text=True).strip()
    require(actual_sha == TAG_SHA, "Package preparation must run from the immutable tag checkout")
    bundle.mkdir()
    records = []
    for slug in PUBLISH:
        working = source / "packages" / slug
        local = json.loads((working / "package.json").read_text())
        require(metadata(local) == REFERENCE[slug]["package"], f"{slug}: exact-tag source metadata mismatch")
        result = json.loads(subprocess.check_output(
            ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", bundle], cwd=working))
        archive = bundle / result[0]["filename"]
        record = package_record(slug, archive)
        if slug == "ghostty-vt-node":
            expected = {}
            for path in subprocess.check_output(["git", "ls-files", "-z", "prebuilt"], cwd=working).split(b"\0"):
                if path:
                    name = os.fsdecode(path)
                    expected["package/" + name] = (working / name).read_bytes()
            with tarfile.open(archive) as packed:
                natives = [item for item in packed.getmembers() if item.name.startswith("package/prebuilt/")]
                require(len(natives) == len(expected) and {entry.name for entry in natives} == expected.keys()
                        and all(entry.isfile() and packed.extractfile(entry).read() == expected[entry.name]
                                for entry in natives), "Packed Ghostty files differ from the committed release set")
        record["reference"] = REFERENCE[slug]["reference"]
        records.append(record)
    manifest = {
        "tag": f"v{VERSION}", "source": TAG_SHA, "control": control_sha, "tag_ci": RUN, "tag_ci_attempt": 1,
        "build_artifact": ARTIFACT, "build_zip_sha256": ZIP_SHA, "windows_native_run": int(native_run),
        "registry": REGISTRY, "dist_tag": "latest", "packages": records,
        "root_release_reference": REFERENCE["adhdev"],
    }
    payload = json.dumps(manifest, indent=2) + "\n"
    (bundle / "manifest.json").write_text(payload, encoding="utf-8")
    digest = hashlib.sha256(payload.encode()).hexdigest()
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        print(f"manifest_sha={digest}", file=output)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        print(f"Review this manifest before allowing npm publication. SHA-256 `{digest}`.\n", file=summary)
        print("```json\n" + payload + "```", file=summary)


def registry_json(name, version):
    url = f"{REGISTRY}/{quote(name, safe='@')}/{version}"
    response = Request(url, headers={"Cache-Control": "no-cache", "Accept": "application/json"})
    try:
        with urlopen(response, timeout=30) as data:
            return json.load(data)
    except HTTPError as error:
        if error.code != 404:
            raise
        return None


def integrity_matches(record, current):
    expected = record["package"]
    return (current["name"], current["version"], current["dist"].get("integrity")) == (
        expected["name"], VERSION, record["integrity"]) and all(
        (current.get(key) or {}) == (expected.get(key) or {}) for key in DEPS)


def registry_state(record):
    name = record["package"]["name"]
    current = registry_json(name, VERSION)
    latest = registry_json(name, "latest")
    if current is not None:
        require(integrity_matches(record, current), f"{name}@{VERSION}: registry contents differ from approved bytes")
        return latest is not None and integrity_matches(record, latest)
    if latest is not None:
        version = latest["version"]
        require(re.fullmatch(r"\d+\.\d+\.\d+", version)
                and tuple(map(int, version.split("."))) < (1, 0, 82),
                f"{name}: refusing to move latest backwards or from a non-stable version")
    return None


def verify_registry_tarball(slug, record):
    url = f"{REGISTRY}/@adhdev/{slug}/-/{slug}-{VERSION}.tgz"
    with urlopen(url, timeout=90) as data:
        require(data.geturl() == url and hashlib.file_digest(data, "sha256").hexdigest() == record["sha256"],
                f"{slug}: registry tarball does not match approved bytes")


def publish(bundle, expected_sha, control_sha):
    publish_env = {key: value for key, value in os.environ.items()
                   if key not in ("NODE_AUTH_TOKEN", "NPM_TOKEN")
                   and not key.lower().startswith("npm_config__authtoken")}
    require(bool(publish_env.get("ACTIONS_ID_TOKEN_REQUEST_URL"))
            and bool(publish_env.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")),
            "OIDC Trusted Publishing requires GitHub Actions id-token: write credentials")
    payload = (bundle / "manifest.json").read_bytes()
    require(hashlib.sha256(payload).hexdigest() == expected_sha, "Prepared manifest digest mismatch")
    manifest = json.loads(payload)
    require((manifest["source"], manifest["control"], manifest["registry"], manifest["dist_tag"]) ==
            (TAG_SHA, control_sha, REGISTRY, "latest"), "Prepared manifest provenance mismatch")
    records = manifest["packages"]
    require([item["package"]["name"] for item in records] == [f"@adhdev/{slug}" for slug in PUBLISH],
            "Unexpected publication set or order")
    for slug, record in zip(PUBLISH, records, strict=True):
        archive = bundle / f"adhdev-{slug}-{VERSION}.tgz"
        require({key: value for key, value in record.items() if key != "reference"} == package_record(slug, archive),
                f"{slug}: prepared tarball changed")
    # Check the entire set before the first irreversible registry write.
    states = [registry_state(record) for record in records]
    require(False not in states, "An existing exact version is not the matching latest version")
    for slug, record in zip(PUBLISH, records, strict=True):
        name = record["package"]["name"]
        state = registry_state(record)
        require(state is not False, f"{name}: latest changed since preflight")
        if state is None:
            subprocess.run(["npm", "publish", str(bundle / record["filename"]), "--access=public",
                            "--ignore-scripts", "--tag=latest", f"--registry={REGISTRY}"],
                           env=publish_env, check=True)
            for _ in range(18):
                if registry_state(record):
                    break
                time.sleep(10)
            else:
                raise SystemExit(f"{name}@{VERSION}: registry did not confirm publication")
        verify_registry_tarball(slug, record)
        print(f"Verified {name}@{VERSION} latest and approved integrity")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    options = parser.add_subparsers(dest="command", required=True)
    options.add_parser("verify-tag")
    options.add_parser("verify-environment")
    control = options.add_parser("verify-control")
    control.add_argument("control", type=Path)
    control.add_argument("control_sha")
    check = options.add_parser("provenance")
    check.add_argument("native_run")
    check.add_argument("control_sha")
    check.add_argument("archive", type=Path)
    check.add_argument("--publish", action="store_true")
    extract = options.add_parser("extract-dist")
    extract.add_argument("archive", type=Path)
    extract.add_argument("source", type=Path)
    prepare = options.add_parser("pack")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("bundle", type=Path)
    prepare.add_argument("native_run")
    prepare.add_argument("control_sha")
    release = options.add_parser("publish")
    release.add_argument("bundle", type=Path)
    release.add_argument("expected_sha")
    release.add_argument("control_sha")
    args = vars(parser.parse_args())
    command = args.pop("command").replace("-", "_")
    if command == "provenance":
        args["publishing"] = args.pop("publish")
    globals()[command](**args)
