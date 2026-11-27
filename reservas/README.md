# Servidor de reservas (Cloudflare Workers + D1)

**Etapa 1 · solo desarrollo local.** Todavía no hay nada creado en Cloudflare.

- `src/index.js`: el servidor (cotiza, crea bloqueos temporales, vence bloqueos).
- `migrations/0001_inicial.sql`: tablas `reservas`, `noches` (una fila por noche: impide reservas superpuestas o simultáneas), `pagos`, `idempotencia`, `eventos`.
- `wrangler.toml`: configuración. Pagos online y confirmación automática **apagados** (`PAGOS_HABILITADOS = "false"`, `CONFIRMACION_AUTOMATICA = "false"`, `MP_MODO = "prueba"`).
- `pruebas/pruebas.mjs`: pruebas (simultaneidad, superposición, idempotencia, validaciones, CORS).

## Probar en la compu (Windows / PowerShell)

La carpeta del proyecto tiene una ruta larga, así que la base local se guarda en `%USERPROFILE%\.cc-reservas-local`.
Usar `npx.cmd` (PowerShell bloquea `npx.ps1`).

```powershell
npm install
npx.cmd wrangler d1 migrations apply reservas --local --persist-to $env:USERPROFILE\.cc-reservas-local
npx.cmd wrangler dev --local --test-scheduled --port 8787 --persist-to $env:USERPROFILE\.cc-reservas-local
# en otra terminal:
node pruebas/pruebas.mjs
```

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/salud` | Estado y modo (pagos apagados) |
| POST | `/api/cotizar` | `{ingreso, salida, adultos, menores}` → precio, seña, saldo y disponibilidad (nunca "garantizada" en esta etapa) |
| POST | `/api/bloqueos` | Igual + `{nombre, telefono, email, observaciones, acepto: true}` y encabezado `Idempotency-Key`. Retiene las fechas `BLOQUEO_MINUTOS` |
| GET | `/api/reservas/{id}` | Estado de una reserva, sin datos personales |

Nunca se guardan claves en este repositorio: los secretos (Mercado Pago, etc.) se cargan con `npx.cmd wrangler secret put NOMBRE`, y quedan cifrados en Cloudflare.
