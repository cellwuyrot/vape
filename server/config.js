/** Конфигурация из окружения. Файл .env читается вручную — без зависимостей. */
import fs from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const bool = (v, fallback) => (v === undefined ? fallback : /^(1|true|yes|да)$/i.test(v));

export const config = {
  port: Number(process.env.PORT || 3000),
  secret: process.env.SECRET_KEY || "dev-secret-change-me",
  dataDir: process.env.DATA_DIR || "./data",
  publicUrl: process.env.PUBLIC_URL || "",

  admin: {
    email: (process.env.ADMIN_EMAIL || "andycoulbot@gmail.com").trim().toLowerCase(),
  },

  /* --- Реквизиты своей организации: подставляются в печатные формы --- */
  org: {
    name: process.env.ORG_NAME || "ООО «Ваша компания»",
    inn: process.env.ORG_INN || "",
    kpp: process.env.ORG_KPP || "",
    ogrn: process.env.ORG_OGRN || "",
    address: process.env.ORG_ADDRESS || "",
    city: process.env.ORG_CITY || "Москва",
    phone: process.env.ORG_PHONE || "",
    email: process.env.ORG_EMAIL || "",
    bank: process.env.ORG_BANK || "",
    bik: process.env.ORG_BIK || "",
    account: process.env.ORG_ACCOUNT || "",
    corr_account: process.env.ORG_CORR_ACCOUNT || "",
    director: process.env.ORG_DIRECTOR || "",
    accountant: process.env.ORG_ACCOUNTANT || "",
  },

  /* --- Задачи и напоминания --- */
  tasks: {
    reminderIntervalMinutes: Number(process.env.TASK_REMINDER_INTERVAL_MINUTES || 5),
    defaultDueHours: Number(process.env.TASK_DEFAULT_DUE_HOURS || 24),
  },

  /* --- Хранилище данных: пусто → SQLite, postgres:// → PostgreSQL --- */
  databaseUrl: process.env.DATABASE_URL || "",
  dbPoolSize: Number(process.env.DB_POOL_SIZE || 10),

  /* --- Файловое хранилище вложений --- */
  storage: {
    // "local" — каталог на диске, "s3" — S3-совместимое хранилище в РФ
    backend: (process.env.STORAGE_BACKEND || (process.env.S3_BUCKET ? "s3" : "local")).toLowerCase(),
    localDir: process.env.STORAGE_DIR || "",
    maxFileSize: Number(process.env.MAX_FILE_SIZE || 25 * 1024 * 1024),
    s3: {
      endpoint: process.env.S3_ENDPOINT || "https://storage.yandexcloud.net",
      region: process.env.S3_REGION || "ru-central1",
      bucket: process.env.S3_BUCKET || "",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      // path-style адресация нужна большинству российских провайдеров
      forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
    },
  },

  /* --- Резервное копирование --- */
  backup: {
    enabled: bool(process.env.BACKUP_ENABLED, false),
    dir: process.env.BACKUP_DIR || "",
    intervalHours: Number(process.env.BACKUP_INTERVAL_HOURS || 24),
    keep: Number(process.env.BACKUP_KEEP || 7),
    uploadToS3: bool(process.env.BACKUP_UPLOAD_S3, false),
    // Проверять восстановление сразу после снятия копии
    verify: bool(process.env.BACKUP_VERIFY, true),
  },

  requireEmailVerification: bool(process.env.REQUIRE_EMAIL_VERIFICATION, true),
  requirePhoneVerification: false,
  codeTtlMinutes: Number(process.env.CODE_TTL_MINUTES || 15),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),

  smtpUrl: process.env.SMTP_URL || "",
  smtpApiKey: process.env.SMTP_API_KEY || "",
  mailFrom: process.env.MAIL_FROM || "info@vapelab.bond",
  mailbox: {
    address: (process.env.MAILBOX_ADDRESS || "info@vapelab.bond").trim().toLowerCase(),
    imapUrl: process.env.MAILBOX_IMAP_URL || "",
    host: process.env.MAIL_HOST || "mail.vapelab.bond",
    domain: process.env.MAIL_DOMAIN || "vapelab.bond",
    serverIp: process.env.MAIL_SERVER_IP || "178.253.16.19",
    dkimSelector: process.env.MAIL_DKIM_SELECTOR || "mail",
  },

  imageSearch: {
    yandexApiKey: process.env.YANDEX_SEARCH_API_KEY || "",
    yandexFolderId: process.env.YANDEX_SEARCH_FOLDER_ID || "",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  },
  smsUrl: process.env.SMS_URL || "",

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    username: String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim(),
    secret: process.env.TELEGRAM_WEBHOOK_SECRET || "telegram-secret",
  },
  wazzup: {
    key: process.env.WAZZUP_API_KEY || "",
    secret: process.env.WAZZUP_WEBHOOK_SECRET || "wazzup-secret",
  },

  isProd: process.env.NODE_ENV === "production",
};

// Каталоги по умолчанию считаем от DATA_DIR, чтобы в облаке хватило одного смонтированного диска.
if (!config.storage.localDir) config.storage.localDir = path.join(config.dataDir, "files");
if (!config.backup.dir) config.backup.dir = path.join(config.dataDir, "backups");

/** Проверка конфигурации на старте: молчаливый дефолт в продакшене опаснее падения. */
export function validateConfig() {
  const problems = [];
  if (config.isProd && config.secret === "dev-secret-change-me") {
    problems.push("SECRET_KEY не задан — сессии можно подделать");
  }
  if (config.isProd && !config.smtpUrl) {
    problems.push("SMTP_URL не задан — отправка одноразовых кодов e-mail недоступна");
  }
  if (config.isProd && !config.publicUrl) {
    problems.push("PUBLIC_URL не задан — невозможно сформировать канонические адреса и sitemap.xml");
  }
  if (config.isProd && config.telegram.secret === "telegram-secret") {
    problems.push("TELEGRAM_WEBHOOK_SECRET не заменён на случайный секрет");
  }
  if (config.isProd && config.wazzup.secret === "wazzup-secret") {
    problems.push("WAZZUP_WEBHOOK_SECRET не заменён на случайный секрет");
  }
  if (config.publicUrl) {
    try {
      const publicUrl = new URL(config.publicUrl);
      if (publicUrl.protocol !== "https:" && config.isProd) problems.push("PUBLIC_URL в production должен использовать HTTPS");
      if (publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
        problems.push("PUBLIC_URL должен содержать только публичный origin, например https://vapelab.tech");
      }
    } catch {
      problems.push("PUBLIC_URL должен быть корректным абсолютным URL");
    }
  }
  if (config.smtpUrl && !/^(smtps?:\/\/|https?:\/\/)/i.test(config.smtpUrl)) {
    problems.push("SMTP_URL должен использовать smtp://, smtps:// или HTTPS webhook");
  }
  if (config.mailbox.imapUrl && !/^imaps:\/\//i.test(config.mailbox.imapUrl)) {
    problems.push("MAILBOX_IMAP_URL должен использовать защищённое подключение imaps://");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.mailbox.address)) {
    problems.push("MAILBOX_ADDRESS должен быть корректным e-mail адресом");
  }
  if (config.isProd && /^http:\/\//i.test(config.smtpUrl)) {
    let localEndpoint = false;
    try {
      localEndpoint = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.smtpUrl).hostname);
    } catch {}
    if (!localEndpoint) problems.push("В production HTTP разрешён только локальный SMTP API");
  }
  if (config.isProd && /\/api\/emails(?:[?#]|$)/i.test(config.smtpUrl) && !config.smtpApiKey) {
    problems.push("SMTP_API_KEY не задан для SMTP API");
  }
  if (config.storage.backend === "s3") {
    const { bucket, accessKeyId, secretAccessKey } = config.storage.s3;
    if (!bucket) problems.push("STORAGE_BACKEND=s3, но не задан S3_BUCKET");
    if (!accessKeyId || !secretAccessKey) problems.push("STORAGE_BACKEND=s3, но не заданы ключи доступа");
  }
  if (config.databaseUrl && !/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    problems.push("DATABASE_URL должен начинаться с postgres://");
  }
  if (config.backup.enabled && config.backup.intervalHours < 1) {
    problems.push("BACKUP_INTERVAL_HOURS не может быть меньше часа");
  }
  return problems;
}
