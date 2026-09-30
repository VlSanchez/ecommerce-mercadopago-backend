import { createApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * Punto de entrada del proceso: arranca el servidor HTTP escuchando en un puerto configurable.
 */
function main(): void {
  const config = loadConfig();
  const app = createApp(config);

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend escuchando en el puerto ${config.port}`);
  });
}

main();
