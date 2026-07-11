const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'persistence-test');
  const database = path.join(root, 'orchestrator.sqlite');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(database);
  store.set('test', 'record', { value: 42 });
  store.save();
  store.db.close();
  fs.copyFileSync(database, `${database}.bak`);
  fs.writeFileSync(`${database}.tmp`, 'incomplete');
  fs.rmSync(database, { force: true });
  const recovered = await Store.open(database);
  assert(recovered.get('test', 'record')?.value === 42, 'database backup was not recovered');
  assert(!fs.existsSync(`${database}.tmp`), 'stale database temporary file was not removed');
  recovered.db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('SQLite recoverable persistence test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
