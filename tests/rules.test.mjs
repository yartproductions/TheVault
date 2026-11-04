// Database rules tests. Run inside the Firestore emulator:
//   npm install --no-save --prefix tests @firebase/rules-unit-testing@4 firebase@11
//   npx firebase-tools emulators:exec --only firestore --project demo-vault "node tests/rules.test.mjs"
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, runTransaction } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-vault',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }
});

await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'members/mem1'), { email: 'member@example.com', role: 'member', active: true });
  await setDoc(doc(db, 'members/own2'), { email: 'owner2@example.com', role: 'owner', active: true });
  await setDoc(doc(db, 'members/off1'), { email: 'off@example.com', role: 'owner', active: false });
  await setDoc(doc(db, 'items/VR-00001'), { code: 'VR-00001', title: 'iPhone', status: 'new' });
  await setDoc(doc(db, 'txs/TX-0001'), { code: 'TX-0001', amount: -100 });
  await setDoc(doc(db, 'counters/VR'), { n: 1 });
  await setDoc(doc(db, 'activity/202611-o1-1'), { month: '202611', by: 'o1', entries: [{ t: 'a' }, { t: 'b' }] });
  await setDoc(doc(db, 'meta/settings'), { feePct: 13 });
  await setDoc(doc(db, 'meta/security'), { pins: { o1: 'hash' } });
  await setDoc(doc(db, 'syslog/0001'), { t: 'x', level: 'error', source: 'app', msg: 'boom' });
  await setDoc(doc(db, 'shopifyOrders/1'), { name: '#1001' });
});

const as = (uid, email) => env.authenticatedContext(uid, { email }).firestore();
const bootstrap = as('boot1', 'kohlindersjohn@gmail.com');
const owner = as('own2', 'owner2@example.com');
const member = as('mem1', 'member@example.com');
const disabled = as('off1', 'off@example.com');
const stranger = as('str1', 'stranger@example.com');
const anon = env.unauthenticatedContext().firestore();
const logEntry = { t: '2026-11-04T00:00:00Z', level: 'error', source: 'app', where: 'x', msg: 'boom', detail: '', who: '', email: '', page: '#/', device: 'test', app: 'web' };

let failures = 0;
async function check(name, promise) {
  try { await promise; console.log('ok   ', name); }
  catch (e) { failures++; console.error('FAIL ', name, '\n      ', e && e.message); }
}
const ok = (name, op) => check(name, assertSucceeds(op));
const no = (name, op) => check(name, assertFails(op));

// Outsiders see nothing.
await no('anonymous cannot read items', getDoc(doc(anon, 'items/VR-00001')));
await no('stranger cannot read items', getDoc(doc(stranger, 'items/VR-00001')));
await no('disabled member cannot read items', getDoc(doc(disabled, 'items/VR-00001')));
await no('stranger cannot write a syslog entry', setDoc(doc(stranger, 'syslog/9'), logEntry));

// Members work normally.
await ok('member reads items', getDoc(doc(member, 'items/VR-00001')));
await ok('member lists items', getDocs(collection(member, 'items')));
await ok('member creates an item', setDoc(doc(member, 'items/VR-00002'), { code: 'VR-00002', title: 'iPad', status: 'new' }));
await ok('member edits an item', updateDoc(doc(member, 'items/VR-00001'), { status: 'proc', 'packet.title': 'iPhone 13' }));
await ok('member creates a customer', setDoc(doc(member, 'customers/CU-0001'), { code: 'CU-0001', name: 'Maria' }));
await ok('member creates a purchase', setDoc(doc(member, 'purchases/PU-0001'), { code: 'PU-0001', total: 10 }));
await ok('member creates a sale', setDoc(doc(member, 'sales/SL-0001'), { code: 'SL-0001', price: 10 }));
await ok('member creates a transaction', setDoc(doc(member, 'txs/TX-0002'), { code: 'TX-0002', amount: 5 }));
await ok('member takes the next record code', runTransaction(member, async t => { const r = doc(member, 'counters/VR'); const s = await t.get(r); t.set(r, { n: s.data().n + 1 }); }));
await ok('member starts a new counter at 1', setDoc(doc(member, 'counters/RT'), { n: 1 }));
await ok('member appends to the activity log', updateDoc(doc(member, 'activity/202611-o1-1'), { entries: [{ t: 'a' }, { t: 'b' }, { t: 'c' }] }));
await ok('member starts a new activity page', setDoc(doc(member, 'activity/202611-m-1'), { month: '202611', by: 'm', entries: [{ t: 'a' }] }));
await ok('member reads settings', getDoc(doc(member, 'meta/settings')));
await ok('member reads PIN hashes (needed for the lock screen)', getDoc(doc(member, 'meta/security')));
await ok('member adds and removes a photo', setDoc(doc(member, 'photos/fs-1'), { data: 'x' }).then(() => deleteDoc(doc(member, 'photos/fs-1'))));
await ok('member reports an error to the system log', setDoc(doc(member, 'syslog/0002'), logEntry));
await ok('member reads the member list', getDocs(collection(member, 'members')));

// Members cannot destroy or take over.
await no('member cannot delete an item', deleteDoc(doc(member, 'items/VR-00001')));
await no('member cannot delete a transaction', deleteDoc(doc(member, 'txs/TX-0001')));
await no('member cannot change a record code', updateDoc(doc(member, 'items/VR-00001'), { code: 'VR-09999' }));
await no('member cannot jump a counter ahead', setDoc(doc(member, 'counters/VR'), { n: 500 }));
await no('member cannot reset a counter', setDoc(doc(member, 'counters/VR'), { n: 1 }));
await no('member cannot wipe the activity log', updateDoc(doc(member, 'activity/202611-o1-1'), { entries: [] }));
await no('member cannot delete activity', deleteDoc(doc(member, 'activity/202611-o1-1')));
await no('member cannot change settings', updateDoc(doc(member, 'meta/settings'), { feePct: 0 }));
await no('member cannot overwrite PINs', setDoc(doc(member, 'meta/security'), { pins: { o1: 'mine' } }));
await no('member cannot read the system log', getDocs(collection(member, 'syslog')));
await no('member cannot clear the system log', deleteDoc(doc(member, 'syslog/0001')));
await no('member cannot edit a log entry', updateDoc(doc(member, 'syslog/0001'), { msg: 'hidden' }));
await no('member cannot write junk to the log', setDoc(doc(member, 'syslog/0003'), { ...logEntry, extra: 1 }));
await no('member cannot make themselves an owner', updateDoc(doc(member, 'members/mem1'), { role: 'owner' }));
await no('member cannot read Shopify orders', getDocs(collection(member, 'shopifyOrders')));
await no('member cannot use an unlisted collection', setDoc(doc(member, 'secrets/x'), { a: 1 }));

// Owners (bootstrap emails and owner-role members) can manage everything allowed from the app.
for (const [label, db] of [['bootstrap owner', bootstrap], ['owner member', owner]]) {
  await ok(`${label} changes settings`, updateDoc(doc(db, 'meta/settings'), { feePct: 12 }));
  await ok(`${label} sets PINs`, setDoc(doc(db, 'meta/security'), { pins: { o1: 'hash' } }));
  await ok(`${label} reads the system log`, getDocs(collection(db, 'syslog')));
  await ok(`${label} reads Shopify orders`, getDocs(collection(db, 'shopifyOrders')));
  await ok(`${label} restores a counter from a backup`, setDoc(doc(db, `counters/T${label.length}`), { n: 50 }));
}
await ok('owner deletes a transaction', deleteDoc(doc(owner, 'txs/TX-0001')));
await ok('owner clears a log entry', deleteDoc(doc(bootstrap, 'syslog/0001')));
await ok('owner deletes an item', deleteDoc(doc(bootstrap, 'items/VR-00002')));
await no('owner cannot edit member accounts directly', updateDoc(doc(owner, 'members/mem1'), { role: 'owner' }));
await no('owner cannot lower a counter', setDoc(doc(owner, 'counters/VR'), { n: 2 }));

await env.cleanup();
if (failures) { console.error(`\n${failures} rules check(s) failed.`); process.exit(1); }
console.log('\nAll rules checks passed.');
