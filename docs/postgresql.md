# PostgreSQL para Foodsys

Foodsys conserva SQLite para uso local y usa PostgreSQL cuando se configura `DATABASE_URL`. No hay que cambiar el frontend. Las tablas guardan las mismas entidades, fotos, identificadores e importes en centavos. Las operaciones de stock, pedidos, edición, caja y usuarios son transacciones. Un bloqueo de transacción de PostgreSQL coordina las escrituras de distintas instancias para impedir sobreventas o ediciones simultáneas que se sobrescriban.

La base queda separada del disco del servicio web: volver a desplegar Foodsys no crea otra base ni reinicia sus datos. Esto requiere conservar **la misma conexión PostgreSQL**. La caducidad o eliminación de una base gratuita, un cambio a otra conexión o una operación manual de borrado sí pueden perder o sustituir los datos. Revisa la vigencia del plan y configura respaldos con tu proveedor.

## Antes de cambiar Render: conservar el SQLite actual

**No despliegues, reinicies ni guardes cambios de entorno del servicio web antes de obtener la copia de SQLite que quieres conservar.** Si el disco es temporal, ese paso puede eliminar el archivo antes de importarlo. Esta versión todavía no traslada datos de un servidor remoto por sí sola.

**Haz el cambio en una ventana de mantenimiento:** antes del respaldo, deja de registrar ventas, cobros, gastos y cambios de pedidos o usuarios; despublica los menús de reservas desde el administrador. Mantén esa pausa hasta activar PostgreSQL. No se pueden conservar operaciones nuevas que entren en SQLite después de tomar la copia. Despublicar menús no requiere reiniciar el servicio.

El archivo original suele estar en `data/foodsys.sqlite`, salvo que hayas configurado `DB_PATH`. En una instalación local con este código puedes crear una copia consistente, incluso con SQLite abierto:

```sh
npm run db:backup
```

Se crea un archivo nuevo en `backups/`, con permisos restringidos y verificación de integridad. El comando no sobrescribe archivos existentes. La carpeta está excluida de Git. Si el origen está en otra ubicación, configura `DB_PATH` para ese archivo antes de ejecutarlo.

Si tu Foodsys actual está en Render y todavía no tiene este comando, necesitas acceso al archivo de **esa instancia**. Si tu plan ofrece Shell/SSH, puedes hacer la copia con Node.js 24 sin desplegar código nuevo:

```sh
node --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite"; import {chmodSync} from "node:fs"; const db=new DatabaseSync(process.env.DB_PATH||"data/foodsys.sqlite",{readOnly:true}); const file="/tmp/foodsys-backup-"+Date.now()+".sqlite"; await backup(db,file); db.close(); chmodSync(file,0o600); console.log(file);'
```

Descarga y conserva esa copia por un canal privado antes de cambiar el servicio. No la subas al repositorio: contiene usuarios, hashes de contraseñas y datos de clientes. Si tu plan no permite acceder al archivo, **no supongas que se recuperará al desplegar**. Primero hay que obtener un respaldo. El código de GitHub y esta conversación no contienen la base de Render. Los datos que ya se hayan perdido de un disco temporal no se pueden reconstruir con esta migración.

## Crear y cargar la base nueva

1. En Render, crea un recurso **Postgres** separado del servicio web. Revisa el plan y su fecha de caducidad. Crear ese recurso no cambia la web actual.
2. El destino debe estar vacío: **importa antes de iniciar Foodsys contra esa base**, porque el primer arranque de una instalación vacía crea las cuentas y el menú de demostración. La herramienta rechaza destinos con datos; no tiene una opción que los borre o mezcle.
3. Instala esta versión en la computadora desde la que harás la importación con `npm ci`. Configura `DATABASE_URL` en el entorno del proceso usando la conexión externa de la nueva base. No pongas la conexión en archivos de código, argumentos de comandos, capturas ni mensajes. Para conexión remota se verifica TLS por defecto; puedes fijar `PGSSLMODE=verify-full`.
4. Revisa la copia y el conteo sin conectarte al destino:

```sh
npm run db:migrate -- --sqlite backups/foodsys-backup.sqlite --dry-run
```

5. Con `DATABASE_URL` configurada, importa:

```sh
npm run db:migrate -- --sqlite backups/foodsys-backup.sqlite
```

El comando primero hace otra copia privada del origen y actualiza únicamente esa copia al esquema vigente. Comprueba integridad y claves foráneas. Después, en una única transacción, copia las tablas en orden, compara su cantidad de filas y una huella de **todos los valores**, y ajusta las secuencias para continuar los números de pedidos y demás identificadores. Si hay un error, revierte la importación completa. No modifica el SQLite original.

Se conservan usuarios y hashes de contraseña, estados de cuenta, menús, productos, fotos, pedidos, selecciones de completos, pagos, gastos, caja, asignaciones de stock y auditoría. Las **sesiones no se importan**: todos deben volver a iniciar sesión. No se incluyen tablas desconocidas ni versiones futuras de esquema sin revisión. Las migraciones anteriores de inventario se conservan; si la copia es anterior al inventario permanente, el primer arranque aplica esa actualización habitual sobre los datos importados.

Un resultado `mode: imported` y `verified: true` confirma la carga de esa base de destino. Un `dry-run` solo valida la copia y muestra conteos. Volver a importar sobre una base ocupada se rechaza para evitar duplicaciones. Conserva el respaldo aunque la verificación haya terminado bien.

## Activar Render después de importar

Una vez que la importación haya terminado y tengas el respaldo:

- Despliega esta versión desde GitHub.
- En **Environment**, configura `DB_DRIVER=postgres` y `DATABASE_URL` con la conexión de **esa misma base**. Desde fuera de Render se usa la URL externa. Dentro de Render también puedes comenzar con la URL externa y TLS verificado; si vas a usar la URL interna, confirma las condiciones de TLS y red que proporciona Render.
- Mantén `NODE_VERSION=24` y `COOKIE_SECURE=true`.
- Build: `npm ci && npm run build`. Inicio: `npm start`. Configura `/api/health` como ruta de comprobación de salud si Render ofrece ese campo.
- La conexión remota verifica el certificado. `PGSSLROOTCERT` permite una CA específica en un archivo de confianza. No uses `no-verify` ni `rejectUnauthorized=false`. `PGSSLMODE=disable` solo es apropiado para un servidor local o una red interna que se haya configurado explícitamente sin TLS; no es una solución para errores de certificado de una conexión pública.

Cuando `DB_DRIVER=postgres` está configurado, la ausencia de `DATABASE_URL` impide arrancar: **no se vuelve silenciosamente a SQLite**. Una conexión PostgreSQL fallida tampoco provoca fallback. Las variables de contraseña inicial no reemplazan las contraseñas de usuarios importados.

Comprueba `/api/health`: debe responder con `{"status":"ok","database":"postgres"}`. Inicia sesión con un usuario conservado, revisa pedidos, stock, fotos y caja, y verifica nuevamente tras un despliegue. Después reactiva la publicación de los menús y permite nuevamente registrar operaciones. La inicialización crea solo estructuras faltantes; no vacía tablas existentes. `app_schema_versions` registra la versión de esquema y se rechaza una base de una versión más reciente que la aplicación.

## Pruebas para desarrollo

```sh
npm test
npm run build
```

El modo normal ejecuta la suite SQLite y omite de forma explícita los casos que necesitan una conexión PostgreSQL. Para probar PostgreSQL, crea una base **dedicada a pruebas**, cuyo nombre termine en `_test`, configura `POSTGRES_TEST_URL` y ejecuta:

```sh
npm run test:postgres
```

La suite crea y elimina esquemas temporales en esa base. Nunca uses una base de producción como destino de pruebas. Se ejecutan las mismas reglas de negocio sobre PostgreSQL, además de la importación completa, la reversión por fallo y los conflictos entre dos conexiones independientes. Las pruebas de actualización de archivos antiguos siguen usando SQLite como origen. Sin `POSTGRES_TEST_URL`, el comando específico falla en lugar de informar una validación vacía.
