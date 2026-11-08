"""Load gitignored build-time device secrets from the repository .env."""

from pathlib import Path

Import("env")  # type: ignore[name-defined]  # Provided by PlatformIO/SCons.


def env_values(path):
    values = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


repository_env = Path(env.subst("$PROJECT_DIR")).parents[1] / ".env"
bridge_token = env_values(repository_env).get("CODEX_BUDDY_TOKEN", "")
if bridge_token:
    env.Append(
        CPPDEFINES=[
            ("CODEX_BUDDY_TOKEN", env.StringifyMacro(bridge_token)),
        ]
    )
