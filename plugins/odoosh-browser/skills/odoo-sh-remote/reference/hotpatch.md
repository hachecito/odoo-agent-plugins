# Prueba rápida con parche en el build staging (antes del push)

Probar un cambio en el build staging que ya está en marcha, sin commit ni push ni esperar un build: se aplican los cambios locales en `~/src/user` del build, se lanzan los tests y se deshace. Lo que se entrega sigue siendo lo que construye Odoo.sh tras el push: esta prueba **no sustituye** a `remote_build` ni a `remote_tests`.

## Reglas

- Solo en el build **staging** de la tarea (`*.dev.odoo.com`), solo en `~/src/user`. Nunca en `~/src/odoo` ni `~/src/enterprise`, nunca en producción.
- **El código manda en local**: el cambio se hace primero en el repo local y se lleva al build tal cual. Si se edita en el editor, el resultado debe coincidir con el local (comprobación de hashes, abajo).
- **Staging es compartido**: el `-u` de los tests cambia su base de datos y guardar un `.py` en el editor reinicia el servidor. Avisar al usuario la primera vez en cada tarea.
- **Deshacer siempre**: antes del push y al cerrar la tarea (completada, bloqueada o abandonada). El siguiente build lo descarta, pero mientras tanto staging ejecuta código que no está en git.
- Evidencia propia: `run-state.js evidence --kind hotpatch_tests ...`. Nunca registrarla como `remote_tests`.
- **Verificado en un build staging de Odoo 18 (noviembre de 2026)**: `~/src/user` es un checkout de git en el commit del build, con permisos de escritura, `git` 2.43 y `base64`; el parche en base64 escrito en el terminal web se aplicó con los mismos `git hash-object` que en local, y `git apply -R` lo deshizo por completo, incluidos los archivos y carpetas nuevos. Comprobarlo igualmente en el primer uso de cada proyecto (`git -C ~/src/user rev-parse HEAD`). Si algún build no fuera un checkout de git: `git apply` funciona también fuera de un repositorio, y en vez de `git status` se comprueba con el propio parche: `git apply -R --check ~/oap-hotpatch.patch` termina bien si el parche **sigue aplicado**, y si no queda `~/oap-hotpatch.patch` no hay parche del agente.

## 1. Preparar el parche (local)

1. SHA del build: `git -C ~/src/user rev-parse --short=12 HEAD` por SSH o en el terminal del editor (12 caracteres se leen mejor en una captura), o el commit que muestra la rama en Odoo.sh. Si no existe en local, `git fetch`.
2. `node <plugin>/scripts/hotpatch.js prepare --base <sha>` (añadir `--only <ruta>` para un parche parcial, por ejemplo solo los tests). Genera en `.oap/odoosh-browser/hotpatch/`:
   - `patch.diff`: commits locales sin subir, cambios sin commit y archivos nuevos respecto al build;
   - `patch.b64`: el mismo parche en base64, para escribirlo en el terminal web;
   - `manifest.json`: archivos y su `git hash-object`.
   Imprime los comandos exactos para SSH y para el editor. No se conecta al build.
3. **Revisar la lista de archivos antes de aplicar.** El parche completo incluye todo lo que git no ignora, también archivos sueltos sin seguimiento (scripts de prueba, un `odoo.conf`, `.env`…), que el script lista aparte. Si aparece algo fuera de los módulos de la tarea, repetir con `--only <modulo> [--only <modulo>...]`. Nunca llevar al build archivos con credenciales o datos de clientes.

## 2a. Aplicar por SSH (preferente)

Con `ssh.enabled` y el host del build. En Windows, con la herramienta **Bash** (Git Bash): PowerShell 5.1 no admite la redirección `<` y pasar el parche por una tubería de PowerShell lo recodifica y lo estropea.
```bash
ssh <build> "cd ~/src/user && git rev-parse HEAD && git status --porcelain"     # HEAD = base; sin cambios ajenos
ssh <build> "cat > ~/oap-hotpatch.patch && cd ~/src/user && git apply --check ~/oap-hotpatch.patch && git apply ~/oap-hotpatch.patch" < .oap/odoosh-browser/hotpatch/patch.diff
ssh <build> "cd ~/src/user && git hash-object <archivos> | cut -c1-12"           # igual que el manifest
```
Si `git status --porcelain` no sale vacío, otra persona o un parche anterior han dejado cambios: no aplicar encima; preguntar al usuario. Si SSH falla (`exec request failed on channel 0` dos veces, sin clave o `ssh.enabled` en `false`), seguir por el editor.

## 2b. Aplicar por el editor (si SSH falla o no está configurado)

Abrir `https://<build>/odoo-sh/editor` y un terminal (*File → New → Terminal*). Leer [editor-jupyterlab.md](editor-jupyterlab.md) §5 para leer la salida del terminal (solo con capturas).

**Todo por el terminal**: tiene escritura en `~/src/user`, así que crear y modificar archivos con comandos (`mkdir -p`, `cat`/`base64 -d` con heredoc, `sed -i`) es más barato y fiable que el editor de archivos: no hay clics ni autoindentado, y el resultado se comprueba en el mismo terminal. Orden de preferencia: A, después B; el editor de archivos (C) solo si el terminal no está disponible.

**Opción A — parche completo (preferente).** Escribir el contenido de `patch.b64` entre estas líneas:
```bash
base64 -d > ~/oap-hotpatch.patch <<'OAP_EOF'
<líneas de patch.b64>
OAP_EOF
cd ~/src/user && git status --porcelain && git apply --check ~/oap-hotpatch.patch && git apply ~/oap-hotpatch.patch
git hash-object <archivos> | cut -c1-12
```
Se usa base64 porque no lleva tabuladores (que el terminal tomaría como autocompletado) ni texto de código que el guard pueda confundir con un comando prohibido.

**Opción B — archivo a archivo en el terminal** (un archivo nuevo o un cambio pequeño, o si `git apply` falla). Verificado: un archivo escrito con `base64 -d` conserva los tabuladores y `sed -i` cambia la línea; el hash coincide con el local. Con el contenido del archivo local:
```bash
mkdir -p ~/src/user/<modulo>/tests
base64 -d > ~/src/user/<ruta> <<'OAP_EOF'      # contenido completo del archivo local en base64
<base64 del archivo>
OAP_EOF
sed -i 's/<texto exacto>/<nuevo>/' ~/src/user/<ruta>   # solo para una línea sencilla
cd ~/src/user && git hash-object <ruta> | cut -c1-12    # igual que el manifest
```
- Para el archivo completo, base64 mejor que texto plano: el código Python lleva sangrías y, a veces, tabuladores o texto (por ejemplo SQL en `cr.execute`) que el terminal o el guard interpretarían mal.
- Nada de editores interactivos (`nano`, `vim`): se manejan a ciegas por capturas y no se puede comprobar lo escrito hasta salir.
- **[no verificado]** si escribir un `.py` desde el terminal reinicia el servidor como al guardar en el editor. Para los tests no importa: se lanzan en un proceso aparte.

**Opción C — editor de archivos (último recurso).**
1. Abrir el archivo con `https://<build>/odoo-sh/editor/lab/tree/src/user/<ruta>`. Archivo nuevo: navegar a su carpeta, *File → New → Text File* (o *Python File*) y renombrarlo con su nombre real (clic derecho en la pestaña o en el explorador → *Rename*).
2. Editar. **[no verificado]** el editor puede autoindentar y cerrar paréntesis o comillas al escribir: revisar el resultado antes de guardar.
3. **Guardar siempre**: `Ctrl+S` o *File → Save*. Sin guardar, el cambio no existe en disco y el test probaría el código anterior. Guardar un `.py` reinicia el servidor de staging.
4. Comprobar desde el terminal que lo guardado coincide con el local: `cd ~/src/user && git hash-object <archivo> | cut -c1-12` contra el `manifest.json`. Una pestaña sin marca de cambios no basta.

## 3. Probar

Con el parche aplicado, lanzar los tests en un proceso aparte, como en [tests.md](tests.md): lee el código parcheado sin reiniciar el servidor.
```bash
odoo-bin -d "$PGDATABASE" -u <modulo> --stop-after-init --no-http --test-enable --test-tags /<modulo>:<Clase>.<metodo> --logfile=/tmp/agent-tests.log --log-level=test
grep -n 'FAIL:\|ERROR:\|tests.result\|Ran ' /tmp/agent-tests.log | tail -n 40
```
Para un test de regresión: primero un parche solo con la carpeta de tests del módulo (`--only <modulo>/tests`, para que vaya también `tests/__init__.py`) y debe **fallar**; después deshacer, preparar el parche completo y debe **pasar**. Solo cuenta como rojo si se ejecutan N > 0 tests y el de regresión falla en su aserción; 0 tests, un `ImportError` o un error al cargar el módulo no reproducen nada.

Registrar `hotpatch_tests` con el SHA base, el parche (`--only` o completo), el comando, N tests y el resultado.

## 4. Deshacer

```bash
cd ~/src/user && git apply -R ~/oap-hotpatch.patch && git status --porcelain && rm ~/oap-hotpatch.patch
```
Por SSH, el mismo comando dentro de `ssh <build> "..."`. Si se cambiaron archivos uno a uno (opciones B o C) sin parche, `git checkout -- <archivos>` y borrar los archivos nuevos con `rm <archivo>` (sin `-rf`). Antes de un parche nuevo, deshacer el anterior.
