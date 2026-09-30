/**
 * Result<T, E> — unión discriminada que representa un retorno explícito de éxito o error.
 *
 * Se usa en los servicios de dominio para evitar lanzar excepciones en flujos de negocio
 * esperados (carrito no encontrado, cantidad inválida, carrito vacío, etc.).
 *
 * Referencia de diseño: design.md → Data Models / Components and Interfaces.
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Helper para construir un resultado exitoso. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Helper para construir un resultado de error. */
export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
