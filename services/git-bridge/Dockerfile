ARG MAVEN_IMAGE=docker.io/library/maven@sha256:3a4ab3276a087bf276f79cae96b1af04f53731bec53fb2e651aca79e4b10211e
FROM ${MAVEN_IMAGE} AS build
ADD --checksum=sha256:827be6176f49eb31b229775140817007028b70f5b3fe0d565016ee54a8585c95 https://codeload.github.com/overleaf/overleaf/tar.gz/e039ad26c5bf5422eb57b89fc7e57c75055e631d /tmp/upstream.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/upstream.tar.gz --strip-components=3 -C /src overleaf-e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/git-bridge && rm /tmp/upstream.tar.gz
COPY source.sha256 ce.patch /tmp/
RUN sha256sum --check /tmp/source.sha256 && git apply --unidiff-zero /tmp/ce.patch
RUN --mount=type=cache,target=/root/.m2 mvn -B -DskipTests package

FROM ${MAVEN_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/ZJUSCT/overleaf" \
      org.opencontainers.image.revision="e039ad26c5bf5422eb57b89fc7e57c75055e631d" \
      org.opencontainers.image.licenses="MIT"
RUN mkdir -p /var/lib/git-bridge/.wlgb/atts /opt/git-bridge && chown -R 10001:10001 /var/lib/git-bridge
COPY --from=build /src/target/writelatex-git-bridge-1.0-SNAPSHOT-jar-with-dependencies.jar /opt/git-bridge/server.jar
COPY --from=build /src/LICENSE /opt/git-bridge/LICENSE
COPY config.json /opt/git-bridge/config.json
USER 10001:10001
EXPOSE 8000
ENTRYPOINT ["java", "-Xmx768m", "-jar", "/opt/git-bridge/server.jar", "/opt/git-bridge/config.json"]
