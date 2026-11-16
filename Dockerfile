FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    TZ=Europe/Madrid \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8090

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web

VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ['PORT'] + '/api/storage', timeout=4)"

CMD ["python", "-m", "app"]
