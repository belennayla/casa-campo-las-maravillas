# Sistema de reservas directas AUTOMÁTICO · Casa Campo Las Maravillas

Plan integral, versión 2 (noviembre 2026). Objetivo: que el huésped **reserve y pague la seña de punta a punta
sin intervención de los dueños**. Los dueños intervienen solo ante excepciones: conflictos, pagos problemáticos y devoluciones.
La aprobación manual queda como alternativa temporal y como mecanismo de excepción.
Este documento no se publica en la web.

---

## 1. El problema de fondo: la demora de los calendarios

- Hoy Booking y Airbnb se sincronizan con nosotros por **iCal**: cada plataforma *lee* nuestro calendario cada tanto.
- No hay un intervalo oficial. Las fuentes del sector hablan de **1 a 6 horas**, y a veces más, y ese plazo no se puede configurar.
- Si alguien reserva en nuestra web, durante esas horas la misma fecha **sigue abierta en Booking y Airbnb**.
- Ninguna de las dos plataformas da su API a anfitriones individuales:
  - **Airbnb** solo trabaja con socios de software aprobados y no acepta nuevos.
  - **Booking.com** solo con proveedores certificados, y por ahora pausó las altas nuevas.
- La única forma de lograr una sincronización **casi inmediata** es un **channel manager**: un software ya conectado por API a las dos plataformas.

## 2. Opciones técnicas

| | **A. Sin servicios nuevos (iCal)** | **B. Channel manager con API + nuestra web** *(recomendada)* | **C. Sistema completo de terceros** | **D. Channel manager argentino** |
|---|---|---|---|---|
| Qué es | Nuestro sistema actual con reserva instantánea | Smoobu o Beds24 conectados por API a Booking y Airbnb. Nuestra web y nuestro servidor consultan su disponibilidad y le crean las reservas. | Usar el motor de reservas y la web de Lodgify, Smoobu, etc. | Interwa, Develop Argentina, etc. |
| Demora con Booking/Airbnb | 1 a 6 h (o más) | Segundos a pocos minutos | Segundos a pocos minutos | Depende del proveedor |
| Costo mensual aprox. | **$0** | **Smoobu ≈ €35** (API y avisos automáticos incluidos) · **Beds24 ≈ €16** de base más cargos por conexión | €17 a €55 | Interwa ≈ $8.230 + IVA por canal más alta de $80.000; Develop ≈ USD 119 |
| Mercado Pago | Sí (ya está hecho) | Sí (lo cobra nuestro servidor) | En general no es nativo (Stripe o PayPal) | Algunos lo traen |
| Diseño propio de la web | Se mantiene | Se mantiene | Se pierde o se limita | Depende |
| Riesgo de doble reserva | **Real** en la ventana de horas | **Mínimo** (ventana de segundos o minutos) | Mínimo | A verificar |
| Automatización | Alta, pero con conflictos ocasionales que hay que resolver | **Completa**, con excepciones raras | Completa | A verificar |

Precios tomados de páginas oficiales y reseñas de 2026: **hay que confirmarlos con cada proveedor**.
Smoobu tiene 14 días de prueba gratis. Smoobu figura como socio *Premier Plus* de Booking y socio preferido de Airbnb.

### Smoobu frente a Beds24 (para una sola casa)

- **Smoobu (≈ €35/mes)**:
  - simple, en español;
  - incluye API completa, avisos automáticos (webhooks) de reservas nuevas, cambios y disponibilidad, y mensajes automáticos al huésped;
  - es el mejor equilibrio para dueños que no quieren operar software.
- **Beds24 (≈ €16/mes más conexiones)**:
  - más barato y muy flexible, pero más técnico;
  - los avisos automáticos de reservas se habilitan pidiéndolos a soporte.

## 3. Recorrido automático propuesto

1. **Fechas y huéspedes.** El servidor verifica la disponibilidad en vivo:
   - nuestra base;
   - el channel manager (opción B), o Booking y Airbnb en vivo (opción A).
2. **Cotización:** noches × tarifa, total, **seña 50 %**, saldo 50 %.
3. **Datos del huésped:** nombre, teléfono, correo (obligatorio para el comprobante). Condiciones y Turnstile.
4. **«Reservar y pagar la seña».** En ese instante:
   - el servidor **retiene las noches** en una sola operación (es imposible que dos personas retengan la misma fecha);
   - en la opción B, crea además un **bloqueo en el channel manager**, que cierra Booking y Airbnb en minutos.
   - La retención dura **20 a 30 minutos**, lo mismo que vence la orden de Mercado Pago. Las **48 horas** quedan solo para la transferencia.
5. **Pago en Mercado Pago** (Checkout Pro): tarjeta de débito, crédito, dinero en cuenta o cuotas.
6. **Verificación automática.** Mercado Pago avisa al servidor con un mensaje firmado; el servidor **vuelve a consultar la orden** y controla:
   - el pago está **acreditado**;
   - el **monto es exactamente la seña** y la moneda es ARS;
   - la referencia es la de esta reserva;
   - la retención sigue siendo suya;
   - un último chequeo de disponibilidad sale limpio.
7. **Confirmación automática.** Si todo se cumple:
   - la reserva pasa a **Confirmada**;
   - en la opción B, el bloqueo del channel manager pasa a reserva confirmada;
   - las fechas quedan en el calendario exportado.
8. **Comprobante al huésped, sin intervención:**
   - página privada de la reserva (`reserva.html#…`) con número, fechas, montos pagados, saldo, dirección y horarios, imprimible;
   - el recibo de Mercado Pago que la plataforma envía sola;
   - correo propio: con un proveedor de correo transaccional con plan gratuito, o con los mensajes automáticos del channel manager.
9. **Aviso por Telegram** a los dueños («Nueva reserva confirmada»), solo informativo.
10. **Si el pago falla o vence:** las noches se liberan solas y, en la opción B, se cancela el bloqueo del channel manager. El huésped puede reintentar.

### Excepciones (las únicas que requieren a los dueños)

| Caso | Qué hace el sistema |
|---|---|
| Pago acreditado **después** de vencer la retención y la fecha ya se ocupó | Estado *Conflicto*, aviso urgente por Telegram, devolución del 100 % (registrada; se ejecuta con un clic o automática si se decide). |
| Reserva simultánea en otra plataforma dentro de la ventana de sincronización | Igual que el caso anterior. Con la opción B es muy improbable. |
| Pago en revisión o pendiente en Mercado Pago | Se mantiene la retención hasta el límite y se avisa si no se resuelve. |
| Contracargo o devolución iniciada por el huésped | Aviso y revisión manual. |

## 4. Transferencia bancaria (alternativa)

- **Mercado Pago Checkout Pro en Argentina no acepta transferencia** como medio de pago (solo tarjetas, dinero en cuenta y cuotas).
- Para una transferencia al alias **no hay una forma pública y confiable de detectar la acreditación automáticamente**: requiere que un dueño la verifique.
- **Flujo propuesto**:
  1. el huésped elige «Pagar por transferencia» y las noches se retienen **48 horas**;
  2. sube o envía el comprobante;
  3. un dueño toca **«Seña acreditada»** en el panel;
  4. desde ahí, la confirmación, el comprobante y los avisos son automáticos.
- Es el único paso manual, y solo para quien elija transferir.

## 5. Qué se puede automatizar sin contratar nada (opción A)

- **Todo el recorrido, la retención, el cobro y la confirmación** son automáticos.
- **Lo que no se puede evitar sin un channel manager** es la ventana de horas en la que Booking y Airbnb siguen abiertos después de una reserva en nuestra web.
- **Mitigaciones**:
  - consulta en vivo a Booking y Airbnb al retener y otra vez antes de confirmar;
  - aviso por Telegram para cerrar las fechas en las plataformas (opcional);
  - condición de devolución del 100 % si no se puede cumplir.
- **Riesgo residual**: bajo con poca demanda, mayor en temporada alta.
  - Si el conflicto ocurre, conviene cancelar la reserva directa (con devolución) y no la de la plataforma: Airbnb y Booking **penalizan** las cancelaciones del anfitrión.

## 6. Recomendación

**Opción B con Smoobu**, en dos fases y sobre lo que ya construimos.

- **Fase 1 (ahora, sin costo):**
  - construir el recorrido automático completo (reserva instantánea, Mercado Pago, confirmación automática segura, comprobante, excepciones, panel);
  - diseñarlo con un **«proveedor de disponibilidad» intercambiable**: hoy iCal más consulta en vivo, mañana el channel manager;
  - probarlo de punta a punta con Mercado Pago de **prueba**;
  - la confirmación automática queda apagada en producción.
- **Fase 2 (con Smoobu):**
  1. los dueños abren la prueba gratuita y conectan Booking y Airbnb por API (reemplaza los links iCal en las plataformas);
  2. conecto nuestro servidor a la API y a los avisos automáticos de Smoobu;
  3. prueba completa;
  4. con su autorización: pagos reales y confirmación automática.
- **Mientras tanto** se puede publicar con la **aprobación manual** como modo temporal, o con la opción A si aceptan el riesgo residual.

**Modos del sistema** (un solo interruptor, `MODO_RESERVA`):

| Modo | Uso |
|---|---|
| `solicitud` | Aprobación manual (actual). Alternativa temporal y de excepción. |
| `instantanea_ical` | Automático con riesgo residual (opción A). |
| `instantanea_cm` | Automático con channel manager (meta final). |

## 7. Componentes de desarrollo (Fase 1)

| Componente | Contenido |
|---|---|
| **A** | Proveedor de disponibilidad unificado (base propia + iCal en vivo; preparado para la API del channel manager) |
| **B** | Recorrido de la web: fechas → cotización → datos → «Reservar y pagar la seña» → Mercado Pago → página de reserva. Transferencia como alternativa. Mismo diseño, celular primero. |
| **C** | Confirmación automática segura (con todas las condiciones), comprobante, aviso al huésped (página propia; correo y WhatsApp preparados), Telegram |
| **D** | Excepciones: conflictos, pagos tardíos, devoluciones; aprobación manual como modo alternativo |
| **E** | Panel: Reservas · Pagos · Calendario · Excepciones · Solicitudes (modo manual) · Bloqueos (después) |
| **F** | Pruebas automáticas, en local (celular y computadora) y en producción con `#prueba` y Mercado Pago de prueba |
| **G** (fase 2) | Conexión con Smoobu: disponibilidad, bloqueos, reservas y avisos automáticos |

## 7 bis. Estado de la Fase 1 (desarrollada y probada en local, SIN publicar)

**Construido**
- **Servidor**:
  - `POST /api/reservas`: reserva instantánea con retención atómica, verificación en vivo, retención en el gestor y orden de Mercado Pago que vence 5 min antes que la retención de 30 min. Transferencia con 48 h.
  - Enlace privado del huésped (`/api/mi-reserva`, token derivado y guardado solo como hash).
  - Confirmación automática segura con todas las condiciones.
  - Excepciones con aviso por Telegram.
  - Liberación en el gestor con reintentos.
  - Webhook del gestor (Smoobu) y supervisión para el panel.
- **Proveedores**:
  - `ical`: nunca confirma solo.
  - `smoobu`: API HMAC documentada; confirma solo con `SMOOBU_BLOQUEO_VERIFICADO = true`.
  - `simulado`: las pruebas nunca tocan el gestor real.
- **Web**:
  - recorrido en 3 pasos según el modo (`whatsapp` / `solicitud` / `instantanea`);
  - medio de pago, resumen fijo con «Cambiar», tarifa del grupo destacada;
  - `reserva.html` con estado, pago, transferencia, verificación y comprobante imprimible.
  - Con el modo actual (`whatsapp`), la web pública se comporta igual que hoy.
- **Panel**: Resumen (excepciones, devoluciones, pagos en curso, próximas llegadas) · Reservas (detalle con historial) · Calendario · Solicitudes · Sistema.
- **Pruebas**: 224 automáticas en 8 baterías (5 escenarios de reserva automática), más el recorrido en el navegador (celular y computadora).

**Limitaciones conocidas**
- La documentación de Smoobu no garantiza que una reserva creada por API cierre Booking y Airbnb: requiere la prueba de aceptación de la fase 2.
- Los webhooks de Smoobu no tienen firma documentada: se autentican con un token secreto en la URL.
- Devoluciones: el panel las registra y las marca como realizadas, pero el reintegro se hace a mano en Mercado Pago o en el banco.
- Transferencia: la acreditación la verifica un dueño (un clic). Mercado Pago Checkout Pro no acepta transferencias en Argentina.
- Aviso al huésped: su enlace privado y el recibo de Mercado Pago. El correo y WhatsApp oficial quedan preparados, sin implementar.
- Los textos del modo WhatsApp actual (preferencia de 48 h) siguen como están. Los textos nuevos se muestran solo en los modos `solicitud` e `instantanea` y están pendientes de aprobación.

**Para activar (cada paso con autorización)**
1. Aprobar los textos para el huésped.
2. Publicar sin cambiar el comportamiento:
   - migración `0004` remota;
   - secretos `ACCESO_SECRETO`, `ICAL_URLS` y `AIRBNB_ICAL_URL` en el Worker público;
   - desplegar los dos Workers;
   - subir la web (sigue en modo `whatsapp`).
3. Probar en producción con `#prueba`, Mercado Pago de prueba y `CONFIRMACION_AUTOMATICA_PRUEBAS = true`.
4. Smoobu:
   1. plan con API;
   2. clave HMAC con «Guest Data (PII)»;
   3. id de la casa;
   4. URL de webhook;
   5. conectar Booking y Airbnb por API;
   6. **prueba de aceptación**: crear una retención por API y comprobar, con tiempos, que ambas plataformas cierran las fechas;
   7. recién entonces `SMOOBU_BLOQUEO_VERIFICADO = true`.
5. Mercado Pago real: credenciales de producción. Requiere habilitarlo en el código, porque hoy está trabado en modo prueba.
6. Encender `MODO_RESERVA = instantanea`, `PAGOS_HABILITADOS` y `CONFIRMACION_AUTOMATICA`.

## 7 ter. Antes de activar reservas reales: tres revisiones (28/11/2026)

**A. Abuso de las retenciones de 48 h con transferencia.** Propuesta, a decidir:
1. Transferencia solo si el ingreso es dentro de **7 días o más**. Para fechas cercanas, solo Mercado Pago (30 min).
2. **Una sola retención por transferencia a la vez para toda la casa**, y una por teléfono, correo y dispositivo.
3. Quien deja vencer una retención por transferencia no puede volver a elegir transferencia por 30 días.
4. Ya existe:
   - Turnstile;
   - límite de 5 intentos por minuto;
   - aviso por Telegram al iniciar;
   - cancelación desde el panel;
   - liberación automática al vencer.

**B. Confirmación automática al huésped sin WhatsApp manual.**
- **Hoy:**
  - el huésped vuelve de Mercado Pago a su enlace privado, que se actualiza solo y muestra la confirmación y el comprobante;
  - además, Mercado Pago le envía su recibo de pago.
- **Para enviar un correo propio** hay dos caminos:
  1. Mensajes automáticos de **Smoobu** (fase 2): no requieren dominio propio. Hay que verificar en la prueba de aceptación que se envían para reservas creadas por API.
  2. **Dominio propio** (por ejemplo, .com.ar) más un proveedor de correo transaccional con plan gratuito. Sin dominio propio los correos terminan en spam.
- WhatsApp oficial queda para más adelante (número propio, plantillas, costo por mensaje).

**C. Textos comerciales.** Ver la sección 9 y los textos del formulario en modo automático (`js/app.js`, `TEXTOS_TERMINOS`) y de `reserva.html`. Pendiente de aprobación.
- Conviene verificar con un profesional si aplica el derecho de revocación (art. 34 de la Ley 24.240 y art. 1110 del CCyC) y el «botón de arrepentimiento» (Res. 424/2020) para reservas en línea con fecha determinada.

## 8. Decisiones de los dueños

| Tema | Decisión |
|---|---|
| Retención para **transferencia** (o flujo con aprobación) | 48 horas |
| Retención para **pago con Mercado Pago** | 20 a 30 minutos (a confirmar) |
| Medios de pago | Mercado Pago (automático) y transferencia (verificación manual) |
| Fechas ocupadas después de pagar | Devolución del 100 % |
| Costos del medio de pago | A cargo del huésped. Ojo: la Ley 25.065 (art. 37) limita los recargos por pagar con tarjeta; consultar con el contador. Los intereses de las cuotas en Mercado Pago ya los paga el comprador. |
| Channel manager | **Pendiente** (recomendado: Smoobu, con prueba gratis) |
