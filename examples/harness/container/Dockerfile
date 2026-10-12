# plan-e3.md E3.9, option A of docs/e3/e3-9-plan.md (the owner's choice, 2026-10-12): the image in which every command a model
# causes runs. It is built once, with the network, and never used with one: the container that runs it has no network at all
# (`--network none`), holds no key, and has a read-only root. The driver (the poly runtime, the harness loop, the calls to the
# model API and the key) stays on the host and reaches this image only through `docker exec` of runner.mjs.
#
# What is in it: Linux node 24, Go 1.25, the two repositories at the digests pinned in tasks/repos.json (verified by build.mjs
# before the build and by tasks.mjs inside it), their dependencies installed from the lockfiles (package-lock.json, go.sum),
# the host code the runner needs (tasks.mjs, world.mjs, the classifier table) and the isolation check. Nothing else.
FROM golang:1.25-bookworm AS go

FROM node:24-bookworm
COPY --from=go /usr/local/go /usr/local/go
ENV GOROOT=/usr/local/go PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local HOME=/tmp
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin runner

# the repositories, where tasks.mjs looks for them: <root>/.. is /opt, so the originals are /opt/todo-app and /opt/snip
COPY repos/todo-app /opt/todo-app
COPY repos/snip /opt/snip
COPY poly /opt/poly

# network is used here and only here. todo-app: the locked packages, no install scripts. snip: the locked modules, and a warm
# build cache so that a run does not compile the standard library first. The seeds are copied to the writable volume at start.
RUN cd /opt/todo-app && npm ci --ignore-scripts --no-audit --no-fund
RUN mkdir -p /opt/seed && cd /opt/snip \
 && GOPATH=/opt/seed/gopath GOCACHE=/opt/seed/gocache GOFLAGS=-mod=readonly go mod download \
 && GOPATH=/opt/seed/gopath GOCACHE=/opt/seed/gocache GOFLAGS=-mod=readonly GOPROXY=off go test -count=1 -run '^$' ./...

# the writable place is a volume mounted here; the root is read-only at run time
RUN mkdir -p /opt/poly/.poly && chown -R runner /opt/poly/.poly && chmod -R a+rX /opt/seed /opt/todo-app /opt/snip /opt/poly
USER runner
WORKDIR /opt/poly
CMD ["sleep", "infinity"]
