import { config } from "./config.js";
import { createServer, shutdown } from "./index.js";
import { registerTelegramWebhook } from "./channels.js";
import { log } from "./logger.js";

const server = await createServer({ withScheduler: true });

server.listen(config.port, () => {
  log.info("server.started", {
    url: `http://localhost:${config.port}`,
    port: config.port,
    admin: config.admin.email,
  });
});

registerTelegramWebhook();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    shutdown(server, signal).then(() => process.exit(0));
  });
}

process.on("unhandledRejection", err => log.exception("unhandled.rejection", err));
process.on("uncaughtException", err => log.exception("unhandled.exception", err));
