'use strict';
// Generates a bcrypt hash for KK_PASSWORD_HASH.
// Usage:  node scripts/generate-password-hash.js
//
// The password is read interactively from stdin (never echoed, never stored
// in shell history).  Paste the resulting hash into the KK_PASSWORD_HASH
// environment variable in Railway settings.

const readline = require('readline');
const bcrypt   = require('bcryptjs');

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
// Disable echo so the password is not displayed or logged
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stderr.write('Enter new password: ');

let password = '';
process.stdin.on('data', (chunk) => {
  const char = chunk.toString();
  if (char === '\n' || char === '\r' || char === '\u0004') {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stderr.write('\n');
    rl.close();

    if (!password) {
      process.stderr.write('Error: password cannot be empty.\n');
      process.exit(1);
    }

    bcrypt.hash(password, 12).then(hash => {
      // Write ONLY the hash to stdout so it can be piped/captured safely
      process.stdout.write(hash + '\n');
    }).catch(err => {
      process.stderr.write('Error: ' + err.message + '\n');
      process.exit(1);
    });
  } else if (char === '\u0003') { // Ctrl-C
    process.stderr.write('\nAborted.\n');
    process.exit(1);
  } else {
    password += char;
  }
});
