FROM golang:1.24-bookworm AS builder

COPY . /src
COPY static /target/static
WORKDIR /src
RUN CGO_ENABLED=0 GOOS=linux go install -a -ldflags '-extldflags "-static"' ./...
RUN cp -r /go/bin /target

FROM scratch
# Copy CA certificates for TLS/HTTPS connections (needed for Firestore)
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /target /
ENTRYPOINT [ "/bin/vail" ]
