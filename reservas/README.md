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

## Mercado Pago (etapa 2 · SOLO PRUEBA)

Checkout Pro vía Orders API. Endpoints nuevos:

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/pagos/orden` | `{reserva_id}` + clave de pruebas. Crea la orden de **seña** (50 %, calculada en el servidor) con `X-Idempotency-Key = orden-{reserva}`; vence junto con el bloqueo; sin efectivo |
| POST | `/api/webhooks/mercadopago` | Valida `x-signature` (HMAC-SHA256 de `id:{data.id};request-id:{x-request-id};ts:{ts};`), responde 200 y procesa con `ctx.waitUntil`: consulta `GET /v1/orders/{id}` y verifica importe, moneda, reserva y estado real |
| GET | `/api/pruebas/reservas/{id}` | Detalle para pruebas (pagos, devoluciones, eventos), solo con la clave de pruebas |

Reglas:
- Pago acreditado y verificado → `pago_verificado` (**nunca** `confirmada`; la confirman los dueños). El huésped ve "Recibimos tu seña… te confirman por WhatsApp".
- Antes de liberar fechas de un bloqueo con orden, se consulta el estado real; si la orden sigue abierta se **cancela** en Mercado Pago y recién después se liberan.
- Pago en proceso → se retienen las fechas renovando de a 30 min mientras Mercado Pago lo siga informando, con tope de 48 h (después, revisión manual).
- Pago tardío → si las fechas siguen libres se vuelven a tomar en una transacción; si no, `conflicto` + devolución pendiente.
- Avisos guardados en `avisos_mp`; la tarea programada reintenta los fallidos y concilia órdenes abiertas cada 5 min.
- Doble traba: `MP_MODO` debe ser `prueba` y la cuenta del token debe tener la etiqueta `test_user`.

Secretos (cargados con `npx.cmd wrangler secret put`): `MP_ACCESS_TOKEN` (de la cuenta **vendedora de prueba**), `MP_WEBHOOK_SECRET`, `CLAVE_PRUEBAS` (temporal).

### Procedimiento de devolución (conflictos)
1. Ver las devoluciones pendientes: `npx.cmd wrangler d1 execute reservas --remote --command "SELECT * FROM devoluciones WHERE estado = 'pendiente_revision'"`.
2. Avisar al huésped por WhatsApp.
3. Devolver desde Mercado Pago (Actividad → el pago → Devolver) o con `POST /v1/orders/{id}/refund` (encabezado `X-Idempotency-Key`; cuerpo vacío = devolución total).
4. Marcar la devolución como `realizada` y la reserva como `cancelada`.

### Probar en local con Mercado Pago simulado
```powershell
node pruebas/mp-simulado.mjs
npx.cmd wrangler dev --local --test-scheduled --port 8787 --persist-to $env:USERPROFILE\.cc-reservas-local --var MP_API_BASE:http://127.0.0.1:8790 --var ORDEN_MIN_SEGUNDOS:3 --var MP_GRACIA_SEG:0
# CLAVE y SECRETO = valores de .dev.vars
node pruebas/pruebas-pagos.mjs
```

Nunca se guardan claves en este repositorio: los secretos (Mercado Pago, etc.) se cargan con `npx.cmd wrangler secret put NOMBRE`, y quedan cifrados en Cloudflare.
