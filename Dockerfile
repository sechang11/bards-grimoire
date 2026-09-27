# The Bard's Grimoire — runs serve.py (standard library only, no pip installs).
# Railway builds this automatically; it provides PORT, and a volume for the shared library.
FROM python:3.12-slim

WORKDIR /app
COPY index.html serve.py ./
COPY css ./css
COPY js ./js

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "serve.py"]
