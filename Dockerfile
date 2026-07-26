FROM python:3.11-slim

WORKDIR /app

# تثبيت المكتبات
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# نسخ ملفات المشروع فقط (config.json و database.json مستثنيان عبر .dockerignore)
COPY bot.py .
COPY discloud.config .
COPY start.sh .
COPY config.example.json .

# البوت يقرأ التوكن من متغير البيئة TOKEN تلقائياً
# (راجع السطر الأخير من bot.py)

CMD ["python", "bot.py"]
