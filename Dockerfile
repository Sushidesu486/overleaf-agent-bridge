FROM docker.io/sharelatex/sharelatex@sha256:d17e196b04222837440b5efb2890864eb200a2e9341e434c0e6bd57a61011cbb
COPY extensions/agent-access /overleaf/services/web/modules/agent-access
COPY patches/install.py /opt/overleaf-agent/install.py
RUN test -s /overleaf/services/web/modules/agent-access/mcp.cjs && python3 /opt/overleaf-agent/install.py
