-- Casa Campo Las Maravillas · esquema inicial de reservas (Cloudflare D1 / SQLite)
-- Fechas en formato AAAA-MM-DD. Horas en ISO 8601 UTC.

-- Una reserva o bloqueo temporal.
CREATE TABLE reservas (
  id              TEXT PRIMARY KEY,              -- identificador aleatorio, imposible de adivinar
  creada          TEXT NOT NULL,
  actualizada     TEXT NOT NULL,
  estado          TEXT NOT NULL CHECK (estado IN (
                    'bloqueo',          -- fechas retenidas temporalmente (todavía sin pago)
                    'pendiente_pago',   -- orden de pago creada, esperando a Mercado Pago
                    'pago_en_proceso',  -- Mercado Pago informó un pago pendiente o en revisión
                    'pago_verificado',  -- pago acreditado y verificado; espera confirmación de los dueños
                    'confirmada',       -- confirmada por los dueños
                    'vencida',          -- el bloqueo venció sin pago
                    'cancelada',
                    'conflicto'         -- pago recibido pero las fechas ya no estaban libres (revisión manual)
                  )),
  ingreso         TEXT NOT NULL,
  salida          TEXT NOT NULL,
  noches          INTEGER NOT NULL CHECK (noches >= 1),
  adultos         INTEGER NOT NULL CHECK (adultos >= 1),
  menores         INTEGER NOT NULL DEFAULT 0 CHECK (menores >= 0),
  huespedes       INTEGER NOT NULL,
  precio_noche    INTEGER NOT NULL,              -- pesos, sin decimales
  total           INTEGER NOT NULL,
  sena            INTEGER NOT NULL,
  saldo           INTEGER NOT NULL,
  pagado          INTEGER NOT NULL DEFAULT 0,    -- importe efectivamente acreditado y verificado
  moneda          TEXT NOT NULL DEFAULT 'ARS',
  nombre          TEXT NOT NULL,
  telefono        TEXT NOT NULL,
  email           TEXT,
  observaciones   TEXT,
  vence_en        TEXT,                          -- hasta cuándo se retienen las fechas sin pago
  mp_order_id     TEXT,
  origen          TEXT NOT NULL DEFAULT 'web',
  CHECK (salida > ingreso)
);
CREATE INDEX idx_reservas_estado_vence ON reservas (estado, vence_en);

-- PROTECCIÓN CONTRA RESERVAS SIMULTÁNEAS:
-- cada noche ocupada es una fila y la fecha es la clave primaria.
-- Si dos solicitudes intentan tomar la misma noche, la base de datos rechaza la segunda.
-- La noche de salida no se guarda, así el día de salida queda libre para un nuevo ingreso.
CREATE TABLE noches (
  fecha       TEXT PRIMARY KEY,
  reserva_id  TEXT NOT NULL REFERENCES reservas (id)
);
CREATE INDEX idx_noches_reserva ON noches (reserva_id);

-- Pagos informados por Mercado Pago (uno por id de pago/orden: avisos repetidos no duplican).
CREATE TABLE pagos (
  id              TEXT PRIMARY KEY,
  reserva_id      TEXT NOT NULL REFERENCES reservas (id),
  monto           INTEGER NOT NULL,
  estado          TEXT NOT NULL,
  estado_detalle  TEXT,
  medio           TEXT,
  modo_prueba     INTEGER NOT NULL DEFAULT 1,
  recibido        TEXT NOT NULL
);

-- Claves de idempotencia: la misma solicitud repetida devuelve la misma reserva.
CREATE TABLE idempotencia (
  clave       TEXT PRIMARY KEY,
  reserva_id  TEXT NOT NULL,
  creada      TEXT NOT NULL
);

-- Historial de cambios (auditoría).
CREATE TABLE eventos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id  TEXT,
  fecha       TEXT NOT NULL,
  tipo        TEXT NOT NULL,
  detalle     TEXT
);
CREATE INDEX idx_eventos_reserva ON eventos (reserva_id);
