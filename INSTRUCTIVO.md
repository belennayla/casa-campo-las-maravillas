# Casa Campo Las Maravillas · Instructivo

Web de reservas directas. Se publica gratis en GitHub Pages y sincroniza sola los calendarios de Airbnb, Booking y Vrbo varias veces por día (GitHub decide el horario exacto; para sincronizar en el momento: pestaña Actions → Run workflow).

## Cómo funciona la sincronización

```
Airbnb ─┐                          ┌─► la web muestra esos días como ocupados
Booking ┼─► GitHub (varias por día)┤
Vrbo  ──┘   + reservas directas    └─► genera un link para cada plataforma
                                       (así las reservas directas y las de las otras
                                        plataformas también se bloquean en cada una)
```

- Una reserva en **Airbnb** bloquea esos días en la web, en Booking y en Vrbo.
- Una **reserva directa** cargada en la web bloquea esos días en Airbnb, Booking y Vrbo.
- Las plataformas leen los calendarios externos cada unas pocas horas (lo decide cada plataforma). Por eso siempre conviene confirmar por WhatsApp antes de cobrar la seña.
- Hoy están conectados **Booking** (secreto `ICAL_URLS`, línea `booking ...`) y **Airbnb** (secreto propio `AIRBNB_ICAL_URL`, solo el link). Vrbo llega a través de Booking. Si una reserva aparece en los dos calendarios (porque Booking re-exporta la de Airbnb), la web la muestra una sola vez y no se la devuelve a su plataforma de origen.

### Archivos generados (no están en el repositorio)

`data/ocupadas-sync.json` y los `calendario*.ics` **se generan en cada publicación** y no se guardan en el repositorio. Por eso, si mirás el repositorio, no los vas a ver: la versión real está en la web publicada, por ejemplo `https://casacampolasmaravillas.github.io/data/ocupadas-sync.json`. Solo contienen fechas y la plataforma de origen, nunca nombres ni datos de huéspedes.

### Cuándo la web muestra "Disponibilidad a confirmar"

La web solo dice "Sincronizado con …" si se cumple todo esto:
- las plataformas de `fuentes_esperadas` (en `data/casa.json`, hoy `["booking", "airbnb"]`) respondieron bien;
- la última sincronización tiene menos de `sync_max_horas` (26 h);
- `calendario_actualizado` es `true` (ustedes confirman que cargaron todas las reservas directas);
- hay al menos una fecha ocupada a futuro (un calendario totalmente vacío se toma como sospechoso).

Si algo falla, aparece un aviso naranja arriba del calendario y en el detalle del precio, que explica qué no se pudo comprobar. Para ver el detalle técnico: pestaña **Actions** de GitHub → la última ejecución → paso "Sincronizar calendarios" (muestra ✓ o ✗ por plataforma).

Para cambiar el link de Airbnb: Settings → Secrets and variables → Actions → `AIRBNB_ICAL_URL` → Update.

## Paso 1 · Copiar el link de cada plataforma (exportar)

| Plataforma | Dónde está |
|---|---|
| **Airbnb** | Calendario → elegí el alojamiento → Disponibilidad → Sincronizar calendarios → **Exportar calendario** → copiar el link |
| **Booking** | Extranet → Tarifas y disponibilidad → **Sincronizar calendarios** → Exportar calendario → copiar el link |
| **Vrbo** | Calendario → Importar/exportar → **Exportar** → copiar el link |

Si Booking pide primero un link para importar, usá el de la web (Paso 3): `calendario-booking.ics`.

## Paso 2 · Cargar esos links en GitHub (privado)

1. En GitHub, entrá al repositorio → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret** → nombre: `ICAL_URLS`
3. En el valor, una línea por plataforma (nombre, espacio, link):

```
airbnb https://www.airbnb.com.ar/calendar/ical/XXXX.ics?s=XXXX
booking https://ical.booking.com/v1/export?t=XXXX
vrbo https://www.vrbo.com/icalendar/XXXX.ics
```

Los links quedan guardados en privado: no aparecen en la web.
Para sincronizar en el momento: pestaña **Actions** → "Sincronizar calendarios y publicar" → **Run workflow**.

## Paso 3 · Pegar en cada plataforma el link de la web (importar)

Cada plataforma tiene su propio link. Incluye las reservas directas y las de las **otras** plataformas:

| Pegar en | Link |
|---|---|
| Airbnb | `https://casacampolasmaravillas.github.io/calendario-airbnb.ics` |
| Booking | `https://casacampolasmaravillas.github.io/calendario-booking.ics` |
| Vrbo | `https://casacampolasmaravillas.github.io/calendario-vrbo.ics` |
| Otra (Google Calendar, etc.) | `https://casacampolasmaravillas.github.io/calendario.ics` |

**Importante:** GitHub pausa la sincronización automática si el repositorio pasa **60 días sin cambios**, y avisa por mail antes. Para reactivarla: pestaña **Actions** → "Sincronizar calendarios y publicar" → **Enable workflow**. Cargar una reserva o cambiar cualquier cosa también reinicia el plazo.

## Cargar una reserva directa o bloquear fechas

En `data/casa.json`, dentro de `"ocupadas"`:

```json
"ocupadas": [
  { "desde": "2027-01-03", "hasta": "2027-01-08", "nota": "Reserva directa" },
  { "desde": "2027-02-01", "hasta": "2027-02-05", "nota": "Uso personal" }
]
```

- `desde` = día de ingreso. `hasta` = día de salida (ese día queda libre para otro ingreso).
- **No escribas nombres, teléfonos ni datos de huéspedes**: este archivo es público.
- También podés pedírselo a Claude: "marcá ocupado del 3 al 8 de enero".
- Cuando estén cargadas todas las reservas vigentes, cambiá `"calendario_actualizado"` a `true` para quitar el aviso "disponibilidad sujeta a confirmación".

## Cambiar precios, textos o fotos

- **Precios, capacidad, estadía mínima, alias, horarios:** `data/casa.json`.
- **Textos y preguntas frecuentes:** `index.html`.
- **Fotos:** están en `img/fotos/`. El orden y las descripciones de la galería están al principio de `js/app.js` (lista `FOTOS`).

## Ver la web en la compu

```
node servidor.js
```

y abrir http://localhost:8080
