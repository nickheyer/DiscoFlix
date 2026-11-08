FROM gcr.io/distroless/static-debian12:nonroot
ARG TARGETPLATFORM
COPY discoflix /usr/local/bin/discoflix
ENV DISCOFLIX_DATA_DIR=/data
VOLUME /data
EXPOSE 5001
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/discoflix"]
CMD ["serve", "--headless", "--addr", ":5001"]
