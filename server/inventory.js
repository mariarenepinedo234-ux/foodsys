// Shared beverage stock is independent of daily menu production.
export async function inventoryStore({
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
  initialize = true
}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,price INTEGER NOT NULL,stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0),minimum INTEGER NOT NULL DEFAULT 5,active INTEGER NOT NULL DEFAULT 1,photo TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS product_allocations(order_id INTEGER NOT NULL REFERENCES orders(id),product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS inventory_movements(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL,type TEXT NOT NULL,date TEXT NOT NULL,created_at TEXT NOT NULL,supplier TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',cost INTEGER NOT NULL DEFAULT 0,expense_id INTEGER REFERENCES expenses(id),order_id INTEGER REFERENCES orders(id),actor TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS legacy_products(item_id INTEGER PRIMARY KEY REFERENCES items(id),product_id INTEGER NOT NULL REFERENCES products(id));
 CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY);`);
  if (initialize && !(await get("SELECT name FROM migrations WHERE name='shared-beverages'"))) await transaction(async () => {
    const groups = new Map();
    for (const item of await all("SELECT * FROM items WHERE kind='drink' AND combo_eligible=0 ORDER BY date DESC,id DESC")) {
      const key = item.name.trim().toLocaleLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const items of groups.values()) {
      // A daily count is a snapshot, not a new delivery. Never sum repeated days.
      const item = items.find(i => i.date <= today()) || items[0];
      const id = Number((await run('INSERT INTO products(name,price,stock,photo) VALUES (?,?,?,?)', item.name, item.price, item.stock - item.used, item.photo)).lastInsertRowid);
      for (const old of items) await run('INSERT INTO legacy_products VALUES (?,?)', old.id, id);
      await run("INSERT INTO inventory_movements(product_id,quantity,type,date,created_at,note) VALUES (?,?,'migration',?,?,?)", id, item.stock - item.used, today(), stamp(), `Saldo importado del menú ${item.date}. Verifica una vez el conteo físico; no se sumaron los menús repetidos.`);
    }
    await run("INSERT INTO migrations VALUES ('shared-beverages')");
  });
  const integer = (value, min = 0) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > 1000000) fail('Cantidad inválida.');
    return n;
  };
  async function saveProduct(body) {
    return await transaction(async () => {
      if (body.photo !== undefined && (typeof body.photo !== 'string' || body.photo.length > 200000 || body.photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(body.photo))) fail('Foto inválida. Usa una imagen JPEG, PNG o WebP de hasta 150 KB.');
      const name = String(body.name || '').trim().slice(0, 100);
      if (!name) fail('Escribe el nombre de la bebida.');
      const price = money(body.price),
        minimum = integer(body.minimum),
        active = body.active === false ? 0 : 1;
      const duplicate = await get('SELECT id FROM products WHERE lower(trim(name))=lower(?) AND id<>?', name, Number(body.id) || 0);
      if (duplicate) fail('Ya existe una bebida con ese nombre.');
      if (body.id) {
        if (!(await get('SELECT id FROM products WHERE id=?', Number(body.id)))) fail('Bebida no encontrada.', 404);
        await run('UPDATE products SET name=?,price=?,minimum=?,active=? WHERE id=?', name, price, minimum, active, Number(body.id));
        if (body.photo !== undefined) await run('UPDATE products SET photo=? WHERE id=?', body.photo, Number(body.id));
        return Number(body.id);
      }
      const id = Number((await run('INSERT INTO products(name,price,minimum) VALUES (?,?,?)', name, price, minimum)).lastInsertRowid);
      if (body.photo !== undefined) await run('UPDATE products SET photo=? WHERE id=?', body.photo, id);
      const stock = integer(body.stock || 0);
      if (stock) await changeStock(id, stock, 'opening', null);
      return id;
    });
  }
  async function movement(body, actor = '') {
    return await transaction(async () => {
      const product = await get('SELECT * FROM products WHERE id=?', Number(body.productId) || 0);
      if (!product) fail('Bebida no encontrada.', 404);
      const adjustment = body.type === 'adjustment';
      if (!['receipt', 'adjustment'].includes(body.type)) fail('Movimiento inválido.');
      const quantity = integer(body.quantity, adjustment ? -1000000 : 1);
      if (!quantity) fail('La cantidad no puede ser cero.');
      const note = String(body.note || '').trim().slice(0, 500);
      if (adjustment && !note) fail('Explica el motivo del ajuste.');
      if (product.stock + quantity < 0 || product.stock + quantity > 1000000) fail('El movimiento dejaría un stock inválido.', 409);
      const date = validDate(body.date);
      if (date > today()) fail('Registra la entrada cuando recibas la mercadería.');
      const cost = body.cost === '' || body.cost === undefined || Number(body.cost) === 0 ? 0 : money(body.cost);
      let expense = null;
      if (adjustment && (cost || body.expense)) fail('Los ajustes no generan compras.');
      if (body.expense) {
        if (date !== today()) fail('Solo puedes registrar en caja gastos de hoy.');
        await openCash();
        if (!['cash', 'qr'].includes(body.method) || !cost) fail('Indica costo y medio de pago.');
        expense = Number((await run('INSERT INTO expenses(date,description,amount,method,created_at) VALUES (?,?,?,?,?)', date, `Compra de bebidas: ${product.name} (${quantity})`, cost, body.method, stamp())).lastInsertRowid);
      }
      await run('UPDATE products SET stock=stock+? WHERE id=?', quantity, product.id);
      await run('INSERT INTO inventory_movements(product_id,quantity,type,date,created_at,supplier,note,cost,expense_id,actor) VALUES (?,?,?,?,?,?,?,?,?,?)', product.id, quantity, body.type, date, stamp(), String(body.supplier || '').slice(0, 150), note, cost, expense, actor);
    });
  }
  async function changeStock(productId, quantity, type, orderId) {
    await run('UPDATE products SET stock=stock+? WHERE id=?', quantity, productId);
    await run('INSERT INTO inventory_movements(product_id,quantity,type,date,created_at,order_id) VALUES (?,?,?,?,?,?)', productId, quantity, type, today(), stamp(), orderId);
  }
  const inventory = async () => ({
    products: await all('SELECT * FROM products ORDER BY name,id'),
    movements: await all('SELECT m.*,p.name FROM inventory_movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT 200')
  });
  const catalog = async () => await all(`SELECT -id AS id,id AS "productId",name,'drink' AS kind,price,stock,0 AS used,stock AS available,0 AS combo_eligible,photo FROM products WHERE active=1 ORDER BY id`);
  return {
    inventory,
    saveProduct,
    movement,
    changeStock,
    catalog
  };
}
