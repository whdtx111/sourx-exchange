import { createApp } from "./api/app.js";
import { MarketplaceService } from "./domain/service.js";
import { createStore } from "./domain/store.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp(new MarketplaceService(createStore()));

try {
  await app.listen({ port, host });
  app.log.info(`SourX Exchange API listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

