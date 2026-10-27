// Requiring better-sqlite3 alone does not load its native binding.
const db = new (require('better-sqlite3'))(':memory:');
if (db.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('SQLite probe failed');
db.close();
const child = require('node-pty').spawn(process.execPath, ['-e', 'process.exit(0)'], {
  env: process.env,
});
const timer = setTimeout(() => { child.kill(); process.exit(1); }, 10000);
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0) process.exit(1);
  console.log(`Native modules ready: ${process.execPath}, ABI ${process.versions.modules}`);
});
