"""Exercise the publisher's independent visibility guard without external writes."""
import ast
from pathlib import Path
import textwrap
import types
import unittest
import urllib.request
from unittest.mock import Mock


class PublisherGuardTests(unittest.TestCase):
    def setUp(self):
        workflow = (Path(__file__).resolve().parents[1] /
                    ".github/workflows/release.yml").read_text()
        scripts = workflow.split("/usr/bin/python3 - <<'PY'\n")[1:]
        publishers = [textwrap.dedent(script.split("\n          PY", 1)[0])
                      for script in scripts if "def check_public():" in script]
        self.assertEqual(len(publishers), 1)
        parsed = ast.parse(publishers[0])
        selected = [node for node in parsed.body if isinstance(node, ast.FunctionDef)
                    and node.name in ("check_public", "request")]
        self.assertEqual(len(selected), 2)
        self.repository = {"private": False, "fork": False,
                           "full_name": "lucastsudaka/unite-next", "default_branch": "master"}
        self.namespace = {"repository": "lucastsudaka/unite-next"}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "publisher-guard", "exec"),
             self.namespace)

    def test_only_the_selected_public_independent_repository_is_accepted(self):
        self.namespace["request"] = Mock(return_value=self.repository)
        self.namespace["check_public"]()
        self.namespace["request"].assert_called_once_with("GET", "")
        for key, value in (("private", True), ("private", None), ("private", 0),
                           ("fork", True), ("fork", 0), ("full_name", "other/repo"),
                           ("default_branch", "other")):
            with self.subTest(key=key, value=value):
                self.namespace["request"] = Mock(return_value={**self.repository, key: value})
                with self.assertRaises(ValueError):
                    self.namespace["check_public"]()

    def test_every_mutating_request_checks_visibility_before_network_or_credentials(self):
        rejected = Mock(side_effect=ValueError("Repository is no longer public"))
        network = Mock(side_effect=AssertionError("A rejected mutation reached the network"))
        self.namespace.update(check_public=rejected,
                              urllib=types.SimpleNamespace(request=types.SimpleNamespace(
                                  Request=network, urlopen=network)))
        for method in ("POST", "PATCH", "DELETE"):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, "no longer public"):
                self.namespace["request"](method, "/releases", {"name": "fixture"})
        self.assertEqual(rejected.call_count, 3)
        network.assert_not_called()


if __name__ == "__main__":
    unittest.main()
