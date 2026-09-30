/**
 * Configuración leída de variables de entorno.
 *
 * Los secretos (p. ej. MP_ACCESS_TOKEN) NUNCA se hardcodean: se leen de env.
 * Referencia de diseño: design.md → decisiones clave (token server-side).
 */
export interface AppConfig {
  /** Puerto en el que escucha el servidor HTTP. */
  port: number;
  /** Origen del frontend permitido por CORS. */
  frontendOrigin: string;
  /** Access token de MercadoPago (secreto, solo server-side). Puede estar vacío en scaffolding. */
  mpAccessToken: string;
  /**
   * Base URL de la API de MercadoPago (p. ej. https://api.mercadopago.com). El adaptador
   * construye sobre ella los endpoints `POST /checkout/preferences` y `GET /v1/payments/:id`.
   */
  mpApiBaseUrl: string;
  /**
   * Secreto del webhook de MercadoPago usado para validar la firma `x-signature` de las
   * notificaciones (SECRETO, solo server-side). Puede estar vacío en scaffolding.
   */
  mpWebhookSecret: string;
  /**
   * Base pública del backend usada para construir `notification_url` (el endpoint del
   * webhook al que MercadoPago envía las notificaciones de pago).
   */
  backendPublicUrl: string;
  /**
   * Integrator ID del Programa de Partners de MercadoPago: identifica la integración ante
   * MercadoPago (Programa de Partners); se envía al SDK. No es secreto pero es configurable
   * por entorno.
   */
  mpIntegratorId: string;
  /**
   * Email del comprador que se incluye en `payer.email` de la Preference (checklist de
   * homologación). Por defecto usa el buyer de prueba; configurable por la env
   * `MP_PAYER_EMAIL`.
   */
  mpPayerEmail: string;
}

/**
 * Determina si el proceso corre en "producción" a efectos de la validación de arranque.
 *
 * Detección de producción basada en una variable **explícita** `APP_ENV` para no depender
 * de convenciones del host:
 * - `APP_ENV === 'production'` ⇒ producción (validación estricta activa).
 * - `APP_ENV` presente con cualquier otro valor ⇒ NO producción (aunque `NODE_ENV` sea
 *   `'production'`): `APP_ENV` explícito **prevalece** sobre `NODE_ENV`.
 * - `APP_ENV` ausente ⇒ se consulta `NODE_ENV` como respaldo (`'production'` ⇒ producción).
 *
 * Referencia de diseño: design.md → "Detección de 'producción'" (Req. 4.3). Algunos hosts
 * fijan `NODE_ENV=production` automáticamente; `APP_ENV` hace la intención inequívoca y manda.
 *
 * @param env Entorno del proceso; se leen `APP_ENV` y, como respaldo, `NODE_ENV`.
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const appEnv = env.APP_ENV;
  if (appEnv !== undefined) {
    // `APP_ENV` explícito manda sobre `NODE_ENV`.
    return appEnv === 'production';
  }
  // Sin `APP_ENV`, se consulta `NODE_ENV` como respaldo.
  return env.NODE_ENV === 'production';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedPort = Number.parseInt(env.PORT ?? '', 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
  return {
    port,
    frontendOrigin: env.FRONTEND_ORIGIN ?? 'http://localhost:4200',
    mpAccessToken: env.MP_ACCESS_TOKEN ?? '',
    mpApiBaseUrl: env.MP_API_BASE_URL ?? 'https://api.mercadopago.com',
    mpWebhookSecret: env.MP_WEBHOOK_SECRET ?? '',
    backendPublicUrl: env.BACKEND_PUBLIC_URL ?? `http://localhost:${port}`,
    mpIntegratorId: env.MP_INTEGRATOR_ID ?? 'dev_24c65fb163bf11ea96500242ac130004',
    mpPayerEmail: env.MP_PAYER_EMAIL ?? 'test_user_3856418533893132774@testuser.com',
  };
}
