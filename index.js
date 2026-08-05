/**
 * =========================================================
 *  j3_discloud — نقطة الدخول لاستضافات Node.js (Pterodactyl)
 * =========================================================
 * البوت مكتوب بـ Python (bot.py) لكن لوحة الاستضافة تعمل
 * بإعداد Node.js وتطلب /home/container/index.js.
 *
 * هذا الملف (index.js) يحل المشكلة بشكل مضاد للأخطاء:
 *   1) يبحث عن bot.py في نفس المجلد ثم في أي مجلد فرعي
 *      (حتى لو رفعت الملفات داخل مجلد j3_discloud/).
 *   2) إن لم يجده — يحمّله تلقائياً من GitHub (بدون أي
 *      تثبيتات إضافية، عبر https مدمج في Node).
 *   3) يتأكد من وجود python3 — وإن لم يوجد يثبّته تلقائياً
 *      (apt-get ثم apk كبديل).
 *   4) يثبّت المتطلبات من requirements.txt (discord.py).
 *   5) يشغّل bot.py ويعرض مخرجاته في الكونسول.
 *   6) يعيد توجيه إشارات الإيقاف (SIGTERM/SIGINT) وكود
 *      الخروج — حتى تتوقف العملية فعلاً عند Stop من اللوحة
 *      وتعمل إعادة التشغيل التلقائية بشكل صحيح.
 * =========================================================
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const GIT_REPO = 'momen7alsmadi-droid/j3_discloud';
const RAW_BASE = `https://raw.githubusercontent.com/${GIT_REPO}/main`;
const NEEDED_FILES = ['bot.py', 'requirements.txt', 'config.example.json'];

/** تنفيذ أمر في القشرة مع طباعته في الكونسول */
function run(cmd) {
  console.log('> ' + cmd);
  return execSync(cmd, { stdio: 'inherit' });
}

/** هل python3 (أو python) متوفر؟ */
function findPython() {
  try { execSync('python3 --version', { stdio: 'ignore' }); return 'python3'; } catch { /* متابعة */ }
  try { execSync('python --version', { stdio: 'ignore' }); return 'python'; } catch { /* متابعة */ }
  return null;
}

/** تثبيت Python تلقائياً إن لم يكن موجوداً (apt ثم apk) */
function ensurePython() {
  if (findPython()) return findPython();
  console.log('⚠️ python3 غير موجود — أحاول تثبيته تلقائياً...');
  const installers = [
    'apt-get update -y && apt-get install -y python3 python3-pip',
    'apk add --no-cache python3 py3-pip',
  ];
  for (const cmd of installers) {
    try {
      run(cmd);
      if (findPython()) return findPython();
    } catch (e) {
      console.log('   (فشلت المحاولة — أجرب الطريقة التالية)');
    }
  }
  console.error('❌ تعذر تثبيت Python تلقائياً.');
  console.error('💡 الحل: اطلب من دعم الاستضافة اختيار إعداد Python، أو تثبيت python3 على الصورة.');
  process.exit(1);
}

/** البحث عن bot.py: نفس المجلد ثم مجلد فرعي واحد (حتى لو رُفعت الملفات داخل مجلد) */
function findBotDir() {
  const candidates = [__dirname];
  try {
    for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        candidates.push(path.join(__dirname, entry.name));
      }
    }
  } catch { /* متابعة */ }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'bot.py'))) return dir;
  }
  return null;
}

/** تنزيل ملف من GitHub (https مدمج — بدون أي مكتبات) */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      })
      .on('error', (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch { /* تجاهل */ }
        reject(err);
      });
  });
}

/** ضمان وجود bot.py — تنزيل تلقائي من GitHub إن لم يكن مرفوعاً */
async function ensureBotFiles() {
  const found = findBotDir();
  if (found) {
    console.log(`✅ تم العثور على bot.py في: ${found}`);
    return found;
  }
  console.log('⬇️ bot.py غير موجود في المجلد — أحمّله تلقائياً من GitHub...');
  const botDir = path.join(__dirname, 'src');
  fs.mkdirSync(botDir, { recursive: true });
  for (const f of NEEDED_FILES) {
    try {
      await download(`${RAW_BASE}/${f}`, path.join(botDir, f));
      console.log('   ✓ ' + f);
    } catch (e) {
      console.error('   ❌ ' + f + ': ' + e.message);
    }
  }
  if (!fs.existsSync(path.join(botDir, 'bot.py'))) {
    console.error('❌ فشل تحميل bot.py — تحقق من اتصال السيرفر بالإنترنت ثم أعد التشغيل.');
    process.exit(1);
  }
  return botDir;
}

async function main() {
  // 1) bot.py (مرفوع أو محمّل تلقائياً)
  const botDir = await ensureBotFiles();

  // 2) Python
  const py = ensurePython();
  console.log('✅ تم العثور على: ' + py);

  // 3) المتطلبات (discord.py) — إن فشل نكمل لأن البوت قد يكون مثبتاً في الصورة
  const reqFile = path.join(botDir, 'requirements.txt');
  if (fs.existsSync(reqFile)) {
    console.log('📦 تثبيت المتطلبات من requirements.txt...');
    try {
      run(`${py} -m pip install -r "${reqFile}"`);
    } catch (e) {
      console.log('⚠️ pip install لم يكتمل — سأحاول تشغيل البوت على أي حال.');
    }
  }

  // 4) تشغيل البوت (cwd = مجلد bot.py حتى يجد config.json و database.json)
  console.log('🚀 تشغيل البوت: ' + py + ' bot.py');
  const proc = spawn(py, ['bot.py'], { cwd: botDir, stdio: 'inherit' });

  proc.on('exit', (code, signal) => {
    console.log(`⛔ انتهى البوت (code=${code}, signal=${signal})`);
    process.exit(code !== null ? code : 1);
  });
  proc.on('error', (err) => {
    console.error('❌ فشل تشغيل العملية:', err.message);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    console.log('🛑 استقبلت SIGTERM — إيقاف البوت...');
    proc.kill('SIGTERM');
  });
  process.on('SIGINT', () => {
    console.log('🛑 استقبلت SIGINT — إيقاف البوت...');
    proc.kill('SIGINT');
  });
}

main().catch((e) => {
  console.error('❌ خطأ غير متوقع:', e.message);
  process.exit(1);
});
