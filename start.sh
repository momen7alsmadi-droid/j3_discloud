#!/bin/bash
# =========================================================
# تشغيل البوت مع تثبيت Python تلقائياً عند الحاجة
# (يعمل على Koyeb / Render / أي استضافة Linux)
# =========================================================
cd "$(dirname "$0")"

# 1) تأكد من وجود python3
if ! command -v python3 &>/dev/null; then
  echo "⚠️ python3 غير موجود — تثبيت..."
  if command -v apt-get &>/dev/null; then
    apt-get update -y && apt-get install -y python3 python3-pip
  elif command -v apk &>/dev/null; then
    apk add --no-cache python3 py3-pip
  else
    echo "❌ لا يمكن تثبيت Python تلقائياً"
    exit 1
  fi
fi

# 2) تثبيت المتطلبات
python3 -m pip install -r requirements.txt

# 3) تشغيل البوت
python3 bot.py
