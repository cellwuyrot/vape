/**
 * Планировщик фоновых задач внутри процесса.
 *
 * Внешний cron есть не везде: в Render, Timeweb Cloud Apps и Yandex Serverless
 * Containers его нет вовсе. Поэтому расписание живёт в приложении, а systemd-таймер
 * из каталога deploy/ остаётся альтернативой для классического сервера.
 */
import { log } from "./logger.js";

const jobs = new Map();

/**
 * Регистрирует периодическую задачу.
 * Задача не запускается повторно, пока не завершилась предыдущая:
 * бэкап на большой базе может идти дольше интервала.
 */
export function schedule(name, intervalMs, handler, { runOnStart = false } = {}) {
  if (jobs.has(name)) throw new Error(`Задача ${name} уже зарегистрирована`);

  let running = false;
  const tick = async () => {
    if (running) {
      log.warn("scheduler.overlap", { job: name });
      return;
    }
    running = true;
    const started = Date.now();
    try {
      await handler();
      log.debug("scheduler.done", { job: name, seconds: Number(((Date.now() - started) / 1000).toFixed(2)) });
    } catch (err) {
      log.exception("scheduler.failed", err, { job: name });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Задача не должна удерживать процесс живым при остановке сервиса
  timer.unref?.();
  jobs.set(name, { timer, tick });

  log.info("scheduler.registered", { job: name, interval_minutes: Math.round(intervalMs / 60000) });
  if (runOnStart) setTimeout(tick, 5000).unref?.();

  return () => stop(name);
}

/** Ручной запуск задачи — используется эндпоинтом обслуживания и тестами. */
export function trigger(name) {
  const job = jobs.get(name);
  if (!job) throw new Error(`Задача ${name} не зарегистрирована`);
  return job.tick();
}

export function stop(name) {
  const job = jobs.get(name);
  if (!job) return;
  clearInterval(job.timer);
  jobs.delete(name);
}

export function stopAll() {
  for (const name of [...jobs.keys()]) stop(name);
}

export const listJobs = () => [...jobs.keys()];
