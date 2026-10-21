import { randomBytes } from 'node:crypto';
export const empty = (epoch = 0) => ({ epoch, seen: [], refs: [] });
export class State {
  constructor(storage) {
    this.storage = storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS connection (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
  }
  encryptionKey() {
    if (this.key) return this.key;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS instance_key (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    const rows = [...this.storage.sql.exec('SELECT value FROM instance_key WHERE id = 1')];
    if (rows.length) return this.key = rows[0].value;
    const key = randomBytes(32).toString('hex');
    this.storage.sql.exec('INSERT INTO instance_key (id, value) VALUES (1, ?)', key);
    return this.key = key;
  }
  read() { const rows = [...this.storage.sql.exec('SELECT value FROM connection WHERE id = 1')]; return rows.length ? JSON.parse(rows[0].value) : empty(); }
  write(value) { this.storage.sql.exec('INSERT INTO connection (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify(value)); }
  alarm(at) { return this.storage.setAlarm(at); }
  deleteAlarm() { return this.storage.deleteAlarm(); }
  getAlarm() { return this.storage.getAlarm(); }
}
