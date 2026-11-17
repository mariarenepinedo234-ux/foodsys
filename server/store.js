import { controlStore } from './control.js';
import { inventoryStore } from './inventory.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function businessDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year','month','day'].map(k => parts.find(p => p.type === k).value).join('-');
}
export const localHour = (now = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/La_Paz', hour: '2-digit', hourCycle: 'h23' }).format(now));
export function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function checkPassword(password, hash) { const [salt, value] = hash.split(':'); return timingSafeEqual(Buffer.from(value,'hex'), Buffer.from(hashPassword(password,salt).split(':')[1],'hex')); }
export function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
export const money = value => { const n = Number(value); if (!Number.isFinite(n) || n < 0.01 || n > 1000000) fail('Importe inválido.'); return Math.round(n * 100); };
export function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail('Fecha inválida.'); return value; }
export function createStore(filename, { seed = true, now = () => new Date() } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive:true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
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
  if(!db.prepare('PRAGMA table_info(items)').all().some(c=>c.name==='combo_eligible')) {
    db.exec("ALTER TABLE items ADD COLUMN combo_eligible INTEGER NOT NULL DEFAULT 0; UPDATE items SET combo_eligible=1 WHERE id IN (SELECT MIN(id) FROM items WHERE kind='drink' GROUP BY date)");
  }
  if(!db.prepare('PRAGMA table_info(items)').all().some(c=>c.name==='photo')) db.exec("ALTER TABLE items ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
  if(!db.prepare('PRAGMA table_info(lines)').all().some(c=>c.name==='selection')) db.exec('ALTER TABLE lines ADD COLUMN selection TEXT');
  if(!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='version')) db.exec('ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  const all = (sql,...args) => db.prepare(sql).all(...args);
  const get = (sql,...args) => db.prepare(sql).get(...args);
  const run = (sql,...args) => db.prepare(sql).run(...args);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value=fn(); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  const today = () => businessDate(now());
  const stamp = () => now().toISOString();
  function reconcile() {
    const date=today();
    const pending=all('SELECT date FROM cash_days WHERE closed_at IS NULL AND (date<? OR (date=? AND ? >=18))',date,date,localHour(now()));
    for(const day of pending){run("UPDATE cash_days SET closed_at=?,note=CASE WHEN note='' THEN 'Cierre automático' ELSE note END WHERE date=?",stamp(),day.date);control.audit('cash_auto_closed',day.date,null);}
    const inserted=run('INSERT OR IGNORE INTO cash_days(date,opened_at) VALUES (?,?)',date,stamp());
    if(inserted.changes){control.audit('cash_auto_opened',date,null);if(localHour(now())>=18){run("UPDATE cash_days SET closed_at=?,note='Cierre automático a las 18:00' WHERE date=?",stamp(),date);control.audit('cash_auto_closed',date,null);}}
    run('DELETE FROM sessions WHERE expires<?',Date.now());
  }
  function openCash() { reconcile(); const day=get('SELECT * FROM cash_days WHERE date=?',today()); if(day.closed_at) fail('La caja de hoy está cerrada. No se pueden registrar movimientos.',409); return day; }
  const control=controlStore({db,all,get,run,transaction,today,stamp,openCash,reconcile,report,fail,hashPassword});
  if(seed) {
    if(!get('SELECT id FROM users LIMIT 1')) for(const [name,username,role] of [['María','admin','admin'],['Caja','cajero','cashier'],['Cocina','cocina','kitchen']]) {
      if(!get('SELECT id FROM users WHERE username=?',username)) run('INSERT INTO users(name,username,password,role) VALUES (?,?,?,?)',name,username,hashPassword(process.env[`${username.toUpperCase()}_PASSWORD`] || `${username}123`),role);
    }
    if(!get('SELECT date FROM days LIMIT 1')) {
      run('INSERT INTO days(date,combo_price,published) VALUES (?,?,1)',today(),2500);
      for(const [name,kind,price,stock] of [['Sopa de maní','soup',1000,50],['Milanesa de pollo','main',1800,35],['Asado a la olla','main',1800,25],['Coca-Cola personal','drink',700,20],['Porción de arroz','extra',500,20]]) run('INSERT INTO items(date,name,kind,price,stock,combo_eligible) VALUES (?,?,?,?,?,?)',today(),name,kind,price,stock,0);
    }
  }
  const inventory=inventoryStore({db,all,get,run,transaction,today,stamp,openCash,fail,money,validDate});
  reconcile();
  function menu(date, publicOnly=false) { validDate(date); const day=get('SELECT * FROM days WHERE date=?',date); return day && (!publicOnly || day.published) ? {...day,items:[...all("SELECT *,stock-used AS available FROM items WHERE date=? AND combo_eligible=0 AND kind<>'drink' ORDER BY id",date),...inventory.catalog()]} : {date,combo_price:2500,published:0,items:[]}; }
  function orders(date) { return all(`SELECT o.*,p.method,p.amount AS paid FROM orders o LEFT JOIN payments p ON p.order_id=o.id WHERE o.date=? ORDER BY o.id DESC`,date).map(o=>({...o,lines:all('SELECT * FROM lines WHERE order_id=?',o.id)})); }
  function createOrder(body, source='staff', editing=null, actor=null) { return transaction(()=>{
    let previous=null,oldLines=[];
    if(editing!==null){
      previous=editableOrder(editing);oldLines=editLines(previous.id);
      if(!Number.isInteger(body.version)||body.version!==previous.version)fail('El pedido cambió. Vuelve a abrirlo antes de editar.',409);
      if(body.date!==undefined&&body.date!==previous.date)fail('No se puede cambiar la fecha del pedido.');
      if(body.payment)fail('Guarda la edición antes de registrar el cobro.');
      source=previous.source;body={...body,date:previous.date,type:previous.type,customer:body.customer??previous.customer,phone:body.phone??previous.phone,note:body.note??previous.note};
      releaseOrder(previous.id,'edit_release');
    }
    const date=validDate(body.date);
    if(date<today()) fail('No se aceptan pedidos para fechas pasadas.');
    const day=get('SELECT * FROM days WHERE date=?',date);
    if(!day || (source==='public' && !previous && !day.published)) fail('El menú aún no está publicado.');
    const reservation=source==='public' || body.type==='reservation';
    if(!reservation && date!==today()) fail('Las ventas deben corresponder a hoy.');
    if(!reservation) openCash();
    const customer=String(body.customer||'').trim().slice(0,100) || (source==='staff'?'Cliente sin nombre':'');
    if(!customer) fail('Escribe el nombre del comensal.');
    if(!Array.isArray(body.lines) || body.lines.length<1 || body.lines.length>30) fail('Agrega al menos un plato.');
    const allocations=new Map(), products=new Map(), lines=[]; let total=0;
    const allocate=(id,quantity,kind)=>{ const item=get('SELECT * FROM items WHERE id=? AND date=?',Number(id)||0,date); if(!item || (kind && item.kind!==kind)) fail('El plato elegido no está en este menú.'); allocations.set(item.id,(allocations.get(item.id)||0)+quantity); return item; };
    for(const line of body.lines) {
      const q=Number(line.quantity); if(!Number.isInteger(q)||q<1||q>100) fail('Cantidad inválida.');
      let price,label;const choice=normalizeChoice(line);
      if(line.kind==='product') {
        const product=get('SELECT * FROM products WHERE id=? AND active=1',Number(line.productId)||0);if(!product)fail('Bebida no disponible.');
        products.set(product.id,(products.get(product.id)||0)+q);price=product.price;label=product.name;
      }
      else if(line.kind==='combo') { const soup=allocate(line.soupId,q,'soup'), main=allocate(line.mainId,q,'main'); price=day.combo_price; const hasSides=Boolean(get("SELECT id FROM items WHERE date=? AND kind='side' LIMIT 1",date));
        const side=hasSides||line.sideId?allocate(line.sideId,q,'side'):null;
        label=`Completo · ${soup.name} + ${main.name}${side?' + '+side.name:''} + vaso de refresco incluido`; }
      else { const item=allocate(line.itemId,q); if(item.kind==='drink'&&!item.combo_eligible)fail('Selecciona la bebida desde el inventario actualizado.');
      if(item.combo_eligible) fail('El refresco solo se sirve incluido en el completo.'); price=item.price;label=item.name; }
      const original=oldLines.find(l=>l.id===Number(line.lineId));
      if(original?.choice&&JSON.stringify(original.choice)===JSON.stringify(choice)){price=original.price;label=original.label;}
      lines.push({label,quantity:q,price,selection:JSON.stringify(choice)});total+=price*q;
    }
    for(const [id,q] of allocations) { const item=get('SELECT * FROM items WHERE id=?',id); if(item.stock-item.used<q) fail(`No alcanza ${item.name}. Quedan ${item.stock-item.used} porciones.`,409); }
    for(const [id,q] of products){const p=get('SELECT * FROM products WHERE id=?',id);if(p.stock<q)fail(`No alcanza ${p.name}. Quedan ${p.stock} unidades.`,409);}
    if(body.expectedTotal !== undefined && body.expectedTotal !== total) fail('El precio del menú cambió. Actualiza la página y revisa tu pedido antes de confirmarlo.',409);
    let id;
    if(previous){
      id=previous.id;run('DELETE FROM lines WHERE order_id=?',id);run('DELETE FROM allocations WHERE order_id=?',id);run('DELETE FROM product_allocations WHERE order_id=?',id);
      run('UPDATE orders SET customer=?,phone=?,note=?,total=?,version=version+1 WHERE id=?',customer,String(body.phone||'').slice(0,30),String(body.note||'').slice(0,500),total,id);
    }else id=Number(run('INSERT INTO orders(date,customer,phone,note,type,source,status,total,created_at) VALUES (?,?,?,?,?,?,?,?,?)',date,customer,String(body.phone||'').slice(0,30),String(body.note||'').slice(0,500),reservation?'reservation':'sale',source,reservation?'reserved':'queued',total,stamp()).lastInsertRowid);
    for(const l of lines) run('INSERT INTO lines(order_id,label,quantity,price,selection) VALUES (?,?,?,?,?)',id,l.label,l.quantity,l.price,l.selection);
    for(const [itemId,q] of allocations) {run('INSERT INTO allocations VALUES (?,?,?)',id,itemId,q);run('UPDATE items SET used=used+? WHERE id=?',q,itemId);}
    for(const [productId,q] of products){run('INSERT INTO product_allocations VALUES (?,?,?)',id,productId,q);inventory.changeStock(productId,-q,previous?'edit_reservation':'order',id);}
    if(previous)control.audit('order_updated',id,actor,{before:{customer:previous.customer,phone:previous.phone,note:previous.note,total:previous.total,lines:oldLines.map(l=>({label:l.label,quantity:l.quantity,price:l.price}))},after:{customer,phone:String(body.phone||'').slice(0,30),note:String(body.note||'').slice(0,500),total,lines:lines.map(l=>({label:l.label,quantity:l.quantity,price:l.price}))}});
    if(source==='staff' && body.payment) pay(id,body.payment);
    return {id,total,status:previous?.status||(reservation?'reserved':'queued'),version:previous?previous.version+1:0};
  }); }
  function normalizeChoice(line){
    if(line.kind==='combo')return {kind:'combo',soupId:Number(line.soupId)||0,mainId:Number(line.mainId)||0,sideId:Number(line.sideId)||0};
    if(line.kind==='product')return {kind:'product',productId:Number(line.productId)||0};
    return {kind:'item',itemId:Number(line.itemId)||0};
  }
  function editableOrder(id){
    const order=get('SELECT * FROM orders WHERE id=?',Number(id));if(!order)fail('Pedido no encontrado.',404);
    if(!['reserved','queued'].includes(order.status))fail('Solo se editan reservas o pedidos que todavía no están en preparación.',409);
    if(get('SELECT id FROM payments WHERE order_id=?',order.id))fail('No se puede editar un pedido pagado.',409);
    if(order.date<today())fail('No se puede editar un pedido pasado.',409);
    return order;
  }
  function releaseOrder(id,reason){
      for(const a of all('SELECT * FROM product_allocations WHERE order_id=?',id))inventory.changeStock(a.product_id,a.quantity,reason,id);
      for(const a of all('SELECT a.quantity,l.product_id FROM allocations a JOIN legacy_products l ON l.item_id=a.item_id WHERE a.order_id=?',id))inventory.changeStock(a.product_id,a.quantity,reason,id);
      for(const a of all('SELECT * FROM allocations WHERE order_id=?',id)) run('UPDATE items SET used=used-? WHERE id=?',a.quantity,a.item_id);
  }
  function editLines(id){
    const items=all('SELECT i.* FROM allocations a JOIN items i ON i.id=a.item_id WHERE a.order_id=?',id);
    const products=all('SELECT p.* FROM product_allocations a JOIN products p ON p.id=a.product_id WHERE a.order_id=?',id);
    return all('SELECT * FROM lines WHERE order_id=?',id).map(line=>{
      if(line.selection)return {...line,choice:JSON.parse(line.selection)};
      // Older versions stored only display text. Infer only unambiguous choices; otherwise ask staff to select again.
      let choices=[];
      if(line.label.startsWith('Completo · ')){
        for(const soup of items.filter(i=>i.kind==='soup'))for(const main of items.filter(i=>i.kind==='main')){
          const sides=[null,...items.filter(i=>i.kind==='side')];for(const side of sides)if(['vaso de refresco incluido',...items.filter(i=>i.kind==='drink').map(i=>i.name)].some(drink=>line.label===`Completo · ${soup.name} + ${main.name}${side?' + '+side.name:''} + ${drink}`))choices.push(normalizeChoice({kind:'combo',soupId:soup.id,mainId:main.id,sideId:side?.id}));
        }
        if(!choices.length){const soups=items.filter(i=>i.kind==='soup'),mains=items.filter(i=>i.kind==='main');if(soups.length===1&&mains.length===1)choices.push(normalizeChoice({kind:'combo',soupId:soups[0].id,mainId:mains[0].id}));}
      }else{
        for(const item of items.filter(i=>i.name===line.label)){
          const legacy=get('SELECT product_id FROM legacy_products WHERE item_id=?',item.id);
          if(legacy)choices.push(normalizeChoice({kind:'product',productId:legacy.product_id}));else if(item.kind!=='drink')choices.push(normalizeChoice({kind:'item',itemId:item.id}));
        }
        for(const p of products.filter(p=>p.name===line.label))choices.push(normalizeChoice({kind:'product',productId:p.id}));
      }
      return {...line,choice:choices.length===1?choices[0]:null};
    });
  }
  function orderForEdit(id){
    const order=editableOrder(id),data=menu(order.date);
    const own=new Map(all('SELECT item_id,SUM(quantity) AS q FROM allocations WHERE order_id=? GROUP BY item_id',id).map(a=>[a.item_id,a.q]));
    const ownProducts=new Map(all('SELECT product_id,SUM(quantity) AS q FROM product_allocations WHERE order_id=? GROUP BY product_id',id).map(a=>[a.product_id,a.q]));
    for(const a of all('SELECT l.product_id,SUM(a.quantity) AS q FROM allocations a JOIN legacy_products l ON l.item_id=a.item_id WHERE a.order_id=? GROUP BY l.product_id',id))ownProducts.set(a.product_id,(ownProducts.get(a.product_id)||0)+a.q);
    data.items=data.items.map(i=>({...i,available:i.available+(i.productId?ownProducts.get(i.productId)||0:own.get(i.id)||0)}));
    return {order:{...order,lines:editLines(id)},menu:data,history:all("SELECT actor_name,actor_username,created_at,details FROM audit_log WHERE action='order_updated' AND entity_id=? ORDER BY id DESC LIMIT 20",String(id)).map(e=>({...e,details:JSON.parse(e.details)}))};
  }
  const editOrder=(id,body,actor)=>createOrder(body,'staff',Number(id),actor);
  function pay(id,method) {
    if(!['cash','qr'].includes(method)) fail('Medio de pago inválido.'); openCash();
    const order=get('SELECT * FROM orders WHERE id=?',id); if(!order || order.status==='cancelled') fail('Pedido no disponible.');
    if(get('SELECT id FROM payments WHERE order_id=?',id)) fail('Este pedido ya está pagado.',409);
    run('INSERT INTO payments(order_id,date,method,amount,created_at) VALUES (?,?,?,?,?)',id,today(),method,order.total,stamp());
  }
  function transition(id,status,role) { return transaction(()=>{
    const order=get('SELECT * FROM orders WHERE id=?',id); if(!order) fail('Pedido no encontrado.',404);
    const allowed={reserved:['queued','cancelled'],queued:['preparing','cancelled'],preparing:['ready'],ready:['delivered']};
    if(!allowed[order.status]?.includes(status)) fail('Este cambio de estado no es válido.',409);
    if(role==='kitchen' && !['preparing','ready','delivered'].includes(status)) fail('Acceso restringido.',403);
    if(role==='cashier' && !['queued','cancelled'].includes(status)) fail('La preparación y entrega corresponden a cocina.',403);
    if(status==='queued' && order.date!==today()) fail('Solo puedes enviar a cocina los pedidos de hoy.');
    if(status==='delivered' && !get('SELECT id FROM payments WHERE order_id=?',id)) fail('Caja debe registrar el pago antes de entregar.');
    if(status==='cancelled') {
      if(get('SELECT id FROM payments WHERE order_id=?',id)) fail('Un pedido pagado requiere gestionar su devolución. Esta versión no permite anularlo.');
      releaseOrder(id,'cancellation');
    }
    run('UPDATE orders SET status=? WHERE id=?',status,id);
  }); }
  function saveMenu(body) {return transaction(()=>{
    const date=validDate(body.date); if(date<today()) fail('No puedes editar un menú pasado.');
    const combo=money(body.combo_price);
    run('INSERT INTO days(date,combo_price,published) VALUES (?,?,?) ON CONFLICT(date) DO UPDATE SET combo_price=excluded.combo_price,published=excluded.published',date,combo,body.published?1:0);
    if(!Array.isArray(body.items)||body.items.length>80) fail('Menú inválido.');
    const keep=[];
    for(const item of body.items) {
      // Preserve legacy refreshments and their historical allocations unchanged.
      if(item.id && get("SELECT id FROM items WHERE id=? AND date=? AND (combo_eligible=1 OR kind='drink')",Number(item.id),date)) continue;
      if(item.kind==='drink')fail('Registra las bebidas en Inventario de bebidas.');
      if(item.combo_eligible) fail('El vaso de refresco ya viene incluido en el completo; no se registra como producto.');
      const name=String(item.name||'').trim().slice(0,100), stock=Number(item.stock);
      if(!name||!['soup','main','side','extra'].includes(item.kind)||!Number.isInteger(stock)||stock<0||stock>10000) fail('Revisa nombre, categoría y cantidad de cada plato.');
      const price=money(item.price);
      if(item.photo!==undefined && (typeof item.photo!=='string' || item.photo.length>200000 || (item.photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.photo)))) fail('Foto inválida. Usa una imagen JPEG, PNG o WebP de hasta 150 KB.');
      if(item.id) {const old=get('SELECT * FROM items WHERE id=? AND date=?',Number(item.id),date);if(!old) fail('Plato inválido.');if(stock<old.used) fail(`${name}: ya hay ${old.used} porciones comprometidas.`); if(old.used && old.kind!==item.kind) fail('No puedes cambiar la categoría de un plato comprometido.');run('UPDATE items SET name=?,kind=?,price=?,stock=? WHERE id=?',name,item.kind,price,stock,old.id);keep.push(old.id);}
      else keep.push(Number(run('INSERT INTO items(date,name,kind,price,stock) VALUES (?,?,?,?,?)',date,name,item.kind,price,stock).lastInsertRowid));
      if(item.photo!==undefined) run('UPDATE items SET photo=? WHERE id=?',item.photo,keep[keep.length-1]);
      run('UPDATE items SET combo_eligible=? WHERE id=?',item.kind==='drink'&&item.combo_eligible?1:0,keep[keep.length-1]);
    }
    for(const old of all('SELECT * FROM items WHERE date=?',date)) if(old.kind!=='drink' && !old.combo_eligible && !keep.includes(old.id)) {if(old.used || get('SELECT order_id FROM allocations WHERE item_id=?',old.id)) fail('No puedes eliminar un plato con historial de pedidos. Puedes dejar su cantidad igual a las porciones comprometidas.');run('DELETE FROM items WHERE id=?',old.id);}
  });}
  function report(from,to) {
    validDate(from);validDate(to);if(from>to) fail('El rango de fechas no es válido.');
    const revenue=all('SELECT date,method,SUM(amount) AS amount,COUNT(*) AS count FROM payments WHERE date BETWEEN ? AND ? GROUP BY date,method',from,to);
    const expenses=all('SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY id DESC',from,to);
    const income=revenue.reduce((s,r)=>s+r.amount,0), spent=expenses.reduce((s,e)=>s+e.amount,0);
    const cash=revenue.filter(r=>r.method==='cash').reduce((s,r)=>s+r.amount,0), qr=income-cash;
    return {from,to,income,spent,balance:income-spent,cash,qr,revenue,expenses,count:revenue.reduce((s,r)=>s+r.count,0)};
  }
  function snapshot(date) {reconcile();return {today:today(),date,menu:menu(date),orders:orders(date),cash:get('SELECT * FROM cash_days WHERE date=?',today()),report:report(date,date)};}
  return {db,all,get,run,transaction,today,stamp,reconcile,openCash,menu,orders,createOrder,orderForEdit,editOrder,pay,transition,saveMenu,report,snapshot,...inventory,...control};
}
