import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('⚙️  Iniciando conexão com o Banco de Dados...');
const dbPath = process.platform === 'linux' 
    ? '/var/www/macos/db/database.sqlite' 
    : path.join(__dirname, '../db/database.sqlite');

console.log(`📂 Usando banco de dados em: ${dbPath}`);

export const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
});

// ========================================
// OTIMIZAÇÕES SQLITE - Performance
// ========================================
console.log('⚙️  Configurando otimizações do SQLite...');
await db.run('PRAGMA journal_mode = WAL'); // Write-Ahead Logging
await db.run('PRAGMA synchronous = NORMAL'); // Menos fsync
await db.run('PRAGMA cache_size = -64000'); // 64MB de cache
await db.run('PRAGMA temp_store = MEMORY'); // Temp em RAM
await db.run('PRAGMA busy_timeout = 5000'); // Aguarda 5s antes de erro de trava
await db.run('PRAGMA foreign_keys = ON'); // Ativa chaves estrangeiras

export default db;
