from pathlib import Path
import hashlib
ROOT = Path('/overleaf')
HASHES = {'services/web/config/settings.defaults.js': 'ee7026882fc5f55b6761e46d2cca88851e1552317a34a27febff0ff6afbb736c', 'services/document-updater/app/js/DocumentManager.js': 'ce020a150d09e320ebfb56880b0131df0cda5e3d320e8e982741a97a5a64a951', 'services/document-updater/app/js/HttpController.js': '7a17a1e83007430a97e69cddc49694cf8dad7aa5cf4badc833096122bceb32c3'}
for name, expected in HASHES.items():
    if hashlib.sha256((ROOT/name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Unsupported upstream file: ' + name)
def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit('Patch context mismatch: ' + str(path))
    p.write_text(s.replace(old, new))
replace('/overleaf/services/web/config/settings.defaults.js', "    'user-activate',\n  ],", "    'user-activate',\n    'agent-access',\n  ],")
replace('/overleaf/services/document-updater/app/js/DocumentManager.js', '    trackChanges\n  ) {\n    if (newLines', '    trackChanges,\n    expectedVersion\n  ) {\n    if (newLines')
replace('/overleaf/services/document-updater/app/js/DocumentManager.js', '    logger.debug(\n      { docId, projectId, oldLines, newLines },', '    // Agent replacements must compare under the same lock as native edits.\n    if (expectedVersion !== undefined && version !== expectedVersion) {\n      return { agentVersionConflict: true }\n    }\n\n    logger.debug(\n      { docId, projectId, oldLines, newLines },')
replace('/overleaf/services/document-updater/app/js/DocumentManager.js', "    trackChanges\n  ) {\n    const UpdateManager = require('./UpdateManager')\n    return await UpdateManager.promises.lockUpdatesAndDo(\n      DocumentManager.setDoc,", "    trackChanges,\n    expectedVersion\n  ) {\n    const UpdateManager = require('./UpdateManager')\n    return await UpdateManager.promises.lockUpdatesAndDo(\n      DocumentManager.setDoc,")
replace('/overleaf/services/document-updater/app/js/DocumentManager.js', '      undoing,\n      external,\n      trackChanges\n    )', '      undoing,\n      external,\n      trackChanges,\n      expectedVersion\n    )')
replace('/overleaf/services/document-updater/app/js/HttpController.js', '    undoing: z.boolean().optional(),\n    trackChanges: z.boolean().optional(),', '    undoing: z.boolean().optional(),\n    trackChanges: z.boolean().optional(),\n    expectedVersion: z.number().int().nonnegative().optional(),')
replace('/overleaf/services/document-updater/app/js/HttpController.js', '  const { lines, source, user_id: userId, undoing, trackChanges } = body', "  const { lines, source, user_id: userId, undoing, trackChanges, expectedVersion } = body\n  if (source === 'agent' && expectedVersion === undefined) return res.sendStatus(400)")
replace('/overleaf/services/document-updater/app/js/HttpController.js', '    undoing,\n    true,\n    trackChanges\n  )\n  timer.done()', '    undoing,\n    true,\n    trackChanges,\n    expectedVersion\n  )\n  timer.done()\n  if (result?.agentVersionConflict) return res.status(409).json({ error: "version-conflict" })')
replace('/overleaf/services/document-updater/app/js/HttpController.js', '  res.json({\n    id: docId,', "  res.setHeader('X-Overleaf-Agent-CAS', '1')\n  res.json({\n    id: docId,")
replace('/etc/nginx/sites-enabled/overleaf.conf', '\tlocation / {', '\n  # Personal URLs are credentials: remove the path before forwarding/logging.\n  location = /agent-mcp { access_log off; return 404; }\n  location ~ "^/mcp/p/([a-f0-9]{24}\\.[A-Za-z0-9_-]{43})$" {\n    access_log off;\n    error_log /dev/null crit;\n    set $agent_credential $1;\n    rewrite ^ /agent-mcp? break;\n    proxy_pass http://127.0.0.1:4000;\n    proxy_http_version 1.1;\n    proxy_set_header X-Overleaf-Agent-Key $agent_credential;\n    proxy_set_header Host $host;\n    proxy_set_header Connection "";\n    proxy_buffering off;\n    proxy_read_timeout 180s;\n    client_max_body_size 1m;\n  }\n  location /mcp/ { access_log off; error_log /dev/null crit; return 404; }\n\n\tlocation / {')
