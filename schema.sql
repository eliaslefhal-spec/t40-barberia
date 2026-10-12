-- Tabla de reservas de T40 (Cloudflare D1). Se ejecuta UNA vez en la consola de D1.
CREATE TABLE IF NOT EXISTS reservas (
  id        TEXT PRIMARY KEY,
  ref       TEXT NOT NULL,
  fecha     TEXT NOT NULL,            -- AAAA-MM-DD
  inicio    INTEGER NOT NULL,         -- minutos desde las 00:00 (600 = 10:00)
  fin       INTEGER NOT NULL,
  servicio  TEXT NOT NULL,
  duracion  INTEGER NOT NULL,         -- minutos
  nombre    TEXT NOT NULL,
  telefono  TEXT NOT NULL,
  notas     TEXT,
  estado    TEXT NOT NULL DEFAULT 'confirmada',   -- confirmada | cancelada
  creada    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas (fecha, estado);
CREATE INDEX IF NOT EXISTS idx_reservas_tel   ON reservas (telefono, estado, fecha);
