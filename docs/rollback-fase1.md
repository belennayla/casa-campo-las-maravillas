# Vuelta atrás (rollback) · despliegue de la Fase 1 (28/11/2026)

Puntos de recuperación tomados **antes** de modificar nada:

| Componente | Punto de recuperación |
|---|---|
| Base D1 `reservas` | Time Travel bookmark `0000006a-00000000-00005131-1f36288e2bb26b5672e99e67eee1186e` |
| Base D1 (copia completa) | `%USERPROFILE%\CasaCampo-respaldos\reservas-antes-fase1-20261128-0027.sql` |
| Worker público `reservas-casacampo` | versión `c4b942eb-8eba-4f4b-9f8d-e9cd7440a5dd` |
| Worker del panel `panel-casacampo` | versión `8ea4f9bb-5aa5-4dd7-a7e9-7579c36115bd` |
| Web (GitHub Pages) | commit `fafd731` |

## Cómo volver atrás

Los comandos se corren desde la carpeta `reservas/`.

1. **Workers:** se puede volver solo uno o los dos. Es inmediato y no toca la base.
   ```
   npx.cmd wrangler rollback c4b942eb-8eba-4f4b-9f8d-e9cd7440a5dd
   npx.cmd wrangler rollback 8ea4f9bb-5aa5-4dd7-a7e9-7579c36115bd -c wrangler.panel.toml
   ```
2. **Web:**
   ```
   git revert --no-edit <commits de la Fase 1>
   git push
   ```
   GitHub Actions vuelve a publicar la versión anterior.
3. **Base D1:**
   - La migración 0004 **solo agrega columnas e índices**, y la versión anterior del código las ignora. Normalmente **no hace falta** restaurar la base.
   - Si hiciera falta, la base vuelve al estado exacto previo:
     ```
     npx.cmd wrangler d1 time-travel restore reservas --bookmark=0000006a-00000000-00005131-1f36288e2bb26b5672e99e67eee1186e
     ```
   - Restaurar borra lo escrito después de ese momento.
   - Alternativa: importar la copia `.sql` en una base nueva.

## Interruptores de seguridad (deben quedar así hasta autorización)

| Interruptor | Valor |
|---|---|
| `MODO_RESERVA` | `whatsapp` |
| `PROVEEDOR_DISPONIBILIDAD` | `ical` |
| `SOLICITUDES_HABILITADAS` | `false` |
| `PAGOS_HABILITADOS` | `false` |
| `MP_MODO` | `prueba` |
| `CONFIRMACION_AUTOMATICA` | `false` |
| `CONFIRMACION_AUTOMATICA_PRUEBAS` | `false` |
| `SMOOBU_BLOQUEO_VERIFICADO` | `false` (sin credenciales de Smoobu) |
| `casa.json` | `solicitudes_en_linea: false`, sin `modo_reserva` |
