from __future__ import annotations

import asyncio
import locale
import re
import shutil
import subprocess
import sys

from harness.types.tools import ToolExecutionResult, ToolParam, ToolSchema

POWERSHELL_SCHEMA = ToolSchema(
    name="powershell",
    description=(
        "Execute a PowerShell script with full shell scripting support "
        "(pipes |, variables $var, cmdlets like Get-ChildItem, conditionals, loops). "
        "Use this instead of shell when you need shell syntax or Windows-specific commands. "
        "PowerShell errors and failed native commands are returned as tool errors. "
        "This is PowerShell, not Bash: Bash heredocs such as `python - <<'PY'` "
        "are invalid. For multiline Python, write a temporary .py file and pass "
        "paths as arguments or environment variables. For structured JSON, prefer "
        "the framework JSON tools; otherwise read UTF-8 text with "
        "`Get-Content -Raw -Encoding utf8` and avoid legacy PowerShell writes that "
        "may add a BOM. After each native command in a multi-command script, check "
        "`$LASTEXITCODE` and throw on failure. "
        "With PowerShell 7, stopOnError also stops a failed native command before "
        "later statements run. On Windows this uses pwsh.exe when available and falls "
        "back to legacy powershell.exe, which can only report the final native exit; "
        "on Linux/macOS it uses pwsh."
    ),
    params=[
        ToolParam(
            name="script",
            type="string",
            description=(
                "PowerShell script to execute. Do not use Bash heredoc syntax. "
                "For non-ASCII JSON use explicit UTF-8 or the structured JSON tools; "
                "for multiline Python use a .py file plus arguments/environment."
            ),
            required=False,
        ),
        ToolParam(
            name="command",
            type="string",
            description="Alias of script for compatibility with models that emit command instead of script.",
            required=False,
        ),
        ToolParam(
            name="cwd",
            type="string",
            description="Working directory (defaults to current directory).",
            required=False,
        ),
        ToolParam(
            name="timeout",
            type="number",
            description="Timeout in seconds (default 30).",
            required=False,
        ),
        ToolParam(
            name="stopOnError",
            type="boolean",
            description=(
                "Stop the remaining script after a PowerShell error, default true. "
                "Set false only for best-effort inspection or batch collection; "
                "reported errors still make the tool result unsuccessful."
            ),
            required=False,
        ),
    ],
)


def _find_powershell() -> str:
    """Return the PowerShell executable path appropriate for the current OS."""
    if sys.platform == "win32":
        for exe in ("pwsh.exe", "powershell.exe"):
            if shutil.which(exe):
                return exe
        return "powershell.exe"
    return "pwsh"


def _guard_script(script: str, *, stop_on_error: bool) -> str:
    """Make command failures terminal and normalize child-process text to UTF-8."""
    preference = "Stop" if stop_on_error else "Continue"
    native_preference = "$true" if stop_on_error else "$false"
    return (
        f"$ErrorActionPreference = '{preference}'\n"
        "$utf8 = New-Object System.Text.UTF8Encoding($false)\n"
        "[Console]::InputEncoding = $utf8\n"
        "[Console]::OutputEncoding = $utf8\n"
        "$OutputEncoding = $utf8\n"
        "$env:PYTHONIOENCODING = 'utf-8'\n"
        "$env:PYTHONUTF8 = '1'\n"
        "$nativePreference = Get-Variable "
        "PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue\n"
        "if ($null -ne $nativePreference) {\n"
        f"  $PSNativeCommandUseErrorActionPreference = {native_preference}\n"
        "}\n"
        "try {\n"
        "  & {\n"
        f"{script}\n"
        "  }\n"
        "  $nativeExitCode = if ($null -eq $LASTEXITCODE) "
        "{ 0 } else { [int]$LASTEXITCODE }\n"
        "  if ($nativeExitCode -ne 0) { exit $nativeExitCode }\n"
        "} catch {\n"
        "  [Console]::Error.WriteLine(($_ | Out-String))\n"
        "  exit 1\n"
        "}\n"
    )


def _decode_output(data: bytes) -> str:
    if not data:
        return ""
    candidates = ["utf-8-sig", locale.getpreferredencoding(False)]
    if sys.platform == "win32":
        candidates.extend(["gb18030", "utf-16"])
    seen: set[str] = set()
    for encoding in candidates:
        normalized = encoding.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        try:
            return data.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")


async def powershell_tool(
    script: str = "",
    command: str = "",
    cwd: str = ".",
    timeout: float = 30.0,
    stopOnError: bool = True,
) -> str | ToolExecutionResult:
    script = script or command
    if not script.strip():
        return ToolExecutionResult("Error: script is required.", is_error=True)
    if re.search(r"(?m)(?:^|[;&]\s*)[^\r\n]*\s<<\s*['\"]?[A-Za-z_]", script):
        return ToolExecutionResult(
            "Error: Bash heredoc syntax is not valid in PowerShell. Write the "
            "multiline program to a temporary file, then invoke it with explicit "
            "arguments or environment variables.",
            is_error=True,
        )

    exe = _find_powershell()
    guarded_script = _guard_script(script, stop_on_error=bool(stopOnError))
    try:
        completed = await asyncio.to_thread(
            subprocess.run,
            [exe, "-NoProfile", "-NonInteractive", "-Command", guarded_script],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            timeout=timeout,
            check=False,
            shell=False,
        )
    except FileNotFoundError:
        return ToolExecutionResult(
            f"Error: PowerShell executable not found: {exe!r}", is_error=True
        )
    except PermissionError as exc:
        return ToolExecutionResult(
            f"Error: permission denied running {exe!r}: {exc}", is_error=True
        )
    except OSError as exc:
        return ToolExecutionResult(
            f"Error: failed to start PowerShell {exe!r}: {exc}", is_error=True
        )
    except subprocess.TimeoutExpired:
        return ToolExecutionResult(
            f"Error: PowerShell timed out after {timeout}s", is_error=True
        )

    stdout_text = _decode_output(completed.stdout)
    stderr_text = _decode_output(completed.stderr)
    exit_code = completed.returncode

    parts: list[str] = []
    if stdout_text:
        parts.append(stdout_text.rstrip("\r\n"))
    if stderr_text:
        parts.append(f"[stderr]\n{stderr_text.rstrip(chr(10)).rstrip(chr(13))}")
    elif exit_code != 0:
        parts.append(
            "[diagnostic]\n"
            f"PowerShell exited with code {exit_code} without diagnostic output. "
            "Re-run the failing command directly or use stopOnError=false to inspect "
            "all command output."
        )
    parts.append(f"[exit code: {exit_code}]")

    return ToolExecutionResult(
        content="\n".join(parts),
        is_error=exit_code != 0 or bool(stderr_text.strip()),
    )
