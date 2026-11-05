import subprocess
from pathlib import Path

from platform_worker.crews.tools import ListFiles, ReadFile, RunCommand, SearchCode, WriteFile


def ws(tmp_path: Path) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("def hello():\n    return 'hi'\n")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    return tmp_path


def bind(cls, root, log):
    return cls().bind(root, lambda t, a, r: log.append((t, r)), "tester")


def test_tools_confined_and_reported(tmp_path: Path) -> None:
    root, log = ws(tmp_path), []
    assert "src/app.py" in bind(ListFiles, root, log)._run(path=".")
    assert "return 'hi'" in bind(ReadFile, root, log)._run(path="src/app.py")
    assert bind(ReadFile, root, log)._run(path="../../etc/passwd").startswith("ERROR")
    assert bind(ReadFile, root, log)._run(path=".git/config").startswith("ERROR")
    assert "created" in bind(WriteFile, root, log)._run(path="src/new.py", content="x = 1\n")
    assert bind(WriteFile, root, log)._run(path="/tmp/../../evil", content="x").startswith(("ERROR", "created"))
    assert not Path("/evil").exists()
    assert "src/app.py:1" in bind(SearchCode, root, log)._run(pattern="def hello")
    assert len(log) == 7


def test_run_command_allowlist(tmp_path: Path) -> None:
    root, log = ws(tmp_path), []
    rc = bind(RunCommand, root, log).allow(["ls"])
    assert "exit code 0" in rc._run(command="ls src")
    assert rc._run(command="rm -rf src").startswith("ERROR: command not allowed")
    assert rc._run(command="ls; rm -rf src").startswith("ERROR")
    assert (root / "src" / "app.py").exists()
