// Test double for the provider CLIs. NEVER used outside tests.
//   node fake-cli.js auth status     -> prints $CLAUDE_CONFIG_DIR/fake-auth.json
//   node fake-cli.js app-server      -> JSON-RPC over stdio answering from $CODEX_HOME/fake-codex.json
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status') {
  const f = path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-auth.json');
  process.stdout.write(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '{"loggedIn": false}');
  process.exit(0);
}

if (args[0] === 'app-server') {
  const conf = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || '', 'fake-codex.json'), 'utf8'));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id === undefined) continue;
      const r = conf[msg.method];
      const out = r === undefined
        ? { id: msg.id, error: { code: -32601, message: 'method not found' } }
        : r && r.__error ? { id: msg.id, error: { code: -32000, message: r.__error } } : { id: msg.id, result: r };
      process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  process.stdout.write('fake-cli 0.0.0\n');
}
