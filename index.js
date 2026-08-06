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
 *   4) يتأكد من وجود pip بأربع طرق متتالية:
 *        أ) pip موجود أصلاً
 *        ب) python3 -m ensurepip
 *        ج) apt-get install python3-pip
 *        د) تنزيل get-pip.py عبر Node (بدون curl) وتشغيله
 *   5) يثبّت المتطلبات من requirements.txt مع دعم أنظمة
 *      Debian 12+ (PEP 668: --break-system-packages / --user)
 *   6) يشغّل bot.py ويعرض مخرجاته في الكونسول.
 *   7) يعيد توجيه إشارات الإيقاف (SIGTERM/SIGINT) وكود
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
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

/** تنفيذ أمر في القشرة مع طباعته في الكونسول — يرمي خطأ عند الفشل */
function run(cmd) {
  console.log('> ' + cmd);
  return execSync(cmd, { stdio: 'inherit' });
}

/** تنفيذ أمر بصمت — يرجع true عند النجاح */
function tryRun(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** تنفيذ أمر بصمت مع التقاط سبب الفشل (أول 250 حرفاً) */
function tryRunVerbose(cmd, label) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch (e) {
    const msg = String(e.stderr || e.message || '').trim().split('\n').slice(0, 6).join('\n');
    console.log(`   ✖ ${label} فشل${msg ? ':\n     ' + msg.slice(0, 250) : ''}`);
    return false;
  }
}

/** هل python3 (أو python) متوفر؟ */
function findPython() {
  if (tryRun('python3 --version')) return 'python3';
  if (tryRun('python --version')) return 'python';
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
  console.error('💡 الحل: اطلب من دعم الاستضافة تثبيت python3 على الصورة.');
  process.exit(1);
}

/** هل pip يعمل مع هذا المفسّر؟ */
function hasPip(py) {
  return tryRun(`${py} -m pip --version`);
}

/** ضمان وجود pip — أربع طرق متتالية */
function ensurePip(py) {
  if (hasPip(py)) {
    console.log('✅ pip موجود');
    return;
  }
  console.log('⚠️ pip غير موجود — أحاول تثبيته...');

  // تشخيص البيئة (لمساعدة الدعم الفني)
  console.log('   [تشخيص] المستخدم الحالي: ' + (tryRun('whoami') ? execSync('whoami').toString().trim() : '?'));
  console.log('   [تشخيص] HOME: ' + (process.env.HOME || 'غير معرف'));

  // أ) python3 -m ensurepip (مرفق مع معظم توزيعات Python)
  if (tryRunVerbose(`${py} -m ensurepip --upgrade`, 'ensurepip')) {
    if (hasPip(py)) { console.log('✅ pip ثُبّت عبر ensurepip'); return; }
  }

  // ب) apt-get (يتطلب صلاحيات Root)
  if (tryRunVerbose('apt-get update -qq && apt-get install -y -qq python3-pip', 'apt-get')) {
    if (hasPip(py)) { console.log('✅ pip ثُبّت عبر apt'); return; }
  }

  // ج) تنزيل get-pip.py عبر Node (يعمل بدون curl) وتشغيله بعدة طرق
  console.log('⬇️ أنزّل get-pip.py من python.org...');
  const getPip = path.join(__dirname, 'get-pip.py');
  try {
    download(GET_PIP_URL, getPip);
    console.log('   ✓ تم تنزيل get-pip.py (' + fs.statSync(getPip).size + ' bytes)');
    const variants = [
      `${py} "${getPip}" --user`,
      `${py} "${getPip}"`,
      `${py} "${getPip}" --user --break-system-packages`,
      `${py} "${getPip}" --break-system-packages`,
    ];
    for (const cmd of variants) {
      if (tryRunVerbose(cmd, 'get-pip.py (' + cmd.split('get-pip.py')[1].trim() + ')')) {
        if (hasPip(py)) {
          console.log('✅ pip ثُبّت عبر get-pip.py');
          return;
        }
      }
    }
  } catch (e) {
    console.log('   ✖ فشل تنزيل get-pip.py: ' + e.message + ' ← هل الحاوية متصلة بالإنترنت؟');
  }

  console.error('❌ تعذر تثبيت pip تلقائياً بأي طريقة.');
  console.error('💡 هذا عادةً بسبب: (1) عدم صلاحيات Root، أو (2) حظر الاتصال بـ pypi.org.');
  console.error('📨 أرسل للدعم الفني هذا النص:');
  console.error('  "الرجاء تثبيت python3-pip داخل حاوية الخادم، أو تغيير Docker Image');
  console.error('   إلى صورة Python تحتوي pip، أو تفعيل الاتصال بالإنترنت من الحاوية.');
  console.error('   المشروع يحتاج pip لتثبيت discord.py من requirements.txt."');
  process.exit(1);
}

/** تثبيت المتطلبات مع دعم PEP 668 (Debian 12+: يمنع التثبيت النظامي) */
function installRequirements(py, reqFile) {
  const variants = [
    `${py} -m pip install --no-cache-dir -r "${reqFile}"`,
    `${py} -m pip install --no-cache-dir -r "${reqFile}" --break-system-packages`,
    `${py} -m pip install --no-cache-dir --user -r "${reqFile}"`,
    `${py} -m pip install --no-cache-dir --user -r "${reqFile}" --break-system-packages`,
  ];
  for (const cmd of variants) {
    try {
      run(cmd);
      console.log('✅ تم تثبيت المتطلبات');
      return;
    } catch (e) {
      console.log('   (فشلت — أجرب طريقة أخرى)');
    }
  }
  throw new Error('فشل تثبيت المتطلبات بكل الطرق (تحقق من الاتصال بالإنترنت)');
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

/** تنزيل ملف (https مدمج — بدون أي مكتبات) */
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

  // 3) pip (4 طرق ضمان)
  ensurePip(py);

  // 4) المتطلبات (discord.py) — مع دعم PEP 668
  const reqFile = path.join(botDir, 'requirements.txt');
  if (fs.existsSync(reqFile)) {
    console.log('📦 تثبيت المتطلبات من requirements.txt...');
    try {
      installRequirements(py, reqFile);
    } catch (e) {
      console.error('❌ ' + e.message);
      console.error('💡 تأكد من أن السيرفر متصل بالإنترنت، ثم أعد التشغيل.');
      process.exit(1);
    }
  }

  // 5) تشغيل البوت (cwd = مجلد bot.py حتى يجد config.json و database.json)
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
