"""Remote paths derive from this installation, not an account name or global bin."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parent
file=ROOT/'remote-config.json'
CONFIG=json.loads(file.read_text()) if file.is_file() else {}
WORKSPACE_ROOT=Path(CONFIG.get('workspaceRoot',str(Path.home()/'windows-local-work')))
WORKSPACE_COMMAND=str(ROOT/'windows-workspace')
