"""History presentation and diff attribution for the pinned Overleaf base."""
from pathlib import Path
import hashlib

ROOT = Path('/overleaf')
HASHES = {
    'services/web/app/src/Features/History/HistoryController.mjs':
        '56b59890a4e3429a0a02e394a3d59f4b84765409edf54997e620728144f14dc5',
    'services/project-history/app/js/DiffGenerator.js':
        'f02b4acac2cbcf671f5d9b3639ee69db17be4c94fa5bfaac262ac336c08d8f7f',
}
for name, expected in HASHES.items():
    if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Unsupported upstream file: ' + name)


def replace(name, old, new):
    path = ROOT / name
    source = path.read_text()
    if source.count(old) != 1:
        raise SystemExit('Patch context mismatch: ' + name)
    path.write_text(source.replace(old, new))


controller = 'services/web/app/src/Features/History/HistoryController.mjs'
replace(controller, "import HistoryManager from './HistoryManager.mjs'",
        "import HistoryManager from './HistoryManager.mjs'\n"
        "import { presentHistoryActors } from '../../../../modules/agent-access/history-actors.mjs'")
replace(controller,
        '  const data = await HistoryManager.promises.injectUserDetails(body)\n  res.json(data)',
        '  const data = await HistoryManager.promises.injectUserDetails(body)\n'
        "  res.set('Cache-Control', 'private, no-store')\n"
        '  res.json(presentHistoryActors(data, userId))')

replace('services/project-history/app/js/DiffGenerator.js',
        '    if (usersNotInBothParts.length > 0) {',
        "    // Keep human and delegated edits distinct even for the same author.\n"
        "    const agentBoundary =\n"
        "      (part.meta?.origin?.kind === 'agent') !==\n"
        "      (lastPart.meta?.origin?.kind === 'agent')\n"
        '    if (usersNotInBothParts.length > 0 || agentBoundary) {')
