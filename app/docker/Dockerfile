FROM python:3.11-slim

ARG BUILD_COMMIT=dev
ARG BUILD_DATE=unknown
ARG BUILD_COUNT=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BUILD_COMMIT=$BUILD_COMMIT \
    BUILD_DATE=$BUILD_DATE \
    BUILD_COUNT=$BUILD_COUNT

# Base system dependencies + Google Coral apt repo for the Edge TPU runtime
# library (libedgetpu1-std). Package install is best-effort: on hosts where the
# repo isn't reachable we still continue the build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libglib2.0-0 libsm6 libxext6 libgl1 curl gnupg ca-certificates usbutils netcat-openbsd \
 && (curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
     | gpg --dearmor -o /usr/share/keyrings/coral-edgetpu.gpg || true) \
 && echo "deb [signed-by=/usr/share/keyrings/coral-edgetpu.gpg] https://packages.cloud.google.com/apt coral-edgetpu-stable main" \
     > /etc/apt/sources.list.d/coral-edgetpu.list \
 && apt-get update || true \
 && (apt-get install -y --no-install-recommends libedgetpu1-std || \
     echo "[build] libedgetpu1-std not available — Coral Edge TPU will be disabled") \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first — layer is only invalidated when requirements.txt changes
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r /app/requirements.txt

# tflite-runtime pinned to a known-good version. 2.14.0 was compiled against
# NumPy 1.x (hence requirements.txt pins numpy<2), and it matches the model
# opset of the google-coral/test_data COCO SSD MobileNet v2 bundle we ship
# with. If this line fails to install the build should fail loudly so the
# operator can diagnose — we deliberately do NOT suppress the error.
RUN pip install --no-cache-dir tflite-runtime==2.14.0

# pycoral 2.0 only publishes wheels for Python 3.7–3.9, so it cannot be
# installed on the 3.11 base. We still try via the official Coral index so
# any future build with 3.11 support lights up automatically, but we keep
# this step optional because a clean install failure is the expected case on
# 3.11. detectors.py reports "Coral TPU aktiv" at startup when pycoral ends
# up importable, otherwise the tflite-runtime CPU fallback kicks in.
RUN pip install --no-cache-dir --extra-index-url https://google-coral.github.io/py-repo \
        "pycoral~=2.0" \
    || echo "[build] pycoral 2.0 does not ship a Python 3.11 wheel — "\
            "Coral EdgeTPU acceleration is disabled. CPU inference via "\
            "tflite-runtime remains available."

# Copy app code after deps so code changes don't re-run pip
COPY app/ /app/app/
COPY web/ /app/web/
COPY config/ /app/config/
COPY scripts/ /app/scripts/

EXPOSE 8099
CMD ["python", "-m", "app.server"]
