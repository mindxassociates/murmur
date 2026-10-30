// Prints only the app version (used by build-windows.bat to name artifacts).
const path = require('path');
process.stdout.write(require(path.join(__dirname, '..', 'package.json')).version + '\n');
