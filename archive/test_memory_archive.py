# SPDX-FileCopyrightText: 2026 Curtis Galloway
# SPDX-License-Identifier: Apache-2.0
"""Tests for memory-archive, the job that keeps a local copy of the notes repo.

Run from the repository root: uv run --with pytest pytest archive

The job is driven end to end against a real local git repository. A `git`
wrapper stands in for the network: it sends the https remote to the local
repository and records every command line it was given.

The wrapper lives in a tools directory outside the archive, so a search of
the archive for the token is a search of what the job itself wrote.
"""

import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import textwrap
import time

import pytest

SOURCE = pathlib.Path(__file__).resolve().parent / "memory-archive"
LOADER = importlib.machinery.SourceFileLoader("memory_archive", str(SOURCE))
SPEC = importlib.util.spec_from_loader("memory_archive", LOADER)
memory_archive = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(memory_archive)

GIT = shutil.which("git")
REMOTE_BASE = "https://acct0123456789.example.invalid/git/default/"
REMOTE = REMOTE_BASE + "memory-test.git"
SECRET = "art_v1_0123456789abcdefTESTONLY"
EXPIRY = 1900000000
TOKEN = "%s?expires=%d" % (SECRET, EXPIRY)
PREFIX = "memory_archive_"
METRIC_LINE = re.compile(r'^(memory_archive_[a-z_]+)\{repo="([^"]*)"\} (-?[0-9]+)$')


def git(cwd, *args):
    env = dict(
        os.environ,
        GIT_CONFIG_GLOBAL="/dev/null",
        GIT_CONFIG_NOSYSTEM="1",
        GIT_AUTHOR_NAME="claude-code",
        GIT_AUTHOR_EMAIL="claude-code@example.invalid",
        GIT_COMMITTER_NAME="claude-code",
        GIT_COMMITTER_EMAIL="claude-code@example.invalid",
    )
    done = subprocess.run(
        [GIT, *args], cwd=cwd, env=env, capture_output=True, text=True, check=True
    )
    return done.stdout.strip()


class Rig:
    """One archive machine in a temporary directory."""

    def __init__(self, tmp, monkeypatch):
        self.monkeypatch = monkeypatch
        self.tools = tmp / "tools"
        self.origin = tmp / "upstream" / "memory-test.git"
        self.work = tmp / "upstream" / "work"
        self.root = tmp / "host" / "archive"
        self.metrics = tmp / "host" / "memory_archive.prom"
        self.creds = tmp / "creds"
        self.git_log = self.tools / "git-argv.log"
        self.header_log = self.tools / "git-header.log"
        for directory in (self.tools, self.origin, self.work, self.root, self.creds):
            directory.mkdir(parents=True)
        self.metrics.write_text("")
        self.set_token(TOKEN)

        wrapper = self.tools / "git"
        wrapper.write_text(
            "#!/bin/sh\n"
            'printf "%%s\\n" "$*" >> "%(argv)s"\n'
            'for a in "$@"; do if [ "$a" = fetch ]; then\n'
            '  if [ "$GIT_CONFIG_VALUE_4" = "Authorization: Bearer %(token)s" ]; then\n'
            '    echo sent >> "%(header)s"; else echo missing >> "%(header)s"; fi\n'
            '  if [ -e "%(tools)s/SLOW_FETCH" ]; then sleep 30; fi\n'
            '  if [ -e "%(tools)s/FAIL_FETCH" ]; then\n'
            "    echo \"fatal: unable to access '%(remote)s': 401 for %(token)s\" >&2\n"
            "    exit 128\n"
            "  fi\n"
            "fi; done\n"
            'exec "%(git)s" -c "url.file://%(upstream)s/.insteadOf=%(base)s" "$@"\n'
            % {
                "argv": self.git_log,
                "header": self.header_log,
                "token": TOKEN,
                "tools": self.tools,
                "remote": REMOTE,
                "git": GIT,
                "upstream": self.origin.parent,
                "base": REMOTE_BASE,
            }
        )
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)

        git(self.origin, "init", "--quiet", "--bare", "--initial-branch=main")
        git(self.work, "init", "--quiet", "--initial-branch=main")
        git(self.work, "remote", "add", "origin", str(self.origin))
        self.commit("profile/about.md", "first\n")

        monkeypatch.delenv("MEMORY_ARCHIVE_TOKEN", raising=False)
        monkeypatch.delenv("MEMORY_ARCHIVE_DEADLINE_SECONDS", raising=False)
        for name, value in {
            "MEMORY_ARCHIVE_REMOTE": REMOTE,
            "MEMORY_ARCHIVE_ROOT": str(self.root),
            "MEMORY_ARCHIVE_METRICS": str(self.metrics),
            "MEMORY_ARCHIVE_GIT": str(wrapper),
            "CREDENTIALS_DIRECTORY": str(self.creds),
        }.items():
            monkeypatch.setenv(name, value)

    def set_token(self, token):
        """Store the token the way systemd's LoadCredential= would hand it over."""
        (self.creds / memory_archive.TOKEN_CREDENTIAL).write_text(token + "\n")

    def set_remote(self, remote):
        self.monkeypatch.setenv("MEMORY_ARCHIVE_REMOTE", remote)

    def commit(self, path, text):
        target = self.work / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        git(self.work, "add", path)
        git(self.work, "commit", "--quiet", "-m", "write " + path)
        git(self.work, "push", "--quiet", "--force", "origin", "main")
        return git(self.work, "rev-parse", "HEAD")

    def replace_upstream_history(self):
        shutil.rmtree(self.work / ".git")
        git(self.work, "init", "--quiet", "--initial-branch=main")
        git(self.work, "remote", "add", "origin", str(self.origin))
        return self.commit("profile/about.md", "replaced\n")

    @property
    def clone(self):
        return self.root / "memory-test"

    @property
    def state_file(self):
        return self.root / ".state" / "state.json"

    def archived_head(self):
        return git(self.clone, "rev-parse", "refs/heads/main")

    def values(self):
        found = {}
        for line in self.metrics.read_text().splitlines():
            match = METRIC_LINE.match(line)
            if match:
                found[match.group(1)[len(PREFIX) :]] = (
                    match.group(2),
                    int(match.group(3)),
                )
        return found


@pytest.fixture
def rig(tmp_path, monkeypatch):
    return Rig(tmp_path, monkeypatch)


def run(capsys):
    status = memory_archive.main()
    return status, capsys.readouterr().out


# --- the pure pieces --------------------------------------------------------


@pytest.mark.parametrize(
    "token, expected",
    [
        (TOKEN, EXPIRY),
        ("abc?expires=1795626171", 1795626171),
        ("abc", None),
        ("abc?expires=", None),
        ("abc?expires=soon", None),
        ("abc?expires=1795626171&x=1", None),
        ("?expires=17", None),
    ],
)
def test_expiry_is_read_from_the_token(token, expected):
    assert memory_archive.parse_expiry(token) == expected


def test_remote_gives_the_repo_name():
    assert memory_archive.check_remote(REMOTE) == "memory-test"
    assert memory_archive.check_remote(REMOTE_BASE + "memory") == "memory"


@pytest.mark.parametrize(
    "remote",
    [
        "http://acct.example.invalid/git/default/memory.git",
        "https://x:secret@acct.example.invalid/git/default/memory.git",
        "https://acct.example.invalid",
        "https://acct.example.invalid/git/default/..git",
        "https://acct.example.invalid/git/default/.state",
        "https://acct.example.invalid/git/default/-rf.git",
        "https://acct.example.invalid/git/default/memory.git?x=1",
        "https://acct.example.invalid/git/default/mem ory.git",
        "/srv/git/memory.git",
        "ssh://git@example.invalid/memory.git",
    ],
)
def test_unacceptable_remotes_are_refused(remote):
    with pytest.raises(memory_archive.Failure) as raised:
        memory_archive.check_remote(remote)
    assert raised.value.step == "remote"
    assert "secret" not in raised.value.message


def test_scrub_hides_every_secret_and_keeps_one_line():
    text = "first line\nfatal: %s and %s\n" % (TOKEN, REMOTE)
    assert memory_archive.scrub(text, [TOKEN, SECRET, REMOTE]) == (
        "fatal: <hidden> and <hidden>"
    )


def test_the_time_budget_is_inside_the_units_limit():
    """The steps must not add up to more than systemd allows."""
    unit = (SOURCE.parent / "memory-archive.service").read_text()
    limit = int(unit.split("TimeoutStartSec=")[1].split()[0])
    budget = memory_archive.DEFAULT_DEADLINE_SECONDS
    grace = max(
        memory_archive.BACKSTOP_GRACE_MINIMUM,
        budget / memory_archive.BACKSTOP_GRACE_FRACTION,
    )
    # The backstop fires at budget + grace and needs time to record and exit.
    assert budget + grace == 270
    assert budget + grace + 20 <= limit
    assert memory_archive.FETCH_STEP_SECONDS < memory_archive.DEFAULT_DEADLINE_SECONDS


def test_the_unit_loads_the_token_under_the_name_the_job_reads():
    unit = (SOURCE.parent / "memory-archive.service").read_text()
    wanted = "LoadCredential=%s:" % memory_archive.TOKEN_CREDENTIAL
    assert wanted in unit
    assert "MEMORY_ARCHIVE_TOKEN=" not in unit


def test_a_deadline_hands_out_what_is_left_then_fails():
    deadline = memory_archive.Deadline(0.2)
    assert 0 < deadline.allow("fetch", 180) <= 0.2
    assert deadline.allow("fetch", 0.05) == 0.05
    time.sleep(0.25)
    with pytest.raises(memory_archive.Failure) as raised:
        deadline.allow("fetch", 180)
    assert raised.value.step == "fetch"


# --- whole runs -------------------------------------------------------------


def test_first_run_clones_with_full_history(rig, capsys):
    rig.commit("projects/one.md", "second\n")
    head = rig.commit("projects/two.md", "third\n")
    before = int(time.time())

    status, out = run(capsys)

    assert status == 0
    assert rig.archived_head() == head
    assert git(rig.clone, "rev-list", "--count", "main") == "3"
    assert git(rig.clone, "log", "-1", "--format=%an", "main") == "claude-code"
    assert (rig.clone / "projects" / "two.md").read_text() == "third\n"
    assert (
        out == "memory-archive: ok repo=memory-test head=%s changed=yes\n" % head[:12]
    )
    values = rig.values()
    assert values["last_run_ok"] == ("memory-test", 1)
    assert values["token_expiry_timestamp_seconds"] == ("memory-test", EXPIRY)
    assert values["last_success_timestamp_seconds"][1] >= before
    assert values["last_run_timestamp_seconds"][1] >= before
    assert values["head_commit_timestamp_seconds"][1] == int(
        git(rig.work, "log", "-1", "--format=%ct")
    )


def test_a_later_write_is_fast_forwarded(rig, capsys):
    assert run(capsys)[0] == 0
    head = rig.commit("projects/later.md", "later\n")

    status, out = run(capsys)

    assert status == 0
    assert rig.archived_head() == head
    assert "changed=yes" in out


def test_a_run_with_nothing_new_succeeds_and_says_so(rig, capsys):
    assert run(capsys)[0] == 0
    status, out = run(capsys)
    assert status == 0
    assert "changed=no" in out
    assert rig.values()["last_run_ok"][1] == 1


def test_rewritten_history_fails_and_keeps_the_archive(rig, capsys):
    rig.commit("projects/keep.md", "must survive\n")
    assert run(capsys)[0] == 0
    archived = rig.archived_head()
    good = rig.values()
    rig.replace_upstream_history()

    status, out = run(capsys)

    assert status == 1
    assert out.startswith("memory-archive: failed step=diverged repo=memory-test ")
    assert rig.archived_head() == archived
    assert (rig.clone / "projects" / "keep.md").read_text() == "must survive\n"
    values = rig.values()
    assert values["last_run_ok"][1] == 0
    assert (
        values["last_success_timestamp_seconds"]
        == good["last_success_timestamp_seconds"]
    )
    assert (
        values["head_commit_timestamp_seconds"] == good["head_commit_timestamp_seconds"]
    )


@pytest.mark.parametrize("damage", ["empty", "garbage"])
def test_an_unreadable_local_main_stops_the_run_and_changes_nothing(
    rig, capsys, damage
):
    """ "Cannot be read" must not be taken for "absent".

    A ref file left empty or damaged (a power loss; git does not sync refs)
    would send the run down the first-clone path, which points main at the
    remote commit with no fast-forward check.
    """
    rig.commit("projects/keep.md", "must survive\n")
    assert run(capsys)[0] == 0
    ref = rig.clone / ".git" / "refs" / "heads" / "main"
    assert ref.is_file()
    content = b"" if damage == "empty" else b"not a commit id\n"
    ref.write_bytes(content)
    # The worst case: upstream history was replaced while main is unreadable.
    rig.replace_upstream_history()
    commands_before = len(rig.git_log.read_text().splitlines())

    status, out = run(capsys)

    assert status == 1
    assert "changed=" not in out
    assert out.startswith("memory-archive: failed step=")
    assert ref.read_bytes() == content
    assert (rig.clone / "projects" / "keep.md").read_text() == "must survive\n"
    # Nothing that moves a branch or the working tree was even attempted.
    for command in rig.git_log.read_text().splitlines()[commands_before:]:
        assert " checkout " not in command and " merge " not in command, command
    assert rig.values()["last_run_ok"][1] == 0


def test_main_is_created_when_a_first_run_failed_before_any_checkout(rig, capsys):
    """A clone that exists but verifiably has no main yet is finished, not refused."""
    (rig.tools / "FAIL_FETCH").write_text("")
    assert run(capsys)[0] == 1
    assert (rig.clone / ".git").is_dir()
    (rig.tools / "FAIL_FETCH").unlink()

    status, out = run(capsys)

    assert status == 0
    assert "changed=yes" in out
    assert rig.archived_head() == git(rig.work, "rev-parse", "HEAD")


def test_a_run_stopped_between_init_and_remote_add_recovers(rig, capsys):
    rig.clone.mkdir()
    git(rig.clone, "init", "--quiet", "--initial-branch=main")

    status, out = run(capsys)

    assert status == 0, out
    assert git(rig.clone, "config", "--get", "remote.origin.url") == REMOTE
    assert rig.archived_head() == git(rig.work, "rev-parse", "HEAD")


def test_the_backstop_records_a_failure_when_a_step_cannot_be_bounded(rig):
    """A hang nothing inside the run can end.

    The sync step is replaced by one that sleeps far past the budget, so only
    the watchdog ends the run. It must still record the failure. The watchdog
    exits the process, so this run is a separate process.
    """
    done = subprocess.run(
        [sys.executable, str(SOURCE)], capture_output=True, text=True, check=False
    )
    assert done.returncode == 0, done.stdout + done.stderr
    good = rig.values()
    driver = textwrap.dedent("""
        import importlib.machinery, importlib.util, sys, time
        loader = importlib.machinery.SourceFileLoader("m", sys.argv[1])
        spec = importlib.util.spec_from_loader("m", loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        module.sync = lambda *args: time.sleep(120)
        sys.exit(module.main())
        """)
    env = dict(os.environ, MEMORY_ARCHIVE_DEADLINE_SECONDS="1")
    started = time.monotonic()

    done = subprocess.run(
        [sys.executable, "-c", driver, str(SOURCE)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=40,
    )

    # Budget 1 s plus the 5 s minimum grace.
    assert 5 < time.monotonic() - started < 12
    assert done.returncode == 1
    assert done.stdout.startswith(
        "memory-archive: failed step=deadline repo=memory-test the run did not finish"
    )
    assert "Traceback" not in done.stderr
    values = rig.values()
    assert values["last_run_ok"] == ("memory-test", 0)
    assert (
        values["last_run_timestamp_seconds"][1] >= good["last_run_timestamp_seconds"][1]
    )
    assert (
        values["last_success_timestamp_seconds"]
        == good["last_success_timestamp_seconds"]
    )
    assert values["token_expiry_timestamp_seconds"] == ("memory-test", EXPIRY)
    assert json.loads(rig.state_file.read_text())["last_success"] == (
        good["last_success_timestamp_seconds"][1]
    )


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "-5", "0", "soon", ""])
def test_a_budget_that_is_not_a_positive_number_is_refused(rig, capsys, value):
    rig.monkeypatch.setenv("MEMORY_ARCHIVE_DEADLINE_SECONDS", value)
    status, out = run(capsys)
    assert status == 2
    assert "MEMORY_ARCHIVE_DEADLINE_SECONDS" in out
    assert rig.metrics.read_text() == ""
    assert not rig.clone.exists()


def test_a_partly_written_metric_file_is_named_in_words(rig, capsys):
    """The reason printed used to be the word None."""
    assert run(capsys)[0] == 0
    real_write = os.write

    def short(descriptor, data):
        return real_write(descriptor, data[:10])

    rig.monkeypatch.setattr(memory_archive.os, "write", short)
    status, out = run(capsys)
    assert status == 1
    assert "failed step=metrics" in out and "partly written" in out
    assert "None" not in out


def test_a_refused_fetch_fails_without_printing_the_token_or_the_remote(rig, capsys):
    assert run(capsys)[0] == 0
    good = rig.values()
    (rig.tools / "FAIL_FETCH").write_text("")

    status, out = run(capsys)

    assert status == 1
    assert out.startswith("memory-archive: failed step=fetch repo=memory-test ")
    assert "401" in out and "<hidden>" in out
    assert SECRET not in out and "expires=" not in out
    assert "acct0123456789" not in out
    values = rig.values()
    assert values["last_run_ok"][1] == 0
    assert (
        values["last_success_timestamp_seconds"]
        == good["last_success_timestamp_seconds"]
    )


def test_a_hung_fetch_ends_as_a_recorded_failure(rig, capsys):
    """The deadline, not systemd's kill, ends a slow run."""
    assert run(capsys)[0] == 0
    good = rig.values()
    (rig.tools / "SLOW_FETCH").write_text("")
    rig.monkeypatch.setenv("MEMORY_ARCHIVE_DEADLINE_SECONDS", "3")
    started = time.monotonic()

    status, out = run(capsys)

    # Well under the wrapper's 30 s sleep: the whole process group was killed.
    assert time.monotonic() - started < 10
    assert status == 1
    assert out.startswith(
        "memory-archive: failed step=fetch repo=memory-test git timed out"
    )
    values = rig.values()
    assert values["last_run_ok"][1] == 0
    assert (
        values["last_run_timestamp_seconds"][1] >= good["last_run_timestamp_seconds"][1]
    )
    assert (
        values["last_success_timestamp_seconds"]
        == good["last_success_timestamp_seconds"]
    )


def test_git_that_cannot_start_still_rewrites_the_metrics(rig, capsys):
    """No path out of a run skips the metric file."""
    assert run(capsys)[0] == 0
    rig.monkeypatch.setenv("MEMORY_ARCHIVE_GIT", str(rig.tools / "no-such-git"))

    status, out = run(capsys)

    assert status == 1
    assert out.startswith(
        "memory-archive: failed step=clone repo=memory-test could not start git"
    )
    assert rig.values()["last_run_ok"][1] == 0


def test_a_yes_or_no_git_question_that_times_out_is_a_failure():
    deadline = memory_archive.Deadline(0.3)
    sleeper = memory_archive.Git("sleep", [], deadline)
    with pytest.raises(memory_archive.Failure) as raised:
        sleeper.status("refs", "5")
    assert raised.value.step == "refs"
    assert "timed out" in raised.value.message


def test_a_token_without_an_expiry_fails_before_any_fetch(rig, capsys):
    rig.set_token(SECRET)
    status, out = run(capsys)
    assert status == 1
    assert out.startswith("memory-archive: failed step=token ")
    assert SECRET not in out
    assert not rig.header_log.exists()
    assert not rig.clone.exists()


def test_a_new_token_is_picked_up_on_the_next_run(rig, capsys):
    assert run(capsys)[0] == 0
    rig.set_token("%s?expires=%d" % (SECRET, EXPIRY + 86400))
    status, _ = run(capsys)
    assert status == 0
    assert rig.values()["token_expiry_timestamp_seconds"][1] == EXPIRY + 86400


def test_another_repo_gets_its_own_clone_and_a_fresh_record(rig, capsys):
    assert run(capsys)[0] == 0
    first_head = rig.archived_head()
    other = rig.origin.parent / "memory.git"
    git(rig.origin.parent, "clone", "--quiet", "--bare", str(rig.origin), str(other))
    rig.set_remote(REMOTE_BASE + "memory.git")

    status, out = run(capsys)

    assert status == 0
    assert "repo=memory " in out
    assert (rig.root / "memory" / ".git").is_dir()
    assert rig.archived_head() == first_head
    assert set(label for label, _ in rig.values().values()) == {"memory"}


def test_a_clone_whose_origin_changed_is_refused(rig, capsys):
    assert run(capsys)[0] == 0
    archived = rig.archived_head()
    rig.set_remote("https://elsewhere.example.invalid/git/default/memory-test.git")

    status, out = run(capsys)

    assert status == 1
    assert "step=remote" in out
    assert "elsewhere" not in out
    assert rig.archived_head() == archived


def test_a_remote_with_a_password_in_it_is_refused_and_never_printed(rig, capsys):
    rig.set_remote("https://user:hunter2@acct.example.invalid/git/default/memory.git")
    status, out = run(capsys)
    assert status == 1
    assert out.startswith("memory-archive: failed step=remote ")
    assert "hunter2" not in out
    assert not rig.header_log.exists()


# --- reading the settings and the token --------------------------------------


def test_missing_remote_exits_2(rig, capsys):
    rig.monkeypatch.delenv("MEMORY_ARCHIVE_REMOTE")
    status, out = run(capsys)
    assert status == 2
    assert "MEMORY_ARCHIVE_REMOTE" in out
    assert not rig.clone.exists()


def test_no_token_source_at_all_exits_2(rig, capsys):
    rig.monkeypatch.delenv("CREDENTIALS_DIRECTORY")
    status, out = run(capsys)
    assert status == 2
    assert "MEMORY_ARCHIVE_TOKEN" in out
    assert not rig.clone.exists()


def test_the_token_can_come_from_the_environment(rig, capsys):
    rig.monkeypatch.delenv("CREDENTIALS_DIRECTORY")
    rig.monkeypatch.setenv("MEMORY_ARCHIVE_TOKEN", TOKEN)

    status, out = run(capsys)

    assert status == 0, out
    assert rig.header_log.read_text().split() == ["sent"]
    assert rig.values()["token_expiry_timestamp_seconds"][1] == EXPIRY


def test_the_environment_token_wins_over_the_credential_file(rig, capsys):
    rig.set_token("art_v1_wrong?expires=1")
    rig.monkeypatch.setenv("MEMORY_ARCHIVE_TOKEN", TOKEN)

    status, out = run(capsys)

    assert status == 0, out
    assert rig.values()["token_expiry_timestamp_seconds"][1] == EXPIRY


def test_a_missing_credential_file_is_a_recorded_failure(rig, capsys):
    (rig.creds / memory_archive.TOKEN_CREDENTIAL).unlink()
    status, out = run(capsys)
    assert status == 1
    assert out.startswith("memory-archive: failed step=token repo=memory-test no token")
    assert rig.values()["last_run_ok"] == ("memory-test", 0)
    assert not rig.clone.exists()


@pytest.mark.parametrize("text", ["", "   \n", "art_v1_two words?expires=1900000000"])
def test_an_empty_or_malformed_token_is_refused_without_printing_it(rig, capsys, text):
    (rig.creds / memory_archive.TOKEN_CREDENTIAL).write_text(text)
    status, out = run(capsys)
    assert status == 1
    assert out.startswith("memory-archive: failed step=token ")
    assert "art_v1" not in out
    assert not rig.header_log.exists()


def test_a_run_without_a_metric_path_writes_no_metrics(rig, capsys):
    rig.monkeypatch.delenv("MEMORY_ARCHIVE_METRICS")

    status, out = run(capsys)

    assert status == 0, out
    assert rig.metrics.read_text() == ""
    assert rig.state_file.is_file()
    assert "metrics" not in out


def test_the_help_text_names_every_setting():
    done = subprocess.run(
        [sys.executable, str(SOURCE), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0
    for name in (
        "MEMORY_ARCHIVE_REMOTE",
        "MEMORY_ARCHIVE_TOKEN",
        "CREDENTIALS_DIRECTORY",
        "MEMORY_ARCHIVE_ROOT",
        "MEMORY_ARCHIVE_METRICS",
        "MEMORY_ARCHIVE_GIT",
        "MEMORY_ARCHIVE_DEADLINE_SECONDS",
    ):
        assert name in done.stdout, name


# --- what the job remembers --------------------------------------------------


def test_state_is_kept_in_its_own_file_not_in_the_metric_file(rig, capsys):
    assert run(capsys)[0] == 0
    good = rig.values()
    saved = json.loads(rig.state_file.read_text())
    assert saved["repo"] == "memory-test"
    assert saved["last_success"] == good["last_success_timestamp_seconds"][1]
    assert saved["token_expiry"] == EXPIRY
    assert not list(rig.state_file.parent.glob("*.tmp"))

    # The metric file is lost between runs (a run killed mid-write, a full
    # disk), and the next run fails. What was known must survive.
    rig.metrics.write_text("")
    (rig.tools / "FAIL_FETCH").write_text("")

    assert run(capsys)[0] == 1
    values = rig.values()
    assert values["last_run_ok"] == ("memory-test", 0)
    assert (
        values["last_success_timestamp_seconds"]
        == good["last_success_timestamp_seconds"]
    )
    assert values["token_expiry_timestamp_seconds"] == ("memory-test", EXPIRY)
    assert (
        values["head_commit_timestamp_seconds"] == good["head_commit_timestamp_seconds"]
    )


def test_a_damaged_state_file_is_not_trusted_and_is_replaced(rig, capsys):
    assert run(capsys)[0] == 0
    rig.state_file.write_text('{"repo": "memory-test", "last_succ')
    (rig.tools / "FAIL_FETCH").write_text("")
    assert run(capsys)[0] == 1
    assert rig.values()["last_success_timestamp_seconds"] == ("memory-test", 0)
    (rig.tools / "FAIL_FETCH").unlink()
    assert run(capsys)[0] == 0
    assert json.loads(rig.state_file.read_text())["repo"] == "memory-test"


def test_a_metric_file_that_cannot_be_written_fails_the_run_but_keeps_state(
    rig, capsys
):
    assert run(capsys)[0] == 0
    first = json.loads(rig.state_file.read_text())
    time.sleep(1.1)
    rig.metrics.unlink()
    rig.metrics.mkdir()

    status, out = run(capsys)

    assert status == 1
    assert "memory-archive: ok repo=memory-test" in out
    assert "failed step=metrics" in out
    assert (
        json.loads(rig.state_file.read_text())["last_success"] > first["last_success"]
    )


def test_a_state_file_that_cannot_be_written_fails_the_run(rig, capsys):
    assert run(capsys)[0] == 0
    rig.state_file.unlink()
    rig.state_file.mkdir()

    status, out = run(capsys)

    assert status == 1
    assert "failed step=state" in out
    assert rig.values()["last_run_ok"][1] == 0


def test_the_metric_file_is_never_left_empty_or_with_a_stale_tail(rig, capsys):
    rig.metrics.write_text("x" * 5000)
    assert run(capsys)[0] == 0
    text = rig.metrics.read_text()
    assert "x" * 10 not in text
    assert text.endswith("\n")

    # The rewrite never opens the file with truncation.
    opened = []
    real_open = os.open

    def spy(path, flags, *args, **kwargs):
        if str(path) == str(rig.metrics):
            opened.append(flags)
        return real_open(path, flags, *args, **kwargs)

    rig.monkeypatch.setattr(os, "open", spy)
    assert run(capsys)[0] == 0
    assert opened and not any(flags & os.O_TRUNC for flags in opened)


def test_metric_file_is_valid_exposition_text(rig, capsys):
    assert run(capsys)[0] == 0
    lines = rig.metrics.read_text().splitlines()
    assert len(lines) == 15
    for index in range(0, 15, 3):
        name = lines[index + 2].split("{")[0]
        assert lines[index].startswith("# HELP %s " % name)
        assert lines[index + 1] == "# TYPE %s gauge" % name
        assert METRIC_LINE.match(lines[index + 2])


# --- the token stays off disk and off command lines --------------------------


def test_the_token_reaches_git_only_as_a_header_for_the_fetch(rig, capsys):
    assert run(capsys)[0] == 0
    rig.commit("projects/more.md", "more\n")
    assert run(capsys)[0] == 0

    # Every fetch carried the header, in the environment.
    assert rig.header_log.read_text().split() == ["sent", "sent"]
    # No command line ever held the token or a URL with a user in it.
    argv = rig.git_log.read_text()
    assert SECRET not in argv and "expires=" not in argv
    assert "Bearer" not in argv
    assert "@" not in argv


def test_only_git_is_ever_started_and_only_the_fetch_gets_the_token(
    rig, capsys, monkeypatch
):
    started = []
    real_popen = subprocess.Popen

    def spy(argv, *args, **kwargs):
        started.append((argv, kwargs.get("env", {})))
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(memory_archive.subprocess, "Popen", spy)
    assert run(capsys)[0] == 0
    assert started
    carrying = 0
    for argv, env in started:
        assert argv[0] == str(rig.tools / "git")
        assert SECRET not in " ".join(argv)
        assert "MEMORY_ARCHIVE_TOKEN" not in env
        assert "CREDENTIALS_DIRECTORY" not in env
        if SECRET in json.dumps(env):
            carrying += 1
            assert "fetch" in argv
    assert carrying == 1


def test_nothing_the_job_wrote_holds_the_token(rig, capsys):
    assert run(capsys)[0] == 0
    (rig.tools / "FAIL_FETCH").write_text("")
    assert run(capsys)[0] == 1

    host = rig.root.parent
    searched = 0
    for directory, _, files in os.walk(host):
        for name in files:
            data = (pathlib.Path(directory) / name).read_bytes()
            searched += 1
            assert SECRET.encode() not in data, name
            assert b"Bearer" not in data, name
    assert searched > 10  # the clone, the state and the metrics were searched
    assert rig.state_file.is_file()

    config = (rig.clone / ".git" / "config").read_text()
    assert "url = %s" % REMOTE in config
    assert "helper" not in config and "extraheader" not in config.lower()
