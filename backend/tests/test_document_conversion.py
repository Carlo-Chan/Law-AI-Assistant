"""DOC 转换的离线边界测试，不要求测试机安装 Office，也不启动外部程序。"""

import io
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from xml.etree import ElementTree
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from docx import Document
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import routes
from app.core.config import Settings
from app.core.errors import (
    CONVERTED_DOCUMENT_TOO_LARGE,
    DOCUMENT_CONVERSION_TIMEOUT,
    DOCUMENT_CONVERTER_BUSY,
    DOCUMENT_CONVERTER_UNAVAILABLE,
    INVALID_DOCUMENT,
    PublicError,
)
from app.main import app
from app.services import document_conversion as conversion

DOC_BYTES = conversion.OLE_SIGNATURE + b"synthetic DOC"


def _docx_bytes():
    document = Document()
    document.add_paragraph("租赁合同")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "押金"
    table.cell(0, 1).text = "2000元"
    table.cell(1, 0).text = "租金"
    table.cell(1, 1).text = "3000元"
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def harness(tmp_path, monkeypatch):
    """模拟转换进程，保留真实目录、产物校验、清理和解析。"""
    executable = tmp_path / "office program" / "soffice.com"
    executable.parent.mkdir()
    executable.write_bytes(b"fake executable")
    monkeypatch.setattr(conversion, "_find_executable", lambda configured: executable)
    monkeypatch.setattr(
        conversion,
        "get_settings",
        lambda: SimpleNamespace(
            libreoffice_path=str(executable),
            doc_conversion_timeout_seconds=7,
            doc_conversion_temp_dir=str(tmp_path),
        ),
    )
    monkeypatch.setattr(conversion, "_conversion_slots", threading.BoundedSemaphore(2))
    launched = []

    def launch(command, **options):
        job = Path(options["cwd"])
        process = Mock(pid=12345)
        process.wait.return_value = 0
        process.poll.return_value = 0
        (job / "output" / "input.docx").write_bytes(_docx_bytes())
        launched.append((command, options, process))
        return process

    launcher = Mock(side_effect=launch)
    monkeypatch.setattr(conversion.subprocess, "Popen", launcher)
    return SimpleNamespace(root=tmp_path, launched=launched, launcher=launcher, launch=launch)


def _assert_error(expected, action):
    with pytest.raises(PublicError) as caught:
        action()
    assert caught.value.info == expected


def _assert_slots_available():
    slots = conversion._conversion_slots
    assert slots.acquire(blocking=False)
    assert slots.acquire(blocking=False)
    assert not slots.acquire(blocking=False)
    slots.release()
    slots.release()


def test_success_uses_private_profile_safe_arguments_and_cleans_job(harness, monkeypatch):
    """应用密钥不传递给转换器，目录分离，完成后仅清理自身临时文件。"""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "must-not-inherit")
    monkeypatch.setenv("UNRELATED_SECRET", "must-not-inherit")
    original = harness.launch
    profiles = []

    def launch(command, **options):
        job = Path(options["cwd"])
        assert (job / "input.doc").read_bytes() == DOC_BYTES
        profile = ElementTree.parse(job / "profile" / "user" / "registrymodifications.xcu")
        namespace = {"oor": "http://openoffice.org/2001/registry"}
        properties = {
            element.attrib[f"{{{namespace['oor']}}}name"]: element.findtext("value")
            for element in profile.findall(".//prop")
        }
        for name in (
            "DisableMacrosExecution",
            "DisableActiveContent",
            "DisableOLEAutomation",
            "BlockUntrustedRefererLinks",
        ):
            assert properties[name] == "true"
        assert properties["MacroSecurityLevel"] == "3"
        assert properties["Link"] == "2"
        assert properties["Field"] == properties["Chart"] == "false"
        profiles.append(job / "profile")
        assert "--headless" in command
        assert "--infilter=MS Word 97" in command
        assert command[command.index("--convert-to") + 1] == "docx:Office Open XML Text"
        assert f"-env:UserInstallation={(job / 'profile').as_uri()}" in command
        assert options["shell"] is False
        for stream in ("stdin", "stdout", "stderr"):
            assert options[stream] == subprocess.DEVNULL
        assert "DEEPSEEK_API_KEY" not in options["env"]
        assert "UNRELATED_SECRET" not in options["env"]
        assert options["env"]["TEMP"] == str(job / "scratch")
        return original(command, **options)

    harness.launcher.side_effect = launch
    for _ in range(2):
        converted = conversion.convert_doc_to_docx(DOC_BYTES)
        assert Document(io.BytesIO(converted)).paragraphs[0].text == "租赁合同"
    assert profiles[0] != profiles[1]
    assert all(not profile.parent.exists() for profile in profiles)
    assert not list(harness.root.glob("law-ai-doc-*"))
    _assert_slots_available()


@pytest.mark.parametrize(
    "content", [b"", b"PK\x03\x04", b"{\\rtf", b"<html>contract</html>", b"plain text"]
)
def test_wrong_signature_never_starts_converter(harness, content):
    _assert_error(INVALID_DOCUMENT, lambda: conversion.convert_doc_to_docx(content))
    harness.launcher.assert_not_called()
    _assert_slots_available()


@pytest.mark.parametrize(
    "failure", ["nonzero", "missing", "empty", "invalid", "not-docx", "large", "expanded"]
)
def test_invalid_output_is_rejected_and_releases_slot(harness, monkeypatch, failure):
    original = harness.launch

    def launch(command, **options):
        process = original(command, **options)
        output = Path(options["cwd"]) / "output" / "input.docx"
        if failure == "nonzero":
            process.wait.return_value = 1
        elif failure == "missing":
            output.unlink()
        elif failure in {"empty", "invalid"}:
            output.write_bytes(b"" if failure == "empty" else b"invalid zip")
        elif failure == "not-docx":
            with ZipFile(output, "w") as archive:
                archive.writestr("unrelated.xml", "not a DOCX")
        elif failure == "large":
            monkeypatch.setattr(conversion, "MAX_CONVERTED_BYTES", 1)
        elif failure == "expanded":
            monkeypatch.setattr(conversion, "MAX_EXPANDED_BYTES", 20)
            with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
                archive.writestr("word/document.xml", "X" * 10000)
        return process

    harness.launcher.side_effect = launch
    expected = (
        CONVERTED_DOCUMENT_TOO_LARGE if failure in {"large", "expanded"} else INVALID_DOCUMENT
    )
    _assert_error(expected, lambda: conversion.convert_doc_to_docx(DOC_BYTES))
    assert not list(harness.root.glob("law-ai-doc-*"))
    _assert_slots_available()


def test_timeout_terminates_owned_tree_and_removes_files(harness, monkeypatch):
    original = harness.launch
    terminate = Mock(side_effect=lambda process: setattr(process.poll, "return_value", -9))
    monkeypatch.setattr(conversion, "_terminate_process_tree", terminate)

    def launch(command, **options):
        process = original(command, **options)
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired(command, 7)
        return process

    harness.launcher.side_effect = launch
    _assert_error(DOCUMENT_CONVERSION_TIMEOUT, lambda: conversion.convert_doc_to_docx(DOC_BYTES))
    terminate.assert_called_once_with(harness.launched[0][2])
    harness.launched[0][2].wait.assert_called_once_with(timeout=7)
    assert not list(harness.root.glob("law-ai-doc-*"))
    _assert_slots_available()


def test_start_failure_has_fixed_message_and_releases_slot(harness):
    harness.launcher.side_effect = OSError("secret path and document")
    _assert_error(DOCUMENT_CONVERTER_UNAVAILABLE, lambda: conversion.convert_doc_to_docx(DOC_BYTES))
    assert not list(harness.root.glob("law-ai-doc-*"))
    _assert_slots_available()


def test_two_jobs_run_isolated_third_fails_fast_then_capacity_recovers(harness):
    entered = threading.Barrier(3)
    release = threading.Event()
    original = harness.launch

    def launch(command, **options):
        process = original(command, **options)

        def wait(timeout):
            entered.wait(timeout=5)
            assert release.wait(timeout=5)
            return 0

        process.wait.side_effect = wait
        return process

    harness.launcher.side_effect = launch
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(conversion.convert_doc_to_docx, DOC_BYTES) for _ in range(2)]
        try:
            entered.wait(timeout=5)
            _assert_error(
                DOCUMENT_CONVERTER_BUSY, lambda: conversion.convert_doc_to_docx(DOC_BYTES)
            )
            assert len({Path(options["cwd"]) for _, options, _ in harness.launched}) == 2
        finally:
            release.set()
        for future in futures:
            assert future.result(timeout=5).startswith(b"PK")
    _assert_slots_available()


@pytest.mark.parametrize("configured", ["relative/soffice", "missing", "directory"])
def test_explicit_invalid_executable_does_not_fallback(tmp_path, monkeypatch, configured):
    path = tmp_path / configured
    if configured == "directory":
        path.mkdir()
    monkeypatch.setattr(conversion.shutil, "which", Mock(return_value="must-not-use"))
    value = configured if configured.startswith("relative") else str(path)
    _assert_error(DOCUMENT_CONVERTER_UNAVAILABLE, lambda: conversion._find_executable(value))
    conversion.shutil.which.assert_not_called()


def test_absolute_executable_and_path_discovery(tmp_path, monkeypatch):
    path = tmp_path / "office folder" / "soffice.com"
    path.parent.mkdir()
    path.write_bytes(b"fake")
    path.chmod(0o755)
    assert conversion._find_executable(str(path)) == path.resolve()
    monkeypatch.setattr(conversion.shutil, "which", lambda name: str(path))
    assert conversion._find_executable("") == path.resolve()


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_termination_targets_only_owned_process_tree(platform, monkeypatch):
    monkeypatch.setattr(conversion, "sys", SimpleNamespace(platform=platform))
    monkeypatch.setattr(conversion, "signal", SimpleNamespace(SIGKILL=9))
    monkeypatch.setattr(conversion.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    taskkill = Mock()
    killpg = Mock()
    monkeypatch.setattr(conversion.subprocess, "run", taskkill)
    monkeypatch.setattr(conversion.os, "killpg", killpg, raising=False)
    process = Mock(pid=12345)
    process.poll.return_value = None
    conversion._terminate_process_tree(process)
    if platform == "win32":
        command = taskkill.call_args.args[0]
        assert command[1:] == ["/PID", "12345", "/T", "/F"]
        assert "/IM" not in command
        killpg.assert_not_called()
    else:
        killpg.assert_called_once_with(12345, conversion.signal.SIGKILL)
        taskkill.assert_not_called()
    process.kill.assert_called_once_with()
    process.wait.assert_called_once_with(timeout=5)


@pytest.mark.parametrize("value", [0, -1, 121, "wrong"])
def test_timeout_configuration_is_bounded(value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, doc_conversion_timeout_seconds=value)


@pytest.mark.parametrize("endpoint", ["/api/analyze_contract", "/api/analyze_contract/stream"])
@pytest.mark.parametrize(
    "error",
    [
        DOCUMENT_CONVERTER_UNAVAILABLE,
        DOCUMENT_CONVERTER_BUSY,
        DOCUMENT_CONVERSION_TIMEOUT,
        INVALID_DOCUMENT,
    ],
)
def test_conversion_errors_are_fixed_before_agent_and_sse_start(endpoint, error, monkeypatch):
    from app.services import parser

    monkeypatch.setattr(parser, "convert_doc_to_docx", Mock(side_effect=PublicError(error)))
    agent = Mock()
    stream_agent = Mock()
    monkeypatch.setattr(routes, "run_contract_analysis", agent)
    monkeypatch.setattr(routes, "run_contract_analysis_stream", stream_agent)
    with TestClient(app) as client:
        response = client.post(endpoint, files={"file": ("合同.DOC", DOC_BYTES)})
    assert response.status_code == error.status_code
    assert response.json() == {"detail": error.message, "code": error.code}
    agent.assert_not_called()
    stream_agent.assert_not_called()
