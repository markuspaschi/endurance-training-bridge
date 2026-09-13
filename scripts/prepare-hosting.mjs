import { copyFile } from 'node:fs/promises';

const source = new URL('./garmin-mcp-tokens.py', import.meta.url);
const destination = new URL('../web/garmin-pair.py', import.meta.url);

await copyFile(source, destination);
console.log('Prepared web/garmin-pair.py for local serving and Firebase Hosting.');
