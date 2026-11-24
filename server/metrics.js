/**
 * Метрики в формате Prometheus — без клиентской библиотеки.
 *
 * Считаем то, по чему судят о здоровье CRM: количество запросов по кодам ответа,
 * время ответа по перцентилям и длительность обращений к базе.
 * Целевой показатель из плана — открытие карточки быстрее 300 мс — виден
 * прямо в гистограмме http_request_duration_seconds.
 */

const startedAt = Date.now();

/** Границы в секундах: последняя корзина 300 мс — контрольная точка из плана. */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.5, 1, 2.5, 5, 10];
const DB_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1];

class Histogram {
  constructor(name, help, buckets, labelNames = []) {
    Object.assign(this, { name, help, buckets, labelNames });
    this.series = new Map();
  }

  observe(labels, value) {
    const key = JSON.stringify(this.labelNames.map((l) => labels[l] ?? ""));
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) entry.counts[i] += 1;
    }
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      const base = this.labelNames.map((l) => `${l}="${escapeLabel(entry.labels[l] ?? "")}"`);
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i += 1) {
        cumulative = entry.counts[i];
        lines.push(`${this.name}_bucket{${[...base, `le="${this.buckets[i]}"`].join(",")}} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket{${[...base, 'le="+Inf"'].join(",")}} ${entry.count}`);
      lines.push(`${this.name}_sum{${base.join(",")}} ${entry.sum.toFixed(6)}`);
      lines.push(`${this.name}_count{${base.join(",")}} ${entry.count}`);
    }
    return lines;
  }
}

class Counter {
  constructor(name, help, labelNames = []) {
    Object.assign(this, { name, help, labelNames });
    this.series = new Map();
  }

  inc(labels = {}, value = 1) {
    const key = JSON.stringify(this.labelNames.map((l) => labels[l] ?? ""));
    const entry = this.series.get(key) || { labels, value: 0 };
    entry.value += value;
    this.series.set(key, entry);
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const entry of this.series.values()) {
      const base = this.labelNames.map((l) => `${l}="${escapeLabel(entry.labels[l] ?? "")}"`);
      lines.push(`${this.name}${base.length ? `{${base.join(",")}}` : ""} ${entry.value}`);
    }
    return lines;
  }
}

const escapeLabel = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

export const httpRequests = new Counter(
  "http_requests_total",
  "Количество HTTP-запросов",
  ["method", "route", "status"]
);
export const httpDuration = new Histogram(
  "http_request_duration_seconds",
  "Время ответа HTTP в секундах",
  HTTP_BUCKETS,
  ["method", "route"]
);
export const dbQueries = new Counter("db_queries_total", "Количество запросов к базе", ["op"]);
export const dbDuration = new Histogram(
  "db_query_duration_seconds",
  "Время запроса к базе в секундах",
  DB_BUCKETS,
  ["op"]
);
export const dbErrors = new Counter("db_errors_total", "Ошибки запросов к базе", []);
export const backupRuns = new Counter("backup_runs_total", "Запуски резервного копирования", ["result"]);
export const messagesIngested = new Counter(
  "inbox_messages_total",
  "Сообщения инбокса",
  ["channel", "direction"]
);

/**
 * Нормализует путь в шаблон маршрута: без этого числовые идентификаторы
 * порождают тысячи временных рядов и убивают Prometheus.
 */
export function routeLabel(pathname) {
  return pathname
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/webhooks\/([a-z]+)\/[^/]+$/i, "/webhooks/$1/:secret")
    .slice(0, 120);
}

export function observeHttp({ method, route, status, seconds }) {
  httpRequests.inc({ method, route, status: String(status) });
  httpDuration.observe({ method, route }, seconds);
}

export function observeDb(op, seconds, ok = true) {
  dbQueries.inc({ op });
  dbDuration.observe({ op }, seconds);
  if (!ok) dbErrors.inc({});
}

export function renderMetrics(extra = {}) {
  const memory = process.memoryUsage();
  const lines = [
    ...httpRequests.render(),
    ...httpDuration.render(),
    ...dbQueries.render(),
    ...dbDuration.render(),
    ...dbErrors.render(),
    ...backupRuns.render(),
    ...messagesIngested.render(),
    "# HELP process_uptime_seconds Время работы процесса",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(1)}`,
    "# HELP process_resident_memory_bytes Занятая память",
    "# TYPE process_resident_memory_bytes gauge",
    `process_resident_memory_bytes ${memory.rss}`,
  ];

  for (const [name, value] of Object.entries(extra)) {
    lines.push(`# TYPE ${name} gauge`, `${name} ${Number(value) || 0}`);
  }
  return `${lines.join("\n")}\n`;
}
