# Foodsys

Primera versión de un sistema web para pensiones, restaurantes y comida rápida. JavaScript en el navegador, Node.js + Express en el servidor y SQLite como base de datos local. No necesita Python, Docker, una cuenta externa ni instalar un servidor de base de datos.

## Iniciar en Windows

Instala **Node.js 24 LTS** (incluye npm). Descarga o clona este repositorio y abre una terminal dentro de su carpeta:

```powershell
npm.cmd install
npm.cmd run dev
```

Abre **http://localhost:5173**. Mantén la terminal abierta mientras uses el sistema. Para detenerlo, presiona `Ctrl+C`. En macOS/Linux los comandos son `npm install` y `npm run dev`.

Node.js es el único requisito: esta aplicación utiliza el módulo SQLite incluido en Node 24. Si tu versión es anterior, actualízala. La primera instalación requiere Internet; las fuentes, el QR y los recursos de la aplicación quedan instalados localmente.

### Usuarios iniciales de demostración

| Perfil | Usuario | Contraseña inicial | Permisos |
| --- | --- | --- | --- |
| Administrador | `admin` | `admin123` | Menús, ventas, reservas, cocina, gastos, arqueo y reportes |
| Cajero | `cajero` | `cajero123` | Ventas, reservas, cobros, disponibilidad y seguimiento de pedidos |
| Cocina | `cocina` | `cocina123` | Cola de preparación, marcar listo y entregar pedidos pagados |

Son cuentas para probar localmente. Antes del **primer arranque** puedes definir `ADMIN_PASSWORD`, `CAJERO_PASSWORD` y `COCINA_PASSWORD` en el entorno del proceso para sustituir las contraseñas iniciales. Por ejemplo, en PowerShell, `$env:ADMIN_PASSWORD = 'una-contraseña-propia'`. Estas variables solo se aplican al crear cada usuario por primera vez; no modifican cuentas ya existentes. No se carga un archivo `.env` automáticamente.

## Qué puedes probar

1. Entra como administrador. Se crea un menú de ejemplo para la fecha de Bolivia del primer inicio: 50 sopas de maní, 35 milanesas de pollo, 25 asados, 60 refrescos, otras bebidas y extras. Son cantidades y precios editables, no ventas ficticias.
2. En **Menú del día**, elige la fecha, define platos, precios y producción total. Publica el menú para habilitar las reservas públicas. Puedes preparar el menú de mañana. No se copia automáticamente el menú de ayer.
3. En **Punto de venta**, agrega completos o platos sueltos. Un completo contiene una sopa, un segundo y una bebida a elección. Marca «Bebida incluida en completo» únicamente en las bebidas que correspondan (por ejemplo el refresco del día); las gaseosas y otras bebidas se pueden vender por separado. El precio del completo es independiente de la suma de precios individuales.
4. Elige **Venta** para enviar el pedido inmediatamente a cocina, o **Reserva** para apartar porciones sin empezar a prepararlas. Puedes registrar las reservas recibidas por WhatsApp. No existe integración automática con WhatsApp.
5. Registra el cobro en efectivo o por QR, o déjalo pendiente. Seleccionar QR significa que el cajero **ya verificó el abono en su banco**. No hay pasarela, cargo automático ni verificación bancaria.
6. En **Pedidos y reservas**, cobra pendientes, envía reservas de hoy a cocina y anula reservas o pedidos sin pagar que todavía no estén en preparación.
7. Abre **Cocina** en otro navegador/dispositivo con la cuenta de cocina. Activa los sonidos con el botón. Los pedidos avanzan: **En espera → Preparando → Listo → Entregado**. Para entregar debe estar registrado el pago.
8. En **Caja y gastos**, registra el fondo inicial antes del primer movimiento; registra compras y otros gastos durante el día. Al terminar, cuenta el efectivo y registra el arqueo. Se muestra la diferencia entre el efectivo esperado y el contado.
9. En **Reportes**, consulta el día, los últimos siete días, el mes o un rango personalizado. Los cobros se agrupan por fecha de pago y medio; los gastos se agrupan por fecha de registro.
10. En **Menú y QR**, comparte el enlace público o descarga la imagen PNG del QR de la página de reservas. Los comensales no necesitan cuenta. Una reserva confirmada ya aparta porciones y muestra su número para recogerla.

## Reglas de inventario y dinero

- Registrar un pedido compromete las porciones en una transacción SQLite. Un completo descuenta una sopa, el segundo elegido y la bebida elegida. Cada segundo tiene su disponibilidad independiente.
- Una reserva ya cuenta contra el stock. Cobrarla o pasarla a cocina **no descuenta de nuevo**.
- Los platos sueltos y los extras descuentan solo su producto. Las cantidades y los precios se validan en el servidor, no se confía en los importes del navegador.
- Si no alcanza alguna porción, se rechaza el pedido entero: no se guarda una venta a medias. Los precios de pedidos existentes no cambian cuando se edita el menú.
- Anular un pedido no pagado libera sus porciones una sola vez. Los pedidos pagados no se pueden anular en esta primera versión porque aún no implementa devoluciones. Tampoco se editan pedidos ya registrados.
- Las reservas no vencen automáticamente. Caja debe anular las que ya no correspondan; los comensales no pueden anularlas por sí mismos en esta versión.
- Los importes se guardan en **centavos enteros de boliviano**, para evitar errores de coma flotante.
- **Resultado estimado = cobros − gastos registrados.** No es utilidad contable: hay que registrar ingredientes, salarios, alquiler, servicios y demás costos. No hay contabilidad por devengado, valoración de inventario ni conciliación bancaria.
- **Efectivo esperado = fondo inicial + cobros en efectivo − gastos pagados desde caja.** Los cobros y gastos QR no alteran el efectivo esperado.
- No se admiten pagos parciales ni varios medios de pago en un mismo pedido todavía.

## Caja automática y horario

Se usa **America/La_Paz (Bolivia)**, independientemente de la zona horaria del equipo. La caja se abre automáticamente al comenzar un nuevo día, sin fondo inicial, y se cierra a las **18:00**; también puedes cerrarla antes. El horario está fijado en esta primera versión en `server/store.js`.

El servidor revisa el horario cada minuto y en las operaciones autenticadas. Si está apagado, no puede ejecutar tareas: al volver a arrancar cierra los días anteriores pendientes y establece la caja del día actual. No simula procesos ejecutados con la computadora apagada. La caja cerrada bloquea cobros, ventas inmediatas y gastos; permite reservas sin pago. Un cierre automático deja pendiente el conteo físico, que se puede registrar después. No hay reapertura de caja en esta versión.

## Usar cocina desde un teléfono o una tablet

Conecta los dispositivos a la misma red Wi-Fi. `npm run dev` muestra la dirección de red del equipo; abre **http://IP-DE-TU-COMPUTADORA:5173** desde el otro dispositivo y entra como cocina. Permite el puerto 5173 en el firewall de tu equipo si corresponde. El teléfono no puede acceder al `localhost` de tu computadora.

Los cambios se notifican con Server-Sent Events y se reconectan automáticamente. El sonido requiere interacción para habilitarse y que la pestaña permanezca abierta. Un teléfono suspendido puede dejar de recibir avisos: no se implementa Web Push ni notificaciones con la aplicación cerrada. Las reservas públicas refrescan la disponibilidad cada 30 segundos; el servidor siempre vuelve a validarla al confirmar.

Para compartir reservas fuera de la red local necesitas desplegar el servidor con HTTPS y almacenamiento persistente. Esta primera versión está orientada a probar localmente; antes de publicarla falta completar administración de cuentas/recuperación de contraseña, operación y copias de respaldo, protección contra abuso de reservas y las necesidades legales/fiscales del negocio. El QR identifica la página de reservas, **no es un QR de pago bancario**.

## Datos y copias de seguridad

Los datos se conservan al reiniciar en `data/foodsys.sqlite`; `data/` está excluido de Git. SQLite puede crear archivos `-wal` y `-shm`. Para una copia manual consistente, detén el servidor con `Ctrl+C` y copia la carpeta `data` completa. No sincronices una base abierta entre computadoras ni coloques el archivo en una carpeta de red. Todos los dispositivos deben usar el mismo servidor.

Para empezar desde cero, detén el servidor y **respalda** `data` antes de retirarla. El siguiente inicio creará una base nueva con usuarios y menú de ejemplo. No borres datos reales para cambiar una contraseña.

Variables opcionales del servidor:

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `PORT` | `3001` | Puerto del API y del servidor de producción |
| `DB_PATH` | `data/foodsys.sqlite` | Ruta al archivo de base de datos |
| `COOKIE_SECURE` | sin definir | `true` para cookies solo por HTTPS al desplegar |
| `ADMIN_PASSWORD`, `CAJERO_PASSWORD`, `COCINA_PASSWORD` | credenciales demo | Contraseñas solo en la creación inicial |

El proxy de Vite apunta al puerto 3001: no cambies `PORT` durante desarrollo sin ajustar `vite.config.js`.

## Comandos y estructura

```powershell
npm.cmd test         # Pruebas de reglas de negocio y API HTTP, con SQLite en memoria
npm.cmd run build    # Genera el frontend en dist/
npm.cmd start        # Sirve API + dist/ en http://localhost:3001 después del build
```

```text
src/main.js          Pantallas y comportamiento del navegador
src/style.css        Diseño responsive y estilos
server/store.js      Esquema SQLite y reglas de negocio
server/index.js      Autenticación, permisos, API, eventos y servidor
test/system.test.js  Pruebas de negocio y API (sin tocar los datos locales)
```

Entidades: `users`, `sessions`, `days` (menús diarios), `items` (producción y porciones comprometidas), `orders`, `lines`, `allocations` (componentes consumidos), `payments`, `cash_days` y `expenses`.

Siguientes mejoras posibles: turnos y horario configurables, gestión de usuarios, cambios de pedidos y devoluciones con auditoría, reservas con hora límite, impresión de tickets, costos por receta, múltiples sucursales y despliegue público. Para varias sucursales o varios servidores, migrar a PostgreSQL sería un siguiente paso razonable; para un negocio y un servidor, SQLite evita instalaciones adicionales.
