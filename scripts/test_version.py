"""Tests for scripts/version.py; run with:

    python -m unittest discover -s scripts -p "test_*.py"
"""

import io
import json
import tempfile
import unittest
from pathlib import Path

import version


def make_repo(root: Path, value: str = "v1.0.0") -> None:
    (root / "python").mkdir()
    (root / "version").write_text(f"{value}\n", encoding="utf-8")
    (root / "package.json").write_text(
        json.dumps({"name": "x", "version": version.bare(value)}, indent=2) + "\n",
        encoding="utf-8",
    )
    (root / "python/qq_notifier.py").write_text(
        '"""Doc summary.\n\nMore text.\n"""\n\n__all__ = []\n\nX = 1\n',
        encoding="utf-8",
    )


class ValidationTests(unittest.TestCase):
    def test_accepts_versions(self):
        for value in ["v0.0.0", "v1.3.0", "v10.20.30"]:
            self.assertEqual(version.validate_version(value), value)

    def test_rejects_bad_versions(self):
        for value in ["1.3.0", "v1.3", "v1.3.0.1", "v01.3.0", "v1.03.0", "v1.3.0-rc1", ""]:
            with self.assertRaises(version.VersionError):
                version.validate_version(value)


class CheckTests(unittest.TestCase):
    def test_check_passes_after_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            version.update(root, "v1.0.0")
            self.assertEqual(version.check(root, out=io.StringIO()), 0)

    def test_check_detects_package_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            version.update(root, "v1.0.0")
            package = json.loads((root / "package.json").read_text(encoding="utf-8"))
            package["version"] = "9.9.9"
            (root / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
            self.assertEqual(version.check(root, out=io.StringIO()), 1)

    def test_check_reports_missing_docstring_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            version.update(root, "v1.0.0")
            module = (root / "python/qq_notifier.py").read_text(encoding="utf-8")
            (root / "python/qq_notifier.py").write_text(
                module.replace("Version: v1.0.0\n", ""), encoding="utf-8"
            )
            with self.assertRaises(version.VersionError):
                version.check(root, out=io.StringIO())


class UpdateTests(unittest.TestCase):
    def test_update_rewrites_every_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)

            changed = version.update(root, "v2.1.0")

            self.assertEqual(
                sorted(changed), ["package.json", "python/qq_notifier.py", "version"]
            )
            self.assertEqual((root / "version").read_text(encoding="utf-8"), "v2.1.0\n")
            package = json.loads((root / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(package["version"], "2.1.0")
            module = (root / "python/qq_notifier.py").read_text(encoding="utf-8")
            self.assertIn('__version__ = "2.1.0"', module)
            self.assertIn("Version: v2.1.0", module)
            self.assertEqual(version.check(root, out=io.StringIO()), 0)

    def test_update_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            version.update(root, "v2.1.0")
            self.assertEqual(version.update(root, "v2.1.0"), [])

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            changed = version.update(root, "v3.0.0", dry_run=True)
            self.assertIn("version", changed)
            self.assertEqual((root / "version").read_text(encoding="utf-8"), "v1.0.0\n")

    def test_update_rejects_invalid_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_repo(root)
            with self.assertRaises(version.VersionError):
                version.update(root, "1.2.3")


if __name__ == "__main__":
    unittest.main()
