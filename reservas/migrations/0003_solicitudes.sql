-- Casa Campo Las Maravillas · Etapa 1 del sistema de solicitudes.
-- Una solicitud NO retiene fechas. La retención empieza recién cuando los dueños aprueban la disponibilidad.

CREATE TABLE solicitudes (
  id              TEXT PRIMARY KEY,                 -- uuid interno
  numero          TEXT NOT NULL UNIQUE,             -- número para el huésped, ej. CC-270615-K7Q2
  creada          TEXT NOT NULL,
  actualizada     TEXT NOT NULL,
  estado          TEXT NOT NULL CHECK (estado IN (
                    'nueva',          -- recibida, esperando revisión de los dueños
                    'aprobada',       -- disponibilidad aprobada: fechas retenidas hasta retencion_vence
                    'rechazada',      -- no disponible u otro motivo
                    'vencida',        -- aprobada pero la retención venció sin avanzar
                    'convertida'      -- pasó a reserva confirmada / pago
                  )),
  ingreso         TEXT NOT NULL,
  salida          TEXT NOT NULL,
  noches          INTEGER NOT NULL,
  adultos         INTEGER NOT NULL,
  menores         INTEGER NOT NULL DEFAULT 0,
  huespedes       INTEGER NOT NULL,
  precio_noche    INTEGER NOT NULL,
  total           INTEGER NOT NULL,
  sena            INTEGER NOT NULL,
  saldo           INTEGER NOT NULL,
  nombre          TEXT NOT NULL,
  telefono        TEXT NOT NULL,
  email           TEXT,
  observaciones   TEXT,
  disponible_al_solicitar INTEGER NOT NULL DEFAULT 1, -- según nuestros datos en el momento de la solicitud
  reserva_id      TEXT REFERENCES reservas (id),    -- reserva/retención creada al aprobar
  retencion_vence TEXT,
  revisada_por    TEXT,
  revisada_en     TEXT,
  motivo          TEXT,
  aviso_enviado   INTEGER NOT NULL DEFAULT 0,       -- 1 = notificación a los dueños enviada
  origen          TEXT NOT NULL DEFAULT 'web',
  CHECK (salida > ingreso)
);
CREATE INDEX idx_solicitudes_estado ON solicitudes (estado, creada);
CREATE INDEX idx_solicitudes_fechas ON solicitudes (ingreso, salida);

ALTER TABLE reservas ADD COLUMN solicitud_id TEXT;
