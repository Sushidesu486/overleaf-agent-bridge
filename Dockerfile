FROM docker.io/sharelatex/sharelatex@sha256:d17e196b04222837440b5efb2890864eb200a2e9341e434c0e6bd57a61011cbb AS frontend
WORKDIR /overleaf
RUN --network=none YARN_ENABLE_NETWORK=0 YARN_ENABLE_SCRIPTS=0 yarn workspaces focus @overleaf/web
COPY extensions/agent-access /overleaf/services/web/modules/agent-access
COPY patches/frontend.py /opt/overleaf-agent/frontend.py
COPY patches/build-frontend.cjs /overleaf/services/web/agent-build.cjs
RUN python3 /opt/overleaf-agent/frontend.py
WORKDIR /overleaf/services/web
RUN --network=none NODE_ENV=production NODE_OPTIONS="--max-old-space-size=8192 --require /overleaf/.pnp.cjs" node agent-build.cjs

FROM docker.io/sharelatex/sharelatex@sha256:d17e196b04222837440b5efb2890864eb200a2e9341e434c0e6bd57a61011cbb
COPY extensions/agent-access /overleaf/services/web/modules/agent-access
COPY --from=frontend /overleaf/services/web/modules/agent-access/app/views/index.js /overleaf/services/web/modules/agent-access/app/views/index.js
COPY --from=frontend /opt/overleaf-agent/frontend-assets /overleaf/services/web/public
COPY patches/install.py /opt/overleaf-agent/install.py
COPY patches/history.py /opt/overleaf-agent/history.py
COPY patches/frontend.py /opt/overleaf-agent/frontend.py
RUN test -s /overleaf/services/web/modules/agent-access/mcp.cjs && python3 /opt/overleaf-agent/install.py && python3 /opt/overleaf-agent/history.py && python3 /opt/overleaf-agent/frontend.py
