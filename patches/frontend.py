"""Register the Agent module with Overleaf's native frontend extension points."""
from pathlib import Path
import hashlib

ROOT = Path('/overleaf/services/web')
HASHES = {
    'config/settings.defaults.js': {
        'ee7026882fc5f55b6761e46d2cca88851e1552317a34a27febff0ff6afbb736c',
        # Same base with the server module registration from install.py.
        '2499fd5ec291a48e11a71a20eac85a9e2f3ea60e5956b01c938149fe8ccf2749',
    },
    'frontend/js/features/ide-react/context/rail-context.tsx': {
        'cd32b65a87bb6184dec7fcfaf1911b505da91b74681bdd732f92b04e16806b87',
    },
    'frontend/js/features/ide-react/context/editor-manager-context.tsx': {
        'fb8291ce73d1913034c12fbca97f3c337cd6aa9380cb734e2d35a5ba22f376de',
    },
    'frontend/stylesheets/main-style.scss': {
        '3ff29138cd9f515e76fc9aeaf414906226fe1004708a384a5d099387580f4263',
    },
}
for name, expected in HASHES.items():
    if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() not in expected:
        raise SystemExit('Unsupported upstream file: ' + name)


def replace(name, old, new):
    path = ROOT / name
    source = path.read_text()
    if source.count(old) != 1:
        raise SystemExit('Patch context mismatch: ' + name)
    path.write_text(source.replace(old, new))


replace('config/settings.defaults.js', '    railEntries: [],',
        "    railEntries: [Path.resolve(__dirname, '../modules/agent-access/frontend/js/components/agent-rail.tsx')],")
replace('frontend/js/features/ide-react/context/rail-context.tsx',
        "  | 'workbench'\n", "  | 'workbench'\n  | 'agent-access'\n")
replace('frontend/stylesheets/main-style.scss',
        "@import 'ciam/all';",
        "@import 'ciam/all';\n@import '../../modules/agent-access/frontend/stylesheets/agent';")

# Version-checked Agent updates are ordinary collaboration; keep other external warnings.
replace('frontend/js/features/ide-react/context/editor-manager-context.tsx',
        "update.meta.source === 'git-bridge'",
        "(update.meta.source === 'git-bridge' || update.meta.source === 'agent')")
