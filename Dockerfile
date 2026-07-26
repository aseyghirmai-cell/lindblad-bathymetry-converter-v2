ARG MBSYSTEM_IMAGE=mbari/mbsystem:latest
FROM ${MBSYSTEM_IMAGE}

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/olex-converter

COPY requirements.txt .
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY main.py converter.py index.html styles.css app.js ./

RUN useradd --create-home --uid 10001 converter \
    && mkdir -p /tmp/olex-converter \
    && chown -R converter:converter /opt/olex-converter /tmp/olex-converter

USER converter

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    WORK_ROOT=/tmp/olex-converter \
    MAX_UPLOAD_MB=500 \
    MAX_UNCOMPRESSED_GB=0.48828125 \
    JOB_TTL_SECONDS=3600 \
    COMMAND_TIMEOUT_SECONDS=3600

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:' + str(${PORT:-8000}) + '/api/health', timeout=3)"

CMD ["/bin/sh", "-c", "python3 -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
