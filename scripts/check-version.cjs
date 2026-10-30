// Version consistency check for the Windows build.
// Standalone script (never inline `node -e` in the .bat — cmd's delayed
// expansion mangles quotes and ! / ^ characters even inside quotes).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const a = require(path.join(root, 'package.json')).version;
const b = require(path.join(root, 'src-tauri', 'tauri.conf.json')).version;
const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const m = cargo.match(/^version\s*=\s*"([^"]+)"/m);
const c = m ? m[1] : '(not found)';
if (a !== b || a !== c) {
  console.error('[FAIL] Version mismatch: package.json=' + a + ' tauri.conf.json=' + b + ' Cargo.toml=' + c);
  process.exit(1);
}
console.log('[OK] Version ' + a);
