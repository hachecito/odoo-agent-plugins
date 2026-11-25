# Diagnóstico con datos del staging (`odoo-bin shell`, solo lectura)

Para entender un fallo con los datos reales del build staging antes de tocar código: leer registros, calcular un campo, contar los casos afectados o, con el OK del usuario, llamar al método que falla y ver su traceback. Sirve para encontrar la causa y escribir un test de regresión que la reproduzca; no sustituye a ese test ni a `remote_tests`.

## Reglas

- Solo en el build **staging** de la tarea (`*.dev.odoo.com`), nunca en producción.
- **Solo lectura.** El script **nunca** hace `commit()`; lo que escriba dentro de la transacción se deshace. Verificado en el código de Odoo 15.0 a 19.0 (`odoo/cli/shell.py`) y en un build de Odoo 18: al terminar el script el shell hace `cr.rollback()` y no queda nada guardado. `diag.js` añade además un `rollback()` explícito.
- **Lo que el rollback no deshace**:
  - métodos que hacen commit por su cuenta (crons, envío de correo con `auto_commit`, colas);
  - **llamadas a servicios externos**: correo, HTTP, EDI, conectores fiscales (por ejemplo SII o las comprobaciones de la AEAT de `l10n-spain`), pasarelas de pago. **[no verificado]** que la neutralización del staging de Odoo.sh las bloquee en módulos OCA o propios.
  
  Por defecto, el diagnóstico solo **lee** (`search`, `read`, campos calculados, `_compute_*`). Llamar a un método de negocio (`action_confirm`, `action_post`, `write` con automatizaciones…) solo con el OK explícito del usuario y tras comprobar que no contacta con nada externo; si no se puede asegurar, reproducir el fallo en un test.
- El guard decodifica el script (va en base64 dentro del comando) y deniega `commit(`, `auto_commit=True` y el SQL de escritura. Un `odoo-bin shell` con el script fuera del comando (`< archivo`, consola interactiva) pide confirmación: no se puede revisar.
- **Datos del cliente**: el staging es una copia neutralizada de producción con datos reales. La salida se usa en la tarea y en el informe local; **nunca** va a la memoria del proyecto (`notes.js`) ni al repo. Imprimir solo lo necesario (ids, recuentos, estados), no nombres, correos ni importes de clientes salvo que hagan falta.
- No escribir nunca en la consola *Odoo shell* que abre el editor: va con transacción abierta.

## 1. Preparar (local)

Escribir el script en un archivo local (por ejemplo `.oap/odoosh-browser/diag/caso.py`) usando `env`, como en el shell:
```python
so = env['sale.order'].browse(1234)
print('estado', so.state, 'lineas', len(so.order_line))
print('importe calculado', so.amount_total, 'impuestos', so.order_line.tax_id.ids)
```
Después:
```bash
node <plugin>/scripts/diag.js prepare .oap/odoosh-browser/diag/caso.py
```
Revisa el script, lo envuelve (los errores del script salen en la salida normal, con `rollback()` al final) e imprime los comandos de una sola línea. No se conecta al build. Máximo unos 6 KB de script: para algo mayor, dividirlo.

## 2a. Ejecutar por SSH

Con la herramienta **Bash** (comillas simples, para que `$PGDATABASE` se expanda en el build y no en local), sustituyendo `<build>`:
```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <build> 'echo <base64> | base64 -d | odoo-bin shell -d "$PGDATABASE" --no-http --log-level=error >/tmp/oap-diag.out 2>/tmp/oap-diag.err; echo EXIT=$?; head -c 20000 /tmp/oap-diag.out; tail -n 3 /tmp/oap-diag.err; rm /tmp/oap-diag.out /tmp/oap-diag.err'
```

## 2b. Ejecutar por el terminal del editor

1. Abrir un terminal (*File → New → Terminal*) y escribir el comando del editor que imprime `diag.js`, en una sola línea; la salida va a `~/oap-diag.txt` (cortada a 20 KB).
2. Esperar a `EXIT=` en el terminal (unos 15-30 s: el shell carga el registro).
3. Leer la salida **como texto**, sin capturas, en otra pestaña: `https://<build>/odoo-sh/editor/api/contents/oap-diag.txt?content=1&format=text&type=file` con `get_page_text` ([editor-jupyterlab.md](editor-jupyterlab.md) §3).
4. Borrar: `rm ~/oap-diag.txt`.

## 3. Interpretar

- `EXIT=0` y la salida del script: el script se ejecutó; un error del script aparece como traceback **dentro** de la salida.
- `EXIT` distinto de 0 y salida vacía: el shell no arrancó (base de datos, módulo que no carga); mirar las últimas líneas de error que imprime el comando.
- Lo que el diagnóstico confirme se pasa a un test de regresión ([tests.md](tests.md), y en el squad al fixer). Si demuestra un hecho útil para otras tareas (un campo, un método, una rareza de la versión), anotarlo con `notes.js` **sin datos del cliente**.
