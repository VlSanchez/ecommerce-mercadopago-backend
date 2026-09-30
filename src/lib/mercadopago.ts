/**
 * Adaptador de MercadoPago — capa delgada sobre el SDK oficial `mercadopago`.
 *
 * Referencia de diseño: design.md → Components and Interfaces / `lib/mercadopago` y
 * Data Models / Preference. Cubre la tarea 8.1.
 *
 * Responsabilidades:
 * 1. Crear una Preference usando la clase `Preference` del SDK (inicializado con
 *    `MercadoPagoConfig` y `MP_ACCESS_TOKEN`) con un timeout de 30s; retorna
 *    `{ id, init_point }` o un error tipado que distingue el TIMEOUT del resto de fallos
 *    (Req. 5.2, 5.3).
 * 2. Consultar un pago referenciado con la clase `Payment` del SDK para obtener su estado
 *    real (Req. 6.6).
 * 3. Validar la firma de la notificación del webhook (esquema `x-signature` /
 *    `x-request-id` con HMAC) para confirmar que proviene de MercadoPago (Req. 6.6). Esta
 *    validación se mantiene con `node:crypto`, sin depender del SDK.
 *
 * La dependencia externa (el SDK) se aísla detrás de una factoría inyectable
 * (`SdkFactory`), de modo que las pruebas puedan mockear los clientes `preference.create`
 * y `payment.get` sin red real. El adaptador usa el patrón `Result<T, E>` para no lanzar
 * en los flujos de error esperados.
 *
 * > Nota: la información de MercadoPago fue parafraseada para cumplir con las restricciones
 * > de licenciamiento. Referencias: Checkout Pro Preferences y Webhooks/notifications de
 * > la documentación oficial de MercadoPago.
 */
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '../models/index.js';
import type { Order, PreferenceRequest, PreferenceRequestItem } from '../models/index.js';
import { PRODUCT } from '../models/index.js';
import { loadConfig, type AppConfig } from '../config.js';

/** Timeout máximo, en milisegundos, para crear la Preference (Req. 5.3: 30 segundos). */
export const PREFERENCE_TIMEOUT_MS = 30_000;

/**
 * Texto de negocio para el resumen de tarjeta del comprador (checklist de homologación:
 * `statement_descriptor`). Corto y reconocible; mejora la aprobación del cargo.
 */
const STATEMENT_DESCRIPTOR = 'ECOMMERCE';

/** Máximo de cuotas ofrecidas con tarjeta de crédito (paso de homologación). */
const MAX_INSTALLMENTS = 6;
/** Marcas de tarjeta excluidas del Checkout (paso de homologación: excluir Visa). */
const EXCLUDED_PAYMENT_METHODS = [{ id: 'visa' }];

/**
 * Indica si una URL apunta a un host local (localhost / 127.0.0.1, con o sin puerto).
 * Se usa para decidir si se puede enviar `auto_return`: MercadoPago rechaza `auto_return`
 * con back_urls locales (error `invalid_auto_return`), por lo que el campo se omite en dev.
 */
function isLocalUrl(url: string): boolean {
  return /localhost|127\.0\.0\.1/i.test(url);
}

/**
 * Respuesta relevante de MercadoPago al crear una Preference: el `id` de la Preference y
 * el `init_point` (URL de Checkout productiva a la que se redirige al visitante) (Req. 5.3).
 * El `init_point` es SIEMPRE la URL de Checkout productiva del payload, acorde al esquema de
 * credenciales `APP_USR-` (usuario de prueba, pero flujo "productivo").
 *
 * `sandbox_init_point` es la URL de Checkout en el entorno de sandbox (sandbox.mercadopago.cl),
 * que MercadoPago devuelve junto al `init_point` de producción. Se conserva de forma opcional
 * SOLO para trazabilidad; no se expone como `init_point`.
 */
export interface PreferenceResponse {
  id: string;
  init_point: string;
  /** URL de Checkout en sandbox (sandbox.mercadopago.cl), si MercadoPago la devuelve. */
  sandbox_init_point?: string;
  /** Payload crudo de la respuesta de MercadoPago, solo para diagnóstico/log. */
  raw?: unknown;
}

/** Estado real de un pago consultado en MercadoPago (Req. 6.6). */
export interface PaymentInfo {
  /** id del pago en MercadoPago. */
  id: string;
  /** estado crudo del pago (p. ej. "approved", "rejected", "pending", ...). */
  status: string;
  /** Order.id correlacionado (external_reference), si viene presente. */
  externalReference?: string;
  /** Indica si el pago se procesó en modo productivo (`true`) o de prueba (`false`). */
  liveMode?: boolean;
  /**
   * id de la cuenta que recibe el pago (collector). Útil para diagnóstico de homologación
   * (seller de prueba vs cuenta principal).
   */
  collectorId?: string;
}

/**
 * Error tipado del adaptador. `TIMEOUT` distingue explícitamente el caso en que
 * MercadoPago no respondió dentro de los 30s del resto de fallos (Req. 5.3, 5.5): así el
 * llamador (Payment_Service) puede conservar la Order en "pending" y retornar
 * `PAYMENT_INIT_FAILED` en ambos casos, pero registrar la causa con precisión.
 */
export interface MercadoPagoError {
  code: 'TIMEOUT' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'NETWORK_ERROR';
  message: string;
  /** Código de estado HTTP, presente cuando `code === 'HTTP_ERROR'`. */
  status?: number;
}

function timeoutError(message: string): MercadoPagoError {
  return { code: 'TIMEOUT', message };
}

function httpError(status: number, message: string): MercadoPagoError {
  return { code: 'HTTP_ERROR', message, status };
}

function invalidResponseError(message: string): MercadoPagoError {
  return { code: 'INVALID_RESPONSE', message };
}

function networkError(message: string): MercadoPagoError {
  return { code: 'NETWORK_ERROR', message };
}

/**
 * URLs de retorno (`back_urls`) a las que MercadoPago redirige el navegador tras el pago.
 * Se derivan del origen del frontend.
 */
export interface BackUrls {
  success: string;
  failure: string;
  pending: string;
}

/** Deriva las `back_urls` de éxito/error/pendiente a partir del origen del frontend. */
function buildBackUrls(frontendOrigin: string): BackUrls {
  const base = frontendOrigin.replace(/\/+$/, '');
  return {
    success: `${base}/checkout/success`,
    failure: `${base}/checkout/failure`,
    pending: `${base}/checkout/pending`,
  };
}

/** Construye la `notification_url` (endpoint del webhook del backend) desde su base pública. */
function buildNotificationUrl(backendPublicUrl: string): string {
  const base = backendPublicUrl.replace(/\/+$/, '');
  return `${base}/api/webhooks/mercadopago`;
}

/**
 * Construye el `PreferenceRequest` a partir de una Order (Req. 5.2).
 *
 * - `items`: el producto único con su cantidad, `unit_price` entero en CLP, su
 *   `description` (checklist `item_description`) y su `picture_url` (checklist `picture_url`),
 *   tomados del snapshot del carrito de la Order y del catálogo (`PRODUCT`). El `id` del ítem
 *   proviene de `item.productId` (= `PRODUCT.id`, 4 dígitos numéricos para homologación).
 * - `external_reference`: es SIEMPRE el `Order.id` (identificador de la Order), de modo que
 *   la notificación del webhook se correlaciona directamente con la Order correspondiente y
 *   `applyPaymentResult` puede actualizarla.
 * - `back_urls` + `notification_url` + `statement_descriptor` (checklist de homologación).
 * - `payment_methods` (paso de homologación): configura un máximo de 6 cuotas con tarjeta
 *   de crédito (`installments: 6`) y excluye la marca Visa (`excluded_payment_methods: [{ id: 'visa' }]`).
 * - `auto_return: "approved"`: se agrega SOLO si `back_urls.success` NO es local, porque
 *   MercadoPago rechaza `auto_return` con back_urls locales (error `invalid_auto_return`).
 *
 * Nota sobre `payer` (checklist `payer.email` / `payer.last_name`): AHORA sí se incluye
 * `payer.email` cuando hay un email configurado (para el checklist de homologación),
 * tomándolo de la config (`mpPayerEmail`, por defecto el buyer de prueba). En cambio,
 * `name`/`surname` siguen sin incluirse porque el sistema aún no captura datos reales del
 * comprador; no se inventan datos falsos para no afectar la homologación ni la aprobación.
 *
 * Se exporta para que el Payment_Service y las pruebas puedan reutilizar/verificar la
 * construcción sin realizar la llamada al SDK.
 */
export function buildPreferenceRequest(
  order: Order,
  options: {
    backUrls: BackUrls;
    notificationUrl: string;
    /**
     * Email para `payer.email`; si está presente y no vacío se incluye el objeto `payer`
     * (checklist de homologación). Si falta, no se agrega `payer`.
     */
    payerEmail?: string;
  },
): PreferenceRequest {
  // El external_reference es SIEMPRE el Order.id, de modo que el webhook correlaciona la
  // notificación directamente con la Order correspondiente.
  const externalReference = order.id;
  const items: PreferenceRequestItem[] = order.cartSnapshot.items.map((item) => ({
    id: item.productId,
    title: PRODUCT.name,
    description: PRODUCT.description,
    picture_url: PRODUCT.imageUrl,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    currency_id: 'CLP',
  }));

  // Objeto base sin `auto_return`. El campo se añade condicionalmente más abajo.
  const req: PreferenceRequest = {
    items,
    external_reference: externalReference,
    back_urls: {
      success: options.backUrls.success,
      failure: options.backUrls.failure,
      pending: options.backUrls.pending,
    },
    statement_descriptor: STATEMENT_DESCRIPTOR,
    payment_methods: {
      installments: MAX_INSTALLMENTS,
      excluded_payment_methods: EXCLUDED_PAYMENT_METHODS,
    },
    notification_url: options.notificationUrl,
  };

  // `auto_return` solo es válido con back_urls públicas. Con localhost/127.0.0.1 la API
  // devuelve `invalid_auto_return` ("back_url.success must be defined"), así que se omite.
  if (!isLocalUrl(options.backUrls.success)) {
    req.auto_return = 'approved';
  }

  // `payer.email` (checklist de homologación): se incluye solo si hay un email configurado
  // y no vacío. `name`/`surname` se omiten porque no se capturan datos reales del comprador.
  if (options.payerEmail !== undefined && options.payerEmail !== '') {
    req.payer = { email: options.payerEmail };
  }

  return req;
}

/**
 * Cliente mínimo del SDK para crear Preferences. Solo declara la superficie que usa el
 * adaptador (`create`), lo que permite inyectar dobles en pruebas sin depender de toda la
 * firma del SDK.
 */
export interface PreferenceClientLike {
  create(args: { body: unknown; requestOptions?: { timeout?: number } }): Promise<unknown>;
}

/**
 * Cliente mínimo del SDK para consultar pagos. Solo declara la superficie que usa el
 * adaptador (`get`).
 */
export interface PaymentClientLike {
  get(args: { id: string; requestOptions?: { timeout?: number } }): Promise<unknown>;
}

/**
 * Factoría inyectable de los clientes del SDK. Recibe el token, el timeout y el
 * `integratorId` (Programa de Partners) y devuelve los clientes `preference` y `payment`.
 * Por defecto usa el SDK oficial; las pruebas pueden inyectar una factoría que devuelva
 * dobles de `create`/`get`.
 */
export type SdkFactory = (config: {
  accessToken: string;
  timeoutMs: number;
  integratorId: string;
}) => {
  preference: PreferenceClientLike;
  payment: PaymentClientLike;
};

/**
 * Factoría por defecto: inicializa el SDK con `MercadoPagoConfig` (token + timeout global +
 * integratorId del Programa de Partners) y devuelve las instancias de `Preference` y `Payment`.
 */
const defaultSdkFactory: SdkFactory = ({ accessToken, timeoutMs, integratorId }) => {
  const client = new MercadoPagoConfig({
    accessToken,
    options: { timeout: timeoutMs, integratorId },
  });
  return {
    preference: new Preference(client) as unknown as PreferenceClientLike,
    payment: new Payment(client) as unknown as PaymentClientLike,
  };
};

/** Dependencias inyectables del adaptador. Todas tienen valores por defecto de producción. */
export interface MercadoPagoAdapterDeps {
  /** Configuración de la app (token, base URLs, secreto del webhook). */
  config?: AppConfig;
  /** Factoría de clientes del SDK; por defecto usa el SDK oficial `mercadopago`. */
  sdkFactory?: SdkFactory;
  /** Timeout de creación de Preference en ms; por defecto 30s (Req. 5.3). */
  timeoutMs?: number;
}

/** Contrato público del adaptador de MercadoPago. */
export interface MercadoPagoAdapter {
  /**
   * Crea la Preference en MercadoPago (clase `Preference` del SDK) usando el
   * `MP_ACCESS_TOKEN` con timeout de 30s. Retorna `{ id, init_point }` o un
   * `MercadoPagoError` que distingue TIMEOUT de otros fallos (Req. 5.2, 5.3).
   */
  createPreference(order: Order): Promise<Result<PreferenceResponse, MercadoPagoError>>;
  /**
   * Consulta el estado real de un pago referenciado (clase `Payment` del SDK) (Req. 6.6).
   */
  getPayment(paymentId: string): Promise<Result<PaymentInfo, MercadoPagoError>>;
  /**
   * Valida la firma de una notificación entrante (esquema `x-signature` de MercadoPago).
   * Retorna `true` solo si la firma es auténtica; `false` en cualquier otro caso (firma
   * ausente, mal formada, secreto no configurado o HMAC que no coincide) (Req. 6.6).
   */
  validateSignature(input: SignatureValidationInput): boolean;
  /** Construye el `PreferenceRequest` para una Order (expuesto para reutilización/pruebas). */
  buildPreferenceRequest(order: Order): PreferenceRequest;
}

/**
 * Datos necesarios para validar la firma de la notificación del webhook (Req. 6.6).
 *
 * MercadoPago firma la notificación con un HMAC-SHA256 sobre un "manifest" que combina el
 * id del recurso (`data.id`), el `x-request-id` y el timestamp `ts` extraído de la cabecera
 * `x-signature`. La cabecera `x-signature` tiene el formato `ts=<timestamp>,v1=<hmac hex>`.
 *
 * El manifest es TOLERANTE: `data.id` y `x-request-id` son opcionales y se OMITEN del
 * manifest si faltan (según la doc de MercadoPago). Solo `x-signature` es obligatoria.
 * Importante: MercadoPago calcula el HMAC con el `data.id` que viaja en el QUERY STRING de
 * la URL del webhook, por lo que el llamador debe priorizar esa fuente para `dataId`.
 */
export interface SignatureValidationInput {
  /** Valor crudo de la cabecera `x-signature`. */
  signatureHeader: string | undefined;
  /** Valor de la cabecera `x-request-id` (opcional; se omite del manifest si falta). */
  requestId: string | undefined;
  /**
   * id del recurso notificado. MercadoPago lo envía en el `data.id` del query string de la
   * URL del webhook; es opcional y se omite del manifest si falta.
   */
  dataId: string | undefined;
}

/** Extrae los campos `ts` y `v1` de una cabecera `x-signature` con formato `k=v,k=v`. */
function parseSignatureHeader(
  header: string,
): { ts: string; v1: string } | undefined {
  const parts = header.split(',');
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  if (ts === undefined || ts === '' || v1 === undefined || v1 === '') {
    return undefined;
  }
  return { ts, v1 };
}

/**
 * Compara dos firmas hex en tiempo constante. Retorna `false` si difieren en longitud o
 * si alguna no es hex válido, evitando fugas por temporización.
 */
function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Detecta si un error corresponde a un timeout/abort de la petición. El SDK aborta la
 * petición vía `AbortController` cuando se supera el `timeout`, lo que se manifiesta como
 * un `AbortError` (o `code` ABORT_ERR / ETIMEDOUT, o un mensaje con "timeout"/"aborted").
 */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? (record['name'] as string) : '';
  const code = typeof record['code'] === 'string' ? (record['code'] as string) : '';
  const message =
    typeof record['message'] === 'string' ? (record['message'] as string) : '';
  if (name === 'AbortError') return true;
  if (code === 'ABORT_ERR' || code === 'ETIMEDOUT') return true;
  return /timeout|aborted/i.test(message);
}

/**
 * Traduce un error lanzado por el SDK a un `MercadoPagoError` tipado (Req. 5.3, 5.5, 6.6):
 * - Timeout/abort → `TIMEOUT`.
 * - Error con `status`/`statusCode` numérico → `HTTP_ERROR` con ese estado.
 * - Cualquier otro → `NETWORK_ERROR` con el mensaje original.
 */
function translateSdkError(error: unknown, context: string): MercadoPagoError {
  if (isTimeoutError(error)) {
    return timeoutError(`MercadoPago no respondió a tiempo al ${context}.`);
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const rawStatus = record['status'] ?? record['statusCode'];
    if (typeof rawStatus === 'number') {
      return httpError(
        rawStatus,
        `MercadoPago respondió con estado ${rawStatus} al ${context}.`,
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return networkError(`Fallo de red al ${context}: ${message}`);
}

/**
 * Crea una instancia del adaptador de MercadoPago.
 *
 * @param deps dependencias inyectables (config, factoría del SDK, timeout). Por defecto usa
 *   la config del entorno, el SDK oficial `mercadopago` y un timeout de 30s.
 */
export function createMercadoPagoAdapter(
  deps: MercadoPagoAdapterDeps = {},
): MercadoPagoAdapter {
  const config = deps.config ?? loadConfig();
  const timeoutMs = deps.timeoutMs ?? PREFERENCE_TIMEOUT_MS;
  const sdkFactory = deps.sdkFactory ?? defaultSdkFactory;

  const backUrls = buildBackUrls(config.frontendOrigin);
  const notificationUrl = buildNotificationUrl(config.backendPublicUrl);

  // Los clientes del SDK se crean una sola vez con el token, el timeout y el integratorId
  // (Programa de Partners) configurados.
  const { preference: preferenceClient, payment: paymentClient } = sdkFactory({
    accessToken: config.mpAccessToken,
    timeoutMs,
    integratorId: config.mpIntegratorId,
  });

  function buildPreference(order: Order): PreferenceRequest {
    return buildPreferenceRequest(order, {
      backUrls,
      notificationUrl,
      payerEmail: config.mpPayerEmail,
    });
  }

  async function createPreference(
    order: Order,
  ): Promise<Result<PreferenceResponse, MercadoPagoError>> {
    const body = buildPreference(order);

    let payload: unknown;
    try {
      payload = await preferenceClient.create({
        body,
        requestOptions: { timeout: timeoutMs },
      });
    } catch (error) {
      return err(translateSdkError(error, 'crear la Preference'));
    }

    if (typeof payload !== 'object' || payload === null) {
      return err(invalidResponseError('La respuesta de MercadoPago no es un objeto.'));
    }

    const record = payload as Record<string, unknown>;
    const id = record['id'];
    const initPoint = record['init_point'];
    // `sandbox_init_point` puede venir o no; solo se considera válido si es string no vacío.
    // Su ausencia NO es un error: la validación de respuesta se hace sobre el init_point crudo.
    const rawSandboxInitPoint = record['sandbox_init_point'];
    const sandboxInitPoint =
      typeof rawSandboxInitPoint === 'string' && rawSandboxInitPoint !== ''
        ? rawSandboxInitPoint
        : undefined;

    if (typeof id !== 'string' || id === '') {
      return err(invalidResponseError('La respuesta no contiene un id de Preference válido.'));
    }
    // La validación se hace sobre el `init_point` crudo del payload (producción).
    if (typeof initPoint !== 'string' || initPoint === '') {
      return err(invalidResponseError('La respuesta no contiene un init_point válido.'));
    }

    // El `init_point` expuesto es SIEMPRE el productivo del payload. Esto es acorde al
    // esquema de credenciales `APP_USR-` (usuario de prueba, pero flujo "productivo"): el
    // Checkout correcto es el `init_point` normal, no el `sandbox_init_point` (que
    // corresponde al sandbox clásico con credenciales `TEST-`). El `sandbox_init_point` se
    // conserva solo para trazabilidad/uso futuro cuando MercadoPago lo devuelva.
    return ok({
      id,
      init_point: initPoint,
      ...(sandboxInitPoint !== undefined ? { sandbox_init_point: sandboxInitPoint } : {}),
      // Payload crudo de la respuesta de MercadoPago, solo para diagnóstico/log.
      raw: payload,
    });
  }

  async function getPayment(
    paymentId: string,
  ): Promise<Result<PaymentInfo, MercadoPagoError>> {
    let payload: unknown;
    try {
      payload = await paymentClient.get({
        id: paymentId,
        requestOptions: { timeout: timeoutMs },
      });
    } catch (error) {
      return err(translateSdkError(error, `consultar el pago ${paymentId}`));
    }

    if (typeof payload !== 'object' || payload === null) {
      return err(invalidResponseError('La respuesta de MercadoPago no es un objeto.'));
    }

    const record = payload as Record<string, unknown>;
    const id = record['id'];
    const status = record['status'];
    if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '') {
      return err(invalidResponseError('La respuesta no contiene un id de pago válido.'));
    }
    if (typeof status !== 'string' || status === '') {
      return err(invalidResponseError('La respuesta no contiene un estado de pago válido.'));
    }

    const externalReference = record['external_reference'];
    // `live_mode` (boolean) y `collector_id` (habitualmente number) se exponen para
    // diagnóstico de homologación: permiten distinguir pagos productivos de los de prueba
    // y saber a qué cuenta (collector) pertenecen. Se extraen de forma defensiva y solo se
    // incluyen si vienen presentes/válidos.
    const liveMode = record['live_mode'];
    const rawCollectorId = record['collector_id'];
    const collectorId =
      typeof rawCollectorId === 'number'
        ? String(rawCollectorId)
        : typeof rawCollectorId === 'string' && rawCollectorId !== ''
          ? rawCollectorId
          : undefined;
    return ok({
      id: String(id),
      status,
      ...(typeof externalReference === 'string' && externalReference !== ''
        ? { externalReference }
        : {}),
      ...(typeof liveMode === 'boolean' ? { liveMode } : {}),
      ...(collectorId !== undefined ? { collectorId } : {}),
    });
  }

  function validateSignature(input: SignatureValidationInput): boolean {
    // Req. 6.6: sin secreto configurado no es posible autenticar la notificación; se
    // rechaza para que el llamador no modifique ninguna Order.
    if (config.mpWebhookSecret === '') return false;
    // Solo la cabecera `x-signature` (con su `ts`/`v1`) es estrictamente requerida. El
    // `data.id` y el `x-request-id` son OPCIONALES: si faltan, se OMITEN del manifest
    // según la doc de MercadoPago (no se rechaza por su ausencia).
    if (input.signatureHeader === undefined) return false;

    const parsed = parseSignatureHeader(input.signatureHeader);
    if (parsed === undefined) return false;

    // Manifest tolerante: se une con ';' solo las partes presentes, en este orden, y se
    // termina con ';'. Se omite `id:` si no hay data.id y `request-id:` si no hay
    // x-request-id; `ts:` siempre está presente. Siguiendo el esquema de firma de
    // MercadoPago (data.id en minúsculas).
    const manifestParts: string[] = [];
    if (input.dataId !== undefined && input.dataId !== '') {
      manifestParts.push(`id:${input.dataId.toLowerCase()}`);
    }
    if (input.requestId !== undefined && input.requestId !== '') {
      manifestParts.push(`request-id:${input.requestId}`);
    }
    manifestParts.push(`ts:${parsed.ts}`);
    const manifest = `${manifestParts.join(';')};`;
    const expected = createHmac('sha256', config.mpWebhookSecret)
      .update(manifest)
      .digest('hex');

    return safeCompareHex(expected, parsed.v1);
  }

  return {
    createPreference,
    getPayment,
    validateSignature,
    buildPreferenceRequest: buildPreference,
  };
}

/**
 * Instancia por defecto compartida por el proceso. El Payment_Service (tarea 9) la consume;
 * las pruebas (tarea 8.2) pueden crear instancias aisladas con `createMercadoPagoAdapter`
 * inyectando una `sdkFactory` que devuelva dobles de `preference.create` / `payment.get`.
 */
export const mercadoPagoAdapter: MercadoPagoAdapter = createMercadoPagoAdapter();
