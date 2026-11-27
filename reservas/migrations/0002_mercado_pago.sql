-- Casa Campo Las Maravillas · Mercado Pago (Checkout Pro vía Orders API), etapa de PRUEBA.

-- Estado de la orden de Mercado Pago asociada a cada reserva.
ALTER TABLE reservas ADD COLUMN mp_checkout_url TEXT;
ALTER TABLE reservas ADD COLUMN mp_estado TEXT;            -- status de la order (created, processed, processing, action_required, failed, canceled, refunded...)
ALTER TABLE reservas ADD COLUMN mp_estado_detalle TEXT;    -- status_detail (accredited, in_process, ...)
ALTER TABLE reservas ADD COLUMN mp_consultada TEXT;        -- última vez que se consultó el estado REAL a Mercado Pago
ALTER TABLE reservas ADD COLUMN revision_manual INTEGER NOT NULL DEFAULT 0; -- 1 = requiere que los dueños revisen

-- Avisos (webhooks) recibidos. Se guardan antes de procesarlos para poder reintentar.
CREATE TABLE avisos_mp (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  recibido    TEXT NOT NULL,
  tipo        TEXT,               -- order / payment
  accion      TEXT,               -- order.processed, payment.created...
  data_id     TEXT,
  request_id  TEXT,
  procesado   INTEGER NOT NULL DEFAULT 0,
  intentos    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  procesado_en TEXT
);
CREATE INDEX idx_avisos_pendientes ON avisos_mp (procesado, intentos);

-- Devoluciones a gestionar (pago acreditado sin fechas disponibles, importe incorrecto, etc.).
-- Nunca se ejecutan automáticamente: los dueños las revisan y las hacen desde Mercado Pago.
CREATE TABLE devoluciones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id   TEXT NOT NULL REFERENCES reservas (id),
  mp_order_id  TEXT NOT NULL,
  mp_pago_id   TEXT,
  monto        INTEGER NOT NULL,
  motivo       TEXT NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'pendiente_revision' CHECK (estado IN ('pendiente_revision', 'realizada', 'descartada')),
  creada       TEXT NOT NULL,
  UNIQUE (mp_order_id, motivo)
);
