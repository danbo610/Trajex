// Demo: build an index from a fixture Claude-style root into a separate DB.
// Usage (Node 22): node app/tests/remote-index-demo.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildIndex } from '../src/main/indexer.ts';
import { remoteBuildArgs, remoteDbPath, remoteWriterLeasePath } from '../src/main/remote-sources.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
class Db {
  constructor(p) { this.db = new DatabaseSync(p); }
  pragma(s) { this.db.exec(`PRAGMA ${s}`); }
  exec(s) { return this.db.exec(s); }
  prepare(s) { return this.db.prepare(s); }
  close() { return this.db.close(); }
}

const tmp = mkdtempSync(join(tmpdir(), 'trajex-remote-demo-'));
const root = join(tmp, 'mnt', 'other-mac', '.claude');
const dir = join(root, 'projects', '-Users-me-demo');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 's1.jsonl'), JSON.stringify({
  uuid: 'm1', type: 'user', timestamp: '2026-06-13T10:00:00Z', cwd: '/Users/me/demo',
  message: { role: 'user', content: [{ type: 'text', text: 'hello from the other mac' }] },
}) + '\n');

const remote = { id: 'demo0001', name: 'Other Mac', providerRoots: { claude: root } };
const trajexDir = join(tmp, '.trajex');
const dbPath = remoteDbPath(trajexDir, remote.id);
const result = buildIndex({
  ...remoteBuildArgs(remote), dbPath,
  writerLeasePath: remoteWriterLeasePath(trajexDir, remote.id), DatabaseImpl: Db,
});
const db = new Db(dbPath);
console.log('remote db :', dbPath);
console.log('sessions  :', db.prepare('SELECT id, project, source FROM sessions').all());
console.log('messages  :', db.prepare('SELECT uuid, text FROM messages').all());
console.log('affected  :', result.affectedSessionIds);
db.close();
