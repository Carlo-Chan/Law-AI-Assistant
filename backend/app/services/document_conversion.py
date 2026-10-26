"""将旧版 DOC 隔离转换为 DOCX，不使用用户文件名，也不接触桌面 Office 配置。"""

import io
import logging
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore
from zipfile import BadZipFile, ZipFile

from app.core.config import get_settings
from app.core.errors import (
    CONVERTED_DOCUMENT_TOO_LARGE,
    DOCUMENT_CONVERSION_TIMEOUT,
    DOCUMENT_CONVERTER_BUSY,
    DOCUMENT_CONVERTER_UNAVAILABLE,
    INVALID_DOCUMENT,
    PublicError,
)

logger = logging.getLogger(__name__)
OLE_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
MAX_CONVERTED_BYTES = 32 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
_conversion_slots = BoundedSemaphore(2)

_PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
    <prop oor:name="Field" oor:op="fuse"><value>false</value></prop>
    <prop oor:name="Chart" oor:op="fuse"><value>false</value></prop>
  </item>
</oor:items>
"""


def _find_executable(configured: str) -> Path:
    """显式配置必须是可执行文件的绝对路径，错误时不悄悄换用其他程序。"""
    if configured:
        candidates = [Path(configured)]
    else:
        names = (
            ("soffice.com", "soffice.exe")
            if sys.platform == "win32"
            else ("libreoffice", "soffice")
        )
        candidates = [Path(found) for name in names if (found := shutil.which(name))]
        if sys.platform == "win32":
            for variable in ("ProgramFiles", "ProgramFiles(x86)"):
                if root := os.environ.get(variable):
                    candidates.append(Path(root) / "LibreOffice" / "program" / "soffice.com")
    for candidate in candidates:
        if not candidate.is_absolute() or not candidate.is_file():
            continue
        if sys.platform == "win32":
            if candidate.suffix.lower() not in {".exe", ".com"}:
                continue
        elif not os.access(candidate, os.X_OK):
            continue
        return candidate.resolve()
    raise PublicError(DOCUMENT_CONVERTER_UNAVAILABLE)


def _process_options(job: Path) -> dict:
    """只传递运行 Office 所需环境，不向子进程继承应用 API Keys。"""
    allowed = {
        "SYSTEMROOT",
        "WINDIR",
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "FONTCONFIG_PATH",
        "FONTCONFIG_FILE",
    }
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    scratch = job / "scratch"
    scratch.mkdir()
    environment.update(TEMP=str(scratch), TMP=str(scratch), TMPDIR=str(scratch))
    options = {
        "cwd": job,
        "env": environment,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "shell": False,
    }
    if sys.platform == "win32":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    return options


def _terminate_process_tree(process: subprocess.Popen) -> None:
    """只清理当前转换创建的进程树；禁止按进程名结束用户自己的 Office。"""
    try:
        if sys.platform == "win32":
            taskkill = (
                Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
            )
            subprocess.run(
                [str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        logger.warning("DOC 转换进程树清理未完成，尝试回收主进程。")
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)


def _read_output(output: Path) -> bytes:
    """转换成功不能仅凭退出码判断，限制产物大小并校验 DOCX 的基本结构。"""
    if output.is_symlink() or not output.is_file():
        raise PublicError(INVALID_DOCUMENT)
    if output.stat().st_size > MAX_CONVERTED_BYTES:
        raise PublicError(CONVERTED_DOCUMENT_TOO_LARGE)
    with output.open("rb") as document:
        content = document.read(MAX_CONVERTED_BYTES + 1)
    if len(content) > MAX_CONVERTED_BYTES:
        raise PublicError(CONVERTED_DOCUMENT_TOO_LARGE)
    try:
        with ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if (
                len(entries) > 2048
                or sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES
            ):
                raise PublicError(CONVERTED_DOCUMENT_TOO_LARGE)
            if "word/document.xml" not in archive.namelist():
                raise PublicError(INVALID_DOCUMENT)
    except BadZipFile as error:
        raise PublicError(INVALID_DOCUMENT) from error
    return content


def convert_doc_to_docx(file_bytes: bytes) -> bytes:
    """每次独立目录和配置，超时终止，达到并发上限立即提示而非无限排队。"""
    if not file_bytes.startswith(OLE_SIGNATURE):
        raise PublicError(INVALID_DOCUMENT)
    if not _conversion_slots.acquire(blocking=False):
        raise PublicError(DOCUMENT_CONVERTER_BUSY)
    try:
        settings = get_settings()
        executable = _find_executable(settings.libreoffice_path)
        parent = (
            Path(settings.doc_conversion_temp_dir) if settings.doc_conversion_temp_dir else None
        )
        if parent is not None and (not parent.is_absolute() or not parent.is_dir()):
            raise PublicError(DOCUMENT_CONVERTER_UNAVAILABLE)
        with TemporaryDirectory(prefix="law-ai-doc-", dir=parent) as directory:
            job = Path(directory).resolve()
            source = job / "input.doc"
            source.write_bytes(file_bytes)
            output = job / "output"
            output.mkdir()
            profile = job / "profile"
            (profile / "user").mkdir(parents=True)
            (profile / "user" / "registrymodifications.xcu").write_text(_PROFILE, encoding="utf-8")
            command = [
                str(executable),
                f"-env:UserInstallation={profile.as_uri()}",
                "--headless",
                "--nologo",
                "--nodefault",
                "--norestore",
                "--infilter=MS Word 97",
                "--convert-to",
                "docx:Office Open XML Text",
                "--outdir",
                str(output),
                str(source),
            ]
            process = subprocess.Popen(command, **_process_options(job))
            try:
                return_code = process.wait(timeout=settings.doc_conversion_timeout_seconds)
            except subprocess.TimeoutExpired as error:
                raise PublicError(DOCUMENT_CONVERSION_TIMEOUT) from error
            finally:
                if process.poll() is None:
                    _terminate_process_tree(process)
            if return_code != 0:
                raise PublicError(INVALID_DOCUMENT)
            return _read_output(output / "input.docx")
    except PublicError:
        raise
    except (OSError, subprocess.SubprocessError) as error:
        raise PublicError(DOCUMENT_CONVERTER_UNAVAILABLE) from error
    finally:
        _conversion_slots.release()
