FROM docker.io/sharelatex/sharelatex@sha256:d17e196b04222837440b5efb2890864eb200a2e9341e434c0e6bd57a61011cbb AS frontend
WORKDIR /overleaf
RUN --network=none YARN_ENABLE_NETWORK=0 YARN_ENABLE_SCRIPTS=0 yarn workspaces focus @overleaf/web
COPY extensions/agent-access /overleaf/services/web/modules/agent-access
COPY extensions/site-access /overleaf/services/web/modules/site-access
COPY patches/frontend.py /opt/overleaf-agent/frontend.py
COPY patches/site.py /opt/overleaf-agent/site.py
COPY patches/build-frontend.cjs /overleaf/services/web/agent-build.cjs
RUN python3 /opt/overleaf-agent/frontend.py && python3 /opt/overleaf-agent/site.py
WORKDIR /overleaf/services/web
RUN --network=none NODE_ENV=production NODE_OPTIONS="--max-old-space-size=8192 --require /overleaf/.pnp.cjs" node agent-build.cjs

FROM docker.io/sharelatex/sharelatex@sha256:d17e196b04222837440b5efb2890864eb200a2e9341e434c0e6bd57a61011cbb AS texlive
# Keep the complete runtime package set in a separate cached layer so UI changes
# do not reinstall TeX Live. Documentation and package source files are omitted.
ARG TEXLIVE_REPOSITORY=https://mirror.ctan.org/systems/texlive/tlnet
COPY scripts/check-texlive.sh scripts/check-report-template.sh /opt/overleaf-agent/
RUN tlmgr --repository "$TEXLIVE_REPOSITORY" update --self \
    && tlmgr option install_docfiles 0 \
    && tlmgr option install_srcfiles 0 \
    && tlmgr --repository "$TEXLIVE_REPOSITORY" update --all \
    && tlmgr --repository "$TEXLIVE_REPOSITORY" install scheme-full \
    && tlmgr path add \
    && sh /opt/overleaf-agent/check-texlive.sh \
    && sh /opt/overleaf-agent/check-report-template.sh

# EPS figures use the system Ghostscript binary through TeX Live's rungs wrapper.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/check-eps.sh /opt/overleaf-agent/check-eps.sh
RUN sh /opt/overleaf-agent/check-eps.sh

FROM texlive
COPY extensions/agent-access /overleaf/services/web/modules/agent-access
COPY extensions/site-access /overleaf/services/web/modules/site-access
COPY --from=frontend /overleaf/services/web/modules/agent-access/app/views/index.js /overleaf/services/web/modules/agent-access/app/views/index.js
COPY --from=frontend /opt/overleaf-agent/frontend-assets /overleaf/services/web/public
COPY patches/install.py /opt/overleaf-agent/install.py
COPY patches/history.py /opt/overleaf-agent/history.py
COPY patches/frontend.py /opt/overleaf-agent/frontend.py
COPY patches/site.py /opt/overleaf-agent/site.py
COPY patches/compile-parser.cjs /opt/overleaf-agent/compile-parser.cjs
# Source archives may be extracted with a private umask. Runtime workers use
# www-data and need to read the bundled modules and connector assets.
RUN chmod -R a+rX /overleaf/services/web/modules/agent-access /overleaf/services/web/modules/site-access \
    && /sbin/setuser www-data test -r /overleaf/services/web/modules/agent-access/history-actors.mjs \
    && /sbin/setuser www-data test -r /overleaf/services/web/modules/agent-access/public/overleaf-agent-connector.mjs
RUN test -s /overleaf/services/web/modules/agent-access/public/overleaf-agent-connector.mjs && test -s /overleaf/services/web/modules/agent-access/mcp.cjs && python3 /opt/overleaf-agent/install.py && python3 /opt/overleaf-agent/history.py && python3 /opt/overleaf-agent/frontend.py && python3 /opt/overleaf-agent/site.py && node /opt/overleaf-agent/compile-parser.cjs
