FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libglib2.0-0 libsm6 libxext6 libgl1 curl netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first — layer is only invalidated when requirements.txt changes
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy app code after deps so code changes don't re-run pip
COPY app/ /app/app/
COPY web/ /app/web/
COPY config/ /app/config/

EXPOSE 8099
CMD ["python", "-m", "app.server"]
