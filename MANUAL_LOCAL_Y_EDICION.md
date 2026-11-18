# Foodsys: pruebas locales con PostgreSQL y edición visual

Este paquete contiene la aplicación, una configuración de PostgreSQL 18 para tu computadora y este manual. No contiene el servidor PostgreSQL instalado ni una copia de los datos de Render: la base local se crea al iniciar el sistema. Las pruebas locales no cambian tu web ni tu base de Render.

Puedes leer este archivo en Visual Studio Code o abrir **MANUAL_LOCAL_Y_EDICION.html** con doble clic en tu navegador, sin conexión.

## 1. Lo que necesitas

- Node.js 24 o posterior, con npm: https://nodejs.org/
- Docker Desktop con Docker Compose, abierto y funcionando: https://www.docker.com/products/docker-desktop/
- Visual Studio Code para editar archivos: https://code.visualstudio.com/

Si ya tienes PostgreSQL instalado, puedes usarlo sin Docker; consulta la alternativa del apartado 4.

## 2. Iniciar en Windows

Descomprime el ZIP. Abre la carpeta **foodsys** en Visual Studio Code y selecciona **Terminal → New Terminal**. Todos los comandos se ejecutan en esa carpeta, donde está `package.json`.

Primero copia la configuración de ejemplo. Hazlo una sola vez; no reemplaces un `.env` que ya hayas configurado:

```powershell
Copy-Item .env.example .env
```

Abre `.env` en el editor. La configuración incluida apunta únicamente a `127.0.0.1:5433`, una base local. No pegues la conexión de Render: si usas esa conexión, tus pruebas sí modificarían datos en línea. La contraseña del ejemplo es de demostración local y no debe usarse al publicar.

Instala dependencias y levanta la base:

```powershell
npm.cmd ci
docker compose up -d --wait db
npm.cmd run dev:local
```

Abre **http://localhost:5173**. Conserva la terminal abierta. Las cuentas de la base LOCAL nueva son:

| Perfil | Usuario | Contraseña de prueba |
| --- | --- | --- |
| Administrador | admin | admin123 |
| Cajero | cajero | cajero123 |
| Cocina | cocina | cocina123 |

Puedes cambiar esas contraseñas en `.env` **antes del primer arranque** de la aplicación. Después, se cambian desde **Usuarios**, con una cuenta de administrador. Cambiar `.env` no sustituye las contraseñas de usuarios existentes.

Se crea un menú de ejemplo para la fecha actual de Bolivia. Los pedidos, caja, fotos, bebidas y guarniciones se guardan en PostgreSQL. El horario de caja sigue siendo el de Bolivia y el cierre automático es a las 18:00; para probar reservas sin cobrar no necesitas que la caja esté abierta.

## 3. Iniciar en macOS o Linux

En una terminal dentro de `foodsys`, copia el archivo una sola vez si todavía no existe `.env`:

```sh
cp .env.example .env
npm ci
docker compose up -d --wait db
npm run dev:local
```

Abre **http://localhost:5173**. También puedes usar los comandos `npm` sin `.cmd` en Windows si tu terminal los permite; `.cmd` evita problemas frecuentes de políticas de PowerShell.

## 4. Comprobar la base y detener el sistema

Abre **http://localhost:3001/api/health**. Debe responder:

```json
{"status":"ok","database":"postgres"}
```

El archivo `compose.yaml` usa PostgreSQL 18 y un volumen llamado `foodsys_pg_data` (Docker añade el nombre del proyecto como prefijo). Allí quedan los datos, separados del código. Actualizar archivos o reiniciar la aplicación no borra ese volumen.

Para detener la aplicación, pulsa **Ctrl+C** en la terminal. Para detener PostgreSQL conservando el volumen:

```sh
docker compose stop db
```

Para volver a arrancar:

```sh
docker compose up -d --wait db
npm run dev:local
```

En Windows puedes usar `npm.cmd run dev:local`. **No uses `docker compose down -v` ni borres el volumen:** esas acciones eliminan la base local. Este paquete no necesita ejecutar un borrado para funcionar.

Los nuevos comandos `dev:local` y `start:local` usan `scripts/local-server.mjs` para leer `.env` y dar prioridad a sus valores sobre los heredados de la terminal. Estos comandos solo permiten PostgreSQL en `localhost` o `127.0.0.1`: rechazan una URL remota para evitar que una prueba modifique Render. Los comandos originales `npm run dev` y `npm start` siguen leyendo las variables del proceso, como en Render; no cargan `.env` por sí solos.

### Alternativa: PostgreSQL instalado sin Docker

Crea en tu PostgreSQL una base exclusiva para pruebas y un usuario con permisos sobre esa base. En `.env`, sustituye `DATABASE_URL` por su conexión local y usa `DB_DRIVER=postgres`. Para un servidor local sin TLS, usa `PGSSLMODE=disable` y `COOKIE_SECURE=false`. El puerto suele ser `5432` si usas una instalación propia.

No necesitas ejecutar `docker compose` en esta alternativa. Ejecuta `npm ci` y `npm run dev:local`: Foodsys crea su esquema automáticamente. No hace falta importar un archivo SQL inicial. Las otras variables `POSTGRES_*` del ejemplo son utilizadas por Docker, no configuran un servidor que ya instalaste por separado.

### Si aparece un error

- **Docker no responde:** abre Docker Desktop y espera a que termine de iniciar.
- **Puerto 5433 ocupado:** cambia `POSTGRES_PORT` y el puerto dentro de `DATABASE_URL` al mismo número libre. No cambies `PORT=3001`: el proxy de Vite utiliza ese puerto.
- **Password authentication failed:** comprueba usuario, contraseña y base. Modificar la contraseña en `.env` no cambia automáticamente la contraseña de una base que ya existe en el volumen. Corrígela con la administración de PostgreSQL sin borrar los datos.
- **La página no carga:** comprueba que `npm run dev:local` siga ejecutándose y revisa la terminal.
- **Falla el certificado al usar una base remota:** la configuración local sin TLS es solo para tu computadora. No uses `PGSSLMODE=disable` para evitar errores de certificado de Render. Consulta `docs/postgresql.md`.

## 5. Mapa de archivos para editar

| Qué quieres cambiar | Ruta / archivo | Dónde buscar |
| --- | --- | --- |
| Colores y estilos propios | `src/custom.css` | Archivo preparado para tus cambios; tiene prioridad sobre los estilos base |
| Diseño completo y reglas responsive | `src/style.css` | Selectores como `.sidebar`, `.primary`, `.login-story` |
| Logotipo y textos de las pantallas | `src/main.js` | Funciones `shell`, `login`, `publicPage` y `sharePage` |
| Imágenes del logotipo | `public/` | Por ejemplo `public/logo.png`, que se usa en HTML como `/logo.png` |
| Título de la pestaña y color del navegador | `index.html` | `<title>`, `meta name="theme-color"` y descripción |
| Color oscuro del QR | `src/main.js` | `QRCode.toCanvas`, opción `color.dark` dentro de `render` |
| Reglas de menús, stock, pedidos y horario | `server/store.js` | Lógica del servidor; requiere pruebas antes de publicar |
| Usuarios, permisos de caja e historial | `server/control.js` y `server/index.js` | Administración y protección de rutas |
| Inventario permanente de bebidas | `server/inventory.js` | Productos y movimientos |
| Conexión SQLite/PostgreSQL | `server/database.js` | No es necesario modificarlo para cambiar la apariencia |
| Variables locales privadas | `.env` | No se incluye en Git ni debe compartirse |

## 6. Cambiar los colores

Abre **`src/custom.css`** y añade, por ejemplo, esta paleta azul:

```css
:root {
  --green: #244c91;
  --orange: #e7953b;
  --muted: #718096;
  --line: #e2e8f0;
  color: #243449;
  background: #f4f7fb;
}

.primary:hover {
  background: #18396f;
}

.login-story {
  background: var(--green);
}

.nav-item.active {
  background: #e8eef9;
  color: var(--green);
}
```

Guarda el archivo: Vite actualiza la vista mientras `dev:local` está abierto. `--green` conserva ese nombre en el código, aunque le asignes azul, rojo u otro color.

La hoja base tiene colores escritos directamente además de las variables. Por eso, cambiar solo `--green` no cambia todos los tonos: sobrescribe el selector correspondiente en `custom.css`, como se hace con `.login-story` o `.nav-item.active`. Evita editar `dist/`, porque se vuelve a generar al compilar.

Para el color de la barra del navegador, abre `index.html` y cambia:

```html
<meta name="theme-color" content="#244c91" />
```

## 7. Cambiar el logotipo

La marca actual se dibuja con el símbolo `◒` y la palabra `foodsys`; no es un archivo de imagen. Para usar tu imagen:

1. Guarda tu logo en **`public/logo.png`**. Puedes crear o reemplazar ese archivo. Se recomiendan PNG o WebP con fondo transparente; SVG también funciona si es un archivo de confianza.
2. Abre **`src/main.js`** y usa **Ctrl+F** para buscar las funciones indicadas abajo. El archivo tiene funciones en líneas largas; no importa el número de línea, busca por nombre.
3. En `shell(content)`, reemplaza el contenido de la marca del menú lateral:

```html
<a class="brand" href="/">
  <img class="brand-logo" src="/logo.png" alt="Nombre de tu negocio">
  <span>Mi Pensión<small>TU COCINA, EN ORDEN</small></span>
</a>
```

Ese HTML va **dentro del texto entre comillas invertidas** de la función. No elimines las comillas invertidas ni las expresiones `${...}` del resto de la pantalla.

4. Repite el cambio en estos lugares para que la marca sea consistente:

| Función | Dónde aparece |
| --- | --- |
| `shell(content)` | Menú lateral después de iniciar sesión |
| `login()` | Marca de la pantalla de acceso |
| `publicPage()` | Cabecera de reservas; conserva su enlace `href="/reservar"` |
| `sharePage()` | Marca sobre el QR; aquí el contenedor es un `<div class="brand">`, no un enlace |

5. Añade a **`src/custom.css`**:

```css
.brand-logo {
  display: block;
  width: 42px;
  height: 42px;
  object-fit: contain;
  flex-shrink: 0;
}
```

Si el logo ya incluye el nombre del negocio, puedes quitar el `<span>` de esa marca. No hagas un reemplazo global de todos los símbolos: algunos son iconos de platos, botones u otros elementos.

La descarga PNG actual del QR contiene el código QR del canvas. La marca visible en la tarjeta HTML no se incrusta automáticamente dentro de ese PNG.

### Nombre de la pestaña e icono

En **`index.html`**, modifica el título y la descripción. Para un icono propio, guarda `public/favicon.png` y añade dentro de `<head>`:

```html
<link rel="icon" type="image/png" href="/favicon.png">
<title>Mi Pensión · Ventas y reservas</title>
```

No añadas un segundo `<title>`: reemplaza el que ya existe. Revisa también el texto del pie dentro de `shell(content)` en `src/main.js` si quieres cambiar el nombre que aparece allí.

## 8. Revisar los cambios antes de compartirlos

Prueba acceso, reservas, Punto de venta y vista móvil. Cambiar CSS o un logotipo no requiere borrar ni recrear la base.

```sh
npm test
npm run build
npm run start:local
```

Detén primero `dev:local` con **Ctrl+C** para que no ocupe el puerto 3001. Tras compilar, `start:local` sirve la aplicación completa en **http://localhost:3001**. Usa `npm.cmd` en PowerShell si lo necesitas.

La prueba normal usa SQLite aislado y omite explícitamente los casos que requieren PostgreSQL. Para ejecutar también la suite PostgreSQL, crea una **segunda base de pruebas cuyo nombre termine en `_test`**, configura `POSTGRES_TEST_URL` en el entorno de esa terminal y ejecuta `npm run test:postgres`. No uses la base local en la que quieras conservar tus registros ni la de Render como destino de esa suite.

## 9. Qué incluye este ZIP y qué se conserva

- Código completo de Foodsys con SQLite local opcional y PostgreSQL.
- `compose.yaml` para levantar PostgreSQL 18, que Docker descarga cuando lo ejecutas.
- `.env.example` con valores de demostración local, no credenciales de Render.
- Manual en HTML y Markdown, pruebas y guía de migración en `docs/postgresql.md`.
- No incluye `node_modules`, una base con datos reales ni ejecutables de PostgreSQL. `npm ci` y Docker los obtienen al preparar tu computadora.

La base local permanece en su volumen Docker. Reiniciar la app, editar colores o recompilar no borra sus datos. Borrar el volumen, cambiar a otra base o eliminar una instalación PostgreSQL sí puede perderlos; conserva respaldos de los datos que sean importantes.

Este ZIP sirve para hacer pruebas separadas. Modificarlo en tu computadora no actualiza Render. Para publicar una personalización, revisa los cambios de código, súbelos al repositorio y despliega manteniendo la misma `DATABASE_URL` de producción. **No reemplaces en Render sus variables por los valores de `.env.example`**.
