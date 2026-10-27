# Ejecutar tests en un build de Odoo.sh

## Comando verificado (prueba real en un build staging de cliente)

```bash
odoo-bin -d "$PGDATABASE" -u <modulo> --stop-after-init --no-http \
  --test-enable --test-tags /<modulo> --logfile=/tmp/agent-tests.log --log-level=test
```

Después:

```bash
grep -n 'FAIL:\|ERROR:\|tests.result' /tmp/agent-tests.log | tail -n 50
```

- En la prueba se usó la ruta completa `/opt/odoo.sh/odoosh/bin/odoo-bin`. Si `odoo-bin` no está en el PATH del terminal o de SSH, usar esa ruta.
- `--test-tags /<modulo>` es **imprescindible**: con `--test-enable` solo, se ejecutan los tests de todos los módulos instalados (lento e innecesario).
- `--no-http` es el patrón que usa el propio `odoo-update` de Odoo.sh y evita chocar con el servidor en marcha. No se ha probado sin él: mantenerlo.
- `--logfile` deja la salida en un archivo: necesario cuando se usa el terminal web, porque su texto no se puede leer como texto (ver [editor-jupyterlab.md](editor-jupyterlab.md)).
- Varios módulos: `-u mod_a,mod_b --test-tags /mod_a,/mod_b`.

Referencia oficial (*Odoo.sh → Advanced → Containers*), para un módulo que se instala: `odoo-bin -i <modulo> --test-enable --log-level=test --stop-after-init`.

## Interpretar la salida

- Éxito: `odoo.tests.result: 0 failed, 0 error(s) of N tests` (el formato varía según la versión). Anotar N.
- Fallo: `FAIL:` / `ERROR:` seguido de traceback. Ver el bloque completo con `grep -n -A 30 'FAIL:\|ERROR:' /tmp/agent-tests.log | head -n 120` y guardarlo como evidencia.
- Sin tests ejecutados (0 tests): el módulo no tiene tests o el tag es incorrecto; no cuenta como `pass`.
- Al terminar: `rm /tmp/agent-tests.log`.

## Recordatorio

La documentación oficial avisa de que estas operaciones **no están aisladas**: `-u` actualiza el módulo en la base de datos del build. En staging (copia neutralizada de producción) es aceptable; nunca en producción.
