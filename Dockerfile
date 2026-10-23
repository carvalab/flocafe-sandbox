FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*
COPY bin/ /opt/flocafe-sandbox/
RUN chmod +x /opt/flocafe-sandbox/*.sh
ENV PATH="/opt/flocafe-sandbox:${PATH}"
