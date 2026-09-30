import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { validateProductionConfig } from './config/validateProductionConfig.js';
import { logger as defaultLogger, type Logger } from './lib/logger.js';

/** Nombre de operación usado en las entradas de log del arranque. */
const OP_STARTUP = 'server.startup';

/** Función que finaliza el proceso; inyectable para poder testear sin matar el runner. */
export type ExitFn = (code: number) => never;

/** Dependencias del chequeo de arranque, inyectables para pruebas. */
export interface StartupCheckDeps {
  /** Configuración cargada a validar. */
  config: AppConfig;
  /** Logger para registrar cada violación por nombre de variable (Req. 5.4). */
  logger?: Logger;
  /** Función de salida del proceso; por defecto `process.exit`. */
  exit?: ExitFn;
}

/**
 * Ejecuta la validación de configuración productiva y aborta el arranque si falla.
 *
 * Si `validateProductionConfig(config)` no es `ok`, registra cada violación con
 * `logger.logFailure('server.startup', ...)` identificando la variable **por nombre**
 * (nunca el valor del secreto, Req. 5.5) y luego llama a `exit(1)`. Debe invocarse
 * ANTES de `createApp`/`listen` para no arrancar con configuración inválida (Req. 4.3, 5.4).
 *
 * La lógica está extraída y con dependencias inyectables para poder testear los caminos
 * ok/!ok sin arrancar el proceso.
 *
 * @returns `true` si la configuración es válida y el arranque puede continuar; `false` si
 *   se detectaron violaciones (tras invocar `exit`).
 */
export function runStartupCheck({
  config,
  logger = defaultLogger,
  exit = process.exit as ExitFn,
}: StartupCheckDeps): boolean {
  const result = validateProductionConfig(config);

  if (!result.ok) {
    for (const violation of result.violations) {
      logger.logFailure(
        OP_STARTUP,
        `Configuración productiva inválida: ${violation.variable} (${violation.reason}).`,
        violation.variable,
        { reason: violation.reason },
      );
    }
    exit(1);
    return false;
  }

  return true;
}

/**
 * Punto de entrada del proceso: valida la configuración productiva y, si es válida,
 * arranca el servidor HTTP escuchando en un puerto configurable.
 */
function main(): void {
  const config = loadConfig();

  // Aborta antes de crear la app/escuchar si la configuración productiva es inválida.
  if (!runStartupCheck({ config })) {
    return;
  }

  const app = createApp(config);

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend escuchando en el puerto ${config.port}`);
  });
}

main();
