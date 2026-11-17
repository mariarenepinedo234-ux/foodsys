import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('catalog, menu editor and complete dialog include refreshment without a drink selector',async()=>{
 const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('}}init();','}}');
 const context=vm.createContext({location:{pathname:'/'},document:{addEventListener(){}},setInterval(){},console});
 vm.runInContext(source+`
 state={menu:{combo_price:2500,published:1,items:[{id:1,name:'Sopa',kind:'soup',price:1000,available:10},{id:2,name:'Segundo',kind:'main',price:1800,available:10},{id:3,name:'Gaseosa',kind:'drink',price:700,available:10}]}};
 globalThis.pages={catalog:catalog(),menu:menuPage(),product:productForm({id:1,name:'Agua',price:500,minimum:5,active:1})};
 inventoryData={products:[{id:1,name:'Agua',stock:3,minimum:5,price:500,active:1}],movements:[]};globalThis.inventoryHTML=inventoryPage();
 modal=html=>{globalThis.dialog=html;};
 globalThis.openCombo=()=>runAction({dataset:{action:'combo'}});
 `,context);
 assert.match(context.pages.catalog,/data-action="combo"/);assert.match(context.pages.catalog,/Vaso de refresco incluido/);
 assert.match(context.pages.catalog,/Gaseosa/);assert.doesNotMatch(context.pages.menu,/name="combo_eligible"/);
 assert.doesNotMatch(context.pages.menu,/<option value="drink"/);assert.doesNotMatch(context.pages.menu,/value="Gaseosa"/);
 assert.match(context.pages.product,/name="productId"/);assert.doesNotMatch(context.pages.product,/name="id"/);
 assert.match(context.inventoryHTML,/Stock bajo/);assert.match(context.inventoryHTML,/Mercadería recibida/);
 await context.openCombo();assert.match(context.dialog,/name="soupId"/);assert.match(context.dialog,/name="mainId"/);
 assert.doesNotMatch(context.dialog,/name="drinkId"/);assert.match(context.dialog,/vaso de refresco incluido/);
});

test('guarnicion selector is part of complete and edit is offered only to staff for eligible unpaid orders',async()=>{
 const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('}}init();','}}');
 const context=vm.createContext({location:{pathname:'/'},document:{addEventListener(){}},setInterval(){},console});
 vm.runInContext(source+`
 state={today:'2026-11-13',menu:{combo_price:2500,items:[{id:1,name:'Sopa',kind:'soup',available:10},{id:2,name:'Segundo',kind:'main',available:10},{id:3,name:'Ensalada rusa',kind:'side',price:500,available:10}]}};
 modal=html=>{globalThis.dialog=html;};globalThis.openCombo=()=>runAction({dataset:{action:'combo'}});
 user={role:'cashier'};const o={id:1,date:state.today,status:'reserved',paid:null};
 globalThis.buttons={unpaid:orderActions(o),paid:orderActions({...o,paid:2500}),preparing:orderActions({...o,status:'preparing'})};
 user={role:'kitchen'};globalThis.buttons.kitchen=orderActions(o);
 globalThis.menuHTML=menuPage();
 `,context);
 await context.openCombo();assert.match(context.dialog,/name="sideId"/);assert.match(context.dialog,/Ensalada rusa/);assert.doesNotMatch(context.dialog,/name="drinkId"/);
 assert.match(context.menuHTML,/<option value="side"/);assert.match(context.buttons.unpaid,/Editar pedido/);
 for(const key of ['paid','preparing','kitchen'])assert.doesNotMatch(context.buttons[key],/Editar pedido/);
});

test('rapid kitchen updates schedule a repaint instead of leaving edit buttons stale',async()=>{
 const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('}}init();','}}');
 let scheduled=null;
 const context=vm.createContext({location:{pathname:'/'},document:{addEventListener(){},querySelector(){return null;}},setInterval(){},clearTimeout(){},setTimeout(callback){scheduled=callback;return 1;},EventSource:class{close(){}},console});
 vm.runInContext(source+`view='orders';lastRender=Date.now();globalThis.paints=0;refresh=async()=>{};render=()=>{globalThis.paints++;};connect();globalThis.message=()=>events.onmessage();`,context);
 context.message();await Promise.resolve();assert.equal(context.paints,0);assert.equal(typeof scheduled,'function');scheduled();assert.equal(context.paints,1);
});
