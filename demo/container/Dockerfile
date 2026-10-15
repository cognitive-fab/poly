# The container of DB6 (Step 8): the stand-in, the replay driver and the build under test, with no route to anywhere. It is run with
# no network at all (docker-compose.yml: network_mode none), and the two names a build believes it talks to are mapped to the
# container's own loopback by /etc/hosts. The build tree is mounted read-only; the throwaway authority is made at the start of
# the run in the container's temporary space and is gone when the container stops.
#
# The image is built once, with a network, from a pinned base; the runs never need one. Pin the base by digest in the pre-registration
# commit (plan step 10), where the owner records it with the agent's version.
FROM node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /demo
COPY . /demo/demo
ENV POLY_DEMO_IN_CONTAINER=1
ENTRYPOINT ["node", "/demo/demo/demo.mjs"]
