import { describe, it, expect } from 'vitest';
import {
  createMercadoPagoAdapter,
  buildPreferenceRequest,
  type BackUrls,
  type PaymentClientLike,
  type PreferenceClientLike,
  type SdkFactory,
} from './mercadopago.js';
import type { AppConfig } from '../config.js';
import type { Order } from '../models/index.js';

/**
 * Pruebas del adaptador de MercadoPago — `getPayment` y `createPreference`.
 *
 * Se inyecta una `sdkFactory` que devuelve dobles de `payment.get` / `preference.create`,
 * de modo que no se realiza ninguna llamada real a MercadoPago. Se verifica que `getPayment`
 * extrae los campos de diagnóstico `liveMode`/`collectorId`, y que `createPreference` expone
 * SIEMPRE el `init_point` productivo (nunca el `sandbox_init_point`).
 */

/** Config mínima de prueba (sin secretos reales; no se toca la red). */
const TEST_CONFIG: AppConfig = {
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
 * Construye una `sdkFactory` de prueba parametrizable. Permite definir el payload que
 * resuelve `payment.get` y/o el que resuelve `preference.create`. Si no se define alguno,
 * ese cliente lanza (para detectar usos indebidos en pruebas que no lo esperan).
 */
function stubSdkFactoryFull(payloads: {
  paymentPayload?: unknown;
  preferencePayload?: unknown;
}): SdkFactory {
  const payment: PaymentClientLike = {
    get: async () => {
      if (!('paymentPayload' in payloads)) {
        throw new Error('payment.get no se usa en estas pruebas');
      }
      return payloads.paymentPayload;
    },
  };
  const preference: PreferenceClientLike = {
    create: async () => {
      if (!('preferencePayload' in payloads)) {
        throw new Error('preference.create no se usa en estas pruebas');
      }
      return payloads.preferencePayload;
    },
  };
  return () => ({ preference, payment });
}

/**
 * Construye una `sdkFactory` de prueba cuyo `payment.get` resuelve al payload indicado.
 * El `preference.create` no se usa en estas pruebas. Se mantiene por compatibilidad con
 * las pruebas de `getPayment`.
 */
function stubSdkFactory(paymentPayload: unknown): SdkFactory {
  return stubSdkFactoryFull({ paymentPayload });
}

/** Order de prueba mínima para construir una Preference (no toca la red). */
const TEST_ORDER: Order = {
  id: 'order-abc',
  cartSnapshot: {
    items: [{ productId: '0001', quantity: 1, unitPrice: 1000, subtotal: 1000 }],
    total: 1000,
    currency: 'CLP',
  },
  amount: 1000,
  status: 'pending',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('getPayment — liveMode / collectorId', () => {
  it('extrae liveMode=true y collectorId (number → string) del payload', async () => {
    const adapter = createMercadoPagoAdapter({
      config: TEST_CONFIG,
      sdkFactory: stubSdkFactory({
        id: 1234567890,
        status: 'approved',
        external_reference: 'order-abc',
        live_mode: true,
        collector_id: 3724261590,
      }),
    });

    const result = await adapter.getPayment('1234567890');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('1234567890');
    expect(result.value.status).toBe('approved');
    expect(result.value.externalReference).toBe('order-abc');
    expect(result.value.liveMode).toBe(true);
    expect(result.value.collectorId).toBe('3724261590');
  });

  it('acepta collector_id como string no vacío y liveMode=false', async () => {
    const adapter = createMercadoPagoAdapter({
      config: TEST_CONFIG,
      sdkFactory: stubSdkFactory({
        id: '999',
        status: 'pending',
        live_mode: false,
        collector_id: '3724261590',
      }),
    });

    const result = await adapter.getPayment('999');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.liveMode).toBe(false);
    expect(result.value.collectorId).toBe('3724261590');
  });

  it('omite liveMode y collectorId cuando no vienen o son inválidos', async () => {
    const adapter = createMercadoPagoAdapter({
      config: TEST_CONFIG,
      sdkFactory: stubSdkFactory({
        id: '555',
        status: 'approved',
        // live_mode ausente; collector_id como string vacío → se omite
        collector_id: '',
      }),
    });

    const result = await adapter.getPayment('555');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.liveMode).toBeUndefined();
    expect(result.value.collectorId).toBeUndefined();
  });
});

describe('createPreference — init_point productivo (esquema APP_USR-)', () => {
  const PROD_INIT_POINT =
    'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=PROD';
  const SANDBOX_INIT_POINT =
    'https://sandbox.mercadopago.cl/checkout/v1/redirect?pref_id=SANDBOX';

  it('con back_urls locales expone el init_point productivo (NO el sandbox) y conserva sandbox_init_point para trazabilidad', async () => {
    const adapter = createMercadoPagoAdapter({
      config: TEST_CONFIG, // frontendOrigin http://localhost:4200 → back_urls locales
      sdkFactory: stubSdkFactoryFull({
        preferencePayload: {
          id: 'PREF-123',
          init_point: PROD_INIT_POINT,
          sandbox_init_point: SANDBOX_INIT_POINT,
        },
      }),
    });

    const result = await adapter.createPreference(TEST_ORDER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('PREF-123');
    // El init_point expuesto es SIEMPRE el productivo, aun con back_urls locales.
    expect(result.value.init_point).toBe(PROD_INIT_POINT);
    // El sandbox_init_point se conserva solo para trazabilidad.
    expect(result.value.sandbox_init_point).toBe(SANDBOX_INIT_POINT);
  });

  it('sin sandbox_init_point en el payload: init_point productivo y sandbox_init_point ausente', async () => {
    const adapter = createMercadoPagoAdapter({
      config: TEST_CONFIG,
      sdkFactory: stubSdkFactoryFull({
        preferencePayload: {
          id: 'PREF-456',
          init_point: PROD_INIT_POINT,
          // sin sandbox_init_point
        },
      }),
    });

    const result = await adapter.createPreference(TEST_ORDER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('PREF-456');
    expect(result.value.init_point).toBe(PROD_INIT_POINT);
    expect(result.value.sandbox_init_point).toBeUndefined();
  });

  it('expone el payload crudo (raw) además del init_point productivo', async () => {
    const payload = {
      id: 'PREF-789',
      init_point: PROD_INIT_POINT,
      sandbox_init_point: SANDBOX_INIT_POINT,
    };
    const adapter = createMercadoPagoAdapter({
      config: TEST_CONFIG,
      sdkFactory: stubSdkFactoryFull({ preferencePayload: payload }),
    });

    const result = await adapter.createPreference(TEST_ORDER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sigue devolviendo el init_point productivo.
    expect(result.value.init_point).toBe(PROD_INIT_POINT);
    // Ahora también incluye el payload crudo para diagnóstico/log.
    expect(result.value.raw).toEqual(payload);
  });
});

describe('buildPreferenceRequest — payer.email (checklist de homologación)', () => {
  const LOCAL_BACK_URLS: BackUrls = {
    success: 'http://localhost:4200/checkout/success',
    failure: 'http://localhost:4200/checkout/failure',
    pending: 'http://localhost:4200/checkout/pending',
  };
  const NOTIFICATION_URL = 'https://api.example.com/api/webhooks/mercadopago';

  it('incluye payer.email cuando se pasa payerEmail configurado', () => {
    const req = buildPreferenceRequest(TEST_ORDER, {
      backUrls: LOCAL_BACK_URLS,
      notificationUrl: NOTIFICATION_URL,
      payerEmail: TEST_CONFIG.mpPayerEmail,
    });

    expect(req.payer?.email).toBe('test_user_3856418533893132774@testuser.com');
  });

  it('omite payer cuando no se pasa payerEmail (comportamiento previo)', () => {
    const req = buildPreferenceRequest(TEST_ORDER, {
      backUrls: LOCAL_BACK_URLS,
      notificationUrl: NOTIFICATION_URL,
    });

    expect(req.payer).toBeUndefined();
  });

  it('createPreference incluye payer.email tomado de la config en el body enviado al SDK', async () => {
    let capturedBody: unknown;
    const preference: PreferenceClientLike = {
      create: async (args) => {
        capturedBody = args.body;
        return { id: 'PREF-PAYER', init_point: 'https://www.mercadopago.cl/checkout' };
      },
    };
    const payment: PaymentClientLike = {
      get: async () => {
        throw new Error('payment.get no se usa en esta prueba');
      },
    };
    const adapter = createMercadoPagoAdapter({
      config: TEST_CONFIG,
      sdkFactory: () => ({ preference, payment }),
    });

    const result = await adapter.createPreference(TEST_ORDER);

    expect(result.ok).toBe(true);
    const body = capturedBody as { payer?: { email?: string } };
    expect(body.payer?.email).toBe('test_user_3856418533893132774@testuser.com');
  });
});
