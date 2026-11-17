import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, businessDate, localHour } from './support/store.js';
import { createApp } from '../server/index.js';
const fixed = '2026-11-13T16:00:00.000Z'; // Noon in Bolivia
async function store() {
  return await createStore(':memory:', {
    now: () => new Date(fixed)
  });
}
async function combo(s, overrides = {}) {
  const menu = await s.menu(s.today());
  return {
    date: s.today(),
    customer: 'Ana',
    type: 'reservation',
    lines: [{
      kind: 'combo',
      soupId: menu.items.find(i => i.kind === 'soup').id,
      mainId: menu.items.find(i => i.kind === 'main').id,
      quantity: 1
    }],
    ...overrides
  };
}
test('business clock uses Bolivia and reconciles automatic opening and closing', async () => {
  assert.equal(businessDate(new Date('2026-11-14T02:00:00Z')), '2026-11-13');
  assert.equal(localHour(new Date('2026-11-14T02:00:00Z')), 22);
  let clock = new Date(fixed);
  const s = await createStore(':memory:', {
    now: () => clock
  });
  assert.equal((await s.snapshot(s.today())).cash.closed_at, null);
  clock = new Date('2026-11-13T22:00:00Z');
  await s.reconcile();
  assert.ok((await s.snapshot(s.today())).cash.closed_at);
  clock = new Date('2026-11-14T15:00:00Z');
  await s.reconcile();
  assert.equal((await s.snapshot(s.today())).cash.closed_at, null);
  assert.ok((await s.get('SELECT closed_at FROM cash_days WHERE date=?', '2026-11-13')).closed_at);
  await s.db.close();
});
test('complete includes refreshment automatically and reserves soup and chosen main; payment and kitchen do not double deduct', async () => {
  const s = await store(),
    before = await s.menu(s.today()),
    o = await s.createOrder(await combo(s));
  assert.equal(o.total, 2500);
  const after = await s.menu(s.today());
  for (const kind of ['soup', 'main']) {
    const item = before.items.find(i => i.kind === kind);
    assert.equal(after.items.find(i => i.id === item.id).available, item.available - 1);
  }
  assert.match((await s.orders(s.today()))[0].lines[0].label, /vaso de refresco incluido/);
  const drink = before.items.find(i => i.kind === 'drink');
  assert.equal(after.items.find(i => i.id === drink.id).available, drink.available);
  const other = before.items.filter(i => i.kind === 'main')[1];
  assert.equal(after.items.find(i => i.id === other.id).available, other.available);
  await s.transaction(async () => await s.pay(o.id, 'qr'));
  await s.transition(o.id, 'queued', 'cashier');
  await assert.rejects(async () => await s.transition(o.id, 'preparing', 'cashier'), /corresponden a cocina/);
  await s.transition(o.id, 'preparing', 'kitchen');
  await s.transition(o.id, 'ready', 'kitchen');
  await s.transition(o.id, 'delivered', 'kitchen');
  assert.deepEqual(await s.menu(s.today()), after);
  await assert.rejects(async () => await s.pay(o.id, 'cash'), /ya está pagado/);
  await s.db.close();
});
test('stock shortage rolls back all allocations, lines and payments', async () => {
  const s = await store(),
    menu = await s.menu(s.today()),
    body = await combo(s);
  body.lines[0].quantity = 51;
  await assert.rejects(async () => await s.createOrder(body), /No alcanza/);
  assert.deepEqual(await s.menu(s.today()), menu);
  assert.equal((await s.all('SELECT * FROM orders')).length, 0);
  assert.equal((await s.all('SELECT * FROM payments')).length, 0);
  await s.db.close();
});
test('singles, repeated lines, cancellation and paid cancellation guard', async () => {
  const s = await store(),
    i = (await s.menu(s.today())).items.find(i => i.kind === 'soup');
  const o = await s.createOrder({
    date: s.today(),
    customer: 'Luis',
    type: 'reservation',
    lines: [{
      itemId: i.id,
      quantity: 2
    }, {
      itemId: i.id,
      quantity: 3
    }]
  });
  assert.equal((await s.get('SELECT used FROM items WHERE id=?', i.id)).used, 5);
  await s.transition(o.id, 'cancelled', 'cashier');
  assert.equal((await s.get('SELECT used FROM items WHERE id=?', i.id)).used, 0);
  await assert.rejects(async () => await s.transition(o.id, 'cancelled', 'cashier'), /no es válido/);
  const paid = await s.createOrder(await combo(s, {
    payment: 'cash'
  }));
  await assert.rejects(async () => await s.transition(paid.id, 'cancelled', 'admin'), /devolución/);
  await s.db.close();
});
test('closed till blocks payments and cash sales but permits unpaid future reservations', async () => {
  const s = await store();
  await s.run('UPDATE cash_days SET closed_at=? WHERE date=?', fixed, s.today());
  await assert.rejects(async () => await s.createOrder(await combo(s, {
    type: 'sale',
    payment: 'cash'
  })), /cerrada/);
  assert.equal((await s.all('SELECT * FROM orders')).length, 0);
  await s.saveMenu({
    date: '2026-11-14',
    combo_price: 25,
    published: true,
    items: [{
      name: 'Sopa',
      kind: 'soup',
      price: 10,
      stock: 10
    }]
  });
  const i = (await s.menu('2026-11-14')).items[0];
  const o = await s.createOrder({
    date: '2026-11-14',
    customer: 'Ana',
    type: 'reservation',
    lines: [{
      itemId: i.id,
      quantity: 1
    }]
  });
  assert.equal(o.status, 'reserved');
  await assert.rejects(async () => await s.transition(o.id, 'queued', 'cashier'), /hoy/);
  await s.db.close();
});
test('daily reports separate cash and QR and subtract expenses in integer cents', async () => {
  const s = await store();
  await s.createOrder(await combo(s, {
    payment: 'cash'
  }));
  await s.createOrder(await combo(s, {
    payment: 'qr'
  }));
  await s.run('INSERT INTO expenses(date,description,amount,method,created_at) VALUES (?,?,?,?,?)', s.today(), 'Verduras', 850, 'cash', fixed);
  const r = await s.report(s.today(), s.today());
  assert.equal(r.income, 5000);
  assert.equal(r.cash, 2500);
  assert.equal(r.qr, 2500);
  assert.equal(r.balance, 4150);
  assert.equal(r.count, 2);
  await s.db.close();
});
test('menu edits cannot reduce reserved portions or remove historical items; previous order prices remain', async () => {
  const s = await store();
  const o = await s.createOrder(await combo(s));
  const before = await s.menu(s.today());
  const body = {
    date: s.today(),
    combo_price: 30,
    published: true,
    items: before.items.filter(i => !i.productId).map(i => ({
      ...i,
      price: i.price / 100
    }))
  };
  body.items[0].stock = 0;
  await assert.rejects(async () => await s.saveMenu(body), /comprometidas/);
  assert.deepEqual(await s.menu(s.today()), before);
  body.items[0].stock = 50;
  await s.saveMenu(body);
  assert.equal((await s.orders(s.today())).find(i => i.id === o.id).total, 2500);
  await s.db.close();
});
test('public reservation cannot mark itself paid or bypass publication and quantity validation', async () => {
  const s = await store();
  const order = await s.createOrder(await combo(s, {
    phone: '70000000',
    payment: 'qr',
    type: 'sale'
  }), 'public');
  assert.equal(order.status, 'reserved');
  assert.equal((await s.all('SELECT * FROM payments')).length, 0);
  await s.run('UPDATE days SET published=0');
  await assert.rejects(async () => await s.createOrder(await combo(s), 'public'), /publicado/);
  await s.run('UPDATE days SET published=1');
  const body = await combo(s);
  body.lines[0].quantity = -1;
  await assert.rejects(async () => await s.createOrder(body), /Cantidad/);
  await s.db.close();
});
let server, base, s;
before(async () => {
  s = await store();
  server = createApp(s).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await new Promise(r => server.close(r));
  await s.db.close();
});
async function request(path, body, cookie) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : {
        'Content-Type': 'application/json'
      }),
      ...(cookie ? {
        Cookie: cookie
      } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    status: res.status,
    data: await res.json(),
    cookie: res.headers.get('set-cookie')?.split(';')[0]
  };
}
test('HTTP authentication, role permissions, public booking, staff payment and logout', async () => {
  assert.equal((await request('/state')).status, 401);
  assert.equal((await request('/login', {
    username: 'admin',
    password: 'wrong'
  })).status, 401);
  const admin = await request('/login', {
      username: 'admin',
      password: 'admin123'
    }),
    cashier = await request('/login', {
      username: 'cajero',
      password: 'cajero123'
    }),
    kitchen = await request('/login', {
      username: 'cocina',
      password: 'cocina123'
    });
  assert.equal(admin.status, 200);
  assert.ok(admin.cookie);
  assert.equal((await request('/menu', {}, cashier.cookie)).status, 403);
  assert.equal((await request('/expenses', {
    description: 'x',
    amount: 1,
    method: 'cash'
  }, kitchen.cookie)).status, 403);
  assert.equal((await request('/reports?from=2026-11-13&to=2026-11-13', undefined, cashier.cookie)).status, 403);
  assert.equal((await request('/public/menu?date=2026-11-13')).data.menu.published, 1);
  const booking = await request('/public/reservations', await combo(s, {
    phone: '70000000',
    payment: 'qr'
  }));
  assert.equal(booking.status, 201);
  assert.equal((await request(`/orders/${booking.data.id}/pay`, {
    method: 'cash'
  }, cashier.cookie)).status, 200);
  assert.equal((await request(`/orders/${booking.data.id}/pay`, {
    method: 'cash'
  }, cashier.cookie)).status, 409);
  const kitchenState = await request('/state', undefined, kitchen.cookie);
  assert.equal(kitchenState.data.report, undefined);
  assert.equal((await request('/logout', {}, cashier.cookie)).status, 200);
  assert.equal((await request('/me', undefined, cashier.cookie)).status, 401);
});
test('HTTP cash workflow guards opening balance and stores reconciled closing', async () => {
  const admin = await request('/login', {
    username: 'admin',
    password: 'admin123'
  });
  assert.equal((await request('/cash/opening', {
    amount: 100
  }, admin.cookie)).status, 400);
  assert.equal((await request('/expenses', {
    description: 'Compras',
    amount: 5,
    method: 'cash'
  }, admin.cookie)).status, 200);
  assert.equal((await request('/cash/close', {
    counted: 20,
    note: 'Sin diferencia'
  }, admin.cookie)).status, 200);
  assert.equal((await request('/expenses', {
    description: 'Compras',
    amount: 5,
    method: 'cash'
  }, admin.cookie)).status, 409);
  assert.equal((await request('/state', undefined, admin.cookie)).data.cash.counted, 2000);
});
test('combo does not need a drink product and rejects a stale checkout price', async () => {
  const s = await store();
  await s.run('UPDATE products SET active=0');
  const order = await s.createOrder(await combo(s));
  assert.equal(order.total, 2500);
  assert.match((await s.orders(s.today()))[0].lines[0].label, /vaso de refresco incluido/);
  await assert.rejects(async () => await s.createOrder(await combo(s, {
    expectedTotal: 1
  })), /precio del menú cambió/);
  assert.equal((await s.all('SELECT * FROM orders')).length, 1);
  await s.db.close();
});
test('concurrent HTTP reservations cannot oversell the final portion', async () => {
  const isolated = await store(),
    item = (await isolated.menu(isolated.today())).items.find(i => i.kind === 'extra');
  await isolated.run('UPDATE items SET stock=1 WHERE id=?', item.id);
  const api = createApp(isolated),
    srv = api.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/public/reservations`,
      body = {
        date: isolated.today(),
        customer: 'Prueba simultánea',
        phone: '70000000',
        lines: [{
          itemId: item.id,
          quantity: 1
        }]
      };
    const responses = await Promise.all([1, 2].map(() => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })));
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.equal((await isolated.get('SELECT used FROM items WHERE id=?', item.id)).used, 1);
    await Promise.all(responses.map(r => r.json()));
  } finally {
    await new Promise(r => srv.close(r));
    await isolated.db.close();
  }
});
test('unnamed staff orders get the default without changing named or public orders', async () => {
  const s = await store();
  await s.createOrder(await combo(s, {
    customer: '  '
  }));
  await s.createOrder(await combo(s, {
    customer: ' Beatriz '
  }));
  assert.deepEqual((await s.orders(s.today())).map(o => o.customer), ['Beatriz', 'Cliente sin nombre']);
  await assert.rejects(async () => await s.createOrder(await combo(s, {
    customer: ''
  }), 'public'), /nombre/);
  await s.db.close();
});
test('photos survive saving, omission and restart; migration preserves existing sales and stock', async () => {
  const {
    mkdtempSync,
    rmSync
  } = await import('node:fs');
  const {
    tmpdir
  } = await import('node:os');
  const {
    join
  } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'foodsys-migration-')),
    path = join(dir, 'legacy.sqlite');
  let s;
  try {
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    await s.createOrder(await combo(s, {
      payment: 'qr'
    }));
    const orders = await s.orders(s.today()),
      menu = await s.menu(s.today()),
      report = await s.report(s.today(), s.today());
    await s.db.exec('ALTER TABLE items DROP COLUMN photo');
    await s.db.close();
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    assert.deepEqual(await s.orders(s.today()), orders);
    assert.deepEqual(await s.menu(s.today()), menu);
    assert.deepEqual(await s.report(s.today(), s.today()), report);
    const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
    const body = {
      date: s.today(),
      combo_price: 25,
      published: true,
      items: menu.items.filter(i => !i.productId).map(i => ({
        ...i,
        price: i.price / 100,
        photo
      }))
    };
    await s.saveMenu(body);
    body.items.forEach(i => delete i.photo);
    await s.saveMenu(body);
    assert.equal((await s.menu(s.today())).items[0].photo, photo);
    body.items[0].photo = 'data:image/svg+xml;base64,PHN2Zz4=';
    await assert.rejects(async () => await s.saveMenu(body), /Foto inválida/);
    await s.db.close();
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    assert.equal((await s.menu(s.today())).items[0].photo, photo);
    assert.deepEqual(await s.orders(s.today()), orders);
    body.items[0].photo = '';
    await s.saveMenu(body);
    assert.equal((await s.menu(s.today())).items[0].photo, '');
  } finally {
    s?.db.close();
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('HTTP menu accepts photo payloads above the old 100 KB limit and exposes them publicly', async () => {
  const isolated = await store(),
    app = createApp(isolated),
    srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'admin',
        password: 'admin123'
      })
    });
    await login.json();
    const photo = 'data:image/jpeg;base64,' + 'A'.repeat(120000),
      menu = await isolated.menu(isolated.today());
    const res = await fetch(url + '/api/menu', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: login.headers.get('set-cookie').split(';')[0]
      },
      body: JSON.stringify({
        date: isolated.today(),
        combo_price: 25,
        published: true,
        items: menu.items.filter(i => !i.productId).map((i, index) => ({
          ...i,
          price: i.price / 100,
          photo: index ? '' : photo
        }))
      })
    });
    assert.equal(res.status, 200);
    await res.json();
    const publicMenu = await fetch(url + '/api/public/menu?date=' + isolated.today());
    assert.equal((await publicMenu.json()).menu.items[0].photo, photo);
    const page = await fetch(url + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="app"/);
  } finally {
    await new Promise(r => srv.close(r));
    await isolated.db.close();
  }
});
test('legacy refreshment stock and orders survive menu edits and restart; cancellation restores original allocations', async () => {
  const {
      mkdtempSync,
      rmSync
    } = await import('node:fs'),
    {
      tmpdir
    } = await import('node:os'),
    {
      join
    } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'foodsys-legacy-drink-')),
    path = join(dir, 'foodsys.sqlite');
  let s;
  try {
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    const drinkId = Number((await s.run('INSERT INTO items(date,name,kind,price,stock,used,combo_eligible) VALUES (?,?,?,?,?,?,?)', s.today(), 'Refresco del día', 'drink', 300, 60, 1, 1)).lastInsertRowid);
    const order = await s.createOrder(await combo(s));
    await s.run('INSERT INTO allocations VALUES (?,?,?)', order.id, drinkId, 1);
    await s.run('UPDATE lines SET label=? WHERE order_id=?', 'Completo antiguo · sopa + segundo + refresco', order.id);
    const orders = await s.orders(s.today()),
      legacy = await s.get('SELECT * FROM items WHERE id=?', drinkId);
    await s.db.close();
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    assert.deepEqual(await s.orders(s.today()), orders);
    assert.ok(!(await s.menu(s.today())).items.some(i => i.id === drinkId));
    await assert.rejects(async () => await s.createOrder({
      date: s.today(),
      type: 'reservation',
      lines: [{
        itemId: drinkId,
        quantity: 1
      }]
    }), /solo se sirve incluido/);
    const menu = await s.menu(s.today());
    await s.saveMenu({
      date: s.today(),
      combo_price: 30,
      published: true,
      items: menu.items.filter(i => !i.productId).map(i => ({
        ...i,
        price: i.price / 100
      }))
    });
    assert.deepEqual(await s.get('SELECT * FROM items WHERE id=?', drinkId), legacy);
    assert.deepEqual(await s.orders(s.today()), orders);
    const soda = menu.items.find(i => i.kind === 'drink');
    const single = await s.createOrder({
      date: s.today(),
      type: 'reservation',
      lines: [{
        kind: 'product',
        productId: soda.productId,
        quantity: 1
      }]
    });
    assert.equal(single.total, soda.price);
    await s.transition(order.id, 'cancelled', 'cashier');
    assert.equal((await s.get('SELECT used FROM items WHERE id=?', drinkId)).used, 0);
  } finally {
    s?.db.close();
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
