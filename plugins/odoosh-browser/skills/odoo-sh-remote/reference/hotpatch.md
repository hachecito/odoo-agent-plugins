# Prueba rápida con parche en el build staging (antes del push)

Probar un cambio en el build staging que ya está en marcha, sin commit ni push ni esperar un build: se aplican los cambios locales en `~/src/user` del build, se lanzan los tests y se deshace. Lo que se entrega sigue siendo lo que construye Odoo.sh tras el push: esta prueba **no sustituye** a `remote_build` ni a `remote_tests`.

## Reglas

- Solo en el build **staging** de la tarea (`*.dev.odoo.com`), solo en `~/src/user`. Nunca en `~/src/odoo` ni `~/src/enterprise`, nunca en producción.
- **El código manda en local**: el cambio se hace primero en el repo local y se lleva al build tal cual. Si se edita en el editor, el resultado debe coincidir con el local (comprobación de hashes, abajo).
- **Staging es compartido**: el `-u` de los tests cambia su base de datos y guardar un `.py` en el editor reinicia el servidor. Avisar al usuario la primera vez en cada tarea.
- **Deshacer siempre**: antes del push y al cerrar la tarea (completada, bloqueada o abandonada). El siguiente build lo descarta, pero mientras tanto staging ejecuta código que no está en git.
- Evidencia propia: `run-state.js evidence --kind hotpatch_tests ...`. Nunca registrarla como `remote_tests`.
- **[no verificado]** que `~/src/user` sea un checkout de git con permisos de escritura. Comprobarlo en el primer uso (`git -C ~/src/user rev-parse HEAD`) y anotarlo en la memoria. `git apply` funciona también fuera de un repositorio; sin `.git` no hay `git status` para ver si está limpio.

## 1. Preparar el parche (local)

1. SHA del build: `git -C ~/src/user rev-parse HEAD` por SSH o en el terminal del editor, o el commit que muestra la rama en Odoo.sh. Si no existe en local, `git fetch`.
2. `node <plugin>/scripts/hotpatch.js prepare --base <sha>` (añadir `--only <ruta>` para un parche parcial, por ejemplo solo los tests). Genera en `.oap/odoosh-browser/hotpatch/`:
   - `patch.diff`: commits locales sin subir, cambios sin commit y archivos nuevos respecto al build;
   - `patch.b64`: el mismo parche en base64, para escribirlo en el terminal web;
   - `manifest.json`: archivos y su `git hash-object`.
   Imprime los comandos exactos para SSH y para el editor. No se conecta al build.

## 2a. Aplicar por SSH (preferente)

Con `ssh.enabled` y el host del build:
```bash
ssh <build> "cd ~/src/user && git rev-parse HEAD && git status --porcelain"     # HEAD = base; sin cambios ajenos
ssh <build> "cat > ~/oap-hotpatch.patch && cd ~/src/user && git apply --check ~/oap-hotpatch.patch && git apply ~/oap-hotpatch.patch" < .oap/odoosh-browser/hotpatch/patch.diff
ssh <build> "cd ~/src/user && git hash-object <archivos> | cut -c1-12"           # igual que el manifest
```
Si `git status --porcelain` no sale vacío, otra persona o un parche anterior han dejado cambios: no aplicar encima; preguntar al usuario. Si SSH falla (`exec request failed on channel 0` dos veces, sin clave o `ssh.enabled` en `false`), seguir por el editor.

## 2b. Aplicar por el editor (si SSH falla o no está configurado)

Abrir `https://<build>/odoo-sh/editor` y un terminal (*File → New → Terminal*). Leer [editor-jupyterlab.md](editor-jupyterlab.md) §5 para leer la salida del terminal (solo con capturas).

**Opción A — terminal (preferente para varios archivos o cambios largos).** Escribir el contenido de `patch.b64` entre estas líneas:
```bash
base64 -d > ~/oap-hotpatch.patch <<'OAP_EOF'
<líneas de patch.b64>
OAP_EOF
cd ~/src/user && git status --porcelain && git apply --check ~/oap-hotpatch.patch && git apply ~/oap-hotpatch.patch
git hash-object <archivos> | cut -c1-12
```
Se usa base64 porque no lleva tabuladores (que el terminal tomaría como autocompletado) ni texto de código que el guard pueda confundir con un comando prohibido.

**Opción B — editor de archivos (cambios pequeños o un archivo nuevo).**
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
Para un test de regresión: primero un parche solo con el test (`--only <ruta del test>`) y debe **fallar**; después deshacer, preparar el parche completo y debe **pasar**.

Registrar `hotpatch_tests` con el SHA base, el parche (`--only` o completo), el comando, N tests y el resultado.

## 4. Deshacer

```bash
cd ~/src/user && git apply -R ~/oap-hotpatch.patch && git status --porcelain && rm ~/oap-hotpatch.patch
```
Por SSH, el mismo comando dentro de `ssh <build> "..."`. Si se editó en el editor sin parche, `git checkout -- <archivos>` y borrar los archivos nuevos con `rm <archivo>` (sin `-rf`). Antes de un parche nuevo, deshacer el anterior.
