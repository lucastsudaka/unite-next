"""REQ-PUBLISH-003: isolated CI receipts, provenance and unchanged ZIP transfer."""
from copy import deepcopy
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import candidate


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="un-candidate-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        source = self.root / "unite-next@lucastsudaka.github.io"
        source.mkdir()
        self.metadata = {"version": 73, "uuid": "unite-next@lucastsudaka.github.io",
                         "gettext-domain": "unite-next", "shell-version": ["50", "51"],
                         "url": "https://github.com/lucastsudaka/unite-next"}
        self.metadata_path = source / "metadata.json"
        self.metadata_path.write_text(json.dumps(self.metadata))
        self.git("init", "--quiet", "--initial-branch=master")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "Create candidate source fixture")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.filename = "unite-next-v73.zip"
        self.build = self.root / "build"
        self.build.mkdir()
        self.reference = self.build / self.filename
        self.payload = {"metadata.json": json.dumps(self.metadata).encode(),
                        "extension.js": b"export default class Extension {}\n",
                        "LICENSE": b"GPLv3 fixture license\n", "NOTICE": b"Fixture attribution\n"}
        self.reference.write_bytes(self.zip_bytes(self.payload))
        self.original = self.zip_bytes(self.payload, compressed=True)
        self.digest = hashlib.sha256(self.original).hexdigest()
        self.event = self.root / "event.json"
        self.event.write_text(json.dumps({"repository": {"private": False}}))
        self.environment = {"GITHUB_REPOSITORY": "lucastsudaka/unite-next",
                            "GITHUB_REF": "refs/heads/master", "GITHUB_SHA": self.commit,
                            "GITHUB_EVENT_NAME": "push", "GITHUB_EVENT_PATH": str(self.event),
                            "REVIEWED_COMMIT": self.commit, "REQUESTED_VERSION": "73",
                            "ACCEPTED_RUN_ID": "123", "ACCEPTED_ARTIFACT_ID": "456",
                            "ACCEPTED_SHA256": self.digest, "GH_TOKEN": "fixture-token"}
        self.repository = {"private": False, "fork": False,
                           "full_name": "lucastsudaka/unite-next", "default_branch": "master"}
        self.run = {"status": "completed", "conclusion": "success", "event": "push",
                    "head_branch": "master", "head_sha": self.commit,
                    "path": ".github/workflows/build.yml@refs/heads/master",
                    "repository": {"full_name": "lucastsudaka/unite-next"},
                    "head_repository": {"full_name": "lucastsudaka/unite-next"}}
        self.artifact = {"id": 456, "name": "unite-next-native-candidate", "expired": False,
                         "workflow_run": {"id": 123, "head_sha": self.commit}}
        network = patch.object(candidate.urllib.request, "urlopen",
                               side_effect=AssertionError("Unit tests must never use a real network"))
        network.start()
        self.addCleanup(network.stop)

    def git(self, *arguments):
        return subprocess.check_output(["git", "-c", "maintenance.auto=false", "-c", "gc.auto=0", *arguments], cwd=self.root,
                                       stderr=subprocess.STDOUT, text=True, timeout=5)

    def zip_bytes(self, payload, *, compressed=False, mode=None):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.comment = b"Accepted original container" if compressed else b"Rebuilt reference container"
            for name, data in payload.items():
                item = zipfile.ZipInfo(name, (2024 if compressed else 2020, 1, 2, 3, 4, 6))
                item.create_system = 3
                item.external_attr = (stat.S_IFREG | 0o644 if mode is None else mode) << 16
                item.compress_type = zipfile.ZIP_DEFLATED if compressed else zipfile.ZIP_STORED
                archive.writestr(item, data)
        return output.getvalue()

    def receipt(self, digest):
        return {"repository": "lucastsudaka/unite-next", "source_commit": self.commit,
                "uuid": "unite-next@lucastsudaka.github.io", "version": 73,
                "channel": "native", "archive": "unite-next-v73.zip", "sha256": digest}

    def accepted(self, data=None):
        data = self.original if data is None else data
        digest = hashlib.sha256(data).hexdigest()
        directory = self.root / "accepted"
        directory.mkdir(exist_ok=True)
        (directory / self.filename).write_bytes(data)
        (directory / (self.filename + ".sha256")).write_text(f"{digest}  {self.filename}\n")
        (directory / "candidate.json").write_text(json.dumps(self.receipt(digest)))
        self.environment["ACCEPTED_SHA256"] = digest
        return directory

    def fetch(self, path):
        return deepcopy({"": self.repository, "/actions/runs/123": self.run,
                         "/actions/artifacts/456": self.artifact}[path])

    def assert_not_transferred(self):
        self.assertFalse((self.build / "accepted-release").exists())

    def test_prepare_binds_public_master_checkout_and_copies_original_archive(self):
        original = self.reference.read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        result = candidate.prepare_candidate(self.root, self.environment)
        directory = self.build / "candidate"
        self.assertEqual(result, self.receipt(digest))
        self.assertEqual({path.name for path in directory.iterdir()},
                         {self.filename, self.filename + ".sha256", "candidate.json"})
        self.assertEqual((directory / self.filename).read_bytes(), original)
        self.assertEqual(json.loads((directory / "candidate.json").read_text()), self.receipt(digest))
        self.assertEqual((directory / (self.filename + ".sha256")).read_bytes(),
                         f"{digest}  {self.filename}\n".encode())
        self.assertEqual(self.reference.read_bytes(), original)

    def test_prepare_rejects_privacy_event_branch_commit_and_identity_mismatch(self):
        cases = [("GITHUB_REPOSITORY", "foreign/project"), ("GITHUB_REF", "refs/heads/topic"),
                 ("GITHUB_SHA", "0" * 40), ("GITHUB_EVENT_NAME", "pull_request")]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(ValueError):
                candidate.prepare_candidate(self.root, {**self.environment, key: value})
        for value in (True, None, "false", 0):
            self.event.write_text(json.dumps({"repository": {"private": value}}))
            with self.subTest(private=value), self.assertRaises(ValueError):
                candidate.prepare_candidate(self.root, self.environment)
        self.event.write_text(json.dumps({"repository": {"private": False}}))
        self.metadata_path.write_text(json.dumps({**self.metadata, "url": "https://github.com/foreign/project"}))
        with self.assertRaises(ValueError):
            candidate.prepare_candidate(self.root, self.environment)
        self.assertFalse((self.build / "candidate").exists())

    def test_ego_candidate_retains_bytes_and_binds_a_separate_channel(self):
        ego = self.build / "ego"
        ego.mkdir()
        filename = self.metadata["uuid"] + ".shell-extension.zip"
        payload = {**self.payload, "metadata.json": (json.dumps(
            {**{key: value for key, value in self.metadata.items() if key != "version"},
             "version-name": "73"}, indent=2) + "\n").encode()}
        data = self.zip_bytes(payload, compressed=True)
        (ego / filename).write_bytes(data)
        native_before = self.reference.read_bytes()
        result = candidate.prepare_candidate(self.root, self.environment, channel="ego")
        self.assertEqual(result["channel"], "ego")
        self.assertEqual(result["archive"], filename)
        self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual((self.build / "ego-candidate" / filename).read_bytes(), data)
        self.assertFalse((self.build / "candidate").exists())
        self.assertEqual(self.reference.read_bytes(), native_before)

    def test_ego_candidate_rejects_renamed_native_changed_runtime_and_modes(self):
        ego = self.build / "ego"
        ego.mkdir()
        filename = self.metadata["uuid"] + ".shell-extension.zip"
        metadata = {key: value for key, value in self.metadata.items() if key != "version"}
        metadata["version-name"] = "73"
        payload = {**self.payload, "metadata.json": (json.dumps(metadata, indent=2) + "\n").encode()}
        for data in (self.reference.read_bytes(),
                     self.zip_bytes({**payload, "extension.js": b"unexpected change"}),
                     self.zip_bytes(payload, mode=stat.S_IFREG | 0o600)):
            with self.subTest(digest=hashlib.sha256(data).hexdigest()):
                (ego / filename).write_bytes(data)
                with self.assertRaises(ValueError):
                    candidate.prepare_candidate(self.root, self.environment, channel="ego")
                self.assertFalse((self.build / "ego-candidate").exists())

    def test_prepare_preserves_existing_directory_and_rejects_symbolic_archive(self):
        directory = self.build / "candidate"
        directory.mkdir()
        (directory / "previous").write_bytes(b"existing artifact")
        with self.assertRaises(FileExistsError):
            candidate.prepare_candidate(self.root, self.environment)
        self.assertEqual((directory / "previous").read_bytes(), b"existing artifact")
        self.reference.unlink()
        self.reference.symlink_to(self.metadata_path)
        with self.assertRaisesRegex(ValueError, "regular file"):
            candidate.prepare_candidate(self.root, self.environment)

    def test_partial_output_failure_removes_only_the_new_candidate_directory(self):
        original = self.reference.read_bytes()
        native_open = Path.open
        def fail(path, *args, **kwargs):
            if path.name == "candidate.json" and "candidate" == path.parent.name:
                raise OSError("Injected output failure")
            return native_open(path, *args, **kwargs)
        with patch.object(Path, "open", fail), self.assertRaisesRegex(OSError, "Injected"):
            candidate.prepare_candidate(self.root, self.environment)
        self.assertFalse((self.build / "candidate").exists())
        self.assertEqual(self.reference.read_bytes(), original)

    def test_staging_and_cleanup_failures_both_remain_visible(self):
        native_open = Path.open
        def fail(path, *args, **kwargs):
            if path.name == "candidate.json":
                raise OSError("Injected write failure")
            return native_open(path, *args, **kwargs)
        with patch.object(Path, "open", fail), \
                patch.object(candidate.shutil, "rmtree", side_effect=OSError("Injected cleanup failure")), \
                self.assertRaisesRegex(OSError, "Injected write failure; cleanup failed: Injected cleanup failure"):
            candidate.prepare_candidate(self.root, self.environment)
        self.assertTrue((self.build / "candidate").is_dir(), "Failed cleanup must not be reported as success")
        self.assertTrue(self.reference.is_file(), "Original archive was removed by failed cleanup")

    def test_successful_origin_uses_exact_read_only_api_paths(self):
        paths = []
        result = candidate.verify_origin(self.root, self.environment,
                                         lambda path: paths.append(path) or self.fetch(path))
        self.assertEqual(result, {"version": 73, "uuid": "unite-next@lucastsudaka.github.io"})
        self.assertEqual(paths, ["", "/actions/runs/123", "/actions/artifacts/456"])

    def test_invalid_dispatch_inputs_fail_before_any_api_access(self):
        for name, value in [("REVIEWED_COMMIT", "A" * 40), ("REVIEWED_COMMIT", "0" * 40),
                            ("REQUESTED_VERSION", "74"), ("ACCEPTED_RUN_ID", "../1"),
                            ("ACCEPTED_ARTIFACT_ID", "0"), ("ACCEPTED_SHA256", "not-a-digest")]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                candidate.verify_origin(self.root, {**self.environment, name: value},
                                        lambda path: self.fail("Invalid input accessed the API"))

    def test_origin_rejects_private_fork_wrong_repository_or_default_branch(self):
        for key, value in [("private", True), ("private", 0), ("fork", True),
                           ("full_name", "foreign/project"), ("default_branch", "development")]:
            with self.subTest(key=key):
                original = self.repository
                self.repository = {**original, key: value}
                with self.assertRaises(ValueError):
                    candidate.verify_origin(self.root, self.environment, self.fetch)
                self.repository = original

    def test_origin_rejects_failed_wrong_workflow_or_foreign_source_runs(self):
        for key, value in [("status", "in_progress"), ("conclusion", "failure"),
                           ("event", "pull_request"), ("head_branch", "topic"),
                           ("head_sha", "0" * 40), ("path", ".github/workflows/release.yml"),
                           ("repository", {"full_name": "foreign/project"}),
                           ("head_repository", {"full_name": "foreign/project"})]:
            with self.subTest(key=key):
                original = self.run
                self.run = {**original, key: value}
                with self.assertRaises(ValueError):
                    candidate.verify_origin(self.root, self.environment, self.fetch)
                self.run = original

    def test_origin_rejects_expired_wrong_artifact_or_run_binding(self):
        for key, value in [("id", 457), ("id", "456"), ("name", "different-artifact"),
                           ("expired", True), ("expired", 0),
                           ("workflow_run", {"id": 124, "head_sha": self.commit}),
                           ("workflow_run", {"id": 123, "head_sha": "0" * 40})]:
            with self.subTest(key=key):
                original = self.artifact
                self.artifact = {**original, key: value}
                with self.assertRaises(ValueError):
                    candidate.verify_origin(self.root, self.environment, self.fetch)
                self.artifact = original

    def test_api_client_uses_only_bounded_authenticated_get(self):
        response = io.BytesIO(b'{"private":true}')
        with patch.object(candidate.urllib.request, "urlopen", return_value=response) as fetch:
            self.assertEqual(candidate.github_json("/actions/runs/123", self.environment), {"private": True})
        request = fetch.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url, "https://api.github.com/repos/lucastsudaka/unite-next/actions/runs/123")
        self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
        self.assertEqual(fetch.call_args.kwargs, {"timeout": 30})

    def test_transfer_preserves_accepted_container_instead_of_rebuilt_reference(self):
        directory = self.accepted()
        before = {path.name: path.read_bytes() for path in directory.iterdir()}
        self.assertNotEqual(self.original, self.reference.read_bytes())
        self.assertEqual(candidate.verify_payload(self.root, self.environment), self.receipt(self.digest))
        transfer = self.build / "accepted-release"
        self.assertEqual({path.name: path.read_bytes() for path in transfer.iterdir()}, before)
        self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)

    def test_transfer_rejects_digest_manifest_source_identity_and_checksum_mismatch(self):
        for change in ("digest", "commit", "repository", "uuid", "version", "boolean-version", "channel", "archive", "checksum"):
            with self.subTest(change=change):
                directory = self.accepted()
                receipt = self.receipt(self.digest)
                if change == "digest": self.environment["ACCEPTED_SHA256"] = "0" * 64
                elif change == "checksum": (directory / (self.filename + ".sha256")).write_text("incorrect\n")
                else:
                    field = "source_commit" if change == "commit" else "version" if change == "boolean-version" else change
                    receipt[field] = True if change == "boolean-version" else "foreign"
                    (directory / "candidate.json").write_text(json.dumps(receipt))
                with self.assertRaises(ValueError):
                    candidate.verify_payload(self.root, self.environment)
                self.assert_not_transferred()

    def test_transfer_rejects_extra_missing_and_symbolic_artifact_files(self):
        directory = self.accepted()
        extra = directory / "private-spec.md"
        extra.write_bytes(b"private")
        with self.assertRaises(ValueError): candidate.verify_payload(self.root, self.environment)
        extra.unlink()
        path = directory / "candidate.json"
        path.unlink()
        with self.assertRaises(ValueError): candidate.verify_payload(self.root, self.environment)
        path.symlink_to(self.metadata_path)
        with self.assertRaises(ValueError): candidate.verify_payload(self.root, self.environment)
        self.assert_not_transferred()

    def test_transfer_rejects_malformed_duplicate_unsafe_private_and_changed_payloads(self):
        variants = [b"not a ZIP", self.zip_bytes({**self.payload, "../escape": b"unsafe"}),
                    self.zip_bytes({**self.payload, "/absolute": b"unsafe"}),
                    self.zip_bytes({**self.payload, "specs/private.md": b"private"}),
                    self.zip_bytes({**self.payload, "extension.js": b"changed source"}),
                    self.zip_bytes({name: value for name, value in self.payload.items() if name != "NOTICE"}),
                    self.zip_bytes(self.payload, mode=stat.S_IFLNK | 0o777)]
        duplicate = io.BytesIO(self.original)
        with warnings.catch_warnings(), zipfile.ZipFile(duplicate, "a") as archive:
            warnings.simplefilter("ignore", UserWarning)
            archive.writestr("extension.js", self.payload["extension.js"])
        variants.append(duplicate.getvalue())
        for index, data in enumerate(variants):
            with self.subTest(variant=index):
                directory = self.accepted(data)
                with self.assertRaises((ValueError, zipfile.BadZipFile)):
                    candidate.verify_payload(self.root, self.environment)
                self.assertEqual((directory / self.filename).read_bytes(), data)
                self.assert_not_transferred()

    def test_transfer_rejects_changed_modes_and_preserves_existing_output(self):
        self.accepted(self.zip_bytes(self.payload, mode=stat.S_IFREG | 0o755))
        with self.assertRaisesRegex(ValueError, "modes"):
            candidate.verify_payload(self.root, self.environment)
        directory = self.accepted()
        transfer = self.build / "accepted-release"
        transfer.mkdir()
        (transfer / "existing").write_bytes(b"preserve")
        with self.assertRaises(FileExistsError):
            candidate.verify_payload(self.root, self.environment)
        self.assertEqual((transfer / "existing").read_bytes(), b"preserve")
        self.assertEqual((directory / self.filename).read_bytes(), self.original)

    def test_cli_origin_appends_outputs_only_after_all_checks_pass(self):
        output = self.root / "outputs"
        output.write_text("existing=kept\n")
        environment = {**self.environment, "GITHUB_OUTPUT": str(output)}
        with patch.object(candidate, "ROOT", self.root), patch.dict(os.environ, environment, clear=True), \
                patch.object(sys, "argv", ["candidate.py", "verify-origin"]), \
                patch.object(candidate, "github_json", side_effect=lambda path, env: self.fetch(path)), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(candidate.main(), 0)
        self.assertEqual(output.read_text(), "existing=kept\nversion=73\nuuid=unite-next@lucastsudaka.github.io\n")
        previous = output.read_bytes()
        with patch.object(candidate, "ROOT", self.root), patch.dict(os.environ, {**environment, "REQUESTED_VERSION": "74"}, clear=True), \
                patch.object(sys, "argv", ["candidate.py", "verify-origin"]), redirect_stderr(io.StringIO()):
            self.assertEqual(candidate.main(), 1)
        self.assertEqual(output.read_bytes(), previous)
