import { controlStore } from './control.js';
import { inventoryStore } from './inventory.js';
import { createDatabase } from './database.js';
import { resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
export function businessDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/La_Paz',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k).value).join('-');
}
export const localHour = (now = new Date()) => Number(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/La_Paz',
  hour: '2-digit',
  hourCycle: 'h23'
}).format(now));
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, hash) {
  const [salt, value] = hash.split(':');
  return timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(hashPassword(password, salt).split(':')[1], 'hex'));
}
export function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
export const money = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01 || n > 1000000) fail('Importe inválido.');
  return Math.round(n * 100);
};
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('Fecha inválida.');
  return value;
}
export async function createStore(filename, {
  seed = true,
  now = () => new Date(),
  databaseUrl,
  initialize = true
} = {}) {
  const url = databaseUrl ?? (filename === undefined ? process.env.DATABASE_URL : undefined);
  if(url!==undefined&&(typeof url!=='string'||!url.trim()))throw new Error('DATABASE_URL está vacía o es inválida.');
  if (filename===undefined && process.env.DB_DRIVER === 'postgres' && !url) throw new Error('Configura DATABASE_URL para PostgreSQL.');
  const db = await createDatabase({
    filename: filename || process.env.DB_PATH || resolve('data/foodsys.sqlite'),
    databaseUrl: url
  });
  try {
    return await db.transaction(async () => {
      await db.exec('CREATE TABLE IF NOT EXISTS app_schema_versions(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
      if((await db.get('SELECT MAX(version) AS version FROM app_schema_versions')).version>1)throw new Error('La base tiene una versión de esquema más reciente que esta aplicación.');
      await db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS days(date TEXT PRIMARY KEY, combo_price INTEGER NOT NULL DEFAULT 2500, published INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, date TEXT NOT NULL REFERENCES days(date), name TEXT NOT NULL, kind TEXT NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL CHECK(stock>=0), used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0 AND used<=stock), combo_eligible INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cash_days(date TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT, opening INTEGER NOT NULL DEFAULT 0, counted INTEGER, note TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, date TEXT NOT NULL REFERENCES days(date), customer TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lines(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), label TEXT NOT NULL, quantity INTEGER NOT NULL, price INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS allocations(order_id INTEGER NOT NULL REFERENCES orders(id), item_id INTEGER NOT NULL REFERENCES items(id), quantity INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id), date TEXT NOT NULL REFERENCES cash_days(date), method TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, date TEXT NOT NULL REFERENCES cash_days(date), description TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, created_at TEXT NOT NULL);`);
      if (!(await db.columns('items')).some(c => c.name === 'combo_eligible')) {
        await db.exec("ALTER TABLE items ADD COLUMN combo_eligible INTEGER NOT NULL DEFAULT 0; UPDATE items SET combo_eligible=1 WHERE id IN (SELECT MIN(id) FROM items WHERE kind='drink' GROUP BY date)");
      }
      if (!(await db.columns('items')).some(c => c.name === 'photo')) await db.exec("ALTER TABLE items ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
      if (!(await db.columns('lines')).some(c => c.name === 'selection')) await db.exec('ALTER TABLE lines ADD COLUMN selection TEXT');
      if (!(await db.columns('orders')).some(c => c.name === 'version')) await db.exec('ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
      const {
        all,
        get,
        run,
        transaction
      } = db;
      const today = () => businessDate(now());
      const stamp = () => now().toISOString();
      async function reconcile() {
        return await transaction(async () => {
          const date = today();
          const pending = await all('SELECT date FROM cash_days WHERE closed_at IS NULL AND (date<? OR (date=? AND ? >=18))', date, date, localHour(now()));
          for (const day of pending) {
            await run("UPDATE cash_days SET closed_at=?,note=CASE WHEN note='' THEN 'Cierre automático' ELSE note END WHERE date=?", stamp(), day.date);
            await control.audit('cash_auto_closed', day.date, null);
          }
          const inserted = await run('INSERT OR IGNORE INTO cash_days(date,opened_at) VALUES (?,?)', date, stamp());
          if (inserted.changes) {
            await control.audit('cash_auto_opened', date, null);
            if (localHour(now()) >= 18) {
              await run("UPDATE cash_days SET closed_at=?,note='Cierre automático a las 18:00' WHERE date=?", stamp(), date);
              await control.audit('cash_auto_closed', date, null);
            }
          }
          await run('DELETE FROM sessions WHERE expires<?', Date.now());
        });
      }
      async function openCash() {
        await reconcile();
        const day = await get('SELECT * FROM cash_days WHERE date=?', today());
        if (day.closed_at) fail('La caja de hoy está cerrada. No se pueden registrar movimientos.', 409);
        return day;
      }
      const control = await controlStore({
        db,
        all,
        get,
        run,
        transaction,
        today,
        stamp,
        openCash,
        reconcile,
        report,
        fail,
        hashPassword
      });
      if (seed && initialize) {
        if (!(await get('SELECT id FROM users LIMIT 1'))) for (const [name, username, role] of [['María', 'admin', 'admin'], ['Caja', 'cajero', 'cashier'], ['Cocina', 'cocina', 'kitchen']]) {
          if (!(await get('SELECT id FROM users WHERE username=?', username))) await run('INSERT INTO users(name,username,password,role) VALUES (?,?,?,?)', name, username, hashPassword(process.env[`${username.toUpperCase()}_PASSWORD`] || `${username}123`), role);
        }
        if (!(await get('SELECT date FROM days LIMIT 1'))) {
          await run('INSERT INTO days(date,combo_price,published) VALUES (?,?,1)', today(), 2500);
          for (const [name, kind, price, stock] of [['Sopa de maní', 'soup', 1000, 50], ['Milanesa de pollo', 'main', 1800, 35], ['Asado a la olla', 'main', 1800, 25], ['Coca-Cola personal', 'drink', 700, 20], ['Porción de arroz', 'extra', 500, 20]]) await run('INSERT INTO items(date,name,kind,price,stock,combo_eligible) VALUES (?,?,?,?,?,?)', today(), name, kind, price, stock, 0);
        }
      }
      const inventory = await inventoryStore({
        db,
        all,
        get,
        run,
        transaction,
        today,
        stamp,
        openCash,
        fail,
        money,
        validDate,
        initialize
      });
      if (initialize) await reconcile();
      await db.exec(`CREATE TABLE IF NOT EXISTS app_schema_versions(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS idx_items_date ON items(date);CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date);CREATE INDEX IF NOT EXISTS idx_lines_order ON lines(order_id);CREATE INDEX IF NOT EXISTS idx_allocations_order ON allocations(order_id);CREATE INDEX IF NOT EXISTS idx_product_allocations_order ON product_allocations(order_id);CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(action,entity_id);CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory_movements(product_id,id);`);
      await run('INSERT OR IGNORE INTO app_schema_versions(version,applied_at) VALUES (?,?)', 1, stamp());
      async function menu(date, publicOnly = false) {
        validDate(date);
        const day = await get('SELECT * FROM days WHERE date=?', date);
        return day && (!publicOnly || day.published) ? {
          ...day,
          items: [...(await all("SELECT *,stock-used AS available FROM items WHERE date=? AND combo_eligible=0 AND kind<>'drink' ORDER BY id", date)), ...(await inventory.catalog())]
        } : {
          date,
          combo_price: 2500,
          published: 0,
          items: []
        };
      }
      async function orders(date) {
        return await Promise.all((await all(`SELECT o.*,p.method,p.amount AS paid FROM orders o LEFT JOIN payments p ON p.order_id=o.id WHERE o.date=? ORDER BY o.id DESC`, date)).map(async o => ({
          ...o,
          lines: await all('SELECT * FROM lines WHERE order_id=?', o.id)
        })));
      }
      async function createOrder(body, source = 'staff', editing = null, actor = null) {
        return await transaction(async () => {
          let previous = null,
            oldLines = [];
          if (editing !== null) {
            previous = await editableOrder(editing);
            oldLines = await editLines(previous.id);
            if (!Number.isInteger(body.version) || body.version !== previous.version) fail('El pedido cambió. Vuelve a abrirlo antes de editar.', 409);
            if (body.date !== undefined && body.date !== previous.date) fail('No se puede cambiar la fecha del pedido.');
            if (body.payment) fail('Guarda la edición antes de registrar el cobro.');
            source = previous.source;
            body = {
              ...body,
              date: previous.date,
              type: previous.type,
              customer: body.customer ?? previous.customer,
              phone: body.phone ?? previous.phone,
              note: body.note ?? previous.note
            };
            await releaseOrder(previous.id, 'edit_release');
          }
          const date = validDate(body.date);
          if (date < today()) fail('No se aceptan pedidos para fechas pasadas.');
          const day = await get('SELECT * FROM days WHERE date=?', date);
          if (!day || source === 'public' && !previous && !day.published) fail('El menú aún no está publicado.');
          const reservation = source === 'public' || body.type === 'reservation';
          if (!reservation && date !== today()) fail('Las ventas deben corresponder a hoy.');
          if (!reservation) await openCash();
          const customer = String(body.customer || '').trim().slice(0, 100) || (source === 'staff' ? 'Cliente sin nombre' : '');
          if (!customer) fail('Escribe el nombre del comensal.');
          if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 30) fail('Agrega al menos un plato.');
          const allocations = new Map(),
            products = new Map(),
            lines = [];
          let total = 0;
          const allocate = async (id, quantity, kind) => {
            const item = await get('SELECT * FROM items WHERE id=? AND date=?', Number(id) || 0, date);
            if (!item || kind && item.kind !== kind) fail('El plato elegido no está en este menú.');
            allocations.set(item.id, (allocations.get(item.id) || 0) + quantity);
            return item;
          };
          for (const line of body.lines) {
            const q = Number(line.quantity);
            if (!Number.isInteger(q) || q < 1 || q > 100) fail('Cantidad inválida.');
            let price, label;
            const choice = normalizeChoice(line);
            if (line.kind === 'product') {
              const product = await get('SELECT * FROM products WHERE id=? AND active=1', Number(line.productId) || 0);
              if (!product) fail('Bebida no disponible.');
              products.set(product.id, (products.get(product.id) || 0) + q);
              price = product.price;
              label = product.name;
            } else if (line.kind === 'combo') {
              const soup = await allocate(line.soupId, q, 'soup'),
                main = await allocate(line.mainId, q, 'main');
              price = day.combo_price;
              const hasSides = Boolean(await get("SELECT id FROM items WHERE date=? AND kind='side' LIMIT 1", date));
              const side = hasSides || line.sideId ? await allocate(line.sideId, q, 'side') : null;
              label = `Completo · ${soup.name} + ${main.name}${side ? ' + ' + side.name : ''} + vaso de refresco incluido`;
            } else {
              const item = await allocate(line.itemId, q);
              if (item.kind === 'drink' && !item.combo_eligible) fail('Selecciona la bebida desde el inventario actualizado.');
              if (item.combo_eligible) fail('El refresco solo se sirve incluido en el completo.');
              price = item.price;
              label = item.name;
            }
            const original = oldLines.find(l => l.id === Number(line.lineId));
            if (original?.choice && JSON.stringify(original.choice) === JSON.stringify(choice)) {
              price = original.price;
              label = original.label;
            }
            lines.push({
              label,
              quantity: q,
              price,
              selection: JSON.stringify(choice)
            });
            total += price * q;
          }
          for (const [id, q] of allocations) {
            const item = await get('SELECT * FROM items WHERE id=?', id);
            if (item.stock - item.used < q) fail(`No alcanza ${item.name}. Quedan ${item.stock - item.used} porciones.`, 409);
          }
          for (const [id, q] of products) {
            const p = await get('SELECT * FROM products WHERE id=?', id);
            if (p.stock < q) fail(`No alcanza ${p.name}. Quedan ${p.stock} unidades.`, 409);
          }
          if (body.expectedTotal !== undefined && body.expectedTotal !== total) fail('El precio del menú cambió. Actualiza la página y revisa tu pedido antes de confirmarlo.', 409);
          let id;
          if (previous) {
            id = previous.id;
            await run('DELETE FROM lines WHERE order_id=?', id);
            await run('DELETE FROM allocations WHERE order_id=?', id);
            await run('DELETE FROM product_allocations WHERE order_id=?', id);
            await run('UPDATE orders SET customer=?,phone=?,note=?,total=?,version=version+1 WHERE id=?', customer, String(body.phone || '').slice(0, 30), String(body.note || '').slice(0, 500), total, id);
          } else id = Number((await run('INSERT INTO orders(date,customer,phone,note,type,source,status,total,created_at) VALUES (?,?,?,?,?,?,?,?,?)', date, customer, String(body.phone || '').slice(0, 30), String(body.note || '').slice(0, 500), reservation ? 'reservation' : 'sale', source, reservation ? 'reserved' : 'queued', total, stamp())).lastInsertRowid);
          for (const l of lines) await run('INSERT INTO lines(order_id,label,quantity,price,selection) VALUES (?,?,?,?,?)', id, l.label, l.quantity, l.price, l.selection);
          for (const [itemId, q] of allocations) {
            await run('INSERT INTO allocations VALUES (?,?,?)', id, itemId, q);
            await run('UPDATE items SET used=used+? WHERE id=?', q, itemId);
          }
          for (const [productId, q] of products) {
            await run('INSERT INTO product_allocations VALUES (?,?,?)', id, productId, q);
            await inventory.changeStock(productId, -q, previous ? 'edit_reservation' : 'order', id);
          }
          if (previous) await control.audit('order_updated', id, actor, {
            before: {
              customer: previous.customer,
              phone: previous.phone,
              note: previous.note,
              total: previous.total,
              lines: oldLines.map(l => ({
                label: l.label,
                quantity: l.quantity,
                price: l.price
              }))
            },
            after: {
              customer,
              phone: String(body.phone || '').slice(0, 30),
              note: String(body.note || '').slice(0, 500),
              total,
              lines: lines.map(l => ({
                label: l.label,
                quantity: l.quantity,
                price: l.price
              }))
            }
          });
          if (source === 'staff' && body.payment) await pay(id, body.payment);
          return {
            id,
            total,
            status: previous?.status || (reservation ? 'reserved' : 'queued'),
            version: previous ? previous.version + 1 : 0
          };
        });
      }
      function normalizeChoice(line) {
        if (line.kind === 'combo') return {
          kind: 'combo',
          soupId: Number(line.soupId) || 0,
          mainId: Number(line.mainId) || 0,
          sideId: Number(line.sideId) || 0
        };
        if (line.kind === 'product') return {
          kind: 'product',
          productId: Number(line.productId) || 0
        };
        return {
          kind: 'item',
          itemId: Number(line.itemId) || 0
        };
      }
      async function editableOrder(id) {
        const order = await get('SELECT * FROM orders WHERE id=?', Number(id));
        if (!order) fail('Pedido no encontrado.', 404);
        if (!['reserved', 'queued'].includes(order.status)) fail('Solo se editan reservas o pedidos que todavía no están en preparación.', 409);
        if (await get('SELECT id FROM payments WHERE order_id=?', order.id)) fail('No se puede editar un pedido pagado.', 409);
        if (order.date < today()) fail('No se puede editar un pedido pasado.', 409);
        return order;
      }
      async function releaseOrder(id, reason) {
        for (const a of await all('SELECT * FROM product_allocations WHERE order_id=?', id)) await inventory.changeStock(a.product_id, a.quantity, reason, id);
        for (const a of await all('SELECT a.quantity,l.product_id FROM allocations a JOIN legacy_products l ON l.item_id=a.item_id WHERE a.order_id=?', id)) await inventory.changeStock(a.product_id, a.quantity, reason, id);
        for (const a of await all('SELECT * FROM allocations WHERE order_id=?', id)) await run('UPDATE items SET used=used-? WHERE id=?', a.quantity, a.item_id);
      }
      async function editLines(id) {
        const items = await all('SELECT i.* FROM allocations a JOIN items i ON i.id=a.item_id WHERE a.order_id=?', id);
        const products = await all('SELECT p.* FROM product_allocations a JOIN products p ON p.id=a.product_id WHERE a.order_id=?', id);
        return await Promise.all((await all('SELECT * FROM lines WHERE order_id=?', id)).map(async line => {
          if (line.selection) return {
            ...line,
            choice: JSON.parse(line.selection)
          };
          // Older versions stored only display text. Infer only unambiguous choices; otherwise ask staff to select again.
          let choices = [];
          if (line.label.startsWith('Completo · ')) {
            for (const soup of items.filter(i => i.kind === 'soup')) for (const main of items.filter(i => i.kind === 'main')) {
              const sides = [null, ...items.filter(i => i.kind === 'side')];
              for (const side of sides) if (['vaso de refresco incluido', ...items.filter(i => i.kind === 'drink').map(i => i.name)].some(drink => line.label === `Completo · ${soup.name} + ${main.name}${side ? ' + ' + side.name : ''} + ${drink}`)) choices.push(normalizeChoice({
                kind: 'combo',
                soupId: soup.id,
                mainId: main.id,
                sideId: side?.id
              }));
            }
            if (!choices.length) {
              const soups = items.filter(i => i.kind === 'soup'),
                mains = items.filter(i => i.kind === 'main');
              if (soups.length === 1 && mains.length === 1) choices.push(normalizeChoice({
                kind: 'combo',
                soupId: soups[0].id,
                mainId: mains[0].id
              }));
            }
          } else {
            for (const item of items.filter(i => i.name === line.label)) {
              const legacy = await get('SELECT product_id FROM legacy_products WHERE item_id=?', item.id);
              if (legacy) choices.push(normalizeChoice({
                kind: 'product',
                productId: legacy.product_id
              }));else if (item.kind !== 'drink') choices.push(normalizeChoice({
                kind: 'item',
                itemId: item.id
              }));
            }
            for (const p of products.filter(p => p.name === line.label)) choices.push(normalizeChoice({
              kind: 'product',
              productId: p.id
            }));
          }
          return {
            ...line,
            choice: choices.length === 1 ? choices[0] : null
          };
        }));
      }
      async function orderForEdit(id) {
        return await transaction(async () => {
          const order = await editableOrder(id),
            data = await menu(order.date);
          const own = new Map((await all('SELECT item_id,SUM(quantity) AS q FROM allocations WHERE order_id=? GROUP BY item_id', id)).map(a => [a.item_id, a.q]));
          const ownProducts = new Map((await all('SELECT product_id,SUM(quantity) AS q FROM product_allocations WHERE order_id=? GROUP BY product_id', id)).map(a => [a.product_id, a.q]));
          for (const a of await all('SELECT l.product_id,SUM(a.quantity) AS q FROM allocations a JOIN legacy_products l ON l.item_id=a.item_id WHERE a.order_id=? GROUP BY l.product_id', id)) ownProducts.set(a.product_id, (ownProducts.get(a.product_id) || 0) + a.q);
          data.items = data.items.map(i => ({
            ...i,
            available: i.available + (i.productId ? ownProducts.get(i.productId) || 0 : own.get(i.id) || 0)
          }));
          return {
            order: {
              ...order,
              lines: await editLines(id)
            },
            menu: data,
            history: (await all("SELECT actor_name,actor_username,created_at,details FROM audit_log WHERE action='order_updated' AND entity_id=? ORDER BY id DESC LIMIT 20", String(id))).map(e => ({
              ...e,
              details: JSON.parse(e.details)
            }))
          };
        });
      }
      const editOrder = async (id, body, actor) => await createOrder(body, 'staff', Number(id), actor);
      async function pay(id, method) {
        if (!['cash', 'qr'].includes(method)) fail('Medio de pago inválido.');
        await openCash();
        const order = await get('SELECT * FROM orders WHERE id=?', id);
        if (!order || order.status === 'cancelled') fail('Pedido no disponible.');
        if (await get('SELECT id FROM payments WHERE order_id=?', id)) fail('Este pedido ya está pagado.', 409);
        await run('INSERT INTO payments(order_id,date,method,amount,created_at) VALUES (?,?,?,?,?)', id, today(), method, order.total, stamp());
      }
      async function transition(id, status, role) {
        return await transaction(async () => {
          const order = await get('SELECT * FROM orders WHERE id=?', id);
          if (!order) fail('Pedido no encontrado.', 404);
          const allowed = {
            reserved: ['queued', 'cancelled'],
            queued: ['preparing', 'cancelled'],
            preparing: ['ready'],
            ready: ['delivered']
          };
          if (!allowed[order.status]?.includes(status)) fail('Este cambio de estado no es válido.', 409);
          if (role === 'kitchen' && !['preparing', 'ready', 'delivered'].includes(status)) fail('Acceso restringido.', 403);
          if (role === 'cashier' && !['queued', 'cancelled'].includes(status)) fail('La preparación y entrega corresponden a cocina.', 403);
          if (status === 'queued' && order.date !== today()) fail('Solo puedes enviar a cocina los pedidos de hoy.');
          if (status === 'delivered' && !(await get('SELECT id FROM payments WHERE order_id=?', id))) fail('Caja debe registrar el pago antes de entregar.');
          if (status === 'cancelled') {
            if (await get('SELECT id FROM payments WHERE order_id=?', id)) fail('Un pedido pagado requiere gestionar su devolución. Esta versión no permite anularlo.');
            await releaseOrder(id, 'cancellation');
          }
          await run('UPDATE orders SET status=? WHERE id=?', status, id);
        });
      }
      async function saveMenu(body) {
        return await transaction(async () => {
          const date = validDate(body.date);
          if (date < today()) fail('No puedes editar un menú pasado.');
          const combo = money(body.combo_price);
          await run('INSERT INTO days(date,combo_price,published) VALUES (?,?,?) ON CONFLICT(date) DO UPDATE SET combo_price=excluded.combo_price,published=excluded.published', date, combo, body.published ? 1 : 0);
          if (!Array.isArray(body.items) || body.items.length > 80) fail('Menú inválido.');
          const keep = [];
          for (const item of body.items) {
            // Preserve legacy refreshments and their historical allocations unchanged.
            if (item.id && (await get("SELECT id FROM items WHERE id=? AND date=? AND (combo_eligible=1 OR kind='drink')", Number(item.id), date))) continue;
            if (item.kind === 'drink') fail('Registra las bebidas en Inventario de bebidas.');
            if (item.combo_eligible) fail('El vaso de refresco ya viene incluido en el completo; no se registra como producto.');
            const name = String(item.name || '').trim().slice(0, 100),
              stock = Number(item.stock);
            if (!name || !['soup', 'main', 'side', 'extra'].includes(item.kind) || !Number.isInteger(stock) || stock < 0 || stock > 10000) fail('Revisa nombre, categoría y cantidad de cada plato.');
            const price = money(item.price);
            if (item.photo !== undefined && (typeof item.photo !== 'string' || item.photo.length > 200000 || item.photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.photo))) fail('Foto inválida. Usa una imagen JPEG, PNG o WebP de hasta 150 KB.');
            if (item.id) {
              const old = await get('SELECT * FROM items WHERE id=? AND date=?', Number(item.id), date);
              if (!old) fail('Plato inválido.');
              if (stock < old.used) fail(`${name}: ya hay ${old.used} porciones comprometidas.`);
              if (old.used && old.kind !== item.kind) fail('No puedes cambiar la categoría de un plato comprometido.');
              await run('UPDATE items SET name=?,kind=?,price=?,stock=? WHERE id=?', name, item.kind, price, stock, old.id);
              keep.push(old.id);
            } else keep.push(Number((await run('INSERT INTO items(date,name,kind,price,stock) VALUES (?,?,?,?,?)', date, name, item.kind, price, stock)).lastInsertRowid));
            if (item.photo !== undefined) await run('UPDATE items SET photo=? WHERE id=?', item.photo, keep[keep.length - 1]);
            await run('UPDATE items SET combo_eligible=? WHERE id=?', item.kind === 'drink' && item.combo_eligible ? 1 : 0, keep[keep.length - 1]);
          }
          for (const old of await all('SELECT * FROM items WHERE date=?', date)) if (old.kind !== 'drink' && !old.combo_eligible && !keep.includes(old.id)) {
            if (old.used || (await get('SELECT order_id FROM allocations WHERE item_id=?', old.id))) fail('No puedes eliminar un plato con historial de pedidos. Puedes dejar su cantidad igual a las porciones comprometidas.');
            await run('DELETE FROM items WHERE id=?', old.id);
          }
        });
      }
      async function report(from, to) {
        validDate(from);
        validDate(to);
        if (from > to) fail('El rango de fechas no es válido.');
        const revenue = await all('SELECT date,method,SUM(amount) AS amount,COUNT(*) AS count FROM payments WHERE date BETWEEN ? AND ? GROUP BY date,method', from, to);
        const expenses = await all('SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY id DESC', from, to);
        const income = revenue.reduce((s, r) => s + r.amount, 0),
          spent = expenses.reduce((s, e) => s + e.amount, 0);
        const cash = revenue.filter(r => r.method === 'cash').reduce((s, r) => s + r.amount, 0),
          qr = income - cash;
        return {
          from,
          to,
          income,
          spent,
          balance: income - spent,
          cash,
          qr,
          revenue,
          expenses,
          count: revenue.reduce((s, r) => s + r.count, 0)
        };
      }
      async function snapshot(date) {
        return await transaction(async () => {
          await reconcile();
          return {
            today: today(),
            date,
            menu: await menu(date),
            orders: await orders(date),
            cash: await get('SELECT * FROM cash_days WHERE date=?', today()),
            report: await report(date, date)
          };
        });
      }
      return {
        db,
        all,
        get,
        run,
        transaction,
        today,
        stamp,
        reconcile,
        openCash,
        menu,
        orders,
        createOrder,
        orderForEdit,
        editOrder,
        pay,
        transition,
        saveMenu,
        report,
        snapshot,
        ...inventory,
        ...control
      };
    });
  } catch (error) {
    await db.close();
    throw error;
  }
}
