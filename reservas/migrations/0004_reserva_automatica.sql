-- Fase 1 · Reserva automática (reserva instantánea con seña) y proveedor de disponibilidad intercambiable.
-- Solo agrega columnas e índices: no modifica datos existentes.

ALTER TABLE reservas ADD COLUMN numero TEXT;                 -- número para el huésped, ej. CC-270315-K7Q2
ALTER TABLE reservas ADD COLUMN acceso_hash TEXT;            -- SHA-256 del enlace privado del huésped (el enlace nunca se guarda)
ALTER TABLE reservas ADD COLUMN modo TEXT;                   -- 'instantanea' | 'solicitud' | NULL (bloqueos de prueba antiguos)
ALTER TABLE reservas ADD COLUMN medio_pago TEXT;             -- 'mercadopago' | 'transferencia'
ALTER TABLE reservas ADD COLUMN cm_proveedor TEXT;           -- proveedor de disponibilidad usado: 'ical' | 'smoobu' | 'simulado'
ALTER TABLE reservas ADD COLUMN cm_ref TEXT;                 -- id de la reserva provisional en el gestor de canales
ALTER TABLE reservas ADD COLUMN cm_estado TEXT;              -- no_aplica | retenida | confirmada | liberacion_pendiente | liberada | error_retencion
ALTER TABLE reservas ADD COLUMN cm_intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservas ADD COLUMN confirmada_en TEXT;
ALTER TABLE reservas ADD COLUMN confirmada_por TEXT;         -- 'automatica' o el correo del dueño
ALTER TABLE reservas ADD COLUMN excepcion TEXT;              -- motivo por el que necesita a los dueños (NULL = ninguno)
ALTER TABLE reservas ADD COLUMN excepcion_avisada INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_reservas_numero ON reservas (numero);
CREATE UNIQUE INDEX idx_reservas_acceso ON reservas (acceso_hash);
CREATE INDEX idx_reservas_cm ON reservas (cm_estado);
CREATE INDEX idx_reservas_ingreso ON reservas (ingreso);
