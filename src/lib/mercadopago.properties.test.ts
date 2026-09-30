import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHmac } from 'node:crypto';
import {
  createMercadoPagoAdapter,
  buildPreferenceRequest,
  type PaymentClientLike,
  type PreferenceClientLike,
  type SdkFactory,
} from './mercadopago.js';
import type { AppConfig } from '../config.js';
import type { Order, PreferenceRequest } from '../models/index.js';
import { PRODUCT } from '../models/index.js';

/**
 * Property-based tests (fast-check) del adaptador de MercadoPago.
 *
 * Cubren las Correctness Properties del diseño (design.md → Correctness Properties):
 * - P4: derivación de la `notification_url` desde `BACKEND_PUBLIC_URL`.
 * - P5: derivación de las `back_urls` desde `FRONTEND_ORIGIN` y activación condicional de
 *   `auto_return` (solo con `back_urls.success` público).
 * - P6: round-trip de validación de la firma `x-signature` del webhook.
 * - P7: presencia de los campos de certificación en el `PreferenceRequest`.
 *
 * Todas las propiedades se ejercitan a través de la superficie pública
 * (`createMercadoPagoAdapter` con una `sdkFactory` inyectada que captura el body enviado a
 * `preference.create`, y `buildPreferenceRequest`); no se exportan helpers internos ni se
 * toca la red. Cada test corre >=100 casos (`{ numRuns: 100 }`).
 *
 * Los tests example-based de `mercadopago.test.ts` (getPayment, init_point productivo,
 * payer.email) y `externalReference.test.ts` (external_reference = Order.id) NO cubren estas
 * propiedades de forma universal (no usan fast-check), por lo que estas propiedades son
 * necesarias y aditivas.
 */

/** Config base de prueba (sin secretos reales; no se toca la red). */
const BASE_CONFIG: AppConfig = {
  port: 3000,
  frontendOrigin: 'http://localhost:4200',
  mpAccessToken: 'test-token',
  mpApiBaseUrl: 'https://api.mercadopago.com',
  mpWebhookSecret: 'test-secret',
  backendPublicUrl: 'http://localhost:3000',
  mpIntegratorId: 'test-integrator',
  mpPayerEmail: 'test_user_3856418533893132774@testuser.com',
};

/**
 * Construye una `sdkFactory` de prueba que captura el body pasado a `preference.create` y
 * resuelve una respuesta válida mínima. El body capturado se expone vía el objeto `captor`.
 */
function capturingSdkFactory(captor: { body?: PreferenceRequest }): SdkFactory {
  const preference: PreferenceClientLike = {
    create: async (args) => {
      captor.body = args.body as PreferenceRequest;
      return {
        id: 'PREF-TEST',
        init_point: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=PREF-TEST',
      };
    },
  };
  const payment: PaymentClientLike = {
    get: async () => {
      throw new Error('payment.get no se usa en estas pruebas');
    },
  };
  return () => ({ preference, payment });
}

/** Order mínima válida para construir una Preference. */
function orderWithId(id: string, quantity = 1): Order {
  const unitPrice = PRODUCT.price;
  const subtotal = unitPrice * quantity;
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id,
    cartSnapshot: {
      items: [{ productId: PRODUCT.id, quantity, unitPrice, subtotal }],
      total: subtotal,
      currency: 'CLP',
    },
    amount: subtotal,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Feature: production-deployment-certification, Property 4
// P4: Derivación de la notification_url — Validates: Requirements 6.1, 7.6
// ---------------------------------------------------------------------------
describe('Property 4 — derivación de la notification_url', () => {
  // Feature: production-deployment-certification, Property 4
  it('para cualquier BACKEND_PUBLIC_URL (con/sin barras finales) la notification_url es base normalizada + /api/webhooks/mercadopago sin barras duplicadas', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Base pública arbitraria (host http/https, opcional puerto y path) ...
        fc.record({
          scheme: fc.constantFrom('http', 'https'),
          host: fc.domain(),
          port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
          path: fc.option(
            fc
              .array(
                fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('/')),
                { minLength: 1, maxLength: 3 },
              )
              .map((segs) => segs.join('/')),
            { nil: undefined },
          ),
          // ... con una cantidad arbitraria de barras finales (incluida ninguna).
          trailingSlashes: fc.integer({ min: 0, max: 5 }),
        }),
        async ({ scheme, host, port, path, trailingSlashes }) => {
          const portPart = port === undefined ? '' : `:${port}`;
          const pathPart = path === undefined ? '' : `/${path}`;
          const normalizedBase = `${scheme}://${host}${portPart}${pathPart}`;
          const backendPublicUrl = `${normalizedBase}${'/'.repeat(trailingSlashes)}`;

          const captor: { body?: PreferenceRequest } = {};
          const adapter = createMercadoPagoAdapter({
            config: { ...BASE_CONFIG, backendPublicUrl },
            sdkFactory: capturingSdkFactory(captor),
          });

          const result = await adapter.createPreference(orderWithId('order-p4'));
          expect(result.ok).toBe(true);
          expect(captor.body).toBeDefined();

          const notificationUrl = captor.body!.notification_url;
          // Debe ser exactamente la base normalizada + el path del webhook.
          expect(notificationUrl).toBe(`${normalizedBase}/api/webhooks/mercadopago`);
          // Y debe terminar exactamente con el path del webhook (sin barras duplicadas).
          expect(notificationUrl.endsWith('/api/webhooks/mercadopago')).toBe(true);
          // No hay barras duplicadas después del esquema (`://`).
          const afterScheme = notificationUrl.slice(notificationUrl.indexOf('://') + 3);
          expect(afterScheme.includes('//')).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: production-deployment-certification, Property 5
// P5: back_urls públicas activan auto_return — Validates: Requirements 7.4, 7.5
// ---------------------------------------------------------------------------
describe('Property 5 — back_urls derivadas de FRONTEND_ORIGIN y auto_return condicional', () => {
  // Feature: production-deployment-certification, Property 5
  it('para cualquier FRONTEND_ORIGIN las back_urls derivan del origen y auto_return === "approved" sii success no es local', async () => {
    // Generador de orígenes que mezcla hosts locales y públicos para ejercitar ambos casos.
    const localOrigin = fc
      .record({
        host: fc.constantFrom('localhost', '127.0.0.1'),
        port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
      })
      .map(({ host, port }) => `http://${host}${port === undefined ? '' : `:${port}`}`);

    const publicOrigin = fc
      .record({
        scheme: fc.constantFrom('http', 'https'),
        // Dominios que no contienen "localhost"/"127.0.0.1".
        host: fc.domain().filter((d) => !/localhost|127\.0\.0\.1/i.test(d)),
        port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
      })
      .map(
        ({ scheme, host, port }) =>
          `${scheme}://${host}${port === undefined ? '' : `:${port}`}`,
      );

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(localOrigin, publicOrigin),
        // Barras finales arbitrarias para verificar la normalización del origen.
        fc.integer({ min: 0, max: 3 }),
        async (baseOrigin, trailingSlashes) => {
          const frontendOrigin = `${baseOrigin}${'/'.repeat(trailingSlashes)}`;

          const captor: { body?: PreferenceRequest } = {};
          const adapter = createMercadoPagoAdapter({
            config: { ...BASE_CONFIG, frontendOrigin },
            sdkFactory: capturingSdkFactory(captor),
          });

          const result = await adapter.createPreference(orderWithId('order-p5'));
          expect(result.ok).toBe(true);
          expect(captor.body).toBeDefined();

          const body = captor.body!;
          // Las back_urls derivan del origen normalizado (sin barras finales duplicadas).
          expect(body.back_urls.success).toBe(`${baseOrigin}/checkout/success`);
          expect(body.back_urls.failure).toBe(`${baseOrigin}/checkout/failure`);
          expect(body.back_urls.pending).toBe(`${baseOrigin}/checkout/pending`);

          // auto_return === 'approved' sii success NO es local.
          const successIsLocal = /localhost|127\.0\.0\.1/i.test(body.back_urls.success);
          if (successIsLocal) {
            expect(body.auto_return).toBeUndefined();
          } else {
            expect(body.auto_return).toBe('approved');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: production-deployment-certification, Property 6
// P6: Round-trip de validación de firma del webhook — Validates: Requirements 6.3, 6.4, 6.5
// ---------------------------------------------------------------------------
describe('Property 6 — round-trip de la firma del webhook', () => {
  /**
   * Réplica exacta del manifest del adaptador: partes unidas con ';' y terminadas en ';',
   * con `id:<dataId en minúsculas>` (solo si dataId presente/no vacío),
   * `request-id:<requestId>` (solo si presente/no vacío) y siempre `ts:<ts>`.
   */
  function buildManifest(
    dataId: string | undefined,
    requestId: string | undefined,
    ts: string,
  ): string {
    const parts: string[] = [];
    if (dataId !== undefined && dataId !== '') parts.push(`id:${dataId.toLowerCase()}`);
    if (requestId !== undefined && requestId !== '') parts.push(`request-id:${requestId}`);
    parts.push(`ts:${ts}`);
    return `${parts.join(';')};`;
  }

  function hmacHex(secret: string, manifest: string): string {
    return createHmac('sha256', secret).update(manifest).digest('hex');
  }

  /**
   * Generador de `ts` (timestamp de la cabecera `x-signature`). Se restringe al espacio de
   * entrada real: MercadoPago envía un token sin espacios y sin los delimitadores `,`/`=` de
   * la cabecera; además `parseSignatureHeader` recorta (trim) el valor, por lo que un `ts`
   * con espacios al borde no round-trip-earía. Se usa un token alfanumérico no vacío.
   */
  const tsArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .map((s) => s.replace(/[\s,=]/g, ''))
    .filter((s) => s.length > 0);

  // Feature: production-deployment-certification, Property 6
  it('una firma v1 = HMAC-SHA256 correcto del manifest valida true', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }), // secreto no vacío
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }), // dataId (puede faltar/vacío)
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }), // requestId
        tsArb, // ts
        (secret, dataId, requestId, ts) => {
          const adapter = createMercadoPagoAdapter({
            config: { ...BASE_CONFIG, mpWebhookSecret: secret },
          });
          const manifest = buildManifest(dataId, requestId, ts);
          const v1 = hmacHex(secret, manifest);
          const signatureHeader = `ts=${ts},v1=${v1}`;

          const valid = adapter.validateSignature({ signatureHeader, requestId, dataId });
          expect(valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: production-deployment-certification, Property 6
  it('una firma calculada con un secreto distinto valida false', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        tsArb,
        (configSecret, otherSecret, dataId, requestId, ts) => {
          // Se requieren secretos distintos para que la firma no coincida.
          fc.pre(configSecret !== otherSecret);
          const adapter = createMercadoPagoAdapter({
            config: { ...BASE_CONFIG, mpWebhookSecret: configSecret },
          });
          const manifest = buildManifest(dataId, requestId, ts);
          const v1 = hmacHex(otherSecret, manifest);
          const signatureHeader = `ts=${ts},v1=${v1}`;

          const valid = adapter.validateSignature({ signatureHeader, requestId, dataId });
          expect(valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: production-deployment-certification, Property 6
  it('una firma v1 alterada valida false', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        tsArb,
        (secret, dataId, requestId, ts) => {
          const adapter = createMercadoPagoAdapter({
            config: { ...BASE_CONFIG, mpWebhookSecret: secret },
          });
          const manifest = buildManifest(dataId, requestId, ts);
          const v1 = hmacHex(secret, manifest);
          // Se altera el primer carácter hex del v1 correcto, preservando la longitud.
          const firstChar = v1[0];
          const replacement = firstChar === 'a' ? 'b' : 'a';
          const alteredV1 = `${replacement}${v1.slice(1)}`;
          const signatureHeader = `ts=${ts},v1=${alteredV1}`;

          const valid = adapter.validateSignature({ signatureHeader, requestId, dataId });
          expect(valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: production-deployment-certification, Property 6
  it('una firma ausente (signatureHeader undefined) valida false', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        (secret, dataId, requestId) => {
          const adapter = createMercadoPagoAdapter({
            config: { ...BASE_CONFIG, mpWebhookSecret: secret },
          });
          const valid = adapter.validateSignature({
            signatureHeader: undefined,
            requestId,
            dataId,
          });
          expect(valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: production-deployment-certification, Property 6
  it('con el secreto configurado vacío, aun con firma "correcta", valida false', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }), // secreto usado para firmar (no el configurado)
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        tsArb,
        (signingSecret, dataId, requestId, ts) => {
          const adapter = createMercadoPagoAdapter({
            config: { ...BASE_CONFIG, mpWebhookSecret: '' },
          });
          const manifest = buildManifest(dataId, requestId, ts);
          const v1 = hmacHex(signingSecret, manifest);
          const signatureHeader = `ts=${ts},v1=${v1}`;

          const valid = adapter.validateSignature({ signatureHeader, requestId, dataId });
          expect(valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: production-deployment-certification, Property 7
// P7: La Preference incluye los campos de certificación
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6
// ---------------------------------------------------------------------------
describe('Property 7 — campos de certificación en el PreferenceRequest', () => {
  const PUBLIC_BACK_URLS = {
    success: 'https://tienda.example.com/checkout/success',
    failure: 'https://tienda.example.com/checkout/failure',
    pending: 'https://tienda.example.com/checkout/pending',
  };
  const NOTIFICATION_URL = 'https://api.example.com/api/webhooks/mercadopago';

  // Feature: production-deployment-certification, Property 7
  it('para cualquier Order con >=1 ítem incluye external_reference=Order.id, description/picture_url por ítem, statement_descriptor, payment_methods (installments<=6, marca excluida) y payer.email cuando hay email', () => {
    // Generador de una Order válida con al menos un ítem (cantidad/precio variados).
    const orderArb = fc
      .record({
        id: fc.string({ minLength: 1, maxLength: 30 }),
        items: fc.array(
          fc.record({
            quantity: fc.integer({ min: 1, max: 99 }),
            unitPrice: fc.integer({ min: 1, max: 999_999 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
      })
      .map(({ id, items }): Order => {
        const cartItems = items.map((it) => ({
          productId: PRODUCT.id,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          subtotal: it.unitPrice * it.quantity,
        }));
        const total = cartItems.reduce((acc, it) => acc + it.subtotal, 0);
        const now = '2024-01-01T00:00:00.000Z';
        return {
          id,
          cartSnapshot: { items: cartItems, total, currency: 'CLP' },
          amount: total,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        };
      });

    fc.assert(
      fc.property(
        orderArb,
        // Email configurado (no vacío) o ausente (undefined) para cubrir ambos caminos.
        fc.option(fc.emailAddress(), { nil: undefined }),
        (order, payerEmail) => {
          const req = buildPreferenceRequest(order, {
            backUrls: PUBLIC_BACK_URLS,
            notificationUrl: NOTIFICATION_URL,
            ...(payerEmail !== undefined ? { payerEmail } : {}),
          });

          // 8.1 — external_reference === Order.id
          expect(req.external_reference).toBe(order.id);

          // 8.6 — cada ítem tiene description y picture_url (no vacíos)
          expect(req.items.length).toBe(order.cartSnapshot.items.length);
          for (const item of req.items) {
            expect(typeof item.description).toBe('string');
            expect(item.description).not.toBe('');
            expect(typeof item.picture_url).toBe('string');
            expect(item.picture_url).not.toBe('');
          }

          // 8.3 — statement_descriptor presente
          expect(typeof req.statement_descriptor).toBe('string');
          expect(req.statement_descriptor).not.toBe('');

          // 8.4 — payment_methods con installments <= 6 y marca excluida definida
          expect(req.payment_methods).toBeDefined();
          expect(req.payment_methods!.installments).toBeLessThanOrEqual(6);
          expect(Array.isArray(req.payment_methods!.excluded_payment_methods)).toBe(true);
          expect(req.payment_methods!.excluded_payment_methods!.length).toBeGreaterThan(0);
          for (const excluded of req.payment_methods!.excluded_payment_methods!) {
            expect(typeof excluded.id).toBe('string');
            expect(excluded.id).not.toBe('');
          }

          // 8.2 — payer.email presente sii hay un email configurado (no vacío)
          if (payerEmail !== undefined && payerEmail !== '') {
            expect(req.payer?.email).toBe(payerEmail);
          } else {
            expect(req.payer).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
